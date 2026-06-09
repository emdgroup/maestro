use std::sync::Arc;
use tauri::State;
use tauri::Emitter;
use serde::Serialize;
use specta::Type;

use crate::core::AppState;
use crate::acp::{SessionRequest, TaskMetadata, ConnectionKey};

use super::session_id_for;

#[derive(Debug, Clone, Serialize, Type)]
#[specta(export)]
pub struct SpawnSessionResult {
    pub log_id: i32,
}

#[tauri::command]
#[specta::specta]
pub async fn spawn_acp_session(
    app_state: State<'_, Arc<AppState>>,
    agent_id: String,
    cwd: String,
    session_name: Option<String>,
    project_id: i32,
    connection: crate::acp::ConnectionKey,
    worktree_branch: Option<String>,
    task_id: Option<i32>,
    task_name: Option<String>,
) -> Result<SpawnSessionResult, String> {
    let connection_id = connection.ssh_id();
    let wsl_connection_id = connection.wsl_id();

    let branch_name: Option<String> = worktree_branch.or_else(|| {
        std::path::Path::new(&cwd)
            .file_name()
            .and_then(|n| n.to_str())
            .and_then(|basename| {
                let conn = app_state.db.lock().ok()?;
                conn.query_row(
                    "SELECT branch_name FROM worktrees WHERE project_id = ?1 AND (path = ?2 OR path LIKE '%/' || ?2) LIMIT 1",
                    rusqlite::params![project_id, basename],
                    |row| row.get(0),
                ).ok()
            })
    });

    let log_id = app_state.pty.session_counter.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let session_id = session_id_for(log_id);

    let (session_start_sha, ssh_opt) = if let Some(conn_id) = connection_id {
        let ssh = app_state.ssh.get_session(conn_id).await
            .ok_or_else(|| format!("No active SSH session for connection_id {}. Connect first.", conn_id))?;
        let git_conn = crate::models::GitConnection::Remote {
            ssh: std::sync::Arc::new(ssh.clone()),
            remote_path: cwd.clone(),
        };
        let sha = crate::git::run_git_in_dir(&git_conn, &cwd, &["rev-parse", "HEAD"])
            .await.ok().map(|s| s.trim().to_string());
        (sha, Some((conn_id, ssh)))
    } else if let Some(wsl_id) = wsl_connection_id {
        let distro: String = {
            let db = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
            db.query_row(
                "SELECT distro_name FROM wsl_connections WHERE id = ?",
                [wsl_id],
                |row| row.get(0),
            ).map_err(|e| format!("WSL connection not found: {}", e))?
        };
        let git_conn = crate::models::GitConnection::Wsl { distro, path: cwd.clone() };
        let sha = crate::git::run_git_in_dir(&git_conn, &cwd, &["rev-parse", "HEAD"])
            .await.ok().map(|s| s.trim().to_string());
        (sha, None)
    } else {
        let git_conn = crate::models::GitConnection::Local { path: cwd.clone() };
        let sha = crate::git::run_git_in_dir(&git_conn, &cwd, &["rev-parse", "HEAD"])
            .await.ok().map(|s| s.trim().to_string());
        (sha, None)
    };

    // Persist execution_start_sha to the task for rollback capability
    if let Some(tid) = task_id {
        if let Some(ref sha) = session_start_sha {
            let conn = app_state.db.lock().map_err(|e| format!("Lock: {}", e))?;
            conn.execute(
                "UPDATE tasks SET execution_start_sha = ? WHERE id = ?",
                rusqlite::params![sha, tid],
            ).map_err(|e| format!("Failed to save execution_start_sha: {}", e))?;
        }
    }

    let connection_key = connection;
    let req = SessionRequest {
        connection_key,
        agent_id: agent_id.clone(),
        cwd: cwd.clone(),
        log_id,
        session_name: session_name.clone(),
        project_id: Some(project_id),
        task_id: None,
        app_state: Arc::clone(&*app_state),
    };
    if crate::acp::try_spawn_via_connection_server(
        &session_id,
        TaskMetadata { task_id, task_name: task_name.clone(), branch_name: branch_name.clone(), session_start_sha: session_start_sha.clone() },
        &req,
    ).await? {
        app_state.app_handle.emit("sessions-changed", ()).ok();
        return Ok(SpawnSessionResult { log_id });
    }

    // Cold path
    match ssh_opt {
        Some((conn_id, ssh)) => {
            let maestro_path = {
                let cache = app_state.acp.discovery_cache.lock().await;
                cache.get(&ConnectionKey::Ssh { id: conn_id })
                    .and_then(|e| e.maestro_server_path.clone())
                    .ok_or_else(|| format!(
                        "maestro-server path not cached for connection {}. Reconnect to refresh.",
                        conn_id
                    ))?
            };
            let req = SessionRequest {
                connection_key: ConnectionKey::Ssh { id: conn_id },
                ..req
            };
            crate::acp::spawn_acp_session_cold(
                crate::acp::TransportTarget::Remote { ssh: &ssh, server_path: &maestro_path },
                &session_id,
                TaskMetadata { task_id, task_name: task_name.clone(), branch_name, session_start_sha },
                &req,
            ).await?;
        }
        None => {
            if let Some(wsl_id) = wsl_connection_id {
                let distro = {
                    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
                    conn.query_row(
                        "SELECT distro_name FROM wsl_connections WHERE id = ?",
                        [wsl_id],
                        |row| row.get::<_, String>(0),
                    ).map_err(|e| format!("WSL connection {} not found: {}", wsl_id, e))?
                };
                let req = SessionRequest { connection_key: ConnectionKey::Wsl { id: wsl_id }, ..req };
                #[cfg(windows)]
                {
                    let maestro_path = {
                        let cached = app_state.acp.discovery_cache.lock().await
                            .get(&ConnectionKey::Wsl { id: wsl_id })
                            .and_then(|e| e.maestro_server_path.clone());
                        match cached {
                            Some(p) => p,
                            None => crate::acp::deploy::ensure_wsl_server(&distro, &app_state.app_handle)
                                .await
                                .map_err(|e| format!("Failed to deploy maestro-server to WSL: {}", e))?
                                .path,
                        }
                    };
                    crate::acp::spawn_acp_session_cold(
                        crate::acp::TransportTarget::Wsl { distro: &distro, server_path: &maestro_path },
                        &session_id,
                        TaskMetadata { task_id, task_name: task_name.clone(), branch_name, session_start_sha },
                        &req,
                    ).await?;
                }
                #[cfg(not(windows))]
                {
                    let _ = (distro, req);
                    return Err("WSL connections are only supported on Windows".to_string());
                }
            } else {
                crate::acp::spawn_acp_session_cold(
                    crate::acp::TransportTarget::Local,
                    &session_id,
                    TaskMetadata { task_id, task_name, branch_name, session_start_sha },
                    &req,
                ).await?;
            }
        }
    }

    app_state.app_handle.emit("sessions-changed", ()).ok();
    Ok(SpawnSessionResult { log_id })
}

/// Cancel a running ACP session — kills the maestro-server subprocess and cleans up.
#[tauri::command]
#[specta::specta]
pub async fn cancel_acp_session(
    app_state: State<'_, Arc<AppState>>,
    log_id: i32,
) -> Result<(), String> {
    use crate::acp::transport::{MaestroRpcMessage, ServerRequest, CancelRequest};

    let session_id = session_id_for(log_id);
    let cancel_msg = MaestroRpcMessage::Request(ServerRequest::Cancel(CancelRequest { session_id }));
    let _ = crate::acp::write_to_acp_session(&app_state, log_id, &cancel_msg).await;

    let teardown_key: Option<ConnectionKey> = {
        let mut sessions = app_state.acp.sessions.lock().await;
        let removed = sessions.remove(&log_id);
        let conn_key = removed.as_ref()
            .filter(|s| s.child.is_none())
            .map(|s| s.connection_key);
        if let Some(mut session) = removed {
            if let Some(cancel_tx) = session.reader_cancel_tx.take() {
                let _ = cancel_tx.send(());
            }
        }
        conn_key
            .filter(|k| !sessions.values().any(|s| &s.connection_key == k && s.child.is_none()))
    };

    if let Some(key) = teardown_key {
        app_state.acp.connection_servers.lock().await.remove(&key);
    }

    app_state.app_handle.emit("sessions-changed", ()).ok();
    Ok(())
}

/// Interrupt the current ACP turn without killing the session.
#[tauri::command]
#[specta::specta]
pub async fn interrupt_acp_turn(
    app_state: State<'_, Arc<AppState>>,
    log_id: i32,
) -> Result<(), String> {
    use crate::acp::transport::{MaestroRpcMessage, ServerRequest, InterruptTurnRequest};

    let session_id = session_id_for(log_id);
    let msg = MaestroRpcMessage::Request(ServerRequest::InterruptTurn(InterruptTurnRequest {
        session_id,
    }));
    crate::acp::write_to_acp_session(&app_state, log_id, &msg).await
}

/// Load an existing ACP session — spawns a full session that resumes from a stored agent session.
#[tauri::command]
#[specta::specta]
pub async fn load_acp_session(
    app_state: State<'_, Arc<AppState>>,
    agent_id: String,
    acp_session_id: String,
    cwd: String,
    connection: crate::acp::ConnectionKey,
    session_name: Option<String>,
    project_id: Option<i32>,
    worktree_branch: Option<String>,
) -> Result<i32, String> {
    let log_id = app_state.pty.session_counter.fetch_add(1, std::sync::atomic::Ordering::Relaxed);

    let connection_key = connection;
    let req = SessionRequest {
        connection_key,
        agent_id: agent_id.clone(),
        cwd: cwd.clone(),
        log_id,
        session_name: session_name.clone(),
        project_id,
        task_id: None,
        app_state: Arc::clone(&*app_state),
    };

    if crate::acp::try_session_load_via_connection_server(&acp_session_id, &req).await? {
        if let Some(ref branch) = worktree_branch {
            if let Some(proc) = app_state.acp.sessions.lock().await.get_mut(&log_id) {
                proc.branch_name = Some(branch.clone());
            }
        }
        app_state.app_handle.emit("sessions-changed", ()).ok();
        return Ok(log_id);
    }

    // Cold path
    match connection_key {
        ConnectionKey::Ssh { id: conn_id } => {
            let (ssh, maestro_path) = crate::acp::resolve_remote_context(&app_state, conn_id).await?;
            crate::acp::load_acp_session_cold(
                crate::acp::TransportTarget::Remote { ssh: &ssh, server_path: &maestro_path },
                &acp_session_id,
                &req,
            ).await?;
        }
        ConnectionKey::Wsl { id: wsl_id } => {
            let distro = {
                let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
                conn.query_row(
                    "SELECT distro_name FROM wsl_connections WHERE id = ?",
                    [wsl_id],
                    |row| row.get::<_, String>(0),
                ).map_err(|e| format!("WSL connection {} not found: {}", wsl_id, e))?
            };
            #[cfg(windows)]
            {
                let maestro_path = {
                    let cached = app_state.acp.discovery_cache.lock().await
                        .get(&ConnectionKey::Wsl { id: wsl_id })
                        .and_then(|e| e.maestro_server_path.clone());
                    match cached {
                        Some(p) => p,
                        None => crate::acp::deploy::ensure_wsl_server(&distro, &app_state.app_handle)
                            .await
                            .map_err(|e| format!("Failed to deploy maestro-server to WSL: {}", e))?
                            .path,
                    }
                };
                crate::acp::load_acp_session_cold(
                    crate::acp::TransportTarget::Wsl { distro: &distro, server_path: &maestro_path },
                    &acp_session_id,
                    &req,
                ).await?;
            }
            #[cfg(not(windows))]
            {
                let _ = distro;
                return Err("WSL connections are only supported on Windows".to_string());
            }
        }
        ConnectionKey::Local => {
            crate::acp::load_acp_session_cold(
                crate::acp::TransportTarget::Local,
                &acp_session_id,
                &req,
            ).await?;
        }
    }

    if let Some(ref branch) = worktree_branch {
        if let Some(proc) = app_state.acp.sessions.lock().await.get_mut(&log_id) {
            proc.branch_name = Some(branch.clone());
        }
    }

    app_state.app_handle.emit("sessions-changed", ()).ok();
    Ok(log_id)
}

/// Close an ACP session stored on the agent server (not a live Tauri session).
#[tauri::command]
#[specta::specta]
pub async fn close_acp_session(
    app_state: State<'_, Arc<AppState>>,
    agent_id: String,
    session_id: String,
    cwd: String,
    connection: crate::acp::ConnectionKey,
) -> Result<(), String> {
    use crate::acp::transport::SessionCloseRequest;

    crate::acp::query_session_close_via_server(
        connection,
        SessionCloseRequest { agent_id, session_id, cwd },
        &app_state,
    )
    .await
}
