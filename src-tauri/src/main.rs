// Tauri build script marker
#![cfg_attr(all(not(debug_assertions), target_os = "windows"), windows_subsystem = "windows")]

use maestro::db::{init_db, AppState};
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{Manager};
use tauri_specta::collect_commands;
use specta_typescript::Typescript;

/// Get the app data directory path for the current platform
fn get_app_data_dir() -> PathBuf {
    #[cfg(target_os = "linux")]
    {
        let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
        PathBuf::from(format!("{}/.local/share/maestro", home))
    }
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
        PathBuf::from(format!("{}/Library/Application Support/maestro", home))
    }
    #[cfg(target_os = "windows")]
    {
        let appdata = std::env::var("APPDATA").unwrap_or_else(|_| ".".to_string());
        PathBuf::from(format!("{}\\maestro", appdata))
    }
}

/// Setup hook for Tauri initialization
fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let app_data_dir = get_app_data_dir();
    let db_path = app_data_dir.join("maestro.db");

    // Initialize database
    let conn = init_db(db_path)
        .map_err(|e| format!("Failed to initialize database: {}", e))?;

    let app_state = Arc::new(AppState::new(conn));

    app.manage(app_state);

    println!("Tauri app initialized successfully");
    Ok(())
}

fn main() {
    // Generate TypeScript bindings in debug builds
    let builder = tauri_specta::Builder::<tauri::Wry>::new()
        .commands(collect_commands![
            maestro::ipc::get_projects,
            maestro::ipc::get_connection_projects,
            maestro::ipc::create_project,
            maestro::ipc::get_project,
            maestro::ipc::remove_project,
            maestro::ipc::get_tasks,
            maestro::ipc::create_task,
            maestro::ipc::update_task,
            maestro::ipc::get_settings,
            maestro::ipc::save_settings,
            maestro::ipc::sync_github_issues,
            maestro::ipc::sync_jira_issues,
            maestro::ipc::save_import_config,
            maestro::ipc::lease_worktree,
            maestro::ipc::return_worktree,
            maestro::ipc::get_pool_status,
            maestro::ipc::cleanup_worktree,
            maestro::ipc::recover_dirty_worktrees,
            maestro::ipc::initialize_worktree_pool,
            maestro::ipc::spawn_agent_execution,
            maestro::ipc::get_execution_logs,
            maestro::ipc::retry_execution,
            maestro::ipc::cancel_execution,
            maestro::ipc::attach_terminal,
            maestro::ipc::send_terminal_input,
            maestro::ipc::resize_terminal,
            maestro::ipc::detach_terminal,
            maestro::ipc::pause_agent_execution,
            maestro::ipc::resume_agent_execution,
            maestro::ipc::append_terminal_output,
            maestro::ipc::get_diff_for_review,
            maestro::ipc::save_task_review,
            maestro::ipc::request_changes,
            maestro::ipc::approve_task_and_merge,
            maestro::ipc::get_project_settings,
            maestro::ipc::update_project_settings,
            maestro::ipc::update_task_settings,
            maestro::ipc::get_ssh_connections,
            maestro::ipc::get_ssh_connection,
            maestro::ipc::get_ssh_connection_status,
            maestro::ipc::save_ssh_connection,
            maestro::ipc::connect_ssh_without_credentials,
            maestro::ipc::connect_ssh_with_password,
            maestro::ipc::list_remote_directories,
            maestro::ipc::list_local_directories,
            maestro::ipc::get_default_file_picker_path,
            maestro::ipc::list_drives,
            maestro::ipc::get_system_accent_color,
            maestro::ipc::delete_ssh_connection,
            maestro::ipc::forget_saved_password,
            maestro::ipc::rename_ssh_connection
        ]);

    #[cfg(debug_assertions)]
    builder
        .export(Typescript::default(), "../../src/types/bindings.ts")
        .expect("Failed to export typescript bindings");

    #[cfg(debug_assertions)]
    tauri::Builder::default()
        .setup(setup)
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(builder.invoke_handler())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
