use std::sync::Arc;
use tauri::{Emitter, State};
use chrono::Utc;
use crate::models::{Task, TASK_SELECT};
use crate::core::AppState;

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
    description: Option<String>,
    skills: Vec<String>,
    labels: Vec<String>,
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

    let description = description.and_then(|d| {
        let trimmed = d.trim().to_string();
        if trimmed.is_empty() { None } else { Some(trimmed) }
    });

    let now = Utc::now().to_rfc3339();
    let skills_json = serde_json::to_string(&skills)
        .map_err(|e| format!("JSON serialization failed: {}", e))?;
    let labels_json = serde_json::to_string(&labels)
        .map_err(|e| format!("JSON serialization failed: {}", e))?;

    conn.execute(
        "INSERT INTO tasks (project_id, title, description, skills, status, base_branch, \
         agent_id, priority, auto_approve, isolated_worktree, model_override, labels, created_at, updated_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        rusqlite::params![
            project_id, &title, &description, &skills_json, "Backlog", &base_branch,
            &agent_id,
            priority.as_deref().unwrap_or("Medium"),
            auto_approve,
            isolated_worktree,
            &model_override,
            &labels_json,
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
    pub description: Option<String>,
    pub skills: Vec<String>,
    pub labels: Vec<String>,
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
        request.labels,
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

/// Fields that can be updated on a task. All fields are optional — only non-None fields
/// are included in the SQL UPDATE. Grouped into a struct to work around the specta
/// 10-argument limit on #[tauri::command] functions.
#[derive(serde::Deserialize, specta::Type)]
pub struct UpdateTaskRequest {
    pub status: Option<String>,
    pub description: Option<String>,
    pub title: Option<String>,
    pub priority: Option<String>,
    pub base_branch: Option<String>,
    pub skills: Option<Vec<String>>,
    pub agent_id: Option<String>,
    pub labels: Option<Vec<String>>,
    pub auto_approve: Option<bool>,
    pub isolated_worktree: Option<bool>,
}

/// Update a task's status or other fields
#[tauri::command]
#[specta::specta]
pub fn update_task(
    app_state: State<Arc<AppState>>,
    task_id: i32,
    updates: UpdateTaskRequest,
) -> Result<Task, String> {
    let mut conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
    let now = Utc::now().to_rfc3339();

    // Build SET clause dynamically from non-None fields, wrapped in a transaction
    let tx = conn.transaction().map_err(|e| format!("Transaction failed: {}", e))?;

    let mut set_parts: Vec<String> = Vec::new();
    let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

    if let Some(ref v) = updates.status {
        set_parts.push("status = ?".to_string());
        params.push(Box::new(v.clone()));
    }
    if let Some(ref v) = updates.description {
        set_parts.push("description = ?".to_string());
        params.push(Box::new(v.clone()));
    }
    if let Some(ref v) = updates.title {
        set_parts.push("title = ?".to_string());
        params.push(Box::new(v.clone()));
    }
    if let Some(ref v) = updates.priority {
        set_parts.push("priority = ?".to_string());
        params.push(Box::new(v.clone()));
    }
    if let Some(ref v) = updates.base_branch {
        set_parts.push("base_branch = ?".to_string());
        params.push(Box::new(v.clone()));
    }
    if let Some(ref new_skills) = updates.skills {
        let skills_json = serde_json::to_string(new_skills)
            .map_err(|e| format!("JSON serialization failed: {}", e))?;
        set_parts.push("skills = ?".to_string());
        params.push(Box::new(skills_json));
    }
    if let Some(ref v) = updates.agent_id {
        set_parts.push("agent_id = ?".to_string());
        params.push(Box::new(v.clone()));
    }
    if let Some(ref new_labels) = updates.labels {
        let labels_json = serde_json::to_string(new_labels)
            .map_err(|e| format!("JSON serialization failed: {}", e))?;
        set_parts.push("labels = ?".to_string());
        params.push(Box::new(labels_json));
    }
    if let Some(v) = updates.auto_approve {
        set_parts.push("auto_approve = ?".to_string());
        params.push(Box::new(v));
    }
    if let Some(v) = updates.isolated_worktree {
        set_parts.push("isolated_worktree = ?".to_string());
        params.push(Box::new(v));
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

/// Cancel a task: sets status=Cancelled and archived_at in one statement
#[tauri::command]
#[specta::specta]
pub fn cancel_task(
    app_state: State<Arc<AppState>>,
    task_id: i32,
) -> Result<Task, String> {
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
    let now = Utc::now().to_rfc3339();

    conn.execute(
        "UPDATE tasks SET status = 'Cancelled', archived_at = ?, updated_at = ? WHERE id = ?",
        rusqlite::params![&now, &now, task_id],
    )
    .map_err(|e| e.to_string())?;

    let query = format!("{} WHERE id = ?", TASK_SELECT);
    let task = conn.query_row(&query, [task_id], Task::from_row)
        .map_err(|e| e.to_string())?;
    app_state.app_handle.emit("tasks-changed", ()).ok();
    Ok(task)
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
        "UPDATE tasks SET model_override = ?, mcp_allowlist = ?, skills_override = ?, permission_mode_override = ?, updated_at = ? WHERE id = ?",
        rusqlite::params![&settings.model_override, &mcp_allowlist_value, &skills_override_value, &settings.permission_mode_override, &now, task_id],
    )
    .map_err(|e| format!("Failed to update task settings: {}", e))?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use crate::core::schema::initialize_schema;

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
            Some("valid description here".to_string()),
            vec![], vec![], "main".to_string(),
            None, None, false, true, None,
        )
        .unwrap_err();
        assert!(err.contains("Title must be 3-255 characters"), "got: {err}");
    }

    #[test]
    fn create_task_succeeds_without_description() {
        let conn = test_db();
        let project_id = insert_project(&conn);
        let task = create_task_impl(
            &conn, project_id, "Valid Task Name".to_string(),
            None,
            vec![], vec![], "main".to_string(),
            None, None, false, true, None,
        )
        .unwrap();
        assert_eq!(task.title, "Valid Task Name");
        assert!(task.description.is_none());
    }

    #[test]
    fn create_task_succeeds_with_valid_inputs() {
        let conn = test_db();
        let project_id = insert_project(&conn);
        let task = create_task_impl(
            &conn, project_id,
            "Valid Task Name".to_string(),
            Some("This is a valid description.".to_string()),
            vec!["rust".to_string()], vec![], "main".to_string(),
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
            Some("This task will be deleted.".to_string()),
            vec![], vec![], "main".to_string(),
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
