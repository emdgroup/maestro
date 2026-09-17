//! Tools an agent calls on Maestro's own MCP server and only the host can answer.
//!
//! `maestro-server` answers the canvas rendering tools itself — they are session updates it
//! already owns the channel for. What reaches here is the rest: the task tools, which need the
//! database, and `canvas_await`, which needs a user.
//!
//! Every task tool is scoped to the project the session belongs to. Ids are small integers, so
//! without that an agent could read or move another project's board by guessing.

use std::sync::Arc;
use tauri::Emitter;

use crate::acp::transport::{HostToolCall, HostToolResult, MaestroRpcMessage, ServerRequest};
use crate::core::AppState;
use crate::models::{BranchMode, TaskStatus};
use serde_json::{json, Value};

/// Ceiling on one `canvas_await`, matching the tool's own schema. The shim's gateway connection
/// and the MCP client's tool timeout both sit above this.
const MAX_AWAIT_SECONDS: u64 = 60;
const DEFAULT_AWAIT_SECONDS: u64 = 30;

/// Mirrors the `priority` enum in the `create_task` tool schema and `TaskPriority`.
const PRIORITIES: [&str; 5] = ["Urgent", "High", "Medium", "Low", "None"];

/// The board columns, and the only statuses `update_task` accepts.
///
/// `TaskStatus::Cancelled` is deliberately absent: cancelling also archives, which
/// `update_task_impl` does not do, so an agent asking for it would produce a task that is
/// cancelled and still sitting on the board.
const STATUSES: [&str; 5] = ["Planning", "Queue", "InProgress", "Review", "Done"];

/// How much of a task's thread `get_task` carries back. Newest kept — an old note matters less
/// than the verdict that came after it, and a CI-heavy task can run to hundreds of entries.
const MAX_THREAD_ENTRIES: usize = 20;

/// Run one host tool and send its result back to `maestro-server`.
///
/// Spawned off the reader loop by its callers: `canvas_await` blocks for up to a minute, and
/// `create_task` touches the database and, for a remote project, may run `git` over SSH.
pub(crate) async fn handle(app_state: Arc<AppState>, log_id: i32, call: HostToolCall) {
    let outcome = match call.name.as_str() {
        "create_task" => create_task(&app_state, log_id, &call.arguments).await,
        "list_tasks" => list_tasks(&app_state, log_id, &call.arguments).await,
        "get_task" => get_task(&app_state, log_id, &call.arguments).await,
        "update_task" => update_task(&app_state, log_id, &call.arguments).await,
        "comment_task" => comment_task(&app_state, log_id, &call.arguments).await,
        "canvas_await" => canvas_await(&app_state, log_id, &call).await,
        "canvas_create" | "canvas_update" | "canvas_data" => {
            canvas_ack(&app_state, log_id, &call.arguments).await
        }
        other => Err(format!("unknown Maestro tool: {other}")),
    };

    let (result, error) = match outcome {
        Ok(result) => (result, None),
        Err(message) => (Value::Null, Some(message)),
    };
    let reply = MaestroRpcMessage::Request(ServerRequest::HostToolResult(HostToolResult {
        session_id: call.session_id,
        request_id: call.request_id,
        result,
        error,
    }));
    if let Err(e) = crate::acp::write_to_acp_session(&app_state, log_id, &reply).await {
        log::warn!(
            "[acp] could not answer {} for session-{log_id}: {e}",
            call.name
        );
    }
}

async fn session_project_id(app_state: &Arc<AppState>, log_id: i32) -> Result<i32, String> {
    app_state
        .acp
        .sessions
        .lock()
        .await
        .get(&log_id)
        .and_then(|session| session.project_id)
        .ok_or_else(|| "this session is not attached to a Maestro project".to_string())
}

/// The title of a task the agent is asking for, or why it cannot be used.
///
/// Trimmed and required to be non-empty: the tool schema says `minLength: 3`, but nothing
/// enforces a schema for the host tools — the shim only validates canvas arguments — so a
/// whitespace title would otherwise reach the board as a blank card.
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

/// One of a fixed set of names, if the agent supplied it.
///
/// Rejected rather than coerced: `TaskPriority::from_str` answers `Medium` for anything it does
/// not recognise, and `create_task_impl` writes the raw string to SQLite regardless. Silently
/// filing a task as Medium because the agent invented a priority is the kind of thing nobody
/// notices. A non-string is the same mistake with a different spelling, so it fails too.
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

fn parse_priority(arguments: &Value) -> Result<Option<String>, String> {
    parse_enum(arguments, "priority", &PRIORITIES)
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

async fn create_task(
    app_state: &Arc<AppState>,
    log_id: i32,
    arguments: &Value,
) -> Result<Value, String> {
    let project_id = session_project_id(app_state, log_id).await?;
    let title = parse_title(arguments)?;
    let priority = parse_priority(arguments)?;

    let config = crate::project::settings::load_project_config_for(app_state, project_id)
        .await
        .unwrap_or_default();
    // The branch a task is cut from, in the same order the create dialog resolves it: the
    // project's configured default, else whatever the repository is on.
    let base_branch = match config.base_branch.clone() {
        Some(branch) => branch,
        None => match crate::core::get_project_with_git_conn(app_state, project_id).await {
            Ok((_, conn)) => crate::git::ops::get_current_branch(&conn)
                .await
                .unwrap_or_else(|_| "main".to_string()),
            Err(_) => "main".to_string(),
        },
    };

    let task = {
        let conn = app_state
            .db
            .lock()
            .map_err(|e| format!("Lock failed: {}", e))?;
        crate::task::crud::create_task_impl(
            &conn,
            project_id,
            title,
            arguments
                .get("description")
                .and_then(Value::as_str)
                .map(str::to_string),
            Vec::new(),
            string_list(arguments.get("labels")),
            base_branch,
            None,
            priority,
            false,
            config.default_workspace_mode(),
            None,
            BranchMode::Create,
            None,
            None,
        )?
    };

    app_state.app_handle.emit("tasks-changed", ()).ok();
    Ok(json!({
        "id": task.id,
        "title": task.title,
        "status": task.status,
    }))
}

async fn list_tasks(
    app_state: &Arc<AppState>,
    log_id: i32,
    arguments: &Value,
) -> Result<Value, String> {
    let project_id = session_project_id(app_state, log_id).await?;
    let wanted: Option<TaskStatus> = match arguments.get("status") {
        Some(value) if !value.is_null() => Some(
            serde_json::from_value(value.clone())
                .map_err(|_| format!("unknown status: {value}"))?,
        ),
        _ => None,
    };

    let tasks = {
        let conn = app_state
            .db
            .lock()
            .map_err(|e| format!("Lock failed: {}", e))?;
        crate::task::crud::list_tasks_impl(&conn, project_id)?
    };

    let rows: Vec<Value> = tasks
        .into_iter()
        .filter(|task| task.archived_at.is_none())
        .filter(|task| wanted.is_none_or(|status| task.status == status))
        .map(|task| {
            json!({
                "id": task.id,
                "title": task.title,
                "status": task.status,
                "priority": task.priority,
                "labels": task.labels,
            })
        })
        .collect();
    Ok(json!({ "tasks": rows }))
}

/// Which task the agent means, or why it cannot be answered.
///
/// An absent `id` means the task this session was started for, which is what the agent almost
/// always wants and cannot otherwise name — it is told what to do, not which card that came from.
async fn parse_task_id(
    app_state: &Arc<AppState>,
    log_id: i32,
    arguments: &Value,
) -> Result<i32, String> {
    match arguments.get("id") {
        None | Some(Value::Null) => {
            let sessions = app_state.acp.sessions.lock().await;
            sessions
                .get(&log_id)
                .and_then(|session| session.task_id)
                .ok_or_else(|| "this session is not attached to a task — pass an id".to_string())
        }
        Some(value) => value
            .as_i64()
            .map(|id| id as i32)
            .ok_or_else(|| format!("id must be a number, got {value}")),
    }
}

/// The task, if it is one this session is allowed to touch.
///
/// Scoped to the session's own project rather than looked up by id alone: a session for one
/// project has no business reading or moving another's cards, and an id is trivially guessable.
fn task_in_project(
    conn: &rusqlite::Connection,
    project_id: i32,
    task_id: i32,
) -> Result<crate::models::Task, String> {
    crate::task::crud::list_tasks_impl(conn, project_id)?
        .into_iter()
        .find(|task| task.id == task_id)
        .ok_or_else(|| format!("no task {task_id} in this project"))
}

fn task_summary(task: &crate::models::Task) -> Value {
    json!({
        "id": task.id,
        "title": task.title,
        "status": task.status,
        "priority": task.priority,
        "labels": task.labels,
    })
}

async fn get_task(
    app_state: &Arc<AppState>,
    log_id: i32,
    arguments: &Value,
) -> Result<Value, String> {
    let project_id = session_project_id(app_state, log_id).await?;
    let task_id = parse_task_id(app_state, log_id, arguments).await?;

    let (task, thread) = {
        let conn = app_state
            .db
            .lock()
            .map_err(|e| format!("Lock failed: {}", e))?;
        let task = task_in_project(&conn, project_id, task_id)?;
        let thread = crate::task::comments::list_for_task(&conn, task_id)?;
        (task, thread)
    };

    let total = thread.len();
    let entries: Vec<Value> = thread
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
    Ok(value)
}

async fn update_task(
    app_state: &Arc<AppState>,
    log_id: i32,
    arguments: &Value,
) -> Result<Value, String> {
    let project_id = session_project_id(app_state, log_id).await?;
    let task_id = parse_task_id(app_state, log_id, arguments).await?;
    let status = parse_enum(arguments, "status", &STATUSES)?;
    let priority = parse_enum(arguments, "priority", &PRIORITIES)?;

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

    let task = {
        let mut conn = app_state
            .db
            .lock()
            .map_err(|e| format!("Lock failed: {}", e))?;
        task_in_project(&conn, project_id, task_id)?;
        crate::task::crud::update_task_impl(
            &mut conn,
            task_id,
            crate::task::crud::UpdateTaskRequest {
                status,
                title,
                description,
                priority,
                labels,
                ..Default::default()
            },
        )?
    };

    app_state.app_handle.emit("tasks-changed", ()).ok();
    Ok(task_summary(&task))
}

/// Append to a task's outcome thread.
///
/// Always as a `note`, and always authored `agent`: the typed kinds are the pipeline's own record
/// of what a phase concluded, and a gate pointing at "the plan that was approved" must not be
/// something a tool call can forge afterwards.
async fn comment_task(
    app_state: &Arc<AppState>,
    log_id: i32,
    arguments: &Value,
) -> Result<Value, String> {
    let project_id = session_project_id(app_state, log_id).await?;
    let task_id = parse_task_id(app_state, log_id, arguments).await?;
    let body = arguments
        .get("body")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|body| !body.is_empty())
        .ok_or_else(|| "body is required".to_string())?;

    let comment = {
        let conn = app_state
            .db
            .lock()
            .map_err(|e| format!("Lock failed: {}", e))?;
        task_in_project(&conn, project_id, task_id)?;
        crate::task::comments::append(&conn, task_id, "note", "agent", Some(body), None, None)?
    };

    app_state
        .app_handle
        .emit("task-comments-changed", task_id)
        .ok();
    Ok(json!({ "id": comment.id, "taskId": task_id, "createdAt": comment.created_at }))
}

/// Make a surface's controls live, and return the first thing the user does with them.
///
/// A poll rather than an open wait: MCP clients time tool calls out, so the tool promises at most
/// a minute and tells the agent to call again. Controls answer nothing outside this window, so a
/// click landing between two polls is impossible rather than silently dropped.
///
/// Answer a canvas tool, carrying back whatever that surface's frame has failed at since the last
/// one.
///
/// The surface itself was already drawn by the server, which owns the session-update channel; this
/// arm exists so the agent hears about a blocked asset, an offline CDN or a thrown exception. They
/// arrive on the *next* call by necessity — the frame has not rendered this one yet.
async fn canvas_ack(
    app_state: &Arc<AppState>,
    log_id: i32,
    arguments: &Value,
) -> Result<Value, String> {
    let Some(surface_id) = arguments.get("surfaceId").and_then(Value::as_str) else {
        return Ok(json!({ "ok": true }));
    };
    let drained = app_state
        .acp
        .canvas_errors
        .lock()
        .await
        .remove(&(log_id, surface_id.to_string()));
    match drained {
        Some(errors) if !errors.is_empty() => Ok(json!({ "ok": true, "errors": errors })),
        _ => Ok(json!({ "ok": true })),
    }
}

/// `surfaceId` is optional. Omitted, the wait takes whichever canvas the user acts on — they can
/// page between all of them, so tying the wait to one is a guess about where they will look. The
/// event names the surface either way.
async fn canvas_await(
    app_state: &Arc<AppState>,
    log_id: i32,
    call: &HostToolCall,
) -> Result<Value, String> {
    let surface_id = match call.arguments.get("surfaceId") {
        None | Some(Value::Null) => None,
        Some(value) => Some(
            value
                .as_str()
                .ok_or_else(|| format!("surfaceId must be a string, got {value}"))?
                .to_string(),
        ),
    };
    let seconds = call
        .arguments
        .get("timeoutSeconds")
        .and_then(Value::as_u64)
        .unwrap_or(DEFAULT_AWAIT_SECONDS)
        .clamp(1, MAX_AWAIT_SECONDS);

    let key = (log_id, call.request_id.clone());
    let (tx, rx) = tokio::sync::oneshot::channel::<Value>();
    app_state
        .acp
        .pending_host_tools
        .lock()
        .await
        .insert(key.clone(), tx);

    let task_id = {
        let sessions = app_state.acp.sessions.lock().await;
        sessions.get(&log_id).and_then(|session| session.task_id)
    };
    if let Some(task_id) = task_id {
        crate::acp::reader_task::mark_task_blocked(app_state, task_id);
    }

    // `surface_id` is null for a wait that takes any surface; the panel reads it that way.
    if let Err(e) = app_state.app_handle.emit(
        &format!("acp://canvas-await/{}", log_id),
        &json!({ "request_id": call.request_id, "surface_id": surface_id }),
    ) {
        log::warn!("[acp] emit canvas-await/{log_id} failed: {e}");
    }

    let outcome = match tokio::time::timeout(std::time::Duration::from_secs(seconds), rx).await {
        Ok(Ok(event)) => json!({ "event": event }),
        // Dropped sender: the entry was taken out by something other than an answer.
        Ok(Err(_)) => json!({ "timeout": true }),
        Err(_) => {
            app_state.acp.pending_host_tools.lock().await.remove(&key);
            json!({ "timeout": true })
        }
    };

    if let Err(e) = app_state.app_handle.emit(
        &format!("acp://canvas-await-ended/{}", log_id),
        &json!({ "request_id": call.request_id }),
    ) {
        log::warn!("[acp] emit canvas-await-ended/{log_id} failed: {e}");
    }
    crate::acp::prompt_handlers::clear_task_blocked(app_state, task_id);

    Ok(outcome)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_priority_list_matches_the_enum() {
        // The allow-list is what keeps a bad priority out of SQLite, and `TaskPriority::FromStr`
        // cannot tell us it has drifted — it answers `Medium` for anything. Serde can.
        use crate::models::TaskPriority::{High, Low, Medium, None, Urgent};
        let names: Vec<String> = [Urgent, High, Medium, Low, None]
            .iter()
            .map(|priority| serde_json::to_value(priority).unwrap())
            .map(|value| value.as_str().unwrap().to_string())
            .collect();
        assert_eq!(names, PRIORITIES);
    }

    #[test]
    fn the_status_list_is_the_board_without_cancelled() {
        use crate::models::TaskStatus::{Cancelled, Done, InProgress, Planning, Queue, Review};
        let names: Vec<String> = [Planning, Queue, InProgress, Review, Done]
            .iter()
            .map(|status| serde_json::to_value(status).unwrap())
            .map(|value| value.as_str().unwrap().to_string())
            .collect();
        assert_eq!(names, STATUSES);
        // Cancelling archives as well, which `update_task_impl` does not do — see STATUSES.
        let cancelled = serde_json::to_value(Cancelled).unwrap();
        assert!(!STATUSES.contains(&cancelled.as_str().unwrap()));
    }

    #[test]
    fn a_status_is_accepted_only_by_its_exact_name() {
        for name in STATUSES {
            assert_eq!(
                parse_enum(&json!({ "status": name }), "status", &STATUSES).unwrap(),
                Some(name.to_string())
            );
        }
        assert!(parse_enum(&json!({ "status": "done" }), "status", &STATUSES).is_err());
        assert!(parse_enum(&json!({ "status": "Cancelled" }), "status", &STATUSES).is_err());
        assert_eq!(
            parse_enum(&json!({}), "status", &STATUSES).unwrap(),
            Option::None
        );
    }

    #[test]
    fn a_priority_is_accepted_only_by_its_exact_name() {
        for name in PRIORITIES {
            assert_eq!(
                parse_priority(&json!({ "priority": name })).unwrap(),
                Some(name.to_string())
            );
        }
        assert!(parse_priority(&json!({ "priority": "urgent" })).is_err());
        assert!(parse_priority(&json!({ "priority": "P0" })).is_err());
        // A number is the same mistake: `as_str` would drop it and the task would be filed with
        // whatever the default is.
        assert!(parse_priority(&json!({ "priority": 1 })).is_err());
    }

    #[test]
    fn an_absent_priority_is_not_an_error() {
        assert_eq!(parse_priority(&json!({})).unwrap(), Option::None);
        assert_eq!(
            parse_priority(&json!({ "priority": null })).unwrap(),
            Option::None
        );
    }

    #[test]
    fn a_title_must_hold_something() {
        assert_eq!(
            parse_title(&json!({ "title": "  Add retries " })).unwrap(),
            "Add retries"
        );
        assert!(parse_title(&json!({})).is_err());
        assert!(parse_title(&json!({ "title": "   " })).is_err());
        assert!(parse_title(&json!({ "title": 7 })).is_err());
    }

    #[test]
    fn labels_keep_only_strings() {
        let arguments = json!({ "labels": ["bug", 3, null, "ssh"] });
        assert_eq!(
            string_list(arguments.get("labels")),
            vec!["bug".to_string(), "ssh".to_string()]
        );
        assert!(string_list(Option::None).is_empty());
        assert!(string_list(json!({ "labels": "bug" }).get("labels")).is_empty());
    }
}
