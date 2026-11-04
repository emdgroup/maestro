//! Loopback gateway from the per-session MCP shims back into the running server.
//!
//! Each shim (`maestro mcp`, see `mcp_stdio`) opens one short-lived TCP connection per tool call.
//! The listener is bound to `127.0.0.1` only and every request carries a token minted at startup
//! and handed to the shim as an environment variable on its `McpServerStdio` entry — any other
//! local process can connect, so the token is what decides whether it is answered.
//!
//! Canvas calls are answered here: they are session updates, and the server already owns that
//! channel. So are the task tools, from the project store, so an agent can reach its board with no
//! window open. The prompt tools are split: the project's collection is answered here, the shared
//! one is forwarded (see `prompt_call`). Everything else is forwarded to Tauri as a
//! `HostToolCall` and parked in `PendingHostTools` until the matching `HostToolResult` comes back.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};

use maestro_protocol::{HostToolCall, HostToolResult, ServerResponse, SessionUpdate};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::{mpsc, oneshot};

use crate::helpers::send_response;
use crate::project_store::Store;
use crate::send_diag;
use crate::sessions::SessionMap;

mod loop_tools;
mod prompt_tools;
mod task_tools;

use prompt_tools::{prompt_call, PROMPT_TOOLS};
use task_tools::{task_tool, TASK_TOOLS};

/// What the MCP shim writes to the gateway, framed with `write_frame`. The reply is a bare
/// [`HostToolResult`].
///
/// The token is checked before anything else is read from the call: the listener is on loopback,
/// which any local process can reach.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GatewayRequest {
    pub token: String,
    pub call: HostToolCall,
}

/// Environment variables the `McpServerStdio` entry carries to the shim.
pub const MCP_GATEWAY_PORT_ENV: &str = "MAESTRO_MCP_PORT";
pub const MCP_GATEWAY_TOKEN_ENV: &str = "MAESTRO_MCP_TOKEN";
pub const MCP_GATEWAY_SESSION_ENV: &str = "MAESTRO_MCP_SESSION";

/// Name of the MCP server Maestro injects. A `.mcp.json` entry using it is skipped.
pub const MCP_SERVER_NAME: &str = "maestro";

/// A call waiting for an answer, and where to send it.
pub(crate) type GatewayItem = (HostToolCall, oneshot::Sender<HostToolResult>);

/// Host-bound calls in flight, keyed by the id the server assigned them. The session id is kept
/// alongside the sender so `Cancel` can fail everything a closing session was waiting on.
pub(crate) type PendingHostTools = HashMap<String, (String, oneshot::Sender<HostToolResult>)>;

/// Port and token of the running gateway, once it has bound. `None` if binding failed, in which
/// case no `maestro` MCP server is injected and sessions run without canvas or task tools.
static GATEWAY: OnceLock<(u16, String)> = OnceLock::new();

/// How long a shim gets to send its request after connecting.
const READ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);
/// How long the host gets to answer before the call is failed.
const HOST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(90);

pub(crate) fn gateway_address() -> Option<&'static (u16, String)> {
    GATEWAY.get()
}

/// Bind the gateway and start accepting. Returns the channel the main loop reads calls from.
pub(crate) async fn start() -> Option<mpsc::Receiver<GatewayItem>> {
    let listener = match tokio::net::TcpListener::bind(("127.0.0.1", 0)).await {
        Ok(listener) => listener,
        Err(e) => {
            send_diag(
                "warn",
                format!("[mcp] cannot bind the MCP gateway, canvas and task tools are off: {e}"),
            );
            return None;
        }
    };
    let port = match listener.local_addr() {
        Ok(addr) => addr.port(),
        Err(e) => {
            send_diag(
                "warn",
                format!("[mcp] cannot read the gateway address: {e}"),
            );
            return None;
        }
    };
    let token = uuid::Uuid::new_v4().to_string();
    if GATEWAY.set((port, token.clone())).is_err() {
        return None;
    }

    let (tx, rx) = mpsc::channel::<GatewayItem>(16);
    tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                break;
            };
            let tx = tx.clone();
            let token = token.clone();
            tokio::spawn(async move {
                serve_connection(stream, token, tx).await;
            });
        }
    });
    send_diag(
        "info",
        format!("[mcp] gateway listening on 127.0.0.1:{port}"),
    );
    Some(rx)
}

async fn serve_connection(
    mut stream: tokio::net::TcpStream,
    token: String,
    tx: mpsc::Sender<GatewayItem>,
) {
    let request = match tokio::time::timeout(
        READ_TIMEOUT,
        maestro_protocol::read_frame::<_, GatewayRequest>(&mut stream),
    )
    .await
    {
        Ok(Ok(request)) => request,
        Ok(Err(e)) => {
            send_diag("warn", format!("[mcp] unreadable gateway request: {e}"));
            return;
        }
        Err(_) => {
            send_diag("warn", "[mcp] gateway request timed out before it arrived");
            return;
        }
    };

    if request.token != token {
        send_diag(
            "warn",
            format!(
                "[mcp] rejected a gateway request for {:?} with a bad token",
                request.call.name
            ),
        );
        reply(&mut stream, fail(&request.call, "unauthorized")).await;
        return;
    }

    let call = request.call;
    let (reply_tx, reply_rx) = oneshot::channel::<HostToolResult>();
    if tx.send((call.clone(), reply_tx)).await.is_err() {
        reply(&mut stream, fail(&call, "Maestro is shutting down")).await;
        return;
    }

    let result = match tokio::time::timeout(HOST_TIMEOUT, reply_rx).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => fail(&call, "Maestro dropped the call"),
        Err(_) => fail(&call, "host did not answer"),
    };
    reply(&mut stream, result).await;
}

async fn reply(stream: &mut tokio::net::TcpStream, result: HostToolResult) {
    if let Err(e) = maestro_protocol::write_frame(stream, &result).await {
        send_diag("warn", format!("[mcp] cannot answer the shim: {e}"));
    }
}

fn fail(call: &HostToolCall, message: &str) -> HostToolResult {
    HostToolResult {
        session_id: call.session_id.clone(),
        request_id: call.request_id.clone(),
        result: serde_json::Value::Null,
        error: Some(message.to_string()),
    }
}

/// Answer a call from a shim, or park it until the host answers.
pub(crate) async fn handle_host_tool_call(
    call: HostToolCall,
    reply_tx: oneshot::Sender<HostToolResult>,
    sessions: &SessionMap,
    project_store: Option<&Store>,
    automation_store: Option<&crate::automation_runner::Store>,
    pending_host_tools: &mut PendingHostTools,
    stdout: &crate::ClientOut,
) {
    // Not "no longer open": the shim is handed its session id while `session/new` is still in
    // flight, so an id absent from the map may be one that has not been registered yet.
    let Some(session) = sessions.get(&call.session_id) else {
        let _ = reply_tx.send(fail(&call, "no Maestro session with this id is open"));
        return;
    };

    if PROMPT_TOOLS.contains(&call.name.as_str()) {
        let project_path = session
            .project
            .as_ref()
            .map(|project| project.project_path.clone());
        prompt_call(
            call,
            reply_tx,
            project_path,
            project_store.cloned(),
            pending_host_tools,
            stdout,
        )
        .await;
        return;
    }

    // Off the loop: `create_task` reads the project's settings and runs `git`.
    if TASK_TOOLS.contains(&call.name.as_str()) {
        let binding = session.project.as_ref().map(|project| SessionTask {
            project_path: project.project_path.clone(),
            task_id: project.meta.task_id,
            loop_session: crate::loop_engine::session_of(session),
        });
        let store = project_store.cloned();
        let automations = automation_store.cloned();
        let stdout = Arc::clone(stdout);
        tokio::spawn(async move {
            // A task an automation's agent creates says which run it came from.
            let draft = match (&automations, call.name.as_str()) {
                (Some(automations), "create_task") => {
                    let conn = automations.lock().await;
                    crate::automations::run_for_session(&conn, &call.session_id).map(|run| {
                        maestro_protocol::TaskDraft {
                            automation: run.automation_name,
                            run: run.ordinal,
                        }
                    })
                }
                _ => None,
            };
            let answered = task_tool(store, binding, &call.name, &call.arguments, draft).await;
            let result = match answered {
                Ok((result, pushes)) => {
                    for push in pushes {
                        crate::helpers::broadcast(&stdout, push).await;
                    }
                    HostToolResult {
                        session_id: call.session_id.clone(),
                        request_id: call.request_id.clone(),
                        result,
                        error: None,
                    }
                }
                Err(message) => fail(&call, &message),
            };
            let _ = reply_tx.send(result);
        });
        return;
    }

    // A canvas call is a session update — the server owns that channel, so the surface is drawn
    // from here. It is *also* forwarded to the host below, whose answer carries back whatever the
    // frame has failed at; the agent never sees its own surface and this is the only way it hears.
    if crate::mcp_stdio::is_canvas_tool(&call.name) {
        let payload = crate::mcp_stdio::canvas_payload(&call.name, &call.arguments);
        if let Err(e) = send_response(
            stdout,
            &ServerResponse::SessionUpdate(SessionUpdate {
                session_id: call.session_id.clone(),
                payload,
            }),
        )
        .await
        {
            let _ = reply_tx.send(fail(&call, &format!("cannot reach Maestro: {e}")));
            return;
        }
    }

    let arguments = call.arguments.clone();
    forward(&call, arguments, reply_tx, pending_host_tools, stdout).await;
}

/// Send `call` to the host with `arguments`, and park `reply_tx` for its answer. A failure to send
/// is answered on `reply_tx` at once.
async fn forward(
    call: &HostToolCall,
    arguments: Value,
    reply_tx: oneshot::Sender<HostToolResult>,
    pending_host_tools: &mut PendingHostTools,
    stdout: &crate::ClientOut,
) {
    let forwarded = host_call(call, arguments);
    let request_id = forwarded.request_id.clone();
    if let Err(e) = send_response(stdout, &ServerResponse::HostToolCall(forwarded)).await {
        let _ = reply_tx.send(fail(call, &format!("cannot reach Maestro: {e}")));
        return;
    }
    pending_host_tools.insert(request_id, (call.session_id.clone(), reply_tx));
}

/// `call` as the host sees it: `arguments`, and an id of the server's own.
fn host_call(call: &HostToolCall, arguments: Value) -> HostToolCall {
    static NEXT_ID: AtomicU64 = AtomicU64::new(0);
    HostToolCall {
        session_id: call.session_id.clone(),
        request_id: format!("host-{}", NEXT_ID.fetch_add(1, Ordering::Relaxed)),
        name: call.name.clone(),
        arguments,
    }
}

/// Send a shared prompt call to one window, and park a receiver for its answer. Any window can
/// answer it, held session or not, so it goes to exactly one or two would race. `None` when no
/// window is attached to take it.
async fn forward_to_one(
    call: &HostToolCall,
    arguments: Value,
    pending_host_tools: &mut PendingHostTools,
    stdout: &crate::ClientOut,
) -> Option<oneshot::Receiver<HostToolResult>> {
    let forwarded = host_call(call, arguments);
    let request_id = forwarded.request_id.clone();
    let message = ServerResponse::HostToolCall(forwarded);
    let buf = match maestro_protocol::encode_message(None, &message) {
        Ok(buf) => buf,
        Err(e) => {
            send_diag("warn", format!("[mcp] cannot encode a host call: {e}"));
            return None;
        }
    };
    if !stdout
        .lock()
        .await
        .write_to_one(&call.session_id, &buf)
        .await
    {
        return None;
    }
    let (tx, rx) = oneshot::channel();
    pending_host_tools.insert(request_id, (call.session_id.clone(), tx));
    Some(rx)
}

/// The project a calling session belongs to, and the task it was started for.
struct SessionTask {
    project_path: String,
    task_id: Option<i32>,
    /// What the session is to its task's loop, when it is one of the loop's own.
    loop_session: Option<crate::loop_engine::LoopSession>,
}

impl SessionTask {
    /// Whether `task_id` is the loop this session works for: it may not see that loop's commands
    /// or sealed paths, which would let it game the checks, nor change its task.
    fn owns_loop(&self, task_id: i32) -> bool {
        self.loop_session.is_some() && self.task_id == Some(task_id)
    }
}

/// Fail every call a closing session was waiting on, so its shim is not left hanging.
pub(crate) fn cancel_session(pending_host_tools: &mut PendingHostTools, session_id: &str) {
    let ids: Vec<String> = pending_host_tools
        .iter()
        .filter(|(_, (session, _))| session == session_id)
        .map(|(id, _)| id.clone())
        .collect();
    for id in ids {
        if let Some((session, sender)) = pending_host_tools.remove(&id) {
            let _ = sender.send(HostToolResult {
                session_id: session,
                request_id: id,
                result: serde_json::Value::Null,
                error: Some("session closed".to_string()),
            });
        }
    }
}

#[cfg(test)]
mod tests;
