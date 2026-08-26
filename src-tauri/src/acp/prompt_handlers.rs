use std::sync::Arc;
use tauri::{Emitter, State};
use serde::{Deserialize, Serialize};
use specta::Type;

use crate::core::AppState;
use crate::acp::transport::{
    MaestroRpcMessage, ServerRequest,
    PromptRequest, PermissionResponse, ElicitationResponse,
    SetModelRequest, SetModeRequest, SetConfigOptionRequest,
};

use super::session_id_for;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct AcpPromptCapabilities {
    pub embedded_context: bool,
    pub image: bool,
    pub audio: bool,
}


async fn send_prompt_impl(
    app_state: &Arc<AppState>,
    log_id: i32,
    content: serde_json::Value,
) -> Result<(), String> {
    // Any reply puts the agent back to work, including a plain message answering a question the
    // agent asked by ending its turn. Without this only permission and elicitation responses
    // would clear the block, and an ordinary reply would leave the card pulsing.
    let task_id = {
        let sessions = app_state.acp.sessions.lock().await;
        sessions.get(&log_id).and_then(|s| s.task_id)
    };
    clear_task_blocked(app_state, task_id);

    let msg = MaestroRpcMessage::Request(ServerRequest::Prompt(PromptRequest {
        session_id: session_id_for(log_id),
        content,
    }));
    crate::acp::write_to_acp_session(app_state, log_id, &msg).await
}

#[tauri::command]
#[specta::specta]
pub async fn send_acp_prompt(
    app_state: State<'_, Arc<AppState>>,
    log_id: i32,
    content: String,
) -> Result<(), String> {
    send_prompt_impl(&app_state, log_id, serde_json::Value::String(content)).await
}

#[tauri::command]
#[specta::specta]
pub async fn send_acp_prompt_structured(
    app_state: State<'_, Arc<AppState>>,
    log_id: i32,
    content_blocks: serde_json::Value,
) -> Result<(), String> {
    send_prompt_impl(&app_state, log_id, content_blocks).await
}

#[tauri::command]
#[specta::specta]
pub async fn respond_acp_permission(
    app_state: State<'_, Arc<AppState>>,
    log_id: i32,
    request_id: String,
    option_id: Option<String>,
) -> Result<(), String> {
    let task_id = {
        let sessions = app_state.acp.sessions.lock().await;
        let session = sessions.get(&log_id);
        if let Some(session) = session {
            session.has_pending_permission.store(false, std::sync::atomic::Ordering::Release);
        }
        session.and_then(|s| s.task_id)
    };
    clear_task_blocked(&app_state, task_id);

    let session_id = session_id_for(log_id);
    let msg = MaestroRpcMessage::Request(ServerRequest::PermitResponse(PermissionResponse {
        session_id,
        request_id,
        option_id,
    }));
    crate::acp::write_to_acp_session(&app_state, log_id, &msg).await
}

/// The user answered, so the agent is running again.
///
/// Paired with `mark_task_blocked` in `reader_task`. Missing this leaves the card pulsing for an
/// answer that has already been given — the cost of persisting the blocked state rather than
/// deriving it from live session events, which used to self-heal on reload.
fn clear_task_blocked(app_state: &Arc<AppState>, task_id: Option<i32>) {
    let Some(task_id) = task_id else {
        return;
    };
    let changed = {
        let Ok(conn) = app_state.db.lock() else {
            return;
        };
        match crate::task::transition::clear_blocked(&conn, task_id) {
            Ok(result) => result.is_some(),
            Err(e) => {
                log::warn!("[acp] could not clear blocked state for task {task_id}: {e}");
                false
            }
        }
    };
    if changed {
        app_state.app_handle.emit("tasks-changed", ()).ok();
    }
}

#[tauri::command]
#[specta::specta]
pub async fn respond_acp_elicitation(
    app_state: State<'_, Arc<AppState>>,
    log_id: i32,
    request_id: String,
    response: serde_json::Value,
) -> Result<(), String> {
    let task_id = {
        let sessions = app_state.acp.sessions.lock().await;
        sessions.get(&log_id).and_then(|s| s.task_id)
    };
    clear_task_blocked(&app_state, task_id);

    let session_id = session_id_for(log_id);
    let msg = MaestroRpcMessage::Request(ServerRequest::ElicitationResponse(ElicitationResponse {
        session_id,
        request_id,
        response,
    }));
    crate::acp::write_to_acp_session(&app_state, log_id, &msg).await
}

#[tauri::command]
#[specta::specta]
pub async fn set_acp_model(
    app_state: State<'_, Arc<AppState>>,
    log_id: i32,
    model_id: String,
) -> Result<(), String> {
    let session_id = session_id_for(log_id);
    let msg = MaestroRpcMessage::Request(ServerRequest::SetModel(SetModelRequest {
        session_id,
        model_id,
    }));
    crate::acp::write_to_acp_session(&app_state, log_id, &msg).await
}

#[tauri::command]
#[specta::specta]
pub async fn set_acp_mode(
    app_state: State<'_, Arc<AppState>>,
    log_id: i32,
    mode_id: String,
) -> Result<(), String> {
    // At `info` because which mode a role ended up in is not otherwise knowable: the request itself
    // is only traced, and the fallback list in `useExecuteTask` is a guess about names that differ
    // per harness. Tuning it needs evidence, and a mode nobody can observe is a mode nobody can
    // correct — during the live pass this was the reason a blocked reviewer could not be explained.
    log::info!("[acp] session-{log_id} permission mode set to {mode_id}");

    let session_id = session_id_for(log_id);
    let msg = MaestroRpcMessage::Request(ServerRequest::SetMode(SetModeRequest {
        session_id,
        mode_id,
    }));
    crate::acp::write_to_acp_session(&app_state, log_id, &msg).await
}

#[tauri::command]
#[specta::specta]
pub async fn set_acp_config_option(
    app_state: State<'_, Arc<AppState>>,
    log_id: i32,
    option_id: String,
    value: String,
) -> Result<(), String> {
    let session_id = session_id_for(log_id);
    let msg = match option_id.as_str() {
        "model" => MaestroRpcMessage::Request(ServerRequest::SetModel(SetModelRequest {
            session_id,
            model_id: value,
        })),
        "mode" => MaestroRpcMessage::Request(ServerRequest::SetMode(SetModeRequest {
            session_id,
            mode_id: value,
        })),
        other => MaestroRpcMessage::Request(ServerRequest::SetConfigOption(SetConfigOptionRequest {
            session_id,
            config_id: other.to_string(),
            value,
        })),
    };
    crate::acp::write_to_acp_session(&app_state, log_id, &msg).await
}


#[cfg(test)]
mod tests {
    use crate::acp::transport::{MaestroRpcMessage, ServerRequest, PromptRequest, PermissionResponse};
    use super::session_id_for;

    #[test]
    fn test_send_acp_prompt_message_structure() {
        let log_id: i32 = 42;
        let content = "fix the auth bug";
        let session_id = session_id_for(log_id);

        let msg = MaestroRpcMessage::Request(ServerRequest::Prompt(PromptRequest {
            session_id: session_id.clone(),
            content: serde_json::Value::String(content.to_string()),
        }));

        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("\"direction\":\"request\""), "must be a request direction");
        assert!(json.contains("\"type\":\"prompt\""), "must have type=prompt");
        assert!(json.contains(&format!("\"session_id\":\"{}\"", session_id)), "session_id must match log_id pattern");
        assert!(json.contains(&format!("\"content\":\"{}\"", content)), "content must be preserved verbatim");

        let back: MaestroRpcMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(msg, back, "PromptRequest must roundtrip through JSON");
    }

    #[test]
    fn test_respond_acp_permission_message_structure() {
        let log_id: i32 = 7;
        let request_id = "perm-001";
        let session_id = session_id_for(log_id);

        let allow_msg = MaestroRpcMessage::Request(ServerRequest::PermitResponse(PermissionResponse {
            session_id: session_id.clone(),
            request_id: request_id.to_string(),
            option_id: Some("allow_once".into()),
        }));
        let allow_json = serde_json::to_string(&allow_msg).unwrap();
        assert!(allow_json.contains("\"type\":\"permit_response\""), "must have type=permit_response");
        assert!(allow_json.contains("\"option_id\""), "option_id must be present");
        assert!(allow_json.contains(&format!("\"request_id\":\"{}\"", request_id)));

        let cancel_msg = MaestroRpcMessage::Request(ServerRequest::PermitResponse(PermissionResponse {
            session_id: session_id.clone(),
            request_id: request_id.to_string(),
            option_id: None,
        }));
        let cancel_json = serde_json::to_string(&cancel_msg).unwrap();
        assert_ne!(allow_json, cancel_json, "allow and cancel must produce different JSON");

        let back: MaestroRpcMessage = serde_json::from_str(&allow_json).unwrap();
        assert_eq!(allow_msg, back);
    }
}
