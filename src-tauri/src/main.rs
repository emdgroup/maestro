// Tauri build script marker
#![cfg_attr(all(not(debug_assertions), target_os = "windows"), windows_subsystem = "windows")]

use maestro::db::{init_db, AppState};
use maestro::models::{Task, AppSettings};
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{Manager, State};
use serde_json;

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

// Tauri command wrappers that call the library functions
#[tauri::command]
fn get_projects(app_state: State<Arc<AppState>>) -> Result<Vec<maestro::models::Project>, String> {
    maestro::ipc::get_projects(app_state)
}

#[tauri::command]
fn get_connection_projects(app_state: State<Arc<AppState>>, connection_id: Option<i32>) -> Result<Vec<maestro::models::Project>, String> {
    maestro::ipc::get_connection_projects(app_state, connection_id)
}

#[tauri::command]
fn create_project(
    app_state: State<Arc<AppState>>,
    project_path: String,
    connection_id: Option<i32>,
) -> Result<maestro::models::Project, String> {
    maestro::ipc::create_project(app_state, project_path, connection_id)
}

#[tauri::command]
fn get_project(app_state: State<Arc<AppState>>, project_id: i32) -> Result<maestro::models::Project, String> {
    maestro::ipc::get_project(app_state, project_id)
}

#[tauri::command]
fn remove_project(app_state: State<Arc<AppState>>, project_id: i32) -> Result<(), String> {
    maestro::ipc::remove_project(app_state, project_id)
}

#[tauri::command]
fn get_tasks(app_state: State<Arc<AppState>>, project_id: i32) -> Result<Vec<Task>, String> {
    maestro::ipc::get_tasks(app_state, project_id)
}

#[tauri::command]
fn create_task(app_state: State<Arc<AppState>>, project_id: i32, name: String, description: String, acceptance_criteria: String, skills: Vec<String>) -> Result<Task, String> {
    maestro::ipc::create_task(app_state, project_id, name, description, acceptance_criteria, skills)
}

#[tauri::command]
fn update_task(app_state: State<Arc<AppState>>, task_id: i32, status: Option<String>, description: Option<String>) -> Result<Task, String> {
    maestro::ipc::update_task(app_state, task_id, status, description)
}

#[tauri::command]
fn get_settings(app_state: State<Arc<AppState>>) -> Result<AppSettings, String> {
    maestro::ipc::get_settings(app_state)
}

#[tauri::command]
fn save_settings(app_state: State<Arc<AppState>>, settings: AppSettings) -> Result<(), String> {
    maestro::ipc::save_settings(app_state, settings)
}

#[tauri::command]
async fn sync_github_issues(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    owner: String,
    repo: String,
    token: String,
) -> Result<maestro::models::SyncResult, String> {
    maestro::ipc::sync_github_issues(app_state, project_id, owner, repo, token).await
}

#[tauri::command]
async fn sync_jira_issues(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    host: String,
    email: String,
    api_token: String,
    jql: String,
) -> Result<maestro::models::SyncResult, String> {
    maestro::ipc::sync_jira_issues(app_state, project_id, host, email, api_token, jql).await
}

#[tauri::command]
fn save_import_config(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    provider: String,
    config: serde_json::Value,
) -> Result<(), String> {
    maestro::ipc::save_import_config(app_state, project_id, provider, config)
}

#[tauri::command]
async fn lease_worktree(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    task_id: i32,
    repo_path: String,
) -> Result<maestro::models::Worktree, String> {
    maestro::ipc::lease_worktree(app_state, project_id, task_id, repo_path).await
}

#[tauri::command]
fn return_worktree(
    app_state: State<'_, Arc<AppState>>,
    worktree_id: i32,
) -> Result<(), String> {
    maestro::ipc::return_worktree(app_state, worktree_id)
}

#[tauri::command]
fn get_pool_status(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
) -> Result<maestro::models::PoolStatus, String> {
    maestro::ipc::get_pool_status(app_state, project_id)
}

#[tauri::command]
async fn cleanup_worktree(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    worktree_id: i32,
    repo_path: String,
) -> Result<(), String> {
    maestro::ipc::cleanup_worktree(app_state, project_id, worktree_id, repo_path).await
}

#[tauri::command]
async fn recover_dirty_worktrees(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    repo_path: String,
) -> Result<Vec<i32>, String> {
    maestro::ipc::recover_dirty_worktrees(app_state, project_id, repo_path).await
}

#[tauri::command]
fn initialize_worktree_pool(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    repo_path: String,
    pool_size: Option<i32>,
) -> Result<maestro::models::PoolStatus, String> {
    maestro::ipc::initialize_worktree_pool(app_state, project_id, repo_path, pool_size)
}

#[tauri::command]
async fn spawn_agent_execution(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    task_id: i32,
    repo_path: String,
) -> Result<i32, String> {
    maestro::ipc::spawn_agent_execution(app_state, project_id, task_id, repo_path).await
}

#[tauri::command]
fn get_execution_logs(
    app_state: State<Arc<AppState>>,
    task_id: i32,
) -> Result<Vec<maestro::models::ExecutionLog>, String> {
    maestro::ipc::get_execution_logs(app_state, task_id)
}

#[tauri::command]
async fn retry_execution(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    task_id: i32,
    repo_path: String,
) -> Result<i32, String> {
    maestro::ipc::retry_execution(app_state, project_id, task_id, repo_path).await
}

#[tauri::command]
fn cancel_execution(
    app_state: State<Arc<AppState>>,
    log_id: i32,
) -> Result<(), String> {
    maestro::ipc::cancel_execution(app_state, log_id)
}

#[tauri::command]
async fn attach_terminal(
    app_state: State<'_, Arc<AppState>>,
    task_id: i32,
    output_channel: tauri::ipc::Channel<String>,
    include_history: Option<bool>,
) -> Result<(), String> {
    maestro::ipc::attach_terminal(app_state, task_id, output_channel, include_history).await
}

#[tauri::command]
async fn send_terminal_input(
    app_state: State<'_, Arc<AppState>>,
    task_id: i32,
    input: String,
) -> Result<(), String> {
    maestro::ipc::send_terminal_input(app_state, task_id, input).await
}

#[tauri::command]
async fn resize_terminal(
    app_state: State<'_, Arc<AppState>>,
    task_id: i32,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    maestro::ipc::resize_terminal(app_state, task_id, cols, rows).await
}

#[tauri::command]
async fn detach_terminal(
    app_state: State<'_, Arc<AppState>>,
    task_id: i32,
) -> Result<(), String> {
    maestro::ipc::detach_terminal(app_state, task_id).await
}

#[tauri::command]
async fn pause_agent_execution(
    app_state: State<'_, Arc<AppState>>,
    task_id: i32,
) -> Result<(), String> {
    maestro::ipc::pause_agent_execution(app_state, task_id).await
}

#[tauri::command]
async fn resume_agent_execution(
    state: State<'_, Arc<AppState>>,
    task_id: i32,
    project_id: i32,
    repo_path: String,
) -> Result<i32, String> {
    maestro::ipc::resume_agent_execution(state, task_id, project_id, repo_path).await
}

#[tauri::command]
async fn append_terminal_output(
    app_state: State<'_, Arc<AppState>>,
    task_id: i32,
    output: String,
) -> Result<(), String> {
    maestro::ipc::append_terminal_output(app_state, task_id, output).await
}

#[tauri::command]
async fn get_diff_for_review(
    app_state: State<'_, Arc<AppState>>,
    task_id: i32,
) -> Result<String, String> {
    maestro::ipc::get_diff_for_review(app_state, task_id).await
}

#[tauri::command]
async fn save_task_review(
    app_state: State<'_, Arc<AppState>>,
    task_id: i32,
    decision: String,
    general_feedback: Option<String>,
    per_file_comments: Option<Vec<(String, String)>>,
) -> Result<serde_json::Value, String> {
    maestro::ipc::save_task_review(app_state, task_id, decision, general_feedback, per_file_comments).await
}

#[tauri::command]
async fn request_changes(
    app_state: State<'_, Arc<AppState>>,
    task_id: i32,
    general_feedback: Option<String>,
    per_file_comments: Option<Vec<(String, String)>>,
) -> Result<serde_json::Value, String> {
    maestro::ipc::request_changes(app_state, task_id, general_feedback, per_file_comments).await
}

#[tauri::command]
async fn approve_task_and_merge(
    app_state: State<'_, Arc<AppState>>,
    task_id: i32,
) -> Result<serde_json::Value, String> {
    maestro::ipc::approve_task_and_merge(app_state, task_id).await
}

#[tauri::command]
fn get_project_settings(
    app_state: State<Arc<AppState>>,
    project_id: i32,
) -> Result<maestro::models::ProjectConfigResponse, String> {
    maestro::ipc::get_project_settings(app_state, project_id)
}

#[tauri::command]
fn update_project_settings(
    app_state: State<Arc<AppState>>,
    project_id: i32,
    settings: maestro::models::ProjectConfigRequest,
) -> Result<(), String> {
    maestro::ipc::update_project_settings(app_state, project_id, settings)
}

#[tauri::command]
fn update_task_settings(
    app_state: State<Arc<AppState>>,
    task_id: i32,
    settings: maestro::models::TaskConfigRequest,
) -> Result<(), String> {
    maestro::ipc::update_task_settings(app_state, task_id, settings)
}


#[tauri::command]
fn get_ssh_connections(
    app_state: State<Arc<AppState>>,
) -> Result<Vec<maestro::ssh::session::SshConnection>, String> {
    maestro::ipc::ssh_handlers::get_ssh_connections(app_state)
}

#[tauri::command]
fn get_ssh_connection(
    connection_id: i32,
    app_state: State<Arc<AppState>>,
) -> Result<maestro::ssh::session::SshConnection, String> {
    maestro::ipc::ssh_handlers::get_ssh_connection(connection_id, app_state)
}

#[tauri::command]
async fn get_ssh_connection_status(
    connection_id: i32,
    app_state: State<'_, Arc<AppState>>,
) -> Result<maestro::models::ConnectionStatus, String> {
    maestro::ipc::ssh_handlers::get_ssh_connection_status(connection_id, app_state).await
}

#[tauri::command]
fn save_ssh_connection(
    app_state: State<Arc<AppState>>,
    connection_string: String,
    auth_method: maestro::ssh::session::SshAuthMethod,
) -> Result<i32, String> {
    maestro::ipc::ssh_handlers::save_ssh_connection(app_state, connection_string, auth_method)
}

#[tauri::command]
async fn connect_ssh_without_credentials(
    app_state: State<'_, Arc<AppState>>,
    connection_id: i32,
) -> Result<i32, String> {
    maestro::ipc::ssh_handlers::connect_ssh_without_credentials(app_state, connection_id).await
}

#[tauri::command]
async fn connect_ssh_with_password(
    app_state: State<'_, Arc<AppState>>,
    connection_id: i32,
    password: String,
    save_password: bool,
) -> Result<i32, String> {
    maestro::ipc::ssh_handlers::connect_ssh_with_password(app_state, connection_id, password, save_password).await
}

#[tauri::command]
async fn list_remote_directories(
    app_state: State<'_, Arc<AppState>>,
    connection_id: i32,
    path: String,
) -> Result<Vec<String>, String> {
    maestro::ipc::ssh_handlers::list_remote_directories(app_state, connection_id, path).await
}

#[tauri::command]
fn list_local_directories(
    path: String,
) -> Result<Vec<String>, String> {
    maestro::ipc::list_local_directories(path)
}

#[tauri::command]
fn get_default_file_picker_path() -> Result<String, String> {
    maestro::ipc::get_default_file_picker_path()
}

#[tauri::command]
fn list_drives() -> Result<Vec<String>, String> {
    maestro::ipc::list_drives()
}

#[tauri::command]
fn get_system_accent_color() -> Result<Vec<u8>, String> {
    maestro::ipc::get_system_accent_color()
}

#[tauri::command]
fn delete_ssh_connection(
    app_state: State<Arc<AppState>>,
    connection_id: i32,
) -> Result<(), String> {
    maestro::ipc::ssh_handlers::delete_ssh_connection(app_state, connection_id)
}

#[tauri::command]
fn forget_saved_password(
    app_state: State<Arc<AppState>>,
    connection_id: i32,
) -> Result<(), String> {
    maestro::ipc::ssh_handlers::forget_saved_password(app_state, connection_id)
}

#[tauri::command]
fn rename_ssh_connection(
    app_state: State<Arc<AppState>>,
    connection_id: i32,
    display_name: String,
) -> Result<(), String> {
    maestro::ipc::ssh_handlers::rename_ssh_connection(app_state, connection_id, display_name)
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

    // Inject theme class on window initialization to prevent flash of unstyled content
    let main_window = app.get_webview_window("main")
        .ok_or("Failed to get main window")?;

    main_window.eval(
        "(function() {
            const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
            if (prefersDark) {
                document.documentElement.classList.add('dark');
            }
        })();"
    ).map_err(|e| format!("Failed to inject theme class: {}", e))?;

    println!("Tauri app initialized successfully");
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .setup(setup)
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            get_projects,
            get_connection_projects,
            create_project,
            get_project,
            remove_project,
            get_tasks,
            create_task,
            update_task,
            get_settings,
            save_settings,
            sync_github_issues,
            sync_jira_issues,
            save_import_config,
            lease_worktree,
            return_worktree,
            get_pool_status,
            cleanup_worktree,
            recover_dirty_worktrees,
            initialize_worktree_pool,
            spawn_agent_execution,
            get_execution_logs,
            retry_execution,
            cancel_execution,
            attach_terminal,
            send_terminal_input,
            resize_terminal,
            append_terminal_output,
            get_diff_for_review,
            save_task_review,
            request_changes,
            approve_task_and_merge,
            get_project_settings,
            update_project_settings,
            update_task_settings,
            get_ssh_connection_status,
            get_ssh_connections,
            get_ssh_connection,
            save_ssh_connection,
            connect_ssh_without_credentials,
            connect_ssh_with_password,
            list_remote_directories,
            list_local_directories,
            get_default_file_picker_path,
            list_drives,
            get_system_accent_color,
            delete_ssh_connection,
            forget_saved_password,
            rename_ssh_connection,
            detach_terminal,
            pause_agent_execution,
            resume_agent_execution
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
