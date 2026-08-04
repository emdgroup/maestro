use std::sync::Arc;
use tauri::{Emitter, State};
use crate::core::AppState;

/// List git branches and the current branch for a project
///
/// Returns a tuple of (branches, current_branch).
/// Falls back to ([], "main") if the project is not a git repo or git is unavailable.
#[tauri::command]
#[specta::specta]
pub async fn list_project_branches(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
) -> Result<(crate::git::BranchList, String), String> {
    // Look up the project to get its path
    let project = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        conn.query_row(
            "SELECT id, name, path, created_at, updated_at, last_opened, connection_id, wsl_connection_id, docker_connection_id FROM projects WHERE id = ?",
            [project_id],
            crate::models::Project::from_row,
        )
        .map_err(|e| e.to_string())?
    };

    // Uses get_git_connection directly (not get_project_with_git_conn) because
    // branch listing should fall back to local path when SSH is disconnected,
    // rather than failing entirely.
    let git_conn = crate::core::get_git_connection(&project, &app_state).await
        .unwrap_or_else(|_| crate::models::GitConnection::Local { path: project.path.clone() });

    let (branches, current_branch) = tokio::join!(
        crate::git::list_branches(&git_conn),
        crate::git::get_current_branch(&git_conn),
    );
    let branches = branches.unwrap_or_else(|_| crate::git::BranchList { local: vec![], remote: vec![] });
    let current_branch = current_branch.unwrap_or_else(|_| "main".to_string());

    Ok((branches, current_branch))
}

/// Stop the active ACP or PTY session for a task and move the task back to Planning.
///
/// Searches ACP sessions and PTY session metadata for an entry associated with the
/// given task_id. If found, replicates the teardown logic from cancel_acp_session or
/// close_pty_session respectively. After all async work is done, updates the task
/// status to Planning via the sync DB mutex (never held across an await point).
#[tauri::command]
#[specta::specta]
pub async fn interrupt_task(
    app_state: State<'_, Arc<AppState>>,
    task_id: i32,
) -> Result<(), String> {
    use crate::acp::transport::{MaestroRpcMessage, ServerRequest, CancelRequest};

    // Search ACP sessions by task_id — release lock immediately in scoped block.
    let acp_log_id: Option<i32> = {
        let sessions = app_state.acp.sessions.lock().await;
        sessions
            .iter()
            .find(|(_, proc)| proc.task_id == Some(task_id))
            .map(|(log_id, _)| *log_id)
    };

    // Search PTY session metadata by task_id — release lock immediately in scoped block.
    let pty_log_id: Option<i32> = {
        let session_meta = app_state.pty.session_meta.lock().await;
        session_meta
            .iter()
            .find(|(_, m)| m.task_id == Some(task_id))
            .map(|(log_id, _)| *log_id)
    };

    if acp_log_id.is_none() && pty_log_id.is_none() {
        return Err(format!("No active session for task {}", task_id));
    }

    // Tear down ACP session if found — replicates cancel_acp_session logic.
    if let Some(log_id) = acp_log_id {
        let session_id = format!("session-{}", log_id);
        let cancel_msg = MaestroRpcMessage::Request(ServerRequest::Cancel(CancelRequest { session_id }));
        // Best-effort — maestro-server may already be gone; error is non-fatal.
        let _ = crate::acp::write_to_acp_session(&app_state, log_id, &cancel_msg).await;

        // The shared connection server stays up — see `cancel_acp_session`.
        let mut sessions = app_state.acp.sessions.lock().await;
        if let Some(mut session) = sessions.remove(&log_id) {
            if let Some(cancel_tx) = session.reader_cancel_tx.take() {
                let _ = cancel_tx.send(());
            }
        }
    }

    // Tear down PTY session if found — replicates close_pty_session logic.
    if let Some(session_key) = pty_log_id {
        {
            let mut cancel_map = app_state.pty.attach_cancel.lock().await;
            if let Some(flag) = cancel_map.remove(&session_key) {
                flag.store(true, std::sync::atomic::Ordering::Relaxed);
            }
        }
        app_state.pty.sessions.lock().await.remove(&session_key);
        app_state.ssh.pty_sessions.lock().await.remove(&session_key);
        app_state.pty.session_meta.lock().await.remove(&session_key);
    }

    // All async work is done — acquire sync DB mutex now to update task status.
    {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        crate::task::transition::apply(
            &conn,
            task_id,
            crate::task::transition::TaskTransition::Stopped,
        )?;
    }

    app_state.app_handle.emit("tasks-changed", ()).ok();
    app_state.app_handle.emit("sessions-changed", ()).ok();
    Ok(())
}

/// Move a task on to review by hand, applying the same transition the agent's own completion
/// would.
///
/// The escape hatch for when neither signal fires: an agent that ignores the completion marker
/// and produced no diff — an investigation or a question answered in prose — would otherwise have
/// no way out of In Progress except being dragged back to Planning, losing its pipeline state.
#[tauri::command]
#[specta::specta]
pub async fn send_task_to_review(
    app_state: State<'_, Arc<AppState>>,
    task_id: i32,
) -> Result<crate::models::Task, String> {
    let is_git_repo = crate::acp::reader_task::is_task_project_git_repo(&app_state, task_id).await;

    let task = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        crate::task::transition::apply(
            &conn,
            task_id,
            crate::task::transition::TaskTransition::TurnCompleted { is_git_repo },
        )?
    };

    app_state.app_handle.emit("tasks-changed", ()).ok();
    Ok(task)
}

/// Records that an agent has begun working on a task.
///
/// The execute flow used to reach In Progress by writing `status` through `update_task`, which
/// applies `ManualMove` — the event for a user dragging a card. That parks the task: no phase, no
/// phase status, ball on nobody, so a card sat through its entire run looking idle and never
/// reached the `Blocked` or `Failed` states the rest of the pipeline depends on.
#[tauri::command]
#[specta::specta]
pub fn mark_task_execution_started(
    app_state: State<'_, Arc<AppState>>,
    task_id: i32,
) -> Result<crate::models::Task, String> {
    let task = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        crate::task::transition::apply(
            &conn,
            task_id,
            crate::task::transition::TaskTransition::ExecutionStarted,
        )?
    };

    app_state.app_handle.emit("tasks-changed", ()).ok();
    Ok(task)
}
