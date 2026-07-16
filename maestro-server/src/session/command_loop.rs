use std::sync::Arc;

use agent_client_protocol as acp;
use acp::schema::v1::{
    CancelNotification, CloseSessionRequest,
    PromptRequest, PromptResponse, SessionConfigId,
    SessionConfigKind, SessionConfigOption, SessionConfigSelectOptions,
    SessionConfigValueId, SetSessionConfigOptionRequest,
    SetSessionModeRequest, StopReason,
};
use maestro_protocol::{
    ConfigOptionUpdatedResponse, ErrorResponse, MaestroRpcMessage,
    ModeInfo as ProtocolModeInfo, ModelInfo as ProtocolModelInfo, PromptCapabilitiesInfo,
    ServerResponse, SessionModeState as ProtocolSessionModeState,
    SessionModelState as ProtocolSessionModelState, SetModeOkResponse,
    TurnEnded,
};
use tokio::sync::{mpsc, Mutex};

use crate::send_response;
use crate::sessions::SessionCommand;

pub(crate) async fn handle_prompt_result(
    result: Result<PromptResponse, acp::Error>,
    session_id: String,
    stdout: &Arc<Mutex<tokio::io::Stdout>>,
) {
    let stop_reason = match result {
        Ok(resp) => match resp.stop_reason {
            StopReason::EndTurn => "end_turn",
            StopReason::MaxTokens => "max_tokens",
            StopReason::MaxTurnRequests => "max_turn_requests",
            StopReason::Refusal => "refusal",
            StopReason::Cancelled => "cancelled",
            _ => "unknown",
        }
        .to_string(),
        Err(e) => {
            crate::send_diag("error", format!("[prompt] ACP error for session {session_id}: {e}"));
            if e.code == acp::schema::v1::ErrorCode::AuthRequired {
                "auth_required"
            } else {
                "error"
            }
            .to_string()
        }
    };
    let msg = MaestroRpcMessage::Response(ServerResponse::TurnEnded(TurnEnded {
        session_id,
        stop_reason,
    }));
    let _ = send_response(stdout, &msg).await;
}


pub(crate) fn convert_acp_modes(
    acp_modes: Option<&acp::schema::v1::SessionModeState>,
) -> Option<ProtocolSessionModeState> {
    acp_modes.map(|m| ProtocolSessionModeState {
        current_mode_id: m.current_mode_id.0.to_string(),
        available_modes: m
            .available_modes
            .iter()
            .map(|mi| ProtocolModeInfo {
                mode_id: mi.id.0.to_string(),
                name: mi.name.clone(),
                description: mi.description.clone(),
            })
            .collect(),
    })
}

pub(crate) fn serialize_config_options(options: &[SessionConfigOption]) -> Vec<serde_json::Value> {
    options
        .iter()
        .filter_map(|opt| serde_json::to_value(opt).ok())
        .collect()
}

/// Used on session load when the agent provides config_options but no legacy models field.
pub(crate) fn models_from_config_options(config_options: &[SessionConfigOption]) -> Option<ProtocolSessionModelState> {
    let model_opt = config_options.iter().find(|o| o.id.0.as_ref() == "model")?;
    let SessionConfigKind::Select(select) = &model_opt.kind else {
        return None;
    };
    let available_models = match &select.options {
        SessionConfigSelectOptions::Ungrouped(vals) => vals
            .iter()
            .map(|v| ProtocolModelInfo {
                model_id: v.value.0.to_string(),
                name: v.name.clone(),
                description: v.description.clone(),
            })
            .collect(),
        SessionConfigSelectOptions::Grouped(groups) => groups
            .iter()
            .flat_map(|g| {
                g.options.iter().map(|v| ProtocolModelInfo {
                    model_id: v.value.0.to_string(),
                    name: v.name.clone(),
                    description: v.description.clone(),
                })
            })
            .collect(),
        _ => return None,
    };
    Some(ProtocolSessionModelState {
        current_model_id: select.current_value.0.to_string(),
        available_models,
    })
}

/// Used on session load when the agent provides config_options but no legacy modes field.
pub(crate) fn modes_from_config_options(config_options: &[SessionConfigOption]) -> Option<ProtocolSessionModeState> {
    let mode_opt = config_options.iter().find(|o| o.id.0.as_ref() == "mode")?;
    let SessionConfigKind::Select(select) = &mode_opt.kind else {
        return None;
    };
    let available_modes = match &select.options {
        SessionConfigSelectOptions::Ungrouped(vals) => vals
            .iter()
            .map(|v| ProtocolModeInfo {
                mode_id: v.value.0.to_string(),
                name: v.name.clone(),
                description: v.description.clone(),
            })
            .collect(),
        SessionConfigSelectOptions::Grouped(groups) => groups
            .iter()
            .flat_map(|g| {
                g.options.iter().map(|v| ProtocolModeInfo {
                    mode_id: v.value.0.to_string(),
                    name: v.name.clone(),
                    description: v.description.clone(),
                })
            })
            .collect(),
        _ => return None,
    };
    Some(ProtocolSessionModeState {
        current_mode_id: select.current_value.0.to_string(),
        available_modes,
    })
}

pub(crate) fn extract_prompt_capabilities(response: &acp::schema::v1::InitializeResponse) -> PromptCapabilitiesInfo {
    PromptCapabilitiesInfo {
        embedded_context: response.agent_capabilities.prompt_capabilities.embedded_context,
        image: response.agent_capabilities.prompt_capabilities.image,
        audio: response.agent_capabilities.prompt_capabilities.audio,
    }
}

pub(crate) async fn run_command_loop(
    mut cmd_rx: mpsc::Receiver<SessionCommand>,
    cx: acp::ConnectionTo<acp::Agent>,
    session_id: acp::schema::v1::SessionId,
    so: Arc<Mutex<tokio::io::Stdout>>,
    maestro_sid: String,
    router: Option<Arc<crate::sessions::SessionRouter>>,
) {
    while let Some(cmd) = cmd_rx.recv().await {
        match cmd {
            SessionCommand::CloseSession => {
                let _ = tokio::time::timeout(
                    std::time::Duration::from_secs(5),
                    cx.send_request(CloseSessionRequest::new(session_id.to_string())).block_task(),
                )
                .await;
                if let Some(ref router) = router {
                    router.unregister(&session_id.to_string()).await;
                }
                return;
            }
            SessionCommand::Prompt(content) => {
                crate::send_diag("info", format!("[prompt] turn started session={}", maestro_sid));
                let so = Arc::clone(&so);
                let so_err = Arc::clone(&so);
                let sid = maestro_sid.clone();
                let result = cx
                    .send_request_to(
                        acp::Agent,
                        PromptRequest::new(session_id.clone(), vec![content.into()]),
                    )
                    .on_receiving_result(async move |result| {
                        handle_prompt_result(result, sid, &so).await;
                        Ok(())
                    });
                if result.is_err() {
                    let _ = send_response(&so_err, &MaestroRpcMessage::Response(
                        ServerResponse::TurnEnded(TurnEnded {
                            session_id: maestro_sid.clone(),
                            stop_reason: "error".to_string(),
                        }),
                    )).await;
                    break;
                }
            }
            SessionCommand::PromptStructured(blocks) => {
                crate::send_diag("info", format!("[prompt] turn started session={}", maestro_sid));
                let so = Arc::clone(&so);
                let so_err = Arc::clone(&so);
                let sid = maestro_sid.clone();
                let content_blocks: Vec<acp::schema::v1::ContentBlock> = blocks
                    .into_iter()
                    .filter_map(|b| serde_json::from_value(b).ok())
                    .collect();
                let result = cx
                    .send_request_to(
                        acp::Agent,
                        PromptRequest::new(session_id.clone(), content_blocks),
                    )
                    .on_receiving_result(async move |result| {
                        handle_prompt_result(result, sid, &so).await;
                        Ok(())
                    });
                if result.is_err() {
                    let _ = send_response(&so_err, &MaestroRpcMessage::Response(
                        ServerResponse::TurnEnded(TurnEnded {
                            session_id: maestro_sid.clone(),
                            stop_reason: "error".to_string(),
                        }),
                    )).await;
                    break;
                }
            }
            SessionCommand::CancelTurn => {
                let _ = cx.send_notification(CancelNotification::new(session_id.clone()));
            }
            SessionCommand::SetModel(model_id) => {
                let result = cx
                    .send_request(SetSessionConfigOptionRequest::new(
                        session_id.clone(),
                        SessionConfigId::new("model".to_string()),
                        SessionConfigValueId::new(model_id.clone()),
                    ))
                    .block_task()
                    .await;
                let msg = match result {
                    Ok(response) => MaestroRpcMessage::Response(
                        ServerResponse::ConfigOptionUpdated(ConfigOptionUpdatedResponse {
                            session_id: maestro_sid.clone(),
                            config_id: "model".to_string(),
                            value: model_id,
                            config_options: serialize_config_options(&response.config_options),
                        }),
                    ),
                    Err(e) => MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
                        message: format!("SetModel failed: {}", e),
                        session_id: None,
                    })),
                };
                let _ = send_response(&so, &msg).await;
            }
            SessionCommand::SetMode(mode_id) => {
                let result = cx
                    .send_request(SetSessionConfigOptionRequest::new(
                        session_id.clone(),
                        SessionConfigId::new("mode".to_string()),
                        SessionConfigValueId::new(mode_id.clone()),
                    ))
                    .block_task()
                    .await;
                let msg = match result {
                    Ok(response) => MaestroRpcMessage::Response(
                        ServerResponse::ConfigOptionUpdated(ConfigOptionUpdatedResponse {
                            session_id: maestro_sid.clone(),
                            config_id: "mode".to_string(),
                            value: mode_id,
                            config_options: serialize_config_options(&response.config_options),
                        }),
                    ),
                    Err(e) if e.code == acp::ErrorCode::MethodNotFound => {
                        let fallback = cx
                            .send_request(SetSessionModeRequest::new(
                                session_id.clone(),
                                mode_id.clone(),
                            ))
                            .block_task()
                            .await;
                        match fallback {
                            Ok(_) => MaestroRpcMessage::Response(ServerResponse::SetModeOk(
                                SetModeOkResponse {
                                    session_id: maestro_sid.clone(),
                                    mode_id,
                                },
                            )),
                            Err(e) => MaestroRpcMessage::Response(ServerResponse::Error(
                                ErrorResponse {
                                    message: format!("SetMode failed: {}", e),
                                    session_id: None,
                                },
                            )),
                        }
                    }
                    Err(e) => MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
                        message: format!("SetMode failed: {}", e),
                        session_id: None,
                    })),
                };
                let _ = send_response(&so, &msg).await;
            }
            SessionCommand::SetConfigOption { config_id, value } => {
                let result = cx
                    .send_request(SetSessionConfigOptionRequest::new(
                        session_id.clone(),
                        SessionConfigId::new(config_id.clone()),
                        SessionConfigValueId::new(value.clone()),
                    ))
                    .block_task()
                    .await;
                let msg = match result {
                    Ok(response) => MaestroRpcMessage::Response(
                        ServerResponse::ConfigOptionUpdated(ConfigOptionUpdatedResponse {
                            session_id: maestro_sid.clone(),
                            config_id,
                            value,
                            config_options: serialize_config_options(&response.config_options),
                        }),
                    ),
                    Err(e) => MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
                        message: format!("SetConfigOption failed: {}", e),
                        session_id: None,
                    })),
                };
                let _ = send_response(&so, &msg).await;
            }
        }
    }
    // Idempotent cleanup: ensure router unregistered regardless of how loop exited
    // (send error, cmd_tx dropped, or any other break path).
    if let Some(ref router) = router {
        router.unregister(&session_id.to_string()).await;
    }
}

