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

/// Stop the active ACP or PTY session for a task, then abandon everything the run produced.
///
/// Stop is abandonment, not a pause: the worktree and its branch are deleted and the task returns
/// to Planning as if it had never run. There is no resume — a stopped task is executed again from
/// the backlog, which cannot start from a half-finished tree, and leaving the worktree behind
/// would strand it with nothing in the UI pointing at it.
///
/// Searches ACP sessions and PTY session metadata for an entry associated with the given task_id.
/// If found, replicates the teardown logic from cancel_acp_session or close_pty_session
/// respectively. A task with no live session is not an error: its session may have died on its
/// own, and the worktree it left behind is exactly what still needs discarding. After all async
/// work is done, updates the task status via the sync DB mutex (never held across an await point).
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

    // Session teardown is done — acquire sync DB mutex now to update task status.
    {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        crate::task::transition::apply(
            &conn,
            task_id,
            crate::task::transition::TaskTransition::Stopped,
        )?;
    }

    crate::git::worktree_lifecycle::discard_task_workspace(&app_state, task_id).await?;

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
///
/// Returns `None` when the task demonstrably changed nothing and `force` is not set. The automatic
/// path refuses exactly this case, holding the task in place rather than opening a review with an
/// empty diff; without the same check here the button would manufacture the state the rest of the
/// pipeline exists to prevent. It is a warning and not a veto — the caller may set `force` — because
/// an override the user cannot override is not an escape hatch.
///
/// Only a definite `Some(false)` blocks. `None` means the question could not be answered — a
/// non-git project, a missing worktree — and is treated as no evidence, matching `classify_turn`.
#[tauri::command]
#[specta::specta]
pub async fn send_task_to_review(
    app_state: State<'_, Arc<AppState>>,
    task_id: i32,
    force: bool,
) -> Result<Option<crate::models::Task>, String> {
    let is_git_repo = crate::acp::reader_task::is_task_project_git_repo(&app_state, task_id).await;

    let has_changes = if is_git_repo {
        crate::acp::reader_task::task_has_changes(&app_state, task_id).await
    } else {
        None
    };

    if !force && has_changes == Some(false) {
        return Ok(None);
    }

    // Forcing is the user setting the empty-diff evidence aside and asking for a review anyway, so
    // the transition is told there is none — `None` routes to the review gate, which is the point
    // of the button. Passing `Some(false)` through would send the task to Done instead, which is
    // the one place the user has just declined to go.
    let has_changes = if force { None } else { has_changes };

    // Sending work to review by hand is still asking for it to be reviewed, so a project with a
    // review agent gets one here too. Doing otherwise would make the button a way of skipping the
    // reviewer, which nothing on it says it is.
    let reviewer_pending =
        crate::acp::reader_task::reviewer_should_run(&app_state, task_id).await;

    let task = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        crate::task::transition::apply(
            &conn,
            task_id,
            crate::task::transition::TaskTransition::TurnCompleted {
                is_git_repo,
                has_changes,
                reviewer_pending,
            },
        )?
    };

    app_state.app_handle.emit("tasks-changed", ()).ok();
    Ok(Some(task))
}

/// Claims a task for execution, before anything is spawned.
///
/// The claim is the start of the spawn, not the end of it. The task keeps its column and takes the
/// `Spawning` phase, which does three things at once: the board shows that the task is being
/// started, the queue drain stops re-picking it, and a spawn that fails leaves it where the user
/// launched it rather than stranded in In Progress.
///
/// Returns `None` when the task is not in a column execution can start from, or when it is already
/// being spawned. The second case is what stops two clicks, or a click racing the auto-mode drain,
/// from building two sessions for one task.
#[tauri::command]
#[specta::specta]
pub fn mark_task_execution_started(
    app_state: State<'_, Arc<AppState>>,
    task_id: i32,
) -> Result<Option<crate::models::Task>, String> {
    use crate::models::TaskStatus;

    let task = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        // InProgress is here only for the plan gate: `claim_for_execution` refuses any phase but
        // the gate's, so this cannot start a task an agent is already working on.
        crate::task::transition::claim_for_execution(
            &conn,
            task_id,
            &[TaskStatus::Planning, TaskStatus::Queue, TaskStatus::InProgress],
        )?
    };

    if task.is_some() {
        app_state.app_handle.emit("tasks-changed", ()).ok();
    }
    Ok(task)
}

/// Records that the session is up and the agent is working.
///
/// The role decides where that leaves the task — a refiner stays in the backlog, a coder moves to
/// In Progress — and the mapping lives in `transition::resolve` so the four spawn paths cannot
/// disagree about it.
///
/// Guarded on the task still being the one that was claimed: a user who dragged the card away
/// mid-spawn, or stopped it, must not have that undone by a session that finished starting
/// afterwards. `None` tells the caller its session no longer belongs to anything and should be
/// torn down.
#[tauri::command]
#[specta::specta]
pub fn mark_task_session_ready(
    app_state: State<'_, Arc<AppState>>,
    task_id: i32,
    role: crate::project::profiles::AgentRole,
) -> Result<Option<crate::models::Task>, String> {
    let task = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        crate::task::transition::apply_if_spawning(
            &conn,
            task_id,
            crate::task::transition::TaskTransition::SessionReady(role),
        )?
    };

    if task.is_some() {
        app_state.app_handle.emit("tasks-changed", ()).ok();
    }
    Ok(task)
}

/// Releases a claim whose spawn never completed.
///
/// `failed` separates the two ways that happens. A spawn that errored leaves the card red at
/// `Spawning`/`Failed` so the user can see it and retry; a spawn the user cancelled at a prompt
/// simply parks the task again, because nothing went wrong.
#[tauri::command]
#[specta::specta]
pub fn release_task_execution_claim(
    app_state: State<'_, Arc<AppState>>,
    task_id: i32,
    failed: bool,
) -> Result<Option<crate::models::Task>, String> {
    use crate::task::transition::TaskTransition;

    let event = if failed { TaskTransition::PhaseFailed } else { TaskTransition::SpawnAborted };

    let task = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        crate::task::transition::apply_if_spawning(&conn, task_id, event)?
    };

    if task.is_some() {
        app_state.app_handle.emit("tasks-changed", ()).ok();
    }
    Ok(task)
}

/// Take or renew a hold on a task the user is interacting with.
///
/// The scheduler skips held tasks. Renewal rather than a one-shot flag because the thing being
/// described — a pointer that is down, a modal that is open — has no reliable end event: a closed
/// window or a killed renderer never sends one, and a task nothing can start is worse than one
/// started a moment early.
#[tauri::command]
#[specta::specta]
pub fn hold_task(app_state: State<'_, Arc<AppState>>, task_id: i32) -> Result<(), String> {
    app_state.task_holds.hold(task_id, crate::task::holds::HOLD_TTL);
    Ok(())
}

/// Release a hold, and tell the scheduler to look again.
///
/// The event matters. A drag that ends where it started changes nothing, so it emits no
/// `tasks-changed` — without this the task would sit unscheduled until some unrelated thing
/// happened to move the board, which is the stalled-queue failure this design keeps running into.
/// It is deliberately not `tasks-changed`: nothing changed, and refetching the board to say so
/// would be a cost paid on every drag.
#[tauri::command]
#[specta::specta]
pub fn release_task_hold(app_state: State<'_, Arc<AppState>>, task_id: i32) -> Result<(), String> {
    app_state.task_holds.release(task_id);
    app_state.app_handle.emit("task-hold-released", task_id).ok();
    Ok(())
}

/// Answer the refiner's proposal gate.
///
/// The proposal is the refiner's closing message, kept in the outcome thread — the refiner writes
/// nothing itself. That is what makes the gate a real comparison rather than an undo: accepting is
/// the first time the description changes, so rejecting is safe by construction rather than
/// dependent on a snapshot having been taken correctly.
///
/// The proposal stays in the thread either way. The thread is append-only and is the record of what
/// was suggested; a rejected proposal is part of that history, not a mistake to erase.
#[tauri::command]
#[specta::specta]
pub fn close_refinement(
    app_state: State<'_, Arc<AppState>>,
    task_id: i32,
    accept: bool,
) -> Result<crate::models::Task, String> {
    let task = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;

        if accept {
            let proposal = crate::task::comments::latest_of_kind(&conn, task_id, "proposal")?
                .ok_or("This task has no proposal to accept")?;
            let body = proposal.body.clone().ok_or("This task has no proposal to accept")?;

            conn.execute(
                "UPDATE tasks SET description = ? WHERE id = ?",
                rusqlite::params![body, task_id],
            )
            .map_err(|e| format!("Failed to apply the proposal to task {}: {}", task_id, e))?;

            // An accepted proposal *is* the description now, and the thread sat directly beneath it
            // showing the same text twice. The thread is otherwise append-only, and a rejected
            // proposal still stays: that one exists nowhere else, and what was suggested and turned
            // down is the part of the history worth keeping.
            conn.execute("DELETE FROM task_comments WHERE id = ?", [proposal.id])
                .map_err(|e| format!("Failed to tidy task {}'s thread: {}", task_id, e))?;
        }

        crate::task::transition::apply(
            &conn,
            task_id,
            crate::task::transition::TaskTransition::RefinementClosed,
        )?
    };

    app_state.app_handle.emit("tasks-changed", ()).ok();
    Ok(task)
}
