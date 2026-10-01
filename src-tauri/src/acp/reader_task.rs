//! ACP reader tasks: background loops that consume messages from a maestro-server process
//! and dispatch them to per-session handlers or connection-level pending channels.

use crate::acp::connection_server::reply;
use crate::acp::manager::log_server_diagnostic;
use crate::acp::replay::{emit_or_buffer_payload, push_config_init_to_buffer};
use crate::acp::session_types::{
    PendingReply, PendingRequests, ReaderTaskContext, RestorableSession,
};
use crate::acp::transport::{
    FileReadResponse, FileSearchResponse, MaestroRpcMessage, PromptCapabilitiesInfo, ServerRequest,
    ServerResponse, SessionModeState, SessionModelState,
};
use crate::acp::transport_types::{serialize_message, AcpReadSource};
use crate::acp::TaskKey;
use maestro_protocol::{TaskTransition, TransitionGuard, TurnEnding};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Emitter;
use tokio::sync::oneshot;

/// Payload for `acp://connection-live` and `acp://connection-lost`.
///
/// Every connection-health event names the connection it is about: a session can be open against
/// more than one at a time, and without this the UI cannot tell whether the event concerns the
/// project on screen.
#[derive(Clone, serde::Serialize)]
pub struct ConnectionEvent {
    pub connection: crate::acp::ConnectionKey,
}

/// Payload for `acp://connection-stale` — the server stopped answering but the transport is
/// still open, so this is a suspicion rather than a failure.
#[derive(Clone, serde::Serialize)]
pub struct ConnectionQuiet {
    pub connection: crate::acp::ConnectionKey,
    pub quiet_for_secs: u64,
}

pub(crate) fn spawn_reader_task(
    source: AcpReadSource,
    cancel_rx: oneshot::Receiver<()>,
    ctx: ReaderTaskContext,
) {
    let ReaderTaskContext {
        session_id,
        app_handle,
        app_state,
        current_model_id,
        current_mode_id,
        pending_file_search,
        pending_file_read,
        acp_session_id_cache,
        replay_buffer,
        initialized,
        completion_filter,
        declared_complete,
        user_interrupted,
        closing_message,
        permission_queue,
        task,
    } = ctx;
    tokio::spawn(async move {
        let mut source = source;
        let mut cancel_rx = cancel_rx;

        loop {
            let msg = tokio::select! {
                biased;
                _ = &mut cancel_rx => break,
                result = source.next_message() => match result {
                    Some(msg) => msg,
                    None => break,
                },
            };
            match &msg {
                MaestroRpcMessage::Response(ServerResponse::Ping { .. })
                | MaestroRpcMessage::Response(ServerResponse::TerminalOutput(_)) => {}
                _ => {
                    if let Ok(json) = serde_json::to_string(&msg) {
                        log::trace!("[acp] << session_id={session_id} {json}");
                    }
                }
            }
            if let MaestroRpcMessage::Response(ServerResponse::Ping { seq }) = &msg {
                log::trace!("[acp] ping seq={seq} on direct session session_id={session_id}");
                let pong = MaestroRpcMessage::Request(ServerRequest::Pong { seq: *seq });
                if let Err(e) =
                    crate::acp::write_to_acp_session(&app_state, &session_id, &pong).await
                {
                    log::warn!("[acp] pong failed on direct session session_id={session_id}: {e}");
                }
                if let Err(e) = app_state.app_handle.emit("acp://heartbeat", ()) {
                    log::warn!("[acp] emit heartbeat failed: {e}");
                }
                continue;
            }

            update_session_from_response(&session_id, &msg, &app_state).await;

            // Off the reader loop for the same reason `resolve_turn_end` is: a `canvas_await`
            // blocks until the user acts, and nothing else on this session could arrive
            // meanwhile — including the answer itself.
            if let MaestroRpcMessage::Response(ServerResponse::HostToolCall(call)) = msg {
                let state = Arc::clone(&app_state);
                let owned_session_id = session_id.clone();
                tokio::spawn(async move {
                    crate::acp::host_tools::handle(state, &owned_session_id, call).await;
                });
                continue;
            }

            if let (
                Some(task),
                MaestroRpcMessage::Response(ServerResponse::PermissionRequest(perm_req)),
            ) = (task, &msg)
            {
                spawn_task_permission_request(
                    &app_state,
                    task,
                    &session_id,
                    &permission_queue,
                    perm_req.clone(),
                );
                continue;
            }

            if let MaestroRpcMessage::Response(ServerResponse::ElicitationRequest(_)) = msg {
                if let Some(task) = task {
                    spawn_mark_task_blocked(&app_state, task);
                }
            }

            // Resolving the turn touches the DB and, for remote projects, runs `git rev-parse`
            // and `git diff` over SSH with no timeout. Run it off the reader loop so it can
            // never delay — or with a wedged connection, indefinitely withhold — the
            // `acp://turn-ended` emit below that takes the UI out of "thinking".
            if let MaestroRpcMessage::Response(ServerResponse::TurnEnded(ref turn_ended)) = msg {
                if let Some(task) = task {
                    let state = Arc::clone(&app_state);
                    let stop_reason = turn_ended.stop_reason.clone();
                    // Read and reset: a declaration applies only to the turn it appeared in.
                    let declared =
                        declared_complete.swap(false, std::sync::atomic::Ordering::AcqRel);
                    let interrupted =
                        user_interrupted.swap(false, std::sync::atomic::Ordering::AcqRel);
                    // Drained here rather than in the spawned task, so the accumulator is empty
                    // before the next turn starts writing into it.
                    let closing = closing_message
                        .lock()
                        .map(|mut m| m.take())
                        .unwrap_or_default();
                    tokio::spawn(async move {
                        resolve_turn_end(
                            &state,
                            task,
                            &stop_reason,
                            declared,
                            interrupted,
                            closing,
                        )
                        .await;
                    });
                }
            }

            handle_server_message(
                msg,
                &session_id,
                &app_handle,
                &current_model_id,
                &current_mode_id,
                &pending_file_search,
                &pending_file_read,
                &acp_session_id_cache,
                &replay_buffer,
                &initialized,
                &completion_filter,
                &declared_complete,
                &closing_message,
            );
        }

        app_state.acp.sessions.lock().await.remove(&session_id);
        fail_task_if_still_running(&app_state, task);
        app_state.app_handle.emit("sessions-changed", ()).ok();
        if let Err(e) = app_handle.emit(&format!("acp://session-ended/{}", session_id), ()) {
            log::warn!("[acp] emit session-ended/{session_id} failed: {e}");
        }
    });
}

/// Apply `event` to the session's task in the daemon, off the caller's task.
///
/// Off it because the caller may be the shared reader, which is also what delivers the daemon's
/// reply: awaiting it there would wait on itself.
pub(crate) fn spawn_transition(
    app_state: &Arc<crate::core::AppState>,
    task: TaskKey,
    event: TaskTransition,
    guard: TransitionGuard,
) {
    let app_state = Arc::clone(app_state);
    tokio::spawn(async move { transition_task(&app_state, task, event, guard).await });
}

/// Apply `event` to the session's task in the daemon and wait for it, logging a failure. Only for
/// callers off the shared reader, see [`spawn_transition`].
pub(crate) async fn transition_task(
    app_state: &Arc<crate::core::AppState>,
    task: TaskKey,
    event: TaskTransition,
    guard: TransitionGuard,
) {
    if let Err(e) = crate::task::ops::apply_transition_on_server(
        app_state,
        task.project_id,
        task.task_id,
        event,
        guard,
    )
    .await
    {
        log::warn!(
            "[acp] could not apply {event:?} to task {} of project {}: {e}",
            task.task_id,
            task.project_id
        );
    }
}

/// Record that the agent is stopped waiting on the user, so the card says so after a reload.
///
/// Awaited, so a caller that marks, shows the question and then clears on the answer applies the
/// two in that order: spawned separately, the clear could overtake the mark and leave the card
/// blocked on a question already answered.
///
/// The `Changed` guard matters here rather than being a nicety: with auto-approve off a session
/// raises permission requests constantly, and every write the daemon makes is pushed to every
/// window as `TasksChanged`, which refetches the whole board.
pub(crate) async fn mark_task_blocked(app_state: &Arc<crate::core::AppState>, task: TaskKey) {
    transition_task(
        app_state,
        task,
        TaskTransition::AwaitingUserInput,
        TransitionGuard::Changed,
    )
    .await;
}

/// [`mark_task_blocked`] for the reader path, which must not wait on the daemon. An elicitation's
/// answer can in principle overtake it; the card then pulses until the next turn ends.
fn spawn_mark_task_blocked(app_state: &Arc<crate::core::AppState>, task: TaskKey) {
    spawn_transition(
        app_state,
        task,
        TaskTransition::AwaitingUserInput,
        TransitionGuard::Changed,
    );
}

/// A session's reader has ended. If the pipeline still believes an agent is working the task,
/// record the failure.
///
/// Without this a session that dies mid-phase leaves the card looking healthy, and a session that
/// dies while blocked leaves it pulsing for an answer nothing will ever consume. Tasks that moved
/// on under their own power — merged, stopped, parked at a review gate — are left untouched.
pub(crate) fn fail_task_if_still_running(
    app_state: &Arc<crate::core::AppState>,
    task: Option<TaskKey>,
) {
    if let Some(task) = task {
        spawn_transition(
            app_state,
            task,
            TaskTransition::PhaseFailed,
            TransitionGuard::AgentRunning,
        );
    }
}

/// Hand the daemon a turn's ending, which it resolves under one lock: the phase read, a reviewer's
/// verdict and its round, the transition while the task still has a phase, and the thread entry.
///
/// Guarded on the task still having a live phase, because this runs detached: by the time it lands
/// the user may have stopped the session or moved the card, and every one of those parks the task.
/// `None` when it had been parked.
async fn end_task_turn(
    app_state: &Arc<crate::core::AppState>,
    task: TaskKey,
    ending: TurnEnding,
    closing_message: String,
) -> Result<Option<crate::models::Task>, String> {
    use crate::acp::completion::{classify_verdict, ReviewVerdict};

    // Consulted by the daemon only when the phase it reads is `SelfReview`.
    let review_approved = classify_verdict(&closing_message) == ReviewVerdict::Approved;
    let ended = crate::acp::connection_server::query_project_store(
        app_state,
        task.project_id,
        |project_path| {
            ServerRequest::EndTaskTurn(maestro_protocol::EndTaskTurnRequest {
                project_path,
                task_id: task.task_id,
                ending,
                review_approved,
                closing_message,
            })
        },
        reply!(ServerResponse::EndTaskTurnOk(ended) => ended),
    )
    .await?;
    Ok(ended
        .task
        .map(|stored| crate::models::Task::from_wire(stored, task.project_id)))
}

/// Decide what a turn ending means for the task, and record it.
///
/// A turn ending is not the same as the work being finished: an agent that stops to ask a
/// question ends its turn exactly like one that finished the job. `classify_turn` weighs the stop
/// reason, whether the agent declared completion, and whether the repository actually changed.
async fn resolve_turn_end(
    app_state: &Arc<crate::core::AppState>,
    task: TaskKey,
    stop_reason: &str,
    declared_complete: bool,
    user_interrupted: bool,
    closing_message: String,
) {
    use crate::acp::completion::{classify_turn, TurnOutcome};
    use crate::models::TaskPhase;

    let is_git_repo = is_project_git_repo(app_state, task.project_id).await;

    // The phase the agent was in, which decides what to ask below. The daemon reads it again under
    // its lock when it applies the ending, so the outcome is filed under the phase that produced
    // it, not the one the task lands in.
    let stored =
        match crate::task::crud::get_task_on_server(app_state, task.project_id, task.task_id).await
        {
            Ok(Some(stored)) => stored,
            Ok(None) => return,
            Err(e) => {
                log::warn!(
                    "[acp] could not read task {} to end its turn: {e}",
                    task.task_id
                );
                return;
            }
        };
    let phase = stored.phase;

    // Three of the four roles write nothing, so asking whether the repository changed cannot say
    // anything about whether they finished — and asking anyway is actively wrong: a clean tree
    // would read as `Some(false)` and stall a refiner that had just produced a perfectly good
    // proposal.
    let writes = matches!(
        phase,
        Some(TaskPhase::Implementing | TaskPhase::Rework | TaskPhase::AwaitingMerge)
    );

    // A declared completion used to skip this call, on the grounds that the agent was believed
    // either way. It no longer is: an agent that declares itself done having changed nothing goes
    // to Done as `NoChanges` rather than opening an empty review, and that is precisely the case
    // the answer is needed for.
    //
    // Skipped outright for an interrupted turn — `classify_turn` ignores it either way, and the
    // answer costs a `git diff` that runs over SSH for a remote project.
    let has_changes = if !user_interrupted && writes && is_git_repo && stop_reason == "end_turn" {
        task_has_changes(app_state, &stored).await
    } else {
        None
    };

    let outcome = classify_turn(
        stop_reason,
        declared_complete,
        has_changes,
        user_interrupted,
    );

    // An agent fixing a red build is already on an open pull request, so its turn ending means
    // "push what you changed", not "advance the task". Nothing else moves: the PR stays open and
    // the branch stays its head, which is the point of fixing rather than re-approving.
    if phase == Some(TaskPhase::AwaitingMerge) && outcome == TurnOutcome::Complete {
        if let Err(e) =
            crate::git::merge::push_ci_fix(app_state, task.project_id, task.task_id).await
        {
            log::error!("Could not push the CI fix for task {}: {}", task.task_id, e);
            // The push already failed and was reported above. Failing to record that leaves the
            // task showing as running with nothing behind it, which the user cannot act on and no
            // later sweep corrects.
            if let Err(e) = crate::task::ops::apply_transition_on_server(
                app_state,
                task.project_id,
                task.task_id,
                TaskTransition::PhaseFailed,
                TransitionGuard::Active,
            )
            .await
            {
                log::error!("Could not mark task {} as failed: {}", task.task_id, e);
            }
        }
        return;
    }

    // A review agent finishing is not "the phase is done, advance" — its reply *is* the decision,
    // which the daemon turns into a verdict when it finds the task at `SelfReview`.
    let ending = match outcome {
        TurnOutcome::Complete => TurnEnding::Completed {
            is_git_repo,
            has_changes,
            reviewer_pending: writes && reviewer_should_run(app_state, &stored).await,
        },
        TurnOutcome::Stalled => TurnEnding::Stalled,
        TurnOutcome::Failed => TurnEnding::Failed,
        TurnOutcome::Ignore => return,
    };

    if let Err(e) = end_task_turn(app_state, task, ending, closing_message).await {
        log::warn!(
            "[acp] could not resolve turn end for task {}: {e}",
            task.task_id
        );
    }
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
pub(crate) async fn reviewer_should_run(
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
pub(crate) async fn task_has_changes(
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

pub(crate) async fn is_project_git_repo(
    app_state: &crate::core::AppState,
    project_id: i32,
) -> bool {
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

/// Settle a task session's permission request off the reader, and show the user what nobody
/// answered.
///
/// Off it because deciding asks the daemon for the task, and on the shared reader the daemon's
/// reply arrives through the very loop that would be waiting on it.
fn spawn_task_permission_request(
    app_state: &Arc<crate::core::AppState>,
    task: TaskKey,
    session_id: &str,
    permission_queue: &crate::acp::session_types::PermissionQueue,
    perm_req: crate::acp::transport::PermissionRequest,
) {
    let app_state = Arc::clone(app_state);
    let session_id = session_id.to_string();
    // Each request makes its own round trips before it is shown, so two raised back to back could
    // otherwise reach the UI in either order. Taken and replaced here, on the reader, which sees
    // them in the order the agent raised them.
    let mut queue = permission_queue
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let previous = queue.take();
    *queue = Some(tokio::spawn(async move {
        if let Some(previous) = previous {
            if let Err(e) = previous.await {
                log::warn!("[acp] an earlier permission request of {session_id} failed: {e}");
            }
        }
        if handle_permission_request(&app_state, task, &session_id, &perm_req).await {
            return;
        }
        if let Some(session) = app_state.acp.sessions.lock().await.get(&session_id) {
            session
                .has_pending_permission
                .store(true, Ordering::Release);
        }
        if let Err(e) = app_state.app_handle.emit(
            &format!("acp://permission-request/{}", session_id),
            &perm_req,
        ) {
            log::warn!("[acp] emit permission-request/{session_id} failed: {e}");
        }
    }));
}

/// Decide what the board does with a permission request, and report whether it answered.
///
/// `true` means the request is settled and must not reach the UI. `false` leaves it for the user,
/// having first marked the task blocked so the card says the agent is stopped.
///
/// Both readers go through here, and that is the point. They did not before: the shared reader —
/// which is the *ordinary local path*, since a connection server serves every session on a
/// connection and only a directly-spawned session gets its own loop — called auto-approve alone.
/// So the plan interception was written, tested, and never once ran outside SSH. Two call sites
/// that must agree on which of three answers a request gets will not stay agreeing, so there is
/// now one.
async fn handle_permission_request(
    app_state: &Arc<crate::core::AppState>,
    task: TaskKey,
    session_id: &str,
    perm_req: &crate::acp::transport::PermissionRequest,
) -> bool {
    let stored =
        crate::task::crud::get_task_on_server(app_state, task.project_id, task.task_id).await;
    match stored {
        Ok(Some(stored)) => {
            if try_auto_approve_permission(app_state, stored.phase, session_id, perm_req).await {
                return true;
            }
            if try_conclude_plan_mode_phase(app_state, task, stored.phase, session_id, perm_req)
                .await
            {
                return true;
            }
        }
        Ok(None) => {}
        Err(e) => log::warn!(
            "[acp] could not read task {} to answer a permission request: {e}",
            task.task_id
        ),
    }
    // Nobody answered for it: the agent is stopped until the user does. Awaited before the prompt
    // reaches the UI, so the user's answer, which clears the mark, cannot overtake it.
    mark_task_blocked(app_state, task).await;
    false
}

async fn try_auto_approve_permission(
    app_state: &Arc<crate::core::AppState>,
    phase: Option<crate::models::TaskPhase>,
    session_id: &str,
    perm_req: &crate::acp::transport::PermissionRequest,
) -> bool {
    // There used to be a per-task `auto_approve` flag in front of this, and a checkbox on the card
    // driving it. It said the same thing twice: a role's permission mode already decides whether
    // the agent stops to ask, and a task carrying "Tasks" through this pipeline wants the workflow
    // to run. Two switches that can disagree about one question is how a task ended up in a mode
    // that prompts with nothing allowed to answer.
    //
    // The phase is the whole gate now, and it is the right one: it already encodes whether the role
    // running may write.
    //
    // Auto-approve is a coder's affordance: it exists so a task that has been told to get on with
    // it is not stopped by a prompt for an edit it was always going to be allowed to make. It must
    // not answer for a role that exists *because* it cannot write.
    //
    // The request that matters is `ExitPlanMode`. In plan mode an agent's writes are refused
    // outright rather than prompted, so it is close to the only permission a read-only role ever
    // asks for — and the `allow_always` option this function prefers means "leave plan mode and
    // stop asking". Approving it handed the read-only guarantee back: a live run had the *planner*
    // implement its own task, tests and all, and then stop at the plan gate to ask whether the plan
    // was any good.
    //
    // Refusing sends it to the user as a blocked task, which is the decision the gates are built
    // on being human in the first place.
    if phase.is_some_and(|p| p.is_read_only()) {
        log::debug!(
            "[acp] not auto-approving a permission request on session {session_id}: \
             {phase:?} is a read-only phase"
        );
        return false;
    }

    let option_id = perm_req
        .payload
        .get("options")
        .and_then(|v| v.as_array())
        .and_then(|opts| {
            opts.iter()
                .find_map(|opt| {
                    let kind = opt.get("kind").and_then(|v| v.as_str())?;
                    if kind == "allow_always" {
                        return opt
                            .get("optionId")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string());
                    }
                    None
                })
                .or_else(|| {
                    opts.iter().find_map(|opt| {
                        let kind = opt.get("kind").and_then(|v| v.as_str())?;
                        if kind == "allow_once" {
                            return opt
                                .get("optionId")
                                .and_then(|v| v.as_str())
                                .map(|s| s.to_string());
                        }
                        None
                    })
                })
                .or_else(|| {
                    opts.iter().find_map(|opt| {
                        let kind = opt.get("kind").and_then(|v| v.as_str())?;
                        if kind.contains("allow") {
                            return opt
                                .get("optionId")
                                .and_then(|v| v.as_str())
                                .map(|s| s.to_string());
                        }
                        None
                    })
                })
        });

    let Some(oid) = option_id else { return false };

    let response = MaestroRpcMessage::Request(ServerRequest::PermitResponse(
        crate::acp::transport::PermissionResponse {
            session_id: session_id.to_string(),
            request_id: perm_req.request_id.clone(),
            option_id: Some(oid),
        },
    ));
    let _ = crate::acp::write_to_acp_session(app_state, session_id, &response).await;
    true
}

/// Take a plan-mode agent's exit request as the end of its phase, and close the session.
///
/// An agent held in a read-only mode has no way to say "I am finished": its conclusion arrives as a
/// request to leave that mode, mid-turn, with the plan attached. Both obvious answers to that
/// request are wrong, and wrong in a way no wording of the prompt fixes. Granting it hands a
/// read-only role write access — a live run had the *planner* implement its own task, tests and
/// all, and then stop at the gate to ask whether the plan was any good. Refusing it makes the agent
/// reread its plan, polish it and ask again, so the gate never opens.
///
/// The way out is that this is not a question to answer at all. The plan is a *deliverable*, and
/// the session that produced it has no further part to play: a project can put a different agent
/// behind `Planner` and `Coder`, on a different model or a different vendor entirely, so approving
/// a plan cannot mean "let this session continue" — there may be no session to continue into. So
/// the request is read as the artifact: keep the plan, refuse the mode change, and end the session.
/// What the user approves later is a plan on the board, and approving it starts a fresh coder.
///
/// Ending it rather than interrupting the turn is deliberate. An interrupted planner is a live
/// agent sitting in plan mode with nothing to do, holding a subprocess and an agent slot for however
/// many days pass before someone looks at the gate — and still able to be prompted into
/// implementing the work it was supposed to only describe.
///
/// Narrow on purpose, and narrow on the payload rather than on the session's mode. The first version
/// asked whether the session was currently held in `plan`, which is a question the host cannot
/// reliably answer — the cached mode is only as fresh as the last `SetModeOk` or
/// `current_mode_update` the agent chose to send. The plan in the payload is the better
/// discriminator and needs no cache: a request to write a file does not carry one, so a refiner or
/// reviewer running in `default` asking for permission to write still reaches the user as the real
/// question it is. `rawInput.plan` rather than a tool name, so this is not about one agent's
/// vocabulary.
///
/// The three read-only phases are not interchangeable. `is_read_only` admits `SelfReview`, so a
/// plan-mode reviewer reaches this path too, and plan mode is the *default* a reviewer runs in when
/// its profile names no `permission_mode`. The daemon reads its verdict off the plan, which is what
/// the request carries: the `tool_call` announcing `ExitPlanMode` resets the closing message before
/// the permission request arrives. A plan that does not open with the verdict line classifies as
/// `Approved`, which is the documented safe direction — the human gate, not another coder round on
/// a guess.
async fn try_conclude_plan_mode_phase(
    app_state: &Arc<crate::core::AppState>,
    task: TaskKey,
    phase: Option<crate::models::TaskPhase>,
    session_id: &str,
    perm_req: &crate::acp::transport::PermissionRequest,
) -> bool {
    let task_id = task.task_id;
    let Some(plan) = perm_req
        .payload
        .get("toolCall")
        .and_then(|call| call.get("rawInput"))
        .and_then(|input| input.get("plan"))
        .and_then(|plan| plan.as_str())
        .map(str::trim)
        .filter(|plan| !plan.is_empty())
    else {
        log::debug!(
            "[acp] task {task_id}: permission request carries no plan, leaving it to the user"
        );
        return false;
    };

    if !phase.is_some_and(|p| p.is_read_only()) {
        log::debug!("[acp] task {task_id}: {phase:?} may write, so its plan is not a gate");
        return false;
    }

    // The thread entry is what the gate reads, and the daemon files it in the same transaction as
    // the transition, so a gate never opens with nothing in it.
    match end_task_turn(
        app_state,
        task,
        TurnEnding::ArtifactDelivered,
        plan.to_string(),
    )
    .await
    {
        Ok(Some(_)) => {}
        Ok(None) => return false,
        Err(e) => {
            log::warn!("[acp] could not close the read-only phase of task {task_id}: {e}");
            return false;
        }
    }

    let refusal = perm_req
        .payload
        .get("options")
        .and_then(|v| v.as_array())
        .and_then(|options| {
            options.iter().find_map(|option| {
                let kind = option.get("kind").and_then(|v| v.as_str())?;
                kind.contains("reject")
                    .then(|| option.get("optionId").and_then(|v| v.as_str()))
                    .flatten()
                    .map(str::to_string)
            })
        });

    // An agent that offers no refusal is left unanswered rather than granted: the session is closed
    // below either way, and the one thing that must not happen is the mode changing.
    if let Some(option_id) = refusal {
        let response = MaestroRpcMessage::Request(ServerRequest::PermitResponse(
            crate::acp::transport::PermissionResponse {
                session_id: session_id.to_string(),
                request_id: perm_req.request_id.clone(),
                option_id: Some(option_id),
            },
        ));
        if let Err(e) = crate::acp::write_to_acp_session(app_state, session_id, &response).await {
            log::warn!("[acp] could not refuse the mode change for task {task_id}: {e}");
        }
    }

    // After the transition, not before: ending a session fails a task whose phase is still
    // `Running`, which would turn the card red. It is a no-op against the `Waiting` the gate above
    // just wrote, which is the ordering this depends on.
    crate::acp::session_handlers::end_acp_session(app_state, session_id).await;
    log::info!("[acp] took the plan for task {task_id} and closed its planning session");

    true
}

fn emit_session_init_events(
    models: Option<&SessionModelState>,
    modes: Option<&SessionModeState>,
    caps: Option<&PromptCapabilitiesInfo>,
    session_id: &str,
    app_handle: &tauri::AppHandle,
    current_model_id: &Arc<std::sync::Mutex<Option<String>>>,
    current_mode_id: &Arc<std::sync::Mutex<Option<String>>>,
) {
    if let Some(m) = models {
        if let Ok(mut cache) = current_model_id.lock() {
            *cache = Some(m.current_model_id.clone());
        }
        if let Err(e) = app_handle.emit(&format!("acp://session-models/{}", session_id), m) {
            log::warn!("[acp] emit session-models/{session_id} failed: {e}");
        }
    }
    if let Some(m) = modes {
        if let Ok(mut cache) = current_mode_id.lock() {
            *cache = Some(m.current_mode_id.clone());
        }
        if let Err(e) = app_handle.emit(&format!("acp://session-modes/{}", session_id), m) {
            log::warn!("[acp] emit session-modes/{session_id} failed: {e}");
        }
    }
    if let Some(c) = caps {
        if let Err(e) = app_handle.emit(&format!("acp://session-capabilities/{}", session_id), c) {
            log::warn!("[acp] emit session-capabilities/{session_id} failed: {e}");
        }
    }
}

/// Emit Tauri events for a parsed server response. Updates per-session current model/mode IDs.
/// Returns the native ACP session ID when a SpawnOk message is processed, None otherwise.
// Takes the session's shared state as individual borrows because callers hold some of these
// fields separately; passing ReaderTaskContext here would force them to reassemble it.
#[allow(clippy::too_many_arguments)]
fn handle_server_message(
    msg: MaestroRpcMessage,
    session_id: &str,
    app_handle: &tauri::AppHandle,
    current_model_id: &Arc<std::sync::Mutex<Option<String>>>,
    current_mode_id: &Arc<std::sync::Mutex<Option<String>>>,
    pending_file_search: &PendingReply<Vec<String>>,
    pending_file_read: &PendingReply<String>,
    acp_session_id_cache: &Arc<std::sync::Mutex<Option<String>>>,
    replay_buffer: &crate::acp::session_types::ReplayBuffer,
    initialized: &Arc<std::sync::Mutex<bool>>,
    completion_filter: &Arc<std::sync::Mutex<crate::acp::completion::CompletionMarkerFilter>>,
    declared_complete: &Arc<std::sync::atomic::AtomicBool>,
    closing_message: &Arc<std::sync::Mutex<crate::acp::completion::ClosingMessage>>,
) -> Option<String> {
    match msg {
        MaestroRpcMessage::Response(ServerResponse::SessionUpdate(upd)) => {
            // Detect CurrentModeUpdate to keep the per-session current_mode_id current.
            if upd.payload.get("sessionUpdate").and_then(|v| v.as_str())
                == Some("current_mode_update")
            {
                if let Some(mode_id) = upd.payload.get("currentModeId").and_then(|v| v.as_str()) {
                    if let Ok(mut m) = current_mode_id.lock() {
                        *m = Some(mode_id.to_string());
                    }
                    if let Err(e) =
                        app_handle.emit(&format!("acp://mode-changed/{}", session_id), mode_id)
                    {
                        log::warn!("[acp] emit mode-changed/{session_id} failed: {e}");
                    }
                }
            }
            // Strip the completion marker, so it is removed from what the user sees while
            // recording that the agent declared the task done.
            let payload_opt = crate::acp::completion::strip_completion_marker_from_payload(
                upd.payload,
                completion_filter,
                declared_complete,
            );

            if let Some(payload) = payload_opt {
                // After stripping, so the marker never reaches the outcome thread either.
                crate::acp::completion::track_closing_message(
                    &payload,
                    payload
                        .get("content")
                        .and_then(|c| c.get("text"))
                        .and_then(|t| t.as_str()),
                    closing_message,
                );
                emit_or_buffer_payload(payload, replay_buffer, app_handle, session_id);
            }
        }
        MaestroRpcMessage::Response(ServerResponse::TerminalOutput(out)) => {
            #[derive(serde::Serialize)]
            struct Payload<'a> {
                terminal_id: &'a str,
                output: String,
            }
            let payload = Payload {
                terminal_id: &out.terminal_id,
                output: String::from_utf8_lossy(&out.bytes).into_owned(),
            };
            if let Err(e) =
                app_handle.emit(&format!("acp://terminal-output/{}", session_id), &payload)
            {
                log::warn!("[acp] emit terminal-output/{session_id} failed: {e}");
            }
        }
        MaestroRpcMessage::Response(ServerResponse::PermissionRequest(req)) => {
            if let Err(e) =
                app_handle.emit(&format!("acp://permission-request/{}", session_id), &req)
            {
                log::warn!("[acp] emit permission-request/{session_id} failed: {e}");
            }
        }
        MaestroRpcMessage::Response(ServerResponse::ElicitationRequest(req)) => {
            if let Err(e) =
                app_handle.emit(&format!("acp://elicitation-request/{}", session_id), &req)
            {
                log::warn!("[acp] emit elicitation-request/{session_id} failed: {e}");
            }
        }
        MaestroRpcMessage::Response(ServerResponse::SpawnOk(spawn_ok)) => {
            log::debug!(
                "[acp] spawn-ok session_id={session_id} session={} acp_session={:?} model={:?} session_list={} session_load={} session_close={} session_delete={}",
                spawn_ok.session_id,
                spawn_ok.acp_session_id,
                spawn_ok.models.as_ref().map(|m| &m.current_model_id),
                spawn_ok.supports_session_list,
                spawn_ok.supports_session_load,
                spawn_ok.supports_session_close,
                spawn_ok.supports_session_delete,
            );
            emit_session_init_events(
                spawn_ok.models.as_ref(),
                spawn_ok.modes.as_ref(),
                spawn_ok.prompt_capabilities.as_ref(),
                session_id,
                app_handle,
                current_model_id,
                current_mode_id,
            );
            if let Some(ref config_options) = spawn_ok.config_options {
                if let Err(e) = app_handle.emit(
                    &format!("acp://config-state-updated/{}", session_id),
                    &serde_json::json!({ "configOptions": config_options }),
                ) {
                    log::warn!("[acp] emit config-state-updated/{session_id} failed: {e}");
                }
            }
            let new_native_id = if let Some(native_id) = spawn_ok.acp_session_id {
                if let Ok(mut cache) = acp_session_id_cache.lock() {
                    *cache = Some(native_id.clone());
                }
                Some(native_id)
            } else {
                None
            };
            if let Ok(mut init) = initialized.lock() {
                *init = true;
            }
            if let Err(e) = app_handle.emit("sessions-changed", ()) {
                log::warn!("[acp] emit sessions-changed failed: {e}");
            }
            if let Err(e) = app_handle.emit(&format!("acp://spawn-ok/{}", session_id), ()) {
                log::warn!("[acp] emit spawn-ok/{session_id} failed: {e}");
            }
            return new_native_id;
        }
        MaestroRpcMessage::Response(ServerResponse::SessionLoadOk(load_ok)) => {
            log::debug!(
                "[acp] session-load-ok session_id={session_id} session={}",
                load_ok.session_id
            );
            emit_session_init_events(
                load_ok.models.as_ref(),
                load_ok.modes.as_ref(),
                load_ok.prompt_capabilities.as_ref(),
                session_id,
                app_handle,
                current_model_id,
                current_mode_id,
            );
            if let Some(ref config_options) = load_ok.config_options {
                if let Err(e) = app_handle.emit(
                    &format!("acp://config-state-updated/{}", session_id),
                    &serde_json::json!({ "configOptions": config_options }),
                ) {
                    log::warn!("[acp] emit config-state-updated/{session_id} failed: {e}");
                }
            }
            push_config_init_to_buffer(
                load_ok.models.as_ref(),
                load_ok.modes.as_ref(),
                replay_buffer,
            );
            if let Ok(mut init) = initialized.lock() {
                *init = true;
            }
            if let Err(e) = app_handle.emit(&format!("acp://spawn-ok/{}", session_id), ()) {
                log::warn!("[acp] emit spawn-ok/{session_id} failed: {e}");
            }
        }
        MaestroRpcMessage::Response(ServerResponse::SetModelOk(ok)) => {
            log::debug!(
                "[acp] set-model-ok session_id={session_id} model={}",
                ok.model_id
            );
            if let Ok(mut m) = current_model_id.lock() {
                *m = Some(ok.model_id.clone());
            }
            if let Err(e) =
                app_handle.emit(&format!("acp://model-changed/{}", session_id), &ok.model_id)
            {
                log::warn!("[acp] emit model-changed/{session_id} failed: {e}");
            }
        }
        MaestroRpcMessage::Response(ServerResponse::SetModeOk(ok)) => {
            log::debug!(
                "[acp] set-mode-ok session_id={session_id} mode={}",
                ok.mode_id
            );
            if let Ok(mut m) = current_mode_id.lock() {
                *m = Some(ok.mode_id.clone());
            }
            if let Err(e) =
                app_handle.emit(&format!("acp://mode-changed/{}", session_id), &ok.mode_id)
            {
                log::warn!("[acp] emit mode-changed/{session_id} failed: {e}");
            }
        }
        MaestroRpcMessage::Response(ServerResponse::SetConfigOptionOk(ok)) => {
            log::debug!(
                "[acp] set-config-ok session_id={session_id} config={} value={}",
                ok.config_id,
                ok.value
            );
            if let Err(e) = app_handle.emit(
                &format!("acp://config-changed/{}", session_id),
                &serde_json::json!({ "config_id": ok.config_id, "value": ok.value }),
            ) {
                log::warn!("[acp] emit config-changed/{session_id} failed: {e}");
            }
        }
        MaestroRpcMessage::Response(ServerResponse::ConfigOptionUpdated(ok)) => {
            log::debug!(
                "[acp] config-updated session_id={session_id} config={} value={}",
                ok.config_id,
                ok.value
            );
            if ok.config_id == "model" {
                if let Ok(mut m) = current_model_id.lock() {
                    *m = Some(ok.value.clone());
                }
            } else if ok.config_id == "mode" {
                if let Ok(mut m) = current_mode_id.lock() {
                    *m = Some(ok.value.clone());
                }
            }
            if let Err(e) = app_handle.emit(
                &format!("acp://config-state-updated/{}", session_id),
                &serde_json::json!({
                    "config_id": ok.config_id,
                    "value": ok.value,
                    "configOptions": ok.config_options,
                }),
            ) {
                log::warn!("[acp] emit config-state-updated/{session_id} failed: {e}");
            }
        }
        MaestroRpcMessage::Response(ServerResponse::FileSearchOk(FileSearchResponse { files })) => {
            if let Ok(mut guard) = pending_file_search.lock() {
                if let Some(tx) = guard.take() {
                    let _ = tx.send(Ok(files));
                }
            }
        }
        MaestroRpcMessage::Response(ServerResponse::FileReadOk(FileReadResponse { content })) => {
            if let Ok(mut guard) = pending_file_read.lock() {
                if let Some(tx) = guard.take() {
                    let _ = tx.send(Ok(content));
                }
            }
        }
        MaestroRpcMessage::Response(ServerResponse::Error(err)) => {
            log::error!(
                "[acp] session-error session_id={session_id}: {}",
                err.message
            );
            // Resolve any pending file op with the error before emitting the session-error event.
            if let Ok(mut guard) = pending_file_search.lock() {
                if let Some(tx) = guard.take() {
                    let _ = tx.send(Err(err.message.clone()));
                }
            }
            if let Ok(mut guard) = pending_file_read.lock() {
                if let Some(tx) = guard.take() {
                    let _ = tx.send(Err(err.message.clone()));
                }
            }
            if let Err(e) =
                app_handle.emit(&format!("acp://session-error/{}", session_id), &err.message)
            {
                log::error!("[acp] emit session-error/{session_id} failed: {e}");
            }
        }
        MaestroRpcMessage::Response(ServerResponse::TurnEnded(turn_ended)) => {
            log::debug!(
                "[acp] turn-ended session_id={session_id} stop={}",
                turn_ended.stop_reason
            );
            if let Err(e) = app_handle.emit(
                &format!("acp://turn-ended/{}", session_id),
                &turn_ended.stop_reason,
            ) {
                log::warn!("[acp] emit turn-ended/{session_id} failed: {e}");
            }
        }
        MaestroRpcMessage::Response(ServerResponse::Diagnostic(diag)) => {
            log_server_diagnostic(&diag.level, &diag.message);
            if let Err(e) = app_handle.emit(&format!("acp://diagnostic/{}", session_id), &diag) {
                log::warn!("[acp] emit diagnostic/{session_id} failed: {e}");
            }
        }
        _ => {
            // Ignore Request variants arriving on stdout — wrong direction.
        }
    }
    None
}

pub(crate) async fn update_session_from_response(
    session_id: &str,
    msg: &MaestroRpcMessage,
    app_state: &Arc<crate::core::AppState>,
) {
    match msg {
        MaestroRpcMessage::Response(ServerResponse::SpawnOk(r)) => {
            let mut sessions = app_state.acp.sessions.lock().await;
            if let Some(session) = sessions.get_mut(session_id) {
                session.session_capabilities = crate::acp::session_types::SessionCapabilitiesInfo {
                    supports_session_list: r.supports_session_list,
                    supports_session_load: r.supports_session_load,
                    supports_session_close: r.supports_session_close,
                    supports_session_delete: r.supports_session_delete,
                };
                session.config_options = r.config_options.clone().unwrap_or_default();
                session.prompt_capabilities = r.prompt_capabilities.clone();
            }
        }
        MaestroRpcMessage::Response(ServerResponse::SessionLoadOk(r)) => {
            let mut sessions = app_state.acp.sessions.lock().await;
            if let Some(session) = sessions.get_mut(session_id) {
                session.config_options = r.config_options.clone().unwrap_or_default();
                session.prompt_capabilities = r.prompt_capabilities.clone();
            }
        }
        MaestroRpcMessage::Response(ServerResponse::ConfigOptionUpdated(r)) => {
            let mut sessions = app_state.acp.sessions.lock().await;
            if let Some(session) = sessions.get_mut(session_id) {
                session.config_options = r.config_options.clone();
            }
        }
        MaestroRpcMessage::Response(ServerResponse::SessionUpdate(upd))
            if upd.payload.get("sessionUpdate").and_then(|v| v.as_str())
                == Some("config_option_update") =>
        {
            if let Some(options_val) = upd.payload.get("configOptions") {
                if let Ok(options) =
                    serde_json::from_value::<Vec<serde_json::Value>>(options_val.clone())
                {
                    let mut sessions = app_state.acp.sessions.lock().await;
                    if let Some(session) = sessions.get_mut(session_id) {
                        session.config_options = options;
                    }
                }
            }
        }
        _ => {}
    }
}

fn extract_session_id(msg: &MaestroRpcMessage) -> Option<String> {
    match msg {
        MaestroRpcMessage::Response(_) => msg.session_id().map(str::to_owned),
        MaestroRpcMessage::Request(_) => None,
    }
}

/// How much is kept for one session nobody here holds yet, and for how many such sessions.
///
/// Most of what lands unclaimed is for a session that is already gone, or belongs to a project
/// this window does not have open, and is never collected; the bounds are what keep that from
/// growing. An automation's session is adopted within seconds of starting, well inside both.
const UNCLAIMED_PER_SESSION: usize = 500;
const UNCLAIMED_SESSIONS: usize = 16;

/// Keep a message for a session this side does not hold, until adoption collects it.
async fn park_unclaimed(
    app_state: &Arc<crate::core::AppState>,
    session_id: String,
    msg: MaestroRpcMessage,
) {
    let mut unclaimed = app_state.acp.unclaimed_messages.lock().await;
    // ponytail: dropping every parked session when a new one would exceed the cap loses a
    // session mid-adoption only if sixteen others are unclaimed at once; evict oldest if it does.
    if !unclaimed.contains_key(&session_id) && unclaimed.len() >= UNCLAIMED_SESSIONS {
        unclaimed.clear();
    }
    let parked = unclaimed.entry(session_id).or_default();
    if parked.len() < UNCLAIMED_PER_SESSION {
        parked.push(msg);
    }
}

/// Take whatever was said to a session before this side held it, oldest first.
pub(crate) async fn take_unclaimed(
    app_state: &crate::core::AppState,
    session_id: &str,
) -> Vec<MaestroRpcMessage> {
    app_state
        .acp
        .unclaimed_messages
        .lock()
        .await
        .remove(session_id)
        .unwrap_or_default()
}

/// Which of this app's projects on `connection_key` a daemon's canonical path names.
fn project_id_for_path(
    app_state: &crate::core::AppState,
    connection_key: crate::acp::ConnectionKey,
    canonical_path: &str,
) -> Option<i32> {
    let conn = app_state.db.lock().ok()?;
    let mut statement = conn
        .prepare(
            "SELECT id, path, connection_id, wsl_connection_id, docker_connection_id FROM projects",
        )
        .ok()?;
    let rows: Vec<(i32, String, crate::acp::ConnectionKey)> = statement
        .query_map([], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                crate::acp::ConnectionKey::from_all_ids(row.get(2)?, row.get(3)?, row.get(4)?),
            ))
        })
        .ok()?
        .filter_map(Result::ok)
        .collect();
    // A local Windows path resolves to the case the directory has on disk, not the case it was
    // opened with.
    let ignore_case = cfg!(windows) && connection_key == crate::acp::ConnectionKey::Local;
    match_project_path(rows, connection_key, canonical_path, ignore_case)
}

/// Compared with separators and a trailing slash tidied, the part of the daemon's
/// `canonical_project_path` this side can reproduce.
///
/// A project opened through a symlink does not match, and its pushes carry no id. That is safe:
/// a push naming no project is refetched by every window, which costs a request and loses nothing.
fn match_project_path(
    rows: Vec<(i32, String, crate::acp::ConnectionKey)>,
    connection_key: crate::acp::ConnectionKey,
    canonical_path: &str,
    ignore_case: bool,
) -> Option<i32> {
    fn tidy(path: &str) -> String {
        let path = path
            .strip_prefix(r"\\?\")
            .unwrap_or(path)
            .replace('\\', "/");
        path.trim_end_matches('/').to_string()
    }
    let wanted = tidy(canonical_path);
    rows.into_iter()
        .find(|(_, path, key)| {
            *key == connection_key
                && if ignore_case {
                    tidy(path).eq_ignore_ascii_case(&wanted)
                } else {
                    tidy(path) == wanted
                }
        })
        .map(|(id, _, _)| id)
}

/// Route a shared-reader message that carries no request id: to its session's handler when it
/// names one, and otherwise as the unprompted event it is. Replies that do carry an id never
/// reach here, see `deliver_reply`.
pub(crate) async fn handle_shared_server_message(
    msg: MaestroRpcMessage,
    connection_key: crate::acp::ConnectionKey,
    app_handle: &tauri::AppHandle,
    app_state: &Arc<crate::core::AppState>,
    pending: &PendingRequests,
) {
    // Session-bearing messages: extract session_id, borrow caches from AcpProcess,
    // then call the existing single-session handler.
    if let Some(session_id) = extract_session_id(&msg) {
        // A request made for this session whose reply names none, a file search or read, cannot
        // be answered once the session has failed.
        if let MaestroRpcMessage::Response(ServerResponse::Error(error)) = &msg {
            pending.fail_session(&session_id, &error.message);
        }
        update_session_from_response(&session_id, &msg, app_state).await;

        // The shared prompt tools need no session, and the daemon sends each one to a single
        // window (`ClientSink::write_to_one`), so whichever window gets it answers, held or not.
        if let MaestroRpcMessage::Response(ServerResponse::HostToolCall(call)) = &msg {
            if crate::acp::host_tools::is_prompt_tool(&call.name) {
                if let MaestroRpcMessage::Response(ServerResponse::HostToolCall(call)) = msg {
                    let state = Arc::clone(app_state);
                    tokio::spawn(async move {
                        crate::acp::host_tools::answer_prompt_tool(&state, connection_key, call)
                            .await;
                    });
                }
                return;
            }
        }

        // Before the cache borrow below: this needs none of it, and the shared reader serves
        // every session on the connection, so a `canvas_await` answered inline would block all
        // of them for as long as the user takes.
        //
        // Only for a session this window holds: a daemon serving several windows sends a session
        // with no owner to all of them, and two answers to one call would race. The window that
        // does not hold it parks the call below, to answer it if it adopts the session.
        let held = matches!(
            msg,
            MaestroRpcMessage::Response(ServerResponse::HostToolCall(_))
        ) && app_state
            .acp
            .sessions
            .lock()
            .await
            .contains_key(&session_id);
        if held {
            if let MaestroRpcMessage::Response(ServerResponse::HostToolCall(call)) = msg {
                let state = Arc::clone(app_state);
                tokio::spawn(async move {
                    crate::acp::host_tools::handle(state, &session_id, call).await;
                });
                return;
            }
        }

        let caches = {
            let sessions = app_state.acp.sessions.lock().await;
            sessions.get(&session_id).map(|s| {
                (
                    Arc::clone(&s.current_model_id),
                    Arc::clone(&s.current_mode_id),
                    Arc::clone(&s.pending_file_search),
                    Arc::clone(&s.pending_file_read),
                    Arc::clone(&s.acp_session_id),
                    Arc::clone(&s.replay_buffer),
                    Arc::clone(&s.initialized),
                    Arc::clone(&s.completion_filter),
                    Arc::clone(&s.declared_complete),
                    Arc::clone(&s.user_interrupted),
                    Arc::clone(&s.closing_message),
                    Arc::clone(&s.permission_queue),
                    s.agent_id_meta.clone(),
                    s.task_key(),
                )
            })
        };
        if let Some((
            current_model_id,
            current_mode_id,
            pfs,
            pfr,
            acp_sid,
            replay,
            initialized,
            completion_filter,
            declared_complete,
            user_interrupted,
            closing_message,
            permission_queue,
            agent_id,
            task,
        )) = caches
        {
            if let (
                Some(task),
                MaestroRpcMessage::Response(ServerResponse::PermissionRequest(perm_req)),
            ) = (task, &msg)
            {
                spawn_task_permission_request(
                    app_state,
                    task,
                    &session_id,
                    &permission_queue,
                    perm_req.clone(),
                );
                return;
            }

            if let MaestroRpcMessage::Response(ServerResponse::ElicitationRequest(_)) = msg {
                if let Some(task) = task {
                    spawn_mark_task_blocked(app_state, task);
                }
            }

            // Off the reader loop — see the matching comment in `spawn_reader_task`. This
            // path is worse: the shared reader serves every session on the connection, so
            // one task's hung `git rev-parse` would stall turn-ended for all of them.
            if let MaestroRpcMessage::Response(ServerResponse::TurnEnded(ref turn_ended)) = msg {
                if let Some(task) = task {
                    let state = Arc::clone(app_state);
                    let stop_reason = turn_ended.stop_reason.clone();
                    let declared =
                        declared_complete.swap(false, std::sync::atomic::Ordering::AcqRel);
                    let interrupted =
                        user_interrupted.swap(false, std::sync::atomic::Ordering::AcqRel);
                    // Drained here rather than in the spawned task, so the accumulator is empty
                    // before the next turn starts writing into it.
                    let closing = closing_message
                        .lock()
                        .map(|mut m| m.take())
                        .unwrap_or_default();
                    tokio::spawn(async move {
                        resolve_turn_end(
                            &state,
                            task,
                            &stop_reason,
                            declared,
                            interrupted,
                            closing,
                        )
                        .await;
                    });
                }
            }

            // If the agent completed a turn without needing auth, it has valid credentials.
            // This covers token-configured agents that never go through the explicit auth flow.
            if let MaestroRpcMessage::Response(ServerResponse::TurnEnded(ref turn_ended)) = msg {
                if turn_ended.stop_reason != "auth_required" {
                    let needs_auth_event = {
                        let mut auth_map = app_state.acp.agent_auth_info.lock().await;
                        if let Some(info) = auth_map.get_mut(&(connection_key, agent_id.clone())) {
                            if !info.authenticated {
                                info.authenticated = true;
                                true
                            } else {
                                false
                            }
                        } else {
                            false
                        }
                    };
                    if needs_auth_event {
                        let conn_key_id = match connection_key {
                            crate::acp::ConnectionKey::Local => "local".to_string(),
                            crate::acp::ConnectionKey::Ssh { id } => format!("ssh-{id}"),
                            crate::acp::ConnectionKey::Wsl { id } => format!("wsl-{id}"),
                            crate::acp::ConnectionKey::Docker { id } => format!("docker-{id}"),
                        };
                        app_handle
                            .emit(
                                &format!("acp://auth-state-changed/{}", conn_key_id),
                                &serde_json::json!({ "agentId": agent_id }),
                            )
                            .ok();
                    }
                }
            }

            let is_permission_request = matches!(
                msg,
                MaestroRpcMessage::Response(ServerResponse::PermissionRequest(_))
            );
            let is_session_load_error = is_fatal_session_error(&msg);
            let is_gone = is_gone_session_error(&msg);
            handle_server_message(
                msg,
                &session_id,
                app_handle,
                &current_model_id,
                &current_mode_id,
                &pfs,
                &pfr,
                &acp_sid,
                &replay,
                &initialized,
                &completion_filter,
                &declared_complete,
                &closing_message,
            );
            if is_permission_request {
                let sessions = app_state.acp.sessions.lock().await;
                if let Some(session) = sessions.get(&session_id) {
                    session
                        .has_pending_permission
                        .store(true, Ordering::Release);
                }
            }
            if is_session_load_error {
                // Session load failed (agent no longer has this session). Remove from the in-memory
                // map so getActiveSessions no longer lists it, then notify the frontend.
                app_state.acp.sessions.lock().await.remove(&session_id);
                fail_task_if_still_running(app_state, task);
                if let Err(e) = app_handle.emit("sessions-changed", ()) {
                    log::warn!("[acp] emit sessions-changed failed: {e}");
                }
                let acp_session_id = acp_sid.lock().ok().and_then(|id| id.clone());
                if let (true, Some(acp_session_id)) = (is_gone, acp_session_id) {
                    // Off this task: the reply comes back through the reader this runs on.
                    tokio::spawn({
                        let app_state = Arc::clone(app_state);
                        async move {
                            if let Err(e) =
                                crate::acp::connection_server::query_close_project_session_via_server(
                                    connection_key,
                                    maestro_protocol::CloseProjectSessionRequest {
                                        agent_id,
                                        acp_session_id,
                                    },
                                    &app_state,
                                )
                                .await
                            {
                                log::warn!("[acp] could not close a session that is gone: {e}");
                            }
                        }
                    });
                }
            }
        } else {
            // The session left the map between the agent answering and us handling the
            // reply — cleanup, a failed write rollback, a concurrent close. Everything
            // above needs the caches, but turn-ended does not: dropping it here is what
            // strands the UI in "thinking", so emit it anyway.
            log::warn!(
                "[acp] no session entry for session_id={session_id} while handling agent reply"
            );
            if let MaestroRpcMessage::Response(ServerResponse::TurnEnded(ref turn_ended)) = msg {
                if let Err(e) = app_handle.emit(
                    &format!("acp://turn-ended/{}", session_id),
                    &turn_ended.stop_reason,
                ) {
                    log::warn!("[acp] emit turn-ended/{session_id} failed: {e}");
                }
            }
            park_unclaimed(app_state, session_id, msg).await;
        }
        return;
    }

    // Sessionless messages.
    match msg {
        // Unsolicited: the clock started this, not the window. Named by project rather than sent
        // to a particular view, because the run belongs to a project whether or not it is open.
        MaestroRpcMessage::Response(ServerResponse::AutomationRunChanged(run)) => {
            crate::core::emit_or_log(app_handle, "automation-run-changed", &run);
        }
        // Pushed to every window on the daemon after any write, this one's included, for every
        // project there: `project_id` is which of this app's projects it is, `null` for one it
        // does not have.
        MaestroRpcMessage::Response(ServerResponse::TasksChanged(project)) => {
            let project_id = project_id_for_path(app_state, connection_key, &project.project_path);
            crate::core::emit_or_log(
                app_handle,
                "tasks-changed",
                &serde_json::json!({ "project_id": project_id }),
            );
        }
        MaestroRpcMessage::Response(ServerResponse::WorktreesChanged(project)) => {
            let project_id = project_id_for_path(app_state, connection_key, &project.project_path);
            crate::core::emit_or_log(
                app_handle,
                "worktrees-changed",
                &serde_json::json!({ "project_id": project_id }),
            );
        }
        MaestroRpcMessage::Response(ServerResponse::PromptsChanged(project)) => {
            let project_id = project_id_for_path(app_state, connection_key, &project.project_path);
            // `project_id` is null when the path matches no project this app knows of.
            crate::core::emit_or_log(
                app_handle,
                "prompts-changed",
                &serde_json::json!({ "collection": "project", "project_id": project_id }),
            );
        }
        // Only the window holding the project takes the session over. Adopting asks the daemon
        // for its row, and a reply comes back through this reader, so it runs on a task of its own.
        MaestroRpcMessage::Response(ServerResponse::TaskSessionStarted(started)) => {
            let held = app_state
                .active_project_lock
                .lock()
                .ok()
                .and_then(|held| *held);
            let project_id = project_id_for_path(app_state, connection_key, &started.project_path);
            if let Some(project_id) =
                crate::acp::session_ops::task_session_target(held, connection_key, project_id)
            {
                tokio::spawn(crate::acp::session_ops::adopt_task_session(
                    connection_key,
                    project_id,
                    started.task_id,
                    started.session_id,
                    Arc::clone(app_state),
                ));
            }
        }
        // The machine's capacity or a project's auto mode: either can let the queue move.
        MaestroRpcMessage::Response(ServerResponse::PipelineSettingsChanged(_)) => {
            crate::core::emit_or_log(app_handle, "settings-changed", &());
        }
        // Named by project as well, since task ids are per project.
        MaestroRpcMessage::Response(ServerResponse::TaskCommentsChanged(task)) => {
            let project_id = project_id_for_path(app_state, connection_key, &task.project_path);
            crate::core::emit_or_log(
                app_handle,
                "task-comments-changed",
                &serde_json::json!({ "project_id": project_id, "task_id": task.task_id }),
            );
        }
        MaestroRpcMessage::Response(response @ ServerResponse::TakeoverResultOk(_)) => {
            pending.deliver_takeover(response);
        }
        // Unsolicited, like a run changing: some window somewhere opened or left a project.
        MaestroRpcMessage::Response(ServerResponse::ProjectLocksChanged) => {
            crate::core::emit_or_log(app_handle, "project-locks-changed", &connection_key);
        }
        MaestroRpcMessage::Response(ServerResponse::TakeoverRequested(req)) => {
            crate::core::emit_or_log(
                app_handle,
                "project-takeover-requested",
                &serde_json::json!({
                    "connection": connection_key,
                    "request_id": req.request_id,
                    "project_path": req.project_path,
                    "requester_label": req.requester_label,
                }),
            );
        }
        MaestroRpcMessage::Response(ServerResponse::ProjectKicked(kicked)) => {
            let released = match app_state.active_project_lock.lock() {
                Ok(mut held) => match *held {
                    Some((project_id, key)) if key == connection_key => {
                        *held = None;
                        Some(project_id)
                    }
                    _ => None,
                },
                Err(_) => None,
            };
            // The daemon keeps running these for whoever holds the project now, and may reload
            // them under new ids. Kept here, they would be taken for that window's sessions the
            // next time this one opens the project, and prompt ids nothing routes.
            if let Some(project_id) = released {
                let entries: Vec<String> = app_state
                    .acp
                    .sessions
                    .lock()
                    .await
                    .iter()
                    .filter(|(_, process)| {
                        process.project_id == Some(project_id)
                            && process.connection_key == connection_key
                    })
                    .map(|(session_id, _)| session_id.clone())
                    .collect();
                crate::acp::session_ops::forget_sessions(app_state, &entries).await;
            }
            crate::core::emit_or_log(
                app_handle,
                "project-kicked",
                &serde_json::json!({
                    "project_path": kicked.project_path,
                    "reason": kicked.reason,
                }),
            );
        }
        MaestroRpcMessage::Response(ServerResponse::AuthTerminalExit(exit)) => {
            let conn_key_id = match connection_key {
                crate::acp::ConnectionKey::Local => "local".to_string(),
                crate::acp::ConnectionKey::Ssh { id } => format!("ssh-{id}"),
                crate::acp::ConnectionKey::Wsl { id } => format!("wsl-{id}"),
                crate::acp::ConnectionKey::Docker { id } => format!("docker-{id}"),
            };
            app_handle
                .emit(
                    &format!("acp://auth-pty-exit/{}", conn_key_id),
                    &serde_json::json!({ "exit_code": exit.exit_code }),
                )
                .ok();
            if exit.exit_code == Some(0) {
                {
                    let mut map = app_state.acp.agent_auth_info.lock().await;
                    if let Some(info) = map.get_mut(&(connection_key, exit.agent_id.clone())) {
                        info.authenticated = true;
                    }
                }
                app_handle
                    .emit(
                        &format!("acp://auth-state-changed/{}", conn_key_id),
                        &serde_json::json!({ "agentId": exit.agent_id }),
                    )
                    .ok();
            }
        }
        MaestroRpcMessage::Response(ServerResponse::AgentConnectionLost(lost)) => {
            for session_id_str in &lost.affected_session_ids {
                {
                    let session_id = session_id_str.clone();
                    // The removed entry is the only place the task id is still available.
                    let removed = app_state.acp.sessions.lock().await.remove(&session_id);
                    fail_task_if_still_running(app_state, removed.and_then(|s| s.task_key()));
                    if let Err(e) =
                        app_handle.emit(&format!("acp://session-ended/{}", session_id), ())
                    {
                        log::warn!("[acp] emit session-ended/{session_id} failed: {e}");
                    }
                }
            }
            log::warn!(
                "[acp] agent-connection-lost agent={} reason={} sessions={:?}",
                lost.agent_id,
                lost.reason,
                lost.affected_session_ids
            );
            app_state.app_handle.emit("sessions-changed", ()).ok();
        }
        MaestroRpcMessage::Response(ServerResponse::Diagnostic(diag)) => {
            log_server_diagnostic(&diag.level, &diag.message);
            // Best-effort: emit to any session on this connection for frontend visibility.
            let session_ids: Vec<String> = {
                let sessions = app_state.acp.sessions.lock().await;
                sessions
                    .iter()
                    .filter(|(_, s)| s.connection_key == connection_key)
                    .map(|(id, _)| id.clone())
                    .collect()
            };
            for lid in session_ids {
                crate::core::emit_or_log(app_handle, &format!("acp://diagnostic/{}", lid), &diag);
            }
            // Connection-scoped event so the auth modal can receive output even when the
            // session that triggered auth was discarded before the modal opened.
            app_handle
                .emit(
                    &format!("acp://auth-output/{}", connection_key_id(&connection_key)),
                    &diag,
                )
                .ok();
        }
        MaestroRpcMessage::Response(ServerResponse::Error(err)) => {
            // No id and no session: nothing says which request this answers, so every session
            // on the connection is told.
            let session_ids: Vec<String> = {
                let sessions = app_state.acp.sessions.lock().await;
                sessions
                    .iter()
                    .filter(|(_, s)| s.connection_key == connection_key)
                    .map(|(id, _)| id.clone())
                    .collect()
            };
            for session_id in session_ids {
                if let Err(e) =
                    app_handle.emit(&format!("acp://session-error/{}", session_id), &err.message)
                {
                    log::error!("[acp] emit session-error/{session_id} failed: {e}");
                }
            }
        }
        _ => {}
    }
}

/// Hand a reply to the request whose id it carries.
async fn deliver_reply(
    id: maestro_protocol::RequestId,
    response: ServerResponse,
    connection_key: crate::acp::ConnectionKey,
    app_state: &Arc<crate::core::AppState>,
    pending: &PendingRequests,
) {
    if let ServerResponse::PreInitializeOk(resp) = &response {
        // Store auth info before sending the response to avoid a race.
        // Preserve authenticated=true if the agent was already authenticated this session
        // (e.g., after terminal auth, the retry spawns a new session and re-sends PreInitializeOk).
        let mut auth_map = app_state.acp.agent_auth_info.lock().await;
        let key = (connection_key, resp.agent_id.clone());
        let prev_authenticated = auth_map
            .get(&key)
            .map(|info| info.authenticated)
            .unwrap_or(false);
        let auth_info = crate::acp::session_types::AgentAuthInfo {
            auth_methods: resp
                .auth_methods
                .iter()
                .map(|m| crate::acp::session_types::AuthMethodDto {
                    id: m.id.clone(),
                    name: m.name.clone(),
                    description: m.description.clone(),
                    method_type: m.method_type.clone(),
                    args: m.args.clone(),
                })
                .collect(),
            supports_logout: resp.supports_auth_logout,
            authenticated: prev_authenticated,
        };
        auth_map.insert(key, auth_info);
        log::debug!(
            "[acp] pre-initialize-ok agent_id={} session_list={} session_load={} session_close={} session_delete={}",
            resp.agent_id,
            resp.supports_session_list,
            resp.supports_session_load,
            resp.supports_session_close,
            resp.supports_session_delete
        );
    }
    if !pending.deliver(id, response) {
        log::debug!("[acp] dropped the reply to request {id}: nothing is waiting on it any more");
    }
}

// Each argument is a separate piece of the connection server the reader outlives its caller with.
#[allow(clippy::too_many_arguments)]
pub(crate) fn spawn_shared_reader_task(
    source: AcpReadSource,
    connection_key: crate::acp::ConnectionKey,
    last_ping_at: Arc<AtomicU64>,
    writer_tx: tokio::sync::mpsc::Sender<Vec<u8>>,
    app_handle: tauri::AppHandle,
    app_state: Arc<crate::core::AppState>,
    pending: PendingRequests,
    ended: Arc<tokio::sync::Notify>,
) {
    tokio::spawn(async move {
        let mut source = source;

        let watchdog_alive = Arc::new(AtomicBool::new(true));
        tokio::spawn({
            let watchdog_alive = Arc::clone(&watchdog_alive);
            let last_ping_at = Arc::clone(&last_ping_at);
            let app_handle = app_handle.clone();
            async move {
                // Going quiet and coming back are both reported once, rather than every tick, so
                // the UI is driven by transitions instead of a repeating warning.
                let mut reported_quiet = false;
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(15)).await;
                    if !watchdog_alive.load(Ordering::Relaxed) {
                        break;
                    }
                    let last = last_ping_at.load(Ordering::Relaxed);
                    if last == 0 {
                        // No ping received yet — server may still be starting up.
                        continue;
                    }
                    let now = SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_secs();
                    let secs_since = now.saturating_sub(last);
                    if secs_since > 25 && !reported_quiet {
                        reported_quiet = true;
                        log::warn!("[acp] connection stale for {connection_key:?}: {secs_since}s since last ping");
                        if let Err(e) = app_handle.emit(
                            "acp://connection-stale",
                            ConnectionQuiet {
                                connection: connection_key,
                                quiet_for_secs: secs_since,
                            },
                        ) {
                            log::warn!("[acp] emit connection-stale failed: {e}");
                        }
                    } else if secs_since <= 25 && reported_quiet {
                        reported_quiet = false;
                        log::info!("[acp] connection responding again for {connection_key:?}");
                        if let Err(e) = app_handle.emit(
                            "acp://connection-live",
                            ConnectionEvent {
                                connection: connection_key,
                            },
                        ) {
                            log::warn!("[acp] emit connection-live failed: {e}");
                        }
                    }
                }
            }
        });

        while let Some((id, msg)) = source.next_message_with_id().await {
            match &msg {
                MaestroRpcMessage::Response(ServerResponse::Ping { .. })
                | MaestroRpcMessage::Response(ServerResponse::TerminalOutput(_)) => {}
                _ => {
                    if let Ok(json) = serde_json::to_string(&msg) {
                        log::trace!("[acp] << {connection_key:?} id={id:?} {json}");
                    }
                }
            }
            if let MaestroRpcMessage::Response(ServerResponse::Ping { seq }) = &msg {
                let now = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs();
                last_ping_at.store(now, Ordering::Relaxed);
                log::trace!("[acp] ping seq={seq} from {connection_key:?}");
                let pong = MaestroRpcMessage::Request(ServerRequest::Pong { seq: *seq });
                match serialize_message(&pong) {
                    Ok(bytes) => {
                        if let Err(e) = writer_tx.send(bytes).await {
                            log::warn!("[acp] pong send failed: {e}");
                        }
                    }
                    Err(e) => log::warn!("[acp] pong serialize failed: {e}"),
                }
                if let Err(e) = app_handle.emit("acp://heartbeat", ()) {
                    log::warn!("[acp] emit heartbeat failed: {e}");
                }
                continue;
            }
            // A reply to a session-scoped request never carries an id, so one that names a
            // session is left to the routing every session message takes.
            if let (Some(id), None) = (id, extract_session_id(&msg)) {
                if let MaestroRpcMessage::Response(response) = msg {
                    deliver_reply(id, response, connection_key, &app_state, &pending).await;
                }
                continue;
            }
            handle_shared_server_message(msg, connection_key, &app_handle, &app_state, &pending)
                .await;
        }

        watchdog_alive.store(false, Ordering::Relaxed);
        // Nothing will answer them now, and leaving them to their timeouts holds the caller for
        // as long as five minutes.
        pending.fail_all("The connection to the server closed before it answered");
        ended.notify_one();

        // Server process died — clean up all shared sessions for this connection.
        // The entry still being here is what distinguishes a death from a teardown: closing the
        // last session on a connection removes it first, which drops the child and ends this
        // stream. Announcing that as a lost connection put a blocking backdrop over a deliberate
        // close.
        let was_registered = app_state
            .acp
            .connection_servers
            .lock()
            .await
            .remove(&connection_key)
            .is_some();

        // Announce it before the sessions go. SSH has its own reconnect story and reports through
        // the `ssh-*` events; every other transport ends here, and until this existed their
        // sessions simply vanished from the UI with nothing said.
        if was_registered && !matches!(connection_key, crate::acp::ConnectionKey::Ssh { .. }) {
            log::warn!("[acp] connection server ended for {connection_key:?}");
            if let Err(e) = app_handle.emit(
                "acp://connection-lost",
                ConnectionEvent {
                    connection: connection_key,
                },
            ) {
                log::warn!("[acp] emit connection-lost failed: {e}");
            }
        }

        // Snapshot restorable metadata before removing sessions from the map.
        // Sessions without an acp_session_id haven't received SpawnOk yet and cannot
        // be restored — emit session-ended for those immediately.
        let (to_restore, to_end_now): (Vec<RestorableSession>, Vec<String>) = {
            let sessions = app_state.acp.sessions.lock().await;
            let mut restorable: Vec<RestorableSession> = Vec::new();
            let mut unrestorable: Vec<String> = Vec::new();
            let is_ssh = matches!(connection_key, crate::acp::ConnectionKey::Ssh { .. });
            for (session_id, s) in sessions
                .iter()
                .filter(|(_, s)| s.connection_key == connection_key)
            {
                let acp_session_id = s.acp_session_id.lock().ok().and_then(|g| g.clone());
                if acp_session_id.is_some() && is_ssh {
                    restorable.push(RestorableSession {
                        session_id: session_id.clone(),
                        acp_session_id,
                        project_id: s.project_id,
                    });
                } else {
                    unrestorable.push(session_id.clone());
                }
            }
            (restorable, unrestorable)
        };

        // Remove all affected sessions from the map.
        {
            let mut sessions = app_state.acp.sessions.lock().await;
            for s in &to_restore {
                sessions.remove(&s.session_id);
            }
            for session_id in &to_end_now {
                sessions.remove(session_id);
            }
        }

        // Immediately end unrestorable sessions (no acp_session_id yet, or non-SSH).
        for session_id in &to_end_now {
            if let Err(e) = app_handle.emit(&format!("acp://session-ended/{}", session_id), ()) {
                log::warn!("[acp] emit session-ended/{session_id} failed: {e}");
            }
        }

        // SSH connections only: park restorable sessions for the reconnect handler.
        // Local and WSL have no reconnect path — end immediately.
        match &connection_key {
            crate::acp::ConnectionKey::Ssh { id: conn_id } if !to_restore.is_empty() => {
                app_state
                    .acp
                    .restorable_sessions
                    .lock()
                    .await
                    .insert(*conn_id, to_restore);
            }
            _ => {
                for s in &to_restore {
                    if let Err(e) =
                        app_handle.emit(&format!("acp://session-ended/{}", s.session_id), ())
                    {
                        log::warn!("[acp] emit session-ended/{} failed: {e}", s.session_id);
                    }
                }
            }
        }

        app_state.app_handle.emit("sessions-changed", ()).ok();
    });
}

fn connection_key_id(key: &crate::acp::ConnectionKey) -> String {
    match key {
        crate::acp::ConnectionKey::Local => "local".to_string(),
        crate::acp::ConnectionKey::Ssh { id } => format!("ssh-{id}"),
        crate::acp::ConnectionKey::Wsl { id } => format!("wsl-{id}"),
        crate::acp::ConnectionKey::Docker { id } => format!("docker-{id}"),
    }
}

/// Whether an error response means the session it names is gone, rather than merely that
/// something went wrong inside it.
///
/// `ErrorResponse::session_id` says only that the error is *scoped to* a session. Treating that
/// alone as fatal — which is what this used to do — made the caller drop the session from the map
/// and fail its task for any session-scoped error, so a single new error carrying an id would
/// silently take a live session's compose bar with it. A load failure is the one fatal case, and
/// it announces itself in the message.
///
/// Matched by prefix rather than equality: the message carries the agent's own reason after it,
/// and servers deployed into `.maestro/bin/` predate the constant while spelling it identically.
fn is_fatal_session_error(msg: &MaestroRpcMessage) -> bool {
    matches!(
        msg,
        MaestroRpcMessage::Response(ServerResponse::Error(e))
            if e.session_id.is_some()
                && e.message.starts_with(maestro_protocol::SESSION_LOAD_FAILED_ERROR)
    )
}

/// Whether a load failed for a reason no later attempt gets past, so the daemon's row for the
/// conversation should be closed.
///
/// An open row is loaded again every time the project is opened, which is right for an agent that
/// crashed or wants signing in to again and wrong for a conversation that no longer exists. The
/// daemon tells the two apart, because it holds the agent's error code and this side is sent only
/// the agent's wording. A load that could not be sent at all, a connection that is down, never
/// produces this message, so an unreachable host keeps its sessions.
fn is_gone_session_error(msg: &MaestroRpcMessage) -> bool {
    matches!(
        msg,
        MaestroRpcMessage::Response(ServerResponse::Error(e))
            if e.session_id.is_some()
                && e.message.starts_with(maestro_protocol::SESSION_GONE_ERROR)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    mod project_paths {
        use super::*;
        use crate::acp::ConnectionKey;

        fn rows() -> Vec<(i32, String, ConnectionKey)> {
            vec![
                (1, r"C:\Users\Dev\Shop\".to_string(), ConnectionKey::Local),
                (2, "/srv/shop".to_string(), ConnectionKey::Ssh { id: 7 }),
                (
                    3,
                    "/home/dev/shop/".to_string(),
                    ConnectionKey::Wsl { id: 2 },
                ),
            ]
        }

        #[test]
        fn a_local_windows_path_matches_whatever_its_case_and_prefix() {
            let found = |path, ignore_case| {
                match_project_path(rows(), ConnectionKey::Local, path, ignore_case)
            };
            assert_eq!(found(r"\\?\C:\users\dev\shop", true), Some(1));
            assert_eq!(found("C:/Users/Dev/Shop", false), Some(1));
            assert_eq!(found(r"C:\users\dev\shop", false), None);
        }

        #[test]
        fn a_remote_path_matches_exactly_on_its_own_connection() {
            let ssh = ConnectionKey::Ssh { id: 7 };
            let wsl = ConnectionKey::Wsl { id: 2 };
            assert_eq!(
                match_project_path(rows(), ssh, "/srv/shop/", false),
                Some(2)
            );
            assert_eq!(match_project_path(rows(), ssh, "/srv/Shop", false), None);
            assert_eq!(
                match_project_path(rows(), wsl, "/home/dev/shop", false),
                Some(3)
            );
            assert_eq!(
                match_project_path(rows(), ConnectionKey::Ssh { id: 8 }, "/srv/shop", false),
                None
            );
        }
    }

    mod fatal_session_errors {
        use super::*;
        use crate::acp::transport::ErrorResponse;

        fn error(message: &str, session_id: Option<&str>) -> MaestroRpcMessage {
            MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
                message: message.to_string(),
                session_id: session_id.map(str::to_string),
            }))
        }

        /// Every gone session is a failed load, so the entry is torn down either way. Only the one
        /// the daemon calls gone costs the conversation its row.
        #[test]
        fn only_a_session_the_daemon_calls_gone_closes_its_row() {
            let gone = error(
                "ACP session/load failed: the session is gone: Resource not found: 558e4705",
                Some("session-3"),
            );
            assert!(is_fatal_session_error(&gone));
            assert!(is_gone_session_error(&gone));

            for retryable in [
                "ACP session/load failed: Authentication required",
                "ACP session/load failed: Internal error",
            ] {
                let message = error(retryable, Some("session-3"));
                assert!(is_fatal_session_error(&message));
                assert!(!is_gone_session_error(&message));
            }
            assert!(!is_gone_session_error(&error(
                "ACP session/load failed: the session is gone",
                None,
            )));
        }

        #[test]
        fn a_load_failure_ends_the_session() {
            assert!(is_fatal_session_error(&error(
                "ACP session/load failed: Resource not found: 558e4705",
                Some("session-3"),
            )));
        }

        /// The bug: every error naming a session was read as "this session is gone", so the first
        /// session-scoped error that was not a load failure would tear down a working session and
        /// leave the user reading a transcript they could not reply to.
        #[test]
        fn another_error_scoped_to_a_session_leaves_it_alone() {
            assert!(!is_fatal_session_error(&error(
                "session file read failed: permission denied",
                Some("session-3"),
            )));
        }

        /// Connection-level failures carry no id and are handled elsewhere; claiming them here
        /// would end whichever session the message happened to be routed to.
        #[test]
        fn an_error_naming_no_session_is_not_fatal_to_one() {
            assert!(!is_fatal_session_error(&error(
                "ACP session/load failed: Resource not found: 558e4705",
                None,
            )));
        }
    }
}
