//! A loop task's checks, iterations, hidden files and controls, each one round trip to the daemon
//! that runs the loop (`maestro-server/src/loop_engine.rs`). See `docs/loops-plan.md`.

use std::sync::Arc;

use maestro_protocol::{
    AnswerLoopProposalRequest, NewTaskComment, OpenAgentGateRequest, SetLoopChecksRequest,
    SetLoopHiddenFilesRequest, TaskRef, TaskTransition, TickLoopCheckRequest, TransitionGuard,
};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use specta::Type;
use tauri::State;

use crate::acp::connection_server::{query_project_store, reply};
use crate::acp::transport::{ServerRequest, ServerResponse};
use crate::core::AppState;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[specta(export)]
pub enum LoopCheckKind {
    Command,
    Judge,
    Manual,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[specta(export)]
pub enum LoopCheckState {
    Pending,
    Pass,
    Fail,
    Flaky,
}

/// One item of a loop's done criteria.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct LoopCheck {
    pub id: i32,
    pub position: i32,
    pub kind: LoopCheckKind,
    pub label: String,
    #[specta(optional)]
    pub command: Option<String>,
    pub state: LoopCheckState,
    /// The last output tail, or the judge's reason.
    #[specta(optional)]
    pub detail: Option<String>,
    /// Proposed by the agent. Waiting for the user while `accepted` is false.
    pub proposed: bool,
    pub accepted: bool,
    #[specta(optional)]
    pub passed_at_sha: Option<String>,
    pub updated_at: String,
}

/// What the user writes of a check.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct LoopCheckSpec {
    pub kind: LoopCheckKind,
    pub label: String,
    #[specta(optional)]
    pub command: Option<String>,
}

/// One check of the user's list: `id` keeps a check, none adds one.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct LoopCheckEntry {
    #[specta(optional)]
    pub id: Option<i32>,
    pub kind: LoopCheckKind,
    pub label: String,
    #[specta(optional)]
    pub command: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[specta(export)]
pub enum LoopIterationOutcome {
    Running,
    Checked,
    Interrupted,
    Empty,
    Failed,
    Blocked,
}

/// One attempt at one iteration.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct LoopIteration {
    pub n: i32,
    pub attempt: i32,
    #[specta(optional)]
    pub acp_session_id: Option<String>,
    #[specta(optional)]
    pub agent_id: Option<String>,
    pub started_at: String,
    #[specta(optional)]
    pub ended_at: Option<String>,
    pub outcome: LoopIterationOutcome,
    pub counted: bool,
    pub touched_sealed: bool,
    #[specta(optional)]
    pub commit_sha: Option<String>,
    pub files: i32,
    pub added: i32,
    pub removed: i32,
    #[specta(optional)]
    pub summary: Option<String>,
    #[specta(optional)]
    pub check_output: Option<String>,
    pub peeks: Vec<String>,
    #[specta(optional)]
    pub tokens: Option<i64>,
    /// Why the worker said it cannot go on.
    #[specta(optional)]
    pub blocked: Option<String>,
}

/// An acceptance file that exists only in the loop's record, never in the repository.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct LoopHiddenFile {
    pub path: String,
    pub content: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[specta(export)]
pub enum LoopHalt {
    Flaky,
    Failing,
    Stalled,
    OutOfIterations,
    Paused,
    Stopped,
    Blocked,
    Conflict,
}

/// The automation run whose agent created a task.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct TaskDraft {
    pub automation: String,
    #[specta(optional)]
    pub run: Option<u32>,
}

/// A loop as its card and its detail's meters show it, read with the task.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct LoopSummary {
    pub iteration: i32,
    pub counted: i32,
    pub agent_secs: i64,
    pub no_change: i32,
    #[specta(optional)]
    pub last_summary: Option<String>,
    pub checks: Vec<LoopCheckState>,
    pub proposals: i32,
    /// Why it last stopped for the user. Read only while it waits on the user.
    #[specta(optional)]
    pub halt: Option<LoopHalt>,
    /// A pause or stop asked for, taken once the running step ends.
    #[specta(optional)]
    pub hold: Option<LoopHalt>,
}

/// An agent's closed usage-limit gate, which a waiting task is held by.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct AgentGateState {
    pub agent_id: String,
    pub resume_at: String,
    /// `five_hour` or `seven_day...`, when the agent named it.
    #[specta(optional)]
    pub window: Option<String>,
    /// No reset time was known: the gate tries again at `resume_at`.
    pub backoff: bool,
}

// ponytail: these types share their wire twin's serde shape, so one JSON round trip converts them
// instead of a `From` per field. A shape that drifts fails here loudly, not silently.
/// The app's mirror of a wire value.
pub(crate) fn mirror<A: Serialize, B: DeserializeOwned>(value: A) -> Result<B, String> {
    serde_json::to_value(value)
        .and_then(serde_json::from_value)
        .map_err(|e| format!("A loop row did not convert: {e}"))
}

fn mirror_all<A: Serialize, B: DeserializeOwned>(values: Vec<A>) -> Result<Vec<B>, String> {
    values.into_iter().map(mirror).collect()
}

/// A loop's checks in list order, proposals included.
#[tauri::command]
#[specta::specta]
pub async fn list_loop_checks(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    task_id: i32,
) -> Result<Vec<LoopCheck>, String> {
    let checks = query_project_store(
        &app_state,
        project_id,
        |project_path| {
            ServerRequest::ListLoopChecks(TaskRef {
                project_path,
                task_id,
            })
        },
        reply!(ServerResponse::ListLoopChecksOk(list) => list.checks),
    )
    .await?;
    mirror_all(checks)
}

/// The user's whole list. A kept check whose spec changed is pending again; proposals waiting
/// for an answer are left alone.
#[tauri::command]
#[specta::specta]
pub async fn set_loop_checks(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    task_id: i32,
    checks: Vec<LoopCheckEntry>,
) -> Result<Vec<LoopCheck>, String> {
    let checks = mirror_all(checks)?;
    let checks = query_project_store(
        &app_state,
        project_id,
        |project_path| {
            ServerRequest::SetLoopChecks(SetLoopChecksRequest {
                project_path,
                task_id,
                checks,
            })
        },
        reply!(ServerResponse::SetLoopChecksOk(list) => list.checks),
    )
    .await?;
    mirror_all(checks)
}

/// Accept a proposed check as `accept`, sealing `seal`, or reject it with `None`.
#[tauri::command]
#[specta::specta]
pub async fn answer_loop_proposal(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    task_id: i32,
    check_id: i32,
    accept: Option<LoopCheckSpec>,
    seal: Vec<String>,
) -> Result<Vec<LoopCheck>, String> {
    let accept = accept.map(mirror).transpose()?;
    let checks = query_project_store(
        &app_state,
        project_id,
        |project_path| {
            ServerRequest::AnswerLoopProposal(AnswerLoopProposalRequest {
                project_path,
                task_id,
                check_id,
                accept,
                seal,
            })
        },
        reply!(ServerResponse::AnswerLoopProposalOk(list) => list.checks),
    )
    .await?;
    mirror_all(checks)
}

/// Tick or untick a manual check.
#[tauri::command]
#[specta::specta]
pub async fn tick_loop_check(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    task_id: i32,
    check_id: i32,
    ticked: bool,
) -> Result<Vec<LoopCheck>, String> {
    let checks = query_project_store(
        &app_state,
        project_id,
        |project_path| {
            ServerRequest::TickLoopCheck(TickLoopCheckRequest {
                project_path,
                task_id,
                check_id,
                ticked,
            })
        },
        reply!(ServerResponse::TickLoopCheckOk(list) => list.checks),
    )
    .await?;
    mirror_all(checks)
}

/// Oldest first.
#[tauri::command]
#[specta::specta]
pub async fn list_loop_iterations(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    task_id: i32,
) -> Result<Vec<LoopIteration>, String> {
    let iterations = query_project_store(
        &app_state,
        project_id,
        |project_path| {
            ServerRequest::ListLoopIterations(TaskRef {
                project_path,
                task_id,
            })
        },
        reply!(ServerResponse::ListLoopIterationsOk(list) => list.iterations),
    )
    .await?;
    mirror_all(iterations)
}

#[tauri::command]
#[specta::specta]
pub async fn list_loop_hidden_files(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    task_id: i32,
) -> Result<Vec<LoopHiddenFile>, String> {
    let files = query_project_store(
        &app_state,
        project_id,
        |project_path| {
            ServerRequest::ListLoopHiddenFiles(TaskRef {
                project_path,
                task_id,
            })
        },
        reply!(ServerResponse::ListLoopHiddenFilesOk(list) => list.files),
    )
    .await?;
    mirror_all(files)
}

/// The whole set, replacing what was there.
#[tauri::command]
#[specta::specta]
pub async fn set_loop_hidden_files(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    task_id: i32,
    files: Vec<LoopHiddenFile>,
) -> Result<Vec<LoopHiddenFile>, String> {
    let files = mirror_all(files)?;
    let files = query_project_store(
        &app_state,
        project_id,
        |project_path| {
            ServerRequest::SetLoopHiddenFiles(SetLoopHiddenFilesRequest {
                project_path,
                task_id,
                files,
            })
        },
        reply!(ServerResponse::SetLoopHiddenFilesOk(list) => list.files),
    )
    .await?;
    mirror_all(files)
}

/// Take the sealed snapshot again and run the checks on the loop's commit. Not an iteration.
#[tauri::command]
#[specta::specta]
pub async fn rerun_loop_checks(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    task_id: i32,
) -> Result<(), String> {
    query_project_store(
        &app_state,
        project_id,
        |project_path| {
            ServerRequest::RerunLoopChecks(TaskRef {
                project_path,
                task_id,
            })
        },
        reply!(ServerResponse::RerunLoopChecksOk => ()),
    )
    .await
}

/// The worker's `.maestro/loop/PROGRESS.md`, as it stands in the loop's worktree.
#[tauri::command]
#[specta::specta]
pub async fn read_loop_notes(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    task_id: i32,
) -> Result<Option<String>, String> {
    query_project_store(
        &app_state,
        project_id,
        |project_path| {
            ServerRequest::ReadLoopNotes(TaskRef {
                project_path,
                task_id,
            })
        },
        reply!(ServerResponse::ReadLoopNotesOk(notes) => notes.content),
    )
    .await
}

/// Hold the loop for the user once the running iteration and its checks end.
#[tauri::command]
#[specta::specta]
pub async fn pause_loop(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    task_id: i32,
) -> Result<(), String> {
    query_project_store(
        &app_state,
        project_id,
        |project_path| {
            ServerRequest::PauseLoop(TaskRef {
                project_path,
                task_id,
            })
        },
        reply!(ServerResponse::PauseLoopOk => ()),
    )
    .await
}

/// Halt the loop where it is. A running iteration is cut and its work kept, uncounted.
#[tauri::command]
#[specta::specta]
pub async fn stop_loop(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    task_id: i32,
) -> Result<(), String> {
    stop_loop_on_server(&app_state, project_id, task_id).await
}

pub(crate) async fn stop_loop_on_server(
    app_state: &Arc<AppState>,
    project_id: i32,
    task_id: i32,
) -> Result<(), String> {
    query_project_store(
        app_state,
        project_id,
        |project_path| {
            ServerRequest::StopLoop(TaskRef {
                project_path,
                task_id,
            })
        },
        reply!(ServerResponse::StopLoopOk => ()),
    )
    .await
}

/// Start a loop that is not running over from scratch, parked in Planning or Queue: its branch
/// back to where the loop started, its iterations and check results gone.
#[tauri::command]
#[specta::specta]
pub async fn restart_loop(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    task_id: i32,
    status: crate::task::models::TaskStatus,
) -> Result<(), String> {
    query_project_store(
        &app_state,
        project_id,
        |project_path| {
            ServerRequest::RestartLoop(maestro_protocol::RestartLoopRequest {
                project_path,
                task_id,
                status: status.into(),
            })
        },
        reply!(ServerResponse::RestartLoopOk => ()),
    )
    .await
}

/// A note for the next iteration. The one running is not interrupted.
#[tauri::command]
#[specta::specta]
pub async fn add_loop_note(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    task_id: i32,
    body: String,
) -> Result<(), String> {
    let comment = steer(&body)?;
    query_project_store(
        &app_state,
        project_id,
        |project_path| {
            ServerRequest::AddTaskComment(maestro_protocol::AddTaskCommentRequest {
                project_path,
                task_id,
                comment,
            })
        },
        reply!(ServerResponse::AddTaskCommentOk(_) => ()),
    )
    .await
}

/// Let a stopped loop, or one at sign-off, go on, with an optional note for its next iteration.
/// Its stall streak counts from here.
#[tauri::command]
#[specta::specta]
pub async fn resume_loop(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    task_id: i32,
    note: Option<String>,
) -> Result<(), String> {
    let comment = match note.as_deref().map(str::trim) {
        Some(body) if !body.is_empty() => Some(steer(body)?),
        _ => None,
    };
    let resumed = crate::task::ops::apply_transition_writing(
        &app_state,
        project_id,
        task_id,
        TaskTransition::LoopResumed,
        TransitionGuard::Ball(maestro_protocol::TaskBall::User),
        None,
        comment,
    )
    .await?;
    match resumed {
        Some(_) => Ok(()),
        None => Err("This loop is not waiting on you".to_string()),
    }
}

/// Open an agent's usage-limit gate now, so its waiting tasks start ("Try now").
#[tauri::command]
#[specta::specta]
pub async fn open_agent_gate(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    agent_id: String,
) -> Result<(), String> {
    query_project_store(
        &app_state,
        project_id,
        |_| ServerRequest::OpenAgentGate(OpenAgentGateRequest { agent_id }),
        reply!(ServerResponse::OpenAgentGateOk => ()),
    )
    .await
}

/// Which of `candidates`, relative paths a check command names, exist on `base_branch`: the paths
/// a loop can seal, since the checks take sealed files from there.
#[tauri::command]
#[specta::specta]
pub async fn loop_sealable_paths(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    base_branch: String,
    candidates: Vec<String>,
) -> Result<Vec<String>, String> {
    if candidates.is_empty() {
        return Ok(Vec::new());
    }
    let (project, git_conn) =
        crate::core::get_project_with_git_conn(&app_state, project_id).await?;
    let base = match base_branch.trim() {
        "" => "HEAD",
        base => base,
    };
    let mut args = vec!["ls-tree", "--name-only", base, "--"];
    let trimmed: Vec<&str> = candidates.iter().map(|c| c.trim_end_matches('/')).collect();
    args.extend(trimmed.iter().copied());
    let listed = crate::git::run_git_in_dir_lossy(&git_conn, &project.path, &args).await?;
    let found: Vec<&str> = listed.lines().map(str::trim).collect();
    Ok(candidates
        .into_iter()
        .filter(|c| found.contains(&c.trim_end_matches('/')))
        .collect())
}

fn steer(body: &str) -> Result<NewTaskComment, String> {
    let body = body.trim();
    if body.is_empty() {
        return Err("A note cannot be empty".to_string());
    }
    Ok(NewTaskComment {
        kind: "steer".to_string(),
        author: "user".to_string(),
        body: Some(body.to_string()),
        external_ref: None,
        phase: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_check_entry_and_an_iteration_survive_the_trip_to_the_wire_and_back() {
        let entry = LoopCheckEntry {
            id: Some(3),
            kind: LoopCheckKind::Command,
            label: "Tests pass".to_string(),
            command: Some("bun run test".to_string()),
        };
        let wire: maestro_protocol::LoopCheckEntry = mirror(entry).unwrap();
        assert_eq!(wire.id, Some(3));
        assert_eq!(wire.spec.command.as_deref(), Some("bun run test"));

        let summary = maestro_protocol::LoopSummary {
            iteration: 2,
            halt: Some(maestro_protocol::LoopHalt::OutOfIterations),
            checks: vec![maestro_protocol::LoopCheckState::Flaky],
            ..Default::default()
        };
        let app: LoopSummary = mirror(summary).unwrap();
        assert_eq!(app.halt, Some(LoopHalt::OutOfIterations));
        assert_eq!(app.checks, [LoopCheckState::Flaky]);
    }
}
