use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use agent_client_protocol as acp;
use acp::schema::{
    CancelNotification, ClientCapabilities, CloseSessionRequest, CreateTerminalRequest,
    CreateTerminalResponse, Implementation, InitializeRequest, KillTerminalRequest,
    KillTerminalResponse, ListSessionsRequest, LoadSessionRequest, NewSessionRequest,
    PermissionOptionId, PromptRequest, PromptResponse, ProtocolVersion, ReleaseTerminalRequest,
    ReleaseTerminalResponse, RequestPermissionOutcome, RequestPermissionRequest,
    RequestPermissionResponse, SelectedPermissionOutcome, SessionNotification,
    SetSessionModelRequest, SetSessionModeRequest, StopReason, TerminalExitStatus,
    TerminalOutputRequest, TerminalOutputResponse, WaitForTerminalExitRequest,
    WaitForTerminalExitResponse,
};
use agent_client_protocol_schema::{
    CreateElicitationRequest, CreateElicitationResponse, ElicitationCapabilities,
    ElicitationFormCapabilities,
};
use maestro_protocol::{
    ElicitationRequest as MaestroElicitationRequest, ErrorResponse, MaestroRpcMessage,
    ModeInfo as ProtocolModeInfo, ModelInfo as ProtocolModelInfo,
    PermissionRequest as MaestroPermissionRequest, PromptCapabilitiesInfo, ServerResponse,
    SessionListEntry, SessionModeState as ProtocolSessionModeState,
    SessionModelState as ProtocolSessionModelState, SessionUpdate, SetModeOkResponse,
    SetModelOkResponse, TurnEnded,
};
use tokio::sync::{mpsc, oneshot, Mutex};
use tokio_util::compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt};

use crate::agent;
use crate::registry;
use crate::send_response;
use crate::sessions::{ActiveSession, AgentCapabilities, AgentConnection, SessionCommand, SessionRouter, SharedSessionState, TerminalHandle};
use crate::terminal::handle_create_terminal;

/// Shared state for ACP connection handlers, routable across N sessions.
#[derive(Clone)]
pub(crate) struct ConnectionHandlers {
    pub router: Arc<SessionRouter>,
    pub terminals: Arc<Mutex<HashMap<String, TerminalHandle>>>,
    pub terminal_counter: Arc<AtomicU64>,
    pub stdout: Arc<Mutex<tokio::io::Stdout>>,
    pub elicit_counter: Arc<AtomicU64>,
}

macro_rules! configure_acp_builder {
    ($handlers:expr, $terms:expr) => {{
        let _h = $handlers;
        let _terms = $terms;
        acp::Client
            .builder()
            .name("maestro-server")
            .on_receive_request(
                {
                    let h = _h.clone();
                    move |request: RequestPermissionRequest, responder: acp::Responder<RequestPermissionResponse>, _cx: acp::ConnectionTo<acp::Agent>| {
                        let h = h.clone();
                        async move { h.handle_permission(request, responder).await }
                    }
                },
                acp::on_receive_request!(),
            )
            .on_receive_notification(
                {
                    let h = _h.clone();
                    move |notification: SessionNotification, _cx: acp::ConnectionTo<acp::Agent>| {
                        let h = h.clone();
                        async move { h.handle_notification(notification).await }
                    }
                },
                acp::on_receive_notification!(),
            )
            .on_receive_request(
                {
                    let h = _h.clone();
                    move |request: CreateTerminalRequest, responder: acp::Responder<CreateTerminalResponse>, _cx: acp::ConnectionTo<acp::Agent>| {
                        let h = h.clone();
                        async move { h.handle_create_terminal(request, responder).await }
                    }
                },
                acp::on_receive_request!(),
            )
            .on_receive_request(
                {
                    let terms = Arc::clone(&_terms);
                    move |request: TerminalOutputRequest, responder: acp::Responder<TerminalOutputResponse>, _cx: acp::ConnectionTo<acp::Agent>| {
                        let terms = terms.clone();
                        async move {
                            let terminal_id_str = request.terminal_id.to_string();
                            let terminals = terms.lock().await;
                            let handle = terminals.get(&terminal_id_str).ok_or_else(|| {
                                acp::Error::new(-32603, "unknown terminal")
                            })?;
                            let output = handle.output_buf.lock().await.clone();
                            let truncated = handle
                                .output_byte_limit
                                .map(|limit| output.len() >= limit as usize)
                                .unwrap_or(false);
                            let exit_status =
                                handle.exit_status.lock().await.as_ref().map(|info| {
                                    TerminalExitStatus::new()
                                        .exit_code(info.exit_code)
                                        .signal(info.signal.clone())
                                });
                            responder.respond(
                                TerminalOutputResponse::new(output, truncated)
                                    .exit_status(exit_status),
                            )
                        }
                    }
                },
                acp::on_receive_request!(),
            )
            .on_receive_request(
                {
                    let terms = Arc::clone(&_terms);
                    move |request: ReleaseTerminalRequest, responder: acp::Responder<ReleaseTerminalResponse>, _cx: acp::ConnectionTo<acp::Agent>| {
                        let terms = terms.clone();
                        async move {
                            let terminal_id_str = request.terminal_id.to_string();
                            terms.lock().await.remove(&terminal_id_str);
                            responder.respond(ReleaseTerminalResponse::new())
                        }
                    }
                },
                acp::on_receive_request!(),
            )
            .on_receive_request(
                {
                    let terms = Arc::clone(&_terms);
                    move |request: WaitForTerminalExitRequest, responder: acp::Responder<WaitForTerminalExitResponse>, _cx: acp::ConnectionTo<acp::Agent>| {
                        let terms = terms.clone();
                        async move {
                            let terminal_id_str = request.terminal_id.to_string();
                            loop {
                                let (exit_status_arc, exit_notify_arc) = {
                                    let terminals = terms.lock().await;
                                    if let Some(handle) = terminals.get(&terminal_id_str) {
                                        (
                                            Arc::clone(&handle.exit_status),
                                            Arc::clone(&handle.exit_notify),
                                        )
                                    } else {
                                        return responder.respond(
                                            WaitForTerminalExitResponse::new(
                                                TerminalExitStatus::new(),
                                            ),
                                        );
                                    }
                                };
                                {
                                    let info = exit_status_arc.lock().await;
                                    if let Some(exit_info) = info.as_ref() {
                                        let status = TerminalExitStatus::new()
                                            .exit_code(exit_info.exit_code)
                                            .signal(exit_info.signal.clone());
                                        return responder.respond(
                                            WaitForTerminalExitResponse::new(status),
                                        );
                                    }
                                }
                                exit_notify_arc.notified().await;
                            }
                        }
                    }
                },
                acp::on_receive_request!(),
            )
            .on_receive_request(
                {
                    let terms = Arc::clone(&_terms);
                    move |request: KillTerminalRequest, responder: acp::Responder<KillTerminalResponse>, _cx: acp::ConnectionTo<acp::Agent>| {
                        let terms = terms.clone();
                        async move {
                            let terminal_id_str = request.terminal_id.to_string();
                            let mut terminals = terms.lock().await;
                            if let Some(handle) = terminals.get_mut(&terminal_id_str) {
                                if let Some(tx) = handle.kill_tx.lock().await.take() {
                                    let _ = tx.send(());
                                }
                            }
                            responder.respond(KillTerminalResponse::new())
                        }
                    }
                },
                acp::on_receive_request!(),
            )
            .on_receive_request(
                {
                    let h = _h.clone();
                    move |request: acp::UntypedMessage, responder: acp::Responder<serde_json::Value>, _cx: acp::ConnectionTo<acp::Agent>| {
                        let h = h.clone();
                        async move { h.handle_elicitation(request, responder).await }
                    }
                },
                acp::on_receive_request!(),
            )
    }};
}

impl ConnectionHandlers {
    pub fn new(stdout: Arc<Mutex<tokio::io::Stdout>>) -> (Self, Arc<SessionRouter>) {
        let router = Arc::new(SessionRouter::default());
        let handlers = Self {
            router: Arc::clone(&router),
            terminals: Arc::new(Mutex::new(HashMap::new())),
            terminal_counter: Arc::new(AtomicU64::new(0)),
            stdout,
            elicit_counter: Arc::new(AtomicU64::new(0)),
        };
        (handlers, router)
    }

    pub async fn handle_permission(
        &self,
        request: RequestPermissionRequest,
        responder: acp::Responder<RequestPermissionResponse>,
    ) -> acp::Result<()> {
        let acp_sid = request.session_id.to_string();
        let (maestro_sid, state) = self
            .router
            .get_session(&acp_sid)
            .await
            .ok_or_else(|| acp::Error::new(-32603, format!("unknown session: {acp_sid}")))?;

        let request_id = request.tool_call.tool_call_id.to_string();
        let (tx, rx) = oneshot::channel::<Option<String>>();
        state.pending_permissions.lock().await.insert(request_id.clone(), tx);

        let payload = serde_json::to_value(&request)
            .map_err(|e| acp::Error::new(-32603, e.to_string()))?;
        let msg = MaestroRpcMessage::Response(ServerResponse::PermissionRequest(
            MaestroPermissionRequest {
                session_id: maestro_sid,
                request_id,
                payload,
            },
        ));
        send_response(&self.stdout, &msg)
            .await
            .map_err(|e| acp::Error::new(-32603, e.to_string()))?;

        let outcome = match rx.await {
            Ok(Some(id)) => RequestPermissionOutcome::Selected(
                SelectedPermissionOutcome::new(PermissionOptionId::new(id)),
            ),
            Ok(None) | Err(_) => RequestPermissionOutcome::Cancelled,
        };
        responder.respond(RequestPermissionResponse::new(outcome))
    }

    pub async fn handle_notification(
        &self,
        notification: SessionNotification,
    ) -> acp::Result<()> {
        let acp_sid = notification.session_id.to_string();
        let maestro_sid = self
            .router
            .get_maestro_id(&acp_sid)
            .await
            .ok_or_else(|| acp::Error::new(-32603, format!("unknown session: {acp_sid}")))?;

        let payload = serde_json::to_value(&notification.update)
            .map_err(|e| acp::Error::new(-32603, e.to_string()))?;
        let msg = MaestroRpcMessage::Response(ServerResponse::SessionUpdate(SessionUpdate {
            session_id: maestro_sid,
            payload,
        }));
        send_response(&self.stdout, &msg)
            .await
            .map_err(|e| acp::Error::new(-32603, e.to_string()))?;
        Ok(())
    }

    pub async fn handle_create_terminal(
        &self,
        request: CreateTerminalRequest,
        responder: acp::Responder<CreateTerminalResponse>,
    ) -> acp::Result<()> {
        let acp_sid = request.session_id.to_string();
        let maestro_sid = self
            .router
            .get_maestro_id(&acp_sid)
            .await
            .ok_or_else(|| acp::Error::new(-32603, format!("unknown session: {acp_sid}")))?;

        let resp = handle_create_terminal(
            request,
            Arc::clone(&self.terminals),
            Arc::clone(&self.terminal_counter),
            Arc::clone(&self.stdout),
            maestro_sid,
        )
        .await?;
        responder.respond(resp)
    }

    pub async fn handle_elicitation(
        &self,
        request: acp::UntypedMessage,
        responder: acp::Responder<serde_json::Value>,
    ) -> acp::Result<()> {
        if request.method() != "elicitation/create" {
            return responder.respond_with_error(
                acp::Error::method_not_found().data(request.method().to_string()),
            );
        }
        let elicitation: CreateElicitationRequest =
            serde_json::from_value(request.params().clone())
                .map_err(|e| acp::Error::new(-32602, format!("invalid elicitation request: {e}")))?;

        let acp_sid = match elicitation.scope() {
            agent_client_protocol_schema::ElicitationScope::Session(scope) => {
                scope.session_id.to_string()
            }
            _ => {
                return responder.respond_with_error(acp::Error::new(
                    -32603,
                    "non-session elicitation scope not supported",
                ))
            }
        };
        let (maestro_sid, state) = self
            .router
            .get_session(&acp_sid)
            .await
            .ok_or_else(|| acp::Error::new(-32603, format!("unknown session: {acp_sid}")))?;

        let request_id = format!(
            "elicit-{}",
            self.elicit_counter.fetch_add(1, Ordering::Relaxed) + 1
        );
        let (tx, rx) = oneshot::channel::<serde_json::Value>();
        state.pending_elicitations.lock().await.insert(request_id.clone(), tx);

        let payload = request.params().clone();
        let msg = MaestroRpcMessage::Response(ServerResponse::ElicitationRequest(
            MaestroElicitationRequest {
                session_id: maestro_sid,
                request_id,
                message: elicitation.message,
                payload,
            },
        ));
        send_response(&self.stdout, &msg)
            .await
            .map_err(|e| acp::Error::new(-32603, e.to_string()))?;

        let response = rx.await.map_err(|_| acp::Error::new(-32603, "elicitation channel closed"))?;
        let _validated: CreateElicitationResponse =
            serde_json::from_value(response.clone())
                .map_err(|e| acp::Error::new(-32603, format!("invalid elicitation response: {e}")))?;
        responder.respond(response)
    }
}

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
        Err(_) => "error".to_string(),
    };
    let msg = MaestroRpcMessage::Response(ServerResponse::TurnEnded(TurnEnded {
        session_id,
        stop_reason,
    }));
    let _ = send_response(stdout, &msg).await;
}

pub(crate) async fn ensure_agent_cache(
    cache: &mut Option<(std::time::Instant, Vec<registry::DiscoveredAgentWithSpawn>)>,
    ttl: std::time::Duration,
    reg: &maestro_protocol::AcpRegistry,
) -> Vec<registry::DiscoveredAgentWithSpawn> {
    let needs_refresh = cache
        .as_ref()
        .map(|(ts, _)| ts.elapsed() > ttl)
        .unwrap_or(true);
    if !needs_refresh {
        return cache.as_ref().unwrap().1.clone();
    }
    let agents = registry::discover_agents(reg).await;
    *cache = Some((std::time::Instant::now(), agents.clone()));
    agents
}

pub(crate) fn convert_acp_models(
    acp_models: Option<&acp::schema::SessionModelState>,
) -> Option<ProtocolSessionModelState> {
    acp_models.map(|m| ProtocolSessionModelState {
        current_model_id: m.current_model_id.0.to_string(),
        available_models: m
            .available_models
            .iter()
            .map(|mi| ProtocolModelInfo {
                model_id: mi.model_id.0.to_string(),
                name: mi.name.clone(),
                description: mi.description.clone(),
            })
            .collect(),
    })
}

pub(crate) fn convert_acp_modes(
    acp_modes: Option<&acp::schema::SessionModeState>,
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

fn extract_prompt_capabilities(response: &acp::schema::InitializeResponse) -> PromptCapabilitiesInfo {
    PromptCapabilitiesInfo {
        embedded_context: response.agent_capabilities.prompt_capabilities.embedded_context,
        image: response.agent_capabilities.prompt_capabilities.image,
        audio: response.agent_capabilities.prompt_capabilities.audio,
    }
}

async fn run_command_loop(
    mut cmd_rx: mpsc::Receiver<SessionCommand>,
    cx: acp::ConnectionTo<acp::Agent>,
    session_id: acp::schema::SessionId,
    so: Arc<Mutex<tokio::io::Stdout>>,
    maestro_sid: String,
) {
    while let Some(cmd) = cmd_rx.recv().await {
        match cmd {
            SessionCommand::Prompt(content) => {
                let so = Arc::clone(&so);
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
                    break;
                }
            }
            SessionCommand::PromptStructured(blocks) => {
                let so = Arc::clone(&so);
                let sid = maestro_sid.clone();
                let content_blocks: Vec<acp::schema::ContentBlock> = blocks
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
                    break;
                }
            }
            SessionCommand::CancelTurn => {
                let _ = cx.send_notification(CancelNotification::new(session_id.clone()));
            }
            SessionCommand::SetModel(model_id) => {
                let result = cx
                    .send_request(SetSessionModelRequest::new(
                        session_id.clone(),
                        model_id.clone(),
                    ))
                    .block_task()
                    .await;
                let msg = match result {
                    Ok(_) => MaestroRpcMessage::Response(ServerResponse::SetModelOk(
                        SetModelOkResponse {
                            session_id: maestro_sid.clone(),
                            model_id,
                        },
                    )),
                    Err(e) => MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
                        message: format!("SetModel failed: {}", e),
                    })),
                };
                let _ = send_response(&so, &msg).await;
            }
            SessionCommand::SetMode(mode_id) => {
                let result = cx
                    .send_request(SetSessionModeRequest::new(
                        session_id.clone(),
                        mode_id.clone(),
                    ))
                    .block_task()
                    .await;
                let msg = match result {
                    Ok(_) => MaestroRpcMessage::Response(ServerResponse::SetModeOk(
                        SetModeOkResponse {
                            session_id: maestro_sid.clone(),
                            mode_id,
                        },
                    )),
                    Err(e) => MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
                        message: format!("SetMode failed: {}", e),
                    })),
                };
                let _ = send_response(&so, &msg).await;
            }
        }
    }
}

/// Spawn the ACP connection task for one agent session.
///
pub(crate) struct SpawnResult {
    pub(crate) session: ActiveSession,
    pub(crate) models: Option<ProtocolSessionModelState>,
    pub(crate) modes: Option<ProtocolSessionModeState>,
    pub(crate) prompt_capabilities: PromptCapabilitiesInfo,
    pub(crate) supports_session_list: bool,
    pub(crate) supports_session_load: bool,
    pub(crate) supports_session_close: bool,
    pub(crate) acp_session_id: String,
}

pub(crate) async fn spawn_acp_session(
    spawn_cmd: &str,
    spawn_args: &[String],
    spawn_env: &HashMap<String, String>,
    cwd: &str,
    maestro_session_id: String,
    stdout: Arc<Mutex<tokio::io::Stdout>>,
) -> Option<SpawnResult> {
    // 1. Spawn agent subprocess
    let mut child =
        match agent::spawn_agent_subprocess(spawn_cmd, spawn_args, cwd, spawn_env).await {
            Ok(c) => c,
            Err(e) => {
                let _ = send_response(
                    &stdout,
                    &MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
                        message: e,
                    })),
                )
                .await;
                return None;
            }
        };

    // 2. Bridge subprocess stdio via compat() for ByteStreams
    let child_stdin = child.stdin.take().expect("child stdin must be piped");
    let child_stdout = child.stdout.take().expect("child stdout must be piped");
    let outgoing = child_stdin.compat_write();
    let incoming = child_stdout.compat();
    let transport = acp::ByteStreams::new(outgoing, incoming);

    // 3. Channels: commands into the connection task, readiness signal out
    let (cmd_tx, cmd_rx) = mpsc::channel::<SessionCommand>(16);

    // 4. Per-session state shared between connection handlers (via router) and main.rs dispatch
    let pending_permissions: Arc<Mutex<HashMap<String, oneshot::Sender<Option<String>>>>> =
        Arc::new(Mutex::new(HashMap::new()));
    let pending_elicitations: Arc<Mutex<HashMap<String, oneshot::Sender<serde_json::Value>>>> =
        Arc::new(Mutex::new(HashMap::new()));
    let session_state = Arc::new(SharedSessionState {
        pending_permissions: Arc::clone(&pending_permissions),
        pending_elicitations: Arc::clone(&pending_elicitations),
    });

    // 5. Build connection handlers with an empty router; session registered inside connect_with
    //    after attach_session() gives us the ACP session ID.
    let (handlers, router) = ConnectionHandlers::new(Arc::clone(&stdout));
    let terms = Arc::clone(&handlers.terminals);
    let so = Arc::clone(&stdout);
    let sid = maestro_session_id.clone();
    let cwd_owned = cwd.to_string();
    let (ready_tx, ready_rx) = oneshot::channel::<Result<(Option<ProtocolSessionModelState>, Option<ProtocolSessionModeState>, PromptCapabilitiesInfo, bool, bool, bool, String), String>>();

    // 6. Spawn ACP connection as background task
    let task = tokio::spawn(async move {
        let _result = configure_acp_builder!(handlers, terms)
            .connect_with(transport, async move |cx: acp::ConnectionTo<acp::Agent>| {
                let init_result = cx
                    .send_request(
                        InitializeRequest::new(ProtocolVersion::V1)
                            .client_info(Implementation::new("maestro-server", "0.1.0"))
                            .client_capabilities(
                                ClientCapabilities::new()
                                    .terminal(true)
                                    .elicitation(
                                        ElicitationCapabilities::new()
                                            .form(ElicitationFormCapabilities::new()),
                                    ),
                            ),
                    )
                    .block_task()
                    .await;
                let init_response = match init_result {
                    Ok(resp) => resp,
                    Err(e) => {
                        let _ = ready_tx.send(Err(format!("ACP initialize failed: {}", e)));
                        return Ok(());
                    }
                };
                let prompt_caps = extract_prompt_capabilities(&init_response);
                let supports_list = init_response.agent_capabilities.session_capabilities.list.is_some();
                let supports_load = init_response.agent_capabilities.load_session;
                let supports_close = supports_list;

                let session_req = NewSessionRequest::new(std::path::PathBuf::from(&cwd_owned));
                let session_response = match cx.send_request(session_req).block_task().await {
                    Ok(r) => r,
                    Err(e) => {
                        let _ = ready_tx.send(Err(format!("ACP new_session failed: {}", e)));
                        return Ok(());
                    }
                };
                let models = convert_acp_models(session_response.models.as_ref());
                let modes = convert_acp_modes(session_response.modes.as_ref());
                let session = match cx.attach_session(session_response, vec![]) {
                    Ok(s) => s,
                    Err(e) => {
                        let _ = ready_tx.send(Err(format!("ACP attach_session failed: {}", e)));
                        return Ok(());
                    }
                };

                let acp_native_session_id = session.session_id().to_string();
                // Register route before signaling readiness so handlers can route immediately.
                router.register(acp_native_session_id.clone(), sid.clone(), session_state).await;
                let _ = ready_tx.send(Ok((models, modes, prompt_caps, supports_list, supports_load, supports_close, acp_native_session_id)));

                run_command_loop(cmd_rx, session.connection().clone(), session.session_id().clone(), so, sid).await;

                Ok(())
            })
            .await;

        drop(child);
    });

    match ready_rx.await {
        Ok(Ok((models, modes, prompt_caps, supports_list, supports_load, supports_close, native_session_id))) => Some(SpawnResult {
            session: ActiveSession {
                cmd_tx,
                pending_permissions,
                pending_elicitations,
                task,
            },
            models,
            modes,
            prompt_capabilities: prompt_caps,
            supports_session_list: supports_list,
            supports_session_load: supports_load,
            supports_session_close: supports_close,
            acp_session_id: native_session_id,
        }),
        Ok(Err(e)) => {
            let _ = send_response(
                &stdout,
                &MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse { message: e })),
            )
            .await;
            None
        }
        Err(_) => {
            let _ = send_response(
                &stdout,
                &MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
                    message: "ACP connection task exited unexpectedly".to_string(),
                })),
            )
            .await;
            None
        }
    }
}

pub(crate) async fn load_acp_session(
    spawn_cmd: &str,
    spawn_args: &[String],
    spawn_env: &HashMap<String, String>,
    cwd: &str,
    acp_session_id: String,
    maestro_session_id: String,
    stdout: Arc<Mutex<tokio::io::Stdout>>,
) -> Option<(ActiveSession, Option<ProtocolSessionModelState>, Option<ProtocolSessionModeState>, PromptCapabilitiesInfo)> {
    let mut child =
        match agent::spawn_agent_subprocess(spawn_cmd, spawn_args, cwd, spawn_env).await {
            Ok(c) => c,
            Err(e) => {
                let _ = send_response(
                    &stdout,
                    &MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
                        message: e,
                    })),
                )
                .await;
                return None;
            }
        };

    let child_stdin = child.stdin.take().expect("child stdin must be piped");
    let child_stdout = child.stdout.take().expect("child stdout must be piped");
    let outgoing = child_stdin.compat_write();
    let incoming = child_stdout.compat();
    let transport = acp::ByteStreams::new(outgoing, incoming);

    let (cmd_tx, cmd_rx) = mpsc::channel::<SessionCommand>(16);
    let pending_permissions: Arc<Mutex<HashMap<String, oneshot::Sender<Option<String>>>>> =
        Arc::new(Mutex::new(HashMap::new()));
    let pending_elicitations: Arc<Mutex<HashMap<String, oneshot::Sender<serde_json::Value>>>> =
        Arc::new(Mutex::new(HashMap::new()));
    let session_state = Arc::new(SharedSessionState {
        pending_permissions: Arc::clone(&pending_permissions),
        pending_elicitations: Arc::clone(&pending_elicitations),
    });

    let (handlers, router) = ConnectionHandlers::new(Arc::clone(&stdout));
    let terms = Arc::clone(&handlers.terminals);
    let so = Arc::clone(&stdout);
    let sid = maestro_session_id.clone();
    let cwd_owned = cwd.to_string();
    let load_sid = acp_session_id.clone();
    let (ready_tx, ready_rx) = oneshot::channel::<Result<(Option<ProtocolSessionModelState>, Option<ProtocolSessionModeState>, PromptCapabilitiesInfo), String>>();

    // Register the route before spawning — we already know the ACP session ID for a load.
    router.register(acp_session_id.clone(), maestro_session_id.clone(), session_state).await;

    let task = tokio::spawn(async move {
        let _result = configure_acp_builder!(handlers, terms)
            .connect_with(transport, async move |cx: acp::ConnectionTo<acp::Agent>| {
                let init_result = cx
                    .send_request(
                        InitializeRequest::new(ProtocolVersion::V1)
                            .client_info(Implementation::new("maestro-server", "0.1.0"))
                            .client_capabilities(
                                ClientCapabilities::new()
                                    .terminal(true)
                                    .elicitation(
                                        ElicitationCapabilities::new()
                                            .form(ElicitationFormCapabilities::new()),
                                    ),
                            ),
                    )
                    .block_task()
                    .await;
                let init_response = match init_result {
                    Ok(resp) => resp,
                    Err(e) => {
                        let _ = ready_tx.send(Err(format!("ACP initialize failed: {}", e)));
                        return Ok(());
                    }
                };
                let prompt_caps = extract_prompt_capabilities(&init_response);

                let load_req = LoadSessionRequest::new(load_sid.clone(), std::path::PathBuf::from(&cwd_owned));
                let load_response = match cx.send_request(load_req).block_task().await {
                    Ok(r) => r,
                    Err(e) => {
                        let _ = ready_tx.send(Err(format!("ACP session/load failed: {}", e)));
                        return Ok(());
                    }
                };
                let models = convert_acp_models(load_response.models.as_ref());
                let modes = convert_acp_modes(load_response.modes.as_ref());
                let _ = ready_tx.send(Ok((models, modes, prompt_caps)));

                run_command_loop(cmd_rx, cx, acp::schema::SessionId::new(load_sid), so, sid).await;

                Ok(())
            })
            .await;

        drop(child);
    });

    match ready_rx.await {
        Ok(Ok((models, modes, prompt_caps))) => Some((
            ActiveSession {
                cmd_tx,
                pending_permissions,
                pending_elicitations,
                task,
            },
            models,
            modes,
            prompt_caps,
        )),
        Ok(Err(e)) => {
            let _ = send_response(
                &stdout,
                &MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse { message: e })),
            )
            .await;
            None
        }
        Err(_) => {
            let _ = send_response(
                &stdout,
                &MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
                    message: "ACP load connection task exited unexpectedly".to_string(),
                })),
            )
            .await;
            None
        }
    }
}

pub(crate) async fn run_session_list(
    spawn_cmd: &str,
    spawn_args: &[String],
    spawn_env: &HashMap<String, String>,
    cwd: &str,
    cursor: Option<String>,
) -> Result<(Vec<SessionListEntry>, Option<String>), String> {
    let mut child = agent::spawn_agent_subprocess(spawn_cmd, spawn_args, cwd, spawn_env).await?;
    let child_stdin = child.stdin.take().expect("child stdin must be piped");
    let child_stdout = child.stdout.take().expect("child stdout must be piped");
    let outgoing = child_stdin.compat_write();
    let incoming = child_stdout.compat();
    let transport = acp::ByteStreams::new(outgoing, incoming);

    let (result_tx, result_rx) = oneshot::channel::<Result<(Vec<SessionListEntry>, Option<String>), String>>();
    let cwd_owned = cwd.to_string();

    tokio::spawn(async move {
        let _result = acp::Client
            .builder()
            .name("maestro-server")
            .on_receive_notification(
                {
                    move |_notification: SessionNotification, _cx: acp::ConnectionTo<acp::Agent>| {
                        async move { Ok(()) }
                    }
                },
                acp::on_receive_notification!(),
            )
            .connect_with(transport, async move |cx: acp::ConnectionTo<acp::Agent>| {
                let init_result = cx
                    .send_request(
                        InitializeRequest::new(ProtocolVersion::V1)
                            .client_info(Implementation::new("maestro-server", "0.1.0")),
                    )
                    .block_task()
                    .await;
                if let Err(e) = init_result {
                    let _ = result_tx.send(Err(format!("ACP initialize failed: {}", e)));
                    return Ok(());
                }

                let mut req = ListSessionsRequest::new().cwd(std::path::PathBuf::from(&cwd_owned));
                if let Some(c) = cursor {
                    req = req.cursor(c);
                }
                let list_result = cx
                    .send_request(req)
                    .block_task()
                    .await;
                match list_result {
                    Ok(resp) => {
                        let entries: Vec<SessionListEntry> = resp.sessions.into_iter().map(|s| {
                            SessionListEntry {
                                session_id: s.session_id.to_string(),
                                title: s.title,
                                updated_at: s.updated_at,
                            }
                        }).collect();
                        let _ = result_tx.send(Ok((entries, resp.next_cursor)));
                    }
                    Err(e) => {
                        let _ = result_tx.send(Err(format!("session/list failed: {}", e)));
                    }
                }
                Ok(())
            })
            .await;
        drop(child);
    });

    result_rx.await.map_err(|_| "session/list connection dropped".to_string())?
}

pub(crate) async fn run_session_close(
    spawn_cmd: &str,
    spawn_args: &[String],
    spawn_env: &HashMap<String, String>,
    cwd: &str,
    session_id: String,
) -> Result<(), String> {
    let mut child = agent::spawn_agent_subprocess(spawn_cmd, spawn_args, cwd, spawn_env).await?;
    let child_stdin = child.stdin.take().expect("child stdin must be piped");
    let child_stdout = child.stdout.take().expect("child stdout must be piped");
    let outgoing = child_stdin.compat_write();
    let incoming = child_stdout.compat();
    let transport = acp::ByteStreams::new(outgoing, incoming);

    let (result_tx, result_rx) = oneshot::channel::<Result<(), String>>();

    tokio::spawn(async move {
        let _result = acp::Client
            .builder()
            .name("maestro-server")
            .on_receive_notification(
                {
                    move |_notification: SessionNotification, _cx: acp::ConnectionTo<acp::Agent>| {
                        async move { Ok(()) }
                    }
                },
                acp::on_receive_notification!(),
            )
            .connect_with(transport, async move |cx: acp::ConnectionTo<acp::Agent>| {
                let init_result = cx
                    .send_request(
                        InitializeRequest::new(ProtocolVersion::V1)
                            .client_info(Implementation::new("maestro-server", "0.1.0")),
                    )
                    .block_task()
                    .await;
                if let Err(e) = init_result {
                    let _ = result_tx.send(Err(format!("ACP initialize failed: {}", e)));
                    return Ok(());
                }

                let close_result = cx
                    .send_request(CloseSessionRequest::new(session_id))
                    .block_task()
                    .await;
                match close_result {
                    Ok(_) => { let _ = result_tx.send(Ok(())); }
                    Err(e) => { let _ = result_tx.send(Err(format!("session/close failed: {}", e))); }
                }
                Ok(())
            })
            .await;
        drop(child);
    });

    result_rx.await.map_err(|_| "session/close connection dropped".to_string())?
}

/// List sessions using an already-initialized connection (fast path for `SessionList`).
pub(crate) async fn session_list_on_connection(
    conn: &AgentConnection,
    cwd: &str,
    cursor: Option<String>,
) -> Result<(Vec<SessionListEntry>, Option<String>), String> {
    let cx = conn.connection.clone();
    let mut req = ListSessionsRequest::new().cwd(std::path::PathBuf::from(cwd));
    if let Some(c) = cursor {
        req = req.cursor(c);
    }
    let resp = cx
        .send_request(req)
        .block_task()
        .await
        .map_err(|e| format!("session/list failed: {}", e))?;
    let entries: Vec<SessionListEntry> = resp
        .sessions
        .into_iter()
        .map(|s| SessionListEntry {
            session_id: s.session_id.to_string(),
            title: s.title,
            updated_at: s.updated_at,
        })
        .collect();
    Ok((entries, resp.next_cursor))
}

/// Close a session using an already-initialized connection (fast path for `SessionClose`).
pub(crate) async fn session_close_on_connection(
    conn: &AgentConnection,
    session_id: String,
) -> Result<(), String> {
    let cx = conn.connection.clone();
    cx.send_request(CloseSessionRequest::new(session_id))
        .block_task()
        .await
        .map_err(|e| format!("session/close failed: {}", e))?;
    Ok(())
}

/// Create a new session on an already-initialized `AgentConnection` (fast path).
///
/// Sends `session/new` on the existing connection instead of spawning a fresh agent process.
/// Registers the session route in the agent's router so shared handlers dispatch correctly.
pub(crate) async fn create_session_on_connection(
    conn: &AgentConnection,
    maestro_session_id: String,
    cwd: &str,
    stdout: Arc<Mutex<tokio::io::Stdout>>,
) -> Option<SpawnResult> {
    let cx = conn.connection.clone();
    let session_response = match cx
        .send_request(NewSessionRequest::new(std::path::PathBuf::from(cwd)))
        .block_task()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            let _ = send_response(
                &stdout,
                &MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
                    message: format!("ACP new_session failed: {}", e),
                })),
            )
            .await;
            return None;
        }
    };

    let models = convert_acp_models(session_response.models.as_ref());
    let modes = convert_acp_modes(session_response.modes.as_ref());
    let session_id = session_response.session_id.clone();
    let acp_session_id_str = session_id.to_string();

    let (cmd_tx, cmd_rx) = mpsc::channel::<SessionCommand>(16);
    let pending_permissions: Arc<Mutex<HashMap<String, oneshot::Sender<Option<String>>>>> =
        Arc::new(Mutex::new(HashMap::new()));
    let pending_elicitations: Arc<Mutex<HashMap<String, oneshot::Sender<serde_json::Value>>>> =
        Arc::new(Mutex::new(HashMap::new()));
    let session_state = Arc::new(SharedSessionState {
        pending_permissions: Arc::clone(&pending_permissions),
        pending_elicitations: Arc::clone(&pending_elicitations),
    });

    conn.router
        .register(
            acp_session_id_str.clone(),
            maestro_session_id.clone(),
            session_state,
        )
        .await;

    let so = Arc::clone(&stdout);
    let sid = maestro_session_id.clone();
    let prompt_capabilities = conn
        .capabilities
        .prompt_capabilities
        .clone()
        .unwrap_or(PromptCapabilitiesInfo {
            embedded_context: false,
            image: false,
            audio: false,
        });
    let supports_session_list = conn.capabilities.supports_session_list;
    let supports_session_load = conn.capabilities.supports_session_load;
    let supports_session_close = conn.capabilities.supports_session_close;

    let task = tokio::spawn(run_command_loop(cmd_rx, cx, session_id, so, sid));

    Some(SpawnResult {
        session: ActiveSession {
            cmd_tx,
            pending_permissions,
            pending_elicitations,
            task,
        },
        models,
        modes,
        prompt_capabilities,
        supports_session_list,
        supports_session_load,
        supports_session_close,
        acp_session_id: acp_session_id_str,
    })
}

/// Load an existing session on an already-initialized `AgentConnection` (fast path for SessionLoad).
///
/// Sends `session/load` on the existing connection instead of spawning a fresh agent process.
/// Registers the session route in the agent's router so shared handlers dispatch correctly.
pub(crate) async fn load_session_on_connection(
    conn: &AgentConnection,
    maestro_session_id: String,
    resume_session_id: String,
    cwd: &str,
    stdout: Arc<Mutex<tokio::io::Stdout>>,
) -> Option<(ActiveSession, Option<ProtocolSessionModelState>, Option<ProtocolSessionModeState>, PromptCapabilitiesInfo)> {
    let cx = conn.connection.clone();
    let load_req = LoadSessionRequest::new(
        resume_session_id.clone(),
        std::path::PathBuf::from(cwd),
    );
    let load_response = match cx.send_request(load_req).block_task().await {
        Ok(r) => r,
        Err(e) => {
            let _ = send_response(
                &stdout,
                &MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
                    message: format!("ACP session/load failed: {}", e),
                })),
            )
            .await;
            return None;
        }
    };

    let models = convert_acp_models(load_response.models.as_ref());
    let modes = convert_acp_modes(load_response.modes.as_ref());
    let session_id = acp::schema::SessionId::new(resume_session_id.clone());

    let (cmd_tx, cmd_rx) = mpsc::channel::<SessionCommand>(16);
    let pending_permissions: Arc<Mutex<HashMap<String, oneshot::Sender<Option<String>>>>> =
        Arc::new(Mutex::new(HashMap::new()));
    let pending_elicitations: Arc<Mutex<HashMap<String, oneshot::Sender<serde_json::Value>>>> =
        Arc::new(Mutex::new(HashMap::new()));
    let session_state = Arc::new(SharedSessionState {
        pending_permissions: Arc::clone(&pending_permissions),
        pending_elicitations: Arc::clone(&pending_elicitations),
    });

    conn.router
        .register(resume_session_id, maestro_session_id.clone(), session_state)
        .await;

    let prompt_capabilities = conn
        .capabilities
        .prompt_capabilities
        .clone()
        .unwrap_or(PromptCapabilitiesInfo {
            embedded_context: false,
            image: false,
            audio: false,
        });

    let so = Arc::clone(&stdout);
    let sid = maestro_session_id;
    let task = tokio::spawn(run_command_loop(cmd_rx, cx, session_id, so, sid));

    Some((
        ActiveSession {
            cmd_tx,
            pending_permissions,
            pending_elicitations,
            task,
        },
        models,
        modes,
        prompt_capabilities,
    ))
}

/// Spawn an agent process and run `initialize` only — no session created yet.
/// The returned `AgentConnection` holds a live `ConnectionTo<Agent>` that can
/// serve N sessions via `session/new` calls.
pub(crate) async fn pre_initialize_agent(
    spawn_cmd: &str,
    spawn_args: &[String],
    spawn_env: &HashMap<String, String>,
    cwd: &str,
    stdout: Arc<Mutex<tokio::io::Stdout>>,
) -> Option<AgentConnection> {
    let mut child =
        match agent::spawn_agent_subprocess(spawn_cmd, spawn_args, cwd, spawn_env).await {
            Ok(c) => c,
            Err(e) => {
                let _ = send_response(
                    &stdout,
                    &MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
                        message: e,
                    })),
                )
                .await;
                return None;
            }
        };

    let child_stdin = child.stdin.take().expect("child stdin must be piped");
    let child_stdout = child.stdout.take().expect("child stdout must be piped");
    let outgoing = child_stdin.compat_write();
    let incoming = child_stdout.compat();
    let transport = acp::ByteStreams::new(outgoing, incoming);

    let (handlers, router) = ConnectionHandlers::new(Arc::clone(&stdout));
    let terms = Arc::clone(&handlers.terminals);

    // Channels: ready signal carries capabilities + cloned connection handle
    type ReadyPayload = Result<(AgentCapabilities, acp::ConnectionTo<acp::Agent>), String>;
    let (ready_tx, ready_rx) = oneshot::channel::<ReadyPayload>();
    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();

    tokio::spawn(async move {
        let _result = configure_acp_builder!(handlers, terms)
            .connect_with(transport, async move |cx: acp::ConnectionTo<acp::Agent>| {
                let init_result = cx
                    .send_request(
                        InitializeRequest::new(ProtocolVersion::V1)
                            .client_info(Implementation::new("maestro-server", "0.1.0"))
                            .client_capabilities(
                                ClientCapabilities::new()
                                    .terminal(true)
                                    .elicitation(
                                        ElicitationCapabilities::new()
                                            .form(ElicitationFormCapabilities::new()),
                                    ),
                            ),
                    )
                    .block_task()
                    .await;
                let init_response = match init_result {
                    Ok(resp) => resp,
                    Err(e) => {
                        let _ = ready_tx.send(Err(format!("ACP initialize failed: {}", e)));
                        return Ok(());
                    }
                };
                let caps = AgentCapabilities {
                    prompt_capabilities: Some(extract_prompt_capabilities(&init_response)),
                    supports_session_list: init_response.agent_capabilities.session_capabilities.list.is_some(),
                    supports_session_load: init_response.agent_capabilities.load_session,
                    supports_session_close: init_response.agent_capabilities.session_capabilities.list.is_some(),
                };
                // Send the live connection handle out — caller uses it to create sessions.
                let _ = ready_tx.send(Ok((caps, cx)));
                // Hold the connection open until shutdown is requested or the child exits.
                let _ = shutdown_rx.await;
                Ok(())
            })
            .await;

        drop(child);
    });

    match ready_rx.await {
        Ok(Ok((capabilities, connection))) => Some(AgentConnection::new(
            connection,
            router,
            capabilities,
            shutdown_tx,
        )),
        Ok(Err(e)) => {
            let _ = send_response(
                &stdout,
                &MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse { message: e })),
            )
            .await;
            None
        }
        Err(_) => {
            let _ = send_response(
                &stdout,
                &MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
                    message: "ACP pre-initialize connection task exited unexpectedly".to_string(),
                })),
            )
            .await;
            None
        }
    }
}
