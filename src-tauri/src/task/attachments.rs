use std::sync::Arc;
use tauri::State;
use chrono::Utc;
use crate::models::TaskAttachment;
use crate::core::AppState;

/// Get attachments for a task
#[tauri::command]
#[specta::specta]
pub fn list_task_attachments(
    app_state: State<Arc<AppState>>,
    task_id: i32,
) -> Result<Vec<TaskAttachment>, String> {
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
    let mut stmt = conn
        .prepare(
            "SELECT id, task_id, filename, file_path, file_size, created_at \
             FROM task_attachments WHERE task_id = ? ORDER BY created_at ASC",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map([task_id], |row| {
            Ok(TaskAttachment {
                id: row.get(0)?,
                task_id: row.get(1)?,
                filename: row.get(2)?,
                file_path: row.get(3)?,
                file_size: row.get(4)?,
                created_at: row.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(rows)
}

/// Add an attachment record for a task
#[tauri::command]
#[specta::specta]
pub fn add_task_attachment(
    app_state: State<Arc<AppState>>,
    task_id: i32,
    filename: String,
    file_path: String,
) -> Result<TaskAttachment, String> {
    let file_size = std::fs::metadata(&file_path)
        .map(|m| m.len() as i64)
        .unwrap_or(0);
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO task_attachments (task_id, filename, file_path, file_size, created_at) VALUES (?, ?, ?, ?, ?)",
        rusqlite::params![task_id, &filename, &file_path, file_size, &now],
    )
    .map_err(|e| e.to_string())?;

    let id = conn.last_insert_rowid() as i32;
    Ok(TaskAttachment { id, task_id, filename, file_path, file_size, created_at: now })
}

/// Remove an attachment record by id
#[tauri::command]
#[specta::specta]
pub fn delete_task_attachment(
    app_state: State<Arc<AppState>>,
    attachment_id: i32,
) -> Result<(), String> {
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
    conn.execute("DELETE FROM task_attachments WHERE id = ?", [attachment_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}
