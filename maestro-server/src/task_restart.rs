//! What a starting daemon does with the tasks its predecessor left in flight.
//!
//! Every session died with the old daemon and `reset_on_start` made every row dormant, so a task
//! the board still shows as worked on has nothing behind it. Once, before the loop runs: a claim
//! with no session is released, a task mid-turn has its session reloaded and is told to resume, and
//! a hand-off to the next stage is started again. The queue drains after.
//!
//! A `Blocked` task is resumed like a `Running` one only when its turn was live at shutdown: the
//! prompt it waited on died with the agent, which asks again on resuming if it still needs the
//! answer. One whose agent ended its turn to ask the user (a stall) is waiting on that user, and is
//! left for them.

use std::collections::HashSet;
use std::sync::{Arc, LazyLock, Mutex};

use maestro_protocol::{
    AgentRole, ApplyTaskTransitionRequest, NewTaskComment, PhaseStatus, ProjectSession,
    ServerRequest, TaskPhase, TaskSessionStarted, TaskTransition, TransitionGuard,
};
use rusqlite::Connection;

use crate::helpers::{broadcast, send_diag};
use crate::sessions::SessionCommand;
use crate::task_turn::Driver;

/// What `useAutoResume` sends a task session whose turn was cut off.
const RESUME: &str = "resume";

/// Sessions this pass is reloading, by the agent's session id. A window opening the project
/// meanwhile finds the row dormant and would load it too; its load is refused until the daemon's
/// is in the map, and the window adopts that one from `TaskSessionStarted`.
static RELOADING: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(Default::default);

pub(crate) fn reloading(acp_session_id: &str) -> bool {
    RELOADING.lock().unwrap().contains(acp_session_id)
}

pub(crate) fn reloaded(acp_session_id: &str) {
    RELOADING.lock().unwrap().remove(acp_session_id);
}

#[derive(Debug, PartialEq)]
pub(crate) enum Action {
    /// Claimed, and the old daemon died before a session came up.
    Release,
    /// Mid-turn: reload the session and tell it to resume, a blocked task unblocked first.
    Resume {
        row: Box<ProjectSession>,
        role: AgentRole,
        unblock: bool,
    },
    /// Mid-turn with no session that can come back.
    Fail(&'static str),
    /// A hand-off the old daemon did not get to start.
    StartNext(AgentRole),
}

/// The role a phase is worked by.
pub(crate) fn role(phase: Option<TaskPhase>) -> Option<AgentRole> {
    match phase? {
        TaskPhase::Refining => Some(AgentRole::Refiner),
        TaskPhase::Drafting => Some(AgentRole::Planner),
        TaskPhase::Implementing | TaskPhase::Rework | TaskPhase::AwaitingMerge => {
            Some(AgentRole::Coder)
        }
        TaskPhase::SelfReview => Some(AgentRole::Reviewer),
        _ => None,
    }
}

/// What one task needs. `next` is `task_turn::next_stage`; `rows` the project's open sessions;
/// `turn_was_live` whether a row's session was mid-turn when the last daemon stopped.
pub(crate) fn decide(
    task_id: i32,
    phase: Option<TaskPhase>,
    status: Option<PhaseStatus>,
    next: Option<AgentRole>,
    rows: &[ProjectSession],
    turn_was_live: impl Fn(&ProjectSession) -> bool,
) -> Option<Action> {
    if phase == Some(TaskPhase::Spawning) {
        // `Failed` is a spawn that failed and is the user's to retry.
        return (status == Some(PhaseStatus::Running)).then_some(Action::Release);
    }
    if let Some(next) = next {
        return Some(Action::StartNext(next));
    }
    let unblock = match status {
        Some(PhaseStatus::Running) => false,
        Some(PhaseStatus::Blocked) => true,
        _ => return None,
    };
    let role = role(phase)?;
    // The newest, which is the one a supersede left open.
    let row = rows
        .iter()
        .rev()
        .find(|row| !row.closed && row.meta.task_id == Some(task_id));
    // Blocked between turns is a stall: the agent asked the user and waits for them.
    if unblock && !row.is_some_and(&turn_was_live) {
        return None;
    }
    match row {
        Some(row) if row.can_reload => Some(Action::Resume {
            row: Box::new(row.clone()),
            role,
            unblock,
        }),
        Some(_) => Some(Action::Fail("its agent cannot reload a session")),
        None => Some(Action::Fail("it left no session to reload")),
    }
}

/// Every task needing something, read before the loop runs. Sessions to reload are marked so.
pub(crate) fn plan(conn: &Connection) -> Vec<(String, i32, Action)> {
    let found = conn
        .prepare(
            "SELECT project_path, id FROM tasks
             WHERE phase IS NOT NULL AND phase_status IN ('Running', 'Blocked', 'Waiting')",
        )
        .and_then(|mut statement| {
            statement
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, i32>(1)?))
                })?
                .collect::<Result<Vec<_>, _>>()
        });
    let tasks = match found {
        Ok(tasks) => tasks,
        Err(e) => {
            send_diag("warn", format!("[task] cannot read tasks at startup: {e}"));
            return Vec::new();
        }
    };
    let mut planned = Vec::new();
    for (path, task_id) in tasks {
        let Ok(Some(task)) = crate::task_store::get(conn, &path, task_id) else {
            continue;
        };
        let rows: Vec<ProjectSession> = crate::project_store::list(conn, &path, false)
            .unwrap_or_default()
            .into_iter()
            .map(|(row, _)| row)
            .collect();
        let next = crate::task_turn::next_stage(&task);
        let turn_was_live = |row: &ProjectSession| {
            crate::project_store::turn_was_active(conn, &row.agent_id, &row.acp_session_id)
        };
        if let Some(action) = decide(
            task_id,
            task.phase,
            task.phase_status,
            next,
            &rows,
            turn_was_live,
        ) {
            if let Action::Resume { row, .. } = &action {
                RELOADING.lock().unwrap().insert(row.acp_session_id.clone());
            }
            planned.push((path, task_id, action));
        }
    }
    planned
}

fn note(body: String) -> NewTaskComment {
    NewTaskComment {
        kind: "note".to_string(),
        author: "maestro".to_string(),
        body: Some(body),
        external_ref: None,
        phase: None,
    }
}

/// Move the task under `guard`, with a note in its thread, and push the change.
async fn transition(
    driver: &Driver,
    everyone: &crate::ClientOut,
    (path, task_id): (&str, i32),
    event: TaskTransition,
    guard: TransitionGuard,
    body: String,
) {
    let request = ServerRequest::ApplyTaskTransition(ApplyTaskTransitionRequest {
        project_path: path.to_string(),
        task_id,
        event,
        guard,
        update: None,
        comment: Some(note(body)),
    });
    let answered = crate::task_store::requests::answer(&mut *driver.store.lock().await, request);
    match answered {
        Ok((_, pushes)) => {
            for push in pushes {
                broadcast(everyone, push).await;
            }
        }
        Err(e) => send_diag("warn", format!("[task] task {task_id} at startup: {e}")),
    }
}

/// Carry out the plan off the loop, then drain every queue.
pub(crate) fn spawn(driver: Driver, planned: Vec<(String, i32, Action)>) {
    tokio::spawn(async move {
        let everyone = crate::client_sink::ClientSink::everyone(&driver.stdout).await;
        for (path, task_id, action) in planned {
            match action {
                Action::Release => {
                    transition(
                        &driver,
                        &everyone,
                        (&path, task_id),
                        TaskTransition::SpawnAborted,
                        TransitionGuard::Spawning,
                        "Maestro restarted while this task was starting, so it was put back."
                            .to_string(),
                    )
                    .await
                }
                Action::Fail(why) => fail(&driver, &everyone, &path, task_id, why).await,
                // The drain starts hand-offs, whoever left them.
                Action::StartNext(_) => crate::scheduler::request_drain(&path),
                Action::Resume { row, role, unblock } => {
                    let acp_session_id = row.acp_session_id.clone();
                    let resumed = Box::pin(resume(
                        &driver, &everyone, &path, task_id, *row, role, unblock,
                    ))
                    .await;
                    if let Err(why) = resumed {
                        reloaded(&acp_session_id);
                        fail(&driver, &everyone, &path, task_id, &why).await;
                    }
                }
            }
        }
        crate::scheduler::request_all();
    });
}

async fn fail(driver: &Driver, everyone: &crate::ClientOut, path: &str, task_id: i32, why: &str) {
    transition(
        driver,
        everyone,
        (path, task_id),
        TaskTransition::PhaseFailed,
        TransitionGuard::AgentRunning,
        format!("Maestro restarted while an agent was working this task, and {why}."),
    )
    .await;
}

/// Reload the task's session, tell it to resume and hand it to the loop as a started task session.
async fn resume(
    driver: &Driver,
    everyone: &crate::ClientOut,
    path: &str,
    task_id: i32,
    row: ProjectSession,
    role: AgentRole,
    unblock: bool,
) -> Result<(), String> {
    let agent = driver
        .agents
        .iter()
        .find(|agent| agent.id == row.agent_id)
        .ok_or_else(|| format!("the agent {} is not known here", row.agent_id))?;
    crate::session::requests::check_load(&row.cwd, Some(path), &row.agent_id, true)?;
    // The agent process runs in the project, never in the worktree: see `automation_runner`.
    let connection = crate::helpers::ensure_and_get_connection(
        &row.agent_id,
        &driver.agent_connections,
        &agent.spawn_cmd,
        &agent.spawn_args,
        &agent.spawn_env,
        path,
        everyone,
    )
    .await
    .ok_or_else(|| format!("the agent {} could not be started", row.agent_id))?;
    let session_id = uuid::Uuid::new_v4().to_string();
    let requested_at = chrono::Utc::now();
    let loaded = crate::session::load_session_on_connection(
        &connection,
        session_id.clone(),
        row.acp_session_id.clone(),
        &row.agent_id,
        &row.cwd,
        &[],
        Arc::clone(everyone),
    )
    .await;
    let (mut session, models, modes, config_options) = match loaded {
        Ok(Some((session, models, modes, _, config_options))) => {
            (session, models, modes, config_options)
        }
        Ok(None) => return Err("the agent could not reload its session".to_string()),
        Err(()) => {
            crate::helpers::evict_if_same_connection(
                &driver.agent_connections,
                &row.agent_id,
                &connection.router,
            )
            .await;
            return Err("the agent could not reload its session".to_string());
        }
    };

    crate::session::task_gate::bind(&connection.router, &row.acp_session_id, path, task_id, role)
        .await;
    if unblock {
        crate::session::task_gate::unblock(&Some((path.to_string(), task_id)), everyone).await;
    }
    // A reloaded session comes up in the agent's defaults, so the stage's settings go first.
    let task = crate::task_store::get(&*driver.store.lock().await, path, task_id)?
        .ok_or_else(|| "the task is gone".to_string())?;
    let capabilities =
        crate::task_runner::capabilities(models.as_ref(), modes.as_ref(), config_options.as_ref());
    let settings = crate::profiles::resolve_stage(path, &task, role, &capabilities)?;
    for warning in &settings.warnings {
        send_diag("warn", format!("[task] task {task_id}: {warning}"));
    }
    let mut commands = crate::task_runner::settings_commands(&settings, config_options.as_ref());
    commands.push(SessionCommand::Prompt(RESUME.to_string()));
    crate::task_runner::expect_turn_ends(&session_id);
    for command in commands {
        if session.cmd_tx.send(command).await.is_err() {
            crate::task_runner::forget_turn_ends(&session_id);
            return Err("the session ended before it could resume".to_string());
        }
    }

    session.agent_id = row.agent_id.clone();
    session.cwd = row.cwd;
    session.project = Some(crate::sessions::ProjectBinding {
        project_path: path.to_string(),
        meta: row.meta,
        can_reload: connection.capabilities.supports_session_load,
        requested_at,
    });
    let started = crate::task_runner::Started {
        push: TaskSessionStarted {
            project_path: path.to_string(),
            task_id,
            session_id: session_id.clone(),
            agent_id: row.agent_id,
            acp_session_id: row.acp_session_id,
            role,
        },
        session_id: session_id.clone(),
        session,
        // Nobody asked, so the one reply goes to a client that does not exist.
        reply: crate::client_sink::ClientSink::for_client(&driver.stdout, u64::MAX).await,
        skipped_attachments: vec![],
    };
    if let Err(e) = driver
        .settle_tx
        .send(crate::dispatch::Settle::TaskStarted(Box::new(started)))
    {
        crate::task_runner::forget_turn_ends(&session_id);
        send_diag("warn", format!("[task] the server stopped: {e}"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use maestro_protocol::SessionMeta;

    /// A window's load of a session the pass is reloading is told to wait, not that it failed.
    #[test]
    fn a_load_during_the_reload_is_refused_as_reloading() {
        assert_eq!(crate::session::requests::reloading_refusal("conv-r"), None);
        RELOADING.lock().unwrap().insert("conv-r".to_string());
        let refusal = crate::session::requests::reloading_refusal("conv-r").unwrap();
        assert!(refusal.starts_with(maestro_protocol::SESSION_RELOADING_ERROR));
        assert!(!refusal.starts_with(maestro_protocol::SESSION_LOAD_FAILED_ERROR));
        reloaded("conv-r");
        assert_eq!(crate::session::requests::reloading_refusal("conv-r"), None);
    }

    fn row(task_id: i32, can_reload: bool, closed: bool) -> ProjectSession {
        ProjectSession {
            agent_id: "a".to_string(),
            acp_session_id: format!("s{task_id}{can_reload}{closed}"),
            cwd: "/p".to_string(),
            meta: SessionMeta {
                task_id: Some(task_id),
                ..Default::default()
            },
            can_reload,
            closed,
            live: None,
        }
    }

    #[test]
    fn a_dead_claim_is_released_and_a_failed_spawn_left_alone() {
        let spawning = Some(TaskPhase::Spawning);
        assert_eq!(
            decide(1, spawning, Some(PhaseStatus::Running), None, &[], |_| {
                false
            }),
            Some(Action::Release)
        );
        assert_eq!(
            decide(1, spawning, Some(PhaseStatus::Failed), None, &[], |_| false),
            None
        );
    }

    #[test]
    fn a_hand_off_is_started_again() {
        assert_eq!(
            decide(
                1,
                Some(TaskPhase::SelfReview),
                Some(PhaseStatus::Waiting),
                Some(AgentRole::Reviewer),
                &[],
                |_| false
            ),
            Some(Action::StartNext(AgentRole::Reviewer))
        );
        // A gate the user owns stays.
        assert_eq!(
            decide(
                1,
                Some(TaskPhase::PlanReview),
                Some(PhaseStatus::Waiting),
                None,
                &[],
                |_| false
            ),
            None
        );
    }

    #[test]
    fn a_task_mid_turn_resumes_its_newest_open_session() {
        let rows = [row(2, true, false), row(1, true, true), row(1, true, false)];
        let implementing = Some(TaskPhase::Implementing);
        assert_eq!(
            decide(
                1,
                implementing,
                Some(PhaseStatus::Running),
                None,
                &rows,
                |_| false
            ),
            Some(Action::Resume {
                row: Box::new(rows[2].clone()),
                role: AgentRole::Coder,
                unblock: false
            })
        );
        assert_eq!(
            decide(
                1,
                Some(TaskPhase::SelfReview),
                Some(PhaseStatus::Blocked),
                None,
                &rows,
                |_| true
            ),
            Some(Action::Resume {
                row: Box::new(rows[2].clone()),
                role: AgentRole::Reviewer,
                unblock: true
            })
        );
    }

    /// `Stalled` writes `Blocked` as a prompt does: only the turn on the row tells them apart.
    #[test]
    fn a_blocked_task_resumes_only_if_its_turn_was_live() {
        let rows = [row(1, true, false)];
        let review = Some(TaskPhase::SelfReview);
        let blocked = Some(PhaseStatus::Blocked);
        assert_eq!(decide(1, review, blocked, None, &rows, |_| false), None);
        assert_eq!(decide(1, review, blocked, None, &[], |_| true), None);
        assert!(matches!(
            decide(1, review, blocked, None, &rows, |_| true),
            Some(Action::Resume { unblock: true, .. })
        ));
    }

    /// The column the decision reads: set at shutdown for a live turn, cleared on coming up.
    #[test]
    fn a_live_turn_is_noted_at_shutdown_and_cleared_on_reload() {
        use crate::project_store::{
            all_dormant, note_live_turns, turn_was_active, upsert, Started,
        };
        let conn = crate::project_store::open_in_memory();
        let meta = SessionMeta::default();
        let started = |session_id| Started {
            agent_id: "a",
            acp_session_id: "s",
            project_path: "/p",
            cwd: "/p",
            meta: &meta,
            can_reload: true,
            session_id,
            requested_at: chrono::Utc::now(),
        };
        upsert(&conn, &started("live-1"), chrono::Utc::now()).unwrap();
        assert!(!turn_was_active(&conn, "a", "s"));
        note_live_turns(&conn, &["live-1".to_string()]).unwrap();
        all_dormant(&conn, chrono::Utc::now()).unwrap();
        assert!(turn_was_active(&conn, "a", "s"));
        upsert(&conn, &started("live-2"), chrono::Utc::now()).unwrap();
        assert!(!turn_was_active(&conn, "a", "s"));
    }

    #[test]
    fn a_task_mid_turn_without_a_reloadable_session_fails() {
        let implementing = Some(TaskPhase::Implementing);
        let running = Some(PhaseStatus::Running);
        assert!(matches!(
            decide(
                1,
                implementing,
                running,
                None,
                &[row(1, false, false)],
                |_| false
            ),
            Some(Action::Fail(_))
        ));
        assert!(matches!(
            decide(
                1,
                implementing,
                running,
                None,
                &[row(1, true, true)],
                |_| false
            ),
            Some(Action::Fail(_))
        ));
    }
}
