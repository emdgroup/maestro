use std::collections::HashMap;
use std::sync::Arc;

use maestro_protocol::{DiagnosticPayload, ErrorResponse, ServerResponse};

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

/// A finished turn: the session, why it stopped, and what the stream said about it.
pub(crate) struct TurnEnd {
    pub session_id: String,
    pub stop_reason: String,
    /// What the stream said about the turn, for resolving a task's turn. Taken here, at every turn
    /// end, so the per-session state never outlives a turn.
    pub facts: crate::turn::TurnFacts,
    /// Token counts the agent reported for the turn, if it reported any.
    pub usage: Option<maestro_protocol::TurnUsage>,
    pub model_usage: Option<serde_json::Value>,
    /// The model, timing and cost the daemon followed through the turn, for its usage row.
    pub meter: crate::usage_store::TurnMeter,
}

pub(crate) type TurnSender = tokio::sync::mpsc::UnboundedSender<TurnEnd>;

/// Where a finished turn is announced inside this process.
///
/// A channel rather than a call, for the same reason `DIAG_TX` is one: turns end deep inside a
/// session's own command loop, which holds none of the state that has to react. The main loop owns
/// the automation store and picks these up there.
pub(crate) static TURN_TX: std::sync::OnceLock<TurnSender> = std::sync::OnceLock::new();

/// A session's command loop ended: drop what its turns left behind, which nothing will take now.
pub(crate) fn forget_session(session_id: &str) {
    let _ = crate::turn::take_turn_facts(session_id);
    crate::usage_store::forget(session_id);
}

/// Note that a turn has ended. No-op until the main loop is running.
pub(crate) fn note_turn_ended(
    session_id: &str,
    stop_reason: &str,
    usage: Option<maestro_protocol::TurnUsage>,
    model_usage: Option<serde_json::Value>,
) {
    let facts = crate::turn::take_turn_facts(session_id);
    if let Some(tx) = TURN_TX.get() {
        if let Err(e) = tx.send(TurnEnd {
            session_id: session_id.to_string(),
            stop_reason: stop_reason.to_string(),
            facts,
            usage,
            model_usage,
            meter: crate::usage_store::take_turn(session_id),
        }) {
            send_diag("warn", format!("[prompt] turn end went unheard: {e}"));
        }
    }
}

/// An error to send back to the host, with no session to attribute it to.
pub(crate) fn error_response(message: String) -> ServerResponse {
    ServerResponse::Error(ErrorResponse {
        message,
        session_id: None,
    })
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
                &ServerResponse::Error(ErrorResponse {
                    message: format!("Unknown agent: {}", agent_id),
                    session_id: None,
                }),
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

/// Send a ServerResponse to the client, flushing after every write.
pub(crate) async fn send_response(
    stdout: &crate::ClientOut,
    msg: &ServerResponse,
) -> Result<(), Box<dyn std::error::Error>> {
    let mut sink = stdout.lock().await;
    let buf =
        maestro_protocol::encode_message(sink.reply_id_for(msg), msg).map_err(|e| e.to_string())?;
    sink.write(msg.session_id(), &buf).await?;
    Ok(())
}

/// Push `response` to every attached client, the one `stdout` replies to included.
pub(crate) async fn broadcast(stdout: &crate::ClientOut, response: ServerResponse) {
    crate::scheduler::observe(&response);
    let everyone = crate::client_sink::ClientSink::everyone(stdout).await;
    if let Err(e) = send_response(&everyone, &response).await {
        send_diag(
            "warn",
            format!("[server] could not broadcast a change: {e}"),
        );
    }
}

/// Answer a request. A write never fails, since a client that has gone just drops the bytes, so
/// the one failure left is a reply that cannot be encoded: over `MAX_MESSAGE_SIZE`, or a serde
/// error. That request is answered with an `Error` instead, so it fails rather than hangs and
/// nothing else is affected.
pub(crate) async fn reply(stdout: &crate::ClientOut, response: &ServerResponse) {
    // As a string: the boxed error is not `Send`, and this awaits again while holding it.
    let Err(e) = send_response(stdout, response)
        .await
        .map_err(|e| e.to_string())
    else {
        return;
    };
    send_diag("warn", format!("[server] could not encode a reply: {e}"));
    let fallback = error_response(format!("The reply could not be sent: {e}"));
    if let Err(e) = send_response(stdout, &fallback).await {
        send_diag(
            "error",
            format!("[server] could not send an error reply: {e}"),
        );
    }
}

/// Forward a command to an active session, answering with an error when the session is not found
/// or its channel is closed.
pub(crate) async fn forward_to_session(
    sessions: &SessionMap,
    session_id: &str,
    cmd: SessionCommand,
    stdout: &crate::ClientOut,
) {
    let message = match sessions.get(session_id) {
        Some(session) => match session.cmd_tx.send(cmd).await {
            Ok(()) => return,
            Err(_) => format!("session {session_id} connection closed"),
        },
        None => format!("unknown session: {session_id}"),
    };
    reply(stdout, &error_response(message)).await;
}

#[cfg(test)]
mod reply_tests {
    use super::*;
    use crate::client_sink::ClientSink;

    /// A reply too large to encode fails its request, rather than going unanswered.
    #[tokio::test]
    async fn a_reply_that_cannot_be_encoded_is_answered_with_an_error() {
        let root = ClientSink::detached();
        let (ours, mut theirs) = tokio::io::duplex(1 << 16);
        let client = root.lock().await.attach(Box::new(ours)).await;
        let to_client = ClientSink::for_client(&root, client).await;

        let huge = error_response("x".repeat(maestro_protocol::MAX_MESSAGE_SIZE));
        reply(&to_client, &huge).await;

        let back: ServerResponse = maestro_protocol::read_message(&mut theirs)
            .await
            .expect("an answer");
        assert!(
            matches!(&back, ServerResponse::Error(e) if e.message.starts_with("The reply could not be sent")),
            "{back:?}"
        );
    }
}
