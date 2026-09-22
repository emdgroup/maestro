//! Automations: an agent this project runs on its own, for work nobody should have to file a task
//! for.
//!
//! An automation is not a task and does not enter the pipeline. It is a prompt, an agent to run it
//! and a workspace to run it in; what the run *produces* — a file, a commit, a pull request, a
//! task — is whatever the prompt asks for, using the tools the agent already has. That is why
//! there is no output field here: the prompt is the contract.
//!
//! **Nothing is stored on this side.** They live in the resident server's own database, on the
//! machine the project lives on, because the clock that fires them has to keep running when this
//! window is closed. Everything below is a round trip to that server, which is also the only thing
//! that ever decides what a project's canonical path is.

use serde::{Deserialize, Serialize};
use specta::Type;
use std::sync::Arc;
use tauri::State;

use crate::acp::connection_server::{
    query_automation_runs_via_server, query_delete_automation_via_server,
    query_list_automations_via_server, query_preview_schedule_via_server,
    query_run_automation_via_server, query_save_automation_via_server,
};
use crate::acp::ConnectionKey;
use crate::core::AppState;

/// Where an automation's agent runs.
///
/// A path rather than a worktree row id: the server acts on this, and it has no access to this
/// app's database — for an SSH, WSL or container project, not even to the machine it is on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum AutomationWorkspace {
    /// The project directory itself.
    Repository,
    /// A directory that already exists, named outright.
    Path { path: String },
    /// A fresh worktree per run, branched from `base_branch`. Not available yet: creating one is
    /// bound to this app's `worktrees` table, which the server cannot reach.
    NewWorktree { base_branch: String },
}

/// TS-exportable version of `maestro_protocol::Automation` — the protocol crate derives no `Type`,
/// and giving it one would compile specta into the binary deployed to every remote host.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct Automation {
    pub id: String,
    /// Canonicalized by the server, so this is the server's answer rather than anything sent to it.
    pub project_path: String,
    pub name: String,
    /// What the agent is asked to do. The whole contract of the run.
    pub prompt: String,
    pub agent_id: String,
    /// Five-field cron. `None` for an automation that only runs when the user asks.
    #[specta(optional)]
    pub cron: Option<String>,
    /// IANA name the cron is read in, so a laptop that crosses a timezone keeps its schedule.
    pub timezone: String,
    /// Whether the schedule is live. Disabling stops the clock; Run now still works, which is what
    /// makes this a pause rather than a second kind of delete.
    pub enabled: bool,
    #[specta(optional)]
    pub model: Option<String>,
    /// The ACP session mode id. `None` leaves it to the agent, which for an unattended run means
    /// whatever that agent's default asks before doing.
    #[specta(optional)]
    pub permission_mode: Option<String>,
    #[specta(optional)]
    pub effort: Option<String>,
    pub workspace: AutomationWorkspace,
    /// When this next comes round, RFC 3339, as the server computed it. Nothing here parses cron.
    #[specta(optional)]
    pub next_due_at: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum AutomationRunStatus {
    Running,
    Succeeded,
    Failed,
}

/// What happened to one firing of an automation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct AutomationRun {
    pub id: String,
    pub automation_id: String,
    pub project_path: String,
    /// Copied by the server rather than joined, so a run still says what it was after the
    /// automation that produced it is renamed or deleted.
    pub automation_name: String,
    pub status: AutomationRunStatus,
    /// Whether the clock started this or somebody pressed the button.
    pub scheduled: bool,
    pub started_at: String,
    #[specta(optional)]
    pub finished_at: Option<String>,
    /// The session the run is happening in. This is how the app finds a session it did not start.
    #[specta(optional)]
    pub session_id: Option<String>,
    #[specta(optional)]
    pub error: Option<String>,
    /// What it takes to open this run again once the idle sweep has closed its session: the
    /// agent's own id for the conversation, which agent it was, and where it ran.
    #[specta(optional)]
    pub agent_session_id: Option<String>,
    #[specta(optional)]
    pub agent_id: Option<String>,
    #[specta(optional)]
    pub cwd: Option<String>,
    /// Whether that agent answers `session/load`. A run whose agent cannot is shown without a way
    /// in, rather than with one that fails.
    #[specta(optional)]
    pub can_reload: Option<bool>,
}

impl From<maestro_protocol::AutomationWorkspace> for AutomationWorkspace {
    fn from(workspace: maestro_protocol::AutomationWorkspace) -> Self {
        match workspace {
            maestro_protocol::AutomationWorkspace::Repository => Self::Repository,
            maestro_protocol::AutomationWorkspace::Path { path } => Self::Path { path },
            maestro_protocol::AutomationWorkspace::NewWorktree { base_branch } => {
                Self::NewWorktree { base_branch }
            }
        }
    }
}

impl From<AutomationWorkspace> for maestro_protocol::AutomationWorkspace {
    fn from(workspace: AutomationWorkspace) -> Self {
        match workspace {
            AutomationWorkspace::Repository => Self::Repository,
            AutomationWorkspace::Path { path } => Self::Path { path },
            AutomationWorkspace::NewWorktree { base_branch } => Self::NewWorktree { base_branch },
        }
    }
}

impl From<maestro_protocol::Automation> for Automation {
    fn from(automation: maestro_protocol::Automation) -> Self {
        Self {
            id: automation.id,
            project_path: automation.project_path,
            name: automation.name,
            prompt: automation.prompt,
            agent_id: automation.agent_id,
            cron: automation.cron,
            timezone: automation.timezone,
            enabled: automation.enabled,
            model: automation.model,
            permission_mode: automation.permission_mode,
            effort: automation.effort,
            workspace: automation.workspace.into(),
            next_due_at: automation.next_due_at,
        }
    }
}

impl From<Automation> for maestro_protocol::Automation {
    fn from(automation: Automation) -> Self {
        Self {
            id: automation.id,
            project_path: automation.project_path,
            name: automation.name,
            prompt: automation.prompt,
            agent_id: automation.agent_id,
            cron: automation.cron,
            timezone: automation.timezone,
            enabled: automation.enabled,
            model: automation.model,
            permission_mode: automation.permission_mode,
            effort: automation.effort,
            workspace: automation.workspace.into(),
            // Computed by the server on the way back out, never sent to it.
            next_due_at: None,
        }
    }
}

impl From<maestro_protocol::AutomationRun> for AutomationRun {
    fn from(run: maestro_protocol::AutomationRun) -> Self {
        Self {
            id: run.id,
            automation_id: run.automation_id,
            project_path: run.project_path,
            automation_name: run.automation_name,
            status: match run.status {
                maestro_protocol::AutomationRunStatus::Running => AutomationRunStatus::Running,
                maestro_protocol::AutomationRunStatus::Succeeded => AutomationRunStatus::Succeeded,
                maestro_protocol::AutomationRunStatus::Failed => AutomationRunStatus::Failed,
            },
            scheduled: run.scheduled,
            started_at: run.started_at,
            finished_at: run.finished_at,
            session_id: run.session_id,
            error: run.error,
            agent_session_id: run.agent_session_id,
            agent_id: run.agent_id,
            cwd: run.cwd,
            can_reload: run.can_reload,
        }
    }
}

/// Which server to ask, and what this project is called on it.
async fn target(
    app_state: &Arc<AppState>,
    project_id: i32,
) -> Result<(ConnectionKey, String), String> {
    let (project, _) = crate::core::get_project_with_git_conn(app_state, project_id).await?;
    Ok((
        ConnectionKey::from_all_ids(
            project.connection_id,
            project.wsl_connection_id,
            project.docker_connection_id,
        ),
        project.path,
    ))
}

/// A project's automations, and the one thing about the machine running them the editor has to
/// know: what "09:00" means there.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct AutomationList {
    pub automations: Vec<Automation>,
    /// The IANA zone the background server's machine is set to. The same as this machine's for a
    /// local project, and the only reason the editor offers a choice when it is not.
    pub server_timezone: String,
}

#[tauri::command]
#[specta::specta]
pub async fn list_automations(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
) -> Result<AutomationList, String> {
    let (connection_key, project_path) = target(&app_state, project_id).await?;
    let response =
        query_list_automations_via_server(connection_key, project_path, &app_state).await?;
    Ok(AutomationList {
        automations: response.automations.into_iter().map(Into::into).collect(),
        server_timezone: response.server_timezone,
    })
}

/// Create or replace one automation.
///
/// One at a time rather than a whole document, because the store is a set of rows now: a
/// whole-document write would have two windows overwriting each other with whatever each last read.
#[tauri::command]
#[specta::specta]
pub async fn save_automation(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    automation: Automation,
) -> Result<Automation, String> {
    let (connection_key, project_path) = target(&app_state, project_id).await?;
    let saved = query_save_automation_via_server(
        connection_key,
        project_path,
        automation.into(),
        &app_state,
    )
    .await?;
    Ok(saved.into())
}

#[tauri::command]
#[specta::specta]
pub async fn delete_automation(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    automation_id: String,
) -> Result<(), String> {
    let (connection_key, _) = target(&app_state, project_id).await?;
    query_delete_automation_via_server(connection_key, automation_id, &app_state).await
}

/// Fire one now, whatever its schedule says.
///
/// Returns as soon as the server has opened a run for it. What happens next arrives as
/// `automation-run-changed`, the same way a scheduled run does — there is deliberately no second
/// path for a run somebody asked for by hand.
#[tauri::command]
#[specta::specta]
pub async fn run_automation(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    automation_id: String,
) -> Result<(), String> {
    let (connection_key, _) = target(&app_state, project_id).await?;
    query_run_automation_via_server(connection_key, automation_id, &app_state).await
}

/// When a schedule being written would next fire, RFC 3339, or `None` for one that never does.
///
/// Asked of the server rather than worked out here, for the same reason `next_due_at` is: the
/// daemon is what decides when a run happens, and a second implementation in the editor would be
/// a second answer to that question.
#[tauri::command]
#[specta::specta]
pub async fn preview_schedule(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    cron: String,
    timezone: String,
) -> Result<Option<String>, String> {
    let (connection_key, _) = target(&app_state, project_id).await?;
    let response =
        query_preview_schedule_via_server(connection_key, cron, timezone, &app_state).await?;
    Ok(response.next)
}

#[tauri::command]
#[specta::specta]
pub async fn list_automation_runs(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    limit: Option<u32>,
) -> Result<Vec<AutomationRun>, String> {
    let (connection_key, project_path) = target(&app_state, project_id).await?;
    let response =
        query_automation_runs_via_server(connection_key, project_path, limit, &app_state).await?;
    Ok(response.runs.into_iter().map(Into::into).collect())
}
