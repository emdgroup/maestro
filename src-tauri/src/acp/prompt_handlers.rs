use std::sync::Arc;
use tauri::State;
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

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct AgentCatalogOptionValue {
    pub name: String,
    pub value: String,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct AgentCatalogOption {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub category: Option<String>,
    pub options: Vec<AgentCatalogOptionValue>,
    pub default_value: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct AgentCatalogCommand {
    pub name: String,
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct AgentSessionCapabilities {
    pub supports_session_list: bool,
    pub supports_session_load: bool,
    pub supports_session_close: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct AgentCacheResponse {
    pub config_options: Vec<AgentCatalogOption>,
    pub available_commands: Vec<AgentCatalogCommand>,
    pub prompt_capabilities: Option<AcpPromptCapabilities>,
    pub session_capabilities: AgentSessionCapabilities,
}

async fn send_prompt_impl(
    app_state: &Arc<AppState>,
    log_id: i32,
    content: serde_json::Value,
) -> Result<(), String> {
    eprintln!("[maestro] send_prompt_impl: log_id={log_id} content={content}");
    let msg = MaestroRpcMessage::Request(ServerRequest::Prompt(PromptRequest {
        session_id: session_id_for(log_id),
        content,
    }));
    let result = crate::acp::write_to_acp_session(app_state, log_id, &msg).await;
    eprintln!("[maestro] send_prompt_impl result: {result:?}");
    result
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
    let session_id = session_id_for(log_id);
    let msg = MaestroRpcMessage::Request(ServerRequest::PermitResponse(PermissionResponse {
        session_id,
        request_id,
        option_id,
    }));
    crate::acp::write_to_acp_session(&app_state, log_id, &msg).await
}

#[tauri::command]
#[specta::specta]
pub async fn respond_acp_elicitation(
    app_state: State<'_, Arc<AppState>>,
    log_id: i32,
    request_id: String,
    response: serde_json::Value,
) -> Result<(), String> {
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

#[tauri::command]
#[specta::specta]
pub async fn get_agent_cache(
    app_state: State<'_, Arc<AppState>>,
    agent_id: String,
    connection: crate::acp::ConnectionKey,
) -> Result<Option<AgentCacheResponse>, String> {
    let connection_key = connection;
    let cache = app_state.acp.agent_cache.lock().await;
    let entry = match cache.get(&(connection_key, agent_id)) {
        Some(e) => e,
        None => return Ok(None),
    };
    Ok(Some(AgentCacheResponse {
        config_options: entry.config_options.iter().map(|o| AgentCatalogOption {
            id: o.id.clone(),
            name: o.name.clone(),
            description: o.description.clone(),
            category: o.category.clone(),
            options: o.options.iter().map(|v| AgentCatalogOptionValue {
                name: v.name.clone(),
                value: v.value.clone(),
                description: v.description.clone(),
            }).collect(),
            default_value: o.default_value.clone(),
        }).collect(),
        available_commands: entry.available_commands.iter().map(|c| AgentCatalogCommand {
            name: c.name.clone(),
            description: c.description.clone(),
        }).collect(),
        prompt_capabilities: entry.prompt_capabilities.as_ref().map(|c| AcpPromptCapabilities {
            embedded_context: c.embedded_context,
            image: c.image,
            audio: c.audio,
        }),
        session_capabilities: AgentSessionCapabilities {
            supports_session_list: entry.session_capabilities.supports_session_list,
            supports_session_load: entry.session_capabilities.supports_session_load,
            supports_session_close: entry.session_capabilities.supports_session_close,
        },
    }))
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
