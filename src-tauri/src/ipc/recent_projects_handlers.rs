use std::sync::Arc;
use serde::{Deserialize, Serialize};
use tauri::State;
use ts_rs::TS;
use crate::models::Project;
use crate::db::AppState;

/// Get recent projects with metadata for rich display
#[tauri::command]
pub fn get_recent_projects_enhanced(
    app_state: State<Arc<AppState>>
) -> Result<Vec<EnhancedRecentProject>, String> {
    println!("get_recent_projects_enhanced() called via IPC");

    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;

    // Get recent_projects from settings
    let settings = crate::db::settings::load_settings(&conn)
        .map_err(|e| format!("Failed to load settings: {}", e))?;

    let mut enhanced = Vec::new();

    for path in settings.recent_projects {
        // Query projects table for full info including last_opened
        let project_info: Result<Project, _> = conn.query_row(
            "SELECT * FROM projects WHERE path = ?",
            [&path],
            Project::from_row,
        );

        if let Ok(project) = project_info {
            // Fetch SSH connection details if this is a remote project
            let (host, username) = if let Some(conn_id) = project.connection_id {
                let result: Result<(String, String), _> = conn.query_row(
                    "SELECT host, username FROM ssh_connections WHERE id = ?",
                    [conn_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                );
                match result {
                    Ok((h, u)) => (Some(h), Some(u)),
                    Err(_) => (None, None),
                }
            } else {
                (None, None)
            };

            enhanced.push(EnhancedRecentProject {
                path: project.path,
                name: project.name,
                connection_id: project.connection_id,
                host,
                username,
                last_opened: project.last_opened.unwrap_or(project.created_at),
            });
        }
    }

    Ok(enhanced)
}

/// Validate and clean up recent projects list
#[tauri::command]
pub fn validate_recent_projects(
    app_state: State<Arc<AppState>>
) -> Result<Vec<String>, String> {
    println!("validate_recent_projects() called via IPC");

    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;

    // Get current recent_projects
    let settings = crate::db::settings::load_settings(&conn)
        .map_err(|e| format!("Failed to load settings: {}", e))?;

    // Filter to only projects that exist in database
    let mut valid_projects = Vec::new();
    for path in settings.recent_projects {
        let exists: bool = conn.query_row(
            "SELECT 1 FROM projects WHERE path = ?",
            [&path],
            |_| Ok(true),
        ).unwrap_or(false);

        if exists {
            valid_projects.push(path);
        }
    }

    Ok(valid_projects)
}

/// Remove project from recent list
#[tauri::command]
pub fn remove_recent_project(
    app_state: State<Arc<AppState>>,
    path: String,
) -> Result<(), String> {
    println!("remove_recent_project({}) called via IPC", path);

    let mut conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;

    // Get current settings
    let mut settings = crate::db::settings::load_settings(&conn)
        .map_err(|e| format!("Failed to load settings: {}", e))?;

    // Remove path from recent_projects
    settings.recent_projects.retain(|p| p != &path);

    // Save updated settings
    crate::db::settings::save_settings(&mut conn, &settings)
        .map_err(|e| format!("Failed to save settings: {}", e))?;

    println!("✓ Removed {} from recent projects", path);
    Ok(())
}


/// Recent project with display metadata
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct EnhancedRecentProject {
    pub path: String,
    pub name: String,
    pub connection_id: Option<i64>,
    pub host: Option<String>,
    pub username: Option<String>,
    pub last_opened: String,  // ISO 8601
}
