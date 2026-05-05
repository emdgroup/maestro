//! Maestro Remote Server
//!
//! Headless binary that runs on remote SSH hosts. Receives MaestroRpcMessage
//! commands from the local Maestro desktop app over stdin/stdout (piped through
//! SSH exec channel), spawns ACP agents as local subprocesses, and forwards
//! structured session updates back.
//!
//! Architecture: Adapted from Zed's remote_server (GPL-3.0).

mod agent;
mod registry;
mod sessions;

#[cfg(test)]
mod tests;

use std::collections::HashMap;
use std::process::Stdio;
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
    SetSessionModelRequest, StopReason, TerminalExitStatus, TerminalId, TerminalOutputRequest,
    TerminalOutputResponse, WaitForTerminalExitRequest, WaitForTerminalExitResponse,
};
use maestro_protocol::{
    read_message, AcpRegistry, DiscoveredAgent, ErrorResponse, FileReadRequest, FileReadResponse,
    FileSearchRequest, FileSearchResponse, HandshakeResponse, ListAgentsResponse, MaestroRpcMessage,
    ModelInfo as ProtocolModelInfo, PermissionRequest as MaestroPermissionRequest,
    ElicitationRequest as MaestroElicitationRequest, PromptCapabilitiesInfo, PROTOCOL_VERSION,
    ServerRequest, ServerResponse, SessionListEntry, SessionListOkResponse, SessionLoadOkResponse,
    SessionModelState as ProtocolSessionModelState, SessionUpdate,
    SetModelOkResponse, SpawnResponse, TerminalOutput, TurnEnded,
};
use ignore::WalkBuilder;
use tokio::io::AsyncWriteExt;
use tokio::sync::{mpsc, oneshot, Mutex, Notify};
use tokio_util::compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt};

use sessions::{ActiveSession, SessionCommand, SessionMap, TerminalExitInfo, TerminalHandle};

/// Send a MaestroRpcMessage to stdout, flushing after every write.
async fn send_response(
    stdout: &Arc<Mutex<tokio::io::Stdout>>,
    msg: &MaestroRpcMessage,
) -> Result<(), Box<dyn std::error::Error>> {
    let mut buf: Vec<u8> = Vec::new();
    maestro_protocol::write_message(&mut buf, msg).await?;
    let mut out = stdout.lock().await;
    out.write_all(&buf).await?;
    out.flush().await?;
    Ok(())
}

/// Truncate `buf` from the beginning to at most `limit` bytes, on a UTF-8 char boundary.
fn truncate_buf(buf: &mut String, limit: usize) {
    if buf.len() > limit {
        let excess = buf.len() - limit;
        let safe_pos = buf
            .char_indices()
            .map(|(i, _)| i)
            .find(|&i| i >= excess)
            .unwrap_or(buf.len());
        *buf = buf[safe_pos..].to_string();
    }
}

fn fuzzy_score(path: &str, query_lower: &str) -> i64 {
    if query_lower.is_empty() {
        let depth = path.chars().filter(|c| *c == '/').count();
        return 1000 - depth as i64;
    }

    let path_lower = path.to_lowercase();
    let basename_lower = path_lower.rsplit('/').next().unwrap_or(&path_lower);

    let mut score: i64 = 0;

    if basename_lower == query_lower {
        score += 100;
    } else if basename_lower.starts_with(query_lower) {
        score += 50;
    } else if basename_lower.contains(query_lower) {
        score += 30;
    } else if path_lower.contains(query_lower) {
        score += 20;
    } else {
        let mut chars = path_lower.chars().peekable();
        let mut matched = 0i64;
        for qc in query_lower.chars() {
            let mut found = false;
            while let Some(&hc) = chars.peek() {
                chars.next();
                if hc == qc {
                    matched += 1;
                    found = true;
                    break;
                }
            }
            if !found {
                return 0;
            }
        }
        score += matched;
    }

    score -= (path.len() as i64) / 10;
    score.max(1)
}

fn handle_file_search(req: FileSearchRequest) -> Result<Vec<String>, String> {
    let limit = req.limit.unwrap_or(50) as usize;
    let root = std::path::Path::new(&req.cwd);
    if !root.is_dir() {
        return Err(format!("Not a directory: {}", req.cwd));
    }

    let query_lower = req.query.to_lowercase();
    let mut results: Vec<(i64, String)> = Vec::new();

    let walker = WalkBuilder::new(root)
        .hidden(false)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .max_depth(Some(20))
        .build();

    for entry in walker.flatten() {
        let file_type = entry.file_type();
        if !file_type.map(|ft| ft.is_file()).unwrap_or(false) {
            continue;
        }
        let rel_path = match entry.path().strip_prefix(root) {
            Ok(p) => p.to_string_lossy().into_owned(),
            Err(_) => continue,
        };

        let score = fuzzy_score(&rel_path, &query_lower);
        if score > 0 {
            results.push((score, rel_path));
        }
    }

    results.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    results.truncate(limit);
    Ok(results.into_iter().map(|(_, p)| p).collect())
}

async fn handle_prompt_result(
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

async fn handle_file_read(req: &FileReadRequest) -> Result<String, String> {
    let rel = std::path::Path::new(&req.relative_path);
    if rel.is_absolute() {
        return Err("relative_path must not be absolute".to_string());
    }
    for component in rel.components() {
        if matches!(component, std::path::Component::ParentDir) {
            return Err("relative_path must not contain '..' segments".to_string());
        }
    }

    let full_path = std::path::Path::new(&req.cwd).join(rel);
    let canonical = full_path
        .canonicalize()
        .map_err(|e| format!("File not found: {e}"))?;
    let canonical_root = std::path::Path::new(&req.cwd)
        .canonicalize()
        .map_err(|e| format!("Invalid cwd: {e}"))?;
    if !canonical.starts_with(&canonical_root) {
        return Err("Path escapes project root".to_string());
    }

    let metadata = tokio::fs::metadata(&canonical)
        .await
        .map_err(|e| format!("Cannot stat file: {e}"))?;
    if metadata.len() > 1_048_576 {
        return Err("File too large (>1MB)".to_string());
    }

    tokio::fs::read_to_string(&canonical)
        .await
        .map_err(|e| format!("Cannot read file: {e}"))
}

async fn ensure_agent_cache(
    cache: &mut Option<(std::time::Instant, Vec<registry::DiscoveredAgentWithSpawn>)>,
    ttl: std::time::Duration,
    reg: &AcpRegistry,
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

fn convert_acp_models(
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
struct SpawnResult {
    session: ActiveSession,
    models: Option<ProtocolSessionModelState>,
    prompt_capabilities: PromptCapabilitiesInfo,
    supports_session_list: bool,
    supports_session_load: bool,
    supports_session_close: bool,
    acp_session_id: String,
}

async fn spawn_acp_session(
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
                                let request_id = format!("elicit-{}", elicit_counter.fetch_add(1, Ordering::Relaxed) + 1);
                                let (tx, rx) = oneshot::channel::<serde_json::Value>();
                                pe.lock().await.insert(request_id.clone(), tx);
                                let payload = request.params().clone();
                                let msg = MaestroRpcMessage::Response(
                                    ServerResponse::ElicitationRequest(MaestroElicitationRequest {
                                        session_id: sid,
                                        request_id,
                                        payload,
                                    }),
                                );
                                send_response(&so, &msg).await.map_err(|e| {
                                    acp::Error::new(-32603, e.to_string())
                                })?;
                                let response = rx.await.map_err(|_| {
                                    acp::Error::new(-32603, "elicitation channel closed")
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
                            .client_capabilities(ClientCapabilities::new().terminal(true)),
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

async fn load_acp_session(
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
                                let request_id = format!("elicit-{}", elicit_counter.fetch_add(1, Ordering::Relaxed) + 1);
                                let (tx, rx) = oneshot::channel::<serde_json::Value>();
                                pe.lock().await.insert(request_id.clone(), tx);
                                let payload = request.params().clone();
                                let msg = MaestroRpcMessage::Response(
                                    ServerResponse::ElicitationRequest(MaestroElicitationRequest {
                                        session_id: sid,
                                        request_id,
                                        payload,
                                    }),
                                );
                                send_response(&so, &msg).await.map_err(|e| {
                                    acp::Error::new(-32603, e.to_string())
                                })?;
                                let response = rx.await.map_err(|_| {
                                    acp::Error::new(-32603, "elicitation channel closed")
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
                            .client_capabilities(ClientCapabilities::new().terminal(true)),
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

async fn run_session_list(
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

async fn run_session_close(
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

/// Handle create_terminal request: spawn subprocess, set up background reader.
async fn handle_create_terminal(
    args: CreateTerminalRequest,
    terminals: Arc<Mutex<HashMap<String, TerminalHandle>>>,
    terminal_counter: Arc<AtomicU64>,
    stdout: Arc<Mutex<tokio::io::Stdout>>,
    maestro_session_id: String,
) -> acp::Result<CreateTerminalResponse> {
    // T-42-01: Validate cwd exists before spawning
    if let Some(ref cwd) = args.cwd {
        for component in cwd.components() {
            if component == std::path::Component::ParentDir {
                return Err(acp::Error::new(
                    -32603,
                    format!("cwd contains '..' component: {}", cwd.display()),
                ));
            }
        }
        match tokio::fs::metadata(cwd).await {
            Ok(meta) if meta.is_dir() => {}
            Ok(_) => {
                return Err(acp::Error::new(
                    -32603,
                    format!("cwd is not a directory: {}", cwd.display()),
                ));
            }
            Err(e) => {
                return Err(acp::Error::new(
                    -32603,
                    format!("cwd does not exist: {}: {}", cwd.display(), e),
                ));
            }
        }
    }

    let terminal_id = format!("term-{}", terminal_counter.fetch_add(1, Ordering::Relaxed) + 1);

    // T-42-02: Use Command::new(program).args(args) — never shell strings
    let mut cmd = tokio::process::Command::new(&args.command);
    cmd.args(&args.args);
    if let Some(ref cwd) = args.cwd {
        cmd.current_dir(cwd);
    }
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    cmd.kill_on_drop(true);

    let mut child = cmd
        .spawn()
        .map_err(|e| acp::Error::new(-32603, e.to_string()))?;

    let stdout_pipe = child.stdout.take();
    let stderr_pipe = child.stderr.take();

    let output_buf: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
    let exit_status: Arc<Mutex<Option<TerminalExitInfo>>> = Arc::new(Mutex::new(None));
    let exit_notify: Arc<Notify> = Arc::new(Notify::new());
    let (kill_tx, kill_rx) = oneshot::channel::<()>();

    let output_buf_bg = Arc::clone(&output_buf);
    let exit_status_bg = Arc::clone(&exit_status);
    let exit_notify_bg = Arc::clone(&exit_notify);
    let stdout_bg = Arc::clone(&stdout);
    let terminal_id_bg = terminal_id.clone();
    let output_byte_limit = args.output_byte_limit;

    // Background reader task — streams terminal output to stdout
    tokio::spawn(async move {
        use tokio::io::{AsyncBufReadExt, BufReader};

        let (line_tx, mut line_rx) = mpsc::channel::<String>(32);

        if let Some(pipe) = stdout_pipe {
            let tx = line_tx.clone();
            tokio::spawn(async move {
                let mut reader = BufReader::new(pipe).lines();
                while let Ok(Some(line)) = reader.next_line().await {
                    if tx.send(line).await.is_err() {
                        break;
                    }
                }
            });
        }

        if let Some(pipe) = stderr_pipe {
            let tx = line_tx.clone();
            tokio::spawn(async move {
                let mut reader = BufReader::new(pipe).lines();
                while let Ok(Some(line)) = reader.next_line().await {
                    if tx.send(line).await.is_err() {
                        break;
                    }
                }
            });
        }

        drop(line_tx);

        let mut kill_rx = kill_rx;
        let killed = loop {
            tokio::select! {
                biased;
                _ = &mut kill_rx => break true,
                item = line_rx.recv() => {
                    match item {
                        Some(line) => {
                            let chunk = format!("{}\n", line);
                            // T-42-03: Respect output_byte_limit — truncate from beginning
                            {
                                let mut buf = output_buf_bg.lock().await;
                                buf.push_str(&chunk);
                                if let Some(limit) = output_byte_limit {
                                    truncate_buf(&mut buf, limit as usize);
                                }
                            }
                            let msg = MaestroRpcMessage::Response(
                                ServerResponse::TerminalOutput(TerminalOutput {
                                    session_id: maestro_session_id.clone(),
                                    terminal_id: terminal_id_bg.clone(),
                                    bytes: chunk.into_bytes(),
                                }),
                            );
                            let _ = send_response(&stdout_bg, &msg).await;
                        }
                        None => break false,
                    }
                }
            }
        };

        if killed {
            let _ = child.start_kill();
        }

        let exit_info = match child.wait().await {
            Ok(status) => {
                let exit_code = status.code().map(|c| c as u32);
                #[cfg(unix)]
                let signal = {
                    use std::os::unix::process::ExitStatusExt;
                    status.signal().map(|s| format!("SIG{}", s))
                };
                #[cfg(not(unix))]
                let signal: Option<String> = None;
                TerminalExitInfo { exit_code, signal }
            }
            Err(_) => TerminalExitInfo {
                exit_code: None,
                signal: None,
            },
        };

        *exit_status_bg.lock().await = Some(exit_info);
        exit_notify_bg.notify_one();
    });

    let handle = TerminalHandle {
        output_buf,
        output_byte_limit: args.output_byte_limit,
        exit_status,
        exit_notify,
        kill_tx: Mutex::new(Some(kill_tx)),
    };
    terminals.lock().await.insert(terminal_id.clone(), handle);

    Ok(CreateTerminalResponse::new(TerminalId::new(&*terminal_id)))
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let stdout: Arc<Mutex<tokio::io::Stdout>> = Arc::new(Mutex::new(tokio::io::stdout()));
    let mut stdin = tokio::io::stdin();
    let mut sessions: SessionMap = HashMap::new();
    let mut agent_cache: Option<(std::time::Instant, Vec<registry::DiscoveredAgentWithSpawn>)> =
        None;
    const CACHE_TTL: std::time::Duration = std::time::Duration::from_secs(300);

    let registry: AcpRegistry = tokio::task::spawn_blocking(registry::load_registry)
        .await
        .unwrap_or_else(|_| registry::parse_backup_registry());

    // Validate the protocol version handshake before entering the main dispatch loop.
    let first_msg = match read_message(&mut stdin).await {
        Ok(msg) => msg,
        Err(_) => return Ok(()),
    };
    match first_msg {
        MaestroRpcMessage::Request(ServerRequest::Handshake(req)) => {
            if req.protocol_version != PROTOCOL_VERSION {
                let _ = send_response(
                    &stdout,
                    &MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
                        message: format!(
                            "protocol version mismatch: server={}, client={}",
                            PROTOCOL_VERSION, req.protocol_version
                        ),
                    })),
                )
                .await;
                return Ok(());
            }
            let _ = send_response(
                &stdout,
                &MaestroRpcMessage::Response(ServerResponse::HandshakeOk(HandshakeResponse {
                    protocol_version: PROTOCOL_VERSION,
                })),
            )
            .await;
        }
        _ => {
            let _ = send_response(
                &stdout,
                &MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
                    message: "expected Handshake as first message".to_string(),
                })),
            )
            .await;
            return Ok(());
        }
    }

    loop {
        let msg = match read_message(&mut stdin).await {
            Ok(msg) => msg,
            Err(e) => {
                let is_eof = e
                    .downcast_ref::<std::io::Error>()
                    .map(|io_err| io_err.kind() == std::io::ErrorKind::UnexpectedEof)
                    .unwrap_or_else(|| {
                        let s = e.to_string();
                        s.contains("early eof")
                            || s.contains("unexpected eof")
                            || s.contains("UnexpectedEof")
                    });
                if is_eof {
                    break;
                }
                let _ = send_response(
                    &stdout,
                    &MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
                        message: format!("read error: {}", e),
                    })),
                )
                .await;
                continue;
            }
        };

        match msg {
            MaestroRpcMessage::Request(ServerRequest::ListAgents(_req)) => {
                let agents_with_spawn =
                    ensure_agent_cache(&mut agent_cache, CACHE_TTL, &registry).await;
                let agents: Vec<DiscoveredAgent> = agents_with_spawn
                    .iter()
                    .map(|a| DiscoveredAgent {
                        id: a.id.clone(),
                        name: a.name.clone(),
                        icon: a.icon.clone(),
                    })
                    .collect();
                let _ = send_response(
                    &stdout,
                    &MaestroRpcMessage::Response(ServerResponse::ListAgentsOk(
                        ListAgentsResponse { agents },
                    )),
                )
                .await;
            }

            MaestroRpcMessage::Request(ServerRequest::Spawn(req)) => {
                let agents_with_spawn =
                    ensure_agent_cache(&mut agent_cache, CACHE_TTL, &registry).await;
                let (spawn_cmd, spawn_args_owned, spawn_env) = match agents_with_spawn
                    .iter()
                    .find(|a| a.id == req.agent_id)
                {
                    Some(a) => (a.spawn_cmd.clone(), a.spawn_args.clone(), a.spawn_env.clone()),
                    None => {
                        let _ = send_response(
                            &stdout,
                            &MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
                                message: format!("Unknown agent: {}", req.agent_id),
                            })),
                        )
                        .await;
                        continue;
                    }
                };

                match spawn_acp_session(
                    &spawn_cmd,
                    &spawn_args_owned,
                    &spawn_env,
                    &req.cwd,
                    req.session_id.clone(),
                    Arc::clone(&stdout),
                )
                .await
                {
                    Some(result) => {
                        let response = SpawnResponse {
                            session_id: req.session_id.clone(),
                            acp_session_id: Some(result.acp_session_id),
                            models: result.models,
                            prompt_capabilities: Some(result.prompt_capabilities),
                            supports_session_list: result.supports_session_list,
                            supports_session_load: result.supports_session_load,
                            supports_session_close: result.supports_session_close,
                        };
                        sessions.insert(req.session_id, result.session);
                        let _ = send_response(
                            &stdout,
                            &MaestroRpcMessage::Response(ServerResponse::SpawnOk(response)),
                        )
                        .await;
                    }
                    None => {
                        // Error already sent by spawn_acp_session
                    }
                }
            }

            MaestroRpcMessage::Request(ServerRequest::Prompt(req)) => {
                if let Some(session) = sessions.get(&req.session_id) {
                    let sent_at = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis() as u64;
                    let _ = send_response(
                        &stdout,
                        &MaestroRpcMessage::Response(ServerResponse::SessionUpdate(SessionUpdate {
                            session_id: req.session_id.clone(),
                            payload: serde_json::json!({
                                "sessionUpdate": "user_message",
                                "content": req.content,
                                "sentAt": sent_at,
                            }),
                        })),
                    )
                    .await;
                    let cmd = match req.content {
                        serde_json::Value::Array(blocks) => {
                            SessionCommand::PromptStructured(blocks)
                        }
                        other => {
                            SessionCommand::Prompt(other.as_str().unwrap_or("").to_string())
                        }
                    };
                    if session.cmd_tx.send(cmd).await.is_err() {
                        let _ = send_response(
                            &stdout,
                            &MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
                                message: format!(
                                    "session {} connection closed",
                                    req.session_id
                                ),
                            })),
                        )
                        .await;
                    }
                } else {
                    let _ = send_response(
                        &stdout,
                        &MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
                            message: format!("unknown session: {}", req.session_id),
                        })),
                    )
                    .await;
                }
            }

            MaestroRpcMessage::Request(ServerRequest::Cancel(req)) => {
                // Drop session — cmd_tx drop causes the connection task to exit,
                // which drops child (kill_on_drop)
                if let Some(session) = sessions.remove(&req.session_id) {
                    session.task.abort();
                }
            }

            MaestroRpcMessage::Request(ServerRequest::InterruptTurn(req)) => {
                if let Some(session) = sessions.get(&req.session_id) {
                    let _ = session.cmd_tx.send(SessionCommand::CancelTurn).await;
                }
            }

            MaestroRpcMessage::Request(ServerRequest::PermitResponse(perm_resp)) => {
                if let Some(session) = sessions.get(&perm_resp.session_id) {
                    if let Some(tx) = session
                        .pending_permissions
                        .lock()
                        .await
                        .remove(&perm_resp.request_id)
                    {
                        let _ = tx.send(perm_resp.option_id);
                    }
                }
            }

            MaestroRpcMessage::Request(ServerRequest::ElicitationResponse(elicit_resp)) => {
                if let Some(session) = sessions.get(&elicit_resp.session_id) {
                    if let Some(tx) = session
                        .pending_elicitations
                        .lock()
                        .await
                        .remove(&elicit_resp.request_id)
                    {
                        let _ = tx.send(elicit_resp.response);
                    }
                }
            }

            MaestroRpcMessage::Request(ServerRequest::SetModel(set_model_req)) => {
                if let Some(session) = sessions.get(&set_model_req.session_id) {
                    if session
                        .cmd_tx
                        .send(SessionCommand::SetModel(set_model_req.model_id))
                        .await
                        .is_err()
                    {
                        let _ = send_response(
                            &stdout,
                            &MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
                                message: format!(
                                    "session {} connection closed",
                                    set_model_req.session_id
                                ),
                            })),
                        )
                        .await;
                    }
                } else {
                    let _ = send_response(
                        &stdout,
                        &MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
                            message: format!("unknown session: {}", set_model_req.session_id),
                        })),
                    )
                    .await;
                }
            }

            MaestroRpcMessage::Request(ServerRequest::FileSearch(req)) => {
                let result = tokio::task::spawn_blocking(move || handle_file_search(req))
                    .await
                    .unwrap_or_else(|e| Err(format!("spawn_blocking: {}", e)));
                let response = match result {
                    Ok(files) => MaestroRpcMessage::Response(ServerResponse::FileSearchOk(
                        FileSearchResponse { files },
                    )),
                    Err(msg) => MaestroRpcMessage::Response(ServerResponse::Error(
                        ErrorResponse { message: msg },
                    )),
                };
                let _ = send_response(&stdout, &response).await;
            }

            MaestroRpcMessage::Request(ServerRequest::FileRead(req)) => {
                let result = handle_file_read(&req).await;
                let response = match result {
                    Ok(content) => MaestroRpcMessage::Response(ServerResponse::FileReadOk(
                        FileReadResponse { content },
                    )),
                    Err(msg) => MaestroRpcMessage::Response(ServerResponse::Error(
                        ErrorResponse { message: msg },
                    )),
                };
                let _ = send_response(&stdout, &response).await;
            }

            MaestroRpcMessage::Request(ServerRequest::SessionList(req)) => {
                let agents_with_spawn =
                    ensure_agent_cache(&mut agent_cache, CACHE_TTL, &registry).await;
                let (spawn_cmd, spawn_args_owned, spawn_env) = match agents_with_spawn
                    .iter()
                    .find(|a| a.id == req.agent_id)
                {
                    Some(a) => (a.spawn_cmd.clone(), a.spawn_args.clone(), a.spawn_env.clone()),
                    None => {
                        let _ = send_response(
                            &stdout,
                            &MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
                                message: format!("Unknown agent: {}", req.agent_id),
                            })),
                        )
                        .await;
                        continue;
                    }
                };
                match run_session_list(&spawn_cmd, &spawn_args_owned, &spawn_env, &req.cwd, req.cursor).await {
                    Ok((sessions_list, next_cursor)) => {
                        let _ = send_response(
                            &stdout,
                            &MaestroRpcMessage::Response(ServerResponse::SessionListOk(
                                SessionListOkResponse { sessions: sessions_list, next_cursor },
                            )),
                        )
                        .await;
                    }
                    Err(e) => {
                        let _ = send_response(
                            &stdout,
                            &MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
                                message: e,
                            })),
                        )
                        .await;
                    }
                }
            }

            MaestroRpcMessage::Request(ServerRequest::SessionLoad(req)) => {
                let agents_with_spawn =
                    ensure_agent_cache(&mut agent_cache, CACHE_TTL, &registry).await;
                let (spawn_cmd, spawn_args_owned, spawn_env) = match agents_with_spawn
                    .iter()
                    .find(|a| a.id == req.agent_id)
                {
                    Some(a) => (a.spawn_cmd.clone(), a.spawn_args.clone(), a.spawn_env.clone()),
                    None => {
                        let _ = send_response(
                            &stdout,
                            &MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
                                message: format!("Unknown agent: {}", req.agent_id),
                            })),
                        )
                        .await;
                        continue;
                    }
                };
                match load_acp_session(
                    &spawn_cmd,
                    &spawn_args_owned,
                    &spawn_env,
                    &req.cwd,
                    req.resume_session_id.clone(),
                    req.session_id.clone(),
                    Arc::clone(&stdout),
                )
                .await
                {
                    Some((session, models, prompt_caps)) => {
                        sessions.insert(req.session_id.clone(), session);
                        let _ = send_response(
                            &stdout,
                            &MaestroRpcMessage::Response(ServerResponse::SessionLoadOk(
                                SessionLoadOkResponse {
                                    session_id: req.session_id.clone(),
                                    models,
                                    prompt_capabilities: Some(prompt_caps),
                                },
                            )),
                        )
                        .await;
                    }
                    None => {
                        // Error already sent by load_acp_session
                    }
                }
            }

            MaestroRpcMessage::Request(ServerRequest::SessionClose(req)) => {
                let agents_with_spawn =
                    ensure_agent_cache(&mut agent_cache, CACHE_TTL, &registry).await;
                let (spawn_cmd, spawn_args_owned, spawn_env) = match agents_with_spawn
                    .iter()
                    .find(|a| a.id == req.agent_id)
                {
                    Some(a) => (a.spawn_cmd.clone(), a.spawn_args.clone(), a.spawn_env.clone()),
                    None => {
                        let _ = send_response(
                            &stdout,
                            &MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
                                message: format!("Unknown agent: {}", req.agent_id),
                            })),
                        )
                        .await;
                        continue;
                    }
                };
                match run_session_close(&spawn_cmd, &spawn_args_owned, &spawn_env, &req.cwd, req.session_id).await {
                    Ok(()) => {
                        let _ = send_response(
                            &stdout,
                            &MaestroRpcMessage::Response(ServerResponse::SessionCloseOk),
                        )
                        .await;
                    }
                    Err(e) => {
                        let _ = send_response(
                            &stdout,
                            &MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
                                message: e,
                            })),
                        )
                        .await;
                    }
                }
            }

            MaestroRpcMessage::Request(ServerRequest::Handshake(_)) => {
                let _ = send_response(
                    &stdout,
                    &MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
                        message: "unexpected Handshake after initialization".to_string(),
                    })),
                )
                .await;
            }

            MaestroRpcMessage::Response(_) => {}
        }
    }

    Ok(())
}
