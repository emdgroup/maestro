//! Webhooks: `POST /hooks/<automation_id>`, served by the resident server.
//!
//! A listener of its own rather than a path on `attach`'s: that one speaks the framed protocol to a
//! client holding the runtime token, and this one faces whatever the user points at it, a tunnel or
//! a reverse proxy included. It binds loopback unless told otherwise, serves no TLS (the tunnel or
//! proxy in front does), and answers as soon as a run is opened or queued, because a sender gives
//! up long before a run ends.
//!
//! The request is judged here, and the run is started by the main loop, which is the only place
//! holding what a spawn needs. `FIRE_TX` carries it across, the same way `TURN_TX` carries turn
//! ends the other way.

use std::collections::{HashMap, VecDeque};
use std::convert::Infallible;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use bytes::Bytes;
use chrono::Utc;
use http_body_util::{BodyExt, Full, Limited};
use hyper::body::Incoming;
use hyper::header::HeaderMap;
use hyper::{Method, Request, Response, StatusCode};
use maestro_protocol::{
    AutomationRun, DeliveryOutcome, WebhookDelivery, WebhookOverlap, WebhookSettings, WebhookStatus,
};
use rusqlite::{params, Connection, OptionalExtension};
use subtle::ConstantTimeEq;

use crate::automation_runner::Store;
use crate::automations;
use crate::helpers::send_diag;

pub const DEFAULT_PORT: u16 = 7433;
const BODY_LIMIT: usize = 1024 * 1024;
/// What of the body goes into the prompt. The rest is in the sender's own records.
const PAYLOAD_LIMIT: usize = 100 * 1024;
const RATE_PER_MINUTE: usize = 30;
const QUEUE_CAP: i64 = 10;
const DELIVERIES_KEPT: i64 = 20;
const DEDUPE_WINDOW: chrono::Duration = chrono::Duration::hours(24);

/// Headers that name what happened, passed to the agent. Never anything that authenticates.
const EVENT_HEADERS: [&str; 5] = [
    "x-github-event",
    "x-gitlab-event",
    "x-event-key",
    "x-event-type",
    "content-type",
];
/// Headers a sender uses to identify one delivery, so its retries can be recognised.
const DELIVERY_ID_HEADERS: [&str; 4] = [
    "x-github-delivery",
    "x-gitlab-webhook-uuid",
    "idempotency-key",
    "x-delivery-id",
];

/// A delivery accepted for a run now, for the main loop to start.
pub struct Fire {
    pub automation_id: String,
    pub payload: String,
    pub reply: tokio::sync::oneshot::Sender<Result<AutomationRun, String>>,
}

pub type FireSender = tokio::sync::mpsc::UnboundedSender<Fire>;
pub static FIRE_TX: std::sync::OnceLock<FireSender> = std::sync::OnceLock::new();

// --- Settings -----------------------------------------------------------------------------------

pub fn settings(conn: &Connection) -> WebhookSettings {
    conn.query_row(
        "SELECT port, bind_address, public_url FROM webhook_settings WHERE id = 1",
        [],
        |row| {
            Ok(WebhookSettings {
                port: row.get(0)?,
                bind_address: row.get(1)?,
                public_url: row.get(2)?,
            })
        },
    )
    .optional()
    .ok()
    .flatten()
    .unwrap_or_else(|| WebhookSettings {
        port: DEFAULT_PORT,
        bind_address: "127.0.0.1".to_string(),
        public_url: None,
    })
}

pub fn save_settings(conn: &Connection, settings: &WebhookSettings) -> Result<(), String> {
    if settings.bind_address.parse::<std::net::IpAddr>().is_err() {
        return Err(format!("'{}' is not an IP address", settings.bind_address));
    }
    if settings.port == 0 {
        return Err("The port cannot be 0".to_string());
    }
    let public_url = settings
        .public_url
        .as_deref()
        .map(|url| url.trim().trim_end_matches('/'))
        .filter(|url| !url.is_empty());
    conn.execute(
        "INSERT INTO webhook_settings (id, port, bind_address, public_url) VALUES (1, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
            port = excluded.port, bind_address = excluded.bind_address,
            public_url = excluded.public_url",
        params![settings.port, settings.bind_address, public_url],
    )
    .map(|_| ())
    .map_err(|e| format!("cannot save the webhook settings: {e}"))
}

// --- Deliveries and the queue -------------------------------------------------------------------

fn outcome_name(outcome: DeliveryOutcome) -> String {
    serde_json::to_value(outcome)
        .ok()
        .and_then(|value| value.as_str().map(str::to_string))
        .unwrap_or_default()
}

fn row_to_delivery(row: &rusqlite::Row<'_>) -> rusqlite::Result<WebhookDelivery> {
    let outcome: String = row.get("outcome")?;
    Ok(WebhookDelivery {
        id: row.get("id")?,
        automation_id: row.get("automation_id")?,
        received_at: row.get("received_at")?,
        status: row.get("status")?,
        outcome: serde_json::from_value(serde_json::Value::String(outcome))
            .unwrap_or(DeliveryOutcome::Failed),
        detail: row.get("detail")?,
        run_id: row.get("run_id")?,
    })
}

struct Recorded<'a> {
    automation_id: &'a str,
    status: StatusCode,
    outcome: DeliveryOutcome,
    detail: Option<String>,
    dedupe_key: Option<&'a str>,
    run_id: Option<&'a str>,
}

/// Write one delivery down, and forget the ones past what is kept.
///
/// A row that started or queued a run is kept past the count while inside the dedupe window, since
/// it is what recognises a sender's retry. Everything else goes at the count, so a flood of refused
/// requests cannot grow the table.
fn record(conn: &Connection, delivery: Recorded<'_>) -> String {
    let id = uuid::Uuid::new_v4().to_string();
    let now = Utc::now();
    let written = conn.execute(
        "INSERT INTO deliveries
            (id, automation_id, received_at, status, outcome, detail, run_id, dedupe_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        params![
            id,
            delivery.automation_id,
            now.to_rfc3339(),
            delivery.status.as_u16(),
            outcome_name(delivery.outcome),
            delivery.detail,
            delivery.run_id,
            delivery.dedupe_key,
        ],
    );
    if let Err(e) = written {
        send_diag("warn", format!("[webhook] cannot record a delivery: {e}"));
    }
    let pruned = conn.execute(
        "DELETE FROM deliveries
          WHERE automation_id = ?1
            AND (dedupe_key IS NULL OR received_at < ?2)
            AND id NOT IN (SELECT id FROM deliveries WHERE automation_id = ?1
                            ORDER BY received_at DESC LIMIT ?3)",
        params![
            delivery.automation_id,
            (now - DEDUPE_WINDOW).to_rfc3339(),
            DELIVERIES_KEPT
        ],
    );
    if let Err(e) = pruned {
        send_diag("warn", format!("[webhook] cannot prune deliveries: {e}"));
    }
    id
}

pub fn list_deliveries(
    conn: &Connection,
    automation_id: &str,
) -> Result<Vec<WebhookDelivery>, String> {
    let mut statement = conn
        .prepare(
            "SELECT * FROM deliveries WHERE automation_id = ?
              ORDER BY received_at DESC LIMIT ?",
        )
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map(params![automation_id, DELIVERIES_KEPT], row_to_delivery)
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

fn is_duplicate(conn: &Connection, automation_id: &str, key: &str) -> bool {
    conn.query_row(
        "SELECT 1 FROM deliveries
          WHERE automation_id = ? AND dedupe_key = ? AND received_at >= ? LIMIT 1",
        params![
            automation_id,
            key,
            (Utc::now() - DEDUPE_WINDOW).to_rfc3339()
        ],
        |_| Ok(()),
    )
    .optional()
    .ok()
    .flatten()
    .is_some()
}

pub fn attach_run(conn: &Connection, delivery_id: &str, run_id: &str) {
    if let Err(e) = conn.execute(
        "UPDATE deliveries SET run_id = ?, outcome = 'started' WHERE id = ?",
        params![run_id, delivery_id],
    ) {
        send_diag(
            "warn",
            format!("[webhook] cannot link a delivery to its run: {e}"),
        );
    }
}

fn queue_length(conn: &Connection, automation_id: &str) -> i64 {
    conn.query_row(
        "SELECT COUNT(*) FROM webhook_queue WHERE automation_id = ?",
        [automation_id],
        |row| row.get(0),
    )
    .unwrap_or(0)
}

/// Automations with a delivery waiting and no run in its way.
pub fn ready_to_dequeue(conn: &Connection) -> Vec<String> {
    let ids: Vec<String> = conn
        .prepare("SELECT DISTINCT automation_id FROM webhook_queue")
        .and_then(|mut statement| {
            statement
                .query_map([], |row| row.get(0))?
                .collect::<rusqlite::Result<Vec<String>>>()
        })
        .unwrap_or_default();
    ids.into_iter()
        .filter(|id| !automations::is_running(conn, id))
        .collect()
}

/// Take the oldest waiting delivery of one automation: its id and the payload it carries.
pub fn dequeue(conn: &Connection, automation_id: &str) -> Option<(String, String)> {
    let next: Option<(i64, String, String)> = conn
        .query_row(
            "SELECT seq, delivery_id, payload FROM webhook_queue
              WHERE automation_id = ? ORDER BY seq LIMIT 1",
            [automation_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .ok()
        .flatten();
    let (seq, delivery_id, payload) = next?;
    if let Err(e) = conn.execute("DELETE FROM webhook_queue WHERE seq = ?", [seq]) {
        send_diag(
            "warn",
            format!("[webhook] cannot take a delivery off the queue: {e}"),
        );
        return None;
    }
    Some((delivery_id, payload))
}

// --- Judging a request --------------------------------------------------------------------------

fn header<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|value| value.to_str().ok())
}

/// Whether the request proves it knows the secret: a GitHub-style signature of the body, or the
/// secret itself as a bearer token. Both compared in constant time.
fn authorized(secret: &str, headers: &HeaderMap, body: &[u8]) -> bool {
    use hmac::{Hmac, Mac};
    if let Some(signature) = header(headers, "x-hub-signature-256") {
        let Some(expected) = signature
            .strip_prefix("sha256=")
            .and_then(|hex| hex::decode(hex).ok())
        else {
            return false;
        };
        let Ok(mut mac) = Hmac::<sha2::Sha256>::new_from_slice(secret.as_bytes()) else {
            return false;
        };
        mac.update(body);
        return mac.verify_slice(&expected).is_ok();
    }
    header(headers, "authorization")
        .and_then(|value| value.strip_prefix("Bearer "))
        .is_some_and(|token| bool::from(token.trim().as_bytes().ct_eq(secret.as_bytes())))
}

/// What identifies this delivery across a sender's retries.
fn dedupe_key(headers: &HeaderMap, body: &[u8]) -> String {
    DELIVERY_ID_HEADERS
        .iter()
        .find_map(|name| header(headers, name))
        .map(|id| format!("id:{id}"))
        .unwrap_or_else(|| {
            use sha2::Digest;
            format!("body:{}", hex::encode(sha2::Sha256::digest(body)))
        })
}

/// Recent authorized deliveries per automation, for the per-minute limit.
static RATE: std::sync::LazyLock<Mutex<HashMap<String, VecDeque<Instant>>>> =
    std::sync::LazyLock::new(Default::default);

fn over_rate_limit(automation_id: &str) -> bool {
    let Ok(mut rate) = RATE.lock() else {
        return false;
    };
    let now = Instant::now();
    let seen = rate.entry(automation_id.to_string()).or_default();
    while seen
        .front()
        .is_some_and(|at| now.duration_since(*at) > Duration::from_secs(60))
    {
        seen.pop_front();
    }
    if seen.len() >= RATE_PER_MINUTE {
        return true;
    }
    seen.push_back(now);
    false
}

/// The request as the agent reads it, appended below the automation's prompt.
pub fn format_payload(headers: &HeaderMap, body: &[u8]) -> String {
    let mut text = String::from("## Webhook payload\n\nThis run was started by a webhook.");
    for name in EVENT_HEADERS {
        if let Some(value) = header(headers, name) {
            text.push_str(&format!("\n{name}: {value}"));
        }
    }
    let (language, mut content) = match serde_json::from_slice::<serde_json::Value>(body) {
        Ok(json) => (
            "json",
            serde_json::to_string_pretty(&json).unwrap_or_default(),
        ),
        Err(_) => ("", String::from_utf8_lossy(body).into_owned()),
    };
    if content.len() > PAYLOAD_LIMIT {
        let mut cut = PAYLOAD_LIMIT;
        while !content.is_char_boundary(cut) {
            cut -= 1;
        }
        content.truncate(cut);
        content.push_str("\n[cut: the payload was longer]");
    }
    if content.trim().is_empty() {
        text.push_str("\n\nThe request had no body.");
        return text;
    }
    // A fence longer than any run of tildes in the body, so the body cannot close it.
    let longest = content
        .split(|character| character != '~')
        .map(str::len)
        .max()
        .unwrap_or(0);
    let fence = "~".repeat(longest.max(2) + 1);
    text.push_str(&format!("\n\n{fence}{language}\n{content}\n{fence}"));
    text
}

fn respond(status: StatusCode, body: serde_json::Value) -> Response<Full<Bytes>> {
    let mut response = Response::new(Full::new(Bytes::from(body.to_string())));
    *response.status_mut() = status;
    if let Ok(value) = "application/json".parse() {
        response.headers_mut().insert("content-type", value);
    }
    response
}

fn refuse(status: StatusCode, message: &str) -> Response<Full<Bytes>> {
    respond(status, serde_json::json!({ "error": message }))
}

async fn handle(store: Store, request: Request<Incoming>) -> Response<Full<Bytes>> {
    let Some(automation_id) = request
        .uri()
        .path()
        .strip_prefix("/hooks/")
        .filter(|id| !id.is_empty() && !id.contains('/'))
        .map(str::to_string)
    else {
        return refuse(StatusCode::NOT_FOUND, "not a webhook address");
    };
    if request.method() != Method::POST {
        return refuse(StatusCode::METHOD_NOT_ALLOWED, "webhooks are POST");
    }
    let automation = {
        let conn = store.lock().await;
        automations::get(&conn, &automation_id).ok().flatten()
    };
    // Nothing is recorded for an id that does not exist: there is nowhere to show it.
    let Some(automation) = automation else {
        return refuse(StatusCode::NOT_FOUND, "no such automation");
    };

    let (parts, body) = request.into_parts();
    let body = match Limited::new(body, BODY_LIMIT).collect().await {
        Ok(collected) => collected.to_bytes(),
        Err(_) => {
            let conn = store.lock().await;
            record(
                &conn,
                Recorded {
                    automation_id: &automation_id,
                    status: StatusCode::PAYLOAD_TOO_LARGE,
                    outcome: DeliveryOutcome::TooLarge,
                    detail: Some("The body was over 1 MB".to_string()),
                    dedupe_key: None,
                    run_id: None,
                },
            );
            return refuse(StatusCode::PAYLOAD_TOO_LARGE, "the body is over 1 MB");
        }
    };

    let judged = judge(&store, &automation, &parts.headers, &body).await;
    let (status, outcome, detail, response) = match judged {
        Judged::Answer {
            status,
            outcome,
            detail,
        } => {
            let response = refuse(status, detail.as_deref().unwrap_or("refused"));
            (status, outcome, detail, response)
        }
        Judged::Queue { dedupe } => {
            let payload = format_payload(&parts.headers, &body);
            let conn = store.lock().await;
            let delivery_id = record(
                &conn,
                Recorded {
                    automation_id: &automation_id,
                    status: StatusCode::ACCEPTED,
                    outcome: DeliveryOutcome::Queued,
                    detail: None,
                    dedupe_key: Some(&dedupe),
                    run_id: None,
                },
            );
            if let Err(e) = conn.execute(
                "INSERT INTO webhook_queue (automation_id, delivery_id, payload) VALUES (?, ?, ?)",
                params![automation_id, delivery_id, payload],
            ) {
                send_diag("warn", format!("[webhook] cannot queue a delivery: {e}"));
                return refuse(StatusCode::INTERNAL_SERVER_ERROR, "could not queue it");
            }
            let position = queue_length(&conn, &automation_id);
            return respond(
                StatusCode::ACCEPTED,
                serde_json::json!({ "queued": true, "position": position }),
            );
        }
        Judged::Run { dedupe } => {
            let payload = format_payload(&parts.headers, &body);
            let (reply, answer) = tokio::sync::oneshot::channel();
            let sent = FIRE_TX.get().is_some_and(|fire| {
                fire.send(Fire {
                    automation_id: automation_id.clone(),
                    payload,
                    reply,
                })
                .is_ok()
            });
            let started = match sent {
                true => answer
                    .await
                    .unwrap_or_else(|_| Err("the server stopped".to_string())),
                false => Err("the server is not ready".to_string()),
            };
            let conn = store.lock().await;
            return match started {
                Ok(run) => {
                    record(
                        &conn,
                        Recorded {
                            automation_id: &automation_id,
                            status: StatusCode::ACCEPTED,
                            outcome: DeliveryOutcome::Started,
                            detail: None,
                            dedupe_key: Some(&dedupe),
                            run_id: Some(&run.id),
                        },
                    );
                    respond(
                        StatusCode::ACCEPTED,
                        serde_json::json!({ "run_id": run.id, "ordinal": run.ordinal }),
                    )
                }
                Err(e) => {
                    record(
                        &conn,
                        Recorded {
                            automation_id: &automation_id,
                            status: StatusCode::INTERNAL_SERVER_ERROR,
                            outcome: DeliveryOutcome::Failed,
                            detail: Some(e.clone()),
                            dedupe_key: None,
                            run_id: None,
                        },
                    );
                    refuse(StatusCode::INTERNAL_SERVER_ERROR, &e)
                }
            };
        }
    };
    let conn = store.lock().await;
    record(
        &conn,
        Recorded {
            automation_id: &automation_id,
            status,
            outcome,
            detail,
            dedupe_key: None,
            run_id: None,
        },
    );
    response
}

enum Judged {
    /// Answered without running anything.
    Answer {
        status: StatusCode,
        outcome: DeliveryOutcome,
        detail: Option<String>,
    },
    Queue {
        dedupe: String,
    },
    Run {
        dedupe: String,
    },
}

/// Everything short of starting the run, in the order that keeps a stranger from affecting the
/// real sender: nothing counts against the rate limit or the dedupe window until the request has
/// proved it knows the secret.
async fn judge(
    store: &Store,
    automation: &maestro_protocol::Automation,
    headers: &HeaderMap,
    body: &[u8],
) -> Judged {
    // Only a delivery that starts or queues a run is remembered for dedupe: one refused here is
    // one the sender is right to retry.
    let answer = |status, outcome, detail: &str| Judged::Answer {
        status,
        outcome,
        detail: Some(detail.to_string()),
    };
    let secret = automation.webhook_secret.as_deref().unwrap_or_default();
    if secret.is_empty() || !authorized(secret, headers, body) {
        return answer(
            StatusCode::UNAUTHORIZED,
            DeliveryOutcome::Unauthorized,
            "No valid signature or token",
        );
    }
    let dedupe = dedupe_key(headers, body);
    if !automation.enabled || !automation.webhook_enabled {
        return answer(
            StatusCode::SERVICE_UNAVAILABLE,
            DeliveryOutcome::Disabled,
            if automation.enabled {
                "The webhook is turned off"
            } else {
                "The automation is paused"
            },
        );
    }
    let conn = store.lock().await;
    if is_duplicate(&conn, &automation.id, &dedupe) {
        return answer(
            StatusCode::OK,
            DeliveryOutcome::Duplicate,
            "Already received",
        );
    }
    if over_rate_limit(&automation.id) {
        return answer(
            StatusCode::TOO_MANY_REQUESTS,
            DeliveryOutcome::RateLimited,
            "Over 30 deliveries in a minute",
        );
    }
    if !automations::is_running(&conn, &automation.id) {
        return Judged::Run { dedupe };
    }
    match automation.webhook_overlap {
        WebhookOverlap::Parallel => Judged::Run { dedupe },
        WebhookOverlap::Refuse => answer(
            StatusCode::CONFLICT,
            DeliveryOutcome::Busy,
            "A run is already going",
        ),
        WebhookOverlap::Queue if queue_length(&conn, &automation.id) >= QUEUE_CAP => answer(
            StatusCode::TOO_MANY_REQUESTS,
            DeliveryOutcome::QueueFull,
            "10 deliveries are already waiting",
        ),
        WebhookOverlap::Queue => Judged::Queue { dedupe },
    }
}

// --- The listener -------------------------------------------------------------------------------

struct Listening {
    task: Option<tokio::task::JoinHandle<()>>,
    error: Option<String>,
}

static LISTENER: Mutex<Listening> = Mutex::new(Listening {
    task: None,
    error: None,
});

pub fn status(conn: &Connection) -> WebhookStatus {
    WebhookStatus {
        settings: settings(conn),
        error: LISTENER
            .lock()
            .ok()
            .and_then(|listening| listening.error.clone()),
    }
}

/// Listen on whatever the settings say, replacing a listener already running.
///
/// A port that cannot be bound is not fatal: every other thing the server does carries on, and the
/// reason is what the settings page shows.
pub async fn restart(store: &Store) {
    let settings = {
        let conn = store.lock().await;
        settings(&conn)
    };
    if let Ok(mut listening) = LISTENER.lock() {
        if let Some(task) = listening.task.take() {
            task.abort();
        }
    }
    let address = format!("{}:{}", settings.bind_address, settings.port);
    let bound = tokio::net::TcpListener::bind(&address).await;
    let (task, error) = match bound {
        Ok(listener) => {
            send_diag("info", format!("[webhook] listening on {address}"));
            let store = std::sync::Arc::clone(store);
            (Some(tokio::spawn(serve(listener, store))), None)
        }
        Err(e) => {
            send_diag("warn", format!("[webhook] cannot listen on {address}: {e}"));
            (None, Some(bind_error(&e)))
        }
    };
    if let Ok(mut listening) = LISTENER.lock() {
        listening.task = task;
        listening.error = error;
    }
}

/// Short enough to sit at the end of the address row it is about; the log keeps the full error.
fn bind_error(error: &std::io::Error) -> String {
    match error.kind() {
        std::io::ErrorKind::AddrInUse => "Port already in use".to_string(),
        std::io::ErrorKind::AddrNotAvailable => "No such address on this machine".to_string(),
        std::io::ErrorKind::PermissionDenied => "Not allowed to use this port".to_string(),
        _ => error.to_string(),
    }
}

async fn serve(listener: tokio::net::TcpListener, store: Store) {
    loop {
        let stream = match listener.accept().await {
            Ok((stream, _)) => stream,
            Err(e) => {
                send_diag("warn", format!("[webhook] accept failed: {e}"));
                tokio::time::sleep(Duration::from_millis(200)).await;
                continue;
            }
        };
        let store = std::sync::Arc::clone(&store);
        tokio::spawn(async move {
            let service = hyper::service::service_fn(move |request| {
                let store = std::sync::Arc::clone(&store);
                async move { Ok::<_, Infallible>(handle(store, request).await) }
            });
            // A slow sender cannot hold a connection open for ever by trickling its headers.
            let served = hyper::server::conn::http1::Builder::new()
                .timer(hyper_util::rt::TokioTimer::new())
                .header_read_timeout(Duration::from_secs(10))
                .serve_connection(hyper_util::rt::TokioIo::new(stream), service)
                .await;
            if let Err(e) = served {
                send_diag("debug", format!("[webhook] connection ended: {e}"));
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use hmac::Mac;

    fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (name, value) in pairs {
            map.insert(
                hyper::header::HeaderName::from_bytes(name.as_bytes()).expect("name"),
                value.parse().expect("value"),
            );
        }
        map
    }

    async fn post(port: u16, automation_id: &str, token: &str, body: &str) -> (u16, String) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .expect("connect");
        let request = format!(
            "POST /hooks/{automation_id} HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer {token}\r\n\
             Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        stream.write_all(request.as_bytes()).await.expect("write");
        let mut response = String::new();
        stream.read_to_string(&mut response).await.expect("read");
        let status = response[9..12].parse().expect("status");
        (status, response)
    }

    #[tokio::test]
    async fn a_delivery_is_judged_before_it_can_run_anything() {
        let dir = tempfile::tempdir().expect("tempdir");
        let conn = automations::open(dir.path()).expect("store");
        let mut automation = maestro_protocol::Automation {
            id: "hook".to_string(),
            project_path: "/p".to_string(),
            name: "Hook".to_string(),
            prompt: "react".to_string(),
            agent_id: "claude".to_string(),
            cron: None,
            timezone: "UTC".to_string(),
            enabled: true,
            model: None,
            permission_mode: None,
            effort: None,
            workspace: maestro_protocol::AutomationWorkspace::Repository,
            next_due_at: None,
            webhook_enabled: false,
            webhook_overlap: WebhookOverlap::Queue,
            webhook_secret: None,
        };
        automations::save(&conn, "/p", &automation).expect("save");
        // Off: no secret has been made yet, so nothing can authenticate.
        automation.webhook_enabled = true;
        let saved = automations::save(&conn, "/p", &automation).expect("turn on");
        let secret = saved
            .webhook_secret
            .clone()
            .expect("a secret, made on turning it on");

        let store: Store = std::sync::Arc::new(tokio::sync::Mutex::new(conn));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let port = listener.local_addr().expect("address").port();
        tokio::spawn(serve(listener, std::sync::Arc::clone(&store)));

        assert_eq!(post(port, "hook", "wrong", "{}").await.0, 401);
        assert_eq!(post(port, "nobody", &secret, "{}").await.0, 404);

        // A run is going, and this automation queues rather than refusing.
        {
            let conn = store.lock().await;
            automations::start_run(&conn, &saved, maestro_protocol::RunTrigger::Manual)
                .expect("a run in flight");
        }
        let (status, body) = post(port, "hook", &secret, r#"{"n":1}"#).await;
        assert_eq!(status, 202, "{body}");
        assert!(body.contains(r#""position":1"#), "{body}");
        // The same body again is the sender retrying, not a second event.
        assert_eq!(post(port, "hook", &secret, r#"{"n":1}"#).await.0, 200);

        {
            let conn = store.lock().await;
            let outcomes: Vec<_> = list_deliveries(&conn, "hook")
                .expect("deliveries")
                .into_iter()
                .map(|delivery| delivery.outcome)
                .collect();
            assert_eq!(
                outcomes,
                vec![
                    DeliveryOutcome::Duplicate,
                    DeliveryOutcome::Queued,
                    DeliveryOutcome::Unauthorized
                ]
            );
            assert!(ready_to_dequeue(&conn).is_empty(), "still running");
            let (_, payload) = dequeue(&conn, "hook").expect("queued");
            assert!(payload.contains("\"n\": 1"));
        }
    }

    #[test]
    fn a_github_signature_or_the_bare_secret_is_accepted_and_nothing_else() {
        let body = br#"{"action":"opened"}"#;
        let mut mac = hmac::Hmac::<sha2::Sha256>::new_from_slice(b"s3cret").expect("key");
        mac.update(body);
        let signature = format!("sha256={}", hex::encode(mac.finalize().into_bytes()));

        let signed = headers(&[("x-hub-signature-256", &signature)]);
        assert!(authorized("s3cret", &signed, body));
        // The same signature over a different body is not the same request.
        assert!(!authorized("s3cret", &signed, b"{}"));
        assert!(authorized(
            "s3cret",
            &headers(&[("authorization", "Bearer s3cret")]),
            body
        ));
        assert!(!authorized(
            "s3cret",
            &headers(&[("authorization", "Bearer nope")]),
            body
        ));
        assert!(!authorized("s3cret", &HeaderMap::new(), body));
    }

    #[test]
    fn a_retry_is_recognised_by_its_delivery_id_before_its_body() {
        let body = b"{}";
        assert_eq!(
            dedupe_key(&headers(&[("x-github-delivery", "abc")]), body),
            "id:abc"
        );
        assert_eq!(
            dedupe_key(&HeaderMap::new(), body),
            dedupe_key(&HeaderMap::new(), body)
        );
        assert_ne!(
            dedupe_key(&HeaderMap::new(), body),
            dedupe_key(&HeaderMap::new(), b"[]")
        );
    }

    #[test]
    fn the_payload_names_the_event_and_cannot_be_closed_by_its_own_body() {
        let text = format_payload(
            &headers(&[
                ("x-github-event", "pull_request"),
                ("authorization", "Bearer s3cret"),
            ]),
            br#"{"note":"~~~ not a fence"}"#,
        );
        assert!(text.contains("x-github-event: pull_request"));
        assert!(!text.contains("s3cret"));
        assert!(text.contains("~~~~json\n"));
        assert!(text.ends_with("\n~~~~"));
    }
}
