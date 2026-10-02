use crate::acp::connection_server::{query_project_store, reply};
use crate::acp::transport::{ServerRequest, ServerResponse};
use crate::core::AppState;
use crate::models::TaskRelationship;
use maestro_protocol::{AddTaskRelationshipRequest, DeleteTaskRelationshipRequest, TaskRef};
use std::sync::Arc;
use tauri::State;

/// Get every relationship the task is on either end of
#[tauri::command]
#[specta::specta]
pub async fn list_task_relationships(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    task_id: i32,
) -> Result<Vec<TaskRelationship>, String> {
    let list = query_project_store(
        &app_state,
        project_id,
        |project_path| {
            ServerRequest::ListTaskRelationships(TaskRef {
                project_path,
                task_id,
            })
        },
        reply!(ServerResponse::ListTaskRelationshipsOk(list) => list),
    )
    .await?;
    Ok(list.relationships.into_iter().map(Into::into).collect())
}

/// Add a relationship between two tasks of one project
#[tauri::command]
#[specta::specta]
pub async fn add_task_relationship(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    from_task_id: i32,
    to_task_id: i32,
    relationship_type: String,
) -> Result<TaskRelationship, String> {
    let relationship = query_project_store(
        &app_state,
        project_id,
        |project_path| {
            ServerRequest::AddTaskRelationship(AddTaskRelationshipRequest {
                project_path,
                from_task_id,
                to_task_id,
                relationship_type,
            })
        },
        reply!(ServerResponse::AddTaskRelationshipOk(relationship) => relationship),
    )
    .await?;
    Ok(relationship.into())
}

/// Remove a task relationship
#[tauri::command]
#[specta::specta]
pub async fn delete_task_relationship(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    relationship_id: i32,
) -> Result<(), String> {
    query_project_store(
        &app_state,
        project_id,
        |project_path| {
            ServerRequest::DeleteTaskRelationship(DeleteTaskRelationshipRequest {
                project_path,
                relationship_id,
            })
        },
        reply!(ServerResponse::DeleteTaskRelationshipOk => ()),
    )
    .await
}
