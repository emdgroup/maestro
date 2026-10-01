//! Tools an agent calls on Maestro's own MCP server and only the host can answer.
//!
//! `maestro-server` answers the canvas rendering tools and the task tools itself — the first are
//! session updates it already owns the channel for, the second rows it holds. What reaches here is
//! the rest: `canvas_await`, which needs a user, the prompt tools, and the automation and template
//! tools in `automation_tools`.

use std::sync::Arc;
use tauri::Emitter;

use crate::acp::automation_tools;
use crate::acp::transport::{HostToolCall, HostToolResult, MaestroRpcMessage, ServerRequest};
use crate::core::AppState;
use serde_json::{json, Value};

/// Ceiling on one `canvas_await`, matching the tool's own schema. The shim's gateway connection
/// and the MCP client's tool timeout both sit above this.
const MAX_AWAIT_SECONDS: u64 = 60;
const DEFAULT_AWAIT_SECONDS: u64 = 30;

/// Run one host tool and send its result back to `maestro-server`.
///
/// Spawned off the reader loop by its callers: `canvas_await` blocks for up to a minute.
pub(crate) async fn handle(app_state: Arc<AppState>, session_id: &str, call: HostToolCall) {
    let outcome = match call.name.as_str() {
        "list_automations" => automation_tools::list_automations(&app_state, session_id).await,
        "get_automation" => {
            automation_tools::get_automation(&app_state, session_id, &call.arguments).await
        }
        "create_automation" => {
            automation_tools::create_automation(&app_state, session_id, &call.arguments).await
        }
        "update_automation" => {
            automation_tools::update_automation(&app_state, session_id, &call.arguments).await
        }
        "delete_automation" => {
            automation_tools::delete_automation(&app_state, session_id, &call.arguments).await
        }
        "run_automation" => automation_tools::run_automation(&app_state, session_id, &call).await,
        "list_automation_runs" => {
            automation_tools::list_automation_runs(&app_state, session_id, &call.arguments).await
        }
        "get_automation_run" => {
            automation_tools::get_automation_run(&app_state, session_id, &call.arguments).await
        }
        "list_templates" => automation_tools::list_templates(&app_state),
        "get_template" => automation_tools::get_template(&app_state, &call.arguments),
        "update_template" => automation_tools::update_template(&app_state, &call.arguments),
        "save_as_template" => {
            automation_tools::save_as_template(&app_state, session_id, &call.arguments).await
        }
        "delete_template" => automation_tools::delete_template(&app_state, &call.arguments),
        "list_prompts" | "get_prompt" | "create_prompt" | "update_prompt" | "delete_prompt" => {
            prompt_tool(&app_state, &call)
        }
        "canvas_await" => canvas_await(&app_state, session_id, &call).await,
        "canvas_create" | "canvas_update" | "canvas_data" => {
            canvas_ack(&app_state, session_id, &call.arguments).await
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
    if let Err(e) = crate::acp::write_to_acp_session(&app_state, session_id, &reply).await {
        log::warn!(
            "[acp] could not answer {} for session-{session_id}: {e}",
            call.name
        );
    }
}

/// The shared collection only: the gateway answers a project's prompts itself.
fn prompt_tool(app_state: &Arc<AppState>, call: &HostToolCall) -> Result<Value, String> {
    let write = !matches!(call.name.as_str(), "list_prompts" | "get_prompt");
    crate::prompts::with_shared(app_state, write, |conn| {
        crate::prompts::tool(conn, &call.name, &call.arguments)
    })
}

pub(super) async fn session_project_id(
    app_state: &Arc<AppState>,
    session_id: &str,
) -> Result<i32, String> {
    app_state
        .acp
        .sessions
        .lock()
        .await
        .get(session_id)
        .and_then(|session| session.project_id)
        .ok_or_else(|| "this session is not attached to a Maestro project".to_string())
}

/// The branch new work is cut from, in the same order the create dialog resolves it: the
/// project's configured default, else whatever the repository is on.
pub(super) async fn default_base_branch(
    app_state: &Arc<AppState>,
    project_id: i32,
    config: &crate::project::models::ProjectConfig,
) -> String {
    match config.base_branch.clone() {
        Some(branch) => branch,
        None => match crate::core::get_project_with_git_conn(app_state, project_id).await {
            Ok((_, conn)) => crate::git::ops::get_current_branch(&conn)
                .await
                .unwrap_or_else(|_| "main".to_string()),
            Err(_) => "main".to_string(),
        },
    }
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
    session_id: &str,
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
        .remove(&(session_id.to_string(), surface_id.to_string()));
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
    session_id: &str,
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

    let key = (session_id.to_string(), call.request_id.clone());
    let (tx, rx) = tokio::sync::oneshot::channel::<Value>();
    app_state
        .acp
        .pending_host_tools
        .lock()
        .await
        .insert(key.clone(), tx);

    let task = {
        let sessions = app_state.acp.sessions.lock().await;
        sessions
            .get(session_id)
            .and_then(|session| session.task_key())
    };
    if let Some(task) = task {
        crate::acp::reader_task::mark_task_blocked(app_state, task).await;
    }

    // `surface_id` is null for a wait that takes any surface; the panel reads it that way.
    if let Err(e) = app_state.app_handle.emit(
        &format!("acp://canvas-await/{}", session_id),
        &json!({ "request_id": call.request_id, "surface_id": surface_id }),
    ) {
        log::warn!("[acp] emit canvas-await/{session_id} failed: {e}");
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
        &format!("acp://canvas-await-ended/{}", session_id),
        &json!({ "request_id": call.request_id }),
    ) {
        log::warn!("[acp] emit canvas-await-ended/{session_id} failed: {e}");
    }
    crate::acp::prompt_handlers::clear_task_blocked(app_state, task).await;

    Ok(outcome)
}
