use std::sync::Arc;
use tauri::{Emitter, State};
use chrono::Utc;
use crate::models::{Task, TaskRelationship, TaskInstruction, TaskAttachment, TASK_SELECT};
use crate::db::AppState;

/// Get list of all tasks for a project
#[tauri::command]
#[specta::specta]
pub fn get_tasks(
    app_state: State<Arc<AppState>>,
    project_id: i32,
) -> Result<Vec<Task>, String> {
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;

    let query = format!("{} WHERE project_id = ? ORDER BY created_at DESC", TASK_SELECT);
    let mut stmt = conn.prepare(&query).map_err(|e| e.to_string())?;

    let tasks = stmt
        .query_map([project_id], Task::from_row)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(tasks)
}

fn create_task_impl(
    conn: &rusqlite::Connection,
    project_id: i32,
    title: String,
    description: String,
    skills: Vec<String>,
    base_branch: String,
    agent_id: Option<String>,
    priority: Option<String>,
    auto_approve: bool,
    isolated_worktree: bool,
    model_override: Option<String>,
) -> Result<Task, String> {
    let trimmed_title = title.trim();
    if trimmed_title.is_empty() || trimmed_title.len() < 3 || trimmed_title.len() > 255 {
        return Err("Title must be 3-255 characters".to_string());
    }
    let trimmed_description = description.trim();
    if trimmed_description.is_empty() || trimmed_description.len() < 10 {
        return Err("Description must be at least 10 characters".to_string());
    }

    let now = Utc::now().to_rfc3339();
    let skills_json = serde_json::to_string(&skills)
        .map_err(|e| format!("JSON serialization failed: {}", e))?;

    conn.execute(
        "INSERT INTO tasks (project_id, title, description, skills, status, base_branch, \
         agent_id, priority, auto_approve, isolated_worktree, model_override, created_at, updated_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        rusqlite::params![
            project_id, &title, &description, &skills_json, "Backlog", &base_branch,
            &agent_id,
            priority.as_deref().unwrap_or("Medium"),
            auto_approve,
            isolated_worktree,
            &model_override,
            &now, &now
        ],
    )
    .map_err(|e| e.to_string())?;

    let task_id = conn.last_insert_rowid();
    let query = format!("{} WHERE id = ?", TASK_SELECT);
    conn.query_row(&query, [task_id], Task::from_row)
        .map_err(|e| e.to_string())
}

#[derive(serde::Deserialize, specta::Type)]
pub struct CreateTaskRequest {
    pub project_id: i32,
    pub title: String,
    pub description: String,
    pub skills: Vec<String>,
    pub base_branch: String,
    pub agent_id: Option<String>,
    pub priority: Option<String>,
    pub auto_approve: bool,
    pub isolated_worktree: bool,
    pub model_override: Option<String>,
}

/// Create a new task with validation
#[tauri::command]
#[specta::specta]
pub fn create_task(
    app_state: State<Arc<AppState>>,
    request: CreateTaskRequest,
) -> Result<Task, String> {
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
    let task = create_task_impl(
        &conn,
        request.project_id,
        request.title,
        request.description,
        request.skills,
        request.base_branch,
        request.agent_id,
        request.priority,
        request.auto_approve,
        request.isolated_worktree,
        request.model_override,
    )?;
    app_state.app_handle.emit("tasks-changed", ()).ok();
    Ok(task)
}

/// Update a task's status or other fields
#[tauri::command]
#[specta::specta]
#[allow(clippy::too_many_arguments)]
pub fn update_task(
    app_state: State<Arc<AppState>>,
    task_id: i32,
    status: Option<String>,
    description: Option<String>,
    title: Option<String>,
    priority: Option<String>,
    base_branch: Option<String>,
    skills: Option<Vec<String>>,
    agent_id: Option<String>,
) -> Result<Task, String> {
    let mut conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
    let now = Utc::now().to_rfc3339();

    // Build SET clause dynamically from non-None fields, wrapped in a transaction
    let tx = conn.transaction().map_err(|e| format!("Transaction failed: {}", e))?;

    let mut set_parts: Vec<String> = Vec::new();
    let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

    if let Some(ref v) = status {
        set_parts.push("status = ?".to_string());
        params.push(Box::new(v.clone()));
    }
    if let Some(ref v) = description {
        set_parts.push("description = ?".to_string());
        params.push(Box::new(v.clone()));
    }
    if let Some(ref v) = title {
        set_parts.push("title = ?".to_string());
        params.push(Box::new(v.clone()));
    }
    if let Some(ref v) = priority {
        set_parts.push("priority = ?".to_string());
        params.push(Box::new(v.clone()));
    }
    if let Some(ref v) = base_branch {
        set_parts.push("base_branch = ?".to_string());
        params.push(Box::new(v.clone()));
    }
    if let Some(ref new_skills) = skills {
        let skills_json = serde_json::to_string(new_skills)
            .map_err(|e| format!("JSON serialization failed: {}", e))?;
        set_parts.push("skills = ?".to_string());
        params.push(Box::new(skills_json));
    }
    if let Some(ref v) = agent_id {
        set_parts.push("agent_id = ?".to_string());
        params.push(Box::new(v.clone()));
    }

    // Always update updated_at
    set_parts.push("updated_at = ?".to_string());
    params.push(Box::new(now));

    // Add task_id as final param for WHERE clause
    params.push(Box::new(task_id));

    let sql = format!("UPDATE tasks SET {} WHERE id = ?", set_parts.join(", "));
    let param_refs: Vec<&dyn rusqlite::types::ToSql> = params.iter().map(|p| p.as_ref()).collect();
    tx.execute(&sql, param_refs.as_slice())
        .map_err(|e| e.to_string())?;

    // Read back inside the same transaction before committing — avoids re-locking the mutex
    let query = format!("{} WHERE id = ?", TASK_SELECT);
    let task = tx.query_row(&query, [task_id], Task::from_row)
        .map_err(|e| e.to_string())?;

    tx.commit().map_err(|e| format!("Commit failed: {}", e))?;

    app_state.app_handle.emit("tasks-changed", ()).ok();
    Ok(task)
}

/// Update task-level configuration overrides
#[tauri::command]
#[specta::specta]
pub fn update_task_settings(
    app_state: State<Arc<AppState>>,
    task_id: i32,
    settings: crate::models::TaskConfigRequest,
) -> Result<(), String> {
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
    let now = Utc::now().to_rfc3339();

    let mcp_allowlist_value = settings
        .mcp_allowlist
        .as_ref()
        .map(serde_json::to_string)
        .transpose()
        .map_err(|e| format!("Failed to serialize mcp_allowlist: {}", e))?;

    let skills_override_value = settings
        .skills_override
        .as_ref()
        .map(serde_json::to_string)
        .transpose()
        .map_err(|e| format!("Failed to serialize skills_override: {}", e))?;

    conn.execute(
        "UPDATE tasks SET model_override = ?, mcp_allowlist = ?, skills_override = ?, updated_at = ? WHERE id = ?",
        rusqlite::params![&settings.model_override, &mcp_allowlist_value, &skills_override_value, &now, task_id],
    )
    .map_err(|e| format!("Failed to update task settings: {}", e))?;

    Ok(())
}

/// Archive a task by setting its archived_at timestamp
#[tauri::command]
#[specta::specta]
pub fn archive_task(
    app_state: State<Arc<AppState>>,
    task_id: i32,
) -> Result<Task, String> {
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
    let now = Utc::now().to_rfc3339();

    conn.execute(
        "UPDATE tasks SET archived_at = ?, updated_at = ? WHERE id = ?",
        rusqlite::params![&now, &now, task_id],
    )
    .map_err(|e| e.to_string())?;

    let query = format!("{} WHERE id = ?", TASK_SELECT);
    let task = conn.query_row(&query, [task_id], Task::from_row)
        .map_err(|e| e.to_string())?;
    app_state.app_handle.emit("tasks-changed", ()).ok();
    Ok(task)
}

/// Delete a task by id
#[tauri::command]
#[specta::specta]
pub fn delete_task(app_state: State<Arc<AppState>>, task_id: i32) -> Result<(), String> {
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
    conn.execute("DELETE FROM tasks WHERE id = ?", [task_id])
        .map_err(|e| e.to_string())?;
    app_state.app_handle.emit("tasks-changed", ()).ok();
    Ok(())
}

/// Get relationships for a task
#[tauri::command]
#[specta::specta]
pub fn get_task_relationships(
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
pub fn remove_task_relationship(
    app_state: State<Arc<AppState>>,
    relationship_id: i32,
) -> Result<(), String> {
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
    conn.execute("DELETE FROM task_relationships WHERE id = ?", [relationship_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Get instructions log for a task
#[tauri::command]
#[specta::specta]
pub fn get_task_instructions(
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

/// List git branches and the current branch for a project
///
/// Returns a tuple of (branches, current_branch).
/// Falls back to ([], "main") if the project is not a git repo or git is unavailable.
#[tauri::command]
#[specta::specta]
pub async fn list_project_branches(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
) -> Result<(crate::git::BranchList, String), String> {
    // Look up the project to get its path
    let project = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        conn.query_row(
            "SELECT id, name, path, created_at, updated_at, last_opened, connection_id, wsl_connection_id FROM projects WHERE id = ?",
            [project_id],
            crate::models::Project::from_row,
        )
        .map_err(|e| e.to_string())?
    };

    // Uses get_git_connection directly (not get_project_with_git_conn) because
    // branch listing should fall back to local path when SSH is disconnected,
    // rather than failing entirely.
    let git_conn = crate::db::get_git_connection(&project, &app_state).await
        .unwrap_or_else(|_| crate::models::GitConnection::Local { path: project.path.clone() });

    let (branches, current_branch) = tokio::join!(
        crate::git::list_branches(&git_conn),
        crate::git::get_current_branch(&git_conn),
    );
    let branches = branches.unwrap_or_else(|_| crate::git::BranchList { local: vec![], remote: vec![] });
    let current_branch = current_branch.unwrap_or_else(|_| "main".to_string());

    Ok((branches, current_branch))
}

/// Get attachments for a task
#[tauri::command]
#[specta::specta]
pub fn get_task_attachments(
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
    file_size: i64,
) -> Result<TaskAttachment, String> {
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
pub fn remove_task_attachment(
    app_state: State<Arc<AppState>>,
    attachment_id: i32,
) -> Result<(), String> {
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
    conn.execute("DELETE FROM task_attachments WHERE id = ?", [attachment_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Stop the active ACP or PTY session for a task and move the task back to Backlog.
///
/// Searches ACP sessions and PTY session metadata for an entry associated with the
/// given task_id. If found, replicates the teardown logic from cancel_acp_session or
/// close_pty_session respectively. After all async work is done, updates the task
/// status to Backlog via the sync DB mutex (never held across an await point).
#[tauri::command]
#[specta::specta]
pub async fn interrupt_task(
    app_state: State<'_, Arc<AppState>>,
    task_id: i32,
) -> Result<(), String> {
    use crate::acp::transport::{MaestroRpcMessage, ServerRequest, CancelRequest};

    // Search ACP sessions by task_id — release lock immediately in scoped block.
    let acp_log_id: Option<i32> = {
        let sessions = app_state.acp.sessions.lock().await;
        sessions
            .iter()
            .find(|(_, proc)| proc.task_id == Some(task_id))
            .map(|(log_id, _)| *log_id)
    };

    // Search PTY session metadata by task_id — release lock immediately in scoped block.
    let pty_log_id: Option<i32> = {
        let session_meta = app_state.pty.session_meta.lock().await;
        session_meta
            .iter()
            .find(|(_, m)| m.task_id == Some(task_id))
            .map(|(log_id, _)| *log_id)
    };

    if acp_log_id.is_none() && pty_log_id.is_none() {
        return Err(format!("No active session for task {}", task_id));
    }

    // Tear down ACP session if found — replicates cancel_acp_session logic.
    if let Some(log_id) = acp_log_id {
        let session_id = format!("session-{}", log_id);
        let cancel_msg = MaestroRpcMessage::Request(ServerRequest::Cancel(CancelRequest { session_id }));
        // Best-effort — maestro-server may already be gone; error is non-fatal.
        let _ = crate::acp::write_to_acp_session(&app_state, log_id, &cancel_msg).await;

        let teardown_key: Option<crate::acp::ConnectionKey> = {
            let mut sessions = app_state.acp.sessions.lock().await;
            let removed = sessions.remove(&log_id);
            let conn_key = removed.as_ref()
                .filter(|s| s.child.is_none())
                .map(|s| s.connection_key);
            if let Some(mut session) = removed {
                if let Some(cancel_tx) = session.reader_cancel_tx.take() {
                    let _ = cancel_tx.send(());
                }
            }
            conn_key
                .filter(|k| !sessions.values().any(|s| &s.connection_key == k && s.child.is_none()))
        };

        if let Some(key) = teardown_key {
            app_state.acp.connection_servers.lock().await.remove(&key);
        }
    }

    // Tear down PTY session if found — replicates close_pty_session logic.
    if let Some(session_key) = pty_log_id {
        {
            let mut cancel_map = app_state.pty.attach_cancel.lock().await;
            if let Some(flag) = cancel_map.remove(&session_key) {
                flag.store(true, std::sync::atomic::Ordering::Relaxed);
            }
        }
        app_state.pty.sessions.lock().await.remove(&session_key);
        app_state.ssh.pty_sessions.lock().await.remove(&session_key);
        app_state.pty.session_meta.lock().await.remove(&session_key);
    }

    // All async work is done — acquire sync DB mutex now to update task status.
    {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        let now = Utc::now().to_rfc3339();
        conn.execute(
            "UPDATE tasks SET status = 'Backlog', updated_at = ? WHERE id = ?",
            rusqlite::params![&now, task_id],
        )
        .map_err(|e| e.to_string())?;
    }

    app_state.app_handle.emit("tasks-changed", ()).ok();
    app_state.app_handle.emit("sessions-changed", ()).ok();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use crate::db::schema::initialize_schema;

    fn test_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        initialize_schema(&conn).unwrap();
        conn
    }

    fn insert_project(conn: &Connection) -> i32 {
        conn.execute(
            "INSERT INTO projects (name, path, created_at, updated_at) \
             VALUES ('Test Project', '/tmp/test-project', '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z')",
            [],
        )
        .unwrap();
        conn.last_insert_rowid() as i32
    }

    #[test]
    fn create_task_rejects_short_name() {
        let conn = test_db();
        let project_id = insert_project(&conn);
        let err = create_task_impl(
            &conn, project_id, "ab".to_string(),
            "valid description here".to_string(),
            vec![], "main".to_string(),
            None, None, false, true, None,
        )
        .unwrap_err();
        assert!(err.contains("Title must be 3-255 characters"), "got: {err}");
    }

    #[test]
    fn create_task_rejects_short_description() {
        let conn = test_db();
        let project_id = insert_project(&conn);
        let err = create_task_impl(
            &conn, project_id, "Valid Name".to_string(),
            "too short".to_string(),
            vec![], "main".to_string(),
            None, None, false, true, None,
        )
        .unwrap_err();
        assert!(err.contains("Description must be at least 10 characters"), "got: {err}");
    }

    #[test]
    fn create_task_succeeds_with_valid_inputs() {
        let conn = test_db();
        let project_id = insert_project(&conn);
        let task = create_task_impl(
            &conn, project_id,
            "Valid Task Name".to_string(),
            "This is a valid description.".to_string(),
            vec!["rust".to_string()], "main".to_string(),
            None, None, false, true, None,
        )
        .unwrap();
        assert_eq!(task.title, "Valid Task Name");
        assert_eq!(task.project_id, project_id);
        assert!(matches!(task.status, crate::models::TaskStatus::Backlog));
    }

    #[test]
    fn delete_task_removes_task() {
        let conn = test_db();
        let project_id = insert_project(&conn);
        let task = create_task_impl(
            &conn, project_id,
            "Task to Delete".to_string(),
            "This task will be deleted.".to_string(),
            vec![], "main".to_string(),
            None, None, false, true, None,
        )
        .unwrap();

        conn.execute("DELETE FROM tasks WHERE id = ?", [task.id]).unwrap();

        let count: i32 = conn
            .query_row("SELECT COUNT(*) FROM tasks WHERE id = ?", [task.id], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }
}
