use std::collections::HashMap;
use std::sync::Arc;

use maestro_protocol::{DiagnosticPayload, ErrorResponse, MaestroRpcMessage, ServerResponse};

use crate::session::pre_initialize_agent;
use crate::sessions::{AgentConnectionHandle, SessionCommand, SessionMap, SharedAgentConnections};

pub(crate) type DiagSender = tokio::sync::mpsc::UnboundedSender<DiagnosticPayload>;

pub(crate) static DIAG_TX: std::sync::OnceLock<DiagSender> = std::sync::OnceLock::new();

/// Send a diagnostic event to Tauri. No-op until the main loop is running.
pub(crate) fn send_diag(level: &str, msg: impl Into<String>) {
    if let Some(tx) = DIAG_TX.get() {
        let _ = tx.send(DiagnosticPayload {
            level: level.into(),
            message: msg.into(),
        });
    }
}

/// A finished turn: the session, why it stopped, and the last thing the agent said.
pub(crate) struct TurnEnd {
    pub session_id: String,
    pub stop_reason: String,
    pub final_message: Option<String>,
}

pub(crate) type TurnSender = tokio::sync::mpsc::UnboundedSender<TurnEnd>;

/// Where a finished turn is announced inside this process.
///
/// A channel rather than a call, for the same reason `DIAG_TX` is one: turns end deep inside a
/// session's own command loop, which holds none of the state that has to react. The main loop owns
/// the automation store and picks these up there.
pub(crate) static TURN_TX: std::sync::OnceLock<TurnSender> = std::sync::OnceLock::new();

/// The text each session's agent has written since its last tool call, during a turn. Taken when
/// the turn ends, which is also what keeps it from growing: every turn ends, cancelled or not.
static FINAL_MESSAGE: std::sync::LazyLock<std::sync::Mutex<HashMap<String, String>>> =
    std::sync::LazyLock::new(Default::default);

/// Past this, a result is cut. It is read in a dialog, not archived.
const FINAL_MESSAGE_LIMIT: usize = 64 * 1024;

/// Follow what the agent writes, keeping only its last block of text: a tool call starts a new
/// block, so what is left when the turn ends is the conclusion rather than the running commentary.
pub(crate) fn note_session_update(session_id: &str, payload: &serde_json::Value) {
    let Ok(mut messages) = FINAL_MESSAGE.lock() else {
        return;
    };
    match payload.get("sessionUpdate").and_then(|kind| kind.as_str()) {
        Some("tool_call") => {
            messages.remove(session_id);
        }
        Some("agent_message_chunk") => {
            let content = &payload["content"];
            if content["type"] == "text" {
                if let Some(text) = content["text"].as_str() {
                    let message = messages.entry(session_id.to_string()).or_default();
                    if message.len() < FINAL_MESSAGE_LIMIT {
                        message.push_str(text);
                    }
                }
            }
        }
        _ => {}
    }
}

/// The session's last block of text, cut to the limit, or `None` if it wrote nothing after its
/// last tool call.
fn take_final_message(session_id: &str) -> Option<String> {
    FINAL_MESSAGE
        .lock()
        .ok()
        .and_then(|mut messages| messages.remove(session_id))
        .map(|mut message| {
            if message.len() > FINAL_MESSAGE_LIMIT {
                let mut cut = FINAL_MESSAGE_LIMIT;
                while !message.is_char_boundary(cut) {
                    cut -= 1;
                }
                message.truncate(cut);
                message.push_str("\n\n[cut: the rest is in the session]");
            }
            message
        })
        .filter(|message| !message.trim().is_empty())
}

/// Note that a turn has ended. No-op until the main loop is running.
pub(crate) fn note_turn_ended(session_id: &str, stop_reason: &str) {
    let final_message = take_final_message(session_id);
    if let Some(tx) = TURN_TX.get() {
        if let Err(e) = tx.send(TurnEnd {
            session_id: session_id.to_string(),
            stop_reason: stop_reason.to_string(),
            final_message,
        }) {
            send_diag("warn", format!("[prompt] turn end went unheard: {e}"));
        }
    }
}

/// An error to send back to the host, with no session to attribute it to.
pub(crate) fn error_response(message: String) -> MaestroRpcMessage {
    MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
        message,
        session_id: None,
    }))
}

/// Drop a failed agent connection, unless it has already been replaced.
///
/// The identity check is the point. Every caller reaches here after awaiting an ACP call that
/// failed, and in that window the entry under `agent_id` may already have been evicted and a fresh
/// connection spawned in its place — removing by key alone would throw away a working connection
/// because an older one died. `Arc::ptr_eq` on the router answers "is this still the same
/// connection I was talking to", which is the question actually being asked.
pub(crate) async fn evict_if_same_connection(
    agent_connections: &SharedAgentConnections,
    agent_id: &str,
    router: &Arc<crate::sessions::SessionRouter>,
) {
    let mut connections = agent_connections.lock().await;
    if connections
        .get(agent_id)
        .map(|c| Arc::ptr_eq(&c.router, router))
        .unwrap_or(false)
    {
        connections.remove(agent_id);
    }
}

pub(crate) async fn resolve_agent_spawn_params(
    agent_id: &str,
    agents: &[crate::agent::registry::DiscoveredAgentWithSpawn],
    stdout: &crate::ClientOut,
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
            Some((
                a.spawn_cmd.clone(),
                a.spawn_args.clone(),
                a.spawn_env.clone(),
            ))
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
    stdout: &crate::ClientOut,
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

/// Send a MaestroRpcMessage to the client, flushing after every write.
pub(crate) async fn send_response(
    stdout: &crate::ClientOut,
    msg: &MaestroRpcMessage,
) -> Result<(), Box<dyn std::error::Error>> {
    let mut buf: Vec<u8> = Vec::new();
    maestro_protocol::write_message(&mut buf, msg).await?;
    stdout.lock().await.write(&buf).await?;
    Ok(())
}

/// Forward a command to an active session. Returns `Err` only if stdout write fails.
/// Sends an error response to stdout if the session is not found or its channel is closed.
pub(crate) async fn forward_to_session(
    sessions: &SessionMap,
    session_id: &str,
    cmd: SessionCommand,
    stdout: &crate::ClientOut,
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

#[cfg(test)]
mod final_message_tests {
    use super::*;

    #[test]
    fn only_the_text_after_the_last_tool_call_is_kept() {
        let session = "final-message-test";
        let chunk = |text: &str| {
            serde_json::json!({
                "sessionUpdate": "agent_message_chunk",
                "content": { "type": "text", "text": text },
            })
        };
        note_session_update(session, &chunk("Let me look at the file."));
        note_session_update(
            session,
            &serde_json::json!({ "sessionUpdate": "tool_call", "toolCallId": "1" }),
        );
        note_session_update(session, &chunk("All four "));
        note_session_update(session, &chunk("tests pass."));
        // A status update to an earlier call does not start a new block.
        note_session_update(
            session,
            &serde_json::json!({ "sessionUpdate": "tool_call_update", "toolCallId": "1" }),
        );

        assert_eq!(
            take_final_message(session).as_deref(),
            Some("All four tests pass.")
        );
        assert_eq!(take_final_message(session), None);
    }
}
