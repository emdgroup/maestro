// Tauri build script marker
#![cfg_attr(all(not(debug_assertions), target_os = "windows"), windows_subsystem = "windows")]

use gsd_demo::db::{init_db, AppState};
use gsd_demo::models::{Task, AppSettings};
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{Manager, State};

/// Get the app data directory path for the current platform
fn get_app_data_dir() -> PathBuf {
    #[cfg(target_os = "linux")]
    {
        let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
        PathBuf::from(format!("{}/.local/share/gsd-demo", home))
    }
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
        PathBuf::from(format!("{}/Library/Application Support/gsd-demo", home))
    }
    #[cfg(target_os = "windows")]
    {
        let appdata = std::env::var("APPDATA").unwrap_or_else(|_| ".".to_string());
        PathBuf::from(format!("{}\\gsd-demo", appdata))
    }
}

// Tauri command wrappers that call the library functions
#[tauri::command]
fn get_projects(app_state: State<Arc<AppState>>) -> Result<Vec<gsd_demo::models::Project>, String> {
    gsd_demo::ipc::handlers::get_projects(app_state)
}

#[tauri::command]
fn get_or_create_project(app_state: State<Arc<AppState>>, project_path: String) -> Result<gsd_demo::models::Project, String> {
    gsd_demo::ipc::handlers::get_or_create_project(app_state, project_path)
}

#[tauri::command]
fn get_tasks(app_state: State<Arc<AppState>>, project_id: i32) -> Result<Vec<Task>, String> {
    gsd_demo::ipc::handlers::get_tasks(app_state, project_id)
}

#[tauri::command]
fn create_task(app_state: State<Arc<AppState>>, project_id: i32, name: String, description: String, acceptance_criteria: String, skills: Vec<String>) -> Result<Task, String> {
    gsd_demo::ipc::handlers::create_task(app_state, project_id, name, description, acceptance_criteria, skills)
}

#[tauri::command]
fn update_task(app_state: State<Arc<AppState>>, task_id: i32, status: Option<String>, description: Option<String>) -> Result<Task, String> {
    gsd_demo::ipc::handlers::update_task(app_state, task_id, status, description)
}

#[tauri::command]
fn get_settings(app_state: State<Arc<AppState>>) -> Result<AppSettings, String> {
    gsd_demo::ipc::handlers::get_settings(app_state)
}

#[tauri::command]
fn save_settings(app_state: State<Arc<AppState>>, settings: AppSettings) -> Result<(), String> {
    gsd_demo::ipc::handlers::save_settings(app_state, settings)
}

/// Setup hook for Tauri initialization
fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let app_data_dir = get_app_data_dir();
    let db_path = app_data_dir.join("gsd-demo.db");

    // Initialize database
    let conn = init_db(db_path)
        .map_err(|e| format!("Failed to initialize database: {}", e))?;

    let app_state = Arc::new(AppState::new(conn));
    app.manage(app_state);

    println!("Tauri app initialized successfully");
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .setup(setup)
        .invoke_handler(tauri::generate_handler![
            get_projects,
            get_or_create_project,
            get_tasks,
            create_task,
            update_task,
            get_settings,
            save_settings
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
