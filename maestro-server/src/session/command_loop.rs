use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;

use acp::schema::v1::{
    CancelNotification, CloseSessionRequest, PromptRequest, PromptResponse, SessionConfigId,
    SessionConfigKind, SessionConfigOption, SessionConfigSelectOptions, SessionConfigValueId,
    SetSessionConfigOptionRequest, SetSessionModeRequest, StopReason,
};
use agent_client_protocol as acp;
use maestro_protocol::{
    ConfigOptionUpdatedResponse, ErrorResponse, ModeInfo as ProtocolModeInfo,
    ModelInfo as ProtocolModelInfo, PromptCapabilitiesInfo, ServerResponse,
    SessionModeState as ProtocolSessionModeState, SessionModelState as ProtocolSessionModelState,
    SessionUpdate, SetModeOkResponse, TurnEnded, TurnStarted, TurnUsage,
};
use tokio::sync::mpsc;

use crate::send_response;
use crate::sessions::SessionCommand;

pub(crate) async fn handle_prompt_result(
    result: Result<PromptResponse, acp::Error>,
    session_id: String,
    stdout: &crate::ClientOut,
) {
    let ended = turn_ended(result, session_id);
    crate::helpers::note_turn_ended(
        &ended.session_id,
        &ended.stop_reason,
        ended.usage.clone(),
        ended.model_usage.clone(),
    );
    let _ = send_response(stdout, &ServerResponse::TurnEnded(ended)).await;
}

fn turn_ended(result: Result<PromptResponse, acp::Error>, session_id: String) -> TurnEnded {
    let (stop_reason, (usage, model_usage)) = match result {
        Ok(resp) => (
            match resp.stop_reason {
                StopReason::EndTurn => "end_turn",
                StopReason::MaxTokens => "max_tokens",
                StopReason::MaxTurnRequests => "max_turn_requests",
                StopReason::Refusal => "refusal",
                StopReason::Cancelled => "cancelled",
                _ => "unknown",
            }
            .to_string(),
            turn_usage(&resp),
        ),
        Err(e) => {
            crate::send_diag(
                "error",
                format!("[prompt] ACP error for session {session_id}: {e}"),
            );
            let stop_reason = if e.code == acp::schema::v1::ErrorCode::AuthRequired {
                "auth_required"
            } else {
                if crate::agent_gate::is_limit(e.data.as_ref(), &e.message) {
                    crate::turn::note_usage_limited(&session_id);
                }
                "error"
            };
            (stop_reason.to_string(), (None, None))
        }
    };
    TurnEnded {
        session_id,
        stop_reason,
        usage,
        model_usage,
    }
}

/// The agent's token counts for the turn, and its raw `_meta.quota.model_usage`.
fn turn_usage(resp: &PromptResponse) -> (Option<TurnUsage>, Option<serde_json::Value>) {
    let usage = resp.usage.as_ref().map(|u| TurnUsage {
        total_tokens: u.total_tokens,
        input_tokens: u.input_tokens,
        output_tokens: u.output_tokens,
        thought_tokens: u.thought_tokens,
        cached_read_tokens: u.cached_read_tokens,
        cached_write_tokens: u.cached_write_tokens,
    });
    let model_usage = resp
        .meta
        .as_ref()
        .and_then(|m| m.get("quota"))
        .and_then(|q| q.get("model_usage"))
        .cloned();
    (usage, model_usage)
}

/// The prompt itself, for the transcript. Sent here rather than where a client's prompt arrives,
/// so the ones the daemon sends on its own, a task's or an automation's, are shown as well.
async fn announce_prompt(stdout: &crate::ClientOut, session_id: &str, content: serde_json::Value) {
    let sent_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    let msg = ServerResponse::SessionUpdate(SessionUpdate {
        session_id: session_id.to_string(),
        payload: serde_json::json!({
            "sessionUpdate": "user_message",
            "content": content,
            "sentAt": sent_at,
        }),
    });
    let _ = send_response(stdout, &msg).await;
}

/// Sent ahead of the prompt, so it reaches the host before anything the agent says in answer.
async fn announce_turn(stdout: &crate::ClientOut, session_id: &str) {
    crate::usage_store::note_turn_started(session_id);
    let msg = ServerResponse::TurnStarted(TurnStarted {
        session_id: session_id.to_string(),
    });
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
pub(crate) fn models_from_config_options(
    config_options: &[SessionConfigOption],
) -> Option<ProtocolSessionModelState> {
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
pub(crate) fn modes_from_config_options(
    config_options: &[SessionConfigOption],
) -> Option<ProtocolSessionModeState> {
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

pub(crate) fn extract_prompt_capabilities(
    response: &acp::schema::v1::InitializeResponse,
) -> PromptCapabilitiesInfo {
    PromptCapabilitiesInfo {
        embedded_context: response
            .agent_capabilities
            .prompt_capabilities
            .embedded_context,
        image: response.agent_capabilities.prompt_capabilities.image,
        audio: response.agent_capabilities.prompt_capabilities.audio,
    }
}

/// The prompts sent and not yet answered.
///
/// Usually one. An agent that queues prompts (claude-agent-acp advertises `promptQueueing`) takes
/// a second while the first is still open, for example a turn it holds for background subagents,
/// and answers the first as the second starts. The turn the user sees runs on into the second,
/// so only the last answer ends it.
#[derive(Default)]
struct PromptsInFlight(AtomicUsize);

impl PromptsInFlight {
    fn start(&self) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }

    /// Whether this answer was the last outstanding one.
    fn finish(&self) -> bool {
        self.0.fetch_sub(1, Ordering::SeqCst) == 1
    }
}

pub(crate) async fn run_command_loop(
    mut cmd_rx: mpsc::Receiver<SessionCommand>,
    cx: acp::ConnectionTo<acp::Agent>,
    session_id: acp::schema::v1::SessionId,
    so: crate::ClientOut,
    maestro_sid: String,
    router: Option<Arc<crate::sessions::SessionRouter>>,
    // Whether a `session/prompt` is genuinely outstanding. Without this the
    // cancel handler cannot tell "agent is working" from "the host's view is
    // stale", and answers neither — leaving the UI stuck in "thinking".
    //
    // Owned by the caller rather than created here because `ActiveSession` holds the other end:
    // a client that has just attached asks which sessions are mid-turn before deciding what it
    // can safely do to them.
    turn_active: Arc<AtomicBool>,
) {
    let in_flight = Arc::new(PromptsInFlight::default());
    while let Some(cmd) = cmd_rx.recv().await {
        match cmd {
            SessionCommand::CloseSession => {
                let _ = tokio::time::timeout(
                    std::time::Duration::from_secs(5),
                    cx.send_request(CloseSessionRequest::new(session_id.to_string()))
                        .block_task(),
                )
                .await;
                break;
            }
            SessionCommand::Prompt(content) => {
                crate::send_diag(
                    "info",
                    format!("[prompt] turn started session={}", maestro_sid),
                );
                let so = Arc::clone(&so);
                let so_err = Arc::clone(&so);
                crate::turn::note_turn_started(&maestro_sid);
                let sid = maestro_sid.clone();
                turn_active.store(true, Ordering::SeqCst);
                let turn_flag = Arc::clone(&turn_active);
                in_flight.start();
                announce_prompt(
                    &so,
                    &maestro_sid,
                    serde_json::Value::String(content.clone()),
                )
                .await;
                announce_turn(&so, &maestro_sid).await;
                let answered = Arc::clone(&in_flight);
                let result = cx
                    .send_request_to(
                        acp::Agent,
                        PromptRequest::new(session_id.clone(), vec![content.into()]),
                    )
                    .on_receiving_result(async move |result| {
                        if !answered.finish() {
                            crate::send_diag(
                                "info",
                                format!("[prompt] superseded by a queued prompt session={sid}"),
                            );
                            return Ok(());
                        }
                        turn_flag.store(false, Ordering::SeqCst);
                        handle_prompt_result(result, sid, &so).await;
                        Ok(())
                    });
                if result.is_err() {
                    in_flight.finish();
                    turn_active.store(false, Ordering::SeqCst);
                    crate::helpers::note_turn_ended(&maestro_sid, "error", None, None);
                    let _ = send_response(
                        &so_err,
                        &ServerResponse::TurnEnded(TurnEnded {
                            session_id: maestro_sid.clone(),
                            stop_reason: "error".to_string(),
                            usage: None,
                            model_usage: None,
                        }),
                    )
                    .await;
                    break;
                }
            }
            SessionCommand::PromptStructured(blocks) => {
                crate::send_diag(
                    "info",
                    format!("[prompt] turn started session={}", maestro_sid),
                );
                let so = Arc::clone(&so);
                let so_err = Arc::clone(&so);
                crate::turn::note_turn_started(&maestro_sid);
                let sid = maestro_sid.clone();
                announce_prompt(&so, &maestro_sid, serde_json::Value::Array(blocks.clone())).await;
                let content_blocks: Vec<acp::schema::v1::ContentBlock> = blocks
                    .into_iter()
                    .filter_map(|b| serde_json::from_value(b).ok())
                    .collect();
                turn_active.store(true, Ordering::SeqCst);
                let turn_flag = Arc::clone(&turn_active);
                in_flight.start();
                announce_turn(&so, &maestro_sid).await;
                let answered = Arc::clone(&in_flight);
                let result = cx
                    .send_request_to(
                        acp::Agent,
                        PromptRequest::new(session_id.clone(), content_blocks),
                    )
                    .on_receiving_result(async move |result| {
                        if !answered.finish() {
                            crate::send_diag(
                                "info",
                                format!("[prompt] superseded by a queued prompt session={sid}"),
                            );
                            return Ok(());
                        }
                        turn_flag.store(false, Ordering::SeqCst);
                        handle_prompt_result(result, sid, &so).await;
                        Ok(())
                    });
                if result.is_err() {
                    in_flight.finish();
                    turn_active.store(false, Ordering::SeqCst);
                    crate::helpers::note_turn_ended(&maestro_sid, "error", None, None);
                    let _ = send_response(
                        &so_err,
                        &ServerResponse::TurnEnded(TurnEnded {
                            session_id: maestro_sid.clone(),
                            stop_reason: "error".to_string(),
                            usage: None,
                            model_usage: None,
                        }),
                    )
                    .await;
                    break;
                }
            }
            SessionCommand::CancelTurn => {
                // Only `InterruptTurn` sends this, and only a user stops a turn.
                crate::turn::note_interrupted(&maestro_sid);
                if turn_active.load(Ordering::SeqCst) {
                    let _ = cx.send_notification(CancelNotification::new(session_id.clone()));
                } else {
                    // No prompt is outstanding, so the agent has nothing to cancel and
                    // would never answer. The host only asks because its own TurnEnded
                    // went missing — re-send one so the UI can leave "thinking".
                    crate::send_diag(
                        "warn",
                        format!("[prompt] cancel with no turn in flight session={maestro_sid} — resending TurnEnded"),
                    );
                    if let Err(e) = send_response(
                        &so,
                        &ServerResponse::TurnEnded(TurnEnded {
                            session_id: maestro_sid.clone(),
                            stop_reason: "cancelled".to_string(),
                            usage: None,
                            model_usage: None,
                        }),
                    )
                    .await
                    {
                        crate::send_diag(
                            "error",
                            format!("[prompt] failed to resend TurnEnded: {e}"),
                        );
                    }
                }
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
                    Ok(response) => {
                        crate::usage_store::note_model(&maestro_sid, &model_id);
                        ServerResponse::ConfigOptionUpdated(ConfigOptionUpdatedResponse {
                            session_id: maestro_sid.clone(),
                            config_id: "model".to_string(),
                            value: model_id,
                            config_options: serialize_config_options(&response.config_options),
                        })
                    }
                    Err(e) => ServerResponse::Error(ErrorResponse {
                        message: format!("SetModel failed: {}", e),
                        session_id: None,
                    }),
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
                    Ok(response) => {
                        ServerResponse::ConfigOptionUpdated(ConfigOptionUpdatedResponse {
                            session_id: maestro_sid.clone(),
                            config_id: "mode".to_string(),
                            value: mode_id,
                            config_options: serialize_config_options(&response.config_options),
                        })
                    }
                    Err(e) if e.code == acp::ErrorCode::MethodNotFound => {
                        let fallback = cx
                            .send_request(SetSessionModeRequest::new(
                                session_id.clone(),
                                mode_id.clone(),
                            ))
                            .block_task()
                            .await;
                        match fallback {
                            Ok(_) => ServerResponse::SetModeOk(SetModeOkResponse {
                                session_id: maestro_sid.clone(),
                                mode_id,
                            }),
                            Err(e) => ServerResponse::Error(ErrorResponse {
                                message: format!("SetMode failed: {}", e),
                                session_id: None,
                            }),
                        }
                    }
                    Err(e) => ServerResponse::Error(ErrorResponse {
                        message: format!("SetMode failed: {}", e),
                        session_id: None,
                    }),
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
                    Ok(response) => {
                        if config_id == "model" {
                            crate::usage_store::note_model(&maestro_sid, &value);
                        }
                        ServerResponse::ConfigOptionUpdated(ConfigOptionUpdatedResponse {
                            session_id: maestro_sid.clone(),
                            config_id,
                            value,
                            config_options: serialize_config_options(&response.config_options),
                        })
                    }
                    Err(e) => ServerResponse::Error(ErrorResponse {
                        message: format!("SetConfigOption failed: {}", e),
                        session_id: None,
                    }),
                };
                let _ = send_response(&so, &msg).await;
            }
        }
    }
    // Idempotent cleanup: ensure router unregistered regardless of how loop exited
    // (close, send error, cmd_tx dropped, or any other break path).
    if let Some(ref router) = router {
        router.unregister(&session_id.to_string()).await;
    }
    crate::helpers::forget_session(&maestro_sid);
}

#[cfg(test)]
mod tests {
    use super::{turn_ended, PromptsInFlight};
    use acp::schema::v1::PromptResponse;
    use agent_client_protocol as acp;
    use maestro_protocol::TurnUsage;

    fn response(json: serde_json::Value) -> PromptResponse {
        serde_json::from_value(json).unwrap()
    }

    #[test]
    fn a_turn_carries_the_usage_the_agent_reported() {
        let model_usage = serde_json::json!([{ "model": "opus", "token_count": { "input": 7 } }]);
        let ended = turn_ended(
            Ok(response(serde_json::json!({
                "stopReason": "end_turn",
                "usage": {
                    "totalTokens": 30,
                    "inputTokens": 10,
                    "outputTokens": 15,
                    "cachedReadTokens": 5
                },
                "_meta": { "quota": { "model_usage": model_usage.clone() } }
            }))),
            "s".to_string(),
        );
        assert_eq!(ended.stop_reason, "end_turn");
        assert_eq!(
            ended.usage,
            Some(TurnUsage {
                total_tokens: 30,
                input_tokens: 10,
                output_tokens: 15,
                thought_tokens: None,
                cached_read_tokens: Some(5),
                cached_write_tokens: None,
            })
        );
        assert_eq!(ended.model_usage, Some(model_usage));
    }

    #[test]
    fn a_turn_without_usage_still_ends() {
        let ended = turn_ended(
            Ok(response(serde_json::json!({ "stopReason": "end_turn" }))),
            "s".to_string(),
        );
        assert_eq!(ended.stop_reason, "end_turn");
        assert_eq!(ended.usage, None);
        assert_eq!(ended.model_usage, None);
    }

    #[test]
    fn malformed_usage_is_dropped_and_the_turn_still_ends() {
        for usage in [
            serde_json::json!("oops"),
            serde_json::json!({ "inputTokens": 1, "outputTokens": 2 }),
        ] {
            let ended = turn_ended(
                Ok(response(
                    serde_json::json!({ "stopReason": "end_turn", "usage": usage }),
                )),
                "s".to_string(),
            );
            assert_eq!(ended.stop_reason, "end_turn");
            assert_eq!(ended.usage, None);
        }
    }

    #[test]
    fn only_the_last_outstanding_answer_ends_the_turn() {
        let in_flight = PromptsInFlight::default();
        in_flight.start();
        in_flight.start();
        assert!(
            !in_flight.finish(),
            "the held prompt, answered as the queued one starts"
        );
        assert!(in_flight.finish(), "the queued prompt");
        in_flight.start();
        assert!(in_flight.finish(), "a lone prompt ends its turn");
    }
}
