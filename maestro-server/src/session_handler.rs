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
    SetSessionModelRequest, StopReason, TerminalExitStatus, TerminalOutputRequest,
    TerminalOutputResponse, WaitForTerminalExitRequest, WaitForTerminalExitResponse,
};
use agent_client_protocol_schema::{
    CreateElicitationRequest, CreateElicitationResponse, ElicitationCapabilities,
    ElicitationFormCapabilities,
};
use maestro_protocol::{
    ElicitationRequest as MaestroElicitationRequest, ErrorResponse, MaestroRpcMessage,
    ModelInfo as ProtocolModelInfo, PermissionRequest as MaestroPermissionRequest,
    PromptCapabilitiesInfo, ServerResponse, SessionListEntry,
    SessionModelState as ProtocolSessionModelState, SessionUpdate, SetModelOkResponse,
    TurnEnded,
};
use tokio::sync::{mpsc, oneshot, Mutex};
use tokio_util::compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt};

use crate::agent;
use crate::registry;
use crate::send_response;
use crate::sessions::{ActiveSession, SessionCommand, TerminalHandle};
use crate::terminal::handle_create_terminal;

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

/// Spawn the ACP connection task for one agent session.
///
pub(crate) struct SpawnResult {
    pub(crate) session: ActiveSession,
    pub(crate) models: Option<ProtocolSessionModelState>,
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

    // 3. Shared state for callbacks (Arc for Send + Sync)
    let pending_permissions: Arc<Mutex<HashMap<String, oneshot::Sender<Option<String>>>>> =
        Arc::new(Mutex::new(HashMap::new()));
    let pending_elicitations: Arc<Mutex<HashMap<String, oneshot::Sender<serde_json::Value>>>> =
        Arc::new(Mutex::new(HashMap::new()));
    let terminals: Arc<Mutex<HashMap<String, TerminalHandle>>> =
        Arc::new(Mutex::new(HashMap::new()));
    let terminal_counter = Arc::new(AtomicU64::new(0));

    // 4. Channels: commands into the connection task, readiness signal out
    let (cmd_tx, mut cmd_rx) = mpsc::channel::<SessionCommand>(16);
    let (ready_tx, ready_rx) = oneshot::channel::<Result<(Option<ProtocolSessionModelState>, PromptCapabilitiesInfo, bool, bool, bool, String), String>>();

    // 5. Clone state for builder callbacks
    let pp = Arc::clone(&pending_permissions);
    let pe = Arc::clone(&pending_elicitations);
    let terms = Arc::clone(&terminals);
    let tc = Arc::clone(&terminal_counter);
    let so = Arc::clone(&stdout);
    let sid = maestro_session_id.clone();
    let cwd_owned = cwd.to_string();
    let elicit_counter = Arc::new(AtomicU64::new(0));

    // 6. Spawn ACP connection as background task
    let task = tokio::spawn(async move {
        let _result = acp::Client
            .builder()
            .name("maestro-server")
            // --- Permission handler ---
            .on_receive_request(
                {
                    let pp = Arc::clone(&pp);
                    let so = Arc::clone(&so);
                    let sid = sid.clone();
                    move |request: RequestPermissionRequest, responder: acp::Responder<RequestPermissionResponse>, _cx: acp::ConnectionTo<acp::Agent>| {
                        let pp = pp.clone();
                        let so = so.clone();
                        let sid = sid.clone();
                        async move {

                            let request_id = request.tool_call.tool_call_id.to_string();

                            let (tx, rx) = oneshot::channel::<Option<String>>();
                            pp.lock().await.insert(request_id.clone(), tx);

                            let payload = serde_json::to_value(&request).map_err(|e| {
                                acp::Error::new(-32603, e.to_string())
                            })?;
                            let msg = MaestroRpcMessage::Response(
                                ServerResponse::PermissionRequest(MaestroPermissionRequest {
                                    session_id: sid,
                                    request_id,
                                    payload,
                                }),
                            );
                            send_response(&so, &msg).await.map_err(|e| {
                                acp::Error::new(-32603, e.to_string())
                            })?;

                            let outcome = match rx.await {
                                Ok(Some(id)) => RequestPermissionOutcome::Selected(
                                    SelectedPermissionOutcome::new(PermissionOptionId::new(id)),
                                ),
                                Ok(None) => RequestPermissionOutcome::Cancelled,
                                Err(_) => RequestPermissionOutcome::Cancelled,
                            };
                            responder.respond(RequestPermissionResponse::new(outcome))
                        }
                    }
                },
                acp::on_receive_request!(),
            )
            // --- Session notification handler ---
            .on_receive_notification(
                {
                    let so = Arc::clone(&so);
                    let sid = sid.clone();
                    move |notification: SessionNotification, _cx: acp::ConnectionTo<acp::Agent>| {
                        let so = so.clone();
                        let sid = sid.clone();
                        async move {
                            let payload = serde_json::to_value(&notification.update).map_err(|e| {
                                acp::Error::new(-32603, e.to_string())
                            })?;
                            let msg = MaestroRpcMessage::Response(
                                ServerResponse::SessionUpdate(SessionUpdate {
                                    session_id: sid,
                                    payload,
                                }),
                            );
                            send_response(&so, &msg).await.map_err(|e| {
                                acp::Error::new(-32603, e.to_string())
                            })?;
                            Ok(())
                        }
                    }
                },
                acp::on_receive_notification!(),
            )
            // --- create_terminal handler ---
            .on_receive_request(
                {
                    let terms = Arc::clone(&terms);
                    let tc = Arc::clone(&tc);
                    let so = Arc::clone(&so);
                    let sid = sid.clone();
                    move |request: CreateTerminalRequest, responder: acp::Responder<CreateTerminalResponse>, _cx: acp::ConnectionTo<acp::Agent>| {
                        let terms = terms.clone();
                        let tc = tc.clone();
                        let so = so.clone();
                        let sid = sid.clone();
                        async move {

                            let resp = handle_create_terminal(request, terms, tc, so, sid).await?;
                            responder.respond(resp)
                        }
                    }
                },
                acp::on_receive_request!(),
            )
            // --- terminal_output handler ---
            .on_receive_request(
                {
                    let terms = Arc::clone(&terms);
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
            // --- release_terminal handler ---
            .on_receive_request(
                {
                    let terms = Arc::clone(&terms);
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
            // --- wait_for_terminal_exit handler ---
            .on_receive_request(
                {
                    let terms = Arc::clone(&terms);
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
            // --- kill_terminal handler ---
            .on_receive_request(
                {
                    let terms = Arc::clone(&terms);
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
            // --- catch-all: forward elicitation/create to Tauri; reject others ---
            .on_receive_request(
                {
                    let pe = Arc::clone(&pe);
                    let so = Arc::clone(&so);
                    let sid = sid.clone();
                    let elicit_counter = Arc::clone(&elicit_counter);
                    move |request: acp::UntypedMessage, responder: acp::Responder<serde_json::Value>, _cx: acp::ConnectionTo<acp::Agent>| {
                        let pe = pe.clone();
                        let so = so.clone();
                        let sid = sid.clone();
                        let elicit_counter = elicit_counter.clone();
                        async move {
                            if request.method() == "elicitation/create" {
                                let elicitation: CreateElicitationRequest =
                                    serde_json::from_value(request.params().clone()).map_err(
                                        |e| acp::Error::new(-32602, format!("invalid elicitation request: {e}")),
                                    )?;
                                let request_id = format!("elicit-{}", elicit_counter.fetch_add(1, Ordering::Relaxed) + 1);
                                let (tx, rx) = oneshot::channel::<serde_json::Value>();
                                pe.lock().await.insert(request_id.clone(), tx);
                                let payload = request.params().clone();
                                let msg = MaestroRpcMessage::Response(
                                    ServerResponse::ElicitationRequest(MaestroElicitationRequest {
                                        session_id: sid,
                                        request_id,
                                        message: elicitation.message,
                                        payload,
                                    }),
                                );
                                send_response(&so, &msg).await.map_err(|e| {
                                    acp::Error::new(-32603, e.to_string())
                                })?;
                                let response = rx.await.map_err(|_| {
                                    acp::Error::new(-32603, "elicitation channel closed")
                                })?;
                                let _validated: CreateElicitationResponse =
                                    serde_json::from_value(response.clone()).map_err(|e| {
                                        acp::Error::new(-32603, format!("invalid elicitation response: {e}"))
                                    })?;
                                responder.respond(response)
                            } else {
                                responder.respond_with_error(
                                    acp::Error::method_not_found().data(request.method().to_string())
                                )
                            }
                        }
                    }
                },
                acp::on_receive_request!(),
            )
            // --- Connect and run ---
            .connect_with(transport, async move |cx: acp::ConnectionTo<acp::Agent>| {
                // Initialize ACP connection
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
                let prompt_caps = PromptCapabilitiesInfo {
                    embedded_context: init_response.agent_capabilities.prompt_capabilities.embedded_context,
                    image: init_response.agent_capabilities.prompt_capabilities.image,
                    audio: init_response.agent_capabilities.prompt_capabilities.audio,
                };
                let supports_list = init_response.agent_capabilities.session_capabilities.list.is_some();
                let supports_load = init_response.agent_capabilities.load_session;
                let supports_close = supports_list;

                // Create ACP session — send request manually to capture models before attach
                let session_req = NewSessionRequest::new(std::path::PathBuf::from(&cwd_owned));
                let session_response = match cx.send_request(session_req).block_task().await {
                    Ok(r) => r,
                    Err(e) => {
                        let _ = ready_tx.send(Err(format!("ACP new_session failed: {}", e)));
                        return Ok(());
                    }
                };
                let models = convert_acp_models(session_response.models.as_ref());
                let session = match cx.attach_session(session_response, vec![]) {
                    Ok(s) => s,
                    Err(e) => {
                        let _ = ready_tx.send(Err(format!("ACP attach_session failed: {}", e)));
                        return Ok(());
                    }
                };

                let acp_native_session_id = session.session_id().to_string();
                let _ = ready_tx.send(Ok((models, prompt_caps, supports_list, supports_load, supports_close, acp_native_session_id)));

                // Process commands from the stdin event loop
                while let Some(cmd) = cmd_rx.recv().await {
                    match cmd {
                        SessionCommand::Prompt(content) => {
                            let so = Arc::clone(&so);
                            let sid = sid.clone();
                            let result = session
                                .connection()
                                .send_request_to(
                                    acp::Agent,
                                    PromptRequest::new(
                                        session.session_id().clone(),
                                        vec![content.into()],
                                    ),
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
                            let sid = sid.clone();
                            let content_blocks: Vec<acp::schema::ContentBlock> = blocks
                                .into_iter()
                                .filter_map(|b| serde_json::from_value(b).ok())
                                .collect();
                            let result = session
                                .connection()
                                .send_request_to(
                                    acp::Agent,
                                    PromptRequest::new(
                                        session.session_id().clone(),
                                        content_blocks,
                                    ),
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
                            let _ = session.connection().send_notification(CancelNotification::new(
                                session.session_id().clone(),
                            ));
                        }
                        SessionCommand::SetModel(model_id) => {
                            let result = session
                                .connection()
                                .send_request(SetSessionModelRequest::new(
                                    session.session_id().clone(),
                                    model_id.clone(),
                                ))
                                .block_task()
                                .await;
                            let msg = match result {
                                Ok(_) => MaestroRpcMessage::Response(ServerResponse::SetModelOk(
                                    SetModelOkResponse {
                                        session_id: sid.clone(),
                                        model_id,
                                    },
                                )),
                                Err(e) => MaestroRpcMessage::Response(ServerResponse::Error(
                                    ErrorResponse {
                                        message: format!("SetModel failed: {}", e),
                                    },
                                )),
                            };
                            let _ = send_response(&so, &msg).await;
                        }
                    }
                }

                Ok(())
            })
            .await;

        // Connection ended — child killed by kill_on_drop
        drop(child);
    });

    // Wait for the connection task to signal readiness
    match ready_rx.await {
        Ok(Ok((models, prompt_caps, supports_list, supports_load, supports_close, native_session_id))) => Some(SpawnResult {
            session: ActiveSession {
                cmd_tx,
                pending_permissions,
                pending_elicitations,
                task,
            },
            models,
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
) -> Option<(ActiveSession, Option<ProtocolSessionModelState>, PromptCapabilitiesInfo)> {
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

    let pending_permissions: Arc<Mutex<HashMap<String, oneshot::Sender<Option<String>>>>> =
        Arc::new(Mutex::new(HashMap::new()));
    let pending_elicitations: Arc<Mutex<HashMap<String, oneshot::Sender<serde_json::Value>>>> =
        Arc::new(Mutex::new(HashMap::new()));
    let terminals: Arc<Mutex<HashMap<String, TerminalHandle>>> =
        Arc::new(Mutex::new(HashMap::new()));
    let terminal_counter = Arc::new(AtomicU64::new(0));

    let (cmd_tx, mut cmd_rx) = mpsc::channel::<SessionCommand>(16);
    let (ready_tx, ready_rx) = oneshot::channel::<Result<(Option<ProtocolSessionModelState>, PromptCapabilitiesInfo), String>>();

    let pp = Arc::clone(&pending_permissions);
    let pe = Arc::clone(&pending_elicitations);
    let terms = Arc::clone(&terminals);
    let tc = Arc::clone(&terminal_counter);
    let so = Arc::clone(&stdout);
    let sid = maestro_session_id.clone();
    let cwd_owned = cwd.to_string();
    let elicit_counter = Arc::new(AtomicU64::new(0));
    let load_sid = acp_session_id.clone();

    let task = tokio::spawn(async move {
        let _result = acp::Client
            .builder()
            .name("maestro-server")
            .on_receive_request(
                {
                    let pp = Arc::clone(&pp);
                    let so = Arc::clone(&so);
                    let sid = sid.clone();
                    move |request: RequestPermissionRequest, responder: acp::Responder<RequestPermissionResponse>, _cx: acp::ConnectionTo<acp::Agent>| {
                        let pp = pp.clone();
                        let so = so.clone();
                        let sid = sid.clone();
                        async move {
                            let request_id = request.tool_call.tool_call_id.to_string();
                            let (tx, rx) = oneshot::channel::<Option<String>>();
                            pp.lock().await.insert(request_id.clone(), tx);
                            let payload = serde_json::to_value(&request).map_err(|e| {
                                acp::Error::new(-32603, e.to_string())
                            })?;
                            let msg = MaestroRpcMessage::Response(
                                ServerResponse::PermissionRequest(MaestroPermissionRequest {
                                    session_id: sid,
                                    request_id,
                                    payload,
                                }),
                            );
                            send_response(&so, &msg).await.map_err(|e| {
                                acp::Error::new(-32603, e.to_string())
                            })?;
                            let outcome = match rx.await {
                                Ok(Some(id)) => RequestPermissionOutcome::Selected(
                                    SelectedPermissionOutcome::new(PermissionOptionId::new(id)),
                                ),
                                Ok(None) => RequestPermissionOutcome::Cancelled,
                                Err(_) => RequestPermissionOutcome::Cancelled,
                            };
                            responder.respond(RequestPermissionResponse::new(outcome))
                        }
                    }
                },
                acp::on_receive_request!(),
            )
            .on_receive_notification(
                {
                    let so = Arc::clone(&so);
                    let sid = sid.clone();
                    move |notification: SessionNotification, _cx: acp::ConnectionTo<acp::Agent>| {
                        let so = so.clone();
                        let sid = sid.clone();
                        async move {
                            let payload = serde_json::to_value(&notification.update).map_err(|e| {
                                acp::Error::new(-32603, e.to_string())
                            })?;
                            let msg = MaestroRpcMessage::Response(
                                ServerResponse::SessionUpdate(SessionUpdate {
                                    session_id: sid,
                                    payload,
                                }),
                            );
                            send_response(&so, &msg).await.map_err(|e| {
                                acp::Error::new(-32603, e.to_string())
                            })?;
                            Ok(())
                        }
                    }
                },
                acp::on_receive_notification!(),
            )
            .on_receive_request(
                {
                    let terms = Arc::clone(&terms);
                    let tc = Arc::clone(&tc);
                    let so = Arc::clone(&so);
                    let sid = sid.clone();
                    move |request: CreateTerminalRequest, responder: acp::Responder<CreateTerminalResponse>, _cx: acp::ConnectionTo<acp::Agent>| {
                        let terms = terms.clone();
                        let tc = tc.clone();
                        let so = so.clone();
                        let sid = sid.clone();
                        async move {
                            let resp = handle_create_terminal(request, terms, tc, so, sid).await?;
                            responder.respond(resp)
                        }
                    }
                },
                acp::on_receive_request!(),
            )
            .on_receive_request(
                {
                    let terms = Arc::clone(&terms);
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
                    let terms = Arc::clone(&terms);
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
                    let terms = Arc::clone(&terms);
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
                    let terms = Arc::clone(&terms);
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
                    let pe = Arc::clone(&pe);
                    let so = Arc::clone(&so);
                    let sid = sid.clone();
                    let elicit_counter = Arc::clone(&elicit_counter);
                    move |request: acp::UntypedMessage, responder: acp::Responder<serde_json::Value>, _cx: acp::ConnectionTo<acp::Agent>| {
                        let pe = pe.clone();
                        let so = so.clone();
                        let sid = sid.clone();
                        let elicit_counter = elicit_counter.clone();
                        async move {
                            if request.method() == "elicitation/create" {
                                let elicitation: CreateElicitationRequest =
                                    serde_json::from_value(request.params().clone()).map_err(
                                        |e| acp::Error::new(-32602, format!("invalid elicitation request: {e}")),
                                    )?;
                                let request_id = format!("elicit-{}", elicit_counter.fetch_add(1, Ordering::Relaxed) + 1);
                                let (tx, rx) = oneshot::channel::<serde_json::Value>();
                                pe.lock().await.insert(request_id.clone(), tx);
                                let payload = request.params().clone();
                                let msg = MaestroRpcMessage::Response(
                                    ServerResponse::ElicitationRequest(MaestroElicitationRequest {
                                        session_id: sid,
                                        request_id,
                                        message: elicitation.message,
                                        payload,
                                    }),
                                );
                                send_response(&so, &msg).await.map_err(|e| {
                                    acp::Error::new(-32603, e.to_string())
                                })?;
                                let response = rx.await.map_err(|_| {
                                    acp::Error::new(-32603, "elicitation channel closed")
                                })?;
                                let _validated: CreateElicitationResponse =
                                    serde_json::from_value(response.clone()).map_err(|e| {
                                        acp::Error::new(-32603, format!("invalid elicitation response: {e}"))
                                    })?;
                                responder.respond(response)
                            } else {
                                responder.respond_with_error(
                                    acp::Error::method_not_found().data(request.method().to_string())
                                )
                            }
                        }
                    }
                },
                acp::on_receive_request!(),
            )
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
                let prompt_caps = PromptCapabilitiesInfo {
                    embedded_context: init_response.agent_capabilities.prompt_capabilities.embedded_context,
                    image: init_response.agent_capabilities.prompt_capabilities.image,
                    audio: init_response.agent_capabilities.prompt_capabilities.audio,
                };

                let load_req = LoadSessionRequest::new(load_sid.clone(), std::path::PathBuf::from(&cwd_owned));
                let load_response = match cx.send_request(load_req).block_task().await {
                    Ok(r) => r,
                    Err(e) => {
                        let _ = ready_tx.send(Err(format!("ACP session/load failed: {}", e)));
                        return Ok(());
                    }
                };
                let models = convert_acp_models(load_response.models.as_ref());
                let _ = ready_tx.send(Ok((models, prompt_caps)));

                // Process commands — use explicit session_id for prompts
                let session_id = acp::schema::SessionId::new(load_sid);
                while let Some(cmd) = cmd_rx.recv().await {
                    match cmd {
                        SessionCommand::Prompt(content) => {
                            let so = Arc::clone(&so);
                            let sid = sid.clone();
                            let result = cx
                                .send_request_to(
                                    acp::Agent,
                                    PromptRequest::new(
                                        session_id.clone(),
                                        vec![content.into()],
                                    ),
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
                            let sid = sid.clone();
                            let content_blocks: Vec<acp::schema::ContentBlock> = blocks
                                .into_iter()
                                .filter_map(|b| serde_json::from_value(b).ok())
                                .collect();
                            let result = cx
                                .send_request_to(
                                    acp::Agent,
                                    PromptRequest::new(
                                        session_id.clone(),
                                        content_blocks,
                                    ),
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
                            let _ = cx.send_notification(CancelNotification::new(
                                session_id.clone(),
                            ));
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
                                        session_id: sid.clone(),
                                        model_id,
                                    },
                                )),
                                Err(e) => MaestroRpcMessage::Response(ServerResponse::Error(
                                    ErrorResponse {
                                        message: format!("SetModel failed: {}", e),
                                    },
                                )),
                            };
                            let _ = send_response(&so, &msg).await;
                        }
                    }
                }

                Ok(())
            })
            .await;

        drop(child);
    });

    match ready_rx.await {
        Ok(Ok((models, prompt_caps))) => Some((
            ActiveSession {
                cmd_tx,
                pending_permissions,
                pending_elicitations,
                task,
            },
            models,
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
