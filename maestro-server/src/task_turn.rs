//! A task session's turn ended: what it means for the task, and the stage that runs next.
//!
//! A port of `resolve_turn_end` in the app's `reader_task.rs` and the hand-off in
//! `useAgentPipeline.ts`, so a task moves from coder to reviewer and back with no window open. The
//! git checks are local `git`, since the daemon runs on the machine the repository is on.

use std::sync::Arc;

use maestro_protocol::{
    AgentRole, ApplyTaskTransitionRequest, EndTaskTurnRequest, NewTaskComment, PhaseStatus,
    ServerRequest, ServerResponse, StartTaskRequest, Task, TaskBall, TaskPhase, TaskTransition,
    TaskUpdate, TransitionGuard, TurnEnding, WorkspaceMode,
};

use crate::helpers::{broadcast, send_diag};
use crate::turn::{classify_turn, classify_verdict, ReviewVerdict, TurnFacts, TurnOutcome};
use crate::worktree::git;

/// What a turn ending asks of the task, git already consulted.
#[derive(Debug, PartialEq)]
pub(crate) enum Resolution {
    Ignore,
    /// A CI fix finished on an open pull request: push it, nothing else moves.
    PushCiFix,
    End(TurnEnding),
}

/// The roles that write, and so the only ones the diff gate and the reviewer apply to.
fn writes(phase: Option<TaskPhase>) -> bool {
    matches!(
        phase,
        Some(TaskPhase::Implementing | TaskPhase::Rework | TaskPhase::AwaitingMerge)
    )
}

/// The decision, pure: `has_changes` and `reviewer_pending` are asked for by the caller.
pub(crate) fn decide(
    phase: Option<TaskPhase>,
    stop_reason: &str,
    facts: &TurnFacts,
    is_git_repo: bool,
    has_changes: Option<bool>,
    reviewer_pending: bool,
) -> Resolution {
    let outcome = classify_turn(
        stop_reason,
        facts.declared_complete,
        has_changes,
        facts.user_interrupted,
    );
    match outcome {
        TurnOutcome::Complete if phase == Some(TaskPhase::AwaitingMerge) => Resolution::PushCiFix,
        TurnOutcome::Complete => Resolution::End(TurnEnding::Completed {
            is_git_repo,
            has_changes,
            reviewer_pending: writes(phase) && reviewer_pending,
        }),
        TurnOutcome::Stalled => Resolution::End(TurnEnding::Stalled),
        TurnOutcome::Failed => Resolution::End(TurnEnding::Failed),
        TurnOutcome::Ignore => Resolution::Ignore,
    }
}

/// The role a task waiting on an agent asks for, as `useAgentPipeline` reads the board.
pub(crate) fn next_stage(task: &Task) -> Option<AgentRole> {
    if task.phase_status != Some(PhaseStatus::Waiting) || task.ball != TaskBall::Agent {
        return None;
    }
    match task.phase {
        Some(TaskPhase::SelfReview) => Some(AgentRole::Reviewer),
        Some(TaskPhase::Rework | TaskPhase::AwaitingMerge) => Some(AgentRole::Coder),
        _ => None,
    }
}

/// Whether a reviewer looks before the user: the project has one, the task did not turn it off,
/// and rounds remain.
fn reviewer_should_run(project_path: &str, task: &Task) -> bool {
    crate::turn::review_rounds_remain(task.review_rounds)
        && !crate::profiles::role_is_skipped(task.profile_overrides.as_deref(), AgentRole::Reviewer)
        && crate::profiles::has_profile_for_role(project_path, AgentRole::Reviewer)
}

/// The task's worktree folder and branch, `None` for a task working in the project itself.
fn task_worktree(
    conn: &rusqlite::Connection,
    project_path: &str,
    task_id: i32,
) -> Option<(String, String)> {
    crate::task_store::worktrees::list(conn, project_path, Some(task_id))
        .ok()?
        .into_iter()
        .next()
        .map(|w| {
            (
                crate::worktree::absolute(project_path, &w.path),
                w.branch_name,
            )
        })
}

/// Whether the agent changed anything since `execution_start_sha`, tracked or untracked. `None`
/// when that cannot be established, which `classify_turn` reads as no evidence.
async fn has_changes(project_path: &str, task: &Task, worktree: Option<&str>) -> Option<bool> {
    // An isolated task without its worktree row must not be measured against the project root,
    // whose unrelated dirt would read as this agent's work.
    if task.workspace_mode != WorkspaceMode::RepositoryDirectory && worktree.is_none() {
        return None;
    }
    let start = task
        .execution_start_sha
        .as_deref()
        .filter(|s| !s.is_empty())?;
    let dir = worktree.unwrap_or(project_path);
    let tracked = git(dir, &["diff", "--name-only", start]).await;
    let untracked = git(dir, &["ls-files", "--others", "--exclude-standard"]).await;
    match (tracked, untracked) {
        (Ok(t), Ok(u)) => Some(!t.trim().is_empty() || !u.trim().is_empty()),
        (Err(e), _) | (_, Err(e)) => {
            send_diag(
                "warn",
                format!("[task] diff gate for task {}: {e}", task.id),
            );
            None
        }
    }
}

/// Push `branch` from `dir` to the project's configured remote, else the one it tracks, else
/// `origin`.
pub(crate) async fn push_branch(
    dir: &str,
    branch: &str,
    configured: Option<String>,
) -> Result<(), String> {
    let remote = match configured {
        Some(remote) => remote,
        None => git(
            dir,
            &["config", "--get", &format!("branch.{branch}.remote")],
        )
        .await
        .ok()
        .map(|r| r.trim().to_string())
        .filter(|r| !r.is_empty())
        .unwrap_or_else(|| "origin".to_string()),
    };
    git(dir, &["push", "--set-upstream", &remote, branch])
        .await
        .map(|_| ())
}

fn store_write(
    conn: &mut rusqlite::Connection,
    request: ServerRequest,
    pushes: &mut Vec<ServerResponse>,
) -> Result<ServerResponse, String> {
    let (reply, more) = crate::task_store::requests::answer(conn, request)?;
    pushes.extend(more);
    Ok(reply)
}

fn transition(
    project_path: &str,
    task_id: i32,
    event: TaskTransition,
    guard: TransitionGuard,
    update: Option<TaskUpdate>,
    comment: Option<NewTaskComment>,
) -> ServerRequest {
    ServerRequest::ApplyTaskTransition(ApplyTaskTransitionRequest {
        project_path: project_path.to_string(),
        task_id,
        event,
        guard,
        update,
        comment,
    })
}

/// Resolve the turn and write it. Returns the stage to start next, if any, and the pushes owed.
pub(crate) async fn resolve(
    store: &crate::project_store::Store,
    project_path: &str,
    task_id: i32,
    stop_reason: &str,
    facts: TurnFacts,
) -> (Option<AgentRole>, Vec<ServerResponse>) {
    let mut pushes = Vec::new();
    // A window-loaded session's binding holds the app's spelling of the path.
    let project_path = &crate::automations::canonical_project_path(project_path);
    let is_git_repo = crate::worktree::is_repository(project_path).await;
    let (task, worktree) = {
        let conn = store.lock().await;
        match crate::task_store::get(&conn, project_path, task_id) {
            Ok(Some(task)) => (task, task_worktree(&conn, project_path, task_id)),
            Ok(None) => return (None, pushes),
            Err(e) => {
                send_diag("warn", format!("[task] cannot read task {task_id}: {e}"));
                return (None, pushes);
            }
        }
    };

    let has_changes = if !facts.user_interrupted
        && writes(task.phase)
        && is_git_repo
        && stop_reason == "end_turn"
    {
        has_changes(project_path, &task, worktree.as_ref().map(|w| w.0.as_str())).await
    } else {
        None
    };
    let resolution = decide(
        task.phase,
        stop_reason,
        &facts,
        is_git_repo,
        has_changes,
        reviewer_should_run(project_path, &task),
    );

    let request = match resolution {
        Resolution::Ignore => return (None, pushes),
        Resolution::PushCiFix => {
            let pushed = match &worktree {
                Some((dir, branch)) => {
                    push_branch(dir, branch, crate::profiles::remote_name(project_path)).await
                }
                None => Err(format!("no worktree for task {task_id}")),
            };
            match pushed {
                // The verdict that asked for the fix must not outlive it.
                Ok(()) => transition(
                    project_path,
                    task_id,
                    TaskTransition::CiFixPushed,
                    TransitionGuard::Always,
                    Some(TaskUpdate {
                        pull_request_ci: Some(None),
                        ..Default::default()
                    }),
                    None,
                ),
                Err(e) => transition(
                    project_path,
                    task_id,
                    TaskTransition::PhaseFailed,
                    TransitionGuard::Active,
                    None,
                    Some(NewTaskComment {
                        kind: "note".to_string(),
                        author: "maestro".to_string(),
                        body: Some(format!("The CI fix could not be pushed: {e}")),
                        external_ref: None,
                        phase: Some("AwaitingMerge".to_string()),
                    }),
                ),
            }
        }
        Resolution::End(ending) => {
            let closing_message = facts.closing_message.unwrap_or_default();
            ServerRequest::EndTaskTurn(EndTaskTurnRequest {
                project_path: project_path.to_string(),
                task_id,
                ending,
                review_approved: classify_verdict(&closing_message) == ReviewVerdict::Approved,
                closing_message,
            })
        }
    };

    let written = store_write(&mut *store.lock().await, request, &mut pushes);
    let task = match written {
        Ok(ServerResponse::EndTaskTurnOk(ended)) => ended.task,
        Ok(ServerResponse::ApplyTaskTransitionOk(applied)) => applied.task,
        Ok(_) => None,
        Err(e) => {
            send_diag("warn", format!("[task] turn end of task {task_id}: {e}"));
            None
        }
    };
    (task.as_ref().and_then(next_stage), pushes)
}

/// What starting the next stage off the loop needs.
pub(crate) struct Driver {
    pub store: crate::project_store::Store,
    pub agent_connections: crate::sessions::SharedAgentConnections,
    pub settle_tx: crate::dispatch::SettleTx,
    pub stdout: crate::ClientOut,
    pub agents: Vec<crate::agent::registry::DiscoveredAgentWithSpawn>,
}

/// Resolve a task session's turn end off the main loop. What follows is the drain's to start.
pub(crate) fn spawn(
    driver: Driver,
    project_path: String,
    task_id: i32,
    stop_reason: String,
    facts: TurnFacts,
) {
    // Each step boxed, so the spawned future stays small: it is built on the main thread's stack.
    tokio::spawn(async move {
        let everyone = crate::client_sink::ClientSink::everyone(&driver.stdout).await;
        let (_, pushes) = Box::pin(resolve(
            &driver.store,
            &project_path,
            task_id,
            &stop_reason,
            facts,
        ))
        .await;
        for push in pushes {
            broadcast(&everyone, push).await;
        }
        // The drain starts the hand-off, as it does after any write that leaves one: one driver,
        // so a stage is never started twice.
        crate::scheduler::request_drain(&project_path);
    });
}

/// Start the stage a task waiting on an agent asks for.
pub(crate) async fn start_next(
    mut driver: Driver,
    everyone: &crate::ClientOut,
    project_path: String,
    task_id: i32,
    role: AgentRole,
) {
    crate::agent::registry::apply_custom_agents(&mut driver.agents);
    let request = StartTaskRequest {
        project_path,
        task_id,
        role,
        feedback: None,
        unattended: true,
        // The session handing over is superseded by this one, so the slot is the same.
        respect_capacity: false,
        agent_id: None,
    };
    let mut pushes = Vec::new();
    let begun = crate::task_runner::begin(
        &mut *driver.store.lock().await,
        &request,
        0,
        &driver.agents,
        &mut pushes,
    );
    for push in pushes {
        broadcast(everyone, push).await;
    }
    match begun {
        Ok(crate::task_runner::Begun::Claimed(claimed)) => {
            // Nobody asked, so the one reply goes to a client that does not exist.
            let reply = crate::client_sink::ClientSink::for_client(&driver.stdout, u64::MAX).await;
            Box::pin(crate::task_runner::launch(
                crate::task_runner::Launcher {
                    store: Arc::clone(&driver.store),
                    agent_connections: driver.agent_connections,
                    settle_tx: driver.settle_tx,
                    reply,
                },
                claimed,
            ))
            .await;
        }
        Ok(crate::task_runner::Begun::Deferred) => {}
        Err(e) => send_diag("warn", format!("[task] next stage of task {task_id}: {e}")),
    }
}

/// A task session died with its agent: fail the task if an agent was still working it.
pub(crate) async fn fail_if_still_running(
    store: &crate::project_store::Store,
    stdout: &crate::ClientOut,
    project_path: &str,
    task_id: i32,
) {
    apply(
        store,
        stdout,
        project_path,
        task_id,
        TaskTransition::PhaseFailed,
        TransitionGuard::AgentRunning,
        None,
    )
    .await;
}

/// One guarded transition, written and pushed.
async fn apply(
    store: &crate::project_store::Store,
    stdout: &crate::ClientOut,
    project_path: &str,
    task_id: i32,
    event: TaskTransition,
    guard: TransitionGuard,
    comment: Option<NewTaskComment>,
) {
    let mut pushes = Vec::new();
    let request = transition(project_path, task_id, event, guard, None, comment);
    if let Err(e) = store_write(&mut *store.lock().await, request, &mut pushes) {
        send_diag("warn", format!("[task] cannot move task {task_id}: {e}"));
    }
    let everyone = crate::client_sink::ClientSink::everyone(stdout).await;
    for push in pushes {
        broadcast(&everyone, push).await;
    }
}

/// The task a session works, with its project path canonical.
pub(crate) fn task_of(session: &crate::sessions::ActiveSession) -> Option<(String, i32)> {
    let binding = session.project.as_ref()?;
    Some((
        crate::automations::canonical_project_path(&binding.project_path),
        binding.meta.task_id?,
    ))
}

/// What a window did to a task's session: a prompt answers a blocked task, a close ends the stage
/// it was running. Off the loop, which must not wait on the store.
pub(crate) fn window_acted(
    store: &crate::project_store::Store,
    stdout: &crate::ClientOut,
    task: (String, i32),
    closed: bool,
) {
    let (store, stdout) = (Arc::clone(store), Arc::clone(stdout));
    tokio::spawn(Box::pin(async move {
        on_window_action(&store, &stdout, task, closed).await;
    }));
}

async fn on_window_action(
    store: &crate::project_store::Store,
    stdout: &crate::ClientOut,
    (project_path, task_id): (String, i32),
    closed: bool,
) {
    let (event, guard, comment) = if closed {
        (
            TaskTransition::PhaseFailed,
            TransitionGuard::AgentRunning,
            Some(NewTaskComment {
                kind: "note".to_string(),
                author: "maestro".to_string(),
                body: Some("The session was ended while the agent was still working.".to_string()),
                external_ref: None,
                phase: None,
            }),
        )
    } else {
        (TaskTransition::Unblocked, TransitionGuard::Blocked, None)
    };
    apply(store, stdout, &project_path, task_id, event, guard, comment).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use maestro_protocol::{BranchMode, CreateTaskRequest};

    fn facts(declared_complete: bool, closing: &str) -> TurnFacts {
        TurnFacts {
            declared_complete,
            user_interrupted: false,
            closing_message: Some(closing.to_string()),
        }
    }

    #[test]
    fn decide_reads_the_turn() {
        let done = facts(true, "done");
        assert_eq!(
            decide(
                Some(TaskPhase::Implementing),
                "end_turn",
                &done,
                true,
                Some(true),
                true
            ),
            Resolution::End(TurnEnding::Completed {
                is_git_repo: true,
                has_changes: Some(true),
                reviewer_pending: true,
            })
        );
        // A reviewer finishing writes nothing, so no reviewer follows it.
        assert_eq!(
            decide(
                Some(TaskPhase::SelfReview),
                "end_turn",
                &done,
                true,
                None,
                true
            ),
            Resolution::End(TurnEnding::Completed {
                is_git_repo: true,
                has_changes: None,
                reviewer_pending: false,
            })
        );
        let quiet = facts(false, "a question?");
        assert_eq!(
            decide(
                Some(TaskPhase::Implementing),
                "end_turn",
                &quiet,
                true,
                Some(false),
                true
            ),
            Resolution::End(TurnEnding::Stalled)
        );
        assert_eq!(
            decide(
                Some(TaskPhase::Implementing),
                "error",
                &quiet,
                true,
                None,
                false
            ),
            Resolution::End(TurnEnding::Failed)
        );
        assert_eq!(
            decide(
                Some(TaskPhase::AwaitingMerge),
                "end_turn",
                &done,
                true,
                None,
                false
            ),
            Resolution::PushCiFix
        );
        let interrupted = TurnFacts {
            user_interrupted: true,
            ..done
        };
        assert_eq!(
            decide(
                Some(TaskPhase::Implementing),
                "end_turn",
                &interrupted,
                true,
                None,
                false
            ),
            Resolution::Ignore
        );
    }

    fn setup(reviewer: bool) -> (tempfile::TempDir, String, crate::project_store::Store, i32) {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join(".maestro")).unwrap();
        // A repository, or a completed turn closes the task as Done.
        assert!(std::process::Command::new("git")
            .arg("init")
            .current_dir(dir.path())
            .output()
            .unwrap()
            .status
            .success());
        if reviewer {
            std::fs::write(
                dir.path().join(".maestro/profiles.json"),
                r#"{"profiles":[{"id":"r","name":"Reviewer","role":"Reviewer","agent_id":"fake"}]}"#,
            )
            .unwrap();
        }
        let project = crate::automations::canonical_project_path(&dir.path().to_string_lossy());
        let mut conn = crate::project_store::open_in_memory();
        let task = crate::task_store::create(
            &mut conn,
            &CreateTaskRequest {
                project_path: project.clone(),
                title: "Fix login".to_string(),
                description: None,
                skills: vec![],
                labels: vec![],
                base_branch: "main".to_string(),
                agent_id: None,
                priority: None,
                auto_approve: false,
                workspace_mode: WorkspaceMode::RepositoryDirectory,
                workspace_worktree_id: None,
                workspace_branch_mode: BranchMode::Create,
                workspace_branch: None,
                model_override: None,
            },
        )
        .unwrap();
        let mut pushes = Vec::new();
        for (event, guard) in [
            (TaskTransition::ExecutionStarted, TransitionGuard::Always),
            (
                TaskTransition::SessionReady(AgentRole::Coder),
                TransitionGuard::Always,
            ),
        ] {
            store_write(
                &mut conn,
                transition(&project, task.id, event, guard, None, None),
                &mut pushes,
            )
            .unwrap();
        }
        (
            dir,
            project,
            Arc::new(tokio::sync::Mutex::new(conn)),
            task.id,
        )
    }

    #[tokio::test]
    async fn a_coder_done_with_a_reviewer_profile_hands_to_the_reviewer() {
        let (_dir, project, store, id) = setup(true);
        let (next, pushes) = resolve(&store, &project, id, "end_turn", facts(true, "done")).await;
        assert_eq!(next, Some(AgentRole::Reviewer));
        assert!(!pushes.is_empty());
    }

    #[tokio::test]
    async fn a_coder_done_without_one_goes_to_the_user() {
        let (_dir, project, store, id) = setup(false);
        let (next, _) = resolve(&store, &project, id, "end_turn", facts(true, "done")).await;
        assert_eq!(next, None);
    }

    #[tokio::test]
    async fn a_turn_end_resolves_the_path_a_window_spelled() {
        let (dir, _, store, id) = setup(true);
        let raw = format!("{}/", dir.path().to_string_lossy());
        let (next, _) = resolve(&store, &raw, id, "end_turn", facts(true, "done")).await;
        assert_eq!(next, Some(AgentRole::Reviewer));
    }

    #[tokio::test]
    async fn a_dead_agent_fails_a_running_task() {
        let (_dir, project, store, id) = setup(false);
        fail_if_still_running(
            &store,
            &crate::client_sink::ClientSink::detached(),
            &project,
            id,
        )
        .await;
        let task = crate::task_store::get(&*store.lock().await, &project, id)
            .unwrap()
            .unwrap();
        assert_eq!(task.phase_status, Some(PhaseStatus::Failed));
    }

    #[tokio::test]
    async fn a_prompt_unblocks_and_a_close_fails_with_a_note() {
        let (_dir, project, store, id) = setup(false);
        let out = crate::client_sink::ClientSink::detached();
        let get = |conn: &rusqlite::Connection| {
            crate::task_store::get(conn, &project, id).unwrap().unwrap()
        };
        // A prompt to a running task changes nothing.
        on_window_action(&store, &out, (project.clone(), id), false).await;
        assert_eq!(
            get(&*store.lock().await).phase_status,
            Some(PhaseStatus::Running)
        );

        store_write(
            &mut *store.lock().await,
            transition(
                &project,
                id,
                TaskTransition::AwaitingUserInput,
                TransitionGuard::Always,
                None,
                None,
            ),
            &mut Vec::new(),
        )
        .unwrap();
        assert_eq!(
            get(&*store.lock().await).phase_status,
            Some(PhaseStatus::Blocked)
        );
        on_window_action(&store, &out, (project.clone(), id), false).await;
        assert_eq!(
            get(&*store.lock().await).phase_status,
            Some(PhaseStatus::Running)
        );

        on_window_action(&store, &out, (project.clone(), id), true).await;
        let conn = store.lock().await;
        assert_eq!(get(&conn).phase_status, Some(PhaseStatus::Failed));
        let notes = crate::task_store::list_comments(&conn, &project, id).unwrap();
        assert!(notes
            .iter()
            .any(|c| c.body.as_deref().is_some_and(|b| b.contains("was ended"))));
    }

    #[tokio::test]
    async fn a_ci_fix_is_pushed_to_the_configured_remote_else_origin() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().to_string();
        let remote = format!("{root}/remote.git");
        let repo = format!("{root}/repo");
        git(&root, &["init", "--bare", &remote]).await.unwrap();
        git(&root, &["init", "-b", "fix", &repo]).await.unwrap();
        for args in [
            &["config", "user.email", "t@t"][..],
            &["config", "user.name", "t"],
            &["commit", "--allow-empty", "-m", "fix"],
            &["remote", "add", "origin", &remote],
        ] {
            git(&repo, args).await.unwrap();
        }
        push_branch(&repo, "fix", None).await.unwrap();
        let heads = git(&remote, &["branch", "--list", "fix"]).await.unwrap();
        assert!(heads.contains("fix"));

        let fork = format!("{root}/fork.git");
        git(&root, &["init", "--bare", &fork]).await.unwrap();
        git(&repo, &["remote", "add", "fork", &fork]).await.unwrap();
        push_branch(&repo, "fix", Some("fork".to_string()))
            .await
            .unwrap();
        let heads = git(&fork, &["branch", "--list", "fix"]).await.unwrap();
        assert!(heads.contains("fix"));
    }
}
