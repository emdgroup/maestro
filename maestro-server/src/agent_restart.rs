use std::sync::Arc;

use maestro_protocol::{MaestroRpcMessage, ServerResponse, SessionLoadOkResponse, TurnEnded};
use tokio::sync::Mutex;

use crate::agent;
use crate::helpers::{resolve_agent_spawn_params, send_diag, send_response};
use crate::session::{load_session_on_connection, pre_initialize_agent};
use crate::sessions::{AgentConnectionHandle, SessionMap, SharedAgentConnections};

pub(crate) async fn handle_agent_restart(
    dead_agent_id: String,
    agent_connections: &SharedAgentConnections,
    sessions: &mut SessionMap,
    agents_with_spawn: &[agent::registry::DiscoveredAgentWithSpawn],
    stdout: &Arc<Mutex<tokio::io::Stdout>>,
) {
    send_diag("warn", format!("[agent] {dead_agent_id:?} connection dead"));

    let is_dead = agent_connections
        .lock()
        .await
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
