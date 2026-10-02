//! The single place a task's lifecycle fields are written, ported from the app's
//! `task::transition`.
//!
//! `status`, `phase`, `phase_status` and `ball` are correlated: a task in Review awaiting a human is
//! `(Review, Approval, Waiting, User)`, and no other combination of those four is meaningful. So
//! callers do not set fields. They report what happened, and `resolve` decides what that means. It
//! is a pure function, so the whole lifecycle is testable without a database.

use chrono::Utc;
use maestro_protocol::{
    AgentRole, ApplyTaskTransitionRequest, PhaseStatus, Task, TaskBall, TaskCompletion, TaskPhase,
    TaskStatus, TaskTransition, TransitionGuard,
};
use rusqlite::{params, Connection};

use super::{commit, parse, read, text, transaction};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TaskState {
    pub status: TaskStatus,
    pub phase: Option<TaskPhase>,
    pub phase_status: Option<PhaseStatus>,
    pub ball: TaskBall,
    pub completion: Option<TaskCompletion>,
    /// The phase a claim took the task from, which `Spawning` overwrites: a start that does not
    /// come up puts the task back there, and a retry tells its agent what it is resuming.
    pub claimed_from: Option<TaskPhase>,
}

/// The column holding [`TaskState::claimed_from`].
pub const V8_TASK_CLAIMED_FROM: &str = "
ALTER TABLE tasks ADD COLUMN claimed_from TEXT;
";

impl TaskState {
    /// No pipeline activity. Clears `completion` as well, so a task dragged out of Done cannot keep
    /// claiming it merged.
    fn parked(status: TaskStatus) -> Self {
        TaskState {
            status,
            phase: None,
            phase_status: None,
            ball: TaskBall::None,
            completion: None,
            claimed_from: None,
        }
    }

    fn done(completion: Option<TaskCompletion>) -> Self {
        TaskState {
            completion,
            ..TaskState::parked(TaskStatus::Done)
        }
    }

    fn active(
        status: TaskStatus,
        phase: TaskPhase,
        phase_status: PhaseStatus,
        ball: TaskBall,
    ) -> Self {
        TaskState {
            status,
            phase: Some(phase),
            phase_status: Some(phase_status),
            ball,
            completion: None,
            claimed_from: None,
        }
    }

    /// A claimed start that did not come up, back in the phase it was claimed from, failed and the
    /// user's: a retry claims it again. With no such phase there is nothing to go back to.
    fn unclaimed(self, otherwise: TaskState) -> TaskState {
        match self.claimed_from {
            Some(phase) if self.phase == Some(TaskPhase::Spawning) => {
                TaskState::active(self.status, phase, PhaseStatus::Failed, TaskBall::User)
            }
            _ => otherwise,
        }
    }
}

/// Decide the new state from what happened and where the task currently is.
///
/// Events that describe the agent rather than the task (`AwaitingUserInput`, `Unblocked`,
/// `PhaseFailed`) keep the current `status` and `phase`: a permission prompt during implementation
/// must not move the card. The reasoning behind each arm is on the app's `TaskTransition`.
pub fn resolve(event: TaskTransition, current: TaskState) -> TaskState {
    use PhaseStatus::*;
    use TaskBall as Ball;
    use TaskPhase::*;
    use TaskStatus::*;

    match event {
        TaskTransition::ManualMove(status) => TaskState::parked(status),

        // Keeps its column: nothing is running yet, and a failed spawn belongs back where the user
        // launched it.
        TaskTransition::ExecutionStarted => TaskState {
            phase: Some(Spawning),
            phase_status: Some(Running),
            ball: Ball::Agent,
            completion: None,
            // A retry of a failed spawn is still the start of what the first claim took it from.
            claimed_from: if current.phase == Some(Spawning) {
                current.claimed_from
            } else {
                current.phase
            },
            ..current
        },

        TaskTransition::SessionReady(role) => match role {
            // A coder starting on a task in Review is fixing the build on an open pull request. The
            // test is the column, because the claim already overwrote the phase with `Spawning`.
            AgentRole::Coder if current.status == Review => {
                TaskState::active(Review, AwaitingMerge, Running, Ball::Agent)
            }
            AgentRole::Refiner => TaskState::active(Planning, Refining, Running, Ball::Agent),
            AgentRole::Planner => TaskState::active(InProgress, Drafting, Running, Ball::Agent),
            AgentRole::Coder => TaskState::active(InProgress, Implementing, Running, Ball::Agent),
            AgentRole::Reviewer => TaskState::active(Review, SelfReview, Running, Ball::Agent),
        },

        TaskTransition::SpawnAborted => current.unclaimed(TaskState::parked(current.status)),

        TaskTransition::AwaitingUserInput => TaskState {
            phase_status: Some(Blocked),
            ball: Ball::User,
            ..current
        },

        TaskTransition::Unblocked => TaskState {
            phase_status: Some(Running),
            ball: Ball::Agent,
            ..current
        },

        TaskTransition::ReviewFinished => TaskState::active(Review, Approval, Waiting, Ball::User),

        TaskTransition::ReviewRejected => {
            TaskState::active(InProgress, Rework, Waiting, Ball::Agent)
        }

        // The two destinations `TurnCompleted` gives these phases. Anything else keeps its state: a
        // task that moved on must not be dragged back to a gate by a request still in flight.
        TaskTransition::ArtifactDelivered => match current.phase {
            Some(Drafting) => TaskState::active(InProgress, PlanReview, Waiting, Ball::User),
            Some(Refining) => TaskState::active(Planning, Refining, Waiting, Ball::User),
            _ => current,
        },

        TaskTransition::TurnCompleted {
            is_git_repo,
            has_changes,
            reviewer_pending,
        } => match current.phase {
            Some(Drafting) => TaskState::active(InProgress, PlanReview, Waiting, Ball::User),
            Some(Refining) => TaskState::active(Planning, Refining, Waiting, Ball::User),
            _ if !is_git_repo => TaskState::done(None),
            // Only a definite "nothing changed" closes the task; unknown goes to review.
            _ if has_changes == Some(false) => TaskState::done(Some(TaskCompletion::NoChanges)),
            _ if reviewer_pending => TaskState::active(Review, SelfReview, Waiting, Ball::Agent),
            _ => TaskState::active(Review, Approval, Waiting, Ball::User),
        },

        TaskTransition::Stopped => TaskState::parked(Planning),

        TaskTransition::RefinementClosed => TaskState::parked(Planning),

        TaskTransition::ReworkRequested => {
            TaskState::active(InProgress, Rework, Waiting, Ball::User)
        }

        TaskTransition::MergeConflict => TaskState::active(InProgress, Rework, Failed, Ball::User),

        TaskTransition::Merged => TaskState::done(Some(TaskCompletion::Merged)),

        TaskTransition::ApprovedWithoutMerge => TaskState::done(Some(TaskCompletion::LocalOnly)),

        TaskTransition::PullRequestOpened => {
            TaskState::active(Review, AwaitingMerge, Waiting, Ball::External)
        }

        TaskTransition::PullRequestMerged => TaskState::done(Some(TaskCompletion::MergedViaPR)),

        TaskTransition::PullRequestClosed => {
            TaskState::active(Review, AwaitingMerge, Failed, Ball::User)
        }

        TaskTransition::PullRequestConflicted => {
            TaskState::active(Review, AwaitingMerge, Waiting, Ball::User)
        }

        TaskTransition::PullRequestMergeable => {
            TaskState::active(Review, AwaitingMerge, Waiting, Ball::External)
        }

        TaskTransition::CiFixRequested => {
            TaskState::active(Review, AwaitingMerge, Waiting, Ball::Agent)
        }

        TaskTransition::CiFixPushed => {
            TaskState::active(Review, AwaitingMerge, Waiting, Ball::External)
        }

        TaskTransition::Discarded => TaskState::parked(Planning),

        TaskTransition::Cancelled => TaskState::parked(TaskStatus::Cancelled),

        TaskTransition::PhaseFailed => current.unclaimed(TaskState {
            phase_status: Some(Failed),
            ball: Ball::User,
            ..current
        }),
    }
}

pub(crate) fn read_state(
    conn: &Connection,
    project_path: &str,
    task_id: i32,
) -> Result<TaskState, String> {
    conn.query_row(
        "SELECT status, phase, phase_status, ball, completion, claimed_from FROM tasks
         WHERE project_path = ?1 AND id = ?2",
        params![project_path, task_id],
        |row| {
            let optional = |index: usize| row.get::<_, Option<String>>(index);
            Ok(TaskState {
                status: parse(&row.get::<_, String>(0)?).unwrap_or(TaskStatus::Planning),
                phase: optional(1)?.and_then(|s| parse(&s)),
                phase_status: optional(2)?.and_then(|s| parse(&s)),
                ball: parse(&row.get::<_, String>(3)?).unwrap_or(TaskBall::None),
                completion: optional(4)?.and_then(|s| parse(&s)),
                claimed_from: optional(5)?.and_then(|s| parse(&s)),
            })
        },
    )
    .map_err(|e| format!("Failed to read task {task_id} state: {e}"))
}

/// Whether the guard lets `event` through, and the event to apply when it does.
fn admit(
    guard: &TransitionGuard,
    event: TaskTransition,
    current: TaskState,
) -> Option<TaskTransition> {
    let admitted = match guard {
        TransitionGuard::Always => true,
        TransitionGuard::Status(expected) => expected.contains(&current.status),
        TransitionGuard::Claim(expected) => {
            // A handoff: one role finished and the board asks for the next. It bypasses
            // `expected`, which lists the columns a user may press Execute from; the phase already
            // pins where the task is. `Approval` waits on a person, so it is not one.
            let handoff = matches!(
                (current.phase, current.phase_status),
                (
                    Some(TaskPhase::SelfReview | TaskPhase::Rework | TaskPhase::AwaitingMerge),
                    Some(PhaseStatus::Waiting)
                )
            );
            // A stage that failed, or a start put back in the phase it was claimed from, is the
            // retry of the stage that phase hands to, wherever its card is.
            let retry = matches!(
                (current.phase, current.phase_status),
                (
                    Some(
                        TaskPhase::PlanReview
                            | TaskPhase::SelfReview
                            | TaskPhase::Rework
                            | TaskPhase::AwaitingMerge
                    ),
                    Some(PhaseStatus::Failed)
                )
            );
            // A failed spawn is claimable, since it is the retry, and so is the plan gate, since
            // approving the plan is what starts the coder.
            let claimable = handoff
                || retry
                || matches!(
                    (current.phase, current.phase_status),
                    (None, _)
                        | (Some(TaskPhase::Spawning), Some(PhaseStatus::Failed))
                        | (Some(TaskPhase::PlanReview), Some(PhaseStatus::Waiting))
                );
            // Through `ExecutionStarted` whatever was asked, so the phase becomes `Spawning` and a
            // second claim finds nothing claimable.
            return (claimable && (handoff || retry || expected.contains(&current.status)))
                .then_some(TaskTransition::ExecutionStarted);
        }
        // `Failed` counts as still spawning, so a retry of a failed spawn can succeed.
        TransitionGuard::Spawning => current.phase == Some(TaskPhase::Spawning),
        TransitionGuard::Active => current.phase.is_some(),
        // Permission requests arrive constantly, and each write refetches every board.
        TransitionGuard::Changed => resolve(event, current) != current,
        TransitionGuard::Phase(phase) => current.phase == Some(*phase),
        // A bare `Unblocked` would also turn a task at a `Waiting` gate into `Running`.
        TransitionGuard::Blocked => current.phase_status == Some(PhaseStatus::Blocked),
        TransitionGuard::AgentRunning => matches!(
            current.phase_status,
            Some(PhaseStatus::Running | PhaseStatus::Blocked)
        ),
        // The rounds are not lifecycle state; `admitted` reads and checks them.
        TransitionGuard::FixRoundsBelow(_) => current.ball == TaskBall::External,
        TransitionGuard::Ball(ball) => current.ball == *ball,
    };
    admitted.then_some(event)
}

/// Read what `guard` needs and decide, returning the event to apply, or `None` when it refused.
/// A missing task is an error whatever the guard.
fn admitted(
    conn: &Connection,
    project_path: &str,
    task_id: i32,
    event: TaskTransition,
    guard: &TransitionGuard,
) -> Result<Option<TaskTransition>, String> {
    let current = read_state(conn, project_path, task_id)?;
    let Some(event) = admit(guard, event, current) else {
        return Ok(None);
    };
    if let TransitionGuard::FixRoundsBelow(cap) = guard {
        let rounds: i32 = conn
            .query_row(
                "SELECT fix_rounds FROM tasks WHERE project_path = ?1 AND id = ?2",
                params![project_path, task_id],
                |row| row.get(0),
            )
            .map_err(|e| format!("Failed to read task {task_id} fix rounds: {e}"))?;
        if rounds >= *cap {
            return Ok(None);
        }
    }
    Ok(Some(event))
}

/// Apply a transition if `guard` holds, returning the updated task, or `None` when it refused.
/// A missing task is an error whatever the guard.
///
/// Takes a `&Connection` so a composite step can run it inside its own transaction.
pub(super) fn apply(
    conn: &Connection,
    project_path: &str,
    task_id: i32,
    event: TaskTransition,
    guard: &TransitionGuard,
) -> Result<Option<Task>, String> {
    let Some(event) = admitted(conn, project_path, task_id, event, guard)? else {
        return Ok(None);
    };
    write(conn, project_path, task_id, event).map(Some)
}

/// Apply an admitted event to the task as it now stands.
fn write(
    conn: &Connection,
    project_path: &str,
    task_id: i32,
    event: TaskTransition,
) -> Result<Task, String> {
    let next = resolve(event, read_state(conn, project_path, task_id)?);

    // A deferral is a promise to a task the scheduler has not picked up yet, so it only survives
    // while the task is still a candidate: parked in Queue. Being claimed clears it, and so does
    // the user dragging the card elsewhere.
    let keep_request = next.status == TaskStatus::Queue && next.phase.is_none();

    conn.execute(
        "UPDATE tasks SET status = ?1, phase = ?2, phase_status = ?3, ball = ?4, completion = ?5,
             execute_requested_at = CASE WHEN ?6 THEN execute_requested_at ELSE NULL END,
             updated_at = ?7, claimed_from = ?10
         WHERE project_path = ?8 AND id = ?9",
        params![
            text(next.status),
            next.phase.map(text),
            next.phase_status.map(text),
            text(next.ball),
            next.completion.map(text),
            keep_request,
            Utc::now().to_rfc3339(),
            project_path,
            task_id,
            next.claimed_from.map(text),
        ],
    )
    .map_err(|e| format!("Failed to apply transition to task {task_id}: {e}"))?;

    read(conn, project_path, task_id)
}

/// One guarded transition, the guard read in the same transaction as the write, with the update
/// the pipeline writes before it and the entry it files after it. A refusal writes none of them,
/// so a step such as a CI fix is counted and reported only if it is also taken.
pub fn apply_transition(
    conn: &mut Connection,
    request: &ApplyTaskTransitionRequest,
) -> Result<Option<Task>, String> {
    let (project_path, task_id) = (request.project_path.as_str(), request.task_id);
    let tx = transaction(conn)?;
    let Some(event) = admitted(&tx, project_path, task_id, request.event, &request.guard)? else {
        return Ok(None);
    };
    if let Some(update) = &request.update {
        super::write_update(&tx, project_path, task_id, update)?;
    }
    let task = write(&tx, project_path, task_id, event)?;
    if let Some(comment) = &request.comment {
        super::append(
            &tx,
            project_path,
            task_id,
            &comment.kind,
            &comment.author,
            comment.body.as_deref(),
            comment.external_ref.as_deref(),
            comment.phase.as_deref(),
        )?;
    }
    commit(tx)?;
    Ok(Some(task))
}

#[cfg(test)]
mod tests {
    use super::*;

    const READ_ONLY_PHASES: [TaskPhase; 3] = [
        TaskPhase::Refining,
        TaskPhase::Drafting,
        TaskPhase::SelfReview,
    ];

    /// A plan-mode agent's request to leave plan mode is the only "I am finished" it has, so it
    /// must reach the same gate a turn ending would.
    #[test]
    fn a_delivered_artifact_reaches_the_same_gate_a_finished_turn_would() {
        for (phase, status) in [
            (TaskPhase::Drafting, TaskStatus::InProgress),
            (TaskPhase::Refining, TaskStatus::Planning),
        ] {
            let running = TaskState::active(status, phase, PhaseStatus::Running, TaskBall::Agent);
            let delivered = resolve(TaskTransition::ArtifactDelivered, running);
            let finished = resolve(
                TaskTransition::TurnCompleted {
                    is_git_repo: true,
                    has_changes: Some(false),
                    reviewer_pending: false,
                },
                running,
            );
            assert_eq!(delivered, finished, "{phase:?}");
            assert_eq!(delivered.ball, TaskBall::User, "{phase:?}");
        }
    }

    /// `SelfReview` has no gate of its own: it is routed to the verdict path before
    /// `ArtifactDelivered` is reached. A read-only phase that reaches it with no arm here is the
    /// bug, and a fourth read-only phase would land in the same hole.
    #[test]
    fn every_read_only_phase_is_either_a_gate_or_deliberately_not_one() {
        for phase in READ_ONLY_PHASES {
            let running = TaskState::active(
                TaskStatus::InProgress,
                phase,
                PhaseStatus::Running,
                TaskBall::Agent,
            );
            let delivered = resolve(TaskTransition::ArtifactDelivered, running);
            if phase == TaskPhase::SelfReview {
                assert_eq!(delivered, running);
                continue;
            }
            assert_ne!(delivered, running, "{phase:?}");
            assert_eq!(delivered.ball, TaskBall::User, "{phase:?}");
        }
    }

    #[test]
    fn a_delivered_artifact_does_not_move_a_task_that_left_its_read_only_phase() {
        let elsewhere = implementing();
        assert_eq!(
            resolve(TaskTransition::ArtifactDelivered, elsewhere),
            elsewhere
        );
    }

    fn implementing() -> TaskState {
        TaskState::active(
            TaskStatus::InProgress,
            TaskPhase::Implementing,
            PhaseStatus::Running,
            TaskBall::Agent,
        )
    }

    fn spawning(status: TaskStatus) -> TaskState {
        TaskState::active(
            status,
            TaskPhase::Spawning,
            PhaseStatus::Running,
            TaskBall::Agent,
        )
    }

    fn turn(has_changes: Option<bool>, reviewer_pending: bool) -> TaskTransition {
        TaskTransition::TurnCompleted {
            is_git_repo: true,
            has_changes,
            reviewer_pending,
        }
    }

    /// The claim must not move the card.
    #[test]
    fn a_claim_marks_the_task_spawning_without_moving_it() {
        for status in [TaskStatus::Planning, TaskStatus::Queue] {
            let next = resolve(TaskTransition::ExecutionStarted, TaskState::parked(status));
            assert_eq!(next, spawning(status));
        }
    }

    #[test]
    fn each_role_lands_in_its_own_column_and_phase() {
        for (role, status, phase) in [
            (
                AgentRole::Refiner,
                TaskStatus::Planning,
                TaskPhase::Refining,
            ),
            (
                AgentRole::Planner,
                TaskStatus::InProgress,
                TaskPhase::Drafting,
            ),
            (
                AgentRole::Coder,
                TaskStatus::InProgress,
                TaskPhase::Implementing,
            ),
            (
                AgentRole::Reviewer,
                TaskStatus::Review,
                TaskPhase::SelfReview,
            ),
        ] {
            let next = resolve(
                TaskTransition::SessionReady(role),
                spawning(TaskStatus::Planning),
            );
            assert_eq!(
                next,
                TaskState::active(status, phase, PhaseStatus::Running, TaskBall::Agent),
                "for {role:?}"
            );
        }
    }

    #[test]
    fn closing_the_refinement_gate_parks_the_task_in_planning() {
        let at_the_gate = TaskState::active(
            TaskStatus::Planning,
            TaskPhase::Refining,
            PhaseStatus::Waiting,
            TaskBall::User,
        );
        assert_eq!(
            resolve(TaskTransition::RefinementClosed, at_the_gate),
            TaskState::parked(TaskStatus::Planning)
        );
    }

    #[test]
    fn an_aborted_spawn_parks_the_task_where_it_started() {
        for status in [TaskStatus::Planning, TaskStatus::Queue] {
            let next = resolve(TaskTransition::SpawnAborted, spawning(status));
            assert_eq!(next, TaskState::parked(status));
        }
    }

    /// A hand-off that does not come up goes back to the phase it was claimed from, failed, where
    /// the stage it hands to can claim it again and still knows what it is resuming.
    #[test]
    fn a_start_that_does_not_come_up_goes_back_to_the_phase_it_was_claimed_from() {
        let handoff = TaskState::active(
            TaskStatus::Review,
            TaskPhase::SelfReview,
            PhaseStatus::Waiting,
            TaskBall::Agent,
        );
        let claimed = resolve(TaskTransition::ExecutionStarted, handoff);
        assert_eq!(claimed.claimed_from, Some(TaskPhase::SelfReview));
        let back = TaskState::active(
            TaskStatus::Review,
            TaskPhase::SelfReview,
            PhaseStatus::Failed,
            TaskBall::User,
        );
        assert_eq!(resolve(TaskTransition::SpawnAborted, claimed), back);
        assert_eq!(resolve(TaskTransition::PhaseFailed, claimed), back);
        assert!(admit(
            &TransitionGuard::Claim(vec![TaskStatus::Queue]),
            TaskTransition::Stopped,
            back
        )
        .is_some());

        // A failed spawn's retry is still the start of the rework the first claim took.
        let rework = TaskState::active(
            TaskStatus::InProgress,
            TaskPhase::Rework,
            PhaseStatus::Waiting,
            TaskBall::User,
        );
        let failed_spawn = TaskState {
            phase_status: Some(PhaseStatus::Failed),
            ..resolve(TaskTransition::ExecutionStarted, rework)
        };
        let retried = resolve(TaskTransition::ExecutionStarted, failed_spawn);
        assert_eq!(retried.claimed_from, Some(TaskPhase::Rework));
    }

    #[test]
    fn a_failed_spawn_stays_in_its_column_as_a_failed_phase() {
        let next = resolve(TaskTransition::PhaseFailed, spawning(TaskStatus::Queue));
        assert_eq!(
            next,
            TaskState::active(
                TaskStatus::Queue,
                TaskPhase::Spawning,
                PhaseStatus::Failed,
                TaskBall::User
            )
        );
    }

    #[test]
    fn manual_move_clears_pipeline_activity() {
        let next = resolve(
            TaskTransition::ManualMove(TaskStatus::Queue),
            implementing(),
        );
        assert_eq!(next, TaskState::parked(TaskStatus::Queue));
    }

    #[test]
    fn awaiting_input_changes_only_who_is_waiting() {
        let next = resolve(TaskTransition::AwaitingUserInput, implementing());
        assert_eq!(next.status, TaskStatus::InProgress);
        assert_eq!(next.phase, Some(TaskPhase::Implementing));
        assert_eq!(next.phase_status, Some(PhaseStatus::Blocked));
        assert_eq!(next.ball, TaskBall::User);
        assert_eq!(resolve(TaskTransition::Unblocked, next), implementing());
    }

    #[test]
    fn phase_failed_preserves_status_and_phase() {
        let next = resolve(TaskTransition::PhaseFailed, implementing());
        assert_eq!(next.status, TaskStatus::InProgress);
        assert_eq!(next.phase, Some(TaskPhase::Implementing));
        assert_eq!(next.phase_status, Some(PhaseStatus::Failed));
        assert_eq!(next.ball, TaskBall::User);
    }

    #[test]
    fn a_finished_turn_routes_on_repo_changes_and_reviewer() {
        assert_eq!(
            resolve(turn(Some(true), false), implementing()),
            TaskState::active(
                TaskStatus::Review,
                TaskPhase::Approval,
                PhaseStatus::Waiting,
                TaskBall::User
            )
        );
        let without_repo = resolve(
            TaskTransition::TurnCompleted {
                is_git_repo: false,
                has_changes: None,
                reviewer_pending: false,
            },
            implementing(),
        );
        assert_eq!(without_repo, TaskState::parked(TaskStatus::Done));

        let unchanged = resolve(turn(Some(false), false), implementing());
        assert_eq!(unchanged.status, TaskStatus::Done);
        assert_eq!(unchanged.completion, Some(TaskCompletion::NoChanges));

        // Unknown is not the same as none: closing a task on missing evidence has no way back.
        assert_eq!(
            resolve(turn(None, false), implementing()).status,
            TaskStatus::Review
        );

        assert_eq!(
            resolve(turn(Some(true), true), implementing()),
            TaskState::active(
                TaskStatus::Review,
                TaskPhase::SelfReview,
                PhaseStatus::Waiting,
                TaskBall::Agent
            )
        );
    }

    #[test]
    fn a_finished_plan_or_refinement_waits_at_its_own_gate() {
        let drafting = TaskState::active(
            TaskStatus::InProgress,
            TaskPhase::Drafting,
            PhaseStatus::Running,
            TaskBall::Agent,
        );
        assert_eq!(
            resolve(turn(Some(true), false), drafting),
            TaskState::active(
                TaskStatus::InProgress,
                TaskPhase::PlanReview,
                PhaseStatus::Waiting,
                TaskBall::User
            )
        );
        let refining = TaskState::active(
            TaskStatus::Planning,
            TaskPhase::Refining,
            PhaseStatus::Running,
            TaskBall::Agent,
        );
        assert_eq!(
            resolve(turn(None, false), refining),
            TaskState::active(
                TaskStatus::Planning,
                TaskPhase::Refining,
                PhaseStatus::Waiting,
                TaskBall::User
            )
        );
    }

    #[test]
    fn rework_and_conflict_land_in_progress_with_the_user() {
        let from_review = TaskState::active(
            TaskStatus::Review,
            TaskPhase::Approval,
            PhaseStatus::Waiting,
            TaskBall::User,
        );
        assert_eq!(
            resolve(TaskTransition::ReworkRequested, from_review),
            TaskState::active(
                TaskStatus::InProgress,
                TaskPhase::Rework,
                PhaseStatus::Waiting,
                TaskBall::User
            )
        );
        assert_eq!(
            resolve(TaskTransition::MergeConflict, from_review),
            TaskState::active(
                TaskStatus::InProgress,
                TaskPhase::Rework,
                PhaseStatus::Failed,
                TaskBall::User
            )
        );
    }

    #[test]
    fn terminal_events_park_the_task() {
        for (event, status) in [
            (TaskTransition::Stopped, TaskStatus::Planning),
            (TaskTransition::Discarded, TaskStatus::Planning),
            (TaskTransition::Cancelled, TaskStatus::Cancelled),
        ] {
            assert_eq!(
                resolve(event, implementing()),
                TaskState::parked(status),
                "for {event:?}"
            );
        }
    }

    #[test]
    fn the_approve_paths_are_distinguishable() {
        for (event, completion) in [
            (TaskTransition::Merged, TaskCompletion::Merged),
            (
                TaskTransition::ApprovedWithoutMerge,
                TaskCompletion::LocalOnly,
            ),
        ] {
            let next = resolve(event, implementing());
            assert_eq!(next.status, TaskStatus::Done, "for {event:?}");
            assert_eq!(next.completion, Some(completion), "for {event:?}");
        }
        let opened = resolve(TaskTransition::PullRequestOpened, implementing());
        assert_eq!(
            opened,
            TaskState::active(
                TaskStatus::Review,
                TaskPhase::AwaitingMerge,
                PhaseStatus::Waiting,
                TaskBall::External
            )
        );
    }

    #[test]
    fn the_forge_can_land_a_task_or_send_it_back_to_the_user() {
        let awaiting = resolve(TaskTransition::PullRequestOpened, implementing());

        let merged = resolve(TaskTransition::PullRequestMerged, awaiting);
        assert_eq!(merged.completion, Some(TaskCompletion::MergedViaPR));
        assert_eq!(merged.ball, TaskBall::None);

        let closed = resolve(TaskTransition::PullRequestClosed, awaiting);
        assert_eq!(closed.phase, Some(TaskPhase::AwaitingMerge));
        assert_eq!(closed.phase_status, Some(PhaseStatus::Failed));
        assert_eq!(closed.ball, TaskBall::User);

        // A conflict is amber, not the red that means the pull request is gone, and it clears.
        let conflicted = resolve(TaskTransition::PullRequestConflicted, awaiting);
        assert_eq!(conflicted.phase_status, Some(PhaseStatus::Waiting));
        assert_eq!(conflicted.ball, TaskBall::User);
        assert_ne!(conflicted, closed);
        assert_eq!(
            resolve(TaskTransition::PullRequestMergeable, conflicted),
            awaiting
        );
    }

    #[test]
    fn a_rejected_review_hands_back_to_a_coder_and_an_accepted_one_to_the_user() {
        let reviewing = TaskState::active(
            TaskStatus::Review,
            TaskPhase::SelfReview,
            PhaseStatus::Running,
            TaskBall::Agent,
        );
        let rejected = resolve(TaskTransition::ReviewRejected, reviewing);
        assert_eq!(rejected.phase, Some(TaskPhase::Rework));
        assert_eq!(rejected.ball, TaskBall::Agent);

        let finished = resolve(TaskTransition::ReviewFinished, reviewing);
        assert_eq!(finished.phase, Some(TaskPhase::Approval));
        assert_eq!(finished.ball, TaskBall::User);
    }

    #[test]
    fn fixing_a_red_build_keeps_the_task_on_its_pull_request() {
        let awaiting = resolve(TaskTransition::PullRequestOpened, implementing());
        let requested = resolve(TaskTransition::CiFixRequested, awaiting);
        assert_eq!(requested.ball, TaskBall::Agent);

        let running = resolve(TaskTransition::SessionReady(AgentRole::Coder), requested);
        assert_eq!(running.status, TaskStatus::Review);
        assert_eq!(running.phase, Some(TaskPhase::AwaitingMerge));

        let pushed = resolve(TaskTransition::CiFixPushed, running);
        assert_eq!(pushed.ball, TaskBall::External);

        let fresh = resolve(
            TaskTransition::SessionReady(AgentRole::Coder),
            implementing(),
        );
        assert_eq!(fresh.phase, Some(TaskPhase::Implementing));
    }

    #[test]
    fn parking_clears_a_stale_completion() {
        let merged = resolve(TaskTransition::Merged, implementing());
        let moved = resolve(TaskTransition::ManualMove(TaskStatus::Planning), merged);
        assert_eq!(moved.completion, None);
    }

    /// The column stores what the app wrote, or rows imported in phase 4 would not read back.
    #[test]
    fn stored_names_are_the_apps() {
        assert_eq!(text(TaskStatus::InProgress), "InProgress");
        assert_eq!(text(TaskCompletion::MergedViaPR), "MergedViaPR");
        assert_eq!(
            parse::<TaskPhase>("AwaitingMerge"),
            Some(TaskPhase::AwaitingMerge)
        );
        assert_eq!(parse::<TaskPhase>("Backlog"), None);
    }

    mod database {
        use super::super::super::tests::{db_with_task, PROJECT};
        use super::*;

        fn state(conn: &Connection, task_id: i32) -> TaskState {
            read_state(conn, PROJECT, task_id).expect("read state")
        }

        fn guarded(
            conn: &Connection,
            task_id: i32,
            event: TaskTransition,
            guard: TransitionGuard,
        ) -> Option<Task> {
            apply(conn, PROJECT, task_id, event, &guard).expect("apply")
        }

        fn always(conn: &Connection, task_id: i32, event: TaskTransition) -> Task {
            guarded(conn, task_id, event, TransitionGuard::Always).expect("applied")
        }

        fn claim(conn: &Connection, task_id: i32, expected: &[TaskStatus]) -> Option<Task> {
            // The event is ignored: a claim is `ExecutionStarted` whatever it says.
            guarded(
                conn,
                task_id,
                TaskTransition::Stopped,
                TransitionGuard::Claim(expected.to_vec()),
            )
        }

        fn when_spawning(conn: &Connection, task_id: i32, event: TaskTransition) -> Option<Task> {
            guarded(conn, task_id, event, TransitionGuard::Spawning)
        }

        const USER_COLUMNS: [TaskStatus; 2] = [TaskStatus::Planning, TaskStatus::Queue];

        fn start_execution(conn: &Connection, task_id: i32) {
            claim(conn, task_id, &USER_COLUMNS).expect("claim");
            when_spawning(
                conn,
                task_id,
                TaskTransition::SessionReady(AgentRole::Coder),
            )
            .expect("session ready");
        }

        #[test]
        fn a_missing_task_is_an_error_whatever_the_guard() {
            let (conn, _) = db_with_task();
            for guard in [TransitionGuard::Always, TransitionGuard::Active] {
                assert!(apply(&conn, PROJECT, 99, TaskTransition::Stopped, &guard).is_err());
            }
            assert!(apply(
                &conn,
                "/other",
                1,
                TaskTransition::Stopped,
                &TransitionGuard::Always
            )
            .is_err());
        }

        #[test]
        fn apply_persists_every_lifecycle_field() {
            let (conn, task_id) = db_with_task();
            start_execution(&conn, task_id);
            assert_eq!(state(&conn, task_id), implementing());

            let task = always(&conn, task_id, TaskTransition::ApprovedWithoutMerge);
            assert_eq!(task.completion, Some(TaskCompletion::LocalOnly));
            assert_eq!(
                state(&conn, task_id).completion,
                Some(TaskCompletion::LocalOnly)
            );
        }

        #[test]
        fn a_status_guard_refuses_a_task_that_moved_on() {
            let (conn, task_id) = db_with_task();
            always(&conn, task_id, TaskTransition::ManualMove(TaskStatus::Done));
            assert!(guarded(
                &conn,
                task_id,
                TaskTransition::ManualMove(TaskStatus::Queue),
                TransitionGuard::Status(USER_COLUMNS.to_vec()),
            )
            .is_none());
            assert_eq!(state(&conn, task_id).status, TaskStatus::Done);
        }

        #[test]
        fn a_claim_accepts_any_listed_column_and_nothing_else() {
            for start in USER_COLUMNS {
                let (conn, task_id) = db_with_task();
                always(&conn, task_id, TaskTransition::ManualMove(start));
                assert!(claim(&conn, task_id, &USER_COLUMNS).is_some(), "{start:?}");
                assert_eq!(state(&conn, task_id), spawning(start));
            }
            let (conn, task_id) = db_with_task();
            always(&conn, task_id, TaskTransition::ManualMove(TaskStatus::Done));
            assert!(claim(&conn, task_id, &USER_COLUMNS).is_none());
        }

        /// Two Execute clicks, or a click racing the auto-mode drain, must build one session.
        #[test]
        fn a_task_already_spawning_cannot_be_claimed_again() {
            let (conn, task_id) = db_with_task();
            assert!(claim(&conn, task_id, &USER_COLUMNS).is_some());
            assert!(claim(&conn, task_id, &USER_COLUMNS).is_none());
        }

        #[test]
        fn a_late_spawn_cannot_move_a_task_that_left() {
            let (conn, task_id) = db_with_task();
            claim(&conn, task_id, &[TaskStatus::Queue]).expect("claim");
            always(
                &conn,
                task_id,
                TaskTransition::ManualMove(TaskStatus::Planning),
            );
            let before = state(&conn, task_id);
            assert!(when_spawning(
                &conn,
                task_id,
                TaskTransition::SessionReady(AgentRole::Coder)
            )
            .is_none());
            assert_eq!(state(&conn, task_id), before);
        }

        #[test]
        fn a_failed_spawn_can_be_claimed_again() {
            let (conn, task_id) = db_with_task();
            claim(&conn, task_id, &[TaskStatus::Queue]).expect("claim");
            when_spawning(&conn, task_id, TaskTransition::PhaseFailed).expect("failed");
            assert!(claim(&conn, task_id, &[TaskStatus::Queue]).is_some());
            assert_eq!(state(&conn, task_id), spawning(TaskStatus::Queue));
            when_spawning(
                &conn,
                task_id,
                TaskTransition::SessionReady(AgentRole::Coder),
            )
            .expect("ready");
            assert_eq!(state(&conn, task_id), implementing());
        }

        #[test]
        fn a_task_at_the_plan_gate_can_be_claimed() {
            let (conn, task_id) = db_with_task();
            claim(&conn, task_id, &[TaskStatus::Queue]).expect("claim");
            when_spawning(
                &conn,
                task_id,
                TaskTransition::SessionReady(AgentRole::Planner),
            )
            .expect("ready");
            always(&conn, task_id, turn(None, false));
            assert_eq!(state(&conn, task_id).phase, Some(TaskPhase::PlanReview));

            assert!(claim(&conn, task_id, &[TaskStatus::InProgress]).is_some());
            assert_eq!(
                state(&conn, task_id),
                TaskState {
                    claimed_from: Some(TaskPhase::PlanReview),
                    ..spawning(TaskStatus::InProgress)
                }
            );
        }

        /// Every handoff is claimable from the column its role works in, which no caller lists.
        #[test]
        fn every_handoff_can_be_claimed_from_the_column_its_role_works_in() {
            for (event, phase, status) in [
                (
                    turn(Some(true), true),
                    TaskPhase::SelfReview,
                    TaskStatus::Review,
                ),
                (
                    TaskTransition::ReviewRejected,
                    TaskPhase::Rework,
                    TaskStatus::InProgress,
                ),
                (
                    TaskTransition::CiFixRequested,
                    TaskPhase::AwaitingMerge,
                    TaskStatus::Review,
                ),
            ] {
                let (conn, task_id) = db_with_task();
                start_execution(&conn, task_id);
                always(&conn, task_id, event);
                assert_eq!(
                    state(&conn, task_id),
                    TaskState::active(status, phase, PhaseStatus::Waiting, TaskBall::Agent)
                );
                assert!(claim(&conn, task_id, &USER_COLUMNS).is_some(), "{phase:?}");
                assert_eq!(
                    state(&conn, task_id),
                    TaskState {
                        claimed_from: Some(phase),
                        ..spawning(status)
                    }
                );
                assert!(claim(&conn, task_id, &USER_COLUMNS).is_none(), "{phase:?}");
            }
        }

        /// Through the claim, not around it: the claim overwrote the phase, so only the column
        /// says this coder is fixing a pull request's build.
        #[test]
        fn a_ci_fix_stays_on_its_pull_request_across_the_claim() {
            let (conn, task_id) = db_with_task();
            start_execution(&conn, task_id);
            always(&conn, task_id, TaskTransition::CiFixRequested);
            claim(&conn, task_id, &USER_COLUMNS).expect("claim");
            when_spawning(
                &conn,
                task_id,
                TaskTransition::SessionReady(AgentRole::Coder),
            )
            .expect("ready");
            assert_eq!(
                state(&conn, task_id),
                TaskState::active(
                    TaskStatus::Review,
                    TaskPhase::AwaitingMerge,
                    PhaseStatus::Running,
                    TaskBall::Agent
                )
            );
        }

        #[test]
        fn a_rework_round_is_still_ordinary_work() {
            let (conn, task_id) = db_with_task();
            start_execution(&conn, task_id);
            always(&conn, task_id, TaskTransition::ReviewRejected);
            claim(&conn, task_id, &USER_COLUMNS).expect("claim");
            when_spawning(
                &conn,
                task_id,
                TaskTransition::SessionReady(AgentRole::Coder),
            )
            .expect("ready");
            assert_eq!(state(&conn, task_id), implementing());
        }

        #[test]
        fn the_approval_gate_and_a_live_phase_are_not_claimable() {
            let (conn, task_id) = db_with_task();
            start_execution(&conn, task_id);
            assert!(claim(&conn, task_id, &[TaskStatus::InProgress]).is_none());
            always(&conn, task_id, turn(Some(true), false));
            assert_eq!(state(&conn, task_id).phase, Some(TaskPhase::Approval));
            assert!(claim(&conn, task_id, &[TaskStatus::Review]).is_none());
        }

        fn request_marker(conn: &Connection, task_id: i32) -> Option<String> {
            conn.query_row(
                "SELECT execute_requested_at FROM tasks WHERE id = ?1",
                [task_id],
                |row| row.get(0),
            )
            .expect("read the deferral marker")
        }

        fn defer(conn: &Connection, task_id: i32) {
            conn.execute(
                "UPDATE tasks SET execute_requested_at = '2026-01-01T00:00:00Z' WHERE id = ?1",
                [task_id],
            )
            .expect("defer the task");
        }

        /// The phase a claim took the task from is stored, and survives to the failed start.
        #[test]
        fn a_failed_handoff_in_review_can_be_claimed_again() {
            let (conn, task_id) = db_with_task();
            always(&conn, task_id, TaskTransition::ReviewFinished);
            always(
                &conn,
                task_id,
                TaskTransition::TurnCompleted {
                    is_git_repo: true,
                    has_changes: Some(true),
                    reviewer_pending: true,
                },
            );
            claim(&conn, task_id, &USER_COLUMNS).expect("the hand-off is claimed");
            assert_eq!(
                state(&conn, task_id).claimed_from,
                Some(TaskPhase::SelfReview)
            );
            when_spawning(&conn, task_id, TaskTransition::PhaseFailed).expect("fail");
            let failed = state(&conn, task_id);
            assert_eq!(
                (failed.status, failed.phase, failed.phase_status),
                (
                    TaskStatus::Review,
                    Some(TaskPhase::SelfReview),
                    Some(PhaseStatus::Failed)
                )
            );
            claim(&conn, task_id, &USER_COLUMNS).expect("and claimed again");
        }

        #[test]
        fn a_deferral_lives_exactly_as_long_as_the_task_is_a_candidate() {
            let (conn, task_id) = db_with_task();
            defer(&conn, task_id);
            claim(&conn, task_id, &[TaskStatus::Queue]).expect("claim");
            assert_eq!(request_marker(&conn, task_id), None, "claiming clears it");

            // An aborted spawn parks it back in Queue, and it is still owed a slot.
            defer(&conn, task_id);
            when_spawning(&conn, task_id, TaskTransition::SpawnAborted).expect("abort");
            assert!(request_marker(&conn, task_id).is_some());

            always(
                &conn,
                task_id,
                TaskTransition::ManualMove(TaskStatus::Planning),
            );
            assert_eq!(
                request_marker(&conn, task_id),
                None,
                "leaving the queue clears it"
            );
        }

        /// A turn landing after the task was parked is ignored, but one ending in Planning, where
        /// a refiner works, still applies.
        #[test]
        fn the_active_guard_tells_a_parked_task_from_a_refining_one() {
            let (conn, task_id) = db_with_task();
            start_execution(&conn, task_id);
            always(&conn, task_id, TaskTransition::Stopped);
            let before = state(&conn, task_id);
            assert!(guarded(
                &conn,
                task_id,
                turn(Some(true), false),
                TransitionGuard::Active
            )
            .is_none());
            assert_eq!(state(&conn, task_id), before);

            claim(&conn, task_id, &[TaskStatus::Planning]).expect("claim");
            when_spawning(
                &conn,
                task_id,
                TaskTransition::SessionReady(AgentRole::Refiner),
            )
            .expect("ready");
            assert!(guarded(&conn, task_id, turn(None, false), TransitionGuard::Active).is_some());
            assert_eq!(
                state(&conn, task_id),
                TaskState::active(
                    TaskStatus::Planning,
                    TaskPhase::Refining,
                    PhaseStatus::Waiting,
                    TaskBall::User
                )
            );
        }

        #[test]
        fn the_changed_guard_skips_a_no_op_write() {
            let (conn, task_id) = db_with_task();
            start_execution(&conn, task_id);
            always(&conn, task_id, TaskTransition::AwaitingUserInput);
            assert!(guarded(
                &conn,
                task_id,
                TaskTransition::AwaitingUserInput,
                TransitionGuard::Changed
            )
            .is_none());
        }

        #[test]
        fn the_blocked_guard_only_touches_blocked_tasks() {
            let (conn, task_id) = db_with_task();
            start_execution(&conn, task_id);
            always(&conn, task_id, TaskTransition::AwaitingUserInput);
            let unblock = |conn: &Connection| {
                guarded(
                    conn,
                    task_id,
                    TaskTransition::Unblocked,
                    TransitionGuard::Blocked,
                )
            };
            assert!(unblock(&conn).is_some());
            assert_eq!(state(&conn, task_id), implementing());

            always(&conn, task_id, turn(Some(true), false));
            let before = state(&conn, task_id);
            assert!(unblock(&conn).is_none());
            assert_eq!(state(&conn, task_id), before);
        }

        #[test]
        fn the_phase_guard_ends_a_self_review_only_while_it_is_one() {
            let (conn, task_id) = db_with_task();
            start_execution(&conn, task_id);
            let end = |conn: &Connection| {
                guarded(
                    conn,
                    task_id,
                    TaskTransition::ReviewFinished,
                    TransitionGuard::Phase(TaskPhase::SelfReview),
                )
            };
            assert!(end(&conn).is_none());
            always(
                &conn,
                task_id,
                TaskTransition::SessionReady(AgentRole::Reviewer),
            );
            assert_eq!(end(&conn).expect("ended").phase, Some(TaskPhase::Approval));
        }

        #[test]
        fn a_dying_session_fails_only_a_running_or_blocked_phase() {
            let fail = |conn: &Connection, task_id: i32| {
                guarded(
                    conn,
                    task_id,
                    TaskTransition::PhaseFailed,
                    TransitionGuard::AgentRunning,
                )
            };
            for setup in [
                TaskTransition::SessionReady(AgentRole::Coder),
                TaskTransition::AwaitingUserInput,
            ] {
                let (conn, task_id) = db_with_task();
                start_execution(&conn, task_id);
                always(&conn, task_id, setup);
                assert!(fail(&conn, task_id).is_some(), "for {setup:?}");
                let failed = state(&conn, task_id);
                assert_eq!(failed.phase_status, Some(PhaseStatus::Failed));
                assert_eq!(
                    failed.status,
                    TaskStatus::InProgress,
                    "the card must not move"
                );
            }
            for terminal in [
                TaskTransition::Merged,
                TaskTransition::Stopped,
                turn(Some(true), false),
            ] {
                let (conn, task_id) = db_with_task();
                start_execution(&conn, task_id);
                always(&conn, task_id, terminal);
                let before = state(&conn, task_id);
                assert!(fail(&conn, task_id).is_none(), "for {terminal:?}");
                assert_eq!(state(&conn, task_id), before);
            }
        }

        /// The sweep decides every three minutes for as long as a closed pull request sits there,
        /// so only the first decision may write.
        #[test]
        fn a_closed_pull_request_is_closed_once() {
            let (conn, task_id) = db_with_task();
            start_execution(&conn, task_id);
            always(&conn, task_id, TaskTransition::PullRequestOpened);
            let close = |conn: &Connection| {
                guarded(
                    conn,
                    task_id,
                    TaskTransition::PullRequestClosed,
                    TransitionGuard::Changed,
                )
            };
            assert!(close(&conn).is_some());
            let closed = state(&conn, task_id);
            assert!(close(&conn).is_none());
            assert_eq!(state(&conn, task_id), closed);
        }

        /// A CI-fix coder that claimed the task between the sweep's read and its write keeps it.
        #[test]
        fn the_forge_does_not_move_a_task_a_coder_claimed() {
            let (conn, task_id) = db_with_task();
            start_execution(&conn, task_id);
            always(&conn, task_id, TaskTransition::PullRequestOpened);
            always(&conn, task_id, TaskTransition::CiFixRequested);
            let claimed = state(&conn, task_id);
            assert_eq!(claimed.ball, TaskBall::Agent);
            for (event, ball) in [
                (TaskTransition::PullRequestConflicted, TaskBall::External),
                (TaskTransition::PullRequestMergeable, TaskBall::User),
            ] {
                assert!(guarded(&conn, task_id, event, TransitionGuard::Ball(ball)).is_none());
                assert_eq!(state(&conn, task_id), claimed, "for {event:?}");
            }

            let (conn, task_id) = db_with_task();
            start_execution(&conn, task_id);
            always(&conn, task_id, TaskTransition::PullRequestOpened);
            let conflict = |conn: &Connection| {
                guarded(
                    conn,
                    task_id,
                    TaskTransition::PullRequestConflicted,
                    TransitionGuard::Ball(TaskBall::External),
                )
            };
            assert!(conflict(&conn).is_some());
            assert_eq!(state(&conn, task_id).ball, TaskBall::User);
        }
    }
}
