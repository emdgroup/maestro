use std::collections::HashMap;
use std::sync::Arc;

use maestro_protocol::{DiagnosticPayload, ErrorResponse, MaestroRpcMessage, ServerResponse};
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;

use crate::session::pre_initialize_agent;
use crate::sessions::{AgentConnectionHandle, SessionCommand, SessionMap, SharedAgentConnections};

pub(crate) type DiagSender = tokio::sync::mpsc::UnboundedSender<DiagnosticPayload>;

pub(crate) static DIAG_TX: std::sync::OnceLock<DiagSender> = std::sync::OnceLock::new();

/// Send a diagnostic event to Tauri. No-op until the main loop is running.
pub(crate) fn send_diag(level: &str, msg: impl Into<String>) {
    if let Some(tx) = DIAG_TX.get() {
        let _ = tx.send(DiagnosticPayload { level: level.into(), message: msg.into() });
    }
}

pub(crate) async fn resolve_agent_spawn_params(
    agent_id: &str,
    agents: &[crate::agent::registry::DiscoveredAgentWithSpawn],
    stdout: &Arc<Mutex<tokio::io::Stdout>>,
) -> Option<(String, Vec<String>, HashMap<String, String>)> {
    match agents.iter().find(|a| a.id == agent_id) {
        Some(a) => {
            send_diag(
                "info",
                format!(
                    "[spawn] resolved agent_id={agent_id:?} cmd={:?} args={:?}",
                    a.spawn_cmd, a.spawn_args
                ),
            );
            Some((a.spawn_cmd.clone(), a.spawn_args.clone(), a.spawn_env.clone()))
        }
        None => {
            send_diag("error", format!("[spawn] agent not found: {agent_id:?}"));
            let _ = send_response(
                stdout,
                &MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
                    message: format!("Unknown agent: {}", agent_id),
                    session_id: None,
                })),
            )
            .await;
            None
        }
    }
}

/// Returns the existing connection for `agent_id`, or creates a new one if absent.
pub(crate) async fn ensure_and_get_connection(
    agent_id: &str,
    agent_connections: &SharedAgentConnections,
    cmd: &str,
    args: &[String],
    env: &HashMap<String, String>,
    cwd: &str,
    stdout: &Arc<Mutex<tokio::io::Stdout>>,
) -> Option<AgentConnectionHandle> {
    if let Some(conn) = agent_connections.lock().await.get(agent_id) {
        return Some(AgentConnectionHandle::from(conn));
    }
    let new_conn = pre_initialize_agent(cmd, args, env, cwd, Arc::clone(stdout)).await?;
    let mut connections = agent_connections.lock().await;
    // Re-check: a concurrent task may have won the race and inserted first.
    if let Some(existing) = connections.get(agent_id) {
        return Some(AgentConnectionHandle::from(existing));
    }
    let handle = AgentConnectionHandle::from(&new_conn);
    connections.insert(agent_id.to_string(), new_conn);
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
pub(crate) async fn forward_to_session(
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
                    session_id: None,
                })),
            )
            .await?;
        }
    } else {
        send_response(
            stdout,
            &MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
                message: format!("unknown session: {}", session_id),
                session_id: None,
            })),
        )
        .await?;
    }
    Ok(())
}
