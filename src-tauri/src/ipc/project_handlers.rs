use std::sync::Arc;
use tauri::State;
use chrono::Utc;

use crate::models::{Project, Task, TaskStatus};
use crate::db::{AppState, project_storage};

/// Get list of all projects
#[tauri::command]
pub fn get_projects(app_state: State<Arc<AppState>>) -> Result<Vec<Project>, String> {
    println!("get_projects() called via IPC");
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;

    let mut stmt = conn
        .prepare("SELECT * FROM projects ORDER BY created_at DESC")
        .map_err(|e| e.to_string())?;

    let projects = stmt
        .query_map([], Project::from_row)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(projects)
}

/// Get list of all projects per connections
#[tauri::command]
pub fn get_connection_projects(connection_id: Option<i32>, app_state: State<Arc<AppState>>) -> Result<Vec<Project>, String> {
    println!("get_connection_projects({}) called via IPC", connection_id.unwrap_or(0));
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;

    let mut stmt = conn
        .prepare("SELECT * FROM projects WHERE connection_id = ? ORDER BY created_at DESC ")
        .map_err(|e| e.to_string())?;

    let projects = stmt
        .query_map([connection_id], Project::from_row)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(projects)
}

/// Get or create project by path
#[tauri::command]
pub fn get_project(
    project_id: i32,
    app_state: State<Arc<AppState>>,
) -> Result<Project, String> {
    println!("get_project({}) called via IPC", project_id);
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;

    // Try to find existing project
    let existing: Result<Project, _> = conn.query_row(
        "SELECT * FROM projects WHERE id = ?",
        [&project_id],
        Project::from_row
    );

    if let Ok(project) = existing {
        // Update last_opened timestamp when project is selected
        let now = Utc::now().to_rfc3339();
        conn.execute(
            "UPDATE projects SET last_opened = ? WHERE id = ?",
            rusqlite::params![&now, project.id],
        )
        .map_err(|e| e.to_string())?;
        Ok(project)
    } else {
        Err("Project not found".to_string())
    }
}

/// Create a new project
#[tauri::command]
pub fn create_project(
    app_state: State<Arc<AppState>>,
    path: String,
    connection_id: Option<i32>
) -> Result<Project, String> {
    println!("create_project() called via IPC with path {} and connection_id {:?}", path, connection_id);
    let project_id = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        let existing: Option<i32> = conn.query_row(
            "SELECT id FROM projects WHERE path = ? AND connection_id = ?",
            rusqlite::params![&path, connection_id],
            |row| row.get(0),
        ).ok();
        existing.unwrap_or_else(|| {
            // Create new remote project in database
            let now = Utc::now().to_rfc3339();
            let name = std::path::Path::new(&path)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("Untitled")
                .to_string();
            conn.execute(
                "INSERT INTO projects (name, path, created_at, updated_at, connection_id, last_opened) VALUES (?, ?, ?, ?, ?, ?)",
                rusqlite::params![&name, &path, &now, &now, connection_id, &now],
            ).expect(&format!("Failed to insert project {}", name));
            conn.last_insert_rowid() as i32
        })
    };

    // Initialize .maestro folder structure for project-local storage
    // (Phase 18 architectural change: state stored locally, not in global database)
    project_storage::create_project_maestro_folder(&path)
        .map_err(|e| format!("Failed to initialize project storage: {}", e))?;

    let project = get_project(project_id, app_state).map_err(|e| e.to_string())?;
    Ok(project)
}

/// Get list of all tasks for a project
#[tauri::command]
pub fn get_tasks(
    app_state: State<Arc<AppState>>,
    project_id: i32,
) -> Result<Vec<Task>, String> {
    println!("get_tasks({}) called via IPC", project_id);
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;

    let mut stmt = conn
        .prepare(
            "SELECT id, project_id, name, description, acceptance_criteria, skills, status, external_id, is_imported, import_source, model_override, mcp_allowlist, skills_override, created_at, updated_at
             FROM tasks WHERE project_id = ? ORDER BY created_at DESC",
        )
        .map_err(|e| e.to_string())?;

    let tasks = stmt
        .query_map([project_id], |row| {
            Ok(Task {
                id: row.get(0)?,
                project_id: row.get(1)?,
                name: row.get(2)?,
                description: row.get(3)?,
                acceptance_criteria: row.get(4)?,
                skills: serde_json::from_str(&row.get::<_, String>(5)?).unwrap_or_default(),
                status: match row.get::<_, String>(6)?.as_str() {
                    "Ready" => TaskStatus::Ready,
                    "InProgress" => TaskStatus::InProgress,
                    "Review" => TaskStatus::Review,
                    "Done" => TaskStatus::Done,
                    "Merging" => TaskStatus::Merging,
                    _ => TaskStatus::Backlog,
                },
                external_id: row.get(7)?,
                is_imported: row.get(8)?,
                import_source: row.get(9)?,
                model_override: row.get(10)?,
                mcp_allowlist: row.get::<_, Option<String>>(11)?.and_then(|s| serde_json::from_str(&s).ok()),
                skills_override: row.get::<_, Option<String>>(12)?.and_then(|s| serde_json::from_str(&s).ok()),
                created_at: row.get(13)?,
                updated_at: row.get(14)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(tasks)
}

/// Create a new task with validation
#[tauri::command]
pub fn create_task(
    app_state: State<Arc<AppState>>,
    project_id: i32,
    name: String,
    description: String,
    acceptance_criteria: String,
    skills: Vec<String>,
) -> Result<Task, String> {
    println!("create_task() called via IPC with name: {}", name);

    // Validate inputs
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
        rusqlite::params![
            project_id,
            &name,
            &description,
            &acceptance_criteria,
            &skills_json,
            "Backlog",
            &now,
            &now
        ],
    )
    .map_err(|e| e.to_string())?;

    let task_id = conn.last_insert_rowid();

    // Fetch and return created task
    let mut stmt = conn.prepare(
        "SELECT id, project_id, name, description, acceptance_criteria, skills, status, external_id, is_imported, import_source, model_override, mcp_allowlist, skills_override, created_at, updated_at
         FROM tasks WHERE id = ?"
    )
    .map_err(|e| e.to_string())?;

    let task = stmt.query_row([task_id], |row| {
        Ok(Task {
            id: row.get(0)?,
            project_id: row.get(1)?,
            name: row.get(2)?,
            description: row.get(3)?,
            acceptance_criteria: Some(row.get::<_, String>(4)?),
            skills: serde_json::from_str(&row.get::<_, String>(5)?).unwrap_or_default(),
            status: match row.get::<_, String>(6)?.as_str() {
                "Ready" => TaskStatus::Ready,
                "InProgress" => TaskStatus::InProgress,
                "Review" => TaskStatus::Review,
                "Done" => TaskStatus::Done,
                "Merging" => TaskStatus::Merging,
                _ => TaskStatus::Backlog,
            },
            external_id: row.get(7)?,
            is_imported: row.get(8)?,
            import_source: row.get(9)?,
            model_override: row.get(10)?,
            mcp_allowlist: row.get::<_, Option<String>>(11)?.and_then(|s| serde_json::from_str(&s).ok()),
            skills_override: row.get::<_, Option<String>>(12)?.and_then(|s| serde_json::from_str(&s).ok()),
            created_at: row.get(13)?,
            updated_at: row.get(14)?,
        })
    })
    .map_err(|e| e.to_string())?;

    Ok(task)
}

/// Update a task's status or other fields
#[tauri::command]
pub fn update_task(
    app_state: State<Arc<AppState>>,
    task_id: i32,
    status: Option<String>,
    description: Option<String>,
) -> Result<Task, String> {
    println!("update_task({}) called via IPC", task_id);
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;

    let now = Utc::now().to_rfc3339();

    // Update status if provided
    if let Some(ref new_status) = status {
        conn.execute(
            "UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?",
            rusqlite::params![&new_status, &now, task_id],
        )
        .map_err(|e| e.to_string())?;
    }

    // Update description if provided
    if let Some(ref new_description) = description {
        conn.execute(
            "UPDATE tasks SET description = ?, updated_at = ? WHERE id = ?",
            rusqlite::params![&new_description, &now, task_id],
        )
        .map_err(|e| e.to_string())?;
    }

    // If neither provided, at least update updated_at
    if status.is_none() && description.is_none() {
        conn.execute(
            "UPDATE tasks SET updated_at = ? WHERE id = ?",
            rusqlite::params![&now, task_id],
        )
        .map_err(|e| e.to_string())?;
    }

    // Fetch and return updated task
    conn.query_row(
        "SELECT id, project_id, name, description, acceptance_criteria, skills, status, external_id, is_imported, import_source, model_override, mcp_allowlist, skills_override, created_at, updated_at FROM tasks WHERE id = ?",
        [task_id],
        |row| {
            Ok(Task {
                id: row.get(0)?,
                project_id: row.get(1)?,
                name: row.get(2)?,
                description: row.get(3)?,
                acceptance_criteria: row.get(4)?,
                skills: serde_json::from_str(&row.get::<_, String>(5)?).unwrap_or_default(),
                status: match row.get::<_, String>(6)?.as_str() {
                    "Ready" => TaskStatus::Ready,
                    "InProgress" => TaskStatus::InProgress,
                    "Review" => TaskStatus::Review,
                    "Done" => TaskStatus::Done,
                    "Merging" => TaskStatus::Merging,
                    _ => TaskStatus::Backlog,
                },
                external_id: row.get(7)?,
                is_imported: row.get(8)?,
                import_source: row.get(9)?,
                model_override: row.get(10)?,
                mcp_allowlist: row.get::<_, Option<String>>(11)?.and_then(|s| serde_json::from_str(&s).ok()),
                skills_override: row.get::<_, Option<String>>(12)?.and_then(|s| serde_json::from_str(&s).ok()),
                created_at: row.get(13)?,
                updated_at: row.get(14)?,
            })
        },
    )
    .map_err(|e| e.to_string())
}

/// Get project-level configuration (model default, MCP allowlist, skills default)
#[tauri::command]
pub fn get_project_settings(
    app_state: State<Arc<AppState>>,
    _project_id: i32,
) -> Result<crate::models::ProjectConfigResponse, String> {
    println!("get_project_settings() called via IPC");
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;

    // Query settings table for configuration keys
    let mut stmt = conn
        .prepare("SELECT key, value FROM settings WHERE key IN ('model_default', 'mcp_allowlist', 'skills_default')")
        .map_err(|e| e.to_string())?;

    let mut settings_map: std::collections::HashMap<String, String> = std::collections::HashMap::new();

    let settings_iter = stmt
        .query_map([], |row| {
            let key: String = row.get(0)?;
            let value: String = row.get(1)?;
            Ok((key, value))
        })
        .map_err(|e| e.to_string())?;

    for result in settings_iter {
        let (key, value) = result.map_err(|e| e.to_string())?;
        settings_map.insert(key, value);
    }

    // Extract values with defaults
    let model_default = settings_map
        .get("model_default")
        .cloned()
        .unwrap_or_else(|| "claude-opus-4-5".to_string());

    let mcp_allowlist: Vec<String> = settings_map
        .get("mcp_allowlist")
        .and_then(|v| serde_json::from_str(v).ok())
        .unwrap_or_default();

    let skills_default: Vec<String> = settings_map
        .get("skills_default")
        .and_then(|v| serde_json::from_str(v).ok())
        .unwrap_or_default();

    Ok(crate::models::ProjectConfigResponse {
        model_default,
        mcp_allowlist,
        skills_default,
    })
}

/// Update project-level configuration
#[tauri::command]
pub fn update_project_settings(
    app_state: State<Arc<AppState>>,
    _project_id: i32,
    settings: crate::models::ProjectConfigRequest,
) -> Result<(), String> {
    println!("update_project_settings() called via IPC");
    let mut conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;

    // Serialize arrays to JSON
    let mcp_allowlist_json = serde_json::to_string(&settings.mcp_allowlist)
        .map_err(|e| format!("Failed to serialize mcp_allowlist: {}", e))?;

    let skills_default_json = serde_json::to_string(&settings.skills_default)
        .map_err(|e| format!("Failed to serialize skills_default: {}", e))?;

    let now = Utc::now().to_rfc3339();

    // Use transaction for atomic writes
    let tx = conn
        .transaction()
        .map_err(|e| format!("Failed to start transaction: {}", e))?;

    // Upsert each setting
    tx.execute(
        "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('model_default', ?, ?)",
        rusqlite::params![&settings.model_default, &now],
    )
    .map_err(|e| format!("Failed to update model_default: {}", e))?;

    tx.execute(
        "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('mcp_allowlist', ?, ?)",
        rusqlite::params![&mcp_allowlist_json, &now],
    )
    .map_err(|e| format!("Failed to update mcp_allowlist: {}", e))?;

    tx.execute(
        "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('skills_default', ?, ?)",
        rusqlite::params![&skills_default_json, &now],
    )
    .map_err(|e| format!("Failed to update skills_default: {}", e))?;

    tx.commit()
        .map_err(|e| format!("Failed to commit transaction: {}", e))?;

    println!("✓ Project settings updated");
    Ok(())
}

/// Update task-level configuration overrides
#[tauri::command]
pub fn update_task_settings(
    app_state: State<Arc<AppState>>,
    task_id: i32,
    settings: crate::models::TaskConfigRequest,
) -> Result<(), String> {
    println!("update_task_settings({}) called via IPC", task_id);
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;

    let now = Utc::now().to_rfc3339();

    // Serialize optional arrays to JSON or NULL
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

    // Update task with configuration overrides
    conn.execute(
        "UPDATE tasks SET model_override = ?, mcp_allowlist = ?, skills_override = ?, updated_at = ? WHERE id = ?",
        rusqlite::params![
            &settings.model_override,
            &mcp_allowlist_value,
            &skills_override_value,
            &now,
            task_id
        ],
    )
    .map_err(|e| format!("Failed to update task settings: {}", e))?;

    println!("✓ Task {} settings updated", task_id);
    Ok(())
}
