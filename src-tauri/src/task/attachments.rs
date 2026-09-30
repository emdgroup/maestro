use crate::acp::connection_server::{query_project_store, reply};
use crate::acp::transport::{ServerRequest, ServerResponse};
use crate::core::AppState;
use crate::models::TaskAttachment;
use maestro_protocol::{AddTaskAttachmentRequest, DeleteTaskAttachmentRequest, TaskRef};
use std::sync::Arc;
use tauri::State;

/// Get attachments for a task
#[tauri::command]
#[specta::specta]
pub async fn list_task_attachments(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    task_id: i32,
) -> Result<Vec<TaskAttachment>, String> {
    let list = query_project_store(
        &app_state,
        project_id,
        |project_path| {
            ServerRequest::ListTaskAttachments(TaskRef {
                project_path,
                task_id,
            })
        },
        reply!(ServerResponse::ListTaskAttachmentsOk(list) => list),
    )
    .await?;
    Ok(list.attachments.into_iter().map(Into::into).collect())
}

/// Record an attachment for a task. The server returns the existing row when that file is already
/// on it, since a second row would be a second copy of the file in every prompt the task sends.
#[tauri::command]
#[specta::specta]
pub async fn add_task_attachment(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    task_id: i32,
    filename: String,
    file_path: String,
) -> Result<TaskAttachment, String> {
    let attachment = query_project_store(
        &app_state,
        project_id,
        |project_path| {
            ServerRequest::AddTaskAttachment(AddTaskAttachmentRequest {
                project_path,
                task_id,
                filename,
                file_path,
            })
        },
        reply!(ServerResponse::AddTaskAttachmentOk(attachment) => attachment),
    )
    .await?;
    Ok(attachment.into())
}

/// Remove an attachment record by id
#[tauri::command]
#[specta::specta]
pub async fn delete_task_attachment(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    attachment_id: i32,
) -> Result<(), String> {
    query_project_store(
        &app_state,
        project_id,
        |project_path| {
            ServerRequest::DeleteTaskAttachment(DeleteTaskAttachmentRequest {
                project_path,
                attachment_id,
            })
        },
        reply!(ServerResponse::DeleteTaskAttachmentOk => ()),
    )
    .await
}
