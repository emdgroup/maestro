use std::sync::Arc;
use tauri::State;
use chrono::Utc;
use crate::models::TaskInstruction;
use crate::core::AppState;

/// Get instructions log for a task
#[tauri::command]
#[specta::specta]
pub fn list_task_instructions(
    app_state: State<Arc<AppState>>,
    task_id: i32,
) -> Result<Vec<TaskInstruction>, String> {
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
    let mut stmt = conn
        .prepare(
            "SELECT id, task_id, content, source, created_at \
             FROM task_instructions WHERE task_id = ? ORDER BY created_at ASC",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map([task_id], |row| {
            Ok(TaskInstruction {
                id: row.get(0)?,
                task_id: row.get(1)?,
                content: row.get(2)?,
                source: row.get(3)?,
                created_at: row.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(rows)
}

/// Add an instruction entry to a task's log
#[tauri::command]
#[specta::specta]
pub fn add_task_instruction(
    app_state: State<Arc<AppState>>,
    task_id: i32,
    content: String,
    source: String,
) -> Result<TaskInstruction, String> {
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO task_instructions (task_id, content, source, created_at) VALUES (?, ?, ?, ?)",
        rusqlite::params![task_id, &content, &source, &now],
    )
    .map_err(|e| e.to_string())?;

    let id = conn.last_insert_rowid() as i32;
    Ok(TaskInstruction { id, task_id, content, source, created_at: now })
}
