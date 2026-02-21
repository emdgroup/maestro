// Tauri build script marker
#![cfg_attr(all(not(debug_assertions), target_os = "windows"), windows_subsystem = "windows")]

use gsd_demo::db::{init_db, AppState};
use gsd_demo::models::{Task, AppSettings};
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{Manager, State};
use serde_json;

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
    gsd_demo::ipc::get_projects(app_state)
}

#[tauri::command]
fn create_project(
    app_state: State<Arc<AppState>>,
    project_path: String,
    connection_id: Option<i64>,
) -> Result<gsd_demo::models::Project, String> {
    gsd_demo::ipc::create_project(app_state, project_path, connection_id)
}

#[tauri::command]
fn get_project(app_state: State<Arc<AppState>>, project_id: i64) -> Result<gsd_demo::models::Project, String> {
    gsd_demo::ipc::get_project(project_id, app_state)
}

#[tauri::command]
fn get_tasks(app_state: State<Arc<AppState>>, project_id: i64) -> Result<Vec<Task>, String> {
    gsd_demo::ipc::get_tasks(app_state, project_id)
}

#[tauri::command]
fn create_task(app_state: State<Arc<AppState>>, project_id: i64, name: String, description: String, acceptance_criteria: String, skills: Vec<String>) -> Result<Task, String> {
    gsd_demo::ipc::create_task(app_state, project_id, name, description, acceptance_criteria, skills)
}

#[tauri::command]
fn update_task(app_state: State<Arc<AppState>>, task_id: i64, status: Option<String>, description: Option<String>) -> Result<Task, String> {
    gsd_demo::ipc::update_task(app_state, task_id, status, description)
}

#[tauri::command]
fn get_settings(app_state: State<Arc<AppState>>) -> Result<AppSettings, String> {
    gsd_demo::ipc::get_settings(app_state)
}

#[tauri::command]
fn save_settings(app_state: State<Arc<AppState>>, settings: AppSettings) -> Result<(), String> {
    gsd_demo::ipc::save_settings(app_state, settings)
}

#[tauri::command]
async fn sync_github_issues(
    app_state: State<'_, Arc<AppState>>,
    project_id: i64,
    owner: String,
    repo: String,
    token: String,
) -> Result<gsd_demo::models::SyncResult, String> {
    gsd_demo::ipc::sync_github_issues(app_state, project_id, owner, repo, token).await
}

#[tauri::command]
async fn sync_jira_issues(
    app_state: State<'_, Arc<AppState>>,
    project_id: i64,
    host: String,
    email: String,
    api_token: String,
    jql: String,
) -> Result<gsd_demo::models::SyncResult, String> {
    gsd_demo::ipc::sync_jira_issues(app_state, project_id, host, email, api_token, jql).await
}

#[tauri::command]
fn save_import_config(
    app_state: State<'_, Arc<AppState>>,
    project_id: i64,
    provider: String,
    config: serde_json::Value,
) -> Result<(), String> {
    gsd_demo::ipc::save_import_config(app_state, project_id, provider, config)
}

#[tauri::command]
async fn lease_worktree(
    app_state: State<'_, Arc<AppState>>,
    project_id: i64,
    task_id: i64,
    repo_path: String,
) -> Result<gsd_demo::models::Worktree, String> {
    gsd_demo::ipc::lease_worktree(app_state, project_id, task_id, repo_path).await
}

#[tauri::command]
fn return_worktree(
    app_state: State<'_, Arc<AppState>>,
    worktree_id: i32,
) -> Result<(), String> {
    gsd_demo::ipc::return_worktree(app_state, worktree_id)
}

#[tauri::command]
fn get_pool_status(
    app_state: State<'_, Arc<AppState>>,
    project_id: i64,
) -> Result<gsd_demo::models::PoolStatus, String> {
    gsd_demo::ipc::get_pool_status(app_state, project_id)
}

#[tauri::command]
async fn cleanup_worktree(
    app_state: State<'_, Arc<AppState>>,
    project_id: i64,
    worktree_id: i32,
    repo_path: String,
) -> Result<(), String> {
    gsd_demo::ipc::cleanup_worktree(app_state, project_id, worktree_id, repo_path).await
}

#[tauri::command]
async fn recover_dirty_worktrees(
    app_state: State<'_, Arc<AppState>>,
    project_id: i64,
    repo_path: String,
) -> Result<Vec<i32>, String> {
    gsd_demo::ipc::recover_dirty_worktrees(app_state, project_id, repo_path).await
}

#[tauri::command]
fn initialize_worktree_pool(
    app_state: State<'_, Arc<AppState>>,
    project_id: i64,
    repo_path: String,
    pool_size: Option<i32>,
) -> Result<gsd_demo::models::PoolStatus, String> {
    gsd_demo::ipc::initialize_worktree_pool(app_state, project_id, repo_path, pool_size)
}

#[tauri::command]
async fn spawn_agent_execution(
    app_state: State<'_, Arc<AppState>>,
    project_id: i64,
    task_id: i64,
    repo_path: String,
) -> Result<i64, String> {
    gsd_demo::ipc::spawn_agent_execution(app_state, project_id, task_id, repo_path).await
}

#[tauri::command]
fn get_execution_logs(
    app_state: State<Arc<AppState>>,
    task_id: i64,
) -> Result<Vec<gsd_demo::models::ExecutionLog>, String> {
    gsd_demo::ipc::get_execution_logs(app_state, task_id)
}

#[tauri::command]
async fn retry_execution(
    app_state: State<'_, Arc<AppState>>,
    project_id: i64,
    task_id: i64,
    repo_path: String,
) -> Result<i64, String> {
    gsd_demo::ipc::retry_execution(app_state, project_id, task_id, repo_path).await
}

#[tauri::command]
fn cancel_execution(
    app_state: State<Arc<AppState>>,
    log_id: i32,
) -> Result<(), String> {
    gsd_demo::ipc::cancel_execution(app_state, log_id)
}

#[tauri::command]
async fn attach_terminal(
    app_state: State<'_, Arc<AppState>>,
    task_id: i64,
    output_channel: tauri::ipc::Channel<String>,
    include_history: Option<bool>,
) -> Result<(), String> {
    gsd_demo::ipc::attach_terminal(app_state, task_id, output_channel, include_history).await
}

#[tauri::command]
async fn send_terminal_input(
    app_state: State<'_, Arc<AppState>>,
    task_id: i64,
    input: String,
) -> Result<(), String> {
    gsd_demo::ipc::send_terminal_input(app_state, task_id, input).await
}

#[tauri::command]
async fn resize_terminal(
    app_state: State<'_, Arc<AppState>>,
    task_id: i64,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    gsd_demo::ipc::resize_terminal(app_state, task_id, cols, rows).await
}

#[tauri::command]
async fn detach_terminal(
    app_state: State<'_, Arc<AppState>>,
    task_id: i64,
) -> Result<(), String> {
    gsd_demo::ipc::detach_terminal(app_state, task_id).await
}

#[tauri::command]
async fn pause_agent_execution(
    app_state: State<'_, Arc<AppState>>,
    task_id: i64,
) -> Result<(), String> {
    gsd_demo::ipc::pause_agent_execution(app_state, task_id).await
}

#[tauri::command]
async fn resume_agent_execution(
    state: State<'_, Arc<AppState>>,
    task_id: i64,
    project_id: i64,
    repo_path: String,
) -> Result<i64, String> {
    gsd_demo::ipc::resume_agent_execution(state, task_id, project_id, repo_path).await
}

#[tauri::command]
async fn append_terminal_output(
    app_state: State<'_, Arc<AppState>>,
    task_id: i64,
    output: String,
) -> Result<(), String> {
    gsd_demo::ipc::append_terminal_output(app_state, task_id, output).await
}

#[tauri::command]
async fn get_diff_for_review(
    app_state: State<'_, Arc<AppState>>,
    task_id: i64,
) -> Result<String, String> {
    gsd_demo::ipc::get_diff_for_review(app_state, task_id).await
}

#[tauri::command]
async fn save_task_review(
    app_state: State<'_, Arc<AppState>>,
    task_id: i64,
    decision: String,
    general_feedback: Option<String>,
    per_file_comments: Option<Vec<(String, String)>>,
) -> Result<serde_json::Value, String> {
    gsd_demo::ipc::save_task_review(app_state, task_id, decision, general_feedback, per_file_comments).await
}

#[tauri::command]
async fn request_changes(
    app_state: State<'_, Arc<AppState>>,
    task_id: i64,
    general_feedback: Option<String>,
    per_file_comments: Option<Vec<(String, String)>>,
) -> Result<serde_json::Value, String> {
    gsd_demo::ipc::request_changes(app_state, task_id, general_feedback, per_file_comments).await
}

#[tauri::command]
async fn approve_task_and_merge(
    app_state: State<'_, Arc<AppState>>,
    task_id: i64,
) -> Result<serde_json::Value, String> {
    gsd_demo::ipc::approve_task_and_merge(app_state, task_id).await
}

#[tauri::command]
fn get_project_settings(
    app_state: State<Arc<AppState>>,
    project_id: i64,
) -> Result<gsd_demo::models::ProjectConfigResponse, String> {
    gsd_demo::ipc::get_project_settings(app_state, project_id)
}

#[tauri::command]
fn update_project_settings(
    app_state: State<Arc<AppState>>,
    project_id: i64,
    settings: gsd_demo::models::ProjectConfigRequest,
) -> Result<(), String> {
    gsd_demo::ipc::update_project_settings(app_state, project_id, settings)
}

#[tauri::command]
fn update_task_settings(
    app_state: State<Arc<AppState>>,
    task_id: i64,
    settings: gsd_demo::models::TaskConfigRequest,
) -> Result<(), String> {
    gsd_demo::ipc::update_task_settings(app_state, task_id, settings)
}


#[tauri::command]
fn get_ssh_connections(
    app_state: State<Arc<AppState>>,
) -> Result<Vec<gsd_demo::ssh::session::SshConnection>, String> {
    gsd_demo::ipc::ssh_handlers::get_ssh_connections(app_state)
}

#[tauri::command]
fn get_ssh_connection(
    connection_id: i64,
    app_state: State<Arc<AppState>>,
) -> Result<gsd_demo::ssh::session::SshConnection, String> {
    gsd_demo::ipc::ssh_handlers::get_ssh_connection(connection_id, app_state)
}

#[tauri::command]
async fn get_ssh_connection_status(
    connection_id: i64,
    app_state: State<'_, Arc<AppState>>,
) -> Result<gsd_demo::models::ConnectionStatus, String> {
    gsd_demo::ipc::ssh_handlers::get_ssh_connection_status(connection_id, app_state).await
}

#[tauri::command]
fn save_ssh_connection(
    app_state: State<Arc<AppState>>,
    connection_string: String,
    auth_method: gsd_demo::ssh::session::SshAuthMethod,
) -> Result<i64, String> {
    gsd_demo::ipc::ssh_handlers::save_ssh_connection(app_state, connection_string, auth_method)
}

#[tauri::command]
async fn connect_ssh_without_credentials(
    app_state: State<'_, Arc<AppState>>,
    connection_id: i64,
) -> Result<i64, String> {
    gsd_demo::ipc::ssh_handlers::connect_ssh_without_credentials(app_state, connection_id).await
}

#[tauri::command]
async fn connect_ssh_with_password(
    app_state: State<'_, Arc<AppState>>,
    connection_id: i64,
    password: String,
    save_password: bool,
) -> Result<i64, String> {
    gsd_demo::ipc::ssh_handlers::connect_ssh_with_password(app_state, connection_id, password, save_password).await
}

#[tauri::command]
async fn list_remote_directories(
    app_state: State<'_, Arc<AppState>>,
    connection_id: i64,
    path: String,
) -> Result<Vec<String>, String> {
    gsd_demo::ipc::ssh_handlers::list_remote_directories(app_state, connection_id, path).await
}

#[tauri::command]
fn list_local_directories(
    path: String,
) -> Result<Vec<String>, String> {
    gsd_demo::ipc::list_local_directories(path)
}

#[tauri::command]
fn get_default_file_picker_path() -> Result<String, String> {
    gsd_demo::ipc::get_default_file_picker_path()
}

#[tauri::command]
fn list_drives() -> Result<Vec<String>, String> {
    gsd_demo::ipc::list_drives()
}

#[tauri::command]
fn get_system_accent_color() -> Result<Vec<u8>, String> {
    gsd_demo::ipc::get_system_accent_color()
}

#[tauri::command]
fn delete_ssh_connection(
    app_state: State<Arc<AppState>>,
    connection_id: i64,
) -> Result<(), String> {
    gsd_demo::ipc::ssh_handlers::delete_ssh_connection(app_state, connection_id)
}

#[tauri::command]
fn forget_saved_password(
    app_state: State<Arc<AppState>>,
    connection_id: i64,
) -> Result<(), String> {
    gsd_demo::ipc::ssh_handlers::forget_saved_password(app_state, connection_id)
}

#[tauri::command]
fn rename_ssh_connection(
    app_state: State<Arc<AppState>>,
    connection_id: i64,
    display_name: String,
) -> Result<(), String> {
    gsd_demo::ipc::ssh_handlers::rename_ssh_connection(app_state, connection_id, display_name)
}

#[tauri::command]
fn get_recent_projects_enhanced(
    app_state: State<Arc<AppState>>
) -> Result<Vec<gsd_demo::ipc::recent_projects_handlers::EnhancedRecentProject>, String> {
    gsd_demo::ipc::get_recent_projects_enhanced(app_state)
}

#[tauri::command]
fn validate_recent_projects(
    app_state: State<Arc<AppState>>
) -> Result<Vec<String>, String> {
    gsd_demo::ipc::validate_recent_projects(app_state)
}

#[tauri::command]
fn remove_recent_project(
    app_state: State<Arc<AppState>>,
    path: String,
) -> Result<(), String> {
    gsd_demo::ipc::remove_recent_project(app_state, path)
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
            create_project,
            get_project,
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
            get_recent_projects_enhanced,
            validate_recent_projects,
            remove_recent_project,
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
