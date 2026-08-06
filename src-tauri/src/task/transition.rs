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

use crate::models::{PhaseStatus, Task, TaskBall, TaskPhase, TaskStatus, TASK_SELECT};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TaskState {
    pub status: TaskStatus,
    pub phase: Option<TaskPhase>,
    pub phase_status: Option<PhaseStatus>,
    pub ball: TaskBall,
}

impl TaskState {
    /// No pipeline activity: parked in a column with nothing running and nobody blocked.
    fn parked(status: TaskStatus) -> Self {
        TaskState { status, phase: None, phase_status: None, ball: TaskBall::None }
    }

    fn active(status: TaskStatus, phase: TaskPhase, phase_status: PhaseStatus, ball: TaskBall) -> Self {
        TaskState { status, phase: Some(phase), phase_status: Some(phase_status), ball }
    }
}

/// Something that happened to a task, not a state to move it to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskTransition {
    /// The user dragged the card or picked a status directly.
    ManualMove(TaskStatus),
    /// An agent session was spawned for the task.
    ExecutionStarted,
    /// The agent stopped mid-phase and needs an answer to continue.
    AwaitingUserInput,
    /// That answer arrived, or the turn resumed some other way.
    Unblocked,
    /// The agent ended its turn.
    ///
    /// This still fires on every `end_turn`, exactly as before — a turn ending is not the same
    /// as the work being finished, and separating the two is deliberately left for later. This
    /// event only gives the existing behaviour a name so there is one place to change it.
    TurnCompleted { is_git_repo: bool },
    /// The user stopped the running session.
    Stopped,
    /// Review feedback was recorded and the task goes back for another pass.
    ReworkRequested,
    /// A merge was attempted and conflicted.
    MergeConflict,
    /// The branch merged cleanly.
    Merged,
    /// The user approved the work but chose to commit it without merging, keeping the worktree.
    ///
    /// Lands in the same place as `Merged` — approval is terminal on the board either way — but
    /// stays a separate event because the repository is left in a different state, and the two
    /// would otherwise be indistinguishable at the one place that decides what approval means.
    ApprovedWithoutMerge,
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

        TaskTransition::ExecutionStarted => {
            TaskState::active(InProgress, Implementing, Running, Ball::Agent)
        }

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

        // Without a repo there is nothing to review, so the task is simply finished.
        TaskTransition::TurnCompleted { is_git_repo } => {
            if is_git_repo {
                TaskState::active(Review, Approval, Waiting, Ball::User)
            } else {
                TaskState::parked(Done)
            }
        }

        TaskTransition::Stopped => TaskState::parked(Planning),

        TaskTransition::ReworkRequested => {
            TaskState::active(InProgress, Rework, Waiting, Ball::User)
        }

        // A conflict is a failure the user has to resolve, not a fresh rework request.
        TaskTransition::MergeConflict => {
            TaskState::active(InProgress, Rework, Failed, Ball::User)
        }

        TaskTransition::Merged | TaskTransition::ApprovedWithoutMerge => TaskState::parked(Done),

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
        "SELECT status, phase, phase_status, ball FROM tasks WHERE id = ?",
        [task_id],
        |row| {
            let status: String = row.get(0)?;
            let phase: Option<String> = row.get(1)?;
            let phase_status: Option<String> = row.get(2)?;
            let ball: String = row.get(3)?;
            Ok(TaskState {
                status: status.parse().unwrap_or(TaskStatus::Planning),
                phase: phase.and_then(|s| s.parse().ok()),
                phase_status: phase_status.and_then(|s| s.parse().ok()),
                ball: ball.parse().unwrap_or(TaskBall::None),
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

    conn.execute(
        "UPDATE tasks SET status = ?, phase = ?, phase_status = ?, ball = ?, updated_at = ? \
         WHERE id = ?",
        rusqlite::params![
            next.status.as_str(),
            next.phase.map(TaskPhase::as_str),
            next.phase_status.map(PhaseStatus::as_str),
            next.ball.as_str(),
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

    fn implementing() -> TaskState {
        TaskState::active(
            TaskStatus::InProgress,
            TaskPhase::Implementing,
            PhaseStatus::Running,
            TaskBall::Agent,
        )
    }

    #[test]
    fn execution_started_hands_the_ball_to_the_agent() {
        let next = resolve(
            TaskTransition::ExecutionStarted,
            TaskState::parked(TaskStatus::Queue),
        );
        assert_eq!(next, implementing());
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
            TaskTransition::TurnCompleted { is_git_repo: true },
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

        let without_repo = resolve(
            TaskTransition::TurnCompleted { is_git_repo: false },
            implementing(),
        );
        assert_eq!(without_repo, TaskState::parked(TaskStatus::Done));
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
            (TaskTransition::Merged, TaskStatus::Done),
            (TaskTransition::ApprovedWithoutMerge, TaskStatus::Done),
            (TaskTransition::Stopped, TaskStatus::Planning),
            (TaskTransition::Discarded, TaskStatus::Planning),
            (TaskTransition::Cancelled, TaskStatus::Cancelled),
        ] {
            let next = resolve(event, implementing());
            assert_eq!(next, TaskState::parked(status), "for {:?}", event);
            assert_eq!(next.ball, TaskBall::None, "for {:?}", event);
        }
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

        #[test]
        fn apply_persists_all_four_fields() {
            let (conn, task_id) = db_with_task();
            let task = apply(&conn, task_id, TaskTransition::ExecutionStarted).unwrap();

            assert_eq!(task.status, TaskStatus::InProgress);
            assert_eq!(task.phase, Some(TaskPhase::Implementing));
            assert_eq!(task.phase_status, Some(PhaseStatus::Running));
            assert_eq!(task.ball, TaskBall::Agent);
            assert_eq!(read_state(&conn, task_id).unwrap(), implementing());
        }

        #[test]
        fn apply_if_status_refuses_a_task_that_moved_on() {
            let (conn, task_id) = db_with_task();
            apply(&conn, task_id, TaskTransition::ManualMove(TaskStatus::Planning)).unwrap();

            let claimed = apply_if_status(
                &conn,
                task_id,
                Some(&[TaskStatus::Queue]),
                TaskTransition::ExecutionStarted,
            )
            .unwrap();

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

                let claimed =
                    apply_if_status(&conn, task_id, Some(&allowed), TaskTransition::ExecutionStarted)
                        .unwrap();

                assert!(claimed.is_some(), "execution must start from {:?}", start);
                assert_eq!(read_state(&conn, task_id).unwrap(), implementing());
            }

            let (conn, task_id) = db_with_task();
            apply(&conn, task_id, TaskTransition::ManualMove(TaskStatus::Done)).unwrap();
            let claimed =
                apply_if_status(&conn, task_id, Some(&allowed), TaskTransition::ExecutionStarted)
                    .unwrap();
            assert!(claimed.is_none(), "a task that moved elsewhere must not be claimed");
        }

        #[test]
        fn apply_if_changed_skips_a_no_op_write() {
            let (conn, task_id) = db_with_task();
            apply(&conn, task_id, TaskTransition::ExecutionStarted).unwrap();
            apply(&conn, task_id, TaskTransition::AwaitingUserInput).unwrap();

            let second = apply_if_changed(&conn, task_id, TaskTransition::AwaitingUserInput).unwrap();
            assert!(second.is_none(), "repeating a blocked write must be skipped");
        }

        #[test]
        fn clear_blocked_only_touches_blocked_tasks() {
            let (conn, task_id) = db_with_task();
            apply(&conn, task_id, TaskTransition::ExecutionStarted).unwrap();
            apply(&conn, task_id, TaskTransition::AwaitingUserInput).unwrap();

            assert!(clear_blocked(&conn, task_id).unwrap().is_some());
            assert_eq!(read_state(&conn, task_id).unwrap(), implementing());

            // A task parked at a review gate is waiting, not blocked, and must be left alone.
            apply(&conn, task_id, TaskTransition::TurnCompleted { is_git_repo: true }).unwrap();
            let before = read_state(&conn, task_id).unwrap();
            assert!(clear_blocked(&conn, task_id).unwrap().is_none());
            assert_eq!(read_state(&conn, task_id).unwrap(), before);
        }

        #[test]
        fn a_dying_session_fails_a_running_or_blocked_phase() {
            for setup in [TaskTransition::ExecutionStarted, TaskTransition::AwaitingUserInput] {
                let (conn, task_id) = db_with_task();
                apply(&conn, task_id, TaskTransition::ExecutionStarted).unwrap();
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
                TaskTransition::TurnCompleted { is_git_repo: true },
            ] {
                let (conn, task_id) = db_with_task();
                apply(&conn, task_id, TaskTransition::ExecutionStarted).unwrap();
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
