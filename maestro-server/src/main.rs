#![cfg_attr(all(not(debug_assertions), target_os = "windows"), windows_subsystem = "windows")]
//! Maestro Remote Server
//!
//! Headless binary that runs on remote SSH hosts. Receives MaestroRpcMessage
//! commands from the local Maestro desktop app over stdin/stdout (piped through
//! SSH exec channel), spawns ACP agents as local subprocesses, and forwards
//! structured session updates back.
//!
//! Architecture: Adapted from Zed's remote_server (GPL-3.0).

mod agent;
mod command_ext;
mod file_ops;
mod session;
mod sessions;
mod terminal;
mod validate_canvas;

#[cfg(test)]
mod tests;

use std::collections::HashMap;
use std::sync::Arc;

use maestro_protocol::{
    AcpRegistry, CheckToolsResponse, DiagnosticPayload,
    DiscoveredAgent, ErrorResponse, FileReadResponse, FileSearchResponse, HandshakeResponse,
    ListAgentsResponse, MaestroRpcMessage, PreInitializeResponse, PROTOCOL_VERSION, ServerRequest,
    ServerResponse, SessionListOkResponse, SessionLoadOkResponse, SessionUpdate, SpawnResponse,
    ToolCheckResult, TurnEnded,
};
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;

pub(crate) type DiagSender = tokio::sync::mpsc::UnboundedSender<DiagnosticPayload>;

static DIAG_TX: std::sync::OnceLock<DiagSender> = std::sync::OnceLock::new();

/// Send a diagnostic event to Tauri. No-op until the main loop is running.
pub(crate) fn send_diag(level: &str, msg: impl Into<String>) {
    if let Some(tx) = DIAG_TX.get() {
        let _ = tx.send(DiagnosticPayload { level: level.into(), message: msg.into() });
    }
}

use file_ops::{handle_file_read, handle_file_search};
use session::{
    create_session_on_connection, load_session_on_connection,
    pre_initialize_agent, session_close_on_connection, session_list_on_connection,
};
use sessions::{AgentConnectionMap, SessionCommand, SessionMap};

async fn resolve_agent_spawn_params(
    agent_id: &str,
    agents: &[agent::registry::DiscoveredAgentWithSpawn],
    stdout: &Arc<Mutex<tokio::io::Stdout>>,
) -> Option<(String, Vec<String>, std::collections::HashMap<String, String>)> {
    match agents.iter().find(|a| a.id == agent_id) {
        Some(a) => {
            send_diag("info", format!("[spawn] resolved agent_id={agent_id:?} cmd={:?} args={:?}", a.spawn_cmd, a.spawn_args));
            Some((a.spawn_cmd.clone(), a.spawn_args.clone(), a.spawn_env.clone()))
        }
        None => {
            send_diag("error", format!("[spawn] agent not found: {agent_id:?}"));
            let _ = send_response(
                stdout,
                &MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
                    message: format!("Unknown agent: {}", agent_id),
                })),
            )
            .await;
            None
        }
    }
}

/// Ensures an `AgentConnection` exists for `agent_id`, initializing one if needed.
/// Returns `true` if a connection is available (existing or newly created).
/// Returns `false` if initialization failed (error already sent to stdout).
async fn ensure_agent_connection(
    agent_id: &str,
    agent_connections: &mut AgentConnectionMap,
    agents_with_spawn: &[agent::registry::DiscoveredAgentWithSpawn],
    cwd: &str,
    stdout: &Arc<Mutex<tokio::io::Stdout>>,
) -> bool {
    if agent_connections.contains_key(agent_id) {
        return true;
    }
    let Some((cmd, args, env)) = resolve_agent_spawn_params(agent_id, agents_with_spawn, stdout).await
    else { return false; };
    match pre_initialize_agent(&cmd, &args, &env, cwd, Arc::clone(stdout)).await {
        Some(conn) => {
            agent_connections.insert(agent_id.to_string(), conn);
            true
        }
        None => false,
    }
}

/// Send a MaestroRpcMessage to stdout, flushing after every write.
pub(crate) async fn send_response(
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

/// Forward a command to an active session. Returns `Err` only if stdout write fails.
/// Sends an error response to stdout if the session is not found or its channel is closed.
async fn forward_to_session(
    sessions: &SessionMap,
    session_id: &str,
    cmd: SessionCommand,
    stdout: &Arc<Mutex<tokio::io::Stdout>>,
) -> Result<(), Box<dyn std::error::Error>> {
    if let Some(session) = sessions.get(session_id) {
        if session.cmd_tx.send(cmd).await.is_err() {
            send_response(
                stdout,
                &MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
                    message: format!("session {} connection closed", session_id),
                })),
            )
            .await?;
        }
    } else {
        send_response(
            stdout,
            &MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
                message: format!("unknown session: {}", session_id),
            })),
        )
        .await?;
    }
    Ok(())
}

fn main() {
    if std::env::args().any(|a| a == "--protocol-version") {
        println!("{}", PROTOCOL_VERSION);
        return;
    }
    if std::env::args().any(|a| a == "--app-version") {
        println!("{}", env!("CARGO_PKG_VERSION"));
        return;
    }
    if std::env::args().nth(1).as_deref() == Some("validate-canvas") {
        std::process::exit(validate_canvas::run());
    }
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("Failed to build tokio runtime")
        .block_on(async_main())
        .expect("maestro-server fatal error");
}

async fn async_main() -> Result<(), Box<dyn std::error::Error>> {
    let stdout: Arc<Mutex<tokio::io::Stdout>> = Arc::new(Mutex::new(tokio::io::stdout()));
    let mut sessions: SessionMap = HashMap::new();
    let mut agent_connections: AgentConnectionMap = HashMap::new();

    let (diag_tx, diag_rx) = tokio::sync::mpsc::unbounded_channel::<DiagnosticPayload>();
    let _ = DIAG_TX.set(diag_tx);

    // On Windows, anonymous pipes don't support overlapped I/O (IOCP), so
    // tokio::io::stdin() falls back to spawn_blocking for each read. When a
    // tokio::select! picks a different arm and drops the read_message future,
    // the blocking thread keeps running and its ReadFile result is discarded —
    // silently consuming the 4-byte framing prefix and desyncing the stream.
    // Fix: one dedicated blocking thread owns stdin forever and forwards messages
    // over a channel, so the future the select polls is always the channel receive,
    // never a raw stdin read.
    let (stdin_msg_tx, mut stdin_msg_rx) =
        tokio::sync::mpsc::channel::<Result<MaestroRpcMessage, String>>(4);
    tokio::task::spawn_blocking(move || {
        let stdin = std::io::stdin();
        let mut locked = stdin.lock();
        loop {
            match maestro_protocol::read_message_sync(&mut locked) {
                Ok(msg) => {
                    if stdin_msg_tx.blocking_send(Ok(msg)).is_err() {
                        break;
                    }
                }
                Err(e) => {
                    let msg = e.to_string();
                    let is_eof = msg.contains("failed to fill whole buffer")
                        || msg.contains("unexpected eof")
                        || msg.contains("early eof");
                    let _ = stdin_msg_tx.blocking_send(Err(msg));
                    if is_eof {
                        break;
                    }
                    // "Message too large": body bytes still in pipe; loop back
                    // and read the next 4 bytes — same cascade semantics as before.
                }
            }
        }
    });

    let registry: AcpRegistry = tokio::task::spawn_blocking(agent::load_registry)
        .await
        .unwrap_or_else(|_| agent::load_registry());

    // Validate the protocol version handshake before entering the main dispatch loop.
    // Agent discovery (which::which PATH scanning) runs AFTER handshake so the client
    // does not time out waiting on slow PATH scans on Windows.
    let first_msg = match stdin_msg_rx.recv().await {
        Some(Ok(msg)) => msg,
        _ => return Ok(()),
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

    let mut agents_with_spawn: Vec<agent::registry::DiscoveredAgentWithSpawn> = agent::discover_agents(&registry);

    // Heartbeat: send Ping every 10s so the parent (Tauri) can detect stale connections.
    tokio::spawn({
        let stdout = Arc::clone(&stdout);
        async move {
            let mut seq: u64 = 0;
            loop {
                tokio::time::sleep(tokio::time::Duration::from_secs(10)).await;
                seq = seq.wrapping_add(1);
                if send_response(
                    &stdout,
                    &MaestroRpcMessage::Response(ServerResponse::Ping { seq }),
                )
                .await
                .is_err()
                {
                    break;
                }
            }
        }
    });

    // Flush diagnostics in the background so they appear even when an arm is blocked mid-await.
    tokio::spawn({
        let stdout = Arc::clone(&stdout);
        async move {
            let mut diag_rx = diag_rx;
            while let Some(payload) = diag_rx.recv().await {
                if send_response(
                    &stdout,
                    &MaestroRpcMessage::Response(ServerResponse::Diagnostic(payload)),
                )
                .await
                .is_err()
                {
                    break;
                }
            }
        }
    });

    // Break the loop if stdout write fails — server can't communicate, no point continuing.
    macro_rules! send_or_break {
        ($e:expr) => {
            if ($e).is_err() {
                break;
            }
        };
    }

    let mut liveness_interval = tokio::time::interval(tokio::time::Duration::from_secs(10));
    liveness_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    loop {
        let msg = tokio::select! {
            biased;

            msg_result = stdin_msg_rx.recv() => {
                match msg_result {
                    Some(Ok(msg)) => msg,
                    Some(Err(e)) => {
                        let is_eof = e.contains("failed to fill whole buffer")
                            || e.contains("early eof")
                            || e.contains("unexpected eof")
                            || e.contains("UnexpectedEof");
                        if is_eof {
                            break;
                        }
                        send_diag("error", format!("stdin framing error: {e}"));
                        send_or_break!(send_response(
                            &stdout,
                            &MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
                                message: format!("read error: {}", e),
                            })),
                        )
                        .await);
                        continue;
                    }
                    None => break,
                }
            }

            _ = liveness_interval.tick() => {
                let dead: Vec<String> = agent_connections
                    .iter()
                    .filter(|(_, conn)| conn.connection_task.is_finished())
                    .map(|(id, _)| id.clone())
                    .collect();
                for agent_id in dead {
                    handle_agent_restart(
                        agent_id,
                        &mut agent_connections,
                        &mut sessions,
                        &agents_with_spawn,
                        &stdout,
                    )
                    .await;
                }
                continue;
            }
        };

        match msg {
            MaestroRpcMessage::Request(ServerRequest::ListAgents(_req)) => {
                let agents: Vec<DiscoveredAgent> = agents_with_spawn
                    .iter()
                    .map(|a| DiscoveredAgent {
                        id: a.id.clone(),
                        name: a.name.clone(),
                        icon: a.icon.clone(),
                        spawn_deps: a.spawn_deps.clone(),
                    })
                    .collect();
                send_or_break!(send_response(
                    &stdout,
                    &MaestroRpcMessage::Response(ServerResponse::ListAgentsOk(
                        ListAgentsResponse { agents },
                    )),
                )
                .await);
            }

            MaestroRpcMessage::Request(ServerRequest::Spawn(req)) => {
                send_diag("info", format!("[spawn] Spawn agent_id={:?} session_id={:?} cwd={:?}", req.agent_id, req.session_id, req.cwd));
                if !ensure_agent_connection(&req.agent_id, &mut agent_connections, &agents_with_spawn, &req.cwd, &stdout).await {
                    continue;
                }
                let result = {
                    let conn = agent_connections.get(&req.agent_id).expect("ensure_agent_connection guarantees entry");
                    create_session_on_connection(conn, req.session_id.clone(), &req.cwd, Arc::clone(&stdout)).await
                };
                if result.is_none() {
                    agent_connections.remove(&req.agent_id);
                }

                if let Some(mut result) = result {
                    let response = SpawnResponse {
                        session_id: req.session_id.clone(),
                        acp_session_id: Some(result.acp_session_id),
                        models: result.models,
                        modes: result.modes,
                        prompt_capabilities: Some(result.prompt_capabilities),
                        supports_session_list: result.supports_session_list,
                        supports_session_load: result.supports_session_load,
                        supports_session_close: result.supports_session_close,
                        config_options: result.config_options,
                    };
                    result.session.agent_id = req.agent_id.clone();
                    result.session.cwd = req.cwd.clone();
                    sessions.insert(req.session_id, result.session);
                    send_or_break!(send_response(
                        &stdout,
                        &MaestroRpcMessage::Response(ServerResponse::SpawnOk(response)),
                    )
                    .await);
                }
                // None: error already sent by spawn function
            }

            MaestroRpcMessage::Request(ServerRequest::Prompt(req)) => {
                if let Some(session) = sessions.get(&req.session_id) {
                    let sent_at = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis() as u64;
                    send_or_break!(send_response(
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
                    .await);
                    let cmd = match req.content {
                        serde_json::Value::Array(blocks) => {
                            SessionCommand::PromptStructured(blocks)
                        }
                        other => {
                            SessionCommand::Prompt(other.as_str().unwrap_or("").to_string())
                        }
                    };
                    if session.cmd_tx.send(cmd).await.is_err() {
                        send_or_break!(send_response(
                            &stdout,
                            &MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
                                message: format!(
                                    "session {} connection closed",
                                    req.session_id
                                ),
                            })),
                        )
                        .await);
                    }
                } else {
                    send_or_break!(send_response(
                        &stdout,
                        &MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
                            message: format!("unknown session: {}", req.session_id),
                        })),
                    )
                    .await);
                }
            }

            MaestroRpcMessage::Request(ServerRequest::Cancel(req)) => {
                if let Some(session) = sessions.remove(&req.session_id) {
                    if session.cmd_tx.try_send(SessionCommand::CloseSession).is_ok() {
                        // Graceful close: command loop sends CloseSessionRequest to agent.
                        // Watchdog force-aborts after 5s if the loop stalls.
                        let abort_handle = session.task.abort_handle();
                        let cleanup = session.cleanup;
                        tokio::spawn(async move {
                            let timed_out = tokio::time::timeout(
                                std::time::Duration::from_secs(5),
                                session.task,
                            )
                            .await
                            .is_err();
                            if timed_out {
                                abort_handle.abort();
                                if let Some(c) = cleanup {
                                    c.router.unregister(&c.acp_session_id).await;
                                }
                            }
                        });
                    } else {
                        // Channel full or closed — force abort and clean up manually.
                        session.task.abort();
                        if let Some(c) = session.cleanup {
                            c.router.unregister(&c.acp_session_id).await;
                        }
                    }
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
                send_or_break!(
                    forward_to_session(
                        &sessions,
                        &set_model_req.session_id,
                        SessionCommand::SetModel(set_model_req.model_id),
                        &stdout,
                    )
                    .await
                );
            }

            MaestroRpcMessage::Request(ServerRequest::SetMode(set_mode_req)) => {
                send_or_break!(
                    forward_to_session(
                        &sessions,
                        &set_mode_req.session_id,
                        SessionCommand::SetMode(set_mode_req.mode_id),
                        &stdout,
                    )
                    .await
                );
            }

            MaestroRpcMessage::Request(ServerRequest::SetConfigOption(req)) => {
                send_or_break!(
                    forward_to_session(
                        &sessions,
                        &req.session_id,
                        SessionCommand::SetConfigOption {
                            config_id: req.config_id,
                            value: req.value,
                        },
                        &stdout,
                    )
                    .await
                );
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
                send_or_break!(send_response(&stdout, &response).await);
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
                send_or_break!(send_response(&stdout, &response).await);
            }

            MaestroRpcMessage::Request(ServerRequest::SessionList(req)) => {
                if !ensure_agent_connection(&req.agent_id, &mut agent_connections, &agents_with_spawn, &req.cwd, &stdout).await {
                    continue;
                }
                let list_result = {
                    let conn = agent_connections.get(&req.agent_id).expect("ensure_agent_connection guarantees entry");
                    session_list_on_connection(conn, &req.cwd, req.cursor).await
                };
                if list_result.is_err() {
                    agent_connections.remove(&req.agent_id);
                }
                match list_result {
                    Ok((sessions_list, next_cursor)) => {
                        send_or_break!(send_response(
                            &stdout,
                            &MaestroRpcMessage::Response(ServerResponse::SessionListOk(
                                SessionListOkResponse { sessions: sessions_list, next_cursor },
                            )),
                        )
                        .await);
                    }
                    Err(e) => {
                        send_or_break!(send_response(
                            &stdout,
                            &MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
                                message: e,
                            })),
                        )
                        .await);
                    }
                }
            }

            MaestroRpcMessage::Request(ServerRequest::SessionLoad(req)) => {
                if !ensure_agent_connection(&req.agent_id, &mut agent_connections, &agents_with_spawn, &req.cwd, &stdout).await {
                    continue;
                }
                let result = {
                    let conn = agent_connections.get(&req.agent_id).expect("ensure_agent_connection guarantees entry");
                    load_session_on_connection(
                        conn,
                        req.session_id.clone(),
                        req.resume_session_id.clone(),
                        &req.cwd,
                        Arc::clone(&stdout),
                    )
                    .await
                };
                match result {
                    Err(()) => {
                        // Transport failure — connection dead, force reconnect on next attempt.
                        agent_connections.remove(&req.agent_id);
                    }
                    Ok(None) => {
                        // ACP-level error (e.g. session not found) — connection still alive,
                        // error response already sent inside load_session_on_connection.
                    }
                    Ok(Some((mut session, models, modes, prompt_caps, config_options))) => {
                        session.agent_id = req.agent_id.clone();
                        session.cwd = req.cwd.clone();
                        sessions.insert(req.session_id.clone(), session);
                        send_or_break!(send_response(
                            &stdout,
                            &MaestroRpcMessage::Response(ServerResponse::SessionLoadOk(
                                SessionLoadOkResponse {
                                    session_id: req.session_id.clone(),
                                    models,
                                    modes,
                                    prompt_capabilities: Some(prompt_caps),
                                    config_options,
                                },
                            )),
                        )
                        .await);
                    }
                }
            }

            MaestroRpcMessage::Request(ServerRequest::SessionClose(req)) => {
                let had_connection = agent_connections.contains_key(&req.agent_id);
                let close_result = if had_connection {
                    let conn = agent_connections.get(&req.agent_id).expect("checked above");
                    session_close_on_connection(conn, req.session_id).await
                } else {
                    Err(format!("no active connection for agent {}", req.agent_id))
                };
                if had_connection && close_result.is_err() {
                    agent_connections.remove(&req.agent_id);
                }
                match close_result {
                    Ok(()) => {
                        send_or_break!(send_response(
                            &stdout,
                            &MaestroRpcMessage::Response(ServerResponse::SessionCloseOk),
                        )
                        .await);
                    }
                    Err(e) => {
                        send_or_break!(send_response(
                            &stdout,
                            &MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
                                message: e,
                            })),
                        )
                        .await);
                    }
                }
            }

            MaestroRpcMessage::Request(ServerRequest::Handshake(_)) => {
                send_or_break!(send_response(
                    &stdout,
                    &MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
                        message: "unexpected Handshake after initialization".to_string(),
                    })),
                )
                .await);
            }

            MaestroRpcMessage::Request(ServerRequest::PreInitialize(req)) => {
                let Some((spawn_cmd, spawn_args_owned, spawn_env)) =
                    resolve_agent_spawn_params(&req.agent_id, &agents_with_spawn, &stdout).await
                else { continue; };
                match pre_initialize_agent(
                    &spawn_cmd,
                    &spawn_args_owned,
                    &spawn_env,
                    &req.cwd,
                    Arc::clone(&stdout),
                )
                .await
                {
                    Some(conn) => {
                        let response = PreInitializeResponse {
                            agent_id: req.agent_id.clone(),
                            prompt_capabilities: conn.capabilities.prompt_capabilities.clone(),
                            supports_session_list: conn.capabilities.supports_session_list,
                            supports_session_load: conn.capabilities.supports_session_load,
                            supports_session_close: conn.capabilities.supports_session_close,
                        };
                        agent_connections.insert(req.agent_id, conn);
                        send_or_break!(send_response(
                            &stdout,
                            &MaestroRpcMessage::Response(ServerResponse::PreInitializeOk(
                                response,
                            )),
                        )
                        .await);
                    }
                    None => {
                        // Error already sent by pre_initialize_agent
                    }
                }
            }

            MaestroRpcMessage::Request(ServerRequest::CheckTools(req)) => {
                let results = check_tools(req.tools).await;
                send_or_break!(send_response(
                    &stdout,
                    &MaestroRpcMessage::Response(ServerResponse::CheckToolsOk(
                        CheckToolsResponse { results },
                    )),
                )
                .await);
            }

            MaestroRpcMessage::Request(ServerRequest::DetectInstalledAgents(_req)) => {
                let response = agent::detection::detect_installed_agents().await;

                // Override spawn_cmd with the path found by detection (handles platform quirks
                // where the registry cmd uses a relative archive path like ./opencode.exe).
                // Only applies to binary distributions — npx/uvx agents use binary_path as a
                // detection signal only, not as the spawn command.
                for info in &response.agents {
                    if let Some(ref path) = info.binary_path {
                        if let Some(agent) = agents_with_spawn.iter_mut().find(|a| a.id == info.agent_id) {
                            if agent.spawn_deps.is_empty() {
                                agent.spawn_cmd = path.clone();
                            }
                        }
                    }
                }

                send_or_break!(send_response(
                    &stdout,
                    &MaestroRpcMessage::Response(ServerResponse::DetectInstalledAgentsOk(
                        response,
                    )),
                )
                .await);
            }

            MaestroRpcMessage::Request(ServerRequest::DetectProjectAgents(req)) => {
                let response = agent::detection::detect_project_agents(&req.cwd).await;
                send_or_break!(send_response(
                    &stdout,
                    &MaestroRpcMessage::Response(ServerResponse::DetectProjectAgentsOk(
                        response,
                    )),
                )
                .await);
            }

            MaestroRpcMessage::Request(ServerRequest::Pong { seq }) => {
                eprintln!("[heartbeat] pong ack seq={seq}");
            }

            MaestroRpcMessage::Response(_) => {}
        }

    }

    // Abort all active session tasks so agent child processes are killed promptly.
    for (_id, session) in sessions.drain() {
        session.task.abort();
        if let Some(c) = session.cleanup {
            c.router.unregister(&c.acp_session_id).await;
        }
    }

    Ok(())
}

async fn handle_agent_restart(
    dead_agent_id: String,
    agent_connections: &mut AgentConnectionMap,
    sessions: &mut SessionMap,
    agents_with_spawn: &[agent::registry::DiscoveredAgentWithSpawn],
    stdout: &Arc<Mutex<tokio::io::Stdout>>,
) {
    send_diag("warn", format!("[agent] {dead_agent_id:?} died, restarting"));

    let to_restore: Vec<(String, String, String)> = sessions
        .iter()
        .filter(|(_, s)| s.agent_id == dead_agent_id)
        .filter_map(|(sid, s)| {
            s.cleanup
                .as_ref()
                .map(|c| (sid.clone(), c.acp_session_id.clone(), s.cwd.clone()))
        })
        .collect();

    for (maestro_sid, _, _) in &to_restore {
        if let Some(session) = sessions.remove(maestro_sid) {
            session.task.abort();
            let _ = send_response(
                stdout,
                &MaestroRpcMessage::Response(ServerResponse::TurnEnded(TurnEnded {
                    session_id: maestro_sid.clone(),
                    stop_reason: "error".to_string(),
                })),
            )
            .await;
        }
    }

    // Cold-path sessions (cleanup==None) have no ACP session ID to restore; just notify and remove.
    let cold_path_sids: Vec<String> = sessions
        .iter()
        .filter(|(_, s)| s.agent_id == dead_agent_id && s.cleanup.is_none())
        .map(|(sid, _)| sid.clone())
        .collect();
    for maestro_sid in cold_path_sids {
        if let Some(session) = sessions.remove(&maestro_sid) {
            session.task.abort();
            let _ = send_response(
                stdout,
                &MaestroRpcMessage::Response(ServerResponse::TurnEnded(TurnEnded {
                    session_id: maestro_sid.clone(),
                    stop_reason: "error".to_string(),
                })),
            )
            .await;
        }
    }

    agent_connections.remove(&dead_agent_id);

    if to_restore.is_empty() {
        return;
    }

    let cwd = &to_restore[0].2;
    let Some((cmd, args, env)) =
        resolve_agent_spawn_params(&dead_agent_id, agents_with_spawn, stdout).await
    else {
        return;
    };
    let Some(new_conn) = pre_initialize_agent(&cmd, &args, &env, cwd, Arc::clone(stdout)).await
    else {
        return;
    };

    if new_conn.capabilities.supports_session_load {
        for (maestro_sid, acp_session_id, session_cwd) in &to_restore {
            let result = load_session_on_connection(
                &new_conn,
                maestro_sid.clone(),
                acp_session_id.clone(),
                session_cwd,
                Arc::clone(stdout),
            )
            .await;
            if let Ok(Some((mut session, models, modes, prompt_caps, config_options))) = result {
                session.agent_id = dead_agent_id.clone();
                session.cwd = session_cwd.clone();
                sessions.insert(maestro_sid.clone(), session);
                let _ = send_response(
                    stdout,
                    &MaestroRpcMessage::Response(ServerResponse::SessionLoadOk(
                        SessionLoadOkResponse {
                            session_id: maestro_sid.clone(),
                            models,
                            modes,
                            prompt_capabilities: Some(prompt_caps),
                            config_options,
                        },
                    )),
                )
                .await;
            }
        }
    }

    agent_connections.insert(dead_agent_id, new_conn);
}

async fn probe_tool(tool: &str) -> (bool, Option<String>) {
    // On Windows, tools like npx/uvx are .cmd batch files — CreateProcess won't find them
    // without going through cmd.exe. Check exit code too since cmd.exe always launches.
    #[cfg(windows)]
    let result = {
        use crate::command_ext::NoConsoleWindow;
        tokio::process::Command::new("cmd")
            .args(["/c", tool, "--version"])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .no_console_window()
            .output()
            .await
    };
    #[cfg(not(windows))]
    let result = tokio::process::Command::new(tool)
        .arg("--version")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .output()
        .await;

    match result {
        Err(_) => (false, None),
        Ok(out) => {
            #[cfg(windows)]
            if !out.status.success() {
                return (false, None);
            }
            let raw = if out.stdout.is_empty() { out.stderr } else { out.stdout };
            let ver = String::from_utf8(raw)
                .ok()
                .map(|s| s.lines().next().unwrap_or("").trim().to_string())
                .filter(|s| !s.is_empty());
            (true, ver)
        }
    }
}

async fn check_tools(tools: Vec<String>) -> Vec<ToolCheckResult> {
    let handles: Vec<_> = tools
        .into_iter()
        .map(|tool| {
            tokio::spawn(async move {
                let (available, version) = probe_tool(&tool).await;
                ToolCheckResult { tool, available, version }
            })
        })
        .collect();

    futures::future::join_all(handles)
        .await
        .into_iter()
        .filter_map(Result::ok)
        .collect()
}
