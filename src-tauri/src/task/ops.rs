use crate::acp::connection_server::{query_project_store, reply};
use crate::acp::transport::{ServerRequest, ServerResponse};
use crate::core::AppState;
use crate::models::Task;
use maestro_protocol::{
    AgentRole, ApplyTaskTransitionRequest, CloseRefinementRequest, TaskPhase, TaskTransition,
    TransitionGuard,
};
use std::sync::Arc;
use tauri::{Emitter, State};

/// Apply one transition in the daemon, its guard read under the same lock as the write. `None`
/// when the guard refused it.
pub(crate) async fn apply_transition_on_server(
    app_state: &Arc<AppState>,
    project_id: i32,
    task_id: i32,
    event: TaskTransition,
    guard: TransitionGuard,
) -> Result<Option<Task>, String> {
    apply_transition_writing(app_state, project_id, task_id, event, guard, None, None).await
}

/// [`apply_transition_on_server`] with an update written before the transition and a thread
/// entry after it, in its transaction and only when the guard admits it.
pub(crate) async fn apply_transition_writing(
    app_state: &Arc<AppState>,
    project_id: i32,
    task_id: i32,
    event: TaskTransition,
    guard: TransitionGuard,
    update: Option<maestro_protocol::TaskUpdate>,
    comment: Option<maestro_protocol::NewTaskComment>,
) -> Result<Option<Task>, String> {
    let reply = query_project_store(
        app_state,
        project_id,
        |project_path| {
            ServerRequest::ApplyTaskTransition(ApplyTaskTransitionRequest {
                project_path,
                task_id,
                event,
                guard,
                update,
                comment,
            })
        },
        reply!(ServerResponse::ApplyTaskTransitionOk(reply) => reply),
    )
    .await?;
    Ok(reply.task.map(|task| Task::from_wire(task, project_id)))
}

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
        let conn = app_state
            .db
            .lock()
            .map_err(|e| format!("Lock failed: {}", e))?;
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
    let git_conn = crate::core::get_git_connection(&project, &app_state)
        .await
        .unwrap_or_else(|_| crate::models::GitConnection::Local {
            path: project.path.clone(),
        });

    let remote = crate::git::remote::project_remote(&app_state, project_id).await;
    let (branches, current_branch) = tokio::join!(
        crate::git::list_branches(&git_conn, &remote),
        crate::git::get_current_branch(&git_conn),
    );
    let branches = branches.unwrap_or_else(|_| crate::git::BranchList {
        local: vec![],
        remote: vec![],
    });
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
/// An ACP session is torn down through `tear_down_session`, the same helper `end_acp_session` uses;
/// a PTY session replicates the `close_pty_session` logic. A task with no live session is not an
/// error: its session may have died on its own, and the worktree it left behind is exactly what
/// still needs discarding.
#[tauri::command]
#[specta::specta]
pub async fn interrupt_task(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    task_id: i32,
) -> Result<(), String> {
    // Search ACP sessions by task — release lock immediately in scoped block. Task ids are per
    // project, so the project has to match too.
    let task = crate::acp::TaskKey {
        project_id,
        task_id,
    };
    let acp_session_id: Option<String> = {
        let sessions = app_state.acp.sessions.lock().await;
        sessions
            .iter()
            .find(|(_, proc)| proc.task_key() == Some(task))
            .map(|(session_id, _)| session_id.clone())
    };

    // Search PTY session metadata by task — release lock immediately in scoped block.
    let pty_session_key: Option<String> = {
        let session_meta = app_state.pty.session_meta.lock().await;
        session_meta
            .iter()
            .find(|(_, m)| m.task_id == Some(task_id) && m.project_id == Some(project_id))
            .map(|(session_id, _)| session_id.clone())
    };

    // Shared with `end_acp_session` rather than copied: this is the copy its doc comment warns
    // about. Its `Cancel` is also what closes the daemon's row, so the interrupted session is not
    // brought back against a worktree the `discard_task_workspace` below has already deleted.
    if let Some(session_id) = acp_session_id {
        crate::acp::session_handlers::tear_down_session(&app_state, &session_id).await;
    }

    // Tear down PTY session if found — replicates close_pty_session logic.
    if let Some(session_id) = pty_session_key {
        {
            let mut cancel_map = app_state.pty.attach_cancel.lock().await;
            if let Some(flag) = cancel_map.remove(&session_id) {
                flag.store(true, std::sync::atomic::Ordering::Relaxed);
            }
        }
        app_state.pty.sessions.lock().await.remove(&session_id);
        app_state.ssh.pty_sessions.lock().await.remove(&session_id);
        app_state.pty.session_meta.lock().await.remove(&session_id);
    }

    apply_transition_on_server(
        &app_state,
        project_id,
        task_id,
        TaskTransition::Stopped,
        TransitionGuard::Always,
    )
    .await?;

    crate::git::worktree_lifecycle::discard_task_workspace(&app_state, project_id, task_id).await?;

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
    project_id: i32,
    task_id: i32,
    force: bool,
) -> Result<Option<Task>, String> {
    let task = crate::task::crud::get_task_on_server(&app_state, project_id, task_id)
        .await?
        .ok_or_else(|| format!("Task {task_id} not found"))?;
    let is_git_repo = is_project_git_repo(&app_state, project_id).await;

    let has_changes = if is_git_repo {
        task_has_changes(&app_state, &task).await
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
    let reviewer_pending = reviewer_should_run(&app_state, &task).await;

    apply_transition_on_server(
        &app_state,
        project_id,
        task_id,
        TaskTransition::TurnCompleted {
            is_git_repo,
            has_changes,
            reviewer_pending,
        },
        TransitionGuard::Always,
    )
    .await
}

/// End the review agent's pass and hand the task to the human gate.
///
/// The same transition an approving verdict applies, so the reviewer is not started again: the
/// round count is untouched and `reviewer_should_run` is never consulted. Going through
/// `send_task_to_review` instead would recompute it and send the task straight back to
/// `SelfReview`.
///
/// Returns `None` when the task has already left `SelfReview` — the verdict landed while the user
/// was pressing the button, and it must not be dragged back to a gate it has passed.
#[tauri::command]
#[specta::specta]
pub async fn end_self_review(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    task_id: i32,
) -> Result<Option<Task>, String> {
    apply_transition_on_server(
        &app_state,
        project_id,
        task_id,
        TaskTransition::ReviewFinished,
        TransitionGuard::Phase(TaskPhase::SelfReview),
    )
    .await
}

/// Take or renew a hold on a task the user is interacting with.
///
/// The scheduler skips held tasks. Renewal rather than a one-shot flag because the thing being
/// described — a pointer that is down, a modal that is open — has no reliable end event: a closed
/// window or a killed renderer never sends one, and a task nothing can start is worse than one
/// started a moment early.
#[tauri::command]
#[specta::specta]
pub async fn hold_task(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    task_id: i32,
) -> Result<(), String> {
    crate::acp::connection_server::query_project_store(
        &app_state,
        project_id,
        |project_path| {
            ServerRequest::HoldTask(maestro_protocol::HoldTaskRequest {
                project_path,
                task_id,
                ttl_ms: None,
            })
        },
        reply!(ServerResponse::HoldTaskOk => ()),
    )
    .await
}

/// Release a hold. The daemon's scheduler looks at the queue again when one is released.
#[tauri::command]
#[specta::specta]
pub async fn release_task_hold(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    task_id: i32,
) -> Result<(), String> {
    crate::acp::connection_server::query_project_store(
        &app_state,
        project_id,
        |project_path| {
            ServerRequest::ReleaseTaskHold(maestro_protocol::TaskRef {
                project_path,
                task_id,
            })
        },
        reply!(ServerResponse::ReleaseTaskHoldOk => ()),
    )
    .await
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
pub async fn close_refinement(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    task_id: i32,
    accept: bool,
) -> Result<Task, String> {
    let task = query_project_store(
        &app_state,
        project_id,
        |project_path| {
            ServerRequest::CloseRefinement(CloseRefinementRequest {
                project_path,
                task_id,
                accept,
            })
        },
        reply!(ServerResponse::CloseRefinementOk(task) => task),
    )
    .await?;
    Ok(Task::from_wire(task, project_id))
}

/// Run one stage of a task in the daemon: claim it, make or reuse its worktree, spawn the role's
/// agent and send the prompt. `None` means the task was deferred to the queue for want of a slot.
///
/// The session itself reaches this window as `TaskSessionStarted`, adopted like an automation's.
/// A sign-in the agent needs fails this with `auth_required:<agent_id>`, which the board turns into
/// its sign-in prompt; the daemon has given the claim back by then. `agent_id` overrides the agent
/// for this start only, and is written nowhere.
#[tauri::command]
#[specta::specta]
#[allow(clippy::too_many_arguments)]
pub async fn start_task(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    task_id: i32,
    role: crate::project::profiles::AgentRole,
    feedback: Option<String>,
    unattended: bool,
    respect_capacity: bool,
    agent_id: Option<String>,
) -> Result<StartTaskResult, String> {
    let (connection_key, project_path) =
        crate::project::automations::target(&app_state, project_id).await?;
    // Spawning an agent, and signing it in, takes far longer than a store write.
    crate::acp::connection_server::query_via_server(
        connection_key,
        &app_state,
        &format!("No connection server for connection {connection_key:?}"),
        ServerRequest::StartTask(maestro_protocol::StartTaskRequest {
            project_path,
            task_id,
            role: AgentRole::from(role),
            feedback,
            unattended,
            respect_capacity,
            agent_id,
        }),
        reply!(ServerResponse::StartTaskOk(response) => StartTaskResult {
            session_id: response.session_id,
            skipped_attachments: response.skipped_attachments,
        }),
        120,
        "The project's server did not start the task within 120s",
    )
    .await
}

/// What `start_task` answers with.
#[derive(Debug, Clone, serde::Serialize, specta::Type)]
pub struct StartTaskResult {
    /// The session started, `None` when the task was deferred to the queue.
    pub session_id: Option<String>,
    /// The attachments the prompt went without, each as `<file>: <why>`.
    pub skipped_attachments: Vec<String>,
}

/// Whether a review agent should look at this task before the user does.
///
/// Three conditions, all necessary. The project must define a `Reviewer` profile, which is how a
/// team opts in — a project without one keeps the pipeline it had. The task must not have turned
/// the stage off for itself, which is the same opt-out one task at a time. And the loop must have
/// rounds left, or a reviewer would be started only to have its verdict escalated anyway.
///
/// So the work of the last rework round reaches the user unreviewed, deliberately: by then they
/// are the reviewer, and the alternative is paying an agent for a verdict nobody may act on.
async fn reviewer_should_run(
    app_state: &crate::core::AppState,
    task: &crate::models::Task,
) -> bool {
    use crate::acp::completion::review_rounds_remain;

    if !review_rounds_remain(task.review_rounds) {
        return false;
    }

    if crate::project::profiles::role_is_skipped(
        task.profile_overrides.as_deref(),
        crate::project::profiles::AgentRole::Reviewer,
    ) {
        log::debug!(
            "[acp] task {} skips review, so it goes straight to the user",
            task.id
        );
        return false;
    }

    crate::project::profiles::has_profile_for_role(
        app_state,
        task.project_id,
        crate::project::profiles::AgentRole::Reviewer,
    )
    .await
}

/// Whether the agent has changed anything since it started, measured against
/// `execution_start_sha` — the baseline captured at spawn and preserved across resumes, so this
/// covers the whole task rather than the turn.
///
/// Returns `None` when the answer cannot be established, which `classify_turn` reads as "no
/// evidence" and treats the same as a non-git project.
async fn task_has_changes(
    app_state: &Arc<crate::core::AppState>,
    task: &crate::models::Task,
) -> Option<bool> {
    let (project_id, task_id) = (task.project_id, task.id);
    let worktree_path = match crate::acp::connection_server::query_project_store(
        app_state,
        project_id,
        |project_path| {
            ServerRequest::ListWorktrees(maestro_protocol::ListWorktreesRequest {
                project_path,
                task_id: Some(task_id),
            })
        },
        reply!(ServerResponse::ListWorktreesOk(list) => list),
    )
    .await
    {
        Ok(list) => list
            .worktrees
            .into_iter()
            .next()
            .map(|worktree| worktree.path),
        Err(e) => {
            log::warn!("[acp] diff gate for task {task_id} could not read its worktree: {e}");
            return None;
        }
    };

    // Both worktree modes leave the row here: a reused workspace is claimed by the task when it
    // starts, exactly so that lookups like this one keep working.
    let isolated = task.workspace_mode != crate::models::WorkspaceMode::RepositoryDirectory;

    // An isolated task whose worktree row has gone missing must report no evidence rather than
    // fall through to the project root: the root is a different tree, and any unrelated dirt in
    // it — an untracked `.maestro/`, a half-finished edit — reads as work this agent did and
    // sends the task to review with a diff it had nothing to do with.
    if isolated && worktree_path.is_none() {
        log::warn!("[acp] task {task_id} is isolated but has no worktree row; skipping diff gate");
        return None;
    }

    let start_sha = task
        .execution_start_sha
        .clone()
        .filter(|sha| !sha.is_empty())?;
    let (_project, git_conn) = crate::core::get_project_with_git_conn(app_state, project_id)
        .await
        .ok()?;

    // Worktree paths are stored relative to the repo; a task without one runs in the project root.
    let cwd = match worktree_path {
        Some(path) => format!("{}/{}", git_conn.path(), path),
        None => git_conn.path().to_string(),
    };

    // `Commit` never consults the remote; passed for signature uniformity, and resolving it is a
    // cached map lookup after the first call.
    let remote = crate::git::remote::project_remote(app_state, project_id).await;
    match crate::git::worktree_query::diff_stats_in(
        &git_conn,
        &cwd,
        &crate::models::DiffTarget::Commit { sha: start_sha },
        &remote,
    )
    .await
    {
        Ok(stats) => Some(stats.has_changes()),
        // Most often the start commit no longer exists, because the agent rebased or amended over
        // it. `None` sends this to `classify_turn` as "unknown", which completes the turn — the
        // alternative is calling work the agent did invisible on the strength of a failed command.
        Err(e) => {
            log::warn!("[acp] diff gate for task {task_id} could not read the diff: {e}");
            None
        }
    }
}

/// `(path, connection_id, wsl_connection_id, docker_connection_id)`
type ProjectLocationRow = (String, Option<i32>, Option<i32>, Option<i32>);

async fn is_project_git_repo(app_state: &crate::core::AppState, project_id: i32) -> bool {
    let result: Option<ProjectLocationRow> = app_state.db.lock().ok().and_then(|conn| {
        conn.query_row(
            "SELECT path, connection_id, wsl_connection_id, docker_connection_id \
             FROM projects WHERE id = ?",
            [project_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .ok()
    });

    let Some((path, connection_id, wsl_connection_id, docker_connection_id)) = result else {
        return true;
    };

    if connection_id.is_none() && wsl_connection_id.is_none() && docker_connection_id.is_none() {
        return std::path::Path::new(&path).join(".git").exists();
    }

    match crate::core::get_project_with_git_conn(app_state, project_id).await {
        Ok((_project, git_conn)) => {
            crate::git::run_git_in_dir(&git_conn, &path, &["rev-parse", "--is-inside-work-tree"])
                .await
                .map(|output| output.trim() == "true")
                .unwrap_or(false)
        }
        Err(_) => false,
    }
}
