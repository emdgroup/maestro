//! Task commands. Every one is a round trip to the daemon of the project's connection, which holds
//! the rows and broadcasts `TasksChanged` after every write; that push, not these commands, is what
//! refetches the board.

use crate::acp::connection_server::{query_project_store, reply};
use crate::acp::transport::{ServerRequest, ServerResponse};
use crate::core::AppState;
use crate::models::{BranchMode, Task, WorkspaceMode};
use maestro_protocol::{ProjectRef, TaskRef, TaskUpdate};
use std::sync::Arc;
use tauri::State;

/// A name the wire enum knows, or an error naming what it was meant to be.
///
/// Refused rather than defaulted: the app's `FromStr` impls fall back to a variant, so a typo
/// arriving over IPC would quietly move or re-prioritise a task instead of being rejected.
pub(crate) fn parse_wire<T: serde::de::DeserializeOwned>(
    what: &str,
    name: &str,
) -> Result<T, String> {
    serde_json::from_value(serde_json::Value::String(name.to_string()))
        .map_err(|_| format!("Unknown task {what} '{name}'"))
}

/// Write `update` to one task and return it as stored.
pub(crate) async fn update_task_on_server(
    app_state: &Arc<AppState>,
    project_id: i32,
    task_id: i32,
    update: TaskUpdate,
) -> Result<Task, String> {
    let task = query_project_store(
        app_state,
        project_id,
        |project_path| {
            ServerRequest::UpdateTask(maestro_protocol::UpdateTaskRequest {
                project_path,
                task_id,
                update,
            })
        },
        reply!(ServerResponse::UpdateTaskOk(task) => task),
    )
    .await?;
    Ok(Task::from_wire(task, project_id))
}

/// One task, `None` when the project has no task by that number.
pub(crate) async fn get_task_on_server(
    app_state: &Arc<AppState>,
    project_id: i32,
    task_id: i32,
) -> Result<Option<Task>, String> {
    let found = query_project_store(
        app_state,
        project_id,
        |project_path| {
            ServerRequest::GetTask(TaskRef {
                project_path,
                task_id,
            })
        },
        reply!(ServerResponse::GetTaskOk(found) => found),
    )
    .await?;
    Ok(found.task.map(|task| Task::from_wire(task, project_id)))
}

/// Get list of all tasks for a project
#[tauri::command]
#[specta::specta]
pub async fn get_tasks(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
) -> Result<Vec<Task>, String> {
    let list = query_project_store(
        &app_state,
        project_id,
        |project_path| ServerRequest::ListTasks(ProjectRef { project_path }),
        reply!(ServerResponse::ListTasksOk(list) => list),
    )
    .await?;
    Ok(list
        .tasks
        .into_iter()
        .map(|task| Task::from_wire(task, project_id))
        .collect())
}

#[derive(serde::Deserialize, specta::Type)]
pub struct CreateTaskRequest {
    pub project_id: i32,
    pub title: String,
    pub description: Option<String>,
    pub skills: Vec<String>,
    pub labels: Vec<String>,
    pub base_branch: String,
    pub agent_id: Option<String>,
    pub priority: Option<String>,
    pub auto_approve: bool,
    pub workspace_mode: WorkspaceMode,
    pub workspace_worktree_id: Option<i32>,
    pub workspace_branch_mode: BranchMode,
    /// `None` leaves the branch name to be generated from the task at spawn time.
    pub workspace_branch: Option<String>,
    pub model_override: Option<String>,
}

/// Create a new task with validation
#[tauri::command]
#[specta::specta]
pub async fn create_task(
    app_state: State<'_, Arc<AppState>>,
    request: CreateTaskRequest,
) -> Result<Task, String> {
    let priority = request
        .priority
        .as_deref()
        .map(|name| parse_wire("priority", name))
        .transpose()?;
    let project_id = request.project_id;
    let task = query_project_store(
        &app_state,
        project_id,
        |project_path| {
            ServerRequest::CreateTask(maestro_protocol::CreateTaskRequest {
                project_path,
                title: request.title,
                description: request.description,
                skills: request.skills,
                labels: request.labels,
                base_branch: request.base_branch,
                agent_id: request.agent_id,
                priority,
                auto_approve: request.auto_approve,
                workspace_mode: request.workspace_mode.into(),
                workspace_worktree_id: request.workspace_worktree_id,
                workspace_branch_mode: request.workspace_branch_mode.into(),
                workspace_branch: request.workspace_branch,
                model_override: request.model_override,
            })
        },
        reply!(ServerResponse::CreateTaskOk(task) => task),
    )
    .await?;
    Ok(Task::from_wire(task, project_id))
}

/// Fields that can be updated on a task. All fields are optional — only non-None fields
/// are written. Grouped into a struct to work around the specta
/// 10-argument limit on #[tauri::command] functions.
#[derive(Default, serde::Deserialize, specta::Type)]
pub struct UpdateTaskRequest {
    pub status: Option<String>,
    pub description: Option<String>,
    pub title: Option<String>,
    pub priority: Option<String>,
    pub base_branch: Option<String>,
    pub skills: Option<Vec<String>>,
    pub agent_id: Option<String>,
    pub labels: Option<Vec<String>>,
    pub auto_approve: Option<bool>,
    /// Writing the mode also writes `workspace_worktree_id`, so switching away from
    /// `ReuseWorkspace` cannot leave a pin behind that nothing will ever look at again.
    pub workspace_mode: Option<WorkspaceMode>,
    pub workspace_worktree_id: Option<i32>,
    /// Writing the branch mode also writes `workspace_branch`, for the same reason: switching to
    /// `Checkout` must not leave the name of a branch nobody is going to create.
    pub workspace_branch_mode: Option<BranchMode>,
    pub workspace_branch: Option<String>,
}

/// Update a task's status or other fields. A status is a manual move, which un-archives the task
/// unless it is sent to `Cancelled`.
#[tauri::command]
#[specta::specta]
pub async fn update_task(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    task_id: i32,
    updates: UpdateTaskRequest,
) -> Result<Task, String> {
    let update = TaskUpdate {
        status: updates
            .status
            .as_deref()
            .map(|name| parse_wire("status", name))
            .transpose()?,
        priority: updates
            .priority
            .as_deref()
            .map(|name| parse_wire("priority", name))
            .transpose()?,
        description: updates.description.map(Some),
        title: updates.title,
        base_branch: updates.base_branch,
        skills: updates.skills,
        agent_id: updates.agent_id,
        labels: updates.labels,
        auto_approve: updates.auto_approve,
        workspace_mode: updates.workspace_mode.map(Into::into),
        workspace_worktree_id: updates.workspace_worktree_id,
        workspace_branch_mode: updates.workspace_branch_mode.map(Into::into),
        workspace_branch: updates.workspace_branch,
        ..TaskUpdate::default()
    };
    update_task_on_server(&app_state, project_id, task_id, update).await
}

/// Cancel a task: archives it and applies `Cancelled`.
#[tauri::command]
#[specta::specta]
pub async fn cancel_task(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    task_id: i32,
) -> Result<Task, String> {
    let task = query_project_store(
        &app_state,
        project_id,
        |project_path| {
            ServerRequest::CancelTask(TaskRef {
                project_path,
                task_id,
            })
        },
        reply!(ServerResponse::CancelTaskOk(task) => task),
    )
    .await?;
    Ok(Task::from_wire(task, project_id))
}

/// Archive a task by setting its archived_at timestamp
#[tauri::command]
#[specta::specta]
pub async fn archive_task(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    task_id: i32,
) -> Result<Task, String> {
    let task = query_project_store(
        &app_state,
        project_id,
        |project_path| {
            ServerRequest::ArchiveTask(TaskRef {
                project_path,
                task_id,
            })
        },
        reply!(ServerResponse::ArchiveTaskOk(task) => task),
    )
    .await?;
    Ok(Task::from_wire(task, project_id))
}

/// Delete a task by id
#[tauri::command]
#[specta::specta]
pub async fn delete_task(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    task_id: i32,
) -> Result<(), String> {
    query_project_store(
        &app_state,
        project_id,
        |project_path| {
            ServerRequest::DeleteTask(TaskRef {
                project_path,
                task_id,
            })
        },
        reply!(ServerResponse::DeleteTaskOk => ()),
    )
    .await
}

/// Choose which agent profile this task uses for each role.
///
/// Its own command rather than a field on `TaskConfigRequest`, for the reason
/// `set_project_accent_color` is separate from the project settings form: that request rewrites
/// every column it names, so a caller that only wanted to change one has to resend the rest
/// correctly or silently clear them. The override dialog knows about roles and nothing else.
///
/// An empty map stores `NULL`, so "no overrides" has one representation rather than two. A `None`
/// value is not an absence but the opposite of one: it says the task skips that stage, which only
/// an entry can express — an absent key already means "the project decides".
///
/// Ids are not checked against the project's profiles: a profile deleted after a task named it
/// falls back to the project default in `ProfilesDocument::resolve`, which is the behaviour we
/// want anyway, and validating here would only move the same outcome earlier.
#[tauri::command]
#[specta::specta]
pub async fn set_task_profile_overrides(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    task_id: i32,
    overrides: std::collections::HashMap<String, Option<String>>,
) -> Result<(), String> {
    let update = TaskUpdate {
        profile_overrides: Some(profile_overrides_column(&overrides)?),
        ..TaskUpdate::default()
    };
    update_task_on_server(&app_state, project_id, task_id, update).await?;
    Ok(())
}

/// The stored form of a task's overrides, split out so it can be tested without a server.
fn profile_overrides_column(
    overrides: &std::collections::HashMap<String, Option<String>>,
) -> Result<Option<String>, String> {
    if overrides.is_empty() {
        return Ok(None);
    }
    serde_json::to_string(overrides)
        .map(Some)
        .map_err(|e| format!("Failed to serialize profile overrides: {}", e))
}

/// Update task-level configuration overrides. Every field is written, so an absent one clears its
/// column.
#[tauri::command]
#[specta::specta]
pub async fn update_task_settings(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    task_id: i32,
    settings: crate::models::TaskConfigRequest,
) -> Result<(), String> {
    let update = TaskUpdate {
        model_override: Some(settings.model_override),
        mcp_allowlist: Some(settings.mcp_allowlist),
        skills_override: Some(settings.skills_override),
        permission_mode_override: Some(settings.permission_mode_override),
        ..TaskUpdate::default()
    };
    update_task_on_server(&app_state, project_id, task_id, update).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    /// A named profile and a skipped stage together, because the two are stored in one map and the
    /// null is the half that only exists on the way through JSON; and clearing the last override
    /// has to be NULL rather than "{}", or two values would mean the same thing.
    #[test]
    fn profile_overrides_are_stored_as_json_or_null() {
        let overrides = HashMap::from([
            ("Reviewer".to_string(), Some("strict-reviewer".to_string())),
            ("Planner".to_string(), None),
        ]);
        let stored = profile_overrides_column(&overrides).unwrap();
        let parsed: HashMap<String, Option<String>> =
            serde_json::from_str(stored.as_deref().unwrap()).unwrap();
        assert_eq!(parsed, overrides);
        assert!(crate::project::profiles::role_is_skipped(
            stored.as_deref(),
            crate::project::profiles::AgentRole::Planner
        ));

        assert_eq!(profile_overrides_column(&HashMap::new()).unwrap(), None);
    }

    #[test]
    fn a_status_or_priority_is_accepted_only_by_its_exact_name() {
        assert_eq!(
            parse_wire::<maestro_protocol::TaskStatus>("status", "InProgress").unwrap(),
            maestro_protocol::TaskStatus::InProgress
        );
        let err = parse_wire::<maestro_protocol::TaskStatus>("status", "Backlog").unwrap_err();
        assert!(err.contains("Unknown task status 'Backlog'"), "got: {err}");
        assert!(parse_wire::<maestro_protocol::TaskPriority>("priority", "urgent").is_err());
    }
}
