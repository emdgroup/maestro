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
// Argument list is the IPC contract: collapsing it into a struct would change the
// generated bindings and every frontend call site.
#[allow(clippy::too_many_arguments)]
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

    let ssh_opt = match connection_id {
        Some(conn_id) => {
            let ssh = app_state.ssh.get_session(conn_id).await
                .ok_or_else(|| format!("No active SSH session for connection_id {}. Connect first.", conn_id))?;
            Some((conn_id, ssh))
        }
        None => None,
    };

    // Routed through the project's own connection rather than rebuilt per connection type: a
    // container project used to fall through to a Local git run against a path that only exists
    // inside the container, and `.ok()` turned the failure into a NULL sha. That silently
    // degrades the review diff to uncommitted-only (both callers of get_acp_session_meta fall
    // back to DiffTarget::Head) and skips the rollback in review.rs.
    //
    // Still best-effort: a session has to start even when HEAD cannot be read.
    let session_start_sha = match crate::core::get_project_with_git_conn(&app_state, project_id).await {
        Ok((_project, git_conn)) => crate::git::run_git_in_dir(&git_conn, &cwd, &["rev-parse", "HEAD"])
            .await.ok().map(|s| s.trim().to_string()),
        Err(e) => {
            log::warn!("[acp] cannot resolve connection for project {project_id} to read session start sha: {e}");
            None
        }
    };

    // Persist execution_start_sha to the task for rollback capability. A task that already
    // has one keeps it: resuming a session would otherwise re-anchor at the current HEAD and
    // hide every change the previous run made. `review.rs` clears it once the task is merged.
    let session_start_sha = match task_id {
        Some(tid) => {
            let conn = app_state.db.lock().map_err(|e| format!("Lock: {}", e))?;
            let stored: Option<String> = conn.query_row(
                "SELECT execution_start_sha FROM tasks WHERE id = ?",
                rusqlite::params![tid],
                |row| row.get(0),
            ).map_err(|e| format!("Failed to read execution_start_sha: {}", e))?;
            match stored.filter(|sha| !sha.is_empty()) {
                Some(sha) => Some(sha),
                None => {
                    if let Some(ref sha) = session_start_sha {
                        conn.execute(
                            "UPDATE tasks SET execution_start_sha = ? WHERE id = ?",
                            rusqlite::params![sha, tid],
                        ).map_err(|e| format!("Failed to save execution_start_sha: {}", e))?;
                    }
                    session_start_sha
                }
            }
        }
        None => session_start_sha,
    };

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
    // Ensure the shared Local maestro-server is running before the fast path so that all
    // Local sessions go through a single process. This keeps agent_connections alive across
    // auth_required, allowing acp_authenticate/acp_start_auth_terminal to succeed.
    if matches!(connection_key, ConnectionKey::Local) {
        crate::acp::spawn_connection_server(
            ConnectionKey::Local,
            crate::acp::TransportTarget::Local,
            &app_state,
        ).await?;
    }
    if crate::acp::try_spawn_via_connection_server(
        &session_id,
        TaskMetadata { task_id, task_name: task_name.clone(), branch_name: branch_name.clone(), session_start_sha: session_start_sha.clone() },
        &req,
    ).await? {
        return Ok(finish_spawn(&app_state, task_id, log_id).await);
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

    Ok(finish_spawn(&app_state, task_id, log_id).await)
}

/// What every successful spawn does once its session exists, whichever path built it.
///
/// One function rather than a copy per return, because the two paths have to agree that a spawn is
/// only finished when the sessions it replaces are gone. Superseding *after* the new session is
/// registered, never before: a spawn that fails must leave the task holding the session it already
/// had rather than none at all.
async fn finish_spawn(
    app_state: &Arc<AppState>,
    task_id: Option<i32>,
    log_id: i32,
) -> SpawnSessionResult {
    if let Some(task_id) = task_id {
        close_superseded_sessions_for_task(app_state, task_id, log_id).await;
    }
    app_state.app_handle.emit("sessions-changed", ()).ok();
    SpawnSessionResult { log_id }
}

/// Cancel a running ACP session — kills the maestro-server subprocess and cleans up.
#[tauri::command]
#[specta::specta]
pub async fn cancel_acp_session(
    app_state: State<'_, Arc<AppState>>,
    log_id: i32,
) -> Result<(), String> {
    end_acp_session(&app_state, log_id).await;
    Ok(())
}

/// Stop a session and forget it, without touching the task it was working for.
///
/// The half of `end_acp_session` that is about the session rather than the task. Split out because
/// superseding a session must *not* fail its task — the task is mid-spawn for the replacement, and
/// `fail_if_agent_running` would redden the card on every handoff. Shared rather than copied: the
/// one other place that tears a session down by hand, `interrupt_task`, has already drifted from
/// this, and a third copy would drift too.
///
/// Returns the session's project and task ids, which the caller needs for its own bookkeeping.
pub(crate) async fn tear_down_session(
    app_state: &Arc<AppState>,
    log_id: i32,
) -> (Option<i32>, Option<i32>) {
    use crate::acp::transport::{CancelRequest, MaestroRpcMessage, ServerRequest};

    let session_id = session_id_for(log_id);
    let cancel_msg = MaestroRpcMessage::Request(ServerRequest::Cancel(CancelRequest { session_id }));
    if let Err(e) = crate::acp::write_to_acp_session(app_state, log_id, &cancel_msg).await {
        // Best-effort: the transport may already be gone, which is one of the reasons to cancel.
        // The teardown below is what actually ends the session, so it proceeds regardless.
        log::debug!("[acp] cancel message not delivered for log_id={log_id}: {e}");
    }

    // The connection server outlives its sessions deliberately: it is per connection, not per
    // session, and closing the last session used to drop it, which killed the transport and
    // surfaced as a lost connection. It is torn down when the project or the app closes.
    let mut sessions = app_state.acp.sessions.lock().await;
    let project_id = sessions.get(&log_id).and_then(|p| p.project_id);
    let task_id = sessions.get(&log_id).and_then(|p| p.task_id);
    if let Some(mut session) = sessions.remove(&log_id) {
        if let Some(cancel_tx) = session.reader_cancel_tx.take() {
            let _ = cancel_tx.send(());
        }
    }
    (project_id, task_id)
}

/// Which live sessions this task no longer needs.
///
/// Takes ids rather than the session map so the rule can be tested: `AcpProcess` owns a subprocess,
/// a writer and a cancel channel, none of which a test can conjure, and the two things that could
/// be wrong here are ordinary — closing the session that was just built, or closing one belonging
/// to another task.
fn superseded_log_ids(
    live: impl Iterator<Item = (i32, Option<i32>)>,
    task_id: i32,
    keep_log_id: i32,
) -> Vec<i32> {
    live.filter(|(log_id, owner)| *log_id != keep_log_id && *owner == Some(task_id))
        .map(|(log_id, _)| log_id)
        .collect()
}

/// Close any other live session belonging to `task_id`, keeping `keep_log_id`.
///
/// A task runs one role at a time but got a new session for each: `resolve_turn_end` moves the task
/// and never touches `acp.sessions`, so a coder's session was still open while its reviewer ran, and
/// the reviewer's while the next coder ran. One live task was observed holding five. That is not
/// only untidy — `occupied_slots` counts every session carrying a task id, so those five were five
/// slots and ~2 GB against the host's agent limit for work one of them was doing.
///
/// Nothing the pipeline needs is lost. The reviewer reads the diff, not the coder's transcript, and
/// the plan interception already establishes that a role's session has no part in the next role's
/// work. `session_aliases` keeps the history entry either way.
pub(crate) async fn close_superseded_sessions_for_task(
    app_state: &Arc<AppState>,
    task_id: i32,
    keep_log_id: i32,
) {
    // Collected before tearing anything down: `tear_down_session` takes the same lock.
    let superseded = {
        let sessions = app_state.acp.sessions.lock().await;
        superseded_log_ids(
            sessions.iter().map(|(log_id, process)| (*log_id, process.task_id)),
            task_id,
            keep_log_id,
        )
    };

    if superseded.is_empty() {
        return;
    }

    for log_id in &superseded {
        tear_down_session(app_state, *log_id).await;
    }
    log::debug!(
        "[acp] task {task_id} kept session {keep_log_id} and closed {} superseded: {superseded:?}",
        superseded.len()
    );

    app_state.app_handle.emit("sessions-changed", ()).ok();
}

/// The body of `cancel_acp_session`, reachable from inside the backend.
///
/// The command form takes Tauri's `State`, which nothing running in a reader loop has. Split out
/// because the plan interception ends the planner's session itself: a plan and its implementation
/// can be different agents entirely, so the session that produced the plan has no part in carrying
/// it out and is closed at the moment the plan is taken.
pub(crate) async fn end_acp_session(app_state: &Arc<AppState>, log_id: i32) {
    // This used to refuse outright when the owning task was InProgress or Review, telling the user
    // to press a Stop button that does not exist on a Review card — and, because the callers
    // swallowed the error, "Force end session" in the agent monitor silently did nothing in the
    // stale-connection case it exists for. What the guard was protecting is handled below instead:
    // the task is failed here rather than being refused.
    let (project_id_for_save, task_id) = tear_down_session(app_state, log_id).await;

    // Recorded here, not left to `reader_task`. Only a *direct* session has a reader loop that a
    // cancel breaks; a session on a shared connection server — the ordinary local path — has no
    // per-session loop, so nothing there would ever observe this and the task would go on claiming
    // an agent was working on it. Doing it here also covers the direct case, harmlessly:
    // `fail_if_agent_running` is a no-op once the phase is no longer Running or Blocked, so the
    // reader firing afterwards changes nothing. A task parked at a review gate is left alone.
    if let Some(task_id) = task_id {
        let failed = match app_state.db.lock() {
            Ok(conn) => crate::task::transition::fail_if_agent_running(&conn, task_id)
                .unwrap_or_else(|e| {
                    log::warn!("[acp] could not fail task {} after cancel: {}", task_id, e);
                    None
                }),
            Err(e) => {
                log::warn!("[acp] lock failed while failing task {}: {}", task_id, e);
                None
            }
        };
        if failed.is_some() {
            app_state.app_handle.emit("tasks-changed", ()).ok();
        }
    }

    app_state.app_handle.emit("sessions-changed", ()).ok();
    if let Some(pid) = project_id_for_save {
        let state = Arc::clone(app_state);
        tokio::spawn(crate::project::handlers::save_current_sessions_for_project(state, pid));
    }
}

/// Interrupt the current ACP turn without killing the session.
#[tauri::command]
#[specta::specta]
pub async fn interrupt_acp_turn(
    app_state: State<'_, Arc<AppState>>,
    log_id: i32,
) -> Result<(), String> {
    use crate::acp::transport::{MaestroRpcMessage, ServerRequest, InterruptTurnRequest};

    // Recorded before the request goes out, so the flag is already set whenever the turn ending it
    // provokes comes back. `resolve_turn_end` reads it to keep a stopped phase from advancing —
    // see the field's own comment for why the stop reason cannot be trusted to say so.
    {
        let sessions = app_state.acp.sessions.lock().await;
        if let Some(session) = sessions.get(&log_id) {
            session.user_interrupted.store(true, std::sync::atomic::Ordering::Release);
        }
    }

    let session_id = session_id_for(log_id);
    let msg = MaestroRpcMessage::Request(ServerRequest::InterruptTurn(InterruptTurnRequest {
        session_id,
    }));
    crate::acp::write_to_acp_session(&app_state, log_id, &msg).await
}

/// Inner implementation shared by the IPC handler and warmup session restore.
// Kept in step with the IPC handler's argument list so the two stay easy to compare.
#[allow(clippy::too_many_arguments)]
pub async fn restore_acp_session(
    app_state: &Arc<AppState>,
    agent_id: String,
    acp_session_id: String,
    cwd: String,
    connection: crate::acp::ConnectionKey,
    session_name: Option<String>,
    project_id: Option<i32>,
    worktree_branch: Option<String>,
    task_id: Option<i32>,
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
        task_id,
        app_state: Arc::clone(app_state),
    };

    if crate::acp::try_session_load_via_connection_server(&acp_session_id, &req).await? {
        if let Some(ref branch) = worktree_branch {
            if let Some(proc) = app_state.acp.sessions.lock().await.get_mut(&log_id) {
                proc.branch_name = Some(branch.clone());
            }
        }
        app_state.app_handle.emit("sessions-changed", ()).ok();
        if let Some(pid) = project_id {
            let state = Arc::clone(app_state);
            tokio::spawn(crate::project::handlers::save_current_sessions_for_project(state, pid));
        }
        return Ok(log_id);
    }

    // Cold path
    match connection_key {
        ConnectionKey::Ssh { id: conn_id } => {
            let (ssh, maestro_path) = crate::acp::resolve_remote_context(app_state, conn_id).await?;
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
        ConnectionKey::Docker { id: docker_id } => {
            let container_name = {
                let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
                conn.query_row(
                    "SELECT container_name FROM docker_connections WHERE id = ?",
                    [docker_id],
                    |row| row.get::<_, String>(0),
                ).map_err(|e| format!("Docker connection {} not found: {}", docker_id, e))?
            };
            let cli = crate::connectivity::docker::ContainerCli::detect()
                .map_err(|e| format!("No container CLI found: {}", e))?;
            let maestro_path = {
                let cached = app_state.acp.discovery_cache.lock().await
                    .get(&ConnectionKey::Docker { id: docker_id })
                    .and_then(|e| e.maestro_server_path.clone());
                match cached {
                    Some(p) => p,
                    None => crate::acp::deploy::ensure_container_server(&cli, &container_name, &app_state.app_handle)
                        .await
                        .map_err(|e| format!("Failed to deploy maestro-server to container: {}", e))?
                        .path,
                }
            };
            crate::acp::load_acp_session_cold(
                crate::acp::TransportTarget::Docker { cli: &cli, container_name: &container_name, server_path: &maestro_path },
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
    // Session in map with acp_session_id set; persist so it survives restart.
    if let Some(pid) = project_id {
        let state = Arc::clone(app_state);
        tokio::spawn(crate::project::handlers::save_current_sessions_for_project(state, pid));
    }
    Ok(log_id)
}

/// Load an existing ACP session — spawns a full session that resumes from a stored agent session.
#[tauri::command]
#[specta::specta]
// Argument list is the IPC contract: collapsing it into a struct would change the
// generated bindings and every frontend call site.
#[allow(clippy::too_many_arguments)]
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
    restore_acp_session(&app_state, agent_id, acp_session_id, cwd, connection, session_name, project_id, worktree_branch, None).await
}

/// Recover a lost task session by reloading it from the stored snapshot in `.maestro/state.json`.
/// Used when the task is InProgress in the DB but has no live session (process died, connection dropped).
#[tauri::command]
#[specta::specta]
pub async fn recover_task_session(
    app_state: State<'_, Arc<AppState>>,
    task_id: i32,
    project_id: i32,
) -> Result<i32, String> {
    let (project_path, connection_key) = {
        let conn = app_state.db.lock().map_err(|e| format!("DB lock failed: {}", e))?;
        conn.query_row(
            "SELECT path, connection_id, wsl_connection_id, docker_connection_id FROM projects WHERE id = ?",
            [project_id],
            |row| Ok((
                row.get::<_, String>(0)?,
                crate::acp::ConnectionKey::from_all_ids(row.get(1)?, row.get(2)?, row.get(3)?)
            )),
        ).map_err(|e| format!("Project not found: {}", e))?
    };

    let snapshots = crate::project::session_state::read_session_snapshots(
        &app_state, &project_path, connection_key,
    ).await;

    let snapshot = snapshots.into_iter()
        .find(|s| s.task_id == Some(task_id))
        .ok_or_else(|| format!("No recoverable session for task {}", task_id))?;

    restore_acp_session(
        &app_state,
        snapshot.agent_id,
        snapshot.acp_session_id,
        snapshot.cwd,
        snapshot.connection_key,
        snapshot.session_name,
        Some(project_id),
        snapshot.branch_name,
        Some(task_id),
    ).await
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

#[cfg(test)]
mod tests {
    use super::*;

    /// The review loop is what made this necessary: coder → reviewer → coder leaves a session
    /// behind at every handoff, and one live task was observed holding five. Each of them counts
    /// against the host's agent limit in `occupied_slots`, which filters on `task_id.is_some()`
    /// with no notion of a session having been superseded.
    #[test]
    fn a_new_session_supersedes_the_task_s_older_ones() {
        let live = [(10, Some(7)), (11, Some(7)), (12, Some(7))];

        let closing = superseded_log_ids(live.into_iter(), 7, 12);

        assert_eq!(closing, vec![10, 11]);
    }

    /// The two ways this could be actively harmful rather than merely useless.
    #[test]
    fn it_keeps_the_new_session_and_leaves_other_tasks_alone() {
        let live = [(10, Some(7)), (11, Some(8)), (12, None), (13, Some(7))];

        let closing = superseded_log_ids(live.into_iter(), 7, 13);

        assert_eq!(closing, vec![10], "task 8's session and the task-less one are not ours");
        assert!(!closing.contains(&13), "the session just spawned must survive its own supersede");
    }

    /// The ordinary case, and the one that runs on every first spawn: nothing to close.
    #[test]
    fn a_task_s_first_session_supersedes_nothing() {
        assert!(superseded_log_ids([(10, Some(7))].into_iter(), 7, 10).is_empty());
        assert!(superseded_log_ids([].into_iter(), 7, 10).is_empty());
    }
}
