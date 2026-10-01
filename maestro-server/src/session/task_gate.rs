//! A task session's permission requests and questions, as the app's reader settles them.
//!
//! A port of `handle_permission_request` in the app's `reader_task.rs`, so a task with no window
//! is not stopped by its first prompt. A stage that may write has its requests approved here and
//! never shown. A read-only stage that delivers a plan by asking to leave plan mode has the plan
//! taken as its artifact, the mode change refused and the session closed. Anything else marks the
//! task blocked and waits for a user, and the mark is cleared when one answers.

use maestro_protocol::{
    ApplyTaskTransitionRequest, EndTaskTurnRequest, ServerRequest, ServerResponse, Task, TaskPhase,
    TaskTransition, TransitionGuard, TurnEnding,
};
use serde_json::Value;

use crate::helpers::{broadcast, send_diag};
use crate::sessions::{SessionRouter, SharedSessionState};

/// What the daemon does with a task session's permission request, decided from the payload alone.
#[derive(Debug, PartialEq)]
pub(crate) enum Decision {
    /// Answer with this option.
    Allow(String),
    /// A read-only stage delivered this plan.
    Plan(String),
    /// Leave it to the user.
    Ask,
}

/// The phases that must not write, so the only ones a delivered plan concludes.
fn read_only(phase: Option<TaskPhase>) -> bool {
    matches!(
        phase,
        Some(TaskPhase::Refining | TaskPhase::Drafting | TaskPhase::SelfReview)
    )
}

/// The first option whose kind passes `test`.
fn option(payload: &Value, test: impl Fn(&str) -> bool) -> Option<String> {
    payload
        .get("options")?
        .as_array()?
        .iter()
        .find(|option| {
            option
                .get("kind")
                .and_then(Value::as_str)
                .is_some_and(&test)
        })?
        .get("optionId")?
        .as_str()
        .map(str::to_string)
}

/// `allow_always`, then `allow_once`, then any kind of allow.
fn allow_option(payload: &Value) -> Option<String> {
    option(payload, |kind| kind == "allow_always")
        .or_else(|| option(payload, |kind| kind == "allow_once"))
        .or_else(|| option(payload, |kind| kind.contains("allow")))
}

/// The plan a request to leave plan mode carries, by `rawInput.plan` rather than a tool name.
fn plan(payload: &Value) -> Option<String> {
    payload
        .get("toolCall")?
        .get("rawInput")?
        .get("plan")?
        .as_str()
        .map(str::trim)
        .filter(|plan| !plan.is_empty())
        .map(str::to_string)
}

/// Phase `None` is not read-only, as in the app: a task outside the pipeline is approved.
pub(crate) fn decide(phase: Option<TaskPhase>, payload: &Value) -> Decision {
    if !read_only(phase) {
        return allow_option(payload).map_or(Decision::Ask, Decision::Allow);
    }
    plan(payload).map_or(Decision::Ask, Decision::Plan)
}

/// Record the task a session works before its row is written, for a session the daemon prompts
/// itself before adopting it.
pub(crate) async fn bind(
    router: &SessionRouter,
    acp_session_id: &str,
    project_path: &str,
    task_id: i32,
) {
    if let Some((_, state)) = router.get_session(acp_session_id).await {
        let _ = state.task.set((project_path.to_string(), task_id));
    }
}

/// The task a session works, `None` when it works none or the daemon does not drive tasks.
pub(crate) async fn task_of(state: &SharedSessionState, session_id: &str) -> Option<(String, i32)> {
    if !crate::task_turn::DAEMON_DRIVES_TASKS {
        return None;
    }
    if let Some(task) = state.task.get() {
        return Some(task.clone());
    }
    let store = crate::project_store::SHARED.get()?;
    let conn = store.lock().await;
    conn.query_row(
        "SELECT project_path, task_id FROM sessions
         WHERE session_id = ?1 AND task_id IS NOT NULL",
        [session_id],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, i32>(1)?)),
    )
    .ok()
    .map(|(path, id)| (crate::automations::canonical_project_path(&path), id))
}

/// Write `request` to the store and push what it changed. The reply, `None` if it failed.
async fn write(request: ServerRequest, stdout: &crate::ClientOut) -> Option<ServerResponse> {
    let store = crate::project_store::SHARED.get()?;
    let answered = crate::task_store::requests::answer(&mut *store.lock().await, request);
    match answered {
        Ok((reply, pushes)) => {
            for push in pushes {
                broadcast(stdout, push).await;
            }
            Some(reply)
        }
        Err(e) => {
            send_diag("warn", format!("[task] {e}"));
            None
        }
    }
}

fn transition_request(
    (project_path, task_id): &(String, i32),
    event: TaskTransition,
    guard: TransitionGuard,
) -> ServerRequest {
    ServerRequest::ApplyTaskTransition(ApplyTaskTransitionRequest {
        project_path: project_path.clone(),
        task_id: *task_id,
        event,
        guard,
        update: None,
        comment: None,
    })
}

/// Move the task, under `guard`, and push the change.
pub(crate) async fn transition(
    task: &(String, i32),
    event: TaskTransition,
    guard: TransitionGuard,
    stdout: &crate::ClientOut,
) {
    write(transition_request(task, event, guard), stdout).await;
}

/// The user answered, so the agent is running again.
pub(crate) async fn unblock(task: &Option<(String, i32)>, stdout: &crate::ClientOut) {
    if let Some(task) = task {
        transition(
            task,
            TaskTransition::Unblocked,
            TransitionGuard::Blocked,
            stdout,
        )
        .await;
    }
}

/// Settle a task session's permission request. `Some(option)` is the answer to give the agent,
/// `None` an absent option, which refuses; the outer `None` leaves the request to the user, the task
/// already marked blocked.
pub(crate) async fn settle_permission(
    task: &(String, i32),
    session_id: &str,
    payload: &Value,
    stdout: &crate::ClientOut,
) -> Option<Option<String>> {
    let (project_path, task_id) = task;
    let phase = match crate::project_store::SHARED.get() {
        Some(store) => crate::task_store::get(&*store.lock().await, project_path, *task_id),
        None => Ok(None),
    };
    let decision = match phase {
        Ok(Some(stored)) => decide(stored.phase, payload),
        Ok(None) => Decision::Ask,
        Err(e) => {
            send_diag("warn", format!("[task] cannot read task {task_id}: {e}"));
            Decision::Ask
        }
    };
    match decision {
        Decision::Allow(option_id) => return Some(Some(option_id)),
        Decision::Plan(plan) => {
            if let Some(ended) = take_plan(task, plan, stdout).await {
                // After the transition, not before, so the close finds the task at its gate.
                if let Some(settle_tx) = crate::dispatch::SETTLE_TX.get() {
                    let next = crate::task_turn::next_stage(&ended)
                        .map(|role| (project_path.clone(), *task_id, role));
                    let _ = settle_tx.send(crate::dispatch::Settle::ArtifactTaken {
                        session_id: session_id.to_string(),
                        next,
                        stdout: std::sync::Arc::clone(stdout),
                    });
                }
                // An agent offering no refusal is cancelled rather than granted: the mode must not
                // change, and the session is closing anyway.
                return Some(option(payload, |kind| kind.contains("reject")));
            }
        }
        Decision::Ask => {}
    }
    // Before the request reaches a window, so a user's answer, which clears it, cannot overtake.
    transition(
        task,
        TaskTransition::AwaitingUserInput,
        TransitionGuard::Changed,
        stdout,
    )
    .await;
    None
}

/// End the read-only stage with its plan as the artifact. The task after, `None` if the store
/// refused, which it does outside a read-only phase.
async fn take_plan(
    (project_path, task_id): &(String, i32),
    plan: String,
    stdout: &crate::ClientOut,
) -> Option<Task> {
    let review_approved =
        crate::turn::classify_verdict(&plan) == crate::turn::ReviewVerdict::Approved;
    let request = ServerRequest::EndTaskTurn(EndTaskTurnRequest {
        project_path: project_path.clone(),
        task_id: *task_id,
        ending: TurnEnding::ArtifactDelivered,
        review_approved,
        closing_message: plan,
    });
    match write(request, stdout).await? {
        ServerResponse::EndTaskTurnOk(ended) => ended.task,
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn request(kinds: &[&str], plan: Option<&str>) -> Value {
        let options: Vec<Value> = kinds
            .iter()
            .map(|kind| json!({ "kind": kind, "optionId": format!("{kind}-id") }))
            .collect();
        json!({ "options": options, "toolCall": { "rawInput": { "plan": plan } } })
    }

    #[test]
    fn a_writing_phase_prefers_allow_always_then_allow_once_then_any_allow() {
        let phase = Some(TaskPhase::Implementing);
        let both = request(&["reject_once", "allow_once", "allow_always"], None);
        assert_eq!(
            decide(phase, &both),
            Decision::Allow("allow_always-id".into())
        );
        let once = request(&["reject_once", "allow_once"], None);
        assert_eq!(
            decide(phase, &once),
            Decision::Allow("allow_once-id".into())
        );
        let other = request(&["reject_once", "allow_for_session"], None);
        assert_eq!(
            decide(phase, &other),
            Decision::Allow("allow_for_session-id".into())
        );
        assert_eq!(
            decide(phase, &request(&["reject_once"], None)),
            Decision::Ask
        );
        assert_eq!(
            decide(None, &once),
            Decision::Allow("allow_once-id".into()),
            "a task outside the pipeline is approved, as the app does"
        );
    }

    #[test]
    fn a_read_only_phase_is_never_approved_and_concludes_on_a_plan() {
        for phase in [
            TaskPhase::Refining,
            TaskPhase::Drafting,
            TaskPhase::SelfReview,
        ] {
            let asking = request(&["allow_always", "reject_once"], None);
            assert_eq!(decide(Some(phase), &asking), Decision::Ask);
            let blank = request(&["allow_always"], Some("   "));
            assert_eq!(decide(Some(phase), &blank), Decision::Ask);
            let planned = request(&["allow_always", "reject_once"], Some("  the plan \n"));
            assert_eq!(
                decide(Some(phase), &planned),
                Decision::Plan("the plan".into())
            );
        }
        let refusal = request(&["allow_always", "reject_once"], Some("plan"));
        assert_eq!(
            option(&refusal, |kind| kind.contains("reject")),
            Some("reject_once-id".into())
        );
    }

    /// The mark and its clearing, as the store applies them: each only where it belongs.
    #[test]
    fn a_request_blocks_a_running_task_and_an_answer_unblocks_it() {
        use maestro_protocol::{
            AgentRole, BranchMode, CreateTaskRequest, PhaseStatus, WorkspaceMode,
        };

        let mut conn = crate::project_store::open_in_memory();
        let project = "/p".to_string();
        let created = crate::task_store::create(
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
        let task = (project.clone(), created.id);
        let mut apply = |event, guard| {
            crate::task_store::requests::answer(&mut conn, transition_request(&task, event, guard))
                .unwrap();
            crate::task_store::get(&conn, &project, created.id)
                .unwrap()
                .unwrap()
                .phase_status
        };
        let unblock = || (TaskTransition::Unblocked, TransitionGuard::Blocked);
        let block = || (TaskTransition::AwaitingUserInput, TransitionGuard::Changed);

        apply(TaskTransition::ExecutionStarted, TransitionGuard::Always);
        let running = apply(
            TaskTransition::SessionReady(AgentRole::Coder),
            TransitionGuard::Always,
        );
        assert_eq!(running, Some(PhaseStatus::Running));
        let (event, guard) = unblock();
        assert_eq!(
            apply(event, guard),
            running,
            "nothing to clear while running"
        );
        let (event, guard) = block();
        assert_eq!(apply(event, guard), Some(PhaseStatus::Blocked));
        let (event, guard) = unblock();
        assert_eq!(apply(event, guard), running);
    }

    #[test]
    fn a_plan_in_a_writing_phase_is_an_ordinary_request() {
        let planned = request(&["allow_once"], Some("plan"));
        assert_eq!(
            decide(Some(TaskPhase::Implementing), &planned),
            Decision::Allow("allow_once-id".into())
        );
        let unanswerable = request(&["reject_once"], Some("plan"));
        assert_eq!(
            decide(Some(TaskPhase::Implementing), &unanswerable),
            Decision::Ask
        );
    }
}
