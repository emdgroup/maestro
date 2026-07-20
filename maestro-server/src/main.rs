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
mod agent_restart;
mod command_ext;
mod dispatch;
mod file_ops;
mod helpers;
mod session;
mod sessions;
mod terminal;
mod tool_check;
mod validate_canvas;

#[cfg(test)]
mod tests;

use std::collections::HashMap;
use std::sync::Arc;

use maestro_protocol::{
    AcpRegistry, DiagnosticPayload, ErrorResponse, HandshakeResponse, MaestroRpcMessage,
    PROTOCOL_VERSION, ServerRequest, ServerResponse,
};
use tokio::sync::Mutex;

use agent_restart::handle_agent_restart;
use dispatch::{dispatch_message, AuthTerminalState};
use sessions::{ActiveSession, AgentConnectionMap, SessionMap, SharedAgentConnections};

// Re-export so that `crate::send_response` and `crate::send_diag` still resolve
// for the submodules that import them via `use crate::send_response` /
// `crate::send_diag(...)`.
pub(crate) use helpers::{send_diag, send_response, DIAG_TX};

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
        tokio::sync::mpsc::channel::<(String, ActiveSession)>(8);

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
                        session_id: None,
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
                    session_id: None,
                })),
            )
            .await;
            return Ok(());
        }
    }

    let mut agents_with_spawn: Vec<agent::registry::DiscoveredAgentWithSpawn> =
        agent::discover_agents(&registry);
    let auth_terminals: Arc<tokio::sync::Mutex<std::collections::HashMap<String, AuthTerminalState>>> =
        Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new()));

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
                        if send_response(
                            &stdout,
                            &MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
                                message: format!("read error: {}", e),
                                session_id: None,
                            })),
                        )
                        .await
                        .is_err()
                        {
                            break;
                        }
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

        if !dispatch_message(
            msg,
            &mut sessions,
            &agent_connections,
            &mut agents_with_spawn,
            &stdout,
            &spawn_result_tx,
            &auth_terminals,
        )
        .await
        {
            break;
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
