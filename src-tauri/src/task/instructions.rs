use crate::acp::connection_server::{query_project_store, reply};
use crate::acp::transport::{ServerRequest, ServerResponse};
use crate::core::AppState;
use crate::models::TaskInstruction;
use maestro_protocol::{AddTaskInstructionRequest, TaskRef};
use std::sync::Arc;
use tauri::State;

/// Get instructions log for a task
#[tauri::command]
#[specta::specta]
pub async fn list_task_instructions(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    task_id: i32,
) -> Result<Vec<TaskInstruction>, String> {
    let list = query_project_store(
        &app_state,
        project_id,
        |project_path| {
            ServerRequest::ListTaskInstructions(TaskRef {
                project_path,
                task_id,
            })
        },
        reply!(ServerResponse::ListTaskInstructionsOk(list) => list),
    )
    .await?;
    Ok(list.instructions.into_iter().map(Into::into).collect())
}

/// Add an instruction entry to a task's log
#[tauri::command]
#[specta::specta]
pub async fn add_task_instruction(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    task_id: i32,
    content: String,
    source: String,
) -> Result<TaskInstruction, String> {
    let instruction = query_project_store(
        &app_state,
        project_id,
        |project_path| {
            ServerRequest::AddTaskInstruction(AddTaskInstructionRequest {
                project_path,
                task_id,
                content,
                source,
            })
        },
        reply!(ServerResponse::AddTaskInstructionOk(instruction) => instruction),
    )
    .await?;
    Ok(instruction.into())
}
