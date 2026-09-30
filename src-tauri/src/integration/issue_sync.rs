use std::sync::Arc;

use tauri::State;

use crate::acp::connection_server::{query_project_store, reply};
use crate::acp::transport::{ServerRequest, ServerResponse};
use crate::core::AppState;
use crate::models::issue_tracking::RemoteIssue;
use crate::models::Task;
use maestro_protocol::{ImportTasksRequest, ImportedIssue, TaskPriority, TaskUpdate};

/// Batch-import remote issues as Backlog tasks for a project, skipping any that have already
/// been imported (by external_id within the project). Returns the list of newly-created tasks.
#[tauri::command]
#[specta::specta]
pub async fn import_tasks(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    issues: Vec<RemoteIssue>,
    base_branch: String,
) -> Result<Vec<Task>, String> {
    let issues = issues
        .into_iter()
        .map(|issue| ImportedIssue {
            priority: match issue.priority.as_deref() {
                Some("Urgent") => TaskPriority::Urgent,
                Some("High") => TaskPriority::High,
                Some("Medium") => TaskPriority::Medium,
                Some("Low") => TaskPriority::Low,
                _ => TaskPriority::None,
            },
            external_id: issue.external_id,
            title: issue.title,
            body: issue.body,
            url: issue.url,
            labels: issue.labels,
            updated_at: issue.updated_at,
        })
        .collect();
    let list = query_project_store(
        &app_state,
        project_id,
        |project_path| {
            ServerRequest::ImportTasks(ImportTasksRequest {
                project_path,
                base_branch,
                issues,
            })
        },
        reply!(ServerResponse::ImportTasksOk(list) => list),
    )
    .await?;
    Ok(list
        .tasks
        .into_iter()
        .map(|task| Task::from_wire(task, project_id))
        .collect())
}

/// Update a task's title, description, labels, and external_updated_at from a remote issue.
/// This is the "Update task" action in the Changed tab — performs a non-destructive content overwrite.
#[tauri::command]
#[specta::specta]
pub async fn update_task_from_remote(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    task_id: i32,
    issue: RemoteIssue,
) -> Result<Task, String> {
    let update = TaskUpdate {
        title: Some(issue.title),
        description: Some(issue.body),
        labels: Some(issue.labels),
        external_updated_at: Some(issue.updated_at),
        ..TaskUpdate::default()
    };
    crate::task::crud::update_task_on_server(&app_state, project_id, task_id, update).await
}

/// Advance a task's external_updated_at to the remote value, clearing the "changed" flag
/// without modifying title, description, or labels.
#[tauri::command]
#[specta::specta]
pub async fn dismiss_task_change(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    task_id: i32,
    remote_updated_at: String,
) -> Result<Task, String> {
    let update = TaskUpdate {
        external_updated_at: Some(Some(remote_updated_at)),
        ..TaskUpdate::default()
    };
    crate::task::crud::update_task_on_server(&app_state, project_id, task_id, update).await
}
