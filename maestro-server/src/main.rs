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
use sessions::{
    AgentConnectionHandle, AgentConnectionMap, SessionCommand, SessionMap,
    SharedAgentConnections,
};

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

/// Returns the existing connection for `agent_id`, or creates a new one if absent.
async fn ensure_and_get_connection(
    agent_id: &str,
    agent_connections: &SharedAgentConnections,
    cmd: &str,
    args: &[String],
    env: &std::collections::HashMap<String, String>,
    cwd: &str,
    stdout: &Arc<Mutex<tokio::io::Stdout>>,
) -> Option<AgentConnectionHandle> {
    if let Some(conn) = agent_connections.lock().await.get(agent_id) {
        return Some(AgentConnectionHandle::from(conn));
    }
    let new_conn = pre_initialize_agent(cmd, args, env, cwd, Arc::clone(stdout)).await?;
    let handle = AgentConnectionHandle::from(&new_conn);
    agent_connections.lock().await.insert(agent_id.to_string(), new_conn);
    Some(handle)
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
    let agent_connections: SharedAgentConnections =
        Arc::new(tokio::sync::Mutex::new(AgentConnectionMap::new()));
    // Completed Spawn and SessionLoad tasks send their results here so the main loop
    // can insert sessions without holding any lock across the async ACP operations.
    let (spawn_result_tx, mut spawn_result_rx) =
        tokio::sync::mpsc::channel::<(String, sessions::ActiveSession)>(8);

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

            result = spawn_result_rx.recv() => {
                if let Some((session_id, session)) = result {
                    sessions.insert(session_id, session);
                }
                continue;
            }

            _ = liveness_interval.tick() => {
                let agents_with_dead: Vec<String> = {
                    let connections = agent_connections.lock().await;
                    connections.iter()
                        .filter(|(_, conn)| conn.connection_task.is_finished())
                        .map(|(id, _)| id.clone())
                        .collect()
                };
                for agent_id in agents_with_dead {
                    handle_agent_restart(
                        agent_id,
                        &agent_connections,
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
                // Resolve spawn params inline (fast: in-memory list search) so the task
                // doesn't need to borrow agents_with_spawn.
                let Some((cmd, args, env)) = resolve_agent_spawn_params(
                    &req.agent_id, &agents_with_spawn, &stdout,
                ).await else { continue; };
                let stdout_task = Arc::clone(&stdout);
                let agent_connections_task = Arc::clone(&agent_connections);
                let spawn_result_tx = spawn_result_tx.clone();
                // Offload the blocking ACP operations to a separate task so the main loop
                // stays responsive to PermitResponse and other messages.
                tokio::spawn(async move {
                    let conn_handle = ensure_and_get_connection(
                        &req.agent_id,
                        &agent_connections_task,
                        &cmd, &args, &env,
                        &req.cwd,
                        &stdout_task,
                    ).await;
                    let conn_handle = match conn_handle {
                        Some(h) => h,
                        None => return,
                    };
                    let result = create_session_on_connection(
                        &conn_handle,
                        req.session_id.clone(),
                        &req.cwd,
                        Arc::clone(&stdout_task),
                    ).await;
                    if result.is_none() {
                        let mut connections = agent_connections_task.lock().await;
                        // Only evict the connection that failed; a concurrent task may have
                        // already inserted a different (live) connection for this agent_id.
                        if connections.get(&req.agent_id)
                            .map(|c| Arc::ptr_eq(&c.router, &conn_handle.router))
                            .unwrap_or(false)
                        {
                            connections.remove(&req.agent_id);
                        }
                        return;
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
                        result.session.agent_id = req.agent_id;
                        result.session.cwd = req.cwd;
                        if send_response(
                            &stdout_task,
                            &MaestroRpcMessage::Response(ServerResponse::SpawnOk(response)),
                        ).await.is_ok() {
                            let _ = spawn_result_tx.send((req.session_id, result.session)).await;
                        }
                    }
                });
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
                    let session_agent_id = session.agent_id.clone();
                    if session.cmd_tx.try_send(SessionCommand::CloseSession).is_ok() {
                        // Graceful close: command loop sends CloseSessionRequest to agent.
                        // Watchdog force-aborts after 5s if the loop stalls.
                        let abort_handle = session.task.abort_handle();
                        let cleanup = session.cleanup;
                        let agent_connections_cancel = Arc::clone(&agent_connections);
                        tokio::spawn(async move {
                            let timed_out = tokio::time::timeout(
                                std::time::Duration::from_secs(5),
                                session.task,
                            )
                            .await
                            .is_err();
                            if timed_out {
                                abort_handle.abort();
                            }
                            if let Some(c) = cleanup {
                                if timed_out {
                                    c.router.unregister(&c.acp_session_id).await;
                                }
                                if c.router.is_empty().await {
                                    agent_connections_cancel.lock().await.remove(&session_agent_id);
                                }
                            }
                        });
                    } else {
                        // Channel full or closed — force abort and clean up manually.
                        session.task.abort();
                        if let Some(c) = session.cleanup {
                            c.router.unregister(&c.acp_session_id).await;
                            if c.router.is_empty().await {
                                agent_connections.lock().await.remove(&session_agent_id);
                            }
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
                let conn_handle = agent_connections.lock().await
                    .get(&req.agent_id)
                    .map(AgentConnectionHandle::from);
                let Some(conn_handle) = conn_handle else {
                    send_or_break!(send_response(
                        &stdout,
                        &MaestroRpcMessage::Response(ServerResponse::SessionListOk(
                            SessionListOkResponse { sessions: vec![], next_cursor: None },
                        )),
                    ).await);
                    continue;
                };
                let list_result = session_list_on_connection(&conn_handle, &req.cwd, req.cursor).await;
                if list_result.is_err() {
                    agent_connections.lock().await.remove(&req.agent_id);
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
                let Some((cmd, args, env)) = resolve_agent_spawn_params(
                    &req.agent_id, &agents_with_spawn, &stdout,
                ).await else { continue; };
                let stdout_task = Arc::clone(&stdout);
                let agent_connections_task = Arc::clone(&agent_connections);
                let spawn_result_tx = spawn_result_tx.clone();
                tokio::spawn(async move {
                    let conn_handle = ensure_and_get_connection(
                        &req.agent_id,
                        &agent_connections_task,
                        &cmd, &args, &env,
                        &req.cwd,
                        &stdout_task,
                    ).await;
                    let conn_handle = match conn_handle {
                        Some(h) => h,
                        None => return,
                    };
                    let result = load_session_on_connection(
                        &conn_handle,
                        req.session_id.clone(),
                        req.resume_session_id.clone(),
                        &req.cwd,
                        Arc::clone(&stdout_task),
                    ).await;
                    match result {
                        Err(()) => {
                            let mut connections = agent_connections_task.lock().await;
                            if connections.get(&req.agent_id)
                                .map(|c| Arc::ptr_eq(&c.router, &conn_handle.router))
                                .unwrap_or(false)
                            {
                                connections.remove(&req.agent_id);
                            }
                        }
                        Ok(None) => {}
                        Ok(Some((mut session, models, modes, prompt_caps, config_options))) => {
                            session.agent_id = req.agent_id;
                            session.cwd = req.cwd;
                            let session_id = req.session_id.clone();
                            if send_response(
                                &stdout_task,
                                &MaestroRpcMessage::Response(ServerResponse::SessionLoadOk(
                                    SessionLoadOkResponse {
                                        session_id: req.session_id,
                                        models,
                                        modes,
                                        prompt_capabilities: Some(prompt_caps),
                                        config_options,
                                    },
                                )),
                            ).await.is_ok() {
                                let _ = spawn_result_tx.send((session_id, session)).await;
                            }
                        }
                    }
                });
            }

            MaestroRpcMessage::Request(ServerRequest::SessionClose(req)) => {
                let conn_handle = agent_connections.lock().await
                    .get(&req.agent_id)
                    .map(AgentConnectionHandle::from);
                let close_result = match conn_handle {
                    Some(ref handle) => {
                        session_close_on_connection(handle, req.session_id.clone()).await
                    }
                    None => Err(format!(
                        "no connection found for agent {} with session {}",
                        req.agent_id, req.session_id
                    )),
                };
                if close_result.is_err() && conn_handle.is_some() {
                    agent_connections.lock().await.remove(&req.agent_id);
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
                        agent_connections.lock().await.insert(req.agent_id, conn);
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
    // Drop all pool entries (kills agent subprocesses via _shutdown_tx drop).
    agent_connections.lock().await.clear();

    Ok(())
}

async fn handle_agent_restart(
    dead_agent_id: String,
    agent_connections: &SharedAgentConnections,
    sessions: &mut SessionMap,
    agents_with_spawn: &[agent::registry::DiscoveredAgentWithSpawn],
    stdout: &Arc<Mutex<tokio::io::Stdout>>,
) {
    send_diag("warn", format!("[agent] {dead_agent_id:?} connection dead"));

    let is_dead = agent_connections.lock().await
        .get(&dead_agent_id)
        .map(|conn| conn.connection_task.is_finished())
        .unwrap_or(false);
    if !is_dead {
        return;
    }

    // Fast-path sessions (shared connection, have cleanup) are candidates for restore.
    let to_restore: Vec<(String, String, String)> = sessions
        .iter()
        .filter(|(_, s)| s.agent_id == dead_agent_id)
        .filter_map(|(sid, s)| {
            s.cleanup.as_ref().map(|c| (sid.clone(), c.acp_session_id.clone(), s.cwd.clone()))
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

    // Cold-path sessions (no cleanup) are always evicted when the connection dies.
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

    agent_connections.lock().await.remove(&dead_agent_id);

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
        let conn_handle = AgentConnectionHandle::from(&new_conn);
        for (maestro_sid, acp_session_id, session_cwd) in &to_restore {
            let result = load_session_on_connection(
                &conn_handle,
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

    agent_connections.lock().await.insert(dead_agent_id, new_conn);
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
