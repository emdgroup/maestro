// Tauri build script marker
#![cfg_attr(all(not(debug_assertions), target_os = "windows"), windows_subsystem = "windows")]

use gsd_demo::db::{init_db, AppState};
use gsd_demo::error::AppError;
use gsd_demo::ipc::{get_projects, get_tasks, create_task, get_settings, save_settings};
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, State};

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
            get_tasks,
            create_task,
            get_settings,
            save_settings
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
