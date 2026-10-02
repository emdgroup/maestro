use std::sync::Arc;

use maestro_protocol::{ServerResponse, SessionLoadOkResponse, TurnEnded};

use crate::agent;
use crate::helpers::{resolve_agent_spawn_params, send_diag, send_response};
use crate::session::{load_session_on_connection, pre_initialize_agent};
use crate::sessions::{AgentConnectionHandle, SessionMap, SharedAgentConnections};

pub(crate) async fn handle_agent_restart(
    dead_agent_id: String,
    agent_connections: &SharedAgentConnections,
    sessions: &mut SessionMap,
    agents_with_spawn: &[agent::registry::DiscoveredAgentWithSpawn],
    project_store: Option<&crate::project_store::Store>,
    stdout: &crate::ClientOut,
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
    let to_restore: Vec<(String, String, String, Vec<String>)> = sessions
        .iter()
        .filter(|(_, s)| s.agent_id == dead_agent_id)
        .filter_map(|(sid, s)| {
            s.cleanup.as_ref().map(|c| {
                (
                    sid.clone(),
                    c.acp_session_id.clone(),
                    s.cwd.clone(),
                    s.additional_directories.clone(),
                )
            })
        })
        .collect();

    let mut carried = std::collections::HashMap::new();
    for (maestro_sid, _, _, _) in &to_restore {
        if let Some(mut session) = sessions.remove(maestro_sid) {
            session.task.abort();
            fail_task(project_store, stdout, session.project.as_ref());
            carried.insert(maestro_sid.clone(), session.project.take());
            // Dormant until the reload below succeeds, so a session that does not make it back is
            // not left looking live.
            if let Some(store) = project_store {
                crate::project_store::report(crate::project_store::go_dormant(
                    &*store.lock().await,
                    maestro_sid,
                    chrono::Utc::now(),
                ));
            }
            let _ = send_response(
                stdout,
                &ServerResponse::TurnEnded(TurnEnded {
                    session_id: maestro_sid.clone(),
                    stop_reason: "error".to_string(),
                }),
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
            fail_task(project_store, stdout, session.project.as_ref());
            let _ = send_response(
                stdout,
                &ServerResponse::TurnEnded(TurnEnded {
                    session_id: maestro_sid.clone(),
                    stop_reason: "error".to_string(),
                }),
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
        for (maestro_sid, acp_session_id, session_cwd, session_roots) in &to_restore {
            let result = load_session_on_connection(
                &conn_handle,
                maestro_sid.clone(),
                acp_session_id.clone(),
                &dead_agent_id,
                session_cwd,
                session_roots,
                Arc::clone(stdout),
            )
            .await;
            if let Ok(Some((mut session, models, modes, prompt_caps, config_options))) = result {
                session.agent_id = dead_agent_id.clone();
                session.cwd = session_cwd.clone();
                session.additional_directories = session_roots.clone();
                session.project = carried.remove(maestro_sid).flatten();
                if let Some(store) = project_store {
                    crate::project_store::report(crate::project_store::revive(
                        &*store.lock().await,
                        &dead_agent_id,
                        acp_session_id,
                        maestro_sid,
                    ));
                }
                sessions.insert(maestro_sid.clone(), session);
                let _ = send_response(
                    stdout,
                    &ServerResponse::SessionLoadOk(SessionLoadOkResponse {
                        session_id: maestro_sid.clone(),
                        models,
                        modes,
                        prompt_capabilities: Some(prompt_caps),
                        config_options,
                    }),
                )
                .await;
            }
        }
    }

    agent_connections
        .lock()
        .await
        .insert(dead_agent_id, new_conn);
}

/// The agent under a task's session died mid-phase: fail the task if an agent was still working
/// it, as the app does when a session's reader ends. Spawned, so this loop's future stays small.
fn fail_task(
    project_store: Option<&crate::project_store::Store>,
    stdout: &crate::ClientOut,
    binding: Option<&crate::sessions::ProjectBinding>,
) {
    let (Some(store), Some(binding)) = (project_store, binding) else {
        return;
    };
    let Some(task_id) = binding.meta.task_id else {
        return;
    };
    let (store, stdout, project_path) = (
        Arc::clone(store),
        Arc::clone(stdout),
        binding.project_path.clone(),
    );
    tokio::spawn(async move {
        crate::task_turn::fail_if_still_running(&store, &stdout, &project_path, task_id).await;
    });
}
