//! The host's session-lifecycle requests: list, load, close and delete.
//!
//! Split out of `dispatch_message`, where these four arms ran to 237 lines. Each one is the same
//! shape — find the agent's connection, call the matching `*_on_connection`, evict the connection
//! if the call failed, answer the host — and close and delete were that shape written twice.

use std::sync::Arc;

use maestro_protocol::{
    MaestroRpcMessage, ServerResponse, SessionListOkResponse, SessionLoadOkResponse,
};
use tokio::sync::Mutex;

use crate::agent;
use crate::helpers::{
    ensure_and_get_connection, error_response, evict_if_same_connection,
    resolve_agent_spawn_params, send_response,
};
use crate::session::{
    load_session_on_connection, session_close_on_connection, session_delete_on_connection,
    session_list_on_connection,
};
use crate::sessions::{ActiveSession, AgentConnectionHandle, SharedAgentConnections};

type Stdout = Arc<Mutex<tokio::io::Stdout>>;

/// List the sessions an agent has on disk for a working directory.
///
/// Returns `false` only when stdout is broken, which is the caller's signal to stop.
pub(crate) async fn list(
    req: maestro_protocol::SessionListRequest,
    agent_connections: &SharedAgentConnections,
    stdout: &Stdout,
) -> bool {
    let conn_handle = agent_connections
        .lock()
        .await
        .get(&req.agent_id)
        .map(AgentConnectionHandle::from);

    // An agent with no connection has nothing to list, which is an empty answer rather than an
    // error: the picker asks this before anything has been spawned.
    let Some(conn_handle) = conn_handle else {
        return send_response(
            stdout,
            &MaestroRpcMessage::Response(ServerResponse::SessionListOk(SessionListOkResponse {
                sessions: vec![],
                next_cursor: None,
                supports_session_delete: false,
            })),
        )
        .await
        .is_ok();
    };

    let supports_session_delete = conn_handle.capabilities.supports_session_delete;
    let response = match session_list_on_connection(&conn_handle, &req.cwd, req.cursor).await {
        Ok((sessions, next_cursor)) => {
            MaestroRpcMessage::Response(ServerResponse::SessionListOk(SessionListOkResponse {
                sessions,
                next_cursor,
                supports_session_delete,
            }))
        }
        Err(e) => {
            evict_if_same_connection(agent_connections, &req.agent_id, &conn_handle.router).await;
            error_response(e)
        }
    };
    send_response(stdout, &response).await.is_ok()
}

/// Resume a session the agent already has, and register it with the dispatch loop.
pub(crate) async fn load(
    req: maestro_protocol::SessionLoadRequest,
    agent_connections: &SharedAgentConnections,
    agents_with_spawn: &[agent::registry::DiscoveredAgentWithSpawn],
    spawn_result_tx: &tokio::sync::mpsc::Sender<(String, ActiveSession)>,
    stdout: &Stdout,
) -> bool {
    // Resolved before offloading: `agents_with_spawn` is borrowed from the dispatch loop and
    // cannot be moved into the task.
    let Some((cmd, args, env)) =
        resolve_agent_spawn_params(&req.agent_id, agents_with_spawn, stdout).await
    else {
        return true;
    };
    let stdout_task = Arc::clone(stdout);
    let agent_connections_task = Arc::clone(agent_connections);
    let spawn_result_tx = spawn_result_tx.clone();
    // Offloaded so the dispatch loop keeps answering while the agent starts and replays the
    // session, which can take as long as the transcript is.
    tokio::spawn(async move {
        let conn_handle = ensure_and_get_connection(
            &req.agent_id,
            &agent_connections_task,
            &cmd,
            &args,
            &env,
            &req.cwd,
            &stdout_task,
        )
        .await;
        let Some(conn_handle) = conn_handle else {
            return;
        };
        let result = load_session_on_connection(
            &conn_handle,
            req.session_id.clone(),
            req.resume_session_id.clone(),
            &req.cwd,
            &req.additional_directories,
            Arc::clone(&stdout_task),
        )
        .await;
        match result {
            // The error has already been reported to the host by `load_session_on_connection`.
            Err(()) => {
                evict_if_same_connection(
                    &agent_connections_task,
                    &req.agent_id,
                    &conn_handle.router,
                )
                .await
            }
            Ok(None) => {}
            Ok(Some((mut session, models, modes, prompt_caps, config_options))) => {
                session.agent_id = req.agent_id;
                session.cwd = req.cwd;
                session.additional_directories = req.additional_directories;
                let session_id = req.session_id.clone();
                // Handed to the dispatch loop only once the host has been told the session
                // exists, so a registered session is always one the host knows about.
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
                )
                .await
                .is_ok()
                {
                    spawn_result_tx.send((session_id, session)).await.ok();
                }
            }
        }
    });
    true
}

/// Which way a session is being ended.
///
/// Closing releases the agent's handle on a session it keeps; deleting removes the transcript from
/// disk. Two requests, one shape — the only differences are which ACP call is made and which
/// acknowledgement comes back.
#[derive(Clone, Copy)]
pub(crate) enum EndKind {
    Close,
    Delete,
}

pub(crate) async fn end(
    kind: EndKind,
    agent_id: String,
    session_id: String,
    agent_connections: &SharedAgentConnections,
    stdout: &Stdout,
) -> bool {
    let conn_handle = agent_connections
        .lock()
        .await
        .get(&agent_id)
        .map(AgentConnectionHandle::from);

    let result = match (&conn_handle, kind) {
        (Some(handle), EndKind::Close) => {
            session_close_on_connection(handle, session_id.clone()).await
        }
        (Some(handle), EndKind::Delete) => {
            session_delete_on_connection(handle, session_id.clone()).await
        }
        (None, _) => Err(format!(
            "no connection found for agent {} with session {}",
            agent_id, session_id
        )),
    };

    let response = match result {
        Ok(()) => MaestroRpcMessage::Response(match kind {
            EndKind::Close => ServerResponse::SessionCloseOk,
            EndKind::Delete => ServerResponse::SessionDeleteOk,
        }),
        Err(e) => {
            if let Some(handle) = &conn_handle {
                evict_if_same_connection(agent_connections, &agent_id, &handle.router).await;
            }
            error_response(e)
        }
    };
    send_response(stdout, &response).await.is_ok()
}
