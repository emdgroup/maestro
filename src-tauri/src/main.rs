// Tauri build script marker
#![cfg_attr(all(not(debug_assertions), target_os = "windows"), windows_subsystem = "windows")]

use gsd_demo::db::{init_db, AppState};
use gsd_demo::models::{Task, AppSettings, SshConfig};
use gsd_demo::ssh::RemoteSshSession;
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
    gsd_demo::ipc::handlers::get_projects(app_state)
}

#[tauri::command]
fn get_or_create_project(app_state: State<Arc<AppState>>, project_path: String) -> Result<gsd_demo::models::Project, String> {
    gsd_demo::ipc::handlers::get_or_create_project(app_state, project_path)
}

#[tauri::command]
async fn create_project(
    name: String,
    path: String,
    is_remote: bool,
    ssh_config: Option<gsd_demo::models::SshConfig>,
    app_state: State<'_, Arc<AppState>>,
) -> Result<gsd_demo::models::Project, String> {
    gsd_demo::ipc::handlers::create_project(app_state.clone(), name, path, is_remote, ssh_config, app_state).await
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

#[tauri::command]
async fn sync_github_issues(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    owner: String,
    repo: String,
    token: String,
) -> Result<gsd_demo::models::SyncResult, String> {
    gsd_demo::ipc::handlers::sync_github_issues(app_state, project_id, owner, repo, token).await
}

#[tauri::command]
async fn sync_jira_issues(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    host: String,
    email: String,
    api_token: String,
    jql: String,
) -> Result<gsd_demo::models::SyncResult, String> {
    gsd_demo::ipc::handlers::sync_jira_issues(app_state, project_id, host, email, api_token, jql).await
}

#[tauri::command]
fn save_import_config(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    provider: String,
    config: serde_json::Value,
) -> Result<(), String> {
    gsd_demo::ipc::handlers::save_import_config(app_state, project_id, provider, config)
}

#[tauri::command]
async fn lease_worktree(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    task_id: i32,
    repo_path: String,
) -> Result<gsd_demo::models::Worktree, String> {
    gsd_demo::ipc::handlers::lease_worktree(app_state, project_id, task_id, repo_path).await
}

#[tauri::command]
fn return_worktree(
    app_state: State<'_, Arc<AppState>>,
    worktree_id: i32,
) -> Result<(), String> {
    gsd_demo::ipc::handlers::return_worktree(app_state, worktree_id)
}

#[tauri::command]
fn get_pool_status(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
) -> Result<gsd_demo::models::PoolStatus, String> {
    gsd_demo::ipc::handlers::get_pool_status(app_state, project_id)
}

#[tauri::command]
async fn cleanup_worktree(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    worktree_id: i32,
    repo_path: String,
) -> Result<(), String> {
    gsd_demo::ipc::handlers::cleanup_worktree(app_state, project_id, worktree_id, repo_path).await
}

#[tauri::command]
async fn recover_dirty_worktrees(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    repo_path: String,
) -> Result<Vec<i32>, String> {
    gsd_demo::ipc::handlers::recover_dirty_worktrees(app_state, project_id, repo_path).await
}

#[tauri::command]
fn initialize_worktree_pool(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    repo_path: String,
    pool_size: Option<i32>,
) -> Result<gsd_demo::models::PoolStatus, String> {
    gsd_demo::ipc::handlers::initialize_worktree_pool(app_state, project_id, repo_path, pool_size)
}

#[tauri::command]
async fn spawn_agent_execution(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    task_id: i32,
    repo_path: String,
) -> Result<i32, String> {
    gsd_demo::ipc::handlers::spawn_agent_execution(app_state, project_id, task_id, repo_path).await
}

#[tauri::command]
fn get_execution_logs(
    app_state: State<Arc<AppState>>,
    task_id: i32,
) -> Result<Vec<gsd_demo::models::ExecutionLog>, String> {
    gsd_demo::ipc::handlers::get_execution_logs(app_state, task_id)
}

#[tauri::command]
async fn retry_execution(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    task_id: i32,
    repo_path: String,
) -> Result<i32, String> {
    gsd_demo::ipc::handlers::retry_execution(app_state, project_id, task_id, repo_path).await
}

#[tauri::command]
fn cancel_execution(
    app_state: State<Arc<AppState>>,
    log_id: i32,
) -> Result<(), String> {
    gsd_demo::ipc::handlers::cancel_execution(app_state, log_id)
}

#[tauri::command]
async fn attach_terminal(
    app_state: State<'_, Arc<AppState>>,
    task_id: i32,
    output_channel: tauri::ipc::Channel<String>,
    include_history: Option<bool>,
) -> Result<(), String> {
    gsd_demo::ipc::handlers::attach_terminal(app_state, task_id, output_channel, include_history).await
}

#[tauri::command]
async fn send_terminal_input(
    app_state: State<'_, Arc<AppState>>,
    task_id: i32,
    input: String,
) -> Result<(), String> {
    gsd_demo::ipc::handlers::send_terminal_input(app_state, task_id, input).await
}

#[tauri::command]
async fn resize_terminal(
    app_state: State<'_, Arc<AppState>>,
    task_id: i32,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    gsd_demo::ipc::handlers::resize_terminal(app_state, task_id, cols, rows).await
}

#[tauri::command]
async fn detach_terminal(
    app_state: State<'_, Arc<AppState>>,
    task_id: i32,
) -> Result<(), String> {
    gsd_demo::ipc::handlers::detach_terminal(app_state, task_id).await
}

#[tauri::command]
async fn pause_agent_execution(
    app_state: State<'_, Arc<AppState>>,
    task_id: i32,
) -> Result<(), String> {
    gsd_demo::ipc::handlers::pause_agent_execution(app_state, task_id).await
}

#[tauri::command]
async fn resume_agent_execution(
    state: State<'_, Arc<AppState>>,
    task_id: i32,
    project_id: i32,
    repo_path: String,
) -> Result<i32, String> {
    gsd_demo::ipc::handlers::resume_agent_execution(state, task_id, project_id, repo_path).await
}

#[tauri::command]
async fn append_terminal_output(
    app_state: State<'_, Arc<AppState>>,
    task_id: i32,
    output: String,
) -> Result<(), String> {
    gsd_demo::ipc::handlers::append_terminal_output(app_state, task_id, output).await
}

#[tauri::command]
async fn get_diff_for_review(
    app_state: State<'_, Arc<AppState>>,
    task_id: i32,
) -> Result<String, String> {
    gsd_demo::ipc::handlers::get_diff_for_review(app_state, task_id).await
}

#[tauri::command]
async fn save_task_review(
    app_state: State<'_, Arc<AppState>>,
    task_id: i32,
    decision: String,
    general_feedback: Option<String>,
    per_file_comments: Option<Vec<(String, String)>>,
) -> Result<serde_json::Value, String> {
    gsd_demo::ipc::handlers::save_task_review(app_state, task_id, decision, general_feedback, per_file_comments).await
}

#[tauri::command]
async fn request_changes(
    app_state: State<'_, Arc<AppState>>,
    task_id: i32,
    general_feedback: Option<String>,
    per_file_comments: Option<Vec<(String, String)>>,
) -> Result<serde_json::Value, String> {
    gsd_demo::ipc::handlers::request_changes(app_state, task_id, general_feedback, per_file_comments).await
}

#[tauri::command]
async fn approve_task_and_merge(
    app_state: State<'_, Arc<AppState>>,
    task_id: i32,
) -> Result<serde_json::Value, String> {
    gsd_demo::ipc::handlers::approve_task_and_merge(app_state, task_id).await
}

#[tauri::command]
fn get_project_settings(
    app_state: State<Arc<AppState>>,
    project_id: i32,
) -> Result<gsd_demo::models::ProjectConfigResponse, String> {
    gsd_demo::ipc::handlers::get_project_settings(app_state, project_id)
}

#[tauri::command]
fn update_project_settings(
    app_state: State<Arc<AppState>>,
    project_id: i32,
    settings: gsd_demo::models::ProjectConfigRequest,
) -> Result<(), String> {
    gsd_demo::ipc::handlers::update_project_settings(app_state, project_id, settings)
}

#[tauri::command]
fn update_task_settings(
    app_state: State<Arc<AppState>>,
    task_id: i32,
    settings: gsd_demo::models::TaskConfigRequest,
) -> Result<(), String> {
    gsd_demo::ipc::handlers::update_task_settings(app_state, task_id, settings)
}

#[tauri::command]
async fn test_remote_connection(
    config: gsd_demo::models::SshConfig,
    app_state: State<'_, Arc<AppState>>,
) -> Result<bool, String> {
    gsd_demo::ipc::handlers::test_remote_connection(config, app_state).await
}

#[tauri::command]
async fn get_remote_connection_status(
    project_id: i32,
    app_state: State<'_, Arc<AppState>>,
) -> Result<gsd_demo::models::ConnectionStatus, String> {
    gsd_demo::ipc::handlers::get_remote_connection_status(project_id, app_state).await
}

#[tauri::command]
async fn reconnect_remote_project(
    project_id: i32,
    app_state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    gsd_demo::ipc::handlers::reconnect_remote_project(project_id, app_state).await
}

/// Setup hook for Tauri initialization
fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let app_data_dir = get_app_data_dir();
    let db_path = app_data_dir.join("gsd-demo.db");

    // Initialize database
    let conn = init_db(db_path)
        .map_err(|e| format!("Failed to initialize database: {}", e))?;

    let app_state = Arc::new(AppState::new(conn));

    // Load remote projects and initialize SSH sessions (lazy connection - do NOT connect)
    {
        let db_lock = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        let mut stmt = db_lock
            .prepare("SELECT id, ssh_config FROM projects WHERE is_remote = 1")
            .map_err(|e| format!("Failed to query projects: {}", e))?;

        let ssh_sessions: Result<Vec<(i64, RemoteSshSession)>, _> = stmt
            .query_map([], |row| {
                let project_id: i64 = row.get(0)?;
                let ssh_config_json: String = row.get(1)?;
                let ssh_config: SshConfig = serde_json::from_str(&ssh_config_json)
                    .map_err(|_| rusqlite::Error::InvalidQuery)?;
                let session = RemoteSshSession::new(ssh_config);
                Ok((project_id, session))
            })
            .and_then(|rows| rows.collect())
            .map_err(|e| format!("Failed to initialize SSH sessions: {}", e));

        match ssh_sessions {
            Ok(sessions) => {
                // Store SSH sessions in AppState (no connections yet - lazy connection)
                let runtime = tokio::runtime::Runtime::new()
                    .map_err(|e| format!("Failed to create tokio runtime: {}", e))?;

                runtime.block_on(async {
                    for (project_id, session) in sessions {
                        app_state.set_ssh_session(project_id, session).await;
                    }
                });

                println!("Loaded SSH sessions from database for remote projects");
            }
            Err(e) => {
                println!("Warning: Failed to load SSH sessions: {}", e);
                // Continue without SSH sessions - they can be created when needed
            }
        }
    }

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
            get_or_create_project,
            create_project,
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
            test_remote_connection,
            get_remote_connection_status,
            reconnect_remote_project,
            detach_terminal,
            pause_agent_execution,
            resume_agent_execution
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
