use crate::core::AppState;
use crate::models::TaskAttachment;
use chrono::Utc;
use rusqlite::{Connection, OptionalExtension};
use std::sync::Arc;
use tauri::State;

/// Get attachments for a task
#[tauri::command]
#[specta::specta]
pub fn list_task_attachments(
    app_state: State<Arc<AppState>>,
    task_id: i32,
) -> Result<Vec<TaskAttachment>, String> {
    let conn = app_state
        .db
        .lock()
        .map_err(|e| format!("Lock failed: {}", e))?;
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

/// Record an attachment for a task, returning the existing row when that file is already on it.
///
/// The guard lives here rather than at the call sites so every caller is covered: a re-attach is
/// not an error, but a second row would be a second copy of the file in every prompt the task
/// ever sends.
///
/// Takes a `&Connection` so the select and the insert cannot interleave — every IPC command
/// shares one `Mutex<Connection>` and the caller holds it across both.
// ponytail: SQL guard, not a `UNIQUE(task_id, file_path)` index — the index would cost a schema
// bump plus a decision on duplicates already in users' databases. Add it if a second connection
// ever writes this table.
pub fn add(
    conn: &Connection,
    task_id: i32,
    filename: &str,
    file_path: &str,
) -> Result<TaskAttachment, String> {
    let file_size = std::fs::metadata(file_path)
        .map(|m| m.len() as i64)
        .unwrap_or(0);

    let existing = conn
        .query_row(
            "SELECT id, filename, file_size, created_at FROM task_attachments \
             WHERE task_id = ? AND file_path = ?",
            rusqlite::params![task_id, file_path],
            |row| {
                Ok(TaskAttachment {
                    id: row.get(0)?,
                    task_id,
                    filename: row.get(1)?,
                    file_path: file_path.to_string(),
                    file_size: row.get(2)?,
                    created_at: row.get(3)?,
                })
            },
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some(existing) = existing {
        return Ok(existing);
    }

    let now = Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO task_attachments (task_id, filename, file_path, file_size, created_at) VALUES (?, ?, ?, ?, ?)",
        rusqlite::params![task_id, filename, file_path, file_size, &now],
    )
    .map_err(|e| e.to_string())?;

    Ok(TaskAttachment {
        id: conn.last_insert_rowid() as i32,
        task_id,
        filename: filename.to_string(),
        file_path: file_path.to_string(),
        file_size,
        created_at: now,
    })
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
    let conn = app_state
        .db
        .lock()
        .map_err(|e| format!("Lock failed: {}", e))?;
    add(&conn, task_id, &filename, &file_path)
}

/// Remove an attachment record by id
#[tauri::command]
#[specta::specta]
pub fn delete_task_attachment(
    app_state: State<Arc<AppState>>,
    attachment_id: i32,
) -> Result<(), String> {
    let conn = app_state
        .db
        .lock()
        .map_err(|e| format!("Lock failed: {}", e))?;
    conn.execute("DELETE FROM task_attachments WHERE id = ?", [attachment_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::schema::initialize_schema;

    fn db_with_task() -> (Connection, i32) {
        let conn = Connection::open_in_memory().expect("open in-memory database");
        initialize_schema(&conn).expect("initialize schema");
        conn.execute(
            "INSERT INTO projects (id, name, path, created_at, updated_at) \
             VALUES (1, 'demo', '/tmp/demo', '2026-01-01', '2026-01-01')",
            [],
        )
        .expect("insert project");
        conn.execute(
            "INSERT INTO tasks (id, project_id, title, status, base_branch, created_at, updated_at) \
             VALUES (1, 1, 'demo task', 'Queue', 'main', '2026-01-01', '2026-01-01')",
            [],
        )
        .expect("insert task");
        (conn, 1)
    }

    fn count(conn: &Connection, task_id: i32) -> i64 {
        conn.query_row(
            "SELECT COUNT(*) FROM task_attachments WHERE task_id = ?",
            [task_id],
            |row| row.get(0),
        )
        .expect("count attachments")
    }

    /// A duplicated row costs a duplicated content block in every prompt the task sends.
    #[test]
    fn attaching_the_same_file_twice_leaves_one_row() {
        let (conn, task_id) = db_with_task();

        let first = add(&conn, task_id, "notes.txt", "/tmp/notes.txt").unwrap();
        let second = add(&conn, task_id, "notes.txt", "/tmp/notes.txt").unwrap();

        assert_eq!(first.id, second.id);
        assert_eq!(count(&conn, task_id), 1);
    }

    #[test]
    fn a_different_path_is_a_different_attachment() {
        let (conn, task_id) = db_with_task();

        add(&conn, task_id, "notes.txt", "/tmp/notes.txt").unwrap();
        add(&conn, task_id, "notes.txt", "/tmp/other/notes.txt").unwrap();

        assert_eq!(count(&conn, task_id), 2);
    }
}
