//! The task's outcome thread, which the daemon keeps in the project's store
//! (`maestro-server/src/task_store/threads.rs`). These are the two commands the UI writes and
//! reads it through; the pipeline's own entries are written by the daemon as phases end.

use std::sync::Arc;

use maestro_protocol::{AddTaskCommentRequest, NewTaskComment, TaskRef};
use tauri::State;

use crate::acp::connection_server::{query_project_store, reply};
use crate::acp::transport::{ServerRequest, ServerResponse};
use crate::core::AppState;
use crate::models::TaskComment;

/// Read a task's thread, oldest first.
#[tauri::command]
#[specta::specta]
pub async fn list_task_comments(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    task_id: i32,
) -> Result<Vec<TaskComment>, String> {
    let list = query_project_store(
        &app_state,
        project_id,
        |project_path| {
            ServerRequest::ListTaskComments(TaskRef {
                project_path,
                task_id,
            })
        },
        reply!(ServerResponse::ListTaskCommentsOk(list) => list),
    )
    .await?;
    Ok(list.comments.into_iter().map(Into::into).collect())
}

/// Add a note of the user's own to a task's thread.
///
/// Only `note` is writable from the UI. The typed kinds are produced by the pipeline and stand as
/// the record of what an agent concluded — letting a user post one by hand would make "the plan
/// the gate approved" something anybody could forge after the fact.
#[tauri::command]
#[specta::specta]
pub async fn add_task_note(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    task_id: i32,
    body: String,
) -> Result<TaskComment, String> {
    let body = body.trim();
    if body.is_empty() {
        return Err("A note cannot be empty".to_string());
    }
    let comment = query_project_store(
        &app_state,
        project_id,
        |project_path| {
            ServerRequest::AddTaskComment(AddTaskCommentRequest {
                project_path,
                task_id,
                comment: NewTaskComment {
                    kind: "note".to_string(),
                    author: "user".to_string(),
                    body: Some(body.to_string()),
                    external_ref: None,
                    phase: None,
                },
            })
        },
        reply!(ServerResponse::AddTaskCommentOk(comment) => comment),
    )
    .await?;
    Ok(comment.into())
}
