//! Loopback gateway from the per-session MCP shims back into the running server.
//!
//! Each shim (`maestro mcp`, see `mcp_stdio`) opens one short-lived TCP connection per tool call.
//! The listener is bound to `127.0.0.1` only and every request carries a token minted at startup
//! and handed to the shim as an environment variable on its `McpServerStdio` entry — any other
//! local process can connect, so the token is what decides whether it is answered.
//!
//! Canvas calls are answered here: they are session updates, and the server already owns that
//! channel. So are the task tools, from the project store, so an agent can reach its board with no
//! window open. Everything else is forwarded to Tauri as a `HostToolCall` and parked in
//! `PendingHostTools` until the matching `HostToolResult` comes back.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};

use maestro_protocol::{
    CreateTaskRequest, GatewayRequest, HostToolCall, HostToolResult, MaestroRpcMessage,
    NewTaskComment, ProjectRef, ServerRequest, ServerResponse, SessionUpdate, TaskPriority,
    TaskRef, TaskStatus, TaskUpdate, UpdateTaskRequest, WorkspaceMode,
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
    pending_host_tools: &mut PendingHostTools,
    stdout: &crate::ClientOut,
) {
    // Not "no longer open": the shim is handed its session id while `session/new` is still in
    // flight, so an id absent from the map may be one that has not been registered yet.
    let Some(session) = sessions.get(&call.session_id) else {
        let _ = reply_tx.send(fail(&call, "no Maestro session with this id is open"));
        return;
    };

    // Off the loop: `create_task` reads the project's settings and runs `git`.
    if TASK_TOOLS.contains(&call.name.as_str()) {
        let binding = session.project.as_ref().map(|project| SessionTask {
            project_path: project.project_path.clone(),
            task_id: project.meta.task_id,
        });
        let store = project_store.cloned();
        let stdout = Arc::clone(stdout);
        tokio::spawn(async move {
            let result = match task_tool(store, binding, &call.name, &call.arguments).await {
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
            &MaestroRpcMessage::Response(ServerResponse::SessionUpdate(SessionUpdate {
                session_id: call.session_id.clone(),
                payload,
            })),
        )
        .await
        {
            let _ = reply_tx.send(fail(&call, &format!("cannot reach Maestro: {e}")));
            return;
        }
    }

    static NEXT_ID: AtomicU64 = AtomicU64::new(0);
    let request_id = format!("host-{}", NEXT_ID.fetch_add(1, Ordering::Relaxed));
    let forwarded = HostToolCall {
        session_id: call.session_id.clone(),
        request_id: request_id.clone(),
        name: call.name.clone(),
        arguments: call.arguments.clone(),
    };
    if let Err(e) = send_response(
        stdout,
        &MaestroRpcMessage::Response(ServerResponse::HostToolCall(forwarded)),
    )
    .await
    {
        let _ = reply_tx.send(fail(&call, &format!("cannot reach Maestro: {e}")));
        return;
    }
    pending_host_tools.insert(request_id, (call.session_id, reply_tx));
}

const TASK_TOOLS: [&str; 5] = [
    "create_task",
    "list_tasks",
    "get_task",
    "update_task",
    "comment_task",
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
}

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
) -> Result<(Value, Vec<ServerResponse>), String> {
    let binding =
        binding.ok_or_else(|| "this session is not attached to a Maestro project".to_string())?;
    let store = store.ok_or_else(|| crate::project_store::UNAVAILABLE.to_string())?;
    let project_path = binding.project_path.clone();
    let mut pushes = Vec::new();

    let result = match name {
        "create_task" => {
            let title = parse_title(arguments)?;
            let priority = parse_priority(arguments)?;
            let (base_branch, workspace_mode) = task_defaults(&project_path).await;
            let request = ServerRequest::CreateTask(CreateTaskRequest {
                project_path,
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
            });
            let ServerResponse::CreateTaskOk(task) =
                ask(&mut *store.lock().await, request, &mut pushes)?
            else {
                return Err(UNEXPECTED.to_string());
            };
            json!({ "id": task.id, "title": task.title, "status": task.status })
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
            if status.is_none()
                && priority.is_none()
                && title.is_none()
                && description.is_none()
                && labels.is_none()
            {
                return Err("nothing to update".to_string());
            }

            let mut conn = store.lock().await;
            task_in_project(&mut conn, &project_path, task_id)?;
            // A status is a manual move, the same as the user dragging the card.
            let request = ServerRequest::UpdateTask(UpdateTaskRequest {
                project_path,
                task_id,
                update: TaskUpdate {
                    status,
                    title,
                    description: description.map(Some),
                    priority,
                    labels,
                    ..TaskUpdate::default()
                },
            });
            let ServerResponse::UpdateTaskOk(task) = ask(&mut conn, request, &mut pushes)? else {
                return Err(UNEXPECTED.to_string());
            };
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
        handle_host_tool_call(call, reply_tx, sessions, store, &mut pending, &sink).await;
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
            json!({ "id": 1, "title": "Fix the thing", "status": "Planning" })
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
