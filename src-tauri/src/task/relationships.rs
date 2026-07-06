use std::sync::Arc;
use tauri::State;
use chrono::Utc;
use crate::models::TaskRelationship;
use crate::core::AppState;

/// Get relationships for a task
#[tauri::command]
#[specta::specta]
pub fn list_task_relationships(
    app_state: State<Arc<AppState>>,
    task_id: i32,
) -> Result<Vec<TaskRelationship>, String> {
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
    let mut stmt = conn
        .prepare(
            "SELECT id, from_task_id, to_task_id, relationship_type, created_at \
             FROM task_relationships WHERE from_task_id = ? OR to_task_id = ?",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map([task_id, task_id], |row| {
            Ok(TaskRelationship {
                id: row.get(0)?,
                from_task_id: row.get(1)?,
                to_task_id: row.get(2)?,
                relationship_type: row.get(3)?,
                created_at: row.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(rows)
}

/// Add a relationship between two tasks
#[tauri::command]
#[specta::specta]
pub fn add_task_relationship(
    app_state: State<Arc<AppState>>,
    from_task_id: i32,
    to_task_id: i32,
    relationship_type: String,
) -> Result<TaskRelationship, String> {
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO task_relationships (from_task_id, to_task_id, relationship_type, created_at) VALUES (?, ?, ?, ?)",
        rusqlite::params![from_task_id, to_task_id, &relationship_type, &now],
    )
    .map_err(|e| e.to_string())?;

    let id = conn.last_insert_rowid() as i32;
    Ok(TaskRelationship { id, from_task_id, to_task_id, relationship_type, created_at: now })
}

/// Remove a task relationship
#[tauri::command]
#[specta::specta]
pub fn delete_task_relationship(
    app_state: State<Arc<AppState>>,
    relationship_id: i32,
) -> Result<(), String> {
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
    conn.execute("DELETE FROM task_relationships WHERE id = ?", [relationship_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}
