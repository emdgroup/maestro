use std::sync::Arc;
use tauri::State;

use crate::models::{Project, Task, AppSettings, ProjectStatus, TaskStatus};
use crate::db::AppState;

/// Get list of all projects
/// DB queries will be added in Phase 2 when database schema is populated
#[tauri::command]
pub fn get_projects() -> Result<Vec<Project>, String> {
    println!("get_projects() called via IPC");
    // Stub: return empty list for now
    Ok(vec![])
}

/// Get list of all tasks for a project
/// DB queries will be added in Phase 2 when database schema is populated
#[tauri::command]
pub fn get_tasks(project_id: i32) -> Result<Vec<Task>, String> {
    println!("get_tasks({}) called via IPC", project_id);
    // Stub: return empty list for now
    Ok(vec![])
}

/// Create a new task
/// DB queries will be added in Phase 2 when database schema is populated
#[tauri::command]
pub fn create_task(name: String, description: String) -> Result<Task, String> {
    println!("create_task() called via IPC with name: {}", name);
    // Stub: return placeholder task
    Ok(Task {
        id: 0,
        project_id: 0,
        name,
        description,
        status: TaskStatus::Backlog,
        created_at: chrono::Utc::now().to_rfc3339(),
        updated_at: chrono::Utc::now().to_rfc3339(),
    })
}

/// Get application settings from database
#[tauri::command]
pub fn get_settings(app_state: State<Arc<AppState>>) -> Result<AppSettings, String> {
    println!("get_settings() called via IPC");
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
    crate::db::settings::load_settings(&conn).map_err(|e| e.to_string())
}

/// Save application settings to database
#[tauri::command]
pub fn save_settings(
    app_state: State<Arc<AppState>>,
    settings: AppSettings,
) -> Result<(), String> {
    println!("save_settings() called via IPC with project_path: {:?}", settings.project_path);
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
    crate::db::settings::save_settings(&conn, &settings).map_err(|e| e.to_string())
}
