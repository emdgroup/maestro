//! The single place a task's lifecycle fields are written.
//!
//! `status`, `phase`, `phase_status` and `ball` are correlated: a task in Review awaiting a
//! human is `(Review, Approval, Waiting, User)`, and no other combination of those four is
//! meaningful. Before this module the status alone was written from ten different call sites
//! with hand-rolled SQL, which is how `reject_review` came to write a status string that no
//! `TaskStatus` variant matches. Four correlated fields written that way would not survive.
//!
//! So callers do not set fields. They report what happened — `Merged`, `MergeConflict`,
//! `AwaitingUserInput` — and `resolve` decides what that means. It is a pure function, so the
//! whole lifecycle is testable without a database.

use chrono::Utc;
use rusqlite::Connection;

use crate::models::{
    PhaseStatus, Task, TaskBall, TaskCompletion, TaskPhase, TaskStatus, TASK_SELECT,
};
use crate::project::profiles::AgentRole;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TaskState {
    pub status: TaskStatus,
    pub phase: Option<TaskPhase>,
    pub phase_status: Option<PhaseStatus>,
    pub ball: TaskBall,
    pub completion: Option<TaskCompletion>,
}

impl TaskState {
    /// No pipeline activity: parked in a column with nothing running and nobody blocked.
    ///
    /// Clears `completion` as well, so a task dragged out of Done cannot keep claiming it merged.
    fn parked(status: TaskStatus) -> Self {
        TaskState {
            status,
            phase: None,
            phase_status: None,
            ball: TaskBall::None,
            completion: None,
        }
    }

    /// Parked at Done, recording how it got there.
    fn done(completion: Option<TaskCompletion>) -> Self {
        TaskState { completion, ..TaskState::parked(TaskStatus::Done) }
    }

    fn active(status: TaskStatus, phase: TaskPhase, phase_status: PhaseStatus, ball: TaskBall) -> Self {
        TaskState {
            status,
            phase: Some(phase),
            phase_status: Some(phase_status),
            ball,
            completion: None,
        }
    }
}

/// Something that happened to a task, not a state to move it to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskTransition {
    /// The user dragged the card or picked a status directly.
    ManualMove(TaskStatus),
    /// The task has been claimed and a session is being spawned for it.
    ///
    /// This does *not* move the task to In Progress. The claim and the start are separate events
    /// because spawning can fail, and a task that never reached an agent belongs in the queue it
    /// was taken from, not in a column implying work happened.
    ExecutionStarted,
    /// The session is up and the agent is working.
    ///
    /// The role is what says *where* that leaves the task, and holding the mapping here rather
    /// than at the four spawn sites is what keeps "a refiner works in Planning, a coder in In
    /// Progress" a single fact rather than four.
    SessionReady(AgentRole),
    /// The spawn was abandoned before the session came up — the user cancelled at a prompt.
    ///
    /// Distinct from `PhaseFailed`, which leaves a red card for a failure the user has to look at.
    /// Cancelling is not a failure, so the task simply goes back to being parked where it was.
    SpawnAborted,
    /// The agent stopped mid-phase and needs an answer to continue.
    AwaitingUserInput,
    /// That answer arrived, or the turn resumed some other way.
    Unblocked,
    /// The agent ended its turn.
    ///
    /// Where that lands depends on which phase ended — a planner finishing means "plan ready",
    /// not "work done" — and on whether anything actually changed.
    ///
    /// `has_changes` is deliberately three-valued. `Some(false)` is the only value that routes a
    /// task to Done without review; `None` means the question could not be answered (no repo, no
    /// worktree, a failed git call) and must fall through to review, because silently closing a
    /// task on missing evidence is the one outcome with no way back.
    ///
    /// `reviewer_pending` says a review agent should look at the work before the user does. It is
    /// an input rather than something `resolve` can decide, because it depends on the project's
    /// profiles and on how many rounds the loop has already spent.
    TurnCompleted { is_git_repo: bool, has_changes: Option<bool>, reviewer_pending: bool },
    /// The review agent finished and the task goes to the human gate.
    ///
    /// One event for approval and for hitting the round cap, because they leave the task in the
    /// same place: a person now decides. Which of the two happened is in the outcome thread.
    ReviewFinished,
    /// The review agent asked for changes and the loop has rounds left.
    ///
    /// The ball goes to `Agent`, not `User` — that is what separates this from the user's own
    /// rework request, and it is what tells the board to start a coder without being asked.
    ReviewRejected,
    /// A role held in a read-only mode delivered its artifact and was stopped at that point.
    ///
    /// Not a turn ending, which is why it is not `TurnCompleted`. An agent held in plan mode has
    /// no way to say "I am finished" other than asking to leave plan mode — that request *is* the
    /// artifact, and it arrives mid-turn. Granting it would hand a read-only role write access
    /// (which is how a planner once implemented its own task); refusing it just makes the agent
    /// polish the plan and ask again. So the board takes the plan, refuses the request, and
    /// interrupts the turn.
    ArtifactDelivered,
    /// The user stopped the running session.
    Stopped,
    /// The user answered the refiner's proposal gate.
    ///
    /// One event for both answers, because they leave the task in the same place: the difference
    /// between accepting and rejecting is whether the description was replaced, and a description
    /// is not a lifecycle field.
    RefinementClosed,
    /// Review feedback was recorded and the task goes back for another pass.
    ReworkRequested,
    /// A merge was attempted and conflicted.
    MergeConflict,
    /// The branch merged cleanly.
    Merged,
    /// The user approved the work but chose to commit it without merging, keeping the worktree.
    ///
    /// Lands in the same column as `Merged`, but with a different completion qualifier: the
    /// changes were never merged and the worktree is still holding them, which is the one Done
    /// variant that carries unfinished business.
    ApprovedWithoutMerge,
    /// The user approved the work and a pull request was opened for it.
    ///
    /// The one approve path that does not land the task: the work is not in the base branch until
    /// somebody merges the PR, and that somebody is not Maestro. So the task stays in Review with
    /// the ball on `External` — neither the user nor an agent has anything to do until the forge
    /// says otherwise.
    PullRequestOpened,
    /// The forge says the pull request merged.
    PullRequestMerged,
    /// The forge says the pull request was closed without merging.
    ///
    /// An error state rather than a route back: the reasons a PR gets closed — superseded,
    /// rejected, reopened elsewhere — have no common answer, and guessing one is how a task ends
    /// up quietly restarted. The card turns red where it stands and the user decides.
    PullRequestClosed,
    /// The forge says the open pull request no longer merges cleanly.
    ///
    /// Amber, not red. `PullRequestClosed` is the red one and it means the pull request is gone;
    /// this one means it is still there and still wanted, and somebody has to rebase it. Same
    /// phase, ball on the user, `Waiting` rather than `Failed` — which is also what makes the
    /// state legible without storing it: at `AwaitingMerge`, `Waiting` with the ball on the user
    /// is this and nothing else.
    PullRequestConflicted,
    /// The conflict cleared and the pull request is back with the forge.
    ///
    /// Lands where `PullRequestOpened` does, and is a separate event for the same reason
    /// `CiFixPushed` is: what `resolve` returns is not what happened.
    PullRequestMergeable,
    /// CI on the open pull request failed and an agent is being sent to fix it.
    ///
    /// Stays at `AwaitingMerge` rather than going back to In Progress: the pull request is still
    /// open and the branch still its head, so the fix is pushed to what exists rather than being
    /// re-approved into a second one.
    CiFixRequested,
    /// The fixing agent finished and its work is back on the pull request.
    CiFixPushed,
    /// The user discarded the work but kept the task.
    Discarded,
    /// The task was abandoned.
    Cancelled,
    /// The current phase errored — a spawn failure, a dead session.
    PhaseFailed,
}

/// Decide the new state from what happened and where the task currently is.
///
/// Events that describe the agent rather than the task — `AwaitingUserInput`, `Unblocked`,
/// `PhaseFailed` — deliberately keep the current `status` and `phase`. A permission prompt
/// during implementation must not move the card; it only changes who is waiting.
pub fn resolve(event: TaskTransition, current: TaskState) -> TaskState {
    use PhaseStatus::*;
    use TaskBall as Ball;
    use TaskPhase::*;
    use TaskStatus::*;

    match event {
        TaskTransition::ManualMove(status) => TaskState::parked(status),

        // Keeps its column. The task is claimed but nothing is running yet, so moving it would
        // announce work that has not started and, if the spawn fails, strand it somewhere it was
        // never queued from. Execute is offered from Planning as well as Queue, and a failure
        // belongs back where the user launched it.
        TaskTransition::ExecutionStarted => TaskState {
            phase: Some(Spawning),
            phase_status: Some(Running),
            ball: Ball::Agent,
            completion: None,
            ..current
        },

        // The role → phase table. A refiner sharpens a ticket in the backlog and never leaves it;
        // a planner and a coder both work inside In Progress but at different gates; a reviewer
        // reads a diff, which only exists once the work is in Review.
        TaskTransition::SessionReady(role) => match role {
            // A coder starting on a task that is already in Review is fixing the build on an open
            // pull request, not starting the work over. Sending it to In Progress would detach it
            // from the pull request its commits are about to be pushed to, and the turn-ended
            // handler gates the push on the phase, so the fix would never reach the forge.
            //
            // The test is the *column*, not the phase, because the phase is already gone by the
            // time this runs: every start goes through `ExecutionStarted` first, which overwrites
            // `phase` with `Spawning`. It leaves `status` alone — deliberately, so a failed spawn
            // stays where the user launched it — and that is the only part of the claim that still
            // remembers where the task came from. Reading `phase` here matched only when called
            // directly, which is to say only from the tests.
            //
            // Review is unambiguous for a coder: both routes back from a review, `ReviewRejected`
            // and `ReworkRequested`, land at `InProgress/Rework`, and Execute is not offered on a
            // Review card.
            AgentRole::Coder if current.status == Review => {
                TaskState::active(Review, AwaitingMerge, Running, Ball::Agent)
            }
            AgentRole::Refiner => TaskState::active(Planning, Refining, Running, Ball::Agent),
            AgentRole::Planner => TaskState::active(InProgress, Drafting, Running, Ball::Agent),
            AgentRole::Coder => TaskState::active(InProgress, Implementing, Running, Ball::Agent),
            AgentRole::Reviewer => TaskState::active(Review, SelfReview, Running, Ball::Agent),
        },

        TaskTransition::SpawnAborted => TaskState::parked(current.status),

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

        TaskTransition::ReviewRejected => TaskState::active(InProgress, Rework, Waiting, Ball::Agent),

        // The same two destinations `TurnCompleted` gives these phases, reached by the other route
        // a read-only role can finish by. Anything else keeps its state: the event is only ever
        // raised from a read-only phase, and a task that has moved on since must not be dragged
        // back to a gate by a request still in flight.
        TaskTransition::ArtifactDelivered => match current.phase {
            Some(Drafting) => TaskState::active(InProgress, PlanReview, Waiting, Ball::User),
            Some(Refining) => TaskState::active(Planning, Refining, Waiting, Ball::User),
            _ => current,
        },

        TaskTransition::TurnCompleted { is_git_repo, has_changes, reviewer_pending } => match current.phase {
            // A planner ending its turn has produced a plan, not an implementation. The gate is
            // inside In Progress — it is not the Review column, which reviews a diff.
            Some(Drafting) => TaskState::active(InProgress, PlanReview, Waiting, Ball::User),

            // The refiner's gate has no phase of its own: Planning runs one role, so `Refining`
            // with nothing running is unambiguously "a proposal is waiting for you".
            Some(Refining) => TaskState::active(Planning, Refining, Waiting, Ball::User),

            // Without a repo there is nothing to review, so the task is simply finished. No
            // completion qualifier: merged, local-only and no-changes all describe a git
            // repository, and none of them is true here.
            _ if !is_git_repo => TaskState::done(None),

            // Demonstrably nothing changed. Review would open an empty diff and In Progress would
            // strand the task, so Done says what happened and the outcome thread says why.
            _ if has_changes == Some(false) => TaskState::done(Some(TaskCompletion::NoChanges)),

            // A review agent is going to look first. `Waiting` with the ball on the agent is the
            // board asking for one to be started — the same shape the queue uses, since only the
            // frontend can spawn a session.
            _ if reviewer_pending => TaskState::active(Review, SelfReview, Waiting, Ball::Agent),

            _ => TaskState::active(Review, Approval, Waiting, Ball::User),
        },

        TaskTransition::Stopped => TaskState::parked(Planning),

        TaskTransition::RefinementClosed => TaskState::parked(Planning),

        TaskTransition::ReworkRequested => {
            TaskState::active(InProgress, Rework, Waiting, Ball::User)
        }

        // A conflict is a failure the user has to resolve, not a fresh rework request.
        TaskTransition::MergeConflict => {
            TaskState::active(InProgress, Rework, Failed, Ball::User)
        }

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

        // There is no Backlog column; discarding returns the task to Planning.
        TaskTransition::Discarded => TaskState::parked(Planning),

        TaskTransition::Cancelled => TaskState::parked(TaskStatus::Cancelled),

        TaskTransition::PhaseFailed => TaskState {
            phase_status: Some(Failed),
            ball: Ball::User,
            ..current
        },
    }
}

fn read_state(conn: &Connection, task_id: i32) -> Result<TaskState, String> {
    conn.query_row(
        "SELECT status, phase, phase_status, ball, completion FROM tasks WHERE id = ?",
        [task_id],
        |row| {
            let status: String = row.get(0)?;
            let phase: Option<String> = row.get(1)?;
            let phase_status: Option<String> = row.get(2)?;
            let ball: String = row.get(3)?;
            let completion: Option<String> = row.get(4)?;
            Ok(TaskState {
                status: status.parse().unwrap_or(TaskStatus::Planning),
                phase: phase.and_then(|s| s.parse().ok()),
                phase_status: phase_status.and_then(|s| s.parse().ok()),
                ball: ball.parse().unwrap_or(TaskBall::None),
                completion: completion.and_then(|s| s.parse().ok()),
            })
        },
    )
    .map_err(|e| format!("Failed to read task {} state: {}", task_id, e))
}

/// Apply a transition and return the updated task.
///
/// Takes a `&Connection` rather than `AppState` so callers keep control of their own locking:
/// several of them hold the database mutex across a carefully scoped block, or run inside a
/// transaction, and must not be forced to reacquire it here.
pub fn apply(conn: &Connection, task_id: i32, event: TaskTransition) -> Result<Task, String> {
    apply_if_status(conn, task_id, None, event)?
        .ok_or_else(|| format!("Task {} not found", task_id))
}

/// Apply a transition only if the task is currently in one of `expected`, returning `None` when
/// it is not.
///
/// Three callers need this. The turn-ended handler runs on a background task and must not
/// complete a task the user has since stopped; the PTY spawn path must only claim a task that is
/// still queued; and the ACP execute path must only claim one the user has not dragged away
/// mid-spawn. The first two previously expressed it as `AND status = '...'` in their own UPDATE.
///
/// A slice rather than a single status because execution can be started from either column a
/// task can sit in before it runs.
pub fn apply_if_status(
    conn: &Connection,
    task_id: i32,
    expected: Option<&[TaskStatus]>,
    event: TaskTransition,
) -> Result<Option<Task>, String> {
    let current = read_state(conn, task_id)?;

    if let Some(expected) = expected {
        if !expected.contains(&current.status) {
            return Ok(None);
        }
    }

    let next = resolve(event, current);
    let now = Utc::now().to_rfc3339();

    // A deferral is a promise to a task the scheduler has not picked up yet, so it is only
    // meaningful while the task is still one of its candidates — parked in Queue. Tying the marker
    // to that condition here means it cannot outlive its meaning: being claimed clears it, and so
    // does the user dragging the card somewhere else, which is them withdrawing the request.
    let keep_request = next.status == TaskStatus::Queue && next.phase.is_none();

    conn.execute(
        "UPDATE tasks SET status = ?, phase = ?, phase_status = ?, ball = ?, completion = ?, \
         execute_requested_at = CASE WHEN ? THEN execute_requested_at ELSE NULL END, \
         updated_at = ? WHERE id = ?",
        rusqlite::params![
            next.status.as_str(),
            next.phase.map(TaskPhase::as_str),
            next.phase_status.map(PhaseStatus::as_str),
            next.ball.as_str(),
            next.completion.map(TaskCompletion::as_str),
            keep_request,
            &now,
            task_id,
        ],
    )
    .map_err(|e| format!("Failed to apply transition to task {}: {}", task_id, e))?;

    let query = format!("{} WHERE id = ?", TASK_SELECT);
    conn.query_row(&query, [task_id], Task::from_row)
        .map(Some)
        .map_err(|e| format!("Failed to read back task {}: {}", task_id, e))
}

/// Claim a task for execution, refusing one that is not in `expected` or is already being spawned.
///
/// The phase guard is the one `apply_if_status` cannot express: a claimed task keeps its column, so
/// status alone cannot tell "queued" from "already starting". Without it, a second Execute click —
/// or a manual click racing the auto-mode drain — builds a second session for one task and orphans
/// the first.
///
/// A *failed* spawn is claimable, because it is the retry. The claim is kept on failure so the card
/// can show what happened, which would otherwise make the failure state a dead end.
///
/// A **handoff** — one role finishing and the board asking for the next — bypasses `expected`
/// entirely. That list describes the columns a *user* may press Execute from, and a handoff is not
/// a user pressing anything: the phase already names the role about to start, and it pins the column
/// far more precisely than the list does. Checking the list anyway is what killed every one of them.
/// A reviewer works in Review and the caller only ever listed Planning, Queue and In Progress, so
/// `useAgentPipeline` asked for a reviewer on every board update and was refused every time — the
/// review loop, the rework round and the red-build fix could not start at all, and the task sat at
/// `SelfReview/Waiting` with nothing left to move it.
pub fn claim_for_execution(
    conn: &Connection,
    task_id: i32,
    expected: &[TaskStatus],
) -> Result<Option<Task>, String> {
    let current = read_state(conn, task_id)?;

    // `Approval` is the one Waiting phase deliberately absent: what waits there is a person choosing
    // how to land the work, not a role to spawn.
    let handoff = matches!(
        (current.phase, current.phase_status),
        (
            Some(TaskPhase::SelfReview | TaskPhase::Rework | TaskPhase::AwaitingMerge),
            Some(PhaseStatus::Waiting)
        )
    );

    let claimable = handoff
        || match (current.phase, current.phase_status) {
            (None, _) => true,
            (Some(TaskPhase::Spawning), Some(PhaseStatus::Failed)) => true,
            // The plan gate is a handover, not a resting place: approving the plan is what starts
            // the coder, so the gate has to be claimable even though the task already has a phase.
            (Some(TaskPhase::PlanReview), Some(PhaseStatus::Waiting)) => true,
            _ => false,
        };

    if !claimable || (!handoff && !expected.contains(&current.status)) {
        return Ok(None);
    }

    // Still through `ExecutionStarted`, so the phase becomes `Spawning` and a second attempt finds
    // a state that is neither a handoff nor otherwise claimable. That is what keeps one handoff from
    // building two sessions while the first is still coming up.
    apply(conn, task_id, TaskTransition::ExecutionStarted).map(Some)
}

/// Apply a transition only to a task still sitting in the `Spawning` phase.
///
/// Everything that finishes a spawn goes through here, so that a spawn landing after the user
/// already stopped or moved the task cannot resurrect it. `Failed` counts as still spawning: a
/// retry of a failed spawn has to be able to succeed.
pub fn apply_if_spawning(
    conn: &Connection,
    task_id: i32,
    event: TaskTransition,
) -> Result<Option<Task>, String> {
    if read_state(conn, task_id)?.phase != Some(TaskPhase::Spawning) {
        return Ok(None);
    }
    apply(conn, task_id, event).map(Some)
}

/// Apply a transition only while the task still has a live phase.
///
/// The guard a turn ending needs. It runs on a detached task, so by the time it lands the user may
/// have stopped the session, dragged the card away or approved the work — and every one of those
/// leaves the task parked, with no phase. Guarding on the *column* instead cannot express this:
/// each role works in a different one, and Planning is both where a refiner runs and where a
/// stopped task is parked.
pub fn apply_if_active(
    conn: &Connection,
    task_id: i32,
    event: TaskTransition,
) -> Result<Option<Task>, String> {
    if read_state(conn, task_id)?.phase.is_none() {
        return Ok(None);
    }
    apply(conn, task_id, event).map(Some)
}

/// Apply a transition only when it would actually change the stored state.
///
/// Permission requests arrive constantly with auto-approve off, and each write emits
/// `tasks-changed`, which refetches the whole board. Skipping no-op writes keeps that quiet.
pub fn apply_if_changed(
    conn: &Connection,
    task_id: i32,
    event: TaskTransition,
) -> Result<Option<Task>, String> {
    let current = read_state(conn, task_id)?;
    if resolve(event, current) == current {
        return Ok(None);
    }
    apply(conn, task_id, event).map(Some)
}

/// Clear a `Blocked` phase, doing nothing if the task is not blocked.
///
/// The guard matters: a bare `Unblocked` would also rewrite a task parked at a `Waiting` gate
/// into `Running`, inventing an agent that is not there.
pub fn clear_blocked(conn: &Connection, task_id: i32) -> Result<Option<Task>, String> {
    if read_state(conn, task_id)?.phase_status != Some(PhaseStatus::Blocked) {
        return Ok(None);
    }
    apply(conn, task_id, TaskTransition::Unblocked).map(Some)
}

/// Mark the phase failed if the pipeline still believes an agent is working on the task.
///
/// Called when a session's reader ends. If the task already moved on under its own power —
/// merged, stopped, parked at a review gate — `phase_status` is no longer `Running` or `Blocked`
/// and this does nothing. What it catches is the session dying mid-phase, which previously left
/// the card looking identical to a healthy one after a reload, and would now otherwise leave a
/// blocked card pulsing forever.
pub fn fail_if_agent_running(conn: &Connection, task_id: i32) -> Result<Option<Task>, String> {
    match read_state(conn, task_id)?.phase_status {
        Some(PhaseStatus::Running | PhaseStatus::Blocked) => {
            apply(conn, task_id, TaskTransition::PhaseFailed).map(Some)
        }
        _ => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The permission path reads the phase to decide whether the agent it is about to answer for is
    /// allowed to write, so this mapping is what stands between `auto_approve` and a read-only role
    /// being let out of read-only. A phase added to the pipeline without a line here defaults to
    /// writable, which is the wrong way round — hence pinning the whole set rather than a sample.
    #[test]
    fn exactly_the_three_read_only_phases_are_read_only() {
        for phase in [TaskPhase::Refining, TaskPhase::Drafting, TaskPhase::SelfReview] {
            assert!(phase.is_read_only(), "{phase:?} should be read-only");
        }
        for phase in [
            TaskPhase::Spawning,
            TaskPhase::PlanReview,
            TaskPhase::Implementing,
            TaskPhase::Rework,
            TaskPhase::Approval,
            TaskPhase::AwaitingMerge,
        ] {
            assert!(!phase.is_read_only(), "{phase:?} should not be read-only");
        }
    }

    /// A plan-mode agent's request to leave plan mode is the only "I am finished" it has, so it
    /// must reach the same gate a turn ending would. The two destinations are duplicated from
    /// `TurnCompleted` deliberately — this arrives mid-turn and cannot carry a turn's evidence —
    /// and a drift between them would strand one route at a gate the other does not use.
    #[test]
    fn a_delivered_artifact_reaches_the_same_gate_a_finished_turn_would() {
        for (phase, status) in [(TaskPhase::Drafting, TaskStatus::InProgress), (
            TaskPhase::Refining,
            TaskStatus::Planning,
        )] {
            let running = TaskState::active(status, phase, PhaseStatus::Running, TaskBall::Agent);
            let delivered = resolve(TaskTransition::ArtifactDelivered, running.clone());
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

    /// The request can land after the user has already moved the task — stopped it, answered the
    /// gate — and a late one must not drag it back.
    #[test]
    fn a_delivered_artifact_does_not_move_a_task_that_left_its_read_only_phase() {
        let elsewhere = implementing();
        assert_eq!(
            resolve(TaskTransition::ArtifactDelivered, elsewhere.clone()),
            elsewhere
        );
    }

    /// `TaskPhase::is_read_only` and `AgentRole::is_read_only` are two spellings of one rule, and a
    /// disagreement between them would put an agent in a phase whose permissions do not match the
    /// profile it was resolved from.
    #[test]
    fn the_phase_and_role_read_only_rules_agree() {
        let pairs = [
            (TaskPhase::Refining, AgentRole::Refiner),
            (TaskPhase::Drafting, AgentRole::Planner),
            (TaskPhase::SelfReview, AgentRole::Reviewer),
            (TaskPhase::Implementing, AgentRole::Coder),
            (TaskPhase::Rework, AgentRole::Coder),
            (TaskPhase::AwaitingMerge, AgentRole::Coder),
        ];
        for (phase, role) in pairs {
            assert_eq!(phase.is_read_only(), role.is_read_only(), "{phase:?} vs {role:?}");
        }
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
        TaskState::active(status, TaskPhase::Spawning, PhaseStatus::Running, TaskBall::Agent)
    }

    /// The claim must not move the card. Announcing In Progress before a session exists is what
    /// left a failed spawn stranded in a column it was never queued from.
    #[test]
    fn a_claim_marks_the_task_spawning_without_moving_it() {
        for status in [TaskStatus::Planning, TaskStatus::Queue] {
            let next = resolve(TaskTransition::ExecutionStarted, TaskState::parked(status));
            assert_eq!(next, spawning(status));
        }
    }

    #[test]
    fn session_ready_hands_the_ball_to_the_agent_in_progress() {
        let next = resolve(TaskTransition::SessionReady(AgentRole::Coder), spawning(TaskStatus::Queue));
        assert_eq!(next, implementing());
    }

    /// Every role starts from the same claim and lands somewhere different. Getting this wrong is
    /// invisible at the spawn site and catastrophic on the board — a refiner that moved its task to
    /// In Progress would have the backlog running the pipeline.
    #[test]
    fn each_role_lands_in_its_own_column_and_phase() {
        let expected = [
            (AgentRole::Refiner, TaskStatus::Planning, TaskPhase::Refining),
            (AgentRole::Planner, TaskStatus::InProgress, TaskPhase::Drafting),
            (AgentRole::Coder, TaskStatus::InProgress, TaskPhase::Implementing),
            (AgentRole::Reviewer, TaskStatus::Review, TaskPhase::SelfReview),
        ];

        for (role, status, phase) in expected {
            let next = resolve(
                TaskTransition::SessionReady(role),
                spawning(TaskStatus::Planning),
            );
            assert_eq!(
                next,
                TaskState::active(status, phase, PhaseStatus::Running, TaskBall::Agent),
                "for {:?}",
                role
            );
        }
    }

    /// Both answers to the gate leave the task parked in the backlog. What differs is whether the
    /// description was replaced, which happens outside the transition.
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

    /// A cancelled spawn is not a failure, so it parks the task back where it was rather than
    /// leaving a red card the user has to dismiss.
    #[test]
    fn an_aborted_spawn_parks_the_task_where_it_started() {
        for status in [TaskStatus::Planning, TaskStatus::Queue] {
            let next = resolve(TaskTransition::SpawnAborted, spawning(status));
            assert_eq!(next, TaskState::parked(status));
        }
    }

    /// The errored-in-queue state, which is an ordinary active row rather than an exception to
    /// the phase invariant.
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
        let next = resolve(TaskTransition::ManualMove(TaskStatus::Queue), implementing());
        assert_eq!(next, TaskState::parked(TaskStatus::Queue));
    }

    /// The card must not move when an agent stops to ask something — only the ball changes.
    #[test]
    fn awaiting_input_preserves_status_and_phase() {
        let next = resolve(TaskTransition::AwaitingUserInput, implementing());
        assert_eq!(next.status, TaskStatus::InProgress);
        assert_eq!(next.phase, Some(TaskPhase::Implementing));
        assert_eq!(next.phase_status, Some(PhaseStatus::Blocked));
        assert_eq!(next.ball, TaskBall::User);
    }

    #[test]
    fn unblocked_reverses_awaiting_input() {
        let blocked = resolve(TaskTransition::AwaitingUserInput, implementing());
        assert_eq!(resolve(TaskTransition::Unblocked, blocked), implementing());
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
    fn turn_completed_routes_on_whether_there_is_a_repo() {
        let with_repo = resolve(
            TaskTransition::TurnCompleted { is_git_repo: true, has_changes: Some(true), reviewer_pending: false },
            implementing(),
        );
        assert_eq!(
            with_repo,
            TaskState::active(
                TaskStatus::Review,
                TaskPhase::Approval,
                PhaseStatus::Waiting,
                TaskBall::User
            )
        );

        // No repository means none of the completion qualifiers describe anything real.
        let without_repo = resolve(
            TaskTransition::TurnCompleted { is_git_repo: false, has_changes: None, reviewer_pending: false },
            implementing(),
        );
        assert_eq!(without_repo, TaskState::parked(TaskStatus::Done));
        assert_eq!(without_repo.completion, None);
    }

    /// An agent that finished having changed nothing is done, not stuck: review would open an
    /// empty diff and In Progress would strand it.
    #[test]
    fn a_turn_that_changed_nothing_completes_as_no_changes() {
        let next = resolve(
            TaskTransition::TurnCompleted { is_git_repo: true, has_changes: Some(false), reviewer_pending: false },
            implementing(),
        );
        assert_eq!(next.status, TaskStatus::Done);
        assert_eq!(next.completion, Some(TaskCompletion::NoChanges));
    }

    /// The asymmetry that matters: unknown is not the same as none. Closing a task on missing
    /// evidence is the one outcome with no way back, so it goes to review instead.
    #[test]
    fn an_unanswerable_change_check_routes_to_review() {
        let next = resolve(
            TaskTransition::TurnCompleted { is_git_repo: true, has_changes: None, reviewer_pending: false },
            implementing(),
        );
        assert_eq!(next.status, TaskStatus::Review);
    }

    /// A planner ending its turn produced a plan, not an implementation, so it must not land in
    /// the column that reviews a diff.
    #[test]
    fn a_finished_plan_lands_at_the_plan_gate_not_review() {
        let drafting = TaskState::active(
            TaskStatus::InProgress,
            TaskPhase::Drafting,
            PhaseStatus::Running,
            TaskBall::Agent,
        );

        let next = resolve(
            TaskTransition::TurnCompleted { is_git_repo: true, has_changes: Some(true), reviewer_pending: false },
            drafting,
        );
        assert_eq!(
            next,
            TaskState::active(
                TaskStatus::InProgress,
                TaskPhase::PlanReview,
                PhaseStatus::Waiting,
                TaskBall::User
            )
        );
    }

    /// Refinement happens in the backlog and produces a proposal. Finishing it must not push the
    /// task into the pipeline.
    #[test]
    fn a_finished_refinement_waits_in_planning() {
        let refining = TaskState::active(
            TaskStatus::Planning,
            TaskPhase::Refining,
            PhaseStatus::Running,
            TaskBall::Agent,
        );

        let next = resolve(
            TaskTransition::TurnCompleted { is_git_repo: true, has_changes: None, reviewer_pending: false },
            refining,
        );
        assert_eq!(
            next,
            TaskState::active(
                TaskStatus::Planning,
                TaskPhase::Refining,
                PhaseStatus::Waiting,
                TaskBall::User
            )
        );
    }

    #[test]
    fn rework_lands_in_progress_waiting_on_the_user() {
        let expected = TaskState::active(
            TaskStatus::InProgress,
            TaskPhase::Rework,
            PhaseStatus::Waiting,
            TaskBall::User,
        );
        let from_review = TaskState::active(
            TaskStatus::Review,
            TaskPhase::Approval,
            PhaseStatus::Waiting,
            TaskBall::User,
        );

        assert_eq!(resolve(TaskTransition::ReworkRequested, from_review), expected);
    }

    /// A conflict differs from ordinary rework only in that it is a failure, which is what puts
    /// the destructive treatment on the card.
    #[test]
    fn merge_conflict_is_a_failed_rework() {
        let next = resolve(
            TaskTransition::MergeConflict,
            TaskState::active(
                TaskStatus::Review,
                TaskPhase::Approval,
                PhaseStatus::Waiting,
                TaskBall::User,
            ),
        );
        assert_eq!(
            next,
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
            let next = resolve(event, implementing());
            assert_eq!(next, TaskState::parked(status), "for {:?}", event);
            assert_eq!(next.ball, TaskBall::None, "for {:?}", event);
        }
    }

    /// The two approve paths land in the same column but leave the repository in different
    /// states, and `LocalOnly` is the one that tells the user their work is still in a worktree.
    #[test]
    fn the_two_approve_paths_are_distinguishable_in_done() {
        for (event, completion) in [
            (TaskTransition::Merged, TaskCompletion::Merged),
            (TaskTransition::ApprovedWithoutMerge, TaskCompletion::LocalOnly),
        ] {
            let next = resolve(event, implementing());
            assert_eq!(next.status, TaskStatus::Done, "for {:?}", event);
            assert_eq!(next.ball, TaskBall::None, "for {:?}", event);
            assert_eq!(next.completion, Some(completion), "for {:?}", event);
        }
    }

    /// The third approve path is the odd one out: it approves without landing, because the work
    /// only reaches the base branch when someone merges the PR. The ball goes to `External` so the
    /// task is neither counted as needing the user nor mistaken for one an agent is working on.
    #[test]
    fn opening_a_pull_request_approves_without_landing_the_task() {
        let next = resolve(TaskTransition::PullRequestOpened, implementing());

        assert_eq!(next.status, TaskStatus::Review);
        assert_eq!(next.phase, Some(TaskPhase::AwaitingMerge));
        assert_eq!(next.phase_status, Some(PhaseStatus::Waiting));
        assert_eq!(next.ball, TaskBall::External);
        assert_eq!(next.completion, None);
    }

    /// The forge's two answers. A merged PR lands the task with a qualifier that says how; a
    /// closed one is an error state where the task stands, because the reasons a PR gets closed
    /// have no common answer and guessing one quietly restarts work nobody asked to restart.
    #[test]
    fn the_forge_can_land_a_task_or_send_it_back_to_the_user() {
        let awaiting = resolve(TaskTransition::PullRequestOpened, implementing());

        let merged = resolve(TaskTransition::PullRequestMerged, awaiting);
        assert_eq!(merged.status, TaskStatus::Done);
        assert_eq!(merged.completion, Some(TaskCompletion::MergedViaPR));
        assert_eq!(merged.ball, TaskBall::None);

        let closed = resolve(TaskTransition::PullRequestClosed, awaiting);
        assert_eq!(closed.status, TaskStatus::Review);
        assert_eq!(closed.phase, Some(TaskPhase::AwaitingMerge));
        assert_eq!(closed.phase_status, Some(PhaseStatus::Failed));
        assert_eq!(closed.ball, TaskBall::User);
        assert_eq!(closed.completion, None);
    }

    /// The review handoff. `Waiting` with the ball on the agent is the board asking for one to be
    /// started, and it is a combination nothing else produces — a gate waiting on a person has the
    /// ball on `User`, a running agent is `Running`.
    #[test]
    fn a_pending_review_asks_for_an_agent_rather_than_the_user() {
        let next = resolve(
            TaskTransition::TurnCompleted {
                is_git_repo: true,
                has_changes: Some(true),
                reviewer_pending: true,
            },
            implementing(),
        );

        assert_eq!(next.status, TaskStatus::Review);
        assert_eq!(next.phase, Some(TaskPhase::SelfReview));
        assert_eq!(next.phase_status, Some(PhaseStatus::Waiting));
        assert_eq!(next.ball, TaskBall::Agent);
    }

    /// The reviewer's two outcomes. Rejection is the only transition in the pipeline that hands
    /// work to an agent without a person in between, which is why it is bounded elsewhere; the
    /// ball on `Agent` is what distinguishes it from the user's own rework request.
    #[test]
    fn a_rejected_review_hands_back_to_a_coder_and_an_accepted_one_to_the_user() {
        let reviewing = TaskState::active(
            TaskStatus::Review,
            TaskPhase::SelfReview,
            PhaseStatus::Running,
            TaskBall::Agent,
        );

        let rejected = resolve(TaskTransition::ReviewRejected, reviewing);
        assert_eq!(rejected.status, TaskStatus::InProgress);
        assert_eq!(rejected.phase, Some(TaskPhase::Rework));
        assert_eq!(rejected.ball, TaskBall::Agent);

        let finished = resolve(TaskTransition::ReviewFinished, reviewing);
        assert_eq!(finished.status, TaskStatus::Review);
        assert_eq!(finished.phase, Some(TaskPhase::Approval));
        assert_eq!(finished.ball, TaskBall::User);

        // The user's own rework request looks the same but waits for them to start it.
        let manual = resolve(TaskTransition::ReworkRequested, reviewing);
        assert_eq!(manual.phase, Some(TaskPhase::Rework));
        assert_eq!(manual.ball, TaskBall::User);
    }

    /// The CI-fix loop. A coder started on a task awaiting merge must stay attached to the pull
    /// request its commits will be pushed to — sending it to In Progress like an ordinary coder
    /// would leave the push with nothing to push to and the pull request never updated.
    #[test]
    fn fixing_a_red_build_keeps_the_task_on_its_pull_request() {
        let awaiting = resolve(TaskTransition::PullRequestOpened, implementing());

        let requested = resolve(TaskTransition::CiFixRequested, awaiting);
        assert_eq!(requested.phase, Some(TaskPhase::AwaitingMerge));
        assert_eq!(requested.ball, TaskBall::Agent);

        let running = resolve(TaskTransition::SessionReady(AgentRole::Coder), requested);
        assert_eq!(running.status, TaskStatus::Review);
        assert_eq!(running.phase, Some(TaskPhase::AwaitingMerge));
        assert_eq!(running.phase_status, Some(PhaseStatus::Running));

        let pushed = resolve(TaskTransition::CiFixPushed, running);
        assert_eq!(pushed.phase, Some(TaskPhase::AwaitingMerge));
        assert_eq!(pushed.ball, TaskBall::External);

        // An ordinary coder is unaffected.
        let fresh = resolve(TaskTransition::SessionReady(AgentRole::Coder), implementing());
        assert_eq!(fresh.status, TaskStatus::InProgress);
        assert_eq!(fresh.phase, Some(TaskPhase::Implementing));
    }

    /// The distinction the conflict feature turns on. `Failed` is already taken at this phase and
    /// already means "the pull request is gone"; a conflicted one is still open and still wanted.
    /// Getting these the same way round would tell a user their pull request had been closed every
    /// time somebody else's merge moved the base branch.
    ///
    /// It also pins what the card reads instead of a stored flag: at `AwaitingMerge`, `Waiting`
    /// with the ball on the user is a conflict and nothing else.
    #[test]
    fn a_conflicted_pull_request_is_amber_and_not_a_closed_one() {
        let awaiting = resolve(TaskTransition::PullRequestOpened, implementing());

        let conflicted = resolve(TaskTransition::PullRequestConflicted, awaiting);
        assert_eq!(conflicted.status, TaskStatus::Review);
        assert_eq!(conflicted.phase, Some(TaskPhase::AwaitingMerge));
        assert_eq!(conflicted.phase_status, Some(PhaseStatus::Waiting));
        assert_eq!(conflicted.ball, TaskBall::User);

        let closed = resolve(TaskTransition::PullRequestClosed, awaiting);
        assert_ne!(
            conflicted, closed,
            "a conflict must not land in the state that means the pull request was closed"
        );
        assert_eq!(closed.phase_status, Some(PhaseStatus::Failed));

        // And the way back out, or the task would sit with the user for ever once rebased.
        let cleared = resolve(TaskTransition::PullRequestMergeable, conflicted);
        assert_eq!(cleared, awaiting);
    }

    /// Dragging a task out of Done must not leave it claiming to have merged.
    #[test]
    fn parking_clears_a_stale_completion() {
        let merged = resolve(TaskTransition::Merged, implementing());
        assert_eq!(merged.completion, Some(TaskCompletion::Merged));

        let moved = resolve(TaskTransition::ManualMove(TaskStatus::Planning), merged);
        assert_eq!(moved.completion, None);
    }

    /// Discarding used to write the string 'Backlog', which no `TaskStatus` variant matches.
    #[test]
    fn discard_writes_a_real_status() {
        let next = resolve(TaskTransition::Discarded, implementing());
        assert_eq!(next.status.as_str(), "Planning");
    }

    mod database {
        use super::*;
        use crate::core::schema::initialize_schema;
        use rusqlite::Connection;

        fn db_with_task() -> (Connection, i32) {
            let conn = Connection::open_in_memory().expect("open in-memory database");
            initialize_schema(&conn).expect("initialize schema");
            conn.execute(
                "INSERT INTO projects (id, name, path, created_at, updated_at) \
                 VALUES (1, 'demo', '/tmp/demo', '2026-01-01', '2026-01-01')",
                [],
            )
            .expect("insert project");
            conn.execute(
                "INSERT INTO tasks (id, project_id, title, status, base_branch, created_at, updated_at) \
                 VALUES (1, 1, 'demo task', 'Queue', 'main', '2026-01-01', '2026-01-01')",
                [],
            )
            .expect("insert task");
            (conn, 1)
        }

        /// Drives the whole claim → ready sequence the execute flow performs.
        fn start_execution(conn: &Connection, task_id: i32) {
            claim_for_execution(conn, task_id, &[TaskStatus::Planning, TaskStatus::Queue])
                .unwrap()
                .expect("claim");
            apply_if_spawning(conn, task_id, TaskTransition::SessionReady(AgentRole::Coder))
                .unwrap()
                .expect("session ready");
        }

        #[test]
        fn apply_persists_every_lifecycle_field() {
            let (conn, task_id) = db_with_task();
            claim_for_execution(&conn, task_id, &[TaskStatus::Queue]).unwrap().unwrap();
            let task =
                apply_if_spawning(&conn, task_id, TaskTransition::SessionReady(AgentRole::Coder)).unwrap().unwrap();

            assert_eq!(task.status, TaskStatus::InProgress);
            assert_eq!(task.phase, Some(TaskPhase::Implementing));
            assert_eq!(task.phase_status, Some(PhaseStatus::Running));
            assert_eq!(task.ball, TaskBall::Agent);
            assert_eq!(task.completion, None);
            assert_eq!(read_state(&conn, task_id).unwrap(), implementing());
        }

        #[test]
        fn completion_survives_a_round_trip_through_the_database() {
            let (conn, task_id) = db_with_task();
            start_execution(&conn, task_id);

            let task = apply(&conn, task_id, TaskTransition::ApprovedWithoutMerge).unwrap();
            assert_eq!(task.completion, Some(TaskCompletion::LocalOnly));
            assert_eq!(
                read_state(&conn, task_id).unwrap().completion,
                Some(TaskCompletion::LocalOnly)
            );
        }

        #[test]
        fn apply_if_status_refuses_a_task_that_moved_on() {
            let (conn, task_id) = db_with_task();
            apply(&conn, task_id, TaskTransition::ManualMove(TaskStatus::Planning)).unwrap();

            let claimed = claim_for_execution(&conn, task_id, &[TaskStatus::Queue]).unwrap();

            assert!(claimed.is_none(), "a task no longer queued must not be claimed");
            assert_eq!(read_state(&conn, task_id).unwrap().status, TaskStatus::Planning);
        }

        /// Execute is offered from both Planning and Queue, so the ACP claim accepts either —
        /// but must still refuse a task the user dragged somewhere else mid-spawn.
        #[test]
        fn a_multi_status_guard_accepts_any_listed_column() {
            let allowed = [TaskStatus::Planning, TaskStatus::Queue];

            for start in allowed {
                let (conn, task_id) = db_with_task();
                apply(&conn, task_id, TaskTransition::ManualMove(start)).unwrap();

                let claimed = claim_for_execution(&conn, task_id, &allowed).unwrap();

                assert!(claimed.is_some(), "execution must start from {:?}", start);
                assert_eq!(read_state(&conn, task_id).unwrap(), spawning(start));
            }

            let (conn, task_id) = db_with_task();
            apply(&conn, task_id, TaskTransition::ManualMove(TaskStatus::Done)).unwrap();
            let claimed = claim_for_execution(&conn, task_id, &allowed).unwrap();
            assert!(claimed.is_none(), "a task that moved elsewhere must not be claimed");
        }

        /// Two Execute clicks, or a click racing the auto-mode drain, must build one session.
        /// Status alone cannot catch this — a claimed task keeps its column.
        #[test]
        fn a_task_already_spawning_cannot_be_claimed_again() {
            let (conn, task_id) = db_with_task();
            let allowed = [TaskStatus::Planning, TaskStatus::Queue];

            assert!(claim_for_execution(&conn, task_id, &allowed).unwrap().is_some());
            assert!(
                claim_for_execution(&conn, task_id, &allowed).unwrap().is_none(),
                "a second claim on a spawning task must be refused"
            );
        }

        /// A spawn landing after the user stopped or moved the task must not resurrect it.
        #[test]
        fn a_late_spawn_cannot_move_a_task_that_left() {
            let (conn, task_id) = db_with_task();
            claim_for_execution(&conn, task_id, &[TaskStatus::Queue]).unwrap().unwrap();

            apply(&conn, task_id, TaskTransition::ManualMove(TaskStatus::Planning)).unwrap();
            let before = read_state(&conn, task_id).unwrap();

            assert!(apply_if_spawning(&conn, task_id, TaskTransition::SessionReady(AgentRole::Coder))
                .unwrap()
                .is_none());
            assert_eq!(read_state(&conn, task_id).unwrap(), before);
        }

        /// A failed spawn stays claimed so the card can show it, which would make the failure a
        /// dead end unless the claim path treats it as retryable.
        #[test]
        fn a_failed_spawn_can_be_claimed_again() {
            let (conn, task_id) = db_with_task();
            claim_for_execution(&conn, task_id, &[TaskStatus::Queue]).unwrap().unwrap();
            apply_if_spawning(&conn, task_id, TaskTransition::PhaseFailed).unwrap().unwrap();
            assert_eq!(read_state(&conn, task_id).unwrap().phase_status, Some(PhaseStatus::Failed));

            let retried = claim_for_execution(&conn, task_id, &[TaskStatus::Queue]).unwrap();
            assert!(retried.is_some(), "a failed spawn must be retryable");
            assert_eq!(read_state(&conn, task_id).unwrap(), spawning(TaskStatus::Queue));

            apply_if_spawning(&conn, task_id, TaskTransition::SessionReady(AgentRole::Coder)).unwrap().unwrap();
            assert_eq!(read_state(&conn, task_id).unwrap(), implementing());
        }

        /// Approving a plan is what starts the coder, so the gate has to be claimable even though
        /// the task already carries a phase.
        #[test]
        fn a_task_at_the_plan_gate_can_be_claimed() {
            let (conn, task_id) = db_with_task();
            claim_for_execution(&conn, task_id, &[TaskStatus::Queue]).unwrap().unwrap();
            apply_if_spawning(&conn, task_id, TaskTransition::SessionReady(AgentRole::Planner))
                .unwrap()
                .unwrap();
            apply(
                &conn,
                task_id,
                TaskTransition::TurnCompleted { is_git_repo: true, has_changes: None, reviewer_pending: false },
            )
            .unwrap();
            assert_eq!(read_state(&conn, task_id).unwrap().phase, Some(TaskPhase::PlanReview));

            let claimed = claim_for_execution(&conn, task_id, &[TaskStatus::InProgress]).unwrap();

            assert!(claimed.is_some(), "the plan gate must hand off to the coder");
            assert_eq!(read_state(&conn, task_id).unwrap(), spawning(TaskStatus::InProgress));
        }

        /// Every handoff the board performs has to be claimable, and the reviewer's proves the
        /// point on its own: it works in Review, which no caller lists among the columns a user may
        /// press Execute from. Checking that list for a handoff refused all three of them, so a
        /// coder finishing left the task at `SelfReview/Waiting` with nothing able to start.
        #[test]
        fn every_handoff_can_be_claimed_from_the_column_its_role_works_in() {
            // Reached the way the board reaches them, so a change to what produces a handoff shows
            // up here rather than in a hand-written state that quietly stops matching.
            let handoffs: [(TaskTransition, TaskPhase, TaskStatus); 3] = [
                (
                    TaskTransition::TurnCompleted {
                        is_git_repo: true,
                        has_changes: Some(true),
                        reviewer_pending: true,
                    },
                    TaskPhase::SelfReview,
                    TaskStatus::Review,
                ),
                (TaskTransition::ReviewRejected, TaskPhase::Rework, TaskStatus::InProgress),
                (TaskTransition::CiFixRequested, TaskPhase::AwaitingMerge, TaskStatus::Review),
            ];

            for (event, phase, status) in handoffs {
                let (conn, task_id) = db_with_task();
                start_execution(&conn, task_id);
                apply(&conn, task_id, event).unwrap();
                assert_eq!(
                    read_state(&conn, task_id).unwrap(),
                    TaskState::active(status, phase, PhaseStatus::Waiting, TaskBall::Agent),
                );

                // The caller's list names the user's columns, and deliberately not this one.
                let claimed =
                    claim_for_execution(&conn, task_id, &[TaskStatus::Planning, TaskStatus::Queue])
                        .unwrap();

                assert!(claimed.is_some(), "{phase:?} is a handoff and must start");
                assert_eq!(read_state(&conn, task_id).unwrap(), spawning(status));

                // And exactly once: the claim itself is what stops the board asking twice while
                // the first session is still coming up.
                assert!(
                    claim_for_execution(&conn, task_id, &[TaskStatus::Planning, TaskStatus::Queue])
                        .unwrap()
                        .is_none(),
                    "{phase:?} must not be claimable twice"
                );
            }
        }

        /// Through the claim, not around it — which is the whole point.
        ///
        /// `resolve` was asked whether the phase was `AwaitingMerge`, and by the time a session is
        /// ready it never is: `ExecutionStarted` has already overwritten it with `Spawning`. The
        /// unit test above passes because it hands `resolve` the pre-claim state directly, so the
        /// guard matched in the tests and nowhere else, and a live CI fix round landed in
        /// `InProgress/Implementing`. From there `reader_task` gates the push on the phase, so the
        /// fix would never have reached the pull request it was written for — it would have gone
        /// round the review loop and asked to open a second one.
        #[test]
        fn a_ci_fix_stays_on_its_pull_request_across_the_claim() {
            let (conn, task_id) = db_with_task();
            start_execution(&conn, task_id);
            apply(&conn, task_id, TaskTransition::CiFixRequested).unwrap();

            claim_for_execution(&conn, task_id, &[TaskStatus::Planning, TaskStatus::Queue])
                .unwrap()
                .expect("the red-build handoff must be claimable");
            // The claim keeps the column and drops the phase. The column is what survives to say
            // where this came from.
            assert_eq!(read_state(&conn, task_id).unwrap(), spawning(TaskStatus::Review));

            apply_if_spawning(&conn, task_id, TaskTransition::SessionReady(AgentRole::Coder))
                .unwrap()
                .unwrap();

            assert_eq!(
                read_state(&conn, task_id).unwrap(),
                TaskState::active(
                    TaskStatus::Review,
                    TaskPhase::AwaitingMerge,
                    PhaseStatus::Running,
                    TaskBall::Agent
                ),
                "a coder fixing a red build must stay attached to its pull request"
            );
        }

        /// The other coder start must not be caught by the same guard: a rework round is ordinary
        /// work in In Progress, and sending it to `AwaitingMerge` would try to push it to a pull
        /// request that does not exist.
        #[test]
        fn a_rework_round_is_still_ordinary_work() {
            let (conn, task_id) = db_with_task();
            start_execution(&conn, task_id);
            apply(&conn, task_id, TaskTransition::ReviewRejected).unwrap();

            claim_for_execution(&conn, task_id, &[TaskStatus::Planning, TaskStatus::Queue])
                .unwrap()
                .expect("a rejected review is a handoff");
            apply_if_spawning(&conn, task_id, TaskTransition::SessionReady(AgentRole::Coder))
                .unwrap()
                .unwrap();

            assert_eq!(read_state(&conn, task_id).unwrap(), implementing());
        }

        /// The human review gate is not a handoff. Something is waiting there, but it is a person
        /// choosing how to land the work — starting an agent for them would be inventing a decision.
        #[test]
        fn the_approval_gate_is_not_a_handoff() {
            let (conn, task_id) = db_with_task();
            start_execution(&conn, task_id);
            apply(
                &conn,
                task_id,
                TaskTransition::TurnCompleted {
                    is_git_repo: true,
                    has_changes: Some(true),
                    reviewer_pending: false,
                },
            )
            .unwrap();
            assert_eq!(read_state(&conn, task_id).unwrap().phase, Some(TaskPhase::Approval));

            assert!(claim_for_execution(&conn, task_id, &[TaskStatus::Review]).unwrap().is_none());
        }

        /// The retry exception must not widen into "any task with a phase can be re-claimed" —
        /// a running agent's task is not startable.
        #[test]
        fn a_task_with_a_live_phase_cannot_be_claimed() {
            let (conn, task_id) = db_with_task();
            start_execution(&conn, task_id);
            apply(&conn, task_id, TaskTransition::ManualMove(TaskStatus::Queue)).unwrap();
            apply(&conn, task_id, TaskTransition::ExecutionStarted).unwrap();
            apply_if_spawning(&conn, task_id, TaskTransition::SessionReady(AgentRole::Coder)).unwrap();

            // Now InProgress/Implementing — not in `expected`, and not spawning either.
            assert!(claim_for_execution(&conn, task_id, &[TaskStatus::Queue]).unwrap().is_none());
        }

        fn request_marker(conn: &Connection, task_id: i32) -> Option<String> {
            conn.query_row(
                "SELECT execute_requested_at FROM tasks WHERE id = ?",
                [task_id],
                |row| row.get(0),
            )
            .expect("read the deferral marker")
        }

        fn defer(conn: &Connection, task_id: i32) {
            conn.execute(
                "UPDATE tasks SET execute_requested_at = '2026-01-01T00:00:00Z' WHERE id = ?",
                [task_id],
            )
            .expect("defer the task");
        }

        /// The deferral marker only means something while the scheduler can still act on it, and
        /// being claimed is the moment it stops meaning anything. Left behind, it would jump the
        /// queue a second time if the task ever came back.
        #[test]
        fn claiming_a_task_clears_its_deferral() {
            let (conn, task_id) = db_with_task();
            defer(&conn, task_id);

            claim_for_execution(&conn, task_id, &[TaskStatus::Queue]).unwrap().unwrap();

            assert_eq!(request_marker(&conn, task_id), None);
        }

        /// Dragging the card out of Queue is the user withdrawing the request.
        #[test]
        fn leaving_the_queue_clears_a_deferral() {
            let (conn, task_id) = db_with_task();
            defer(&conn, task_id);

            apply(&conn, task_id, TaskTransition::ManualMove(TaskStatus::Planning)).unwrap();

            assert_eq!(request_marker(&conn, task_id), None);
        }

        /// A transition that leaves the task where it was must not silently cancel the promise —
        /// an aborted spawn parks it back in Queue and it is still owed a slot.
        #[test]
        fn a_deferral_survives_a_transition_back_into_the_queue() {
            let (conn, task_id) = db_with_task();
            defer(&conn, task_id);

            claim_for_execution(&conn, task_id, &[TaskStatus::Queue]).unwrap().unwrap();
            defer(&conn, task_id);
            apply_if_spawning(&conn, task_id, TaskTransition::SpawnAborted).unwrap().unwrap();

            assert!(request_marker(&conn, task_id).is_some());
        }

        /// The guard a turn ending relies on. Every way a task leaves an agent's hands — stopped,
        /// dragged away, approved — parks it, and a turn landing afterwards must not undo that.
        #[test]
        fn a_turn_landing_after_the_task_was_parked_is_ignored() {
            let (conn, task_id) = db_with_task();
            start_execution(&conn, task_id);
            apply(&conn, task_id, TaskTransition::Stopped).unwrap();
            let before = read_state(&conn, task_id).unwrap();

            let applied = apply_if_active(
                &conn,
                task_id,
                TaskTransition::TurnCompleted { is_git_repo: true, has_changes: Some(true), reviewer_pending: false },
            )
            .unwrap();

            assert!(applied.is_none());
            assert_eq!(read_state(&conn, task_id).unwrap(), before);
        }

        /// It must not over-guard either: a refiner works in Planning, which is also where a
        /// stopped task is parked, so a column check would silently drop every refinement.
        #[test]
        fn a_turn_ending_in_planning_still_applies() {
            let (conn, task_id) = db_with_task();
            apply(&conn, task_id, TaskTransition::ManualMove(TaskStatus::Planning)).unwrap();
            claim_for_execution(&conn, task_id, &[TaskStatus::Planning]).unwrap().unwrap();
            apply_if_spawning(&conn, task_id, TaskTransition::SessionReady(AgentRole::Refiner))
                .unwrap()
                .unwrap();

            let applied = apply_if_active(
                &conn,
                task_id,
                TaskTransition::TurnCompleted { is_git_repo: true, has_changes: None, reviewer_pending: false },
            )
            .unwrap();

            assert!(applied.is_some());
            assert_eq!(
                read_state(&conn, task_id).unwrap(),
                TaskState::active(
                    TaskStatus::Planning,
                    TaskPhase::Refining,
                    PhaseStatus::Waiting,
                    TaskBall::User
                )
            );
        }

        #[test]
        fn apply_if_changed_skips_a_no_op_write() {
            let (conn, task_id) = db_with_task();
            start_execution(&conn, task_id);
            apply(&conn, task_id, TaskTransition::AwaitingUserInput).unwrap();

            let second = apply_if_changed(&conn, task_id, TaskTransition::AwaitingUserInput).unwrap();
            assert!(second.is_none(), "repeating a blocked write must be skipped");
        }

        #[test]
        fn clear_blocked_only_touches_blocked_tasks() {
            let (conn, task_id) = db_with_task();
            start_execution(&conn, task_id);
            apply(&conn, task_id, TaskTransition::AwaitingUserInput).unwrap();

            assert!(clear_blocked(&conn, task_id).unwrap().is_some());
            assert_eq!(read_state(&conn, task_id).unwrap(), implementing());

            // A task parked at a review gate is waiting, not blocked, and must be left alone.
            apply(
                &conn,
                task_id,
                TaskTransition::TurnCompleted { is_git_repo: true, has_changes: Some(true), reviewer_pending: false },
            )
            .unwrap();
            let before = read_state(&conn, task_id).unwrap();
            assert!(clear_blocked(&conn, task_id).unwrap().is_none());
            assert_eq!(read_state(&conn, task_id).unwrap(), before);
        }

        #[test]
        fn a_dying_session_fails_a_running_or_blocked_phase() {
            for setup in [TaskTransition::SessionReady(AgentRole::Coder), TaskTransition::AwaitingUserInput] {
                let (conn, task_id) = db_with_task();
                start_execution(&conn, task_id);
                apply(&conn, task_id, setup).unwrap();

                let failed = fail_if_agent_running(&conn, task_id).unwrap();
                assert!(failed.is_some(), "for {:?}", setup);

                let state = read_state(&conn, task_id).unwrap();
                assert_eq!(state.phase_status, Some(PhaseStatus::Failed));
                assert_eq!(state.ball, TaskBall::User);
                assert_eq!(state.status, TaskStatus::InProgress, "the card must not move");
            }
        }

        /// The common case: a session ends because its work finished. Nothing should be failed.
        #[test]
        fn a_session_ending_after_the_task_moved_on_is_not_a_failure() {
            for terminal in [
                TaskTransition::Merged,
                TaskTransition::Stopped,
                TaskTransition::TurnCompleted { is_git_repo: true, has_changes: Some(true), reviewer_pending: false },
            ] {
                let (conn, task_id) = db_with_task();
                start_execution(&conn, task_id);
                apply(&conn, task_id, terminal).unwrap();
                let before = read_state(&conn, task_id).unwrap();

                assert!(
                    fail_if_agent_running(&conn, task_id).unwrap().is_none(),
                    "for {:?}",
                    terminal
                );
                assert_eq!(read_state(&conn, task_id).unwrap(), before);
            }
        }
    }
}
