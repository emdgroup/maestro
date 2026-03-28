use std::sync::Arc;
use tauri::State;
use chrono::Utc;
use crate::models::{Task, TaskRelationship, TaskInstruction};
use crate::db::AppState;

const TASK_SELECT: &str =
    "SELECT id, project_id, name, description, acceptance_criteria, status, priority, \
     origin_branch, archived_at, external_id, is_imported, import_source, skills, \
     model_override, mcp_allowlist, skills_override, created_at, updated_at FROM tasks";

/// Get list of all tasks for a project
#[tauri::command]
#[specta::specta]
pub fn get_tasks(
    app_state: State<Arc<AppState>>,
    project_id: i32,
) -> Result<Vec<Task>, String> {
    println!("get_tasks({}) called via IPC", project_id);
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

/// Create a new task with validation
#[tauri::command]
#[specta::specta]
pub fn create_task(
    app_state: State<Arc<AppState>>,
    project_id: i32,
    name: String,
    description: String,
    acceptance_criteria: String,
    skills: Vec<String>,
) -> Result<Task, String> {
    println!("create_task() called via IPC with name: {}", name);

    let trimmed_name = name.trim();
    if trimmed_name.is_empty() || trimmed_name.len() < 3 || trimmed_name.len() > 255 {
        return Err("Name must be 3-255 characters".to_string());
    }
    let trimmed_description = description.trim();
    if trimmed_description.is_empty() || trimmed_description.len() < 10 {
        return Err("Description must be at least 10 characters".to_string());
    }
    let trimmed_criteria = acceptance_criteria.trim();
    if trimmed_criteria.is_empty() || trimmed_criteria.len() < 10 {
        return Err("Acceptance criteria must be at least 10 characters".to_string());
    }

    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
    let now = Utc::now().to_rfc3339();
    let skills_json = serde_json::to_string(&skills)
        .map_err(|e| format!("JSON serialization failed: {}", e))?;

    conn.execute(
        "INSERT INTO tasks (project_id, name, description, acceptance_criteria, skills, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        rusqlite::params![project_id, &name, &description, &acceptance_criteria, &skills_json, "Backlog", &now, &now],
    )
    .map_err(|e| e.to_string())?;

    let task_id = conn.last_insert_rowid();
    let query = format!("{} WHERE id = ?", TASK_SELECT);
    conn.query_row(&query, [task_id], Task::from_row)
        .map_err(|e| e.to_string())
}

/// Update a task's status or other fields
#[tauri::command]
#[specta::specta]
pub fn update_task(
    app_state: State<Arc<AppState>>,
    task_id: i32,
    status: Option<String>,
    description: Option<String>,
    name: Option<String>,
    priority: Option<String>,
    acceptance_criteria: Option<String>,
    origin_branch: Option<String>,
    skills: Option<Vec<String>>,
) -> Result<Task, String> {
    println!("update_task({}) called via IPC", task_id);
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
    let now = Utc::now().to_rfc3339();

    if let Some(ref new_status) = status {
        conn.execute(
            "UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?",
            rusqlite::params![&new_status, &now, task_id],
        )
        .map_err(|e| e.to_string())?;
    }

    if let Some(ref new_description) = description {
        conn.execute(
            "UPDATE tasks SET description = ?, updated_at = ? WHERE id = ?",
            rusqlite::params![&new_description, &now, task_id],
        )
        .map_err(|e| e.to_string())?;
    }

    if let Some(ref new_name) = name {
        conn.execute(
            "UPDATE tasks SET name = ?, updated_at = ? WHERE id = ?",
            rusqlite::params![&new_name, &now, task_id],
        )
        .map_err(|e| e.to_string())?;
    }

    if let Some(ref new_priority) = priority {
        conn.execute(
            "UPDATE tasks SET priority = ?, updated_at = ? WHERE id = ?",
            rusqlite::params![&new_priority, &now, task_id],
        )
        .map_err(|e| e.to_string())?;
    }

    if let Some(ref new_ac) = acceptance_criteria {
        conn.execute(
            "UPDATE tasks SET acceptance_criteria = ?, updated_at = ? WHERE id = ?",
            rusqlite::params![&new_ac, &now, task_id],
        )
        .map_err(|e| e.to_string())?;
    }

    if let Some(ref new_branch) = origin_branch {
        conn.execute(
            "UPDATE tasks SET origin_branch = ?, updated_at = ? WHERE id = ?",
            rusqlite::params![&new_branch, &now, task_id],
        )
        .map_err(|e| e.to_string())?;
    }

    if let Some(ref new_skills) = skills {
        let skills_json = serde_json::to_string(new_skills)
            .map_err(|e| format!("JSON serialization failed: {}", e))?;
        conn.execute(
            "UPDATE tasks SET skills = ?, updated_at = ? WHERE id = ?",
            rusqlite::params![&skills_json, &now, task_id],
        )
        .map_err(|e| e.to_string())?;
    }

    if status.is_none()
        && description.is_none()
        && name.is_none()
        && priority.is_none()
        && acceptance_criteria.is_none()
        && origin_branch.is_none()
        && skills.is_none()
    {
        conn.execute(
            "UPDATE tasks SET updated_at = ? WHERE id = ?",
            rusqlite::params![&now, task_id],
        )
        .map_err(|e| e.to_string())?;
    }

    let query = format!("{} WHERE id = ?", TASK_SELECT);
    conn.query_row(&query, [task_id], Task::from_row)
        .map_err(|e| e.to_string())
}

/// Update task-level configuration overrides
#[tauri::command]
#[specta::specta]
pub fn update_task_settings(
    app_state: State<Arc<AppState>>,
    task_id: i32,
    settings: crate::models::TaskConfigRequest,
) -> Result<(), String> {
    println!("update_task_settings({}) called via IPC", task_id);
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
    let now = Utc::now().to_rfc3339();

    let mcp_allowlist_value = settings
        .mcp_allowlist
        .as_ref()
        .map(|v| serde_json::to_string(v))
        .transpose()
        .map_err(|e| format!("Failed to serialize mcp_allowlist: {}", e))?;

    let skills_override_value = settings
        .skills_override
        .as_ref()
        .map(|v| serde_json::to_string(v))
        .transpose()
        .map_err(|e| format!("Failed to serialize skills_override: {}", e))?;

    conn.execute(
        "UPDATE tasks SET model_override = ?, mcp_allowlist = ?, skills_override = ?, updated_at = ? WHERE id = ?",
        rusqlite::params![&settings.model_override, &mcp_allowlist_value, &skills_override_value, &now, task_id],
    )
    .map_err(|e| format!("Failed to update task settings: {}", e))?;

    println!("✓ Task {} settings updated", task_id);
    Ok(())
}

/// Archive a task by setting its archived_at timestamp
#[tauri::command]
#[specta::specta]
pub fn archive_task(
    app_state: State<Arc<AppState>>,
    task_id: i32,
) -> Result<Task, String> {
    println!("archive_task({}) called via IPC", task_id);
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
    let now = Utc::now().to_rfc3339();

    conn.execute(
        "UPDATE tasks SET archived_at = ?, updated_at = ? WHERE id = ?",
        rusqlite::params![&now, &now, task_id],
    )
    .map_err(|e| e.to_string())?;

    let query = format!("{} WHERE id = ?", TASK_SELECT);
    conn.query_row(&query, [task_id], Task::from_row)
        .map_err(|e| e.to_string())
}

/// Delete a task by id
#[tauri::command]
#[specta::specta]
pub fn delete_task(app_state: State<Arc<AppState>>, task_id: i32) -> Result<(), String> {
    println!("delete_task({}) called via IPC", task_id);
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
    conn.execute("DELETE FROM tasks WHERE id = ?", [task_id])
        .map_err(|e| e.to_string())?;
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
) -> Result<(Vec<String>, String), String> {
    println!("list_project_branches({}) called via IPC", project_id);

    // Look up the project to get its path
    let project = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        conn.query_row(
            "SELECT id, name, path, created_at, updated_at, last_opened, connection_id FROM projects WHERE id = ?",
            [project_id],
            crate::models::Project::from_row,
        )
        .map_err(|e| e.to_string())?
    };

    let git_conn = crate::db::get_git_connection(&project, &app_state).await
        .unwrap_or_else(|_| crate::models::GitConnection::Local { path: project.path.clone() });

    let branches = crate::git::list_branches(&git_conn).await.unwrap_or_default();
    let current_branch = crate::git::get_current_branch(&git_conn).await.unwrap_or_else(|_| "main".to_string());

    Ok((branches, current_branch))
}
