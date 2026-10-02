use serde::{Deserialize, Serialize};
use specta::Type;
use std::sync::Arc;
use tauri::State;

use crate::acp::transport::{
    ElicitationResponse, MaestroRpcMessage, PermissionResponse, PromptRequest, ServerRequest,
    SetConfigOptionRequest, SetModeRequest, SetModelRequest,
};
use crate::core::AppState;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct AcpPromptCapabilities {
    pub embedded_context: bool,
    pub image: bool,
    pub audio: bool,
}

async fn send_prompt_impl(
    app_state: &Arc<AppState>,
    session_id: &str,
    content: serde_json::Value,
) -> Result<(), String> {
    // The daemon clears a task's block on any prompt, an answer to a question included.
    let msg = MaestroRpcMessage::Request(ServerRequest::Prompt(PromptRequest {
        session_id: session_id.to_string(),
        content,
    }));
    crate::acp::write_to_acp_session(app_state, session_id, &msg).await
}

#[tauri::command]
#[specta::specta]
pub async fn send_acp_prompt(
    app_state: State<'_, Arc<AppState>>,
    session_id: &str,
    content: String,
) -> Result<(), String> {
    send_prompt_impl(&app_state, session_id, serde_json::Value::String(content)).await
}

#[tauri::command]
#[specta::specta]
pub async fn send_acp_prompt_structured(
    app_state: State<'_, Arc<AppState>>,
    session_id: &str,
    content_blocks: serde_json::Value,
) -> Result<(), String> {
    send_prompt_impl(&app_state, session_id, content_blocks).await
}

#[tauri::command]
#[specta::specta]
pub async fn respond_acp_permission(
    app_state: State<'_, Arc<AppState>>,
    session_id: &str,
    request_id: String,
    option_id: Option<String>,
) -> Result<(), String> {
    let task = {
        let sessions = app_state.acp.sessions.lock().await;
        let session = sessions.get(session_id);
        if let Some(session) = session {
            session
                .has_pending_permission
                .store(false, std::sync::atomic::Ordering::Release);
        }
        session.and_then(|s| s.task_key())
    };

    // A question Maestro asked itself, such as `run_automation`'s, is answered here: the server
    // never saw it and has nothing waiting on it, so its block is this window's to clear. The
    // daemon clears the block on an answer to its own.
    let host_question = app_state
        .acp
        .pending_host_tools
        .lock()
        .await
        .remove(&(session_id.to_string(), request_id.clone()));
    if let Some(sender) = host_question {
        clear_task_blocked(&app_state, task).await;
        let _ = sender.send(serde_json::json!(option_id));
        return Ok(());
    }

    let msg = MaestroRpcMessage::Request(ServerRequest::PermitResponse(PermissionResponse {
        session_id: session_id.to_string(),
        request_id,
        option_id,
    }));
    crate::acp::write_to_acp_session(&app_state, session_id, &msg).await
}

/// The user answered a wait this window owns, so the agent is running again.
///
/// Paired with `mark_task_blocked` in `reader_task`.
///
/// Awaited rather than spawned: every caller is a command or a host tool, off the shared reader,
/// and a spawned clear could land before a mark still in flight.
pub(crate) async fn clear_task_blocked(
    app_state: &Arc<AppState>,
    task: Option<crate::acp::TaskKey>,
) {
    if let Some(task) = task {
        crate::acp::reader_task::transition_task(
            app_state,
            task,
            maestro_protocol::TaskTransition::Unblocked,
            maestro_protocol::TransitionGuard::Blocked,
        )
        .await;
    }
}

#[tauri::command]
#[specta::specta]
pub async fn respond_acp_elicitation(
    app_state: State<'_, Arc<AppState>>,
    session_id: &str,
    request_id: String,
    response: serde_json::Value,
) -> Result<(), String> {
    let msg = MaestroRpcMessage::Request(ServerRequest::ElicitationResponse(ElicitationResponse {
        session_id: session_id.to_string(),
        request_id,
        response,
    }));
    crate::acp::write_to_acp_session(&app_state, session_id, &msg).await
}

/// Answer a `canvas_await` the agent is blocked on.
///
/// Silently does nothing when the request is no longer pending: the wait times out on its own
/// schedule, and a click that lands as it expires is a race, not an error worth surfacing.
#[tauri::command]
#[specta::specta]
pub async fn respond_host_tool(
    app_state: State<'_, Arc<AppState>>,
    session_id: &str,
    request_id: String,
    result: serde_json::Value,
) -> Result<(), String> {
    let sender = app_state
        .acp
        .pending_host_tools
        .lock()
        .await
        .remove(&(session_id.to_string(), request_id));
    if let Some(sender) = sender {
        let _ = sender.send(result);
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn set_acp_model(
    app_state: State<'_, Arc<AppState>>,
    session_id: &str,
    model_id: String,
) -> Result<(), String> {
    let msg = MaestroRpcMessage::Request(ServerRequest::SetModel(SetModelRequest {
        session_id: session_id.to_string(),
        model_id,
    }));
    crate::acp::write_to_acp_session(&app_state, session_id, &msg).await
}

#[tauri::command]
#[specta::specta]
pub async fn set_acp_mode(
    app_state: State<'_, Arc<AppState>>,
    session_id: &str,
    mode_id: String,
) -> Result<(), String> {
    // At `info` because which mode a role ended up in is not otherwise knowable: the request itself
    // is only traced, and the fallback list in `useExecuteTask` is a guess about names that differ
    // per harness. Tuning it needs evidence, and a mode nobody can observe is a mode nobody can
    // correct — during the live pass this was the reason a blocked reviewer could not be explained.
    log::info!("[acp] session-{session_id} permission mode set to {mode_id}");

    let msg = MaestroRpcMessage::Request(ServerRequest::SetMode(SetModeRequest {
        session_id: session_id.to_string(),
        mode_id,
    }));
    crate::acp::write_to_acp_session(&app_state, session_id, &msg).await
}

#[tauri::command]
#[specta::specta]
pub async fn set_acp_config_option(
    app_state: State<'_, Arc<AppState>>,
    session_id: &str,
    option_id: String,
    value: String,
) -> Result<(), String> {
    let msg = match option_id.as_str() {
        "model" => MaestroRpcMessage::Request(ServerRequest::SetModel(SetModelRequest {
            session_id: session_id.to_string(),
            model_id: value,
        })),
        "mode" => MaestroRpcMessage::Request(ServerRequest::SetMode(SetModeRequest {
            session_id: session_id.to_string(),
            mode_id: value,
        })),
        other => {
            MaestroRpcMessage::Request(ServerRequest::SetConfigOption(SetConfigOptionRequest {
                session_id: session_id.to_string(),
                config_id: other.to_string(),
                value,
            }))
        }
    };
    crate::acp::write_to_acp_session(&app_state, session_id, &msg).await
}

#[cfg(test)]
mod tests {
    use crate::acp::transport::{
        MaestroRpcMessage, PermissionResponse, PromptRequest, ServerRequest,
    };

    #[test]
    fn test_send_acp_prompt_message_structure() {
        let session_id = "b5c1f0e2-4a7d-4c2b-9c3e-0f1a2b3c4d5e";
        let content = "fix the auth bug";

        let msg = MaestroRpcMessage::Request(ServerRequest::Prompt(PromptRequest {
            session_id: session_id.to_string(),
            content: serde_json::Value::String(content.to_string()),
        }));

        let json = serde_json::to_string(&msg).unwrap();
        assert!(
            json.contains("\"direction\":\"request\""),
            "must be a request direction"
        );
        assert!(
            json.contains("\"type\":\"prompt\""),
            "must have type=prompt"
        );
        assert!(
            json.contains(&format!("\"session_id\":\"{}\"", session_id)),
            "session_id must match session_id pattern"
        );
        assert!(
            json.contains(&format!("\"content\":\"{}\"", content)),
            "content must be preserved verbatim"
        );

        let back: MaestroRpcMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(msg, back, "PromptRequest must roundtrip through JSON");
    }

    #[test]
    fn test_respond_acp_permission_message_structure() {
        let session_id = "9d2e7c41-8b6a-4f3d-a1c5-6e7f8a9b0c1d";
        let request_id = "perm-001";

        let allow_msg =
            MaestroRpcMessage::Request(ServerRequest::PermitResponse(PermissionResponse {
                session_id: session_id.to_string(),
                request_id: request_id.to_string(),
                option_id: Some("allow_once".into()),
            }));
        let allow_json = serde_json::to_string(&allow_msg).unwrap();
        assert!(
            allow_json.contains("\"type\":\"permit_response\""),
            "must have type=permit_response"
        );
        assert!(
            allow_json.contains("\"option_id\""),
            "option_id must be present"
        );
        assert!(allow_json.contains(&format!("\"request_id\":\"{}\"", request_id)));

        let cancel_msg =
            MaestroRpcMessage::Request(ServerRequest::PermitResponse(PermissionResponse {
                session_id: session_id.to_string(),
                request_id: request_id.to_string(),
                option_id: None,
            }));
        let cancel_json = serde_json::to_string(&cancel_msg).unwrap();
        assert_ne!(
            allow_json, cancel_json,
            "allow and cancel must produce different JSON"
        );

        let back: MaestroRpcMessage = serde_json::from_str(&allow_json).unwrap();
        assert_eq!(allow_msg, back);
    }
}
