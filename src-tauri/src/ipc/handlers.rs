use std::sync::Arc;
use tauri::State;

use crate::models::{Project, Task, AppSettings, TaskStatus};
use crate::db::AppState;

/// Get list of all projects
#[tauri::command]
pub fn get_projects(app_state: State<Arc<AppState>>) -> Result<Vec<Project>, String> {
    println!("get_projects() called via IPC");
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;

    let mut stmt = conn
        .prepare("SELECT id, name, path, created_at FROM projects ORDER BY created_at DESC")
        .map_err(|e| e.to_string())?;

    let projects = stmt
        .query_map([], |row| {
            Ok(Project {
                id: row.get(0)?,
                name: row.get(1)?,
                path: row.get(2)?,
                created_at: row.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(projects)
}

/// Get or create project by path
#[tauri::command]
pub fn get_or_create_project(
    app_state: State<Arc<AppState>>,
    path: String,
) -> Result<Project, String> {
    println!("get_or_create_project({}) called via IPC", path);
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;

    // Try to find existing project
    let existing: Result<Project, _> = conn.query_row(
        "SELECT id, name, path, created_at FROM projects WHERE path = ?",
        [&path],
        |row| {
            Ok(Project {
                id: row.get(0)?,
                name: row.get(1)?,
                path: row.get(2)?,
                created_at: row.get(3)?,
            })
        },
    );

    if let Ok(project) = existing {
        return Ok(project);
    }

    // Create new project
    let now = chrono::Utc::now().to_rfc3339();
    let name = std::path::Path::new(&path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("Untitled")
        .to_string();

    conn.execute(
        "INSERT INTO projects (name, path, created_at, updated_at) VALUES (?, ?, ?, ?)",
        rusqlite::params![&name, &path, &now, &now],
    )
    .map_err(|e| e.to_string())?;

    let project_id = conn.last_insert_rowid() as i32;

    Ok(Project {
        id: project_id,
        name,
        path,
        created_at: now,
    })
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
            "SELECT id, project_id, name, description, acceptance_criteria, skills, status, external_id, is_imported, import_source, created_at, updated_at
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
                    _ => TaskStatus::Backlog,
                },
                external_id: row.get(7)?,
                is_imported: row.get(8)?,
                import_source: row.get(9)?,
                created_at: row.get(10)?,
                updated_at: row.get(11)?,
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

    let now = chrono::Utc::now().to_rfc3339();
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

    let task_id = conn.last_insert_rowid() as i32;

    // Fetch and return created task
    let mut stmt = conn.prepare(
        "SELECT id, project_id, name, description, acceptance_criteria, skills, status, external_id, is_imported, import_source, created_at, updated_at
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
                _ => TaskStatus::Backlog,
            },
            external_id: row.get(7)?,
            is_imported: row.get(8)?,
            import_source: row.get(9)?,
            created_at: row.get(10)?,
            updated_at: row.get(11)?,
        })
    })
    .map_err(|e| e.to_string())?;

    Ok(task)
}

/// Get application settings from database
#[tauri::command]
pub fn get_settings(app_state: State<Arc<AppState>>) -> Result<AppSettings, String> {
    println!("get_settings() called via IPC");
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
    crate::db::settings::load_settings(&conn).map_err(|e| e.to_string())
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

    let now = chrono::Utc::now().to_rfc3339();

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
        "SELECT id, project_id, name, description, acceptance_criteria, skills, status, external_id, is_imported, import_source, created_at, updated_at FROM tasks WHERE id = ?",
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
                    _ => TaskStatus::Backlog,
                },
                external_id: row.get(7)?,
                is_imported: row.get(8)?,
                import_source: row.get(9)?,
                created_at: row.get(10)?,
                updated_at: row.get(11)?,
            })
        },
    )
    .map_err(|e| e.to_string())
}

/// Save application settings to database
#[tauri::command]
pub fn save_settings(
    app_state: State<Arc<AppState>>,
    settings: AppSettings,
) -> Result<(), String> {
    println!("save_settings() called via IPC with project_path: {:?}", settings.project_path);
    let mut conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
    crate::db::settings::save_settings(&mut *conn, &settings).map_err(|e| e.to_string())
}
