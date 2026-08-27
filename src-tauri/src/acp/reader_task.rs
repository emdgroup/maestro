//! ACP reader tasks: background loops that consume messages from a maestro-server process
//! and dispatch them to per-session handlers or connection-level pending channels.

use crate::acp::canvas::{
    emit_or_buffer_payload, extract_canvas_fences_from_payload, push_config_init_to_buffer,
    CanvasFenceExtractor,
};
use crate::acp::manager::log_server_diagnostic;
use crate::acp::session_types::{
    PendingChannels, PendingReply, ReaderTaskContext, RestorableSession,
};
use crate::acp::transport::{
    FileReadResponse, FileSearchResponse, MaestroRpcMessage, PromptCapabilitiesInfo, ServerRequest,
    ServerResponse, SessionModeState, SessionModelState,
};
use crate::acp::transport_types::{serialize_message, AcpReadSource};
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
        log_id,
        app_handle,
        app_state,
        current_model_id,
        current_mode_id,
        pending_file_search,
        pending_file_read,
        acp_session_id_cache,
        replay_buffer,
        initialized,
        canvas_extractor,
        completion_filter,
        declared_complete,
        user_interrupted,
        closing_message,
        session_name,
        agent_id,
        project_id,
        task_id,
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
                        log::trace!("[acp] << log_id={log_id} {json}");
                    }
                }
            }
            if let MaestroRpcMessage::Response(ServerResponse::Ping { seq }) = &msg {
                log::trace!("[acp] ping seq={seq} on direct session log_id={log_id}");
                let pong = MaestroRpcMessage::Request(ServerRequest::Pong { seq: *seq });
                if let Err(e) = crate::acp::write_to_acp_session(&app_state, log_id, &pong).await {
                    log::warn!("[acp] pong failed on direct session log_id={log_id}: {e}");
                }
                if let Err(e) = app_state.app_handle.emit("acp://heartbeat", ()) {
                    log::warn!("[acp] emit heartbeat failed: {e}");
                }
                continue;
            }

            update_session_from_response(log_id, &msg, &app_state).await;

            if let MaestroRpcMessage::Response(ServerResponse::PermissionRequest(ref perm_req)) =
                msg
            {
                if let Some(tid) = task_id {
                    if handle_permission_request(&app_state, tid, log_id, perm_req).await {
                        continue;
                    }
                }
            }

            if let MaestroRpcMessage::Response(ServerResponse::ElicitationRequest(_)) = msg {
                if let Some(tid) = task_id {
                    mark_task_blocked(&app_state, tid);
                }
            }

            // Resolving the turn touches the DB and, for remote projects, runs `git rev-parse`
            // and `git diff` over SSH with no timeout. Run it off the reader loop so it can
            // never delay — or with a wedged connection, indefinitely withhold — the
            // `acp://turn-ended` emit below that takes the UI out of "thinking".
            if let MaestroRpcMessage::Response(ServerResponse::TurnEnded(ref turn_ended)) = msg {
                if let Some(tid) = task_id {
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
                        resolve_turn_end(&state, tid, &stop_reason, declared, interrupted, closing)
                            .await;
                    });
                }
            }

            if let Some(native_id) = handle_server_message(
                msg,
                log_id,
                &app_handle,
                &current_model_id,
                &current_mode_id,
                &pending_file_search,
                &pending_file_read,
                &acp_session_id_cache,
                &replay_buffer,
                &initialized,
                &canvas_extractor,
                &completion_filter,
                &declared_complete,
                &closing_message,
            ) {
                if let (Some(pid), Some(ref name)) = (project_id, &session_name) {
                    if let Ok(conn) = app_state.db.lock() {
                        let _ = crate::acp::session_ops::upsert_session_alias(
                            &conn, pid, &agent_id, &native_id, name,
                        );
                    }
                }
                // SpawnOk received — acp_session_id is now set; persist so sessions survive restart.
                if let Some(pid) = project_id {
                    tokio::spawn(crate::project::handlers::save_current_sessions_for_project(
                        Arc::clone(&app_state),
                        pid,
                    ));
                }
            }
        }

        app_state.acp.sessions.lock().await.remove(&log_id);
        fail_task_if_still_running(&app_state, task_id);
        app_state.app_handle.emit("sessions-changed", ()).ok();
        if let Err(e) = app_handle.emit(&format!("acp://session-ended/{}", log_id), ()) {
            log::warn!("[acp] emit session-ended/{log_id} failed: {e}");
        }
    });
}

/// Record that the agent is stopped waiting on the user, so the card says so after a reload.
///
/// `apply_if_changed` matters here rather than being a nicety: with auto-approve off a session
/// raises permission requests constantly, and every write emits `tasks-changed`, which refetches
/// the whole board.
fn mark_task_blocked(app_state: &crate::core::AppState, task_id: i32) {
    let changed = {
        let Ok(conn) = app_state.db.lock() else {
            return;
        };
        match crate::task::transition::apply_if_changed(
            &conn,
            task_id,
            crate::task::transition::TaskTransition::AwaitingUserInput,
        ) {
            Ok(result) => result.is_some(),
            Err(e) => {
                log::warn!("[acp] could not mark task {task_id} blocked: {e}");
                false
            }
        }
    };
    if changed {
        app_state.app_handle.emit("tasks-changed", ()).ok();
    }
}

/// A session's reader has ended. If the pipeline still believes an agent is working the task,
/// record the failure.
///
/// Without this a session that dies mid-phase leaves the card looking healthy, and a session that
/// dies while blocked leaves it pulsing for an answer nothing will ever consume. Tasks that moved
/// on under their own power — merged, stopped, parked at a review gate — are left untouched.
fn fail_task_if_still_running(app_state: &crate::core::AppState, task_id: Option<i32>) {
    let Some(task_id) = task_id else {
        return;
    };
    let changed = {
        let Ok(conn) = app_state.db.lock() else {
            return;
        };
        match crate::task::transition::fail_if_agent_running(&conn, task_id) {
            Ok(result) => result.is_some(),
            Err(e) => {
                log::warn!("[acp] could not record phase failure for task {task_id}: {e}");
                false
            }
        }
    };
    if changed {
        app_state.app_handle.emit("tasks-changed", ()).ok();
    }
}

/// Decide what a turn ending means for the task, and record it.
///
/// A turn ending is not the same as the work being finished: an agent that stops to ask a
/// question ends its turn exactly like one that finished the job. `classify_turn` weighs the stop
/// reason, whether the agent declared completion, and whether the repository actually changed.
async fn resolve_turn_end(
    app_state: &crate::core::AppState,
    task_id: i32,
    stop_reason: &str,
    declared_complete: bool,
    user_interrupted: bool,
    closing_message: String,
) {
    use crate::acp::completion::{classify_turn, TurnOutcome};
    use crate::task::transition::{self, TaskTransition};

    let is_git_repo = is_task_project_git_repo(app_state, task_id).await;

    // The phase the agent was in, read before the transition rewrites it — the outcome belongs to
    // the phase that produced it, not the one the task lands in.
    let phase: Option<String> = {
        let Ok(conn) = app_state.db.lock() else {
            return;
        };
        conn.query_row("SELECT phase FROM tasks WHERE id = ?", [task_id], |row| row.get(0))
            .unwrap_or(None)
    };

    // Three of the four roles write nothing, so asking whether the repository changed cannot say
    // anything about whether they finished — and asking anyway is actively wrong: a clean tree
    // would read as `Some(false)` and stall a refiner that had just produced a perfectly good
    // proposal.
    let writes =
        matches!(phase.as_deref(), Some("Implementing") | Some("Rework") | Some("AwaitingMerge"));

    // A declared completion used to skip this call, on the grounds that the agent was believed
    // either way. It no longer is: an agent that declares itself done having changed nothing goes
    // to Done as `NoChanges` rather than opening an empty review, and that is precisely the case
    // the answer is needed for.
    //
    // Skipped outright for an interrupted turn — `classify_turn` ignores it either way, and the
    // answer costs a `git diff` that runs over SSH for a remote project.
    let has_changes = if !user_interrupted && writes && is_git_repo && stop_reason == "end_turn" {
        task_has_changes(app_state, task_id).await
    } else {
        None
    };

    let outcome = classify_turn(stop_reason, declared_complete, has_changes, user_interrupted);

    // A review agent finishing is not "the phase is done, advance" — its reply *is* the decision,
    // so it routes past `TurnCompleted` entirely.
    // An agent fixing a red build is already on an open pull request, so its turn ending means
    // "push what you changed", not "advance the task". Nothing else moves: the PR stays open and
    // the branch stays its head, which is the point of fixing rather than re-approving.
    if phase.as_deref() == Some("AwaitingMerge") && outcome == TurnOutcome::Complete {
        if let Err(e) = crate::git::merge::push_ci_fix(app_state, task_id).await {
            log::error!("Could not push the CI fix for task {}: {}", task_id, e);
            let Ok(conn) = app_state.db.lock() else { return };
            let _ = transition::apply_if_active(&conn, task_id, TaskTransition::PhaseFailed);
        }
        return;
    }

    let event = if phase.as_deref() == Some("SelfReview") && outcome == TurnOutcome::Complete {
        let Ok(conn) = app_state.db.lock() else { return };
        review_verdict_event(&conn, task_id, &closing_message)
    } else {
        match outcome {
            TurnOutcome::Complete => TaskTransition::TurnCompleted {
                is_git_repo,
                has_changes,
                reviewer_pending: writes && reviewer_should_run(app_state, task_id).await,
            },
            TurnOutcome::Stalled => TaskTransition::AwaitingUserInput,
            TurnOutcome::Failed => TaskTransition::PhaseFailed,
            TurnOutcome::Ignore => return,
        }
    };

    let changed = {
        let Ok(conn) = app_state.db.lock() else {
            return;
        };

        // Guarded on the task still having a live phase, because this runs detached: by the time
        // it lands the user may have stopped the session or moved the card, and every one of those
        // parks the task. The column cannot express it — each role works in a different one, and
        // Planning is both where a refiner runs and where a stopped task ends up.
        let changed = match transition::apply_if_active(&conn, task_id, event) {
            Ok(result) => result.is_some(),
            Err(e) => {
                log::warn!("[acp] could not resolve turn end for task {task_id}: {e}");
                false
            }
        };

        // Only when the transition applied. A turn resolved against a task the user already moved
        // has no claim on its record either.
        //
        // Filed by whether the phase produced anything, not by which phase it was: `kind_for_phase`
        // answers "what does this role deliver", which is the wrong question for a turn that failed
        // or stopped to ask something. It put a session-limit error in the thread as a reviewer's
        // verdict.
        if changed {
            let phase = phase.as_deref();
            if outcome == TurnOutcome::Complete {
                crate::task::comments::record_outcome(&conn, task_id, phase, &closing_message);
            } else {
                crate::task::comments::record_unfinished(&conn, task_id, phase, &closing_message);
            }
        }

        changed
    };

    if changed {
        app_state.app_handle.emit("tasks-changed", ()).ok();
        app_state.app_handle.emit("task-comments-changed", task_id).ok();
    }
}

/// Whether a review agent should look at this task before the user does.
///
/// Two conditions, both necessary. The project must define a `Reviewer` profile, which is how a
/// team opts in — a project without one keeps the pipeline it had. And the loop must have rounds
/// left, or a reviewer would be started only to have its verdict escalated anyway.
///
/// So the work of the last rework round reaches the user unreviewed, deliberately: by then they
/// are the reviewer, and the alternative is paying an agent for a verdict nobody may act on.
pub(crate) async fn reviewer_should_run(app_state: &crate::core::AppState, task_id: i32) -> bool {
    use crate::acp::completion::review_rounds_remain;

    let Ok(Some((project_id, rounds))) = ({
        app_state.db.lock().map(|conn| {
            conn.query_row(
                "SELECT project_id, review_rounds FROM tasks WHERE id = ?",
                [task_id],
                |row| Ok((row.get::<_, i32>(0)?, row.get::<_, i32>(1)?)),
            )
            .ok()
        })
    }) else {
        return false;
    };

    if !review_rounds_remain(rounds) {
        return false;
    }

    crate::project::profiles::has_profile_for_role(
        app_state,
        project_id,
        crate::project::profiles::AgentRole::Reviewer,
    )
    .await
}

/// Turn the review agent's reply into the transition it implies, counting the round if the loop
/// is going round again.
///
/// The count is incremented here rather than when the coder starts, because this is the moment the
/// decision to spend another round is taken. Counting at the start would let a rejected task that
/// never got a coder — the app closed, the host was full — be rejected again for free.
fn review_verdict_event(
    conn: &rusqlite::Connection,
    task_id: i32,
    reply: &str,
) -> crate::task::transition::TaskTransition {
    use crate::acp::completion::{
        classify_verdict, review_rounds_remain, ReviewVerdict, REVIEW_ROUND_CAP,
    };
    use crate::task::transition::TaskTransition;

    if classify_verdict(reply) == ReviewVerdict::Approved {
        return TaskTransition::ReviewFinished;
    }

    let rounds: i32 = conn
        .query_row("SELECT review_rounds FROM tasks WHERE id = ?", [task_id], |row| row.get(0))
        .unwrap_or(REVIEW_ROUND_CAP);

    // The backstop rather than the primary guard: `reviewer_should_run` already refuses to start a
    // reviewer with no rounds left, so reaching this means one was started another way.
    if !review_rounds_remain(rounds) {
        log::info!(
            "Task {} hit the review round cap ({}); escalating to the user",
            task_id,
            REVIEW_ROUND_CAP
        );
        return TaskTransition::ReviewFinished;
    }

    if let Err(e) = conn.execute(
        "UPDATE tasks SET review_rounds = review_rounds + 1 WHERE id = ?",
        [task_id],
    ) {
        // Failing to count would make the loop unbounded, which is the one thing it must not be.
        log::error!("Could not count a review round for task {}: {}", task_id, e);
        return TaskTransition::ReviewFinished;
    }

    TaskTransition::ReviewRejected
}

/// Whether the agent has changed anything since it started, measured against
/// `execution_start_sha` — the baseline captured at spawn and preserved across resumes, so this
/// covers the whole task rather than the turn.
///
/// Returns `None` when the answer cannot be established, which `classify_turn` reads as "no
/// evidence" and treats the same as a non-git project.
pub(crate) async fn task_has_changes(
    app_state: &crate::core::AppState,
    task_id: i32,
) -> Option<bool> {
    let (project_id, start_sha, isolated, worktree_path) = {
        let conn = app_state.db.lock().ok()?;
        let row: (i32, Option<String>, bool, Option<String>) = conn
            .query_row(
                "SELECT t.project_id, t.execution_start_sha, t.isolated_worktree, \
                    (SELECT path FROM worktrees WHERE task_id = t.id LIMIT 1) \
                 FROM tasks t WHERE t.id = ?",
                [task_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .ok()?;
        row
    };

    // An isolated task whose worktree row has gone missing must report no evidence rather than
    // fall through to the project root: the root is a different tree, and any unrelated dirt in
    // it — an untracked `.maestro/`, a half-finished edit — reads as work this agent did and
    // sends the task to review with a diff it had nothing to do with.
    if isolated && worktree_path.is_none() {
        log::warn!("[acp] task {task_id} is isolated but has no worktree row; skipping diff gate");
        return None;
    }

    let start_sha = start_sha.filter(|sha| !sha.is_empty())?;
    let (_project, git_conn) = crate::core::get_project_with_git_conn(app_state, project_id)
        .await
        .ok()?;

    // Worktree paths are stored relative to the repo; a task without one runs in the project root.
    let cwd = match worktree_path {
        Some(path) => format!("{}/{}", git_conn.path(), path),
        None => git_conn.path().to_string(),
    };

    crate::git::worktree_query::diff_stats_in(
        &git_conn,
        &cwd,
        &crate::models::DiffTarget::Commit { sha: start_sha },
    )
    .await
    .ok()
    .map(|stats| stats.has_changes())
}

/// `(project_id, path, connection_id, wsl_connection_id, docker_connection_id)`
type ProjectLocationRow = (i32, String, Option<i32>, Option<i32>, Option<i32>);

pub(crate) async fn is_task_project_git_repo(
    app_state: &crate::core::AppState,
    task_id: i32,
) -> bool {
    let result: Option<ProjectLocationRow> =
        app_state.db.lock().ok().and_then(|conn| {
        conn.query_row(
            "SELECT p.id, p.path, p.connection_id, p.wsl_connection_id, p.docker_connection_id \
             FROM tasks t JOIN projects p ON t.project_id = p.id \
             WHERE t.id = ?",
            [task_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        ).ok()
    });

    let Some((project_id, path, connection_id, wsl_connection_id, docker_connection_id)) = result
    else {
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
    task_id: i32,
    log_id: i32,
    perm_req: &crate::acp::transport::PermissionRequest,
) -> bool {
    if try_auto_approve_permission(app_state, task_id, log_id, perm_req).await {
        return true;
    }
    if try_conclude_plan_mode_phase(app_state, task_id, log_id, perm_req).await {
        return true;
    }
    // Nobody answered for it: the agent is stopped until the user does.
    mark_task_blocked(app_state, task_id);
    false
}

async fn try_auto_approve_permission(
    app_state: &Arc<crate::core::AppState>,
    task_id: i32,
    log_id: i32,
    perm_req: &crate::acp::transport::PermissionRequest,
) -> bool {
    let phase = app_state.db.lock().ok().and_then(|conn| {
        conn.query_row("SELECT phase FROM tasks WHERE id = ?", [task_id], |row| {
            row.get::<_, Option<String>>(0)
        })
        .ok()
    });

    let Some(phase) = phase else { return false };

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
    let read_only = phase
        .as_deref()
        .and_then(|p| p.parse::<crate::models::TaskPhase>().ok())
        .is_some_and(|p| p.is_read_only());
    if read_only {
        log::debug!(
            "[acp] not auto-approving a permission request for task {task_id}: \
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

    let session_id = format!("session-{}", log_id);
    let response = MaestroRpcMessage::Request(ServerRequest::PermitResponse(
        crate::acp::transport::PermissionResponse {
            session_id,
            request_id: perm_req.request_id.clone(),
            option_id: Some(oid),
        },
    ));
    let _ = crate::acp::write_to_acp_session(app_state, log_id, &response).await;
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
/// File a read-only role's deliverable and move the task on from it.
///
/// Split out from `try_conclude_plan_mode_phase` for the ordinary reason: everything above it in
/// that function is a session and a payload, and none of this needed either. Which is how the bug
/// below survived — the decision could not be tested without spawning an agent.
///
/// The three read-only phases are not interchangeable here. `is_read_only` admits `SelfReview`, so
/// a plan-mode reviewer reaches this path, but `ArtifactDelivered` has arms only for `Drafting` and
/// `Refining` and falls through to "change nothing". The caller then closes the session, leaving a
/// task marked `Running` with no agent behind it and a reply that — though already filed as a
/// verdict by `kind_for_phase` — never reached `classify_verdict`. The loop could not reject.
///
/// That is not an exotic configuration: with no `permission_mode` on the profile a read-only role
/// takes the first of `READ_ONLY_MODES` its agent offers, so plan mode is the *default* a reviewer
/// runs in.
///
/// The verdict is read off the plan payload because that is what the request carries. The reviewer's
/// prose would be the better source, but the `tool_call` announcing `ExitPlanMode` resets the
/// closing message before the permission request arrives. A plan that does not open with the verdict
/// line classifies as `Approved`, which is the documented safe direction — the human gate, not
/// another coder round on a guess.
fn conclude_read_only_phase(
    conn: &rusqlite::Connection,
    task_id: i32,
    phase: Option<&str>,
    text: &str,
) -> Result<Option<crate::models::Task>, String> {
    // Order matters: the thread entry is what the gate reads, so a transition that lands without
    // it would open a gate with nothing in it — the defect this whole path exists to close.
    crate::task::comments::record_outcome(conn, task_id, phase, text);

    let event = if phase == Some("SelfReview") {
        review_verdict_event(conn, task_id, text)
    } else {
        crate::task::transition::TaskTransition::ArtifactDelivered
    };
    crate::task::transition::apply_if_active(conn, task_id, event)
}

async fn try_conclude_plan_mode_phase(
    app_state: &Arc<crate::core::AppState>,
    task_id: i32,
    log_id: i32,
    perm_req: &crate::acp::transport::PermissionRequest,
) -> bool {
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

    let recorded = {
        let Ok(conn) = app_state.db.lock() else { return false };
        let phase: Option<String> = conn
            .query_row("SELECT phase FROM tasks WHERE id = ?", [task_id], |row| row.get(0))
            .unwrap_or(None);

        let read_only_phase = phase
            .as_deref()
            .and_then(|p| p.parse::<crate::models::TaskPhase>().ok())
            .is_some_and(|p| p.is_read_only());
        if !read_only_phase {
            log::debug!("[acp] task {task_id}: {phase:?} may write, so its plan is not a gate");
            return false;
        }

        conclude_read_only_phase(&conn, task_id, phase.as_deref(), plan)
    };

    match recorded {
        // Told to the board before the session is closed below. Both halves are needed and the
        // order is not cosmetic: closing the session emits `sessions-changed` on its own, so a
        // board that has been told the session is gone but not that the task reached its gate
        // renders the phase it still believes is running with no agent behind it — which is
        // exactly the shape of a crashed session. The card said "Session lost" and offered
        // Recover, with the finished plan sitting unreachable behind it.
        Ok(Some(_)) => {
            app_state.app_handle.emit("tasks-changed", ()).ok();
            app_state.app_handle.emit("task-comments-changed", task_id).ok();
        }
        Ok(None) => return false,
        Err(e) => {
            log::warn!("[acp] could not close the read-only phase of task {task_id}: {e}");
            return false;
        }
    }

    let session_id = format!("session-{}", log_id);
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
                session_id,
                request_id: perm_req.request_id.clone(),
                option_id: Some(option_id),
            },
        ));
        if let Err(e) = crate::acp::write_to_acp_session(app_state, log_id, &response).await {
            log::warn!("[acp] could not refuse the mode change for task {task_id}: {e}");
        }
    }

    // After the transition, not before: ending a session runs `fail_if_agent_running`, which would
    // turn the card red if the task were still `Running`. It is a no-op against the `Waiting` the
    // gate above just wrote, which is the ordering this depends on.
    crate::acp::session_handlers::end_acp_session(app_state, log_id).await;
    log::info!("[acp] took the plan for task {task_id} and closed its planning session");

    true
}

fn emit_session_init_events(
    models: Option<&SessionModelState>,
    modes: Option<&SessionModeState>,
    caps: Option<&PromptCapabilitiesInfo>,
    log_id: i32,
    app_handle: &tauri::AppHandle,
    current_model_id: &Arc<std::sync::Mutex<Option<String>>>,
    current_mode_id: &Arc<std::sync::Mutex<Option<String>>>,
) {
    if let Some(m) = models {
        if let Ok(mut cache) = current_model_id.lock() {
            *cache = Some(m.current_model_id.clone());
        }
        if let Err(e) = app_handle.emit(&format!("acp://session-models/{}", log_id), m) {
            log::warn!("[acp] emit session-models/{log_id} failed: {e}");
        }
    }
    if let Some(m) = modes {
        if let Ok(mut cache) = current_mode_id.lock() {
            *cache = Some(m.current_mode_id.clone());
        }
        if let Err(e) = app_handle.emit(&format!("acp://session-modes/{}", log_id), m) {
            log::warn!("[acp] emit session-modes/{log_id} failed: {e}");
        }
    }
    if let Some(c) = caps {
        if let Err(e) = app_handle.emit(&format!("acp://session-capabilities/{}", log_id), c) {
            log::warn!("[acp] emit session-capabilities/{log_id} failed: {e}");
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
    log_id: i32,
    app_handle: &tauri::AppHandle,
    current_model_id: &Arc<std::sync::Mutex<Option<String>>>,
    current_mode_id: &Arc<std::sync::Mutex<Option<String>>>,
    pending_file_search: &PendingReply<Vec<String>>,
    pending_file_read: &PendingReply<String>,
    acp_session_id_cache: &Arc<std::sync::Mutex<Option<String>>>,
    replay_buffer: &crate::acp::session_types::ReplayBuffer,
    initialized: &Arc<std::sync::Mutex<bool>>,
    canvas_extractor: &Arc<std::sync::Mutex<CanvasFenceExtractor>>,
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
                        app_handle.emit(&format!("acp://mode-changed/{}", log_id), mode_id)
                    {
                        log::warn!("[acp] emit mode-changed/{log_id} failed: {e}");
                    }
                }
            }
            // Extract canvas fences from agent_message_chunk text. Each complete
            // ```maestro-canvas ... ``` block is emitted as a synthetic canvas session
            // update; the remaining text (fences stripped) is forwarded normally.
            let (payload_opt, canvas_messages) =
                extract_canvas_fences_from_payload(upd.payload, canvas_extractor);

            for canvas_msg in canvas_messages {
                emit_or_buffer_payload(canvas_msg, replay_buffer, app_handle, log_id);
            }

            // Strip the completion marker last, so it is removed from what the user sees
            // while recording that the agent declared the task done.
            let payload_opt = payload_opt.and_then(|payload| {
                crate::acp::completion::strip_completion_marker_from_payload(
                    payload,
                    completion_filter,
                    declared_complete,
                )
            });

            if let Some(payload) = payload_opt {
                // After stripping, so the marker never reaches the outcome thread either.
                crate::acp::completion::track_closing_message(
                    &payload,
                    payload.get("content").and_then(|c| c.get("text")).and_then(|t| t.as_str()),
                    closing_message,
                );
                emit_or_buffer_payload(payload, replay_buffer, app_handle, log_id);
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
            if let Err(e) = app_handle.emit(&format!("acp://terminal-output/{}", log_id), &payload)
            {
                log::warn!("[acp] emit terminal-output/{log_id} failed: {e}");
            }
        }
        MaestroRpcMessage::Response(ServerResponse::PermissionRequest(req)) => {
            if let Err(e) = app_handle.emit(&format!("acp://permission-request/{}", log_id), &req) {
                log::warn!("[acp] emit permission-request/{log_id} failed: {e}");
            }
        }
        MaestroRpcMessage::Response(ServerResponse::ElicitationRequest(req)) => {
            if let Err(e) = app_handle.emit(&format!("acp://elicitation-request/{}", log_id), &req)
            {
                log::warn!("[acp] emit elicitation-request/{log_id} failed: {e}");
            }
        }
        MaestroRpcMessage::Response(ServerResponse::SpawnOk(spawn_ok)) => {
            log::debug!(
                "[acp] spawn-ok log_id={log_id} session={} acp_session={:?} model={:?} session_list={} session_load={} session_close={} session_delete={}",
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
                log_id,
                app_handle,
                current_model_id,
                current_mode_id,
            );
            if let Some(ref config_options) = spawn_ok.config_options {
                if let Err(e) = app_handle.emit(
                    &format!("acp://config-state-updated/{}", log_id),
                    &serde_json::json!({ "configOptions": config_options }),
                ) {
                    log::warn!("[acp] emit config-state-updated/{log_id} failed: {e}");
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
            if let Err(e) = app_handle.emit(&format!("acp://spawn-ok/{}", log_id), ()) {
                log::warn!("[acp] emit spawn-ok/{log_id} failed: {e}");
            }
            return new_native_id;
        }
        MaestroRpcMessage::Response(ServerResponse::SessionLoadOk(load_ok)) => {
            log::debug!(
                "[acp] session-load-ok log_id={log_id} session={}",
                load_ok.session_id
            );
            emit_session_init_events(
                load_ok.models.as_ref(),
                load_ok.modes.as_ref(),
                load_ok.prompt_capabilities.as_ref(),
                log_id,
                app_handle,
                current_model_id,
                current_mode_id,
            );
            if let Some(ref config_options) = load_ok.config_options {
                if let Err(e) = app_handle.emit(
                    &format!("acp://config-state-updated/{}", log_id),
                    &serde_json::json!({ "configOptions": config_options }),
                ) {
                    log::warn!("[acp] emit config-state-updated/{log_id} failed: {e}");
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
            if let Err(e) = app_handle.emit(&format!("acp://spawn-ok/{}", log_id), ()) {
                log::warn!("[acp] emit spawn-ok/{log_id} failed: {e}");
            }
        }
        MaestroRpcMessage::Response(ServerResponse::SetModelOk(ok)) => {
            log::debug!("[acp] set-model-ok log_id={log_id} model={}", ok.model_id);
            if let Ok(mut m) = current_model_id.lock() {
                *m = Some(ok.model_id.clone());
            }
            if let Err(e) =
                app_handle.emit(&format!("acp://model-changed/{}", log_id), &ok.model_id)
            {
                log::warn!("[acp] emit model-changed/{log_id} failed: {e}");
            }
        }
        MaestroRpcMessage::Response(ServerResponse::SetModeOk(ok)) => {
            log::debug!("[acp] set-mode-ok log_id={log_id} mode={}", ok.mode_id);
            if let Ok(mut m) = current_mode_id.lock() {
                *m = Some(ok.mode_id.clone());
            }
            if let Err(e) = app_handle.emit(&format!("acp://mode-changed/{}", log_id), &ok.mode_id)
            {
                log::warn!("[acp] emit mode-changed/{log_id} failed: {e}");
            }
        }
        MaestroRpcMessage::Response(ServerResponse::SetConfigOptionOk(ok)) => {
            log::debug!(
                "[acp] set-config-ok log_id={log_id} config={} value={}",
                ok.config_id,
                ok.value
            );
            if let Err(e) = app_handle.emit(
                &format!("acp://config-changed/{}", log_id),
                &serde_json::json!({ "config_id": ok.config_id, "value": ok.value }),
            ) {
                log::warn!("[acp] emit config-changed/{log_id} failed: {e}");
            }
        }
        MaestroRpcMessage::Response(ServerResponse::ConfigOptionUpdated(ok)) => {
            log::debug!(
                "[acp] config-updated log_id={log_id} config={} value={}",
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
                &format!("acp://config-state-updated/{}", log_id),
                &serde_json::json!({
                    "config_id": ok.config_id,
                    "value": ok.value,
                    "configOptions": ok.config_options,
                }),
            ) {
                log::warn!("[acp] emit config-state-updated/{log_id} failed: {e}");
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
            log::error!("[acp] session-error log_id={log_id}: {}", err.message);
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
                app_handle.emit(&format!("acp://session-error/{}", log_id), &err.message)
            {
                log::error!("[acp] emit session-error/{log_id} failed: {e}");
            }
        }
        MaestroRpcMessage::Response(ServerResponse::TurnEnded(turn_ended)) => {
            log::debug!(
                "[acp] turn-ended log_id={log_id} stop={}",
                turn_ended.stop_reason
            );
            if let Err(e) = app_handle.emit(
                &format!("acp://turn-ended/{}", log_id),
                &turn_ended.stop_reason,
            ) {
                log::warn!("[acp] emit turn-ended/{log_id} failed: {e}");
            }
        }
        MaestroRpcMessage::Response(ServerResponse::Diagnostic(diag)) => {
            log_server_diagnostic(&diag.level, &diag.message);
            if let Err(e) = app_handle.emit(&format!("acp://diagnostic/{}", log_id), &diag) {
                log::warn!("[acp] emit diagnostic/{log_id} failed: {e}");
            }
        }
        _ => {
            // Ignore Request variants arriving on stdout — wrong direction.
        }
    }
    None
}

pub(crate) async fn update_session_from_response(
    log_id: i32,
    msg: &MaestroRpcMessage,
    app_state: &Arc<crate::core::AppState>,
) {
    match msg {
        MaestroRpcMessage::Response(ServerResponse::SpawnOk(r)) => {
            let mut sessions = app_state.acp.sessions.lock().await;
            if let Some(session) = sessions.get_mut(&log_id) {
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
            if let Some(session) = sessions.get_mut(&log_id) {
                session.config_options = r.config_options.clone().unwrap_or_default();
                session.prompt_capabilities = r.prompt_capabilities.clone();
            }
        }
        MaestroRpcMessage::Response(ServerResponse::ConfigOptionUpdated(r)) => {
            let mut sessions = app_state.acp.sessions.lock().await;
            if let Some(session) = sessions.get_mut(&log_id) {
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
                        if let Some(session) = sessions.get_mut(&log_id) {
                            session.config_options = options;
                        }
                    }
                }
            }
        _ => {}
    }
}

fn log_id_from_session_id(session_id: &str) -> Option<i32> {
    session_id.strip_prefix("session-")?.parse().ok()
}

fn extract_session_log_id(msg: &MaestroRpcMessage) -> Option<i32> {
    match msg {
        MaestroRpcMessage::Response(ServerResponse::SpawnOk(r)) => {
            log_id_from_session_id(&r.session_id)
        }
        MaestroRpcMessage::Response(ServerResponse::SessionUpdate(r)) => {
            log_id_from_session_id(&r.session_id)
        }
        MaestroRpcMessage::Response(ServerResponse::PermissionRequest(r)) => {
            log_id_from_session_id(&r.session_id)
        }
        MaestroRpcMessage::Response(ServerResponse::ElicitationRequest(r)) => {
            log_id_from_session_id(&r.session_id)
        }
        MaestroRpcMessage::Response(ServerResponse::TerminalOutput(r)) => {
            log_id_from_session_id(&r.session_id)
        }
        MaestroRpcMessage::Response(ServerResponse::TurnEnded(r)) => {
            log_id_from_session_id(&r.session_id)
        }
        MaestroRpcMessage::Response(ServerResponse::SetModelOk(r)) => {
            log_id_from_session_id(&r.session_id)
        }
        MaestroRpcMessage::Response(ServerResponse::SetModeOk(r)) => {
            log_id_from_session_id(&r.session_id)
        }
        MaestroRpcMessage::Response(ServerResponse::SetConfigOptionOk(r)) => {
            log_id_from_session_id(&r.session_id)
        }
        MaestroRpcMessage::Response(ServerResponse::ConfigOptionUpdated(r)) => {
            log_id_from_session_id(&r.session_id)
        }
        MaestroRpcMessage::Response(ServerResponse::SessionLoadOk(r)) => {
            log_id_from_session_id(&r.session_id)
        }
        MaestroRpcMessage::Response(ServerResponse::Error(err)) if err.session_id.is_some() => {
            err.session_id.as_deref().and_then(log_id_from_session_id)
        }
        _ => None,
    }
}

/// Route a shared-reader message to the correct per-session handler or to
/// connection-level pending channels (PreInitialize, SessionList, SessionClose, etc.).
async fn handle_shared_server_message(
    msg: MaestroRpcMessage,
    connection_key: crate::acp::ConnectionKey,
    app_handle: &tauri::AppHandle,
    app_state: &Arc<crate::core::AppState>,
    pending: &PendingChannels,
) {
    // Session-bearing messages: extract log_id, borrow caches from AcpProcess,
    // then call the existing single-session handler.
    if let Some(log_id) = extract_session_log_id(&msg) {
        update_session_from_response(log_id, &msg, app_state).await;

        let caches = {
            let sessions = app_state.acp.sessions.lock().await;
            sessions.get(&log_id).map(|s| {
                (
                Arc::clone(&s.current_model_id),
                Arc::clone(&s.current_mode_id),
                Arc::clone(&s.pending_file_search),
                Arc::clone(&s.pending_file_read),
                Arc::clone(&s.acp_session_id),
                Arc::clone(&s.replay_buffer),
                Arc::clone(&s.initialized),
                Arc::clone(&s.canvas_extractor),
                Arc::clone(&s.completion_filter),
                Arc::clone(&s.declared_complete),
                Arc::clone(&s.user_interrupted),
                Arc::clone(&s.closing_message),
                s.session_name.clone(),
                s.agent_id_meta.clone(),
                s.project_id,
                s.task_id,
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
            canvas_extractor,
            completion_filter,
            declared_complete,
            user_interrupted,
            closing_message,
            session_name,
            agent_id,
            pid,
            task_id,
        )) = caches
        {
            if let MaestroRpcMessage::Response(ServerResponse::PermissionRequest(ref perm_req)) =
                msg
            {
                if let Some(tid) = task_id {
                    if handle_permission_request(app_state, tid, log_id, perm_req).await {
                        return;
                    }
                }
            }

            if let MaestroRpcMessage::Response(ServerResponse::ElicitationRequest(_)) = msg {
                if let Some(tid) = task_id {
                    mark_task_blocked(app_state, tid);
                }
            }

            // Off the reader loop — see the matching comment in `spawn_reader_task`. This
            // path is worse: the shared reader serves every session on the connection, so
            // one task's hung `git rev-parse` would stall turn-ended for all of them.
            if let MaestroRpcMessage::Response(ServerResponse::TurnEnded(ref turn_ended)) = msg {
                if let Some(tid) = task_id {
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
                        resolve_turn_end(&state, tid, &stop_reason, declared, interrupted, closing)
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
            let is_session_load_error = matches!(&msg, MaestroRpcMessage::Response(ServerResponse::Error(e)) if e.session_id.is_some());
            let native_id = handle_server_message(
                msg,
                log_id,
                app_handle,
                &current_model_id,
                &current_mode_id,
                &pfs,
                &pfr,
                &acp_sid,
                &replay,
                &initialized,
                &canvas_extractor,
                &completion_filter,
                &declared_complete,
                &closing_message,
            );
            if is_permission_request {
                let sessions = app_state.acp.sessions.lock().await;
                if let Some(session) = sessions.get(&log_id) {
                    session
                        .has_pending_permission
                        .store(true, Ordering::Release);
                }
            }
            if let Some(native_id) = native_id {
                if let (Some(project_id_val), Some(ref name)) = (pid, &session_name) {
                    if let Ok(conn) = app_state.db.lock() {
                        let _ = crate::acp::session_ops::upsert_session_alias(
                            &conn,
                            project_id_val,
                            &agent_id,
                            &native_id,
                            name,
                        );
                    }
                }
                // SpawnOk received — acp_session_id is now set; persist so sessions survive restart.
                if let Some(project_id_val) = pid {
                    tokio::spawn(crate::project::handlers::save_current_sessions_for_project(
                        Arc::clone(app_state),
                        project_id_val,
                    ));
                }
            }
            if is_session_load_error {
                // Session load failed (agent no longer has this session). Remove from the in-memory
                // map so getActiveSessions no longer lists it, then notify the frontend.
                app_state.acp.sessions.lock().await.remove(&log_id);
                fail_task_if_still_running(app_state, task_id);
                if let Err(e) = app_handle.emit("sessions-changed", ()) {
                    log::warn!("[acp] emit sessions-changed failed: {e}");
                }
            }
        } else {
            // The session left the map between the agent answering and us handling the
            // reply — cleanup, a failed write rollback, a concurrent close. Everything
            // above needs the caches, but turn-ended does not: dropping it here is what
            // strands the UI in "thinking", so emit it anyway.
            log::warn!("[acp] no session entry for log_id={log_id} while handling agent reply");
            if let MaestroRpcMessage::Response(ServerResponse::TurnEnded(ref turn_ended)) = msg {
                if let Err(e) = app_handle.emit(
                    &format!("acp://turn-ended/{}", log_id),
                    &turn_ended.stop_reason,
                ) {
                    log::warn!("[acp] emit turn-ended/{log_id} failed: {e}");
                }
            }
        }
        return;
    }

    // Sessionless messages.
    match msg {
        MaestroRpcMessage::Response(ServerResponse::ListAgentsOk(resp)) => {
            let agents: Vec<crate::acp::registry::DiscoveredAgent> = resp
                .agents
                .into_iter()
                .map(|a| crate::acp::registry::DiscoveredAgent {
                id: a.id,
                name: a.name,
                icon: a.icon,
                spawn_deps: a.spawn_deps,
                })
                .collect();
            log::debug!(
                "[registry] ListAgentsOk: {} agents: {:?}",
                agents.len(),
                agents.iter().map(|a| &a.id).collect::<Vec<_>>()
            );
            if let Ok(mut guard) = pending.list_agents.lock() {
                if let Some(tx) = guard.take() {
                    let _ = tx.send(Ok(agents));
                }
            }
        }
        MaestroRpcMessage::Response(ServerResponse::SessionListOk(resp)) => {
            if let Ok(mut guard) = pending.session_list.lock() {
                if let Some(tx) = guard.take() {
                    let _ = tx.send(Ok(resp));
                }
            }
        }
        MaestroRpcMessage::Response(ServerResponse::SessionCloseOk) => {
            if let Ok(mut guard) = pending.session_close.lock() {
                if let Some(tx) = guard.take() {
                    let _ = tx.send(Ok(()));
                }
            }
        }
        MaestroRpcMessage::Response(ServerResponse::SessionDeleteOk) => {
            if let Ok(mut guard) = pending.session_delete.lock() {
                if let Some(tx) = guard.take() {
                    let _ = tx.send(Ok(()));
                }
            }
        }
        MaestroRpcMessage::Response(ServerResponse::CheckToolsOk(resp)) => {
            if let Ok(mut guard) = pending.check_tools.lock() {
                if let Some(tx) = guard.take() {
                    let _ = tx.send(Ok(resp));
                }
            }
        }
        MaestroRpcMessage::Response(ServerResponse::SetToolPathOk(resp)) => {
            if let Ok(mut guard) = pending.set_tool_path.lock() {
                if let Some(tx) = guard.take() {
                    let _ = tx.send(Ok(resp));
                }
            }
        }
        MaestroRpcMessage::Response(ServerResponse::TestToolPathOk(resp)) => {
            if let Ok(mut guard) = pending.test_tool_path.lock() {
                if let Some(tx) = guard.take() {
                    let _ = tx.send(Ok(resp));
                }
            }
        }
        MaestroRpcMessage::Response(ServerResponse::InstallSkillsOk(resp)) => {
            if let Ok(mut guard) = pending.install_skills.lock() {
                if let Some(tx) = guard.take() {
                    let _ = tx.send(Ok(resp));
                }
            }
        }
        MaestroRpcMessage::Response(ServerResponse::DetectInstalledAgentsOk(resp)) => {
            log::debug!(
                "[registry] DetectInstalledAgentsOk: {:?}",
                resp.agents.iter().map(|a| &a.agent_id).collect::<Vec<_>>()
            );
            if let Ok(mut guard) = pending.detect_installed.lock() {
                if let Some(tx) = guard.take() {
                    let _ = tx.send(Ok(resp));
                }
            }
        }
        MaestroRpcMessage::Response(ServerResponse::DetectProjectAgentsOk(resp)) => {
            if let Ok(mut guard) = pending.detect_project.lock() {
                if let Some(tx) = guard.take() {
                    let _ = tx.send(Ok(resp));
                }
            }
        }
        MaestroRpcMessage::Response(ServerResponse::PreInitializeOk(resp)) => {
            let agent_id = resp.agent_id.clone();
            let supports = (
                resp.supports_session_list,
                resp.supports_session_load,
                resp.supports_session_close,
                resp.supports_session_delete,
            );
            // Store auth info before sending the response to avoid a race.
            // Preserve authenticated=true if the agent was already authenticated this session
            // (e.g., after terminal auth, the retry spawns a new session and re-sends PreInitializeOk).
            let mut auth_map = app_state.acp.agent_auth_info.lock().await;
            let prev_authenticated = auth_map
                .get(&(connection_key, agent_id.clone()))
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
            auth_map.insert((connection_key, agent_id.clone()), auth_info);
            drop(auth_map);
            let tx = pending
                .pre_init
                .lock()
                .ok()
                .and_then(|mut map| map.remove(&resp.agent_id));
            if let Some(tx) = tx {
                let _ = tx.send(Ok(resp));
            }
            log::debug!(
                "[acp] pre-initialize-ok agent_id={agent_id} session_list={} session_load={} session_close={} session_delete={}",
                supports.0, supports.1, supports.2, supports.3
            );
        }
        MaestroRpcMessage::Response(ServerResponse::AuthenticateOk) => {
            if let Ok(mut guard) = pending.authenticate.lock() {
                if let Some(tx) = guard.take() {
                    let _ = tx.send(Ok(()));
                }
            }
        }
        MaestroRpcMessage::Response(ServerResponse::LogoutOk) => {
            if let Ok(mut guard) = pending.logout.lock() {
                if let Some(tx) = guard.take() {
                    let _ = tx.send(Ok(()));
                }
            }
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
                if let Some(log_id) = log_id_from_session_id(session_id_str) {
                    // The removed entry is the only place the task id is still available.
                    let removed = app_state.acp.sessions.lock().await.remove(&log_id);
                    fail_task_if_still_running(app_state, removed.and_then(|s| s.task_id));
                    if let Err(e) = app_handle.emit(&format!("acp://session-ended/{}", log_id), ())
                    {
                        log::warn!("[acp] emit session-ended/{log_id} failed: {e}");
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
        MaestroRpcMessage::Response(ServerResponse::FileSearchOk(FileSearchResponse { files })) => {
            // Deliver to the first connection session that has a pending file search.
            let sessions = app_state.acp.sessions.lock().await;
            for (_, session) in sessions
                .iter()
                .filter(|(_, s)| s.connection_key == connection_key)
            {
                if let Ok(mut guard) = session.pending_file_search.lock() {
                    if guard.is_some() {
                        if let Some(tx) = guard.take() {
                            let _ = tx.send(Ok(files));
                        }
                        break;
                    }
                }
            }
        }
        MaestroRpcMessage::Response(ServerResponse::FileReadOk(FileReadResponse { content })) => {
            let sessions = app_state.acp.sessions.lock().await;
            for (_, session) in sessions
                .iter()
                .filter(|(_, s)| s.connection_key == connection_key)
            {
                if let Ok(mut guard) = session.pending_file_read.lock() {
                    if guard.is_some() {
                        if let Some(tx) = guard.take() {
                            let _ = tx.send(Ok(content));
                        }
                        break;
                    }
                }
            }
        }
        MaestroRpcMessage::Response(ServerResponse::Diagnostic(diag)) => {
            log_server_diagnostic(&diag.level, &diag.message);
            // Best-effort: emit to any session on this connection for frontend visibility.
            let log_ids: Vec<i32> = {
                let sessions = app_state.acp.sessions.lock().await;
                sessions
                    .iter()
                    .filter(|(_, s)| s.connection_key == connection_key)
                    .map(|(id, _)| *id)
                    .collect()
            };
            for lid in log_ids {
                let _ = app_handle.emit(&format!("acp://diagnostic/{}", lid), &diag);
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
            // Try pending session ops first, then file ops, then PreInitialize, then emit globally.
            let mut resolved = false;

            // Pending SessionList / SessionClose / CheckTools
            if !resolved {
                if let Ok(mut guard) = pending.session_list.lock() {
                    if guard.is_some() {
                        if let Some(tx) = guard.take() {
                            let _ = tx.send(Err(err.message.clone()));
                        }
                        resolved = true;
                    }
                }
            }
            if !resolved {
                if let Ok(mut guard) = pending.session_close.lock() {
                    if guard.is_some() {
                        if let Some(tx) = guard.take() {
                            let _ = tx.send(Err(err.message.clone()));
                        }
                        resolved = true;
                    }
                }
            }
            if !resolved {
                if let Ok(mut guard) = pending.check_tools.lock() {
                    if guard.is_some() {
                        if let Some(tx) = guard.take() {
                            let _ = tx.send(Err(err.message.clone()));
                        }
                        resolved = true;
                    }
                }
            }
            if !resolved {
                if let Ok(mut guard) = pending.set_tool_path.lock() {
                    if guard.is_some() {
                        if let Some(tx) = guard.take() {
                            let _ = tx.send(Err(err.message.clone()));
                        }
                        resolved = true;
                    }
                }
            }
            if !resolved {
                if let Ok(mut guard) = pending.install_skills.lock() {
                    if guard.is_some() {
                        if let Some(tx) = guard.take() {
                            let _ = tx.send(Err(err.message.clone()));
                        }
                        resolved = true;
                    }
                }
            }
            if !resolved {
                if let Ok(mut guard) = pending.test_tool_path.lock() {
                    if guard.is_some() {
                        if let Some(tx) = guard.take() {
                            let _ = tx.send(Err(err.message.clone()));
                        }
                        resolved = true;
                    }
                }
            }
            if !resolved {
                if let Ok(mut guard) = pending.detect_installed.lock() {
                    if guard.is_some() {
                        if let Some(tx) = guard.take() {
                            let _ = tx.send(Err(err.message.clone()));
                        }
                        resolved = true;
                    }
                }
            }
            if !resolved {
                if let Ok(mut guard) = pending.detect_project.lock() {
                    if guard.is_some() {
                        if let Some(tx) = guard.take() {
                            let _ = tx.send(Err(err.message.clone()));
                        }
                        resolved = true;
                    }
                }
            }

            if !resolved {
                let sessions = app_state.acp.sessions.lock().await;
                'outer: for (_, session) in sessions
                    .iter()
                    .filter(|(_, s)| s.connection_key == connection_key)
                {
                    if let Ok(mut guard) = session.pending_file_search.lock() {
                        if guard.is_some() {
                            if let Some(tx) = guard.take() {
                                let _ = tx.send(Err(err.message.clone()));
                            }
                            resolved = true;
                            break 'outer;
                        }
                    }
                    if let Ok(mut guard) = session.pending_file_read.lock() {
                        if guard.is_some() {
                            if let Some(tx) = guard.take() {
                                let _ = tx.send(Err(err.message.clone()));
                            }
                            resolved = true;
                            break 'outer;
                        }
                    }
                }
            }
            if !resolved {
                // Try pending ListAgents.
                if let Ok(mut guard) = pending.list_agents.lock() {
                    if let Some(tx) = guard.take() {
                        let _ = tx.send(Err(err.message.clone()));
                        resolved = true;
                    }
                }
            }
            if !resolved {
                if let Ok(mut guard) = pending.authenticate.lock() {
                    if guard.is_some() {
                        if let Some(tx) = guard.take() {
                            let _ = tx.send(Err(err.message.clone()));
                        }
                        resolved = true;
                    }
                }
            }
            if !resolved {
                if let Ok(mut guard) = pending.logout.lock() {
                    if guard.is_some() {
                        if let Some(tx) = guard.take() {
                            let _ = tx.send(Err(err.message.clone()));
                        }
                        resolved = true;
                    }
                }
            }
            if !resolved {
                // Try pending PreInitialize.
                let pre_init_tx = pending.pre_init.lock().ok().and_then(|mut map| {
                    let key = map.keys().next().cloned()?;
                    map.remove(&key)
                });
                if let Some(tx) = pre_init_tx {
                    let _ = tx.send(Err(err.message));
                } else {
                    // Emit as session-error for all connection sessions.
                    let log_ids: Vec<i32> = {
                        let sessions = app_state.acp.sessions.lock().await;
                        sessions
                            .iter()
                            .filter(|(_, s)| s.connection_key == connection_key)
                            .map(|(id, _)| *id)
                            .collect()
                    };
                    for log_id in log_ids {
                        if let Err(e) = app_handle
                            .emit(&format!("acp://session-error/{}", log_id), &err.message)
                        {
                            log::error!("[acp] emit session-error/{log_id} failed: {e}");
                        }
                    }
                }
            }
        }
        _ => {}
    }
}

pub(crate) fn spawn_shared_reader_task(
    source: AcpReadSource,
    connection_key: crate::acp::ConnectionKey,
    last_ping_at: Arc<AtomicU64>,
    writer_tx: tokio::sync::mpsc::Sender<Vec<u8>>,
    app_handle: tauri::AppHandle,
    app_state: Arc<crate::core::AppState>,
    pending: PendingChannels,
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
                            ConnectionQuiet { connection: connection_key, quiet_for_secs: secs_since },
                        ) {
                            log::warn!("[acp] emit connection-stale failed: {e}");
                        }
                    } else if secs_since <= 25 && reported_quiet {
                        reported_quiet = false;
                        log::info!("[acp] connection responding again for {connection_key:?}");
                        if let Err(e) = app_handle.emit(
                            "acp://connection-live",
                            ConnectionEvent { connection: connection_key },
                        ) {
                            log::warn!("[acp] emit connection-live failed: {e}");
                        }
                    }
                }
            }
        });

        while let Some(msg) = source.next_message().await {
            match &msg {
                MaestroRpcMessage::Response(ServerResponse::Ping { .. })
                | MaestroRpcMessage::Response(ServerResponse::TerminalOutput(_)) => {}
                _ => {
                    if let Ok(json) = serde_json::to_string(&msg) {
                        log::trace!("[acp] << {connection_key:?} {json}");
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
            handle_shared_server_message(msg, connection_key, &app_handle, &app_state, &pending)
            .await;
        }

        watchdog_alive.store(false, Ordering::Relaxed);

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
                ConnectionEvent { connection: connection_key },
            ) {
                log::warn!("[acp] emit connection-lost failed: {e}");
            }
        }

        // Snapshot restorable metadata before removing sessions from the map.
        // Sessions without an acp_session_id haven't received SpawnOk yet and cannot
        // be restored — emit session-ended for those immediately.
        let (to_restore, to_end_now): (Vec<RestorableSession>, Vec<i32>) = {
            let sessions = app_state.acp.sessions.lock().await;
            let mut restorable: Vec<RestorableSession> = Vec::new();
            let mut unrestorable: Vec<i32> = Vec::new();
            let is_ssh = matches!(connection_key, crate::acp::ConnectionKey::Ssh { .. });
            for (log_id, s) in sessions
                .iter()
                .filter(|(_, s)| s.connection_key == connection_key)
            {
                let acp_session_id = s.acp_session_id.lock().ok().and_then(|g| g.clone());
                if acp_session_id.is_some() && is_ssh {
                    restorable.push(RestorableSession {
                        log_id: *log_id,
                        agent_id: s.agent_id_meta.clone(),
                        acp_session_id,
                        cwd: s.cwd.clone(),
                        session_name: s.session_name.clone(),
                        project_id: s.project_id,
                        task_id: s.task_id,
                    });
                } else {
                    unrestorable.push(*log_id);
                }
            }
            (restorable, unrestorable)
        };

        // Remove all affected sessions from the map.
        {
            let mut sessions = app_state.acp.sessions.lock().await;
            for s in &to_restore {
                sessions.remove(&s.log_id);
            }
            for log_id in &to_end_now {
                sessions.remove(log_id);
            }
        }

        // Immediately end unrestorable sessions (no acp_session_id yet, or non-SSH).
        for log_id in &to_end_now {
            if let Err(e) = app_handle.emit(&format!("acp://session-ended/{}", log_id), ()) {
                log::warn!("[acp] emit session-ended/{log_id} failed: {e}");
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
                        app_handle.emit(&format!("acp://session-ended/{}", s.log_id), ())
                    {
                        log::warn!("[acp] emit session-ended/{} failed: {e}", s.log_id);
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::task::transition::TaskTransition;

    /// A task with a reviewer running on it, in the state both routes to a verdict find it.
    fn under_review(rounds: i32) -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().expect("open db");
        crate::core::schema::initialize_schema(&conn).expect("schema");
        conn.execute(
            "INSERT INTO projects (id, name, path, created_at, updated_at) \
             VALUES (1, 'demo', '/tmp/demo', '2026-01-01', '2026-01-01')",
            [],
        )
        .expect("insert project");
        conn.execute(
            "INSERT INTO tasks (id, project_id, title, status, base_branch, phase, phase_status, \
             ball, review_rounds, created_at, updated_at) \
             VALUES (1, 1, 'demo task', 'Review', 'main', 'SelfReview', 'Running', 'Agent', ?, \
             '2026-01-01', '2026-01-01')",
            [rounds],
        )
        .expect("insert task");
        conn
    }

    fn rounds_on(conn: &rusqlite::Connection) -> i32 {
        conn.query_row("SELECT review_rounds FROM tasks WHERE id = 1", [], |row| row.get(0))
            .expect("read rounds")
    }

    /// Both routes a reviewer can finish by — its turn ending, and the plan-mode exit request it
    /// has instead — land here, and this is the only place the round is counted. It had no test
    /// until the arithmetic in it turned out to be wrong.
    #[test]
    fn asking_for_changes_spends_a_round_and_sends_the_task_back() {
        let conn = under_review(0);

        let event = review_verdict_event(&conn, 1, "CHANGES REQUESTED\n\nThe null check is gone.");

        assert_eq!(event, TaskTransition::ReviewRejected);
        assert_eq!(rounds_on(&conn), 1, "the decision to spend a round is taken here");
    }

    /// Approval is free: it ends the loop rather than going round again, so counting it would
    /// charge a task for the round that did not happen.
    #[test]
    fn approval_costs_nothing_and_ends_the_loop() {
        let conn = under_review(1);

        let event = review_verdict_event(&conn, 1, "APPROVED\n\nReads well.");

        assert_eq!(event, TaskTransition::ReviewFinished);
        assert_eq!(rounds_on(&conn), 1);
    }

    /// The last round the cap allows is still spent; the one after it goes to the user with the
    /// verdict intact rather than starting a coder nobody bounded.
    #[test]
    fn the_round_after_the_cap_goes_to_the_user() {
        use crate::acp::completion::REVIEW_ROUND_CAP;

        let conn = under_review(REVIEW_ROUND_CAP - 1);
        assert_eq!(
            review_verdict_event(&conn, 1, "CHANGES REQUESTED\n\nstill wrong"),
            TaskTransition::ReviewRejected,
            "the last round the cap allows must still be spent"
        );
        assert_eq!(rounds_on(&conn), REVIEW_ROUND_CAP);

        assert_eq!(
            review_verdict_event(&conn, 1, "CHANGES REQUESTED\n\nstill wrong"),
            TaskTransition::ReviewFinished,
            "and the next one escalates instead"
        );
        assert_eq!(rounds_on(&conn), REVIEW_ROUND_CAP, "an escalation is not a round");
    }

    /// A reviewer in plan mode delivers through `ExitPlanMode`, and its payload is a plan rather
    /// than the verdict line. Unparseable is `Approved` by design — the human gate, not another
    /// coder round on a guess.
    #[test]
    fn a_plan_that_is_not_a_verdict_reaches_the_user_rather_than_a_coder() {
        let conn = under_review(0);

        let event = review_verdict_event(&conn, 1, "1. Fix the null check\n2. Add a test");

        assert_eq!(event, TaskTransition::ReviewFinished);
        assert_eq!(rounds_on(&conn), 0);
    }

    fn state_of(conn: &rusqlite::Connection) -> (String, Option<String>, Option<String>, String) {
        conn.query_row(
            "SELECT status, phase, phase_status, ball FROM tasks WHERE id = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .expect("read state")
    }

    /// The join `try_conclude_plan_mode_phase` makes, and the one that was wrong. Testing
    /// `review_verdict_event` and the transition table separately said nothing about it: both were
    /// correct on their own while the path between them sent a reviewer to the wrong one.
    #[test]
    fn a_plan_mode_reviewer_asking_for_changes_goes_back_to_a_coder() {
        let conn = under_review(0);

        let moved = conclude_read_only_phase(
            &conn,
            1,
            Some("SelfReview"),
            "CHANGES REQUESTED\n\nThe null check is gone.",
        )
        .expect("apply");

        assert!(moved.is_some(), "the task must move; the caller closes the session either way");
        let (status, phase, phase_status, ball) = state_of(&conn);
        assert_eq!(
            (status.as_str(), phase.as_deref(), phase_status.as_deref(), ball.as_str()),
            ("InProgress", Some("Rework"), Some("Waiting"), "Agent"),
            "a rejected review is a handoff back to a coder, not a gate"
        );
        assert_eq!(rounds_on(&conn), 1);

        let filed: String = conn
            .query_row(
                "SELECT kind FROM task_comments WHERE task_id = 1 ORDER BY id DESC LIMIT 1",
                [],
                |row| row.get(0),
            )
            .expect("read comment");
        assert_eq!(filed, "verdict", "and it is filed as what it is");
    }

    /// The other two read-only phases still take the artifact route — the point is that the phase
    /// decides, not that everything now goes through the verdict path.
    #[test]
    fn a_planner_still_delivers_its_plan_to_the_gate() {
        let conn = under_review(0);
        conn.execute("UPDATE tasks SET status = 'InProgress', phase = 'Drafting' WHERE id = 1", [])
            .expect("move to drafting");

        conclude_read_only_phase(&conn, 1, Some("Drafting"), "1. Fix it\n2. Test it")
            .expect("apply")
            .expect("the task must move");

        let (status, phase, phase_status, ball) = state_of(&conn);
        assert_eq!(
            (status.as_str(), phase.as_deref(), phase_status.as_deref(), ball.as_str()),
            ("InProgress", Some("PlanReview"), Some("Waiting"), "User")
        );
        assert_eq!(rounds_on(&conn), 0, "a plan is not a review round");
    }
}
