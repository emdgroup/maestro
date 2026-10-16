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

use maestro_protocol::{
    CreateTaskRequest, GatewayRequest, HostToolCall, HostToolResult, LoopCheck, LoopCheckEntry,
    LoopCheckKind, LoopCheckSpec, LoopCheckState, LoopConfig, NewTaskComment, ProjectRef, RunMode,
    ServerRequest, ServerResponse, SessionUpdate, TaskDraft, TaskPriority, TaskRef, TaskStatus,
    TaskUpdate, UpdateTaskRequest, WorkspaceMode,
};
use rusqlite::Connection;
use serde_json::{json, Value};
use tokio::sync::{mpsc, oneshot};

use crate::helpers::send_response;
use crate::project_store::Store;
use crate::send_diag;
use crate::sessions::SessionMap;

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

const PROMPT_TOOLS: [&str; 5] = [
    "list_prompts",
    "get_prompt",
    "create_prompt",
    "update_prompt",
    "delete_prompt",
];

/// What an agent sees when it reaches for the shared collection with no window to hold it.
const NO_WINDOW: &str = "the shared prompts are kept by the Maestro app, and no Maestro window is \
                         open; only this project's prompts are available";

/// How long `list_prompts` waits for the shared half before answering with the project's alone.
const SHARED_LIST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// One prompt tool, split between the two collections.
///
/// The contract with the host, which `src-tauri` implements to match:
///
/// - The agent names a prompt `project-<n>` or `shared-<n>`, because the daemon and the app mint
///   ids independently. The project collection is answered here, from `prompt_store`, scoped to
///   the calling session's project.
/// - A call on the shared collection is forwarded as a `HostToolCall` with the **same tool name**,
///   to exactly one window (`ClientSink::write_to_one`: the session's owner, else the window
///   attached longest), which answers it whether or not it holds the session, and its arguments
///   rewritten: `id`, where there is one, is the bare integer `<n>`, and
///   `create_prompt` loses `collection`. Every other argument (`title`, `body`, `tags`,
///   `favorite`, `list_prompts`' `tag`) passes through as the agent sent it. The host only ever
///   deals with the shared collection and bare integer ids, and answers with bare integer ids.
/// - The gateway prefixes `shared-` on every id in the host's result: `id` on an object or on each
///   element of an array, and `deleted` on `delete_prompt`'s `{deleted}`.
/// - `list_prompts` is the one call that goes both ways. The host answers with an array of
///   `{id, title, tags, favorite}`; the agent gets `{prompts}`, the project's first, then the
///   shared ones. With no window attached, or a host that fails or takes longer than
///   `SHARED_LIST_TIMEOUT`, it gets the project's alone and a `shared_unavailable` note saying
///   why; with no project store or no project bound, the shared ones and `project_unavailable`.
///   Any other shared call with no window attached is refused with `NO_WINDOW`.
/// - Both collections answer a prompt with the same keys: `id`, `title`, `body`, `tags`,
///   `favorite`, `created_at`, `updated_at`.
/// - `update_prompt` has no `shared` argument any more: moving a prompt is a create in the other
///   collection. Its `favorite` stars the prompt in its own collection.
async fn prompt_call(
    call: HostToolCall,
    reply_tx: oneshot::Sender<HostToolResult>,
    project_path: Option<String>,
    store: Option<Store>,
    pending_host_tools: &mut PendingHostTools,
    stdout: &crate::ClientOut,
) {
    if call.name == "list_prompts" {
        let arguments = call.arguments.clone();
        let shared = forward_to_one(&call, arguments, pending_host_tools, stdout).await;
        let stdout = Arc::clone(stdout);
        tokio::spawn(async move {
            let project = project_prompt_tool(store, project_path, &call, &stdout).await;
            let _ = reply_tx.send(answer(&call, Ok(merge_lists(project, shared).await)));
        });
        return;
    }

    let shared_arguments = match shared_arguments(&call) {
        Ok(arguments) => arguments,
        Err(message) => {
            let _ = reply_tx.send(fail(&call, &message));
            return;
        }
    };
    let Some(arguments) = shared_arguments else {
        let stdout = Arc::clone(stdout);
        tokio::spawn(async move {
            let result = project_prompt_tool(store, project_path, &call, &stdout).await;
            let _ = reply_tx.send(answer(&call, result));
        });
        return;
    };

    let Some(rx) = forward_to_one(&call, arguments, pending_host_tools, stdout).await else {
        let _ = reply_tx.send(fail(&call, NO_WINDOW));
        return;
    };
    tokio::spawn(async move {
        let result = match tokio::time::timeout(HOST_TIMEOUT, rx).await {
            Ok(Ok(HostToolResult {
                error: None,
                mut result,
                ..
            })) => {
                prefix_shared_ids(&mut result);
                Ok(result)
            }
            Ok(Ok(HostToolResult {
                error: Some(message),
                ..
            })) => Err(message),
            Ok(Err(_)) => Err("Maestro dropped the call".to_string()),
            Err(_) => Err("host did not answer".to_string()),
        };
        let _ = reply_tx.send(answer(&call, result));
    });
}

fn answer(call: &HostToolCall, result: Result<Value, String>) -> HostToolResult {
    match result {
        Ok(result) => HostToolResult {
            session_id: call.session_id.clone(),
            request_id: call.request_id.clone(),
            result,
            error: None,
        },
        Err(message) => fail(call, &message),
    }
}

/// The arguments to forward if `call` is on the shared collection, `None` if it is on the
/// project's. `list_prompts` is neither and never comes here.
fn shared_arguments(call: &HostToolCall) -> Result<Option<Value>, String> {
    let mut arguments = call.arguments.clone();
    if call.name == "create_prompt" {
        let collection = arguments
            .as_object_mut()
            .and_then(|object| object.remove("collection"));
        return match collection {
            None | Some(Value::Null) => Ok(None),
            Some(Value::String(name)) if name == "project" => Ok(None),
            Some(Value::String(name)) if name == "shared" => Ok(Some(arguments)),
            Some(other) => Err(format!(
                "collection must be \"project\" or \"shared\", got {other}"
            )),
        };
    }
    match parse_prompt_id(&call.arguments)? {
        PromptId::Project(_) => Ok(None),
        PromptId::Shared(id) => {
            if let Some(object) = arguments.as_object_mut() {
                object.insert("id".into(), json!(id));
            }
            Ok(Some(arguments))
        }
    }
}

enum PromptId {
    Project(i32),
    Shared(i32),
}

fn parse_prompt_id(arguments: &Value) -> Result<PromptId, String> {
    let invalid =
        || "id must be a prompt id from list_prompts, like project-3 or shared-3".to_string();
    let raw = arguments
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(invalid)?;
    let number = |digits: &str| digits.parse::<i32>().map_err(|_| invalid());
    if let Some(digits) = raw.strip_prefix("project-") {
        Ok(PromptId::Project(number(digits)?))
    } else if let Some(digits) = raw.strip_prefix("shared-") {
        Ok(PromptId::Shared(number(digits)?))
    } else {
        Err(invalid())
    }
}

fn prefix_shared_ids(value: &mut Value) {
    match value {
        Value::Array(items) => items.iter_mut().for_each(prefix_shared_ids),
        Value::Object(object) => {
            for key in ["id", "deleted"] {
                if let Some(id) = object.get(key).and_then(Value::as_i64) {
                    object.insert(key.into(), json!(format!("shared-{id}")));
                }
            }
        }
        _ => {}
    }
}

/// The project's list followed by the host's. A half that cannot be read is left out, with a note
/// saying why in its place, so one collection failing never hides the other.
async fn merge_lists(
    project: Result<Value, String>,
    shared: Option<oneshot::Receiver<HostToolResult>>,
) -> Value {
    let shared = match shared {
        None => Err(NO_WINDOW.to_string()),
        Some(rx) => match tokio::time::timeout(SHARED_LIST_TIMEOUT, rx).await {
            Ok(Ok(HostToolResult {
                error: None,
                mut result,
                ..
            })) => {
                prefix_shared_ids(&mut result);
                match result {
                    Value::Array(rows) => Ok(rows),
                    other => Err(format!("the app answered with {other}, not a list")),
                }
            }
            Ok(Ok(HostToolResult {
                error: Some(message),
                ..
            })) => Err(format!("the shared prompts could not be read: {message}")),
            Ok(Err(_)) | Err(_) => {
                Err("the Maestro app did not answer for the shared prompts".into())
            }
        },
    };
    let mut prompts = Vec::new();
    let mut result = serde_json::Map::new();
    match project {
        Ok(mut project) => {
            if let Some(Value::Array(rows)) = project.get_mut("prompts").map(Value::take) {
                prompts = rows;
            }
        }
        Err(note) => {
            result.insert("project_unavailable".into(), json!(note));
        }
    }
    match shared {
        Ok(rows) => prompts.extend(rows),
        Err(note) => {
            result.insert("shared_unavailable".into(), json!(note));
        }
    }
    result.insert("prompts".into(), Value::Array(prompts));
    Value::Object(result)
}

/// One prompt tool on the project's collection, answered from the store. Every lookup is scoped to
/// the session's project, so an id from another project's collection finds nothing.
async fn project_prompt_tool(
    store: Option<Store>,
    project_path: Option<String>,
    call: &HostToolCall,
    stdout: &crate::ClientOut,
) -> Result<Value, String> {
    let project_path = project_path
        .ok_or_else(|| "this session is not attached to a Maestro project".to_string())?;
    let store = store.ok_or_else(|| crate::project_store::UNAVAILABLE.to_string())?;
    let project_path = crate::automations::canonical_project_path(&project_path);
    let (result, changed) = {
        let conn = store.lock().await;
        project_prompt(&conn, &project_path, &call.name, &call.arguments)?
    };
    if changed {
        crate::helpers::broadcast(
            stdout,
            ServerResponse::PromptsChanged(ProjectRef { project_path }),
        )
        .await;
    }
    Ok(result)
}

/// The result, and whether the collection changed.
fn project_prompt(
    conn: &Connection,
    project_path: &str,
    name: &str,
    arguments: &Value,
) -> Result<(Value, bool), String> {
    use crate::prompt_store;
    let id = || match parse_prompt_id(arguments)? {
        PromptId::Project(id) => Ok(id),
        PromptId::Shared(_) => Err(UNEXPECTED_PROMPT.to_string()),
    };
    let visible = |id: i32| {
        prompt_store::get(conn, project_path, id)?
            .ok_or_else(|| format!("no prompt project-{id} in this project"))
    };
    Ok(match name {
        "list_prompts" => {
            let tag = string_argument(arguments, "tag")?;
            let rows: Vec<Value> = prompt_store::list(conn, project_path)?
                .iter()
                .filter(|prompt| tag.as_ref().is_none_or(|tag| prompt.tags.contains(tag)))
                .map(|prompt| {
                    json!({
                        "id": format!("project-{}", prompt.id),
                        "title": prompt.title,
                        "tags": prompt.tags,
                        "favorite": prompt.favorite,
                    })
                })
                .collect();
            (json!({ "prompts": rows }), false)
        }
        "get_prompt" => (prompt_json(&visible(id()?)?), false),
        "create_prompt" => {
            let request = maestro_protocol::CreatePromptRequest {
                project_path: project_path.to_string(),
                title: string_argument(arguments, "title")?.unwrap_or_default(),
                body: string_argument(arguments, "body")?.unwrap_or_default(),
                tags: tags_argument(arguments)?.unwrap_or_default(),
                favorite: bool_argument(arguments, "favorite")?.unwrap_or(false),
            };
            (prompt_json(&prompt_store::create(conn, &request)?), true)
        }
        // Partial, as the host's was: what the agent leaves out keeps its value. The store's update
        // replaces title, body and tags together, so the gap is filled from the row first, under the
        // same lock. The favorite is not an edit and goes on its own.
        "update_prompt" => {
            let mut prompt = visible(id()?)?;
            let title = string_argument(arguments, "title")?;
            let body = string_argument(arguments, "body")?;
            let tags = tags_argument(arguments)?;
            let favorite = bool_argument(arguments, "favorite")?;
            if title.is_some() || body.is_some() || tags.is_some() {
                let request = maestro_protocol::UpdatePromptRequest {
                    project_path: project_path.to_string(),
                    prompt_id: prompt.id,
                    title: title.unwrap_or(prompt.title),
                    body: body.unwrap_or(prompt.body),
                    tags: tags.unwrap_or(prompt.tags),
                };
                prompt = prompt_store::update(conn, &request)?;
            }
            if let Some(favorite) = favorite {
                prompt = prompt_store::set_favorite(conn, project_path, prompt.id, favorite)?;
            }
            (prompt_json(&prompt), true)
        }
        "delete_prompt" => {
            let id = id()?;
            if !prompt_store::delete(conn, project_path, id)? {
                return Err(format!("no prompt project-{id} in this project"));
            }
            (json!({ "deleted": format!("project-{id}") }), true)
        }
        other => return Err(format!("unknown Maestro tool: {other}")),
    })
}

const UNEXPECTED_PROMPT: &str = "a shared prompt reached the project's collection";

fn prompt_json(prompt: &maestro_protocol::Prompt) -> Value {
    json!({
        "id": format!("project-{}", prompt.id),
        "title": prompt.title,
        "body": prompt.body,
        "tags": prompt.tags,
        "favorite": prompt.favorite,
        "created_at": prompt.created_at,
        "updated_at": prompt.updated_at,
    })
}

// Absent and null both mean "leave it"; a value of the wrong type is refused with the field's
// name rather than coerced, since nothing validates a tool's schema before it gets here.
fn string_argument(arguments: &Value, key: &str) -> Result<Option<String>, String> {
    match arguments.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.clone())),
        Some(_) => Err(format!("{key} must be a string")),
    }
}

fn bool_argument(arguments: &Value, key: &str) -> Result<Option<bool>, String> {
    match arguments.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Bool(value)) => Ok(Some(*value)),
        Some(_) => Err(format!("{key} must be true or false")),
    }
}

fn tags_argument(arguments: &Value) -> Result<Option<Vec<String>>, String> {
    match arguments.get("tags") {
        None | Some(Value::Null) => Ok(None),
        Some(value) => serde_json::from_value(value.clone())
            .map(Some)
            .map_err(|_| "tags must be a list of strings".to_string()),
    }
}

const TASK_TOOLS: [&str; 8] = [
    "create_task",
    "list_tasks",
    "get_task",
    "update_task",
    "comment_task",
    "loop_status",
    "loop_propose_check",
    "loop_blocked",
];

/// Mirrors the `priority` enum in the `create_task` tool schema and `TaskPriority`.
const PRIORITIES: [&str; 5] = ["Urgent", "High", "Medium", "Low", "None"];

/// The board columns, and the only statuses `update_task` accepts.
///
/// `Cancelled` is deliberately absent: cancelling also archives, which an update does not do, so
/// an agent asking for it would produce a task that is cancelled and still sitting on the board.
const STATUSES: [&str; 5] = ["Planning", "Queue", "InProgress", "Review", "Done"];

/// How much of a task's thread `get_task` carries back. Newest kept: an old note matters less
/// than the verdict that came after it, and a CI-heavy task can run to hundreds of entries.
const MAX_THREAD_ENTRIES: usize = 20;

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

/// The loop fields of `create_task` and `update_task`, each `None` when the agent left it out.
#[derive(Default)]
struct LoopFields {
    run_mode: Option<RunMode>,
    checks: Option<Vec<LoopCheckSpec>>,
    max_iterations: Option<u32>,
    max_build_minutes: Option<u32>,
    stall_limit: Option<u32>,
    check_timeout_minutes: Option<u32>,
    setup_command: Option<String>,
    sealed_paths: Option<Vec<String>>,
}

impl LoopFields {
    fn parse(arguments: &Value) -> Result<LoopFields, String> {
        let number = |key: &str| -> Result<Option<u32>, String> {
            match arguments.get(key) {
                None | Some(Value::Null) => Ok(None),
                Some(value) => value
                    .as_u64()
                    .filter(|n| *n >= 1)
                    .and_then(|n| u32::try_from(n).ok())
                    .map(Some)
                    .ok_or_else(|| format!("{key} must be a whole number of at least 1")),
            }
        };
        let checks = match arguments.get("checks") {
            None | Some(Value::Null) => None,
            Some(value) => {
                let specs: Vec<LoopCheckSpec> =
                    serde_json::from_value(value.clone()).map_err(|_| {
                        "checks must be a list of {kind, label, command}, kind one of Command, \
                         Judge or Manual"
                            .to_string()
                    })?;
                Some(
                    specs
                        .iter()
                        .map(crate::task_store::loops::spec)
                        .collect::<Result<_, _>>()?,
                )
            }
        };
        Ok(LoopFields {
            run_mode: parse_enum(arguments, "run_mode", &["Pipeline", "Loop"])?
                .map(|name| serde_json::from_value(Value::String(name)))
                .transpose()
                .map_err(|e| e.to_string())?,
            checks,
            max_iterations: number("max_iterations")?,
            max_build_minutes: number("max_build_minutes")?,
            stall_limit: number("stall_limit")?,
            check_timeout_minutes: number("check_timeout_minutes")?,
            setup_command: string_argument(arguments, "setup_command")?,
            sealed_paths: arguments
                .get("sealed_paths")
                .filter(|value| !value.is_null())
                .map(|value| string_list(Some(value))),
        })
    }

    fn budgets(&self) -> bool {
        self.max_iterations.is_some()
            || self.max_build_minutes.is_some()
            || self.stall_limit.is_some()
            || self.check_timeout_minutes.is_some()
    }

    /// What a loop that has started no longer takes from an agent.
    fn shape(&self) -> bool {
        self.run_mode.is_some()
            || self.checks.is_some()
            || self.setup_command.is_some()
            || self.sealed_paths.is_some()
    }

    fn any(&self) -> bool {
        self.budgets() || self.shape()
    }

    /// Fields only a loop has.
    fn loop_only(&self) -> bool {
        self.budgets()
            || self.checks.is_some()
            || self.setup_command.is_some()
            || self.sealed_paths.is_some()
    }

    /// `config` with these fields over it. The sealed paths are the ones `sealable` returned.
    fn over(&self, mut config: LoopConfig, sealed: Option<Vec<String>>) -> LoopConfig {
        if let Some(n) = self.max_iterations {
            config.max_iterations = n;
        }
        if let Some(minutes) = self.max_build_minutes {
            config.max_build_secs = minutes.saturating_mul(60);
        }
        if let Some(n) = self.stall_limit {
            config.stall_limit = n;
        }
        if let Some(minutes) = self.check_timeout_minutes {
            config.check_timeout_secs = minutes.saturating_mul(60);
        }
        if let Some(setup) = &self.setup_command {
            config.setup_command = Some(setup.clone());
        }
        if let Some(sealed) = sealed {
            config.sealed_paths = sealed;
        }
        config
    }

    /// The sealed paths named, each checked where the checks will run, as the app's are.
    async fn sealed(
        &self,
        store: &Store,
        project_path: &str,
        task_id: Option<i32>,
        base: &str,
    ) -> Result<Option<Vec<String>>, String> {
        let Some(paths) = &self.sealed_paths else {
            return Ok(None);
        };
        let mut sealed = Vec::new();
        for path in paths {
            let found =
                crate::loop_engine::sealable(store, project_path, task_id, base, path).await?;
            sealed.push(found);
        }
        Ok(Some(sealed))
    }
}

const NOT_A_LOOP: &str = "checks and budgets are a loop's: pass run_mode \"Loop\" with them";

/// The keys of `.maestro/settings.json` a new task's defaults come from. The app owns the file.
#[derive(Default, serde::Deserialize)]
#[serde(default)]
struct ProjectSettings {
    base_branch: Option<String>,
    default_workspace_mode: Option<WorkspaceMode>,
    /// The key `default_workspace_mode` replaced: `false` meant the repository directory.
    default_worktree: Option<bool>,
}

/// One task tool, answered from the store. Every one is scoped to the session's project: ids are
/// small integers, so without that an agent could read or move another project's board by
/// guessing. Returns the result and the pushes the change owes every window.
async fn task_tool(
    store: Option<Store>,
    binding: Option<SessionTask>,
    name: &str,
    arguments: &Value,
    draft: Option<TaskDraft>,
) -> Result<(Value, Vec<ServerResponse>), String> {
    let binding =
        binding.ok_or_else(|| "this session is not attached to a Maestro project".to_string())?;
    let store = store.ok_or_else(|| crate::project_store::UNAVAILABLE.to_string())?;
    let project_path = binding.project_path.clone();
    let mut pushes = Vec::new();

    let result = match name {
        "loop_status" | "loop_propose_check" | "loop_blocked" => {
            loop_tool(&store, &binding, name, arguments, &mut pushes).await?
        }
        "create_task" => {
            let title = parse_title(arguments)?;
            let priority = parse_priority(arguments)?;
            let fields = LoopFields::parse(arguments)?;
            let looping = fields.run_mode == Some(RunMode::Loop);
            if fields.loop_only() && !looping {
                return Err(NOT_A_LOOP.to_string());
            }
            let (base_branch, workspace_mode) = task_defaults(&project_path).await;
            let (workspace_mode, loop_config) = if looping {
                let sealed = fields
                    .sealed(&store, &project_path, None, &base_branch)
                    .await?;
                let config = fields.over(LoopConfig::default(), sealed);
                (WorkspaceMode::NewWorktree, Some(config))
            } else {
                (workspace_mode, None)
            };
            let request = ServerRequest::CreateTask(CreateTaskRequest {
                project_path: project_path.clone(),
                title,
                description: arguments
                    .get("description")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                skills: Vec::new(),
                labels: string_list(arguments.get("labels")),
                base_branch,
                agent_id: None,
                priority,
                auto_approve: false,
                workspace_mode,
                workspace_worktree_id: None,
                workspace_branch_mode: maestro_protocol::BranchMode::Create,
                workspace_branch: None,
                model_override: None,
                run_mode: fields.run_mode.unwrap_or_default(),
                loop_config,
            });
            let mut conn = store.lock().await;
            let ServerResponse::CreateTaskOk(task) = ask(&mut conn, request, &mut pushes)? else {
                return Err(UNEXPECTED.to_string());
            };
            if let Some(checks) = fields.checks.filter(|_| looping) {
                let request =
                    ServerRequest::SetLoopChecks(maestro_protocol::SetLoopChecksRequest {
                        project_path: project_path.clone(),
                        task_id: task.id,
                        checks: checks
                            .into_iter()
                            .map(|spec| LoopCheckEntry { id: None, spec })
                            .collect(),
                    });
                ask(&mut conn, request, &mut pushes)?;
            }
            if let Some(draft) = draft {
                crate::task_store::set_drafted_by(&conn, &task.project_path, task.id, &draft)?;
                let run = draft.run.map(|n| format!(", run #{n}")).unwrap_or_default();
                let body = format!("Drafted by the automation \"{}\"{run}.", draft.automation);
                let request =
                    ServerRequest::AddTaskComment(maestro_protocol::AddTaskCommentRequest {
                        project_path,
                        task_id: task.id,
                        comment: NewTaskComment {
                            kind: "note".to_string(),
                            author: "maestro".to_string(),
                            body: Some(body),
                            external_ref: None,
                            phase: None,
                        },
                    });
                ask(&mut conn, request, &mut pushes)?;
            }
            json!({
                "id": task.id,
                "title": task.title,
                "status": task.status,
                "runMode": task.run_mode,
            })
        }
        "list_tasks" => {
            let wanted: Option<TaskStatus> = match arguments.get("status") {
                Some(value) if !value.is_null() => Some(
                    serde_json::from_value(value.clone())
                        .map_err(|_| format!("unknown status: {value}"))?,
                ),
                _ => None,
            };
            let request = ServerRequest::ListTasks(ProjectRef { project_path });
            let ServerResponse::ListTasksOk(list) =
                ask(&mut *store.lock().await, request, &mut pushes)?
            else {
                return Err(UNEXPECTED.to_string());
            };
            let rows: Vec<Value> = list
                .tasks
                .iter()
                .filter(|task| task.archived_at.is_none())
                .filter(|task| wanted.is_none_or(|status| task.status == status))
                .map(task_summary)
                .collect();
            json!({ "tasks": rows })
        }
        "get_task" => {
            let task_id = parse_task_id(&binding, arguments)?;
            let mut conn = store.lock().await;
            let task = task_in_project(&mut conn, &project_path, task_id)?;
            let checks = match task.run_mode {
                RunMode::Loop => {
                    crate::task_store::loops::list_checks(&conn, &task.project_path, task_id)?
                }
                RunMode::Pipeline => Vec::new(),
            };
            let request = ServerRequest::ListTaskComments(TaskRef {
                project_path,
                task_id,
            });
            let ServerResponse::ListTaskCommentsOk(thread) = ask(&mut conn, request, &mut pushes)?
            else {
                return Err(UNEXPECTED.to_string());
            };
            drop(conn);

            let total = thread.comments.len();
            let entries: Vec<Value> = thread
                .comments
                .into_iter()
                .skip(total.saturating_sub(MAX_THREAD_ENTRIES))
                .map(|comment| {
                    json!({
                        "kind": comment.kind,
                        "author": comment.author,
                        "body": comment.body,
                        "createdAt": comment.created_at,
                    })
                })
                .collect();
            let mut value = task_summary(&task);
            let object = value
                .as_object_mut()
                .ok_or_else(|| "task summary is not an object".to_string())?;
            object.insert("description".into(), json!(task.description));
            object.insert("baseBranch".into(), json!(task.base_branch));
            object.insert("createdAt".into(), json!(task.created_at));
            object.insert("runMode".into(), json!(task.run_mode));
            if task.run_mode == RunMode::Loop {
                let own = binding.owns_loop(task_id);
                object.insert("loop".into(), loop_json(&task, &checks, own));
            }
            object.insert("thread".into(), Value::Array(entries));
            if total > MAX_THREAD_ENTRIES {
                object.insert("threadTruncated".into(), json!(total - MAX_THREAD_ENTRIES));
            }
            value
        }
        "update_task" => {
            let task_id = parse_task_id(&binding, arguments)?;
            let status = parse_enum(arguments, "status", &STATUSES)?
                .map(|name| serde_json::from_value::<TaskStatus>(Value::String(name)))
                .transpose()
                .map_err(|e| e.to_string())?;
            let priority = parse_priority(arguments)?;
            let title = match arguments.get("title") {
                None | Some(Value::Null) => None,
                Some(_) => Some(parse_title(arguments)?),
            };
            let description = match arguments.get("description") {
                None | Some(Value::Null) => None,
                Some(value) => Some(
                    value
                        .as_str()
                        .ok_or_else(|| format!("description must be a string, got {value}"))?
                        .to_string(),
                ),
            };
            let labels = arguments
                .get("labels")
                .map(|_| string_list(arguments.get("labels")));
            let fields = LoopFields::parse(arguments)?;
            if status.is_none()
                && priority.is_none()
                && title.is_none()
                && description.is_none()
                && labels.is_none()
                && !fields.any()
            {
                return Err("nothing to update".to_string());
            }
            if binding.owns_loop(task_id) {
                return Err("a loop's own session cannot change its task".to_string());
            }

            let task = task_in_project(&mut *store.lock().await, &project_path, task_id)?;
            let mut update = TaskUpdate {
                status,
                title,
                description: description.map(Some),
                priority,
                labels,
                ..TaskUpdate::default()
            };
            if fields.any() {
                if fields.run_mode.is_some_and(|mode| mode != task.run_mode) {
                    return Err("a task's run mode is fixed when it is created".to_string());
                }
                let looping = task.run_mode == RunMode::Loop;
                if fields.loop_only() && !looping {
                    return Err(NOT_A_LOOP.to_string());
                }
                let started = task.phase.is_some()
                    || !matches!(task.status, TaskStatus::Planning | TaskStatus::Queue);
                if started && fields.shape() {
                    return Err("once a loop has started only its budgets change here; its \
                                checks, setup command and sealed paths change in the app"
                        .to_string());
                }
                if looping {
                    let sealed = fields
                        .sealed(&store, &project_path, Some(task_id), &task.base_branch)
                        .await?;
                    let config = task.loop_config.clone().unwrap_or_default();
                    update.loop_config = Some(fields.over(config, sealed));
                }
            }

            let mut conn = store.lock().await;
            // A status is a manual move, the same as the user dragging the card.
            let request = ServerRequest::UpdateTask(UpdateTaskRequest {
                project_path: project_path.clone(),
                task_id,
                update,
            });
            let ServerResponse::UpdateTaskOk(task) = ask(&mut conn, request, &mut pushes)? else {
                return Err(UNEXPECTED.to_string());
            };
            if let Some(checks) = fields.checks {
                let request =
                    ServerRequest::SetLoopChecks(maestro_protocol::SetLoopChecksRequest {
                        project_path,
                        task_id,
                        checks: checks
                            .into_iter()
                            .map(|spec| LoopCheckEntry { id: None, spec })
                            .collect(),
                    });
                ask(&mut conn, request, &mut pushes)?;
            }
            task_summary(&task)
        }
        // Always a `note`, and always authored `agent`: the typed kinds are the pipeline's own
        // record of what a phase concluded, and a gate pointing at "the plan that was approved"
        // must not be something a tool call can forge afterwards.
        "comment_task" => {
            let task_id = parse_task_id(&binding, arguments)?;
            let body = arguments
                .get("body")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|body| !body.is_empty())
                .ok_or_else(|| "body is required".to_string())?;
            let mut conn = store.lock().await;
            task_in_project(&mut conn, &project_path, task_id)?;
            let request = ServerRequest::AddTaskComment(maestro_protocol::AddTaskCommentRequest {
                project_path,
                task_id,
                comment: NewTaskComment {
                    kind: "note".to_string(),
                    author: "agent".to_string(),
                    body: Some(body.to_string()),
                    external_ref: None,
                    phase: None,
                },
            });
            let ServerResponse::AddTaskCommentOk(comment) = ask(&mut conn, request, &mut pushes)?
            else {
                return Err(UNEXPECTED.to_string());
            };
            json!({ "id": comment.id, "taskId": task_id, "createdAt": comment.created_at })
        }
        other => return Err(format!("unknown Maestro tool: {other}")),
    };
    Ok((result, pushes))
}

const UNEXPECTED: &str = "the task store answered with the wrong reply";

/// One request through the same path a window's takes, so canonicalization and pushes match.
fn ask(
    conn: &mut Connection,
    request: ServerRequest,
    pushes: &mut Vec<ServerResponse>,
) -> Result<ServerResponse, String> {
    let (reply, more) = crate::task_store::requests::answer(conn, request)?;
    pushes.extend(more);
    Ok(reply)
}

fn task_in_project(
    conn: &mut Connection,
    project_path: &str,
    task_id: i32,
) -> Result<maestro_protocol::Task, String> {
    let request = ServerRequest::GetTask(TaskRef {
        project_path: project_path.to_string(),
        task_id,
    });
    match crate::task_store::requests::answer(conn, request)?.0 {
        ServerResponse::GetTaskOk(found) => found
            .task
            .ok_or_else(|| format!("no task {task_id} in this project")),
        _ => Err(UNEXPECTED.to_string()),
    }
}

fn task_summary(task: &maestro_protocol::Task) -> Value {
    json!({
        "id": task.id,
        "title": task.title,
        "status": task.status,
        "priority": task.priority,
        "labels": task.labels,
    })
}

/// A loop as `get_task` shows it. The loop's own sessions get its checks without their commands,
/// and neither the setup command nor the sealed paths: those would say what to game.
fn loop_json(task: &maestro_protocol::Task, checks: &[LoopCheck], own: bool) -> Value {
    let config = task.loop_config.clone().unwrap_or_default();
    let summary = task.loop_summary.as_deref();
    let checks: Vec<Value> = checks
        .iter()
        .map(|check| {
            let mut value = json!({
                "label": check.label,
                "kind": check.kind,
                "state": check.state,
            });
            if check.proposed && !check.accepted {
                value["proposed"] = json!(true);
            }
            if let Some(command) = check.command.as_ref().filter(|_| !own) {
                value["command"] = json!(command);
            }
            value
        })
        .collect();
    let mut value = json!({
        "checks": checks,
        "maxIterations": config.max_iterations,
        "maxBuildMinutes": config.max_build_secs / 60,
        "stallLimit": config.stall_limit,
        "checkTimeoutMinutes": config.check_timeout_secs / 60,
        "iteration": summary.map_or(0, |s| s.iteration),
        "halt": summary
            .and_then(|s| s.halt)
            .filter(|_| task.ball == maestro_protocol::TaskBall::User),
    });
    if !own {
        value["setupCommand"] = json!(config.setup_command);
        value["sealedPaths"] = json!(config.sealed_paths);
    }
    value
}

/// The worker's loop tools, answered only for the iteration that is running: a session the loop
/// has moved on from no longer acts for it.
async fn loop_tool(
    store: &Store,
    binding: &SessionTask,
    name: &str,
    arguments: &Value,
    pushes: &mut Vec<ServerResponse>,
) -> Result<Value, String> {
    use crate::task_store::loops;
    use maestro_protocol::LoopIterationOutcome;

    let (Some(crate::loop_engine::LoopSession::Iteration(n)), Some(task_id)) =
        (&binding.loop_session, binding.task_id)
    else {
        return Err("this session is not a loop iteration".to_string());
    };
    let n = *n;
    let path = crate::automations::canonical_project_path(&binding.project_path);
    let mut conn = store.lock().await;
    let task = task_in_project(&mut conn, &path, task_id)?;
    let iterations = loops::list_iterations(&conn, &path, task_id)?;
    let running = task.phase == Some(maestro_protocol::TaskPhase::Iterating)
        && iterations
            .iter()
            .any(|i| i.n == n && i.outcome == LoopIterationOutcome::Running);
    if !running {
        return Err(format!(
            "iteration {n} is over, so this session no longer acts for the loop"
        ));
    }
    match name {
        "loop_status" => {
            let checks = loops::list_checks(&conn, &path, task_id)?;
            Ok(loop_status(&task, n, &checks, &iterations))
        }
        "loop_propose_check" => {
            let label = required_text(arguments, "label")?;
            let why = string_argument(arguments, "why")?.filter(|s| !s.trim().is_empty());
            let command = string_argument(arguments, "command")?.filter(|s| !s.trim().is_empty());
            let id = loops::propose_check(
                &mut conn,
                &path,
                task_id,
                &label,
                why.as_deref().map(str::trim),
                command.as_deref().map(str::trim),
            )?;
            pushes.push(ServerResponse::TasksChanged(ProjectRef {
                project_path: path,
            }));
            Ok(json!({
                "id": id,
                "proposed": label,
                "note": "The user decides whether to add it. Carry on meanwhile.",
            }))
        }
        "loop_blocked" => {
            let reason = required_text(arguments, "reason")?;
            loops::set_blocked(&conn, &path, task_id, n, &reason)?;
            Ok(json!({
                "blocked": true,
                "next": "End your turn now. Your work is committed, the checks do not run, and \
                         the loop waits for the user's answer.",
            }))
        }
        other => Err(format!("unknown Maestro tool: {other}")),
    }
}

/// Where the loop stands, for its worker: never a check's command, and the output it is shown is
/// the output its prompt carried.
fn loop_status(
    task: &maestro_protocol::Task,
    n: i32,
    checks: &[LoopCheck],
    iterations: &[maestro_protocol::LoopIteration],
) -> Value {
    use maestro_protocol::LoopIterationOutcome;

    let config = task.loop_config.clone().unwrap_or_default();
    let summary = task.loop_summary.as_deref();
    let counted = summary.map_or(0, |s| s.counted).max(0) as u32;
    // This Build's own time, the limit it is closed at.
    let build_secs = iterations
        .iter()
        .rev()
        .find(|i| i.outcome == LoopIterationOutcome::Running)
        .and_then(|i| chrono::DateTime::parse_from_rfc3339(&i.started_at).ok())
        .map_or(0, |started| {
            (chrono::Utc::now() - started.to_utc()).num_seconds()
        });
    let rows: Vec<Value> = checks
        .iter()
        .filter(|c| !c.proposed || c.accepted)
        .map(|c| {
            let mut value = json!({ "label": c.label, "kind": c.kind, "state": c.state });
            match (c.kind, c.state, c.detail.as_deref()) {
                (LoopCheckKind::Command, LoopCheckState::Fail | LoopCheckState::Flaky, Some(d)) => {
                    value["output"] = json!(d)
                }
                (LoopCheckKind::Judge, _, Some(d)) => value["reason"] = json!(d),
                _ => {}
            }
            value
        })
        .collect();
    let proposals: Vec<&str> = checks
        .iter()
        .filter(|c| c.proposed && !c.accepted)
        .map(|c| c.label.as_str())
        .collect();
    let mut value = json!({
        "goal": task.description,
        "iteration": n,
        "maxIterations": config.max_iterations,
        "budget": {
            "iterationsAfterThis": config.max_iterations.saturating_sub(counted + 1),
            "buildMinutesLeft": (i64::from(config.max_build_secs) - build_secs).max(0) / 60,
        },
        "checks": rows,
        "proposals": proposals,
    });
    let last = iterations
        .iter()
        .rev()
        .find(|i| i.outcome != LoopIterationOutcome::Running);
    if let Some(error) = last
        .filter(|i| i.outcome == LoopIterationOutcome::Failed)
        .and_then(|i| i.check_output.as_deref())
    {
        value["lastError"] = json!(error);
    }
    value
}

/// A string argument that must be there and not blank, trimmed.
fn required_text(arguments: &Value, key: &str) -> Result<String, String> {
    string_argument(arguments, key)?
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("{key} is required"))
}

/// Which task the agent means. An absent `id` is the task this session was started for, which is
/// what the agent almost always wants and cannot otherwise name: it is told what to do, not which
/// card that came from.
fn parse_task_id(binding: &SessionTask, arguments: &Value) -> Result<i32, String> {
    match arguments.get("id") {
        None | Some(Value::Null) => binding
            .task_id
            .ok_or_else(|| "this session is not attached to a task — pass an id".to_string()),
        Some(value) => value
            .as_i64()
            .map(|id| id as i32)
            .ok_or_else(|| format!("id must be a number, got {value}")),
    }
}

/// Trimmed and required to be non-empty: nothing enforces the tool schema's `minLength` for these
/// tools, so a whitespace title would otherwise reach the board as a blank card.
fn parse_title(arguments: &Value) -> Result<String, String> {
    let title = arguments
        .get("title")
        .and_then(Value::as_str)
        .ok_or_else(|| "title is required".to_string())?
        .trim();
    if title.is_empty() {
        return Err("title is required".to_string());
    }
    Ok(title.to_string())
}

/// One of a fixed set of names, if the agent supplied it. Rejected rather than coerced: silently
/// filing a task as Medium because the agent invented a priority is the kind of thing nobody
/// notices.
fn parse_enum(arguments: &Value, key: &str, allowed: &[&str]) -> Result<Option<String>, String> {
    let value = match arguments.get(key) {
        None | Some(Value::Null) => return Ok(None),
        Some(value) => value,
    };
    let name = value
        .as_str()
        .ok_or_else(|| format!("{key} must be a string, got {value}"))?;
    if !allowed.contains(&name) {
        return Err(format!(
            "unknown {key} {name:?} — use one of {}",
            allowed.join(", ")
        ));
    }
    Ok(Some(name.to_string()))
}

fn parse_priority(arguments: &Value) -> Result<Option<TaskPriority>, String> {
    parse_enum(arguments, "priority", &PRIORITIES)?
        .map(|name| serde_json::from_value(Value::String(name)))
        .transpose()
        .map_err(|e| e.to_string())
}

fn string_list(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

/// A new task's base branch and workspace mode, as the create dialog resolves them: the project's
/// configured defaults, else whatever the repository is on and a worktree of its own. The daemon
/// is on the project's machine, so both are read here.
async fn task_defaults(project_path: &str) -> (String, WorkspaceMode) {
    let settings: ProjectSettings =
        tokio::fs::read_to_string(format!("{project_path}/.maestro/settings.json"))
            .await
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default();
    let workspace_mode =
        settings
            .default_workspace_mode
            .unwrap_or(match settings.default_worktree {
                Some(false) => WorkspaceMode::RepositoryDirectory,
                _ => WorkspaceMode::NewWorktree,
            });
    let base_branch = match settings.base_branch {
        Some(branch) => branch,
        None => crate::worktree::git(project_path, &["symbolic-ref", "--short", "HEAD"])
            .await
            .map(|out| out.trim().to_string())
            .ok()
            .filter(|branch| !branch.is_empty())
            .unwrap_or_else(|| "main".to_string()),
    };
    (base_branch, workspace_mode)
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
mod tests {
    use super::*;

    fn pending_with(
        entries: &[(&str, &str)],
    ) -> (PendingHostTools, Vec<oneshot::Receiver<HostToolResult>>) {
        let mut pending = PendingHostTools::new();
        let mut receivers = Vec::new();
        for (request_id, session_id) in entries {
            let (tx, rx) = oneshot::channel();
            pending.insert((*request_id).to_string(), ((*session_id).to_string(), tx));
            receivers.push(rx);
        }
        (pending, receivers)
    }

    fn session_in(project_path: &str, task_id: Option<i32>) -> crate::sessions::ActiveSession {
        let (cmd_tx, _cmd_rx) = mpsc::channel(4);
        crate::sessions::ActiveSession {
            cmd_tx,
            pending_permissions: Default::default(),
            pending_elicitations: Default::default(),
            task: tokio::spawn(async {}),
            cleanup: None,
            agent_id: "agent".to_string(),
            cwd: project_path.to_string(),
            additional_directories: Vec::new(),
            project: Some(crate::sessions::ProjectBinding {
                project_path: project_path.to_string(),
                meta: maestro_protocol::SessionMeta {
                    task_id,
                    ..Default::default()
                },
                can_reload: false,
                requested_at: chrono::Utc::now(),
            }),
            turn_active: Default::default(),
            idle_marked: false,
        }
    }

    /// One tool call through the gateway, as the main loop makes it.
    async fn call(
        sessions: &SessionMap,
        store: Option<&Store>,
        name: &str,
        arguments: Value,
    ) -> HostToolResult {
        let (reply_tx, reply_rx) = oneshot::channel();
        let mut pending = PendingHostTools::new();
        let call = HostToolCall {
            session_id: "session".to_string(),
            request_id: "request".to_string(),
            name: name.to_string(),
            arguments,
        };
        let sink = crate::client_sink::ClientSink::detached();
        handle_host_tool_call(call, reply_tx, sessions, store, None, &mut pending, &sink).await;
        assert!(pending.is_empty(), "{name} was forwarded to the host");
        reply_rx.await.expect("an answer")
    }

    fn ok(result: HostToolResult) -> Value {
        assert_eq!(result.error, None);
        result.result
    }

    #[tokio::test]
    async fn task_tools_are_answered_from_the_store() {
        let project = tempfile::tempdir().expect("project dir");
        std::fs::create_dir(project.path().join(".maestro")).expect(".maestro");
        std::fs::write(
            project.path().join(".maestro/settings.json"),
            r#"{"base_branch":"develop","default_workspace_mode":"RepositoryDirectory"}"#,
        )
        .expect("settings");
        let project_path = project.path().to_string_lossy().into_owned();
        let store: Store = Arc::new(tokio::sync::Mutex::new(
            crate::project_store::open_in_memory(),
        ));
        let mut sessions = SessionMap::new();
        // The first task a project mints is 1: the session was started for the one created below.
        sessions.insert("session".to_string(), session_in(&project_path, Some(1)));
        let answered_by = Some(&store);

        let created = ok(call(
            &sessions,
            answered_by,
            "create_task",
            json!({ "title": "  Fix the thing  ", "priority": "High", "labels": ["bug"] }),
        )
        .await);
        assert_eq!(
            created,
            json!({ "id": 1, "title": "Fix the thing", "status": "Planning", "runMode": "Pipeline" })
        );

        let listed = ok(call(&sessions, answered_by, "list_tasks", json!({})).await);
        assert_eq!(
            listed,
            json!({ "tasks": [{ "id": 1, "title": "Fix the thing", "status": "Planning",
                                "priority": "High", "labels": ["bug"] }] })
        );
        let none = ok(call(
            &sessions,
            answered_by,
            "list_tasks",
            json!({ "status": "Done" }),
        )
        .await);
        assert_eq!(none, json!({ "tasks": [] }));

        let updated = ok(call(
            &sessions,
            answered_by,
            "update_task",
            json!({ "id": 1, "status": "InProgress", "priority": "Low" }),
        )
        .await);
        assert_eq!(updated["status"], "InProgress");
        assert_eq!(updated["priority"], "Low");

        let comment = ok(call(
            &sessions,
            answered_by,
            "comment_task",
            json!({ "body": " tried X, it did not work " }),
        )
        .await);
        assert_eq!(comment["taskId"], 1);

        // No id: the session's own task.
        let task = ok(call(&sessions, answered_by, "get_task", json!({})).await);
        assert_eq!(task["id"], 1);
        assert_eq!(task["status"], "InProgress");
        assert_eq!(task["baseBranch"], "develop");
        let thread = task["thread"].as_array().expect("thread");
        assert_eq!(thread.len(), 1);
        assert_eq!(thread[0]["kind"], "note");
        assert_eq!(thread[0]["author"], "agent");
        assert_eq!(thread[0]["body"], "tried X, it did not work");

        let stored = crate::task_store::list(
            &*store.lock().await,
            &crate::automations::canonical_project_path(&project_path),
        )
        .expect("list");
        assert_eq!(stored[0].workspace_mode, WorkspaceMode::RepositoryDirectory);
    }

    #[tokio::test]
    async fn a_loop_is_drafted_and_its_worker_gets_the_loop_tools_only() {
        let project = tempfile::tempdir().expect("project dir");
        let project_path = project.path().to_string_lossy().into_owned();
        let canonical = crate::automations::canonical_project_path(&project_path);
        let store: Store = Arc::new(tokio::sync::Mutex::new(
            crate::project_store::open_in_memory(),
        ));
        let mut plain = SessionMap::new();
        plain.insert("session".to_string(), session_in(&project_path, None));
        let mut worker = SessionMap::new();
        let mut session = session_in(&project_path, Some(1));
        if let Some(binding) = session.project.as_mut() {
            let role = json!({ "loop": crate::loop_engine::LoopSession::Iteration(1) });
            binding.meta.role = Some(role.to_string());
        }
        worker.insert("session".to_string(), session);
        let shared = store.clone();
        let store = Some(&store);
        let error = |result: HostToolResult| result.error.expect("an error");

        assert_eq!(
            error(
                call(
                    &plain,
                    store,
                    "create_task",
                    json!({ "title": "x", "max_iterations": 3 })
                )
                .await
            ),
            NOT_A_LOOP
        );
        let created = ok(call(
            &plain,
            store,
            "create_task",
            json!({
                "title": "Make it pass",
                "run_mode": "Loop",
                "checks": [
                    { "kind": "Command", "label": "Tests pass", "command": "cargo test" },
                    { "kind": "Judge", "label": "Empty lists are handled" },
                ],
                "max_iterations": 5,
            }),
        )
        .await);
        assert_eq!(created["runMode"], "Loop");
        let task = crate::task_store::get(&*shared.lock().await, &canonical, 1)
            .unwrap()
            .unwrap();
        assert_eq!(task.workspace_mode, WorkspaceMode::NewWorktree);
        assert_eq!(task.loop_config.as_ref().unwrap().max_iterations, 5);

        // Not running yet: the worker's session acts for no iteration.
        assert_eq!(
            error(call(&worker, store, "loop_status", json!({})).await),
            "iteration 1 is over, so this session no longer acts for the loop"
        );
        {
            let conn = shared.lock().await;
            conn.execute(
                "UPDATE tasks SET status = 'InProgress', phase = 'Iterating',
                    phase_status = 'Running', ball = 'Agent' WHERE project_path = ?1 AND id = 1",
                [&canonical],
            )
            .unwrap();
            crate::task_store::loops::start_iteration(&conn, &canonical, 1, 1, "acp", "agent")
                .unwrap();
        }

        let status = ok(call(&worker, store, "loop_status", json!({})).await);
        assert_eq!(status["iteration"], 1);
        assert_eq!(status["budget"]["iterationsAfterThis"], 4);
        assert_eq!(status["checks"][0]["label"], "Tests pass");
        assert!(status["checks"][0].get("command").is_none());

        let own = ok(call(&worker, store, "get_task", json!({})).await);
        assert!(own["loop"]["checks"][0].get("command").is_none());
        assert!(own["loop"].get("sealedPaths").is_none());
        let seen = ok(call(&plain, store, "get_task", json!({ "id": 1 })).await);
        assert_eq!(seen["loop"]["checks"][0]["command"], "cargo test");
        assert_eq!(
            error(call(&worker, store, "update_task", json!({ "status": "Done" })).await),
            "a loop's own session cannot change its task"
        );

        for n in 0..3 {
            ok(call(
                &worker,
                store,
                "loop_propose_check",
                json!({ "label": format!("Check {n}"), "why": "because" }),
            )
            .await);
        }
        assert!(error(
            call(
                &worker,
                store,
                "loop_propose_check",
                json!({ "label": "One more" })
            )
            .await
        )
        .contains("3 proposals"));

        ok(call(
            &worker,
            store,
            "loop_blocked",
            json!({ "reason": " Which API key? " }),
        )
        .await);
        let iterations =
            crate::task_store::loops::list_iterations(&*shared.lock().await, &canonical, 1)
                .unwrap();
        assert_eq!(iterations[0].blocked.as_deref(), Some("Which API key?"));

        assert_eq!(
            error(call(&plain, store, "loop_status", json!({})).await),
            "this session is not a loop iteration"
        );
    }

    #[tokio::test]
    async fn task_tools_refuse_what_the_host_refused() {
        let project = tempfile::tempdir().expect("project dir");
        let project_path = project.path().to_string_lossy().into_owned();
        let store: Store = Arc::new(tokio::sync::Mutex::new(
            crate::project_store::open_in_memory(),
        ));
        let mut sessions = SessionMap::new();
        sessions.insert("session".to_string(), session_in(&project_path, None));
        let store = Some(&store);

        let error = |result: HostToolResult| result.error.expect("an error");
        assert_eq!(
            error(call(&sessions, None, "list_tasks", json!({})).await),
            crate::project_store::UNAVAILABLE
        );
        assert_eq!(
            error(call(&sessions, store, "get_task", json!({})).await),
            "this session is not attached to a task — pass an id"
        );
        assert_eq!(
            error(call(&sessions, store, "get_task", json!({ "id": 7 })).await),
            "no task 7 in this project"
        );
        assert!(error(
            call(
                &sessions,
                store,
                "create_task",
                json!({ "title": "Something", "priority": "P1" })
            )
            .await
        )
        .starts_with("unknown priority \"P1\""));

        ok(call(
            &sessions,
            store,
            "create_task",
            json!({ "title": "Something" }),
        )
        .await);
        assert!(error(
            call(
                &sessions,
                store,
                "update_task",
                json!({ "id": 1, "status": "Cancelled" })
            )
            .await
        )
        .starts_with("unknown status \"Cancelled\""));
        assert_eq!(
            error(call(&sessions, store, "update_task", json!({ "id": 1 })).await),
            "nothing to update"
        );
        assert_eq!(
            error(
                call(
                    &sessions,
                    store,
                    "comment_task",
                    json!({ "id": 1, "body": "  " })
                )
                .await
            ),
            "body is required"
        );

        // A session with no project is refused before anything else.
        sessions.get_mut("session").expect("session").project = None;
        assert_eq!(
            error(call(&sessions, store, "list_tasks", json!({})).await),
            "this session is not attached to a Maestro project"
        );
    }

    /// A status from `update_task` is the user dragging the card: it takes the task out of the
    /// pipeline rather than leaving a phase claiming an agent is still at work.
    #[tokio::test]
    async fn update_task_moves_a_task_as_the_user_would() {
        let project = tempfile::tempdir().expect("project dir");
        let project_path = project.path().to_string_lossy().into_owned();
        let canonical = crate::automations::canonical_project_path(&project_path);
        let store: Store = Arc::new(tokio::sync::Mutex::new(
            crate::project_store::open_in_memory(),
        ));
        let mut sessions = SessionMap::new();
        sessions.insert("session".to_string(), session_in(&project_path, None));

        ok(call(
            &sessions,
            Some(&store),
            "create_task",
            json!({ "title": "Ship it" }),
        )
        .await);
        crate::task_store::transition::apply_transition(
            &mut *store.lock().await,
            &maestro_protocol::ApplyTaskTransitionRequest {
                project_path: canonical.clone(),
                task_id: 1,
                event: maestro_protocol::TaskTransition::SessionReady(
                    maestro_protocol::AgentRole::Coder,
                ),
                guard: maestro_protocol::TransitionGuard::Always,
                update: None,
                comment: None,
            },
        )
        .expect("apply")
        .expect("applied");

        let moved = ok(call(
            &sessions,
            Some(&store),
            "update_task",
            json!({ "id": 1, "status": "Review" }),
        )
        .await);
        assert_eq!(moved["status"], "Review");
        let stored = crate::task_store::list(&*store.lock().await, &canonical).expect("list");
        assert_eq!(stored[0].phase, None);
        assert_eq!(stored[0].phase_status, None);
        assert_eq!(stored[0].ball, maestro_protocol::TaskBall::None);
    }

    /// Ids are small integers per project, so an id from another project must not reach its board.
    #[tokio::test]
    async fn update_task_refuses_another_projects_task() {
        let project = tempfile::tempdir().expect("project dir");
        let project_path = project.path().to_string_lossy().into_owned();
        let other = tempfile::tempdir().expect("other project dir");
        let other_path = other.path().to_string_lossy().into_owned();
        let store: Store = Arc::new(tokio::sync::Mutex::new(
            crate::project_store::open_in_memory(),
        ));
        let mut sessions = SessionMap::new();
        sessions.insert("session".to_string(), session_in(&other_path, None));
        for title in ["First", "Second"] {
            ok(call(
                &sessions,
                Some(&store),
                "create_task",
                json!({ "title": title }),
            )
            .await);
        }
        sessions.insert("session".to_string(), session_in(&project_path, None));

        let refused = call(
            &sessions,
            Some(&store),
            "update_task",
            json!({ "id": 2, "status": "Done" }),
        )
        .await;
        assert_eq!(refused.error.as_deref(), Some("no task 2 in this project"));
        let untouched = crate::task_store::list(
            &*store.lock().await,
            &crate::automations::canonical_project_path(&other_path),
        )
        .expect("list");
        assert!(untouched
            .iter()
            .all(|task| task.status == TaskStatus::Planning));
    }

    #[tokio::test]
    async fn project_prompts_are_answered_from_the_store() {
        let project = tempfile::tempdir().expect("project dir");
        let project_path = project.path().to_string_lossy().into_owned();
        let store: Store = Arc::new(tokio::sync::Mutex::new(
            crate::project_store::open_in_memory(),
        ));
        let mut sessions = SessionMap::new();
        sessions.insert("session".to_string(), session_in(&project_path, None));
        let store = Some(&store);

        let created = ok(call(
            &sessions,
            store,
            "create_prompt",
            json!({ "title": "Review", "body": "Review the diff", "tags": ["Code"] }),
        )
        .await);
        assert_eq!(created["id"], "project-1");
        assert_eq!(created["tags"], json!(["code"]));
        ok(call(
            &sessions,
            store,
            "create_prompt",
            json!({ "title": "Plan", "body": "Plan it", "collection": "project" }),
        )
        .await);

        // Partial: the body and tags the agent left out are kept.
        let updated = ok(call(
            &sessions,
            store,
            "update_prompt",
            json!({ "id": "project-1", "title": "Review again", "favorite": true }),
        )
        .await);
        assert_eq!(updated["title"], "Review again");
        assert_eq!(updated["body"], "Review the diff");
        assert_eq!(updated["tags"], json!(["code"]));
        assert_eq!(updated["favorite"], true);

        // No window: the project's alone, and a note saying why.
        let listed = ok(call(&sessions, store, "list_prompts", json!({})).await);
        let ids: Vec<&str> = listed["prompts"]
            .as_array()
            .expect("prompts")
            .iter()
            .filter_map(|row| row["id"].as_str())
            .collect();
        assert_eq!(ids, ["project-1", "project-2"]);
        assert_eq!(listed["shared_unavailable"], NO_WINDOW);
        let tagged = ok(call(&sessions, store, "list_prompts", json!({ "tag": "code" })).await);
        assert_eq!(tagged["prompts"].as_array().map(Vec::len), Some(1));

        let read = ok(call(&sessions, store, "get_prompt", json!({ "id": "project-2" })).await);
        assert_eq!(read["body"], "Plan it");

        let deleted = ok(call(
            &sessions,
            store,
            "delete_prompt",
            json!({ "id": "project-2" }),
        )
        .await);
        assert_eq!(deleted, json!({ "deleted": "project-2" }));

        let error = |result: HostToolResult| result.error.expect("an error");
        assert_eq!(
            error(
                call(
                    &sessions,
                    store,
                    "delete_prompt",
                    json!({ "id": "project-2" })
                )
                .await
            ),
            "no prompt project-2 in this project"
        );
        assert_eq!(
            error(call(&sessions, store, "get_prompt", json!({ "id": 1 })).await),
            "id must be a prompt id from list_prompts, like project-3 or shared-3"
        );
        assert_eq!(
            error(call(&sessions, store, "get_prompt", json!({ "id": "project-9" })).await),
            "no prompt project-9 in this project"
        );
        // A shared call with no window is refused here, not left waiting on nobody.
        assert_eq!(
            error(call(&sessions, store, "get_prompt", json!({ "id": "shared-1" })).await),
            NO_WINDOW
        );

        // Neither half: an empty list and a note for each, not a failure.
        let listed = ok(call(&sessions, None, "list_prompts", json!({})).await);
        assert_eq!(listed["prompts"], json!([]));
        assert_eq!(
            listed["project_unavailable"],
            crate::project_store::UNAVAILABLE
        );
        assert_eq!(listed["shared_unavailable"], NO_WINDOW);
    }

    /// Every window answers a shared prompt call whether it holds the session or not, so the call
    /// must reach one of them only.
    #[tokio::test]
    async fn a_shared_prompt_call_reaches_one_window() {
        let project = tempfile::tempdir().expect("project dir");
        let project_path = project.path().to_string_lossy().into_owned();
        let mut sessions = SessionMap::new();
        sessions.insert("session".to_string(), session_in(&project_path, None));
        let sink = crate::client_sink::ClientSink::detached();
        let mut windows = Vec::new();
        for _ in 0..2 {
            let (ours, theirs) = tokio::io::duplex(1 << 16);
            sink.lock().await.attach(Box::new(ours)).await;
            windows.push(theirs);
        }
        let mut pending = PendingHostTools::new();
        let (reply_tx, _reply_rx) = oneshot::channel();
        let call = HostToolCall {
            session_id: "session".to_string(),
            request_id: "request".to_string(),
            name: "get_prompt".to_string(),
            arguments: json!({ "id": "shared-1" }),
        };
        handle_host_tool_call(call, reply_tx, &sessions, None, None, &mut pending, &sink).await;
        assert_eq!(pending.len(), 1);

        let mut received = 0;
        for window in &mut windows {
            let read = tokio::time::timeout(
                std::time::Duration::from_millis(100),
                maestro_protocol::read_message(window),
            )
            .await;
            if let Ok(Ok(ServerResponse::HostToolCall(_))) = read {
                received += 1;
            }
        }
        assert_eq!(received, 1);
    }

    #[tokio::test]
    async fn shared_prompts_go_to_the_host_with_bare_ids() {
        let project = tempfile::tempdir().expect("project dir");
        let project_path = project.path().to_string_lossy().into_owned();
        let store: Store = Arc::new(tokio::sync::Mutex::new(
            crate::project_store::open_in_memory(),
        ));
        let mut sessions = SessionMap::new();
        sessions.insert("session".to_string(), session_in(&project_path, None));
        let sink = crate::client_sink::ClientSink::detached();
        let (ours, mut window) = tokio::io::duplex(1 << 16);
        sink.lock().await.attach(Box::new(ours)).await;
        let mut pending = PendingHostTools::new();

        // Yields the reply's receiver unawaited: the host answers only after every call is parked.
        #[allow(clippy::async_yields_async)]
        let mut send = async |name: &str, arguments: Value| {
            let (reply_tx, reply_rx) = oneshot::channel();
            let call = HostToolCall {
                session_id: "session".to_string(),
                request_id: "request".to_string(),
                name: name.to_string(),
                arguments,
            };
            handle_host_tool_call(
                call,
                reply_tx,
                &sessions,
                Some(&store),
                None,
                &mut pending,
                &sink,
            )
            .await;
            reply_rx
        };
        let next = async |window: &mut tokio::io::DuplexStream| -> ServerResponse {
            maestro_protocol::read_message(window)
                .await
                .expect("a message")
        };

        // A write to the project's collection is pushed to every window.
        let created = send("create_prompt", json!({ "title": "Mine", "body": "Do it" })).await;
        assert!(matches!(
            next(&mut window).await,
            ServerResponse::PromptsChanged(_)
        ));
        assert_eq!(ok(created.await.expect("an answer"))["id"], "project-1");

        let got = send("get_prompt", json!({ "id": "shared-4" })).await;
        let ServerResponse::HostToolCall(forwarded) = next(&mut window).await else {
            panic!("not forwarded");
        };
        assert_eq!(forwarded.name, "get_prompt");
        assert_eq!(forwarded.arguments, json!({ "id": 4 }));

        let created = send(
            "create_prompt",
            json!({ "title": "Ours", "body": "Do it", "collection": "shared" }),
        )
        .await;
        let ServerResponse::HostToolCall(forwarded_create) = next(&mut window).await else {
            panic!("not forwarded");
        };
        assert_eq!(
            forwarded_create.arguments,
            json!({ "title": "Ours", "body": "Do it" })
        );

        let listed = send("list_prompts", json!({})).await;
        let ServerResponse::HostToolCall(forwarded_list) = next(&mut window).await else {
            panic!("not forwarded");
        };

        let mut answer_host = |forwarded: HostToolCall, result: Value| {
            let (_, tx) = pending.remove(&forwarded.request_id).expect("parked");
            tx.send(HostToolResult {
                session_id: forwarded.session_id,
                request_id: forwarded.request_id,
                result,
                error: None,
            })
            .expect("waiting");
        };
        answer_host(forwarded, json!({ "id": 4, "title": "Theirs" }));
        answer_host(forwarded_create, json!({ "id": 5, "title": "Ours" }));
        answer_host(
            forwarded_list,
            json!([{ "id": 4, "title": "Theirs", "tags": [], "favorite": false }]),
        );

        let got = ok(got.await.expect("an answer"));
        assert_eq!(got["id"], "shared-4");
        let created = created.await.expect("an answer");
        assert_eq!(created.request_id, "request");
        assert_eq!(ok(created)["id"], "shared-5");
        let listed = ok(listed.await.expect("an answer"));
        let ids: Vec<&str> = listed["prompts"]
            .as_array()
            .expect("prompts")
            .iter()
            .filter_map(|row| row["id"].as_str())
            .collect();
        assert_eq!(ids, ["project-1", "shared-4"]);
        assert!(listed.get("shared_unavailable").is_none());
    }

    #[tokio::test]
    async fn cancel_fails_only_the_closing_session() {
        let (mut pending, mut receivers) =
            pending_with(&[("host-0", "session-1"), ("host-1", "session-2")]);
        cancel_session(&mut pending, "session-1");

        assert_eq!(pending.len(), 1);
        assert!(pending.contains_key("host-1"));
        let failed = receivers.remove(0).await.unwrap();
        assert_eq!(failed.error.as_deref(), Some("session closed"));
        // The surviving call is still waiting, not answered.
        assert!(receivers[0].try_recv().is_err());
    }
}
