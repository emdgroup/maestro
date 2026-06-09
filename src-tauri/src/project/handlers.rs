use std::path::Path;
use std::sync::Arc;
use tauri::State;
use crate::command_ext::NoConsoleWindow;
use chrono::Utc;
use rusqlite::params;
use serde_json;
use crate::models::Project;
use crate::core::{AppState, project_storage};
use crate::git::remote::shell_quote;
use crate::acp::ConnectionKey;

/// Register a project in the database (check-or-insert) and initialize .maestro folder.
/// Returns the full Project row.
fn register_project_in_db(
    app_state: &Arc<AppState>,
    path: &str,
    name: &str,
    connection_key: ConnectionKey,
) -> Result<Project, String> {
    let path = path.trim_end_matches('/');
    let connection_id = connection_key.ssh_id();
    let wsl_connection_id = connection_key.wsl_id();
    let project_id = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        let existing: Option<i32> = conn.query_row(
            "SELECT id FROM projects WHERE path = ? AND connection_id IS ? AND wsl_connection_id IS ?",
            params![path, connection_id, wsl_connection_id],
            |row| row.get(0),
        ).ok();
        match existing {
            Some(id) => id,
            None => {
                let now = chrono::Utc::now().to_rfc3339();
                conn.execute(
                    "INSERT INTO projects (name, path, created_at, updated_at, connection_id, wsl_connection_id, last_opened) VALUES (?, ?, ?, ?, ?, ?, ?)",
                    params![name, path, now, now, connection_id, wsl_connection_id, now],
                ).map_err(|e| format!("Failed to insert project: {}", e))?;
                conn.last_insert_rowid() as i32
            }
        }
    };

    // Init .maestro folder for local and WSL projects.
    // WSL paths are accessible from Windows via \\wsl$\ UNC paths.
    match connection_key {
        ConnectionKey::Local => {
            crate::core::project_storage::create_project_maestro_folder(path)
                .map_err(|e| format!("Failed to initialize project storage: {}", e))?;
            crate::core::project_storage::ensure_commit_template_exists(path)
                .map_err(|e| format!("Failed to initialize commit template: {}", e))?;
        }
        ConnectionKey::Wsl { id: wsl_id } => {
            let distro = {
                let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
                conn.query_row(
                    "SELECT distro_name FROM wsl_connections WHERE id = ?",
                    [wsl_id],
                    |row| row.get::<_, String>(0),
                ).map_err(|e| format!("WSL connection {} not found: {}", wsl_id, e))?
            };
            let unc_path = format!(r"\\wsl$\{}\{}", distro, path.trim_start_matches('/'));
            crate::core::project_storage::create_project_maestro_folder(&unc_path)
                .map_err(|e| format!("Failed to initialize WSL project storage: {}", e))?;
            crate::core::project_storage::ensure_commit_template_exists(&unc_path)
                .map_err(|e| format!("Failed to initialize commit template: {}", e))?;
        }
        ConnectionKey::Ssh { .. } => {}
    }

    // Read back full project row
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
    conn.query_row(
        "SELECT id, name, path, created_at, updated_at, last_opened, connection_id, wsl_connection_id FROM projects WHERE id = ?",
        params![project_id],
        Project::from_row,
    ).map_err(|e| e.to_string())
}

/// Fetch projects for a connection from an open DB connection.
/// Isolated into a helper so all borrow-checker temporaries are fully dropped
/// before the caller proceeds to async SSH I/O.
fn fetch_projects_from_db(
    conn: &rusqlite::Connection,
    connection_key: ConnectionKey,
) -> Result<Vec<Project>, String> {
    let select = "SELECT id, name, path, created_at, updated_at, last_opened, connection_id, wsl_connection_id FROM projects";
    let order = "ORDER BY last_opened DESC NULLS LAST, created_at DESC";

    match connection_key {
        ConnectionKey::Ssh { id } => {
            let query = format!("{} WHERE connection_id = ? {}", select, order);
            let mut stmt = conn.prepare(&query).map_err(|e| e.to_string())?;
            let projects: Vec<Project> = stmt
                .query_map([id], Project::from_row)
                .map_err(|e| e.to_string())?
                .collect::<Result<_, _>>()
                .map_err(|e: rusqlite::Error| e.to_string())?;
            Ok(projects)
        }
        ConnectionKey::Wsl { id } => {
            let query = format!("{} WHERE wsl_connection_id = ? {}", select, order);
            let mut stmt = conn.prepare(&query).map_err(|e| e.to_string())?;
            let projects: Vec<Project> = stmt
                .query_map([id], Project::from_row)
                .map_err(|e| e.to_string())?
                .collect::<Result<_, _>>()
                .map_err(|e: rusqlite::Error| e.to_string())?;
            Ok(projects)
        }
        ConnectionKey::Local => {
            let query = format!("{} WHERE connection_id IS NULL AND wsl_connection_id IS NULL {}", select, order);
            let mut stmt = conn.prepare(&query).map_err(|e| e.to_string())?;
            let projects: Vec<Project> = stmt
                .query_map([], Project::from_row)
                .map_err(|e| e.to_string())?
                .collect::<Result<_, _>>()
                .map_err(|e: rusqlite::Error| e.to_string())?;
            Ok(projects)
        }
    }
}

/// Get list of all projects
#[tauri::command]
#[specta::specta]
pub fn get_projects(app_state: State<Arc<AppState>>) -> Result<Vec<Project>, String> {
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;

    let mut stmt = conn
        .prepare("SELECT id, name, path, created_at, updated_at, last_opened, connection_id, wsl_connection_id FROM projects ORDER BY last_opened DESC NULLS LAST")
        .map_err(|e| e.to_string())?;

    let projects = stmt
        .query_map([], Project::from_row)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(projects)
}

/// Get list of all projects per connection
#[tauri::command]
#[specta::specta]
pub async fn get_connection_projects(app_state: State<'_, Arc<AppState>>, connection_key: ConnectionKey) -> Result<Vec<Project>, String> {
    // ── Step 1: fetch projects (db lock acquired and released in this block) ─
    let projects: Vec<Project> = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        fetch_projects_from_db(&conn, connection_key)?
        // conn drops here — lock released before async work below
    };

    // ── Step 2: validate paths ───────────────────────────────────────────────
    let stale_ids = collect_stale_project_ids(&projects, connection_key, &app_state).await;

    // ── Step 3: delete stale projects and return filtered list ───────────────
    if !stale_ids.is_empty() {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        for id in &stale_ids {
            conn.execute("DELETE FROM projects WHERE id = ?", [id])
                .map_err(|e| e.to_string())?;
        }
    }

    Ok(projects.into_iter().filter(|p| !stale_ids.contains(&p.id)).collect())
}

/// Returns the IDs of projects whose paths no longer exist.
async fn collect_stale_project_ids(
    projects: &[Project],
    connection_key: ConnectionKey,
    app_state: &Arc<AppState>,
) -> Vec<i32> {
    match connection_key {
        ConnectionKey::Local => projects
            .iter()
            .filter(|p| !std::path::Path::new(&p.path).exists())
            .map(|p| p.id)
            .collect(),

        ConnectionKey::Ssh { id: conn_id } => {
            let session = match app_state.ssh.get_session(conn_id).await {
                Some(s) => s,
                None => return vec![],
            };
            let mut stale = Vec::new();
            for project in projects {
                let cmd = format!("test -d {} && echo ok || echo missing", shell_quote(&project.path));
                match session.execute_command(&cmd).await {
                    Ok(output) => {
                        if output.trim() != "ok" {
                            stale.push(project.id);
                        }
                    }
                    Err(_) => {}
                }
            }
            stale
        }

        ConnectionKey::Wsl { id: wsl_id } => {
            let distro: String = {
                let db = match app_state.db.lock() {
                    Ok(d) => d,
                    Err(_) => return vec![],
                };
                match db.query_row(
                    "SELECT distro_name FROM wsl_connections WHERE id = ?",
                    params![wsl_id],
                    |row| row.get(0),
                ) {
                    Ok(d) => d,
                    Err(_) => return vec![],
                }
            };
            let mut stale = Vec::new();
            for project in projects {
                let output = tokio::process::Command::new("wsl.exe")
                    .args(["-d", &distro, "--", "test", "-d", &project.path])
                    .stdout(std::process::Stdio::piped())
                    .stderr(std::process::Stdio::piped())
                    .no_console_window()
                    .output()
                    .await;
                match output {
                    Ok(out) if !out.status.success() => stale.push(project.id),
                    Err(_) => {} // On error, keep the project
                    _ => {}
                }
            }
            stale
        }
    }
}

/// Get project by id
#[tauri::command]
#[specta::specta]
pub fn get_project(
    app_state: State<Arc<AppState>>,
    project_id: i32,
) -> Result<Project, String> {
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;

    // Try to find existing project
    let existing: Result<Project, _> = conn.query_row(
        "SELECT id, name, path, created_at, updated_at, last_opened, connection_id, wsl_connection_id FROM projects WHERE id = ?",
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

/// Open a project by ID: acquire the project lock, mark orphaned sessions as failed,
/// update last_opened, and return the Project.
///
/// This is the entry point for project selection. It enforces single-instance access:
/// if another live Maestro instance has the project open, it returns an error of the
/// form "PROJECT_LOCKED:<id>" which the frontend interprets to show a toast.
#[tauri::command]
#[specta::specta]
pub fn open_project(
    app_state: State<Arc<AppState>>,
    project_id: i32,
) -> Result<Project, String> {
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;

    let project: Project = conn
        .query_row(
            "SELECT id, name, path, created_at, updated_at, last_opened, connection_id, wsl_connection_id FROM projects WHERE id = ?",
            [&project_id],
            Project::from_row,
        )
        .map_err(|_| "Project not found".to_string())?;

    // Acquire project lock — errors if another live instance owns it.
    // Must drop conn first so the lock doesn't block during acquire.
    drop(conn);

    app_state.acquire_project_lock(project_id)?;

    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;

    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE projects SET last_opened = ? WHERE id = ?",
        rusqlite::params![now, project_id],
    )
    .map_err(|e| e.to_string())?;

    // Ensure commit template exists for local/WSL projects (no-op if file already present).
    // SSH projects don't have a local .maestro/ folder.
    if !project.is_remote() {
        let effective_path = if let Some(wsl_id) = project.wsl_connection_id {
            let distro: String = conn.query_row(
                "SELECT distro_name FROM wsl_connections WHERE id = ?",
                [wsl_id],
                |row| row.get(0),
            ).map_err(|e| format!("WSL connection not found: {}", e))?;
            format!(r"\\wsl$\{}\{}", distro, project.path.trim_start_matches('/'))
        } else {
            project.path.clone()
        };
        crate::core::project_storage::ensure_commit_template_exists(&effective_path)
            .map_err(|e| format!("Failed to initialize commit template: {}", e))?;
    }

    Ok(project)
}

/// Release the active project lock held by this instance.
/// Called when the user navigates back to the project picker.
#[tauri::command]
#[specta::specta]
pub fn release_active_project_lock(app_state: State<Arc<AppState>>) -> Result<(), String> {
    app_state.release_active_project_lock();
    Ok(())
}

/// Return the subset of project IDs that are currently locked by another live instance.
/// Used by the project picker to show visual lock indicators before the user clicks.
#[tauri::command]
#[specta::specta]
pub fn check_project_locks(
    app_state: State<Arc<AppState>>,
    project_ids: Vec<i32>,
) -> Vec<i32> {
    project_ids
        .into_iter()
        .filter(|&id| crate::project::lock::is_project_locked(&app_state.app_data_dir, id))
        .collect()
}

/// remove project by id
#[tauri::command]
#[specta::specta]
pub fn delete_project(
    app_state: State<Arc<AppState>>,
    project_id: i32,
) -> Result<(), String> {
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;

    // Delete from database
    conn.execute("DELETE FROM projects WHERE id = ?",[project_id])
        .map_err(|e| e.to_string())?;

    Ok(())
}

/// remove projects by connection id
#[tauri::command]
pub fn remove_projects_by_connection_id(
    app_state: State<Arc<AppState>>,
    connection_id: i32,
) -> Result<(), String> {
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;

    // Delete from database
    conn.execute("DELETE FROM projects WHERE connection_id = ?",[connection_id])
        .map_err(|e| e.to_string())?;

    Ok(())
}

/// Initialize git in an existing directory (no-op if already a git repo)
#[tauri::command]
#[specta::specta]
pub async fn git_init_project(
    app_state: State<'_, Arc<AppState>>,
    path: String,
    connection_id: Option<i32>,
    wsl_connection_id: Option<i32>,
) -> Result<(), String> {
    if let Some(conn_id) = connection_id {
        let session = app_state
            .ssh.get_session(conn_id)
            .await
            .ok_or_else(|| format!("No active SSH session for connection {}", conn_id))?;
        // No-op if already a git repo
        let check = session
            .execute_command(&format!("test -d {}/.git && echo yes || echo no", shell_quote(&path)))
            .await
            .map_err(|e| format!("SSH check failed: {}", e))?;
        if check.trim() == "yes" {
            return Ok(());
        }
        let output = session
            .execute_command(&format!("git init -b main {}", shell_quote(&path)))
            .await
            .map_err(|e| format!("SSH git init failed: {}", e))?;
        if output.contains("Initialized") || output.contains("Reinitialized") {
            return Ok(());
        }
        return Err(format!("git init failed: {}", output));
    }

    if let Some(wsl_id) = wsl_connection_id {
        let distro: String = {
            let db = app_state.db.lock().map_err(|e| e.to_string())?;
            db.query_row(
                "SELECT distro_name FROM wsl_connections WHERE id = ?",
                params![wsl_id],
                |row| row.get(0),
            )
            .map_err(|e| format!("WSL connection not found: {}", e))?
        };
        // No-op if already a git repo
        let check = tokio::process::Command::new("wsl.exe")
            .args(["-d", &distro, "--", "git", "-C", &path, "rev-parse", "--is-inside-work-tree"])
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .no_console_window()
            .output()
            .await
            .map_err(|e| format!("Failed to spawn wsl.exe: {}", e))?;
        if check.status.success() {
            return Ok(());
        }
        let output = tokio::process::Command::new("wsl.exe")
            .args(["-d", &distro, "--", "git", "init", "-b", "main", &path])
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .no_console_window()
            .output()
            .await
            .map_err(|e| format!("Failed to spawn wsl.exe: {}", e))?;
        if output.status.success() {
            return Ok(());
        }
        return Err(format!("git init failed: {}", String::from_utf8_lossy(&output.stderr)));
    }

    let git_dir = std::path::Path::new(&path).join(".git");
    if git_dir.exists() {
        return Ok(());
    }
    let output = tokio::process::Command::new("git")
        .args(["init", "-b", "main", &path])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .no_console_window()
        .output()
        .await
        .map_err(|e| format!("Failed to spawn git: {}", e))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(format!("git init failed: {}", String::from_utf8_lossy(&output.stderr)))
    }
}

#[tauri::command]
#[specta::specta]
pub async fn check_is_git_repo(
    app_state: State<'_, Arc<AppState>>,
    path: String,
    connection_id: Option<i32>,
    wsl_connection_id: Option<i32>,
) -> Result<bool, String> {
    if let Some(conn_id) = connection_id {
        let session = app_state
            .ssh.get_session(conn_id)
            .await
            .ok_or_else(|| format!("No active SSH session for connection {}", conn_id))?;
        let check = session
            .execute_command(&format!(
                "git -C {} rev-parse --is-inside-work-tree 2>/dev/null && echo yes || echo no",
                shell_quote(&path)
            ))
            .await
            .map_err(|e| format!("SSH check failed: {}", e))?;
        return Ok(check.trim().ends_with("yes"));
    }

    if let Some(wsl_id) = wsl_connection_id {
        let distro: String = {
            let db = app_state.db.lock().map_err(|e| e.to_string())?;
            db.query_row(
                "SELECT distro_name FROM wsl_connections WHERE id = ?",
                params![wsl_id],
                |row| row.get(0),
            )
            .map_err(|e| format!("WSL connection not found: {}", e))?
        };
        let output = tokio::process::Command::new("wsl.exe")
            .args(["-d", &distro, "--", "git", "-C", &path, "rev-parse", "--is-inside-work-tree"])
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .no_console_window()
            .output()
            .await
            .map_err(|e| format!("Failed to spawn wsl.exe: {}", e))?;
        return Ok(output.status.success());
    }

    // Use `git rev-parse` to detect both root repos and subdirectories within a git tree
    let output = tokio::process::Command::new("git")
        .args(["-C", &path, "rev-parse", "--is-inside-work-tree"])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .no_console_window()
        .output()
        .await;
    match output {
        Ok(out) => Ok(out.status.success()),
        Err(_) => Ok(false), // git not installed → not a git repo
    }
}

async fn build_provider_auth_header(
    provider: &str,
    app_state: &AppState,
) -> Result<Option<String>, String> {
    use base64::Engine as _;

    // GitHub supports a fallback to the `gh` CLI token when no keychain entry exists.
    let token_result = if provider == "github" {
        match crate::integration::issue_tracking_handlers::get_integration_creds(provider, app_state) {
            Ok(creds) => Ok(creds.token),
            Err(_) => crate::integration::github::try_gh_cli_token()
                .await
                .ok_or_else(|| "No GitHub credentials found".to_string()),
        }
    } else {
        crate::integration::issue_tracking_handlers::get_integration_creds(provider, app_state)
            .map(|creds| creds.token)
    };

    let header = match provider {
        "github" => {
            let basic = base64::engine::general_purpose::STANDARD
                .encode(format!("x-access-token:{}", token_result?).as_bytes());
            format!("Authorization: Basic {}", basic)
        }
        "gitlab" => format!("Authorization: Bearer {}", token_result?),
        "bitbucket" => {
            let creds = crate::integration::issue_tracking_handlers::get_integration_creds(provider, app_state)?;
            match creds.instance_url {
                Some(_) => format!("Authorization: Bearer {}", creds.token),
                None => {
                    let email = creds.email.ok_or("Bitbucket Cloud credentials missing email")?;
                    let basic = base64::engine::general_purpose::STANDARD
                        .encode(format!("{}:{}", email, creds.token).as_bytes());
                    format!("Authorization: Basic {}", basic)
                }
            }
        }
        "forgejo" | "gitea" => format!("Authorization: token {}", token_result?),
        "azuredevops" => {
            let basic = base64::engine::general_purpose::STANDARD
                .encode(format!(":{}", token_result?).as_bytes());
            format!("Authorization: Basic {}", basic)
        }
        _ => return Ok(None),
    };

    Ok(Some(header))
}

/// Clone a git repository and register it as a project
#[tauri::command]
#[specta::specta]
pub async fn clone_project(
    app_state: State<'_, Arc<AppState>>,
    url: String,
    target_path: String,
    connection_id: Option<i32>,
    wsl_connection_id: Option<i32>,
    provider: Option<String>,
) -> Result<Project, String> {
    let connection_key = ConnectionKey::from_ids(connection_id, wsl_connection_id);
    let auth_header = match provider.as_deref() {
        Some(provider_key) if url.starts_with("http://") || url.starts_with("https://") => {
            build_provider_auth_header(provider_key, &app_state).await?
        }
        _ => None,
    };

    match connection_key {
        ConnectionKey::Ssh { id: conn_id } => {
            let session = app_state
                .ssh.get_session(conn_id)
                .await
                .ok_or_else(|| format!("No active SSH session for connection {}", conn_id))?;
            let git_cmd = match &auth_header {
                Some(header) => format!(
                    "git -c {} clone {} {}",
                    shell_quote(&format!("http.extraHeader={}", header)),
                    shell_quote(&url),
                    shell_quote(&target_path),
                ),
                None => format!("git clone {} {}", shell_quote(&url), shell_quote(&target_path)),
            };
            let output = session
                .execute_command(&git_cmd)
                .await
                .map_err(|e| format!("SSH git clone failed: {}", e))?;
            if output.contains("error:") || output.contains("fatal:") {
                return Err(format!("git clone failed: {}", output));
            }
        }
        ConnectionKey::Wsl { id: wsl_id } => {
            let distro: String = {
                let db = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
                db.query_row("SELECT distro_name FROM wsl_connections WHERE id = ?", params![wsl_id], |row| row.get(0))
                    .map_err(|e| format!("WSL connection not found: {}", e))?
            };
            let mut wsl_args = vec!["-d".to_string(), distro, "--".to_string(), "git".to_string()];
            // WSL has its own certificate store separate from Windows; disable SSL verification
            // so clones from internal servers with self-signed certs work out of the box.
            wsl_args.push("-c".to_string());
            wsl_args.push("http.sslVerify=false".to_string());
            if let Some(ref header) = auth_header {
                wsl_args.push("-c".to_string());
                wsl_args.push(format!("http.extraHeader={}", header));
            }
            wsl_args.extend(["clone".to_string(), url.clone(), target_path.clone()]);
            let output = tokio::process::Command::new("wsl.exe")
                .args(&wsl_args)
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .no_console_window()
                .output()
                .await
                .map_err(|e| format!("Failed to spawn wsl.exe: {}", e))?;
            if !output.status.success() {
                return Err(format!("git clone failed: {}", String::from_utf8_lossy(&output.stderr)));
            }
        }
        ConnectionKey::Local => {
            let mut args: Vec<String> = Vec::new();
            if let Some(header) = auth_header {
                args.push("-c".to_string());
                args.push(format!("http.extraHeader={}", header));
            }
            args.extend(["clone".to_string(), url.clone(), target_path.clone()]);
            let output = tokio::process::Command::new("git")
                .args(&args)
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .no_console_window()
                .output()
                .await
                .map_err(|e| format!("Failed to spawn git: {}", e))?;
            if !output.status.success() {
                return Err(format!("git clone failed: {}", String::from_utf8_lossy(&output.stderr)));
            }
        }
    }

    let name = std::path::Path::new(&target_path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("Untitled")
        .to_string();

    register_project_in_db(app_state.inner(), &target_path, &name, connection_key)
}

/// Create a new project directory, git init it, and register as a project
#[tauri::command]
#[specta::specta]
pub async fn create_new_project(
    app_state: State<'_, Arc<AppState>>,
    parent_dir: String,
    folder_name: String,
    connection_id: Option<i32>,
    wsl_connection_id: Option<i32>,
) -> Result<Project, String> {
    let connection_key = ConnectionKey::from_ids(connection_id, wsl_connection_id);
    // Build full path string (works for both local and remote — remote paths are POSIX)
    let full_path_str = format!("{}/{}", parent_dir.trim_end_matches('/'), folder_name);

    match connection_key {
        ConnectionKey::Ssh { id: conn_id } => {
            let session = app_state
                .ssh.get_session(conn_id)
                .await
                .ok_or_else(|| format!("No active SSH session for connection {}", conn_id))?;
            let exists = session
                .execute_command(&format!("test -d {} && echo yes || echo no", shell_quote(&full_path_str)))
                .await
                .map_err(|e| format!("SSH check failed: {}", e))?;
            if exists.trim() == "yes" {
                return Err("Directory already exists. Choose a different path or use Select Existing.".to_string());
            }
            let output = session
                .execute_command(&format!("mkdir -p {} && git init -b main {}", shell_quote(&full_path_str), shell_quote(&full_path_str)))
                .await
                .map_err(|e| format!("SSH create failed: {}", e))?;
            if output.contains("error:") || output.contains("fatal:") {
                return Err(format!("Remote create failed: {}", output));
            }
        }
        ConnectionKey::Wsl { id: wsl_id } => {
            let distro: String = {
                let db = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
                db.query_row("SELECT distro_name FROM wsl_connections WHERE id = ?", params![wsl_id], |row| row.get(0))
                    .map_err(|e| format!("WSL connection not found: {}", e))?
            };
            let exists_out = tokio::process::Command::new("wsl.exe")
                .args(["-d", &distro, "--", "test", "-d", &full_path_str])
                .no_console_window()
                .status()
                .await
                .map_err(|e| format!("Failed to spawn wsl.exe: {}", e))?;
            if exists_out.success() {
                return Err("Directory already exists. Choose a different path or use Select Existing.".to_string());
            }
            let script = format!("mkdir -p {} && git init -b main {}", shell_quote(&full_path_str), shell_quote(&full_path_str));
            let output = tokio::process::Command::new("wsl.exe")
                .args(["-d", &distro, "--", "sh", "-c", &script])
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .no_console_window()
                .output()
                .await
                .map_err(|e| format!("Failed to spawn wsl.exe: {}", e))?;
            let stderr = String::from_utf8_lossy(&output.stderr);
            if stderr.contains("error:") || stderr.contains("fatal:") || !output.status.success() {
                return Err(format!("WSL create failed: {}", stderr));
            }
        }
        ConnectionKey::Local => {
            let full_path = std::path::Path::new(&parent_dir).join(&folder_name);
            if full_path.exists() {
                return Err("Directory already exists. Choose a different path or use Select Existing.".to_string());
            }
            std::fs::create_dir_all(&full_path)
                .map_err(|e| format!("Failed to create directory: {}", e))?;
            let output = tokio::process::Command::new("git")
                .args(["init", "-b", "main", &full_path_str])
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .no_console_window()
                .output()
                .await
                .map_err(|e| format!("Failed to spawn git: {}", e))?;
            if !output.status.success() {
                return Err(format!("git init failed: {}", String::from_utf8_lossy(&output.stderr)));
            }
        }
    }

    register_project_in_db(app_state.inner(), &full_path_str, &folder_name, connection_key)
}

/// Create a new project
#[tauri::command]
#[specta::specta]
pub fn create_project(
    app_state: State<Arc<AppState>>,
    path: String,
    connection: crate::acp::ConnectionKey,
) -> Result<Project, String> {
    let path = path.trim_end_matches('/').to_string();
    let connection_id = connection.ssh_id();
    let wsl_connection_id = connection.wsl_id();
    // NOTE: This older handler has similar logic to register_project_in_db but also
    // updates last_opened via get_project(). Could be unified in a future cleanup.
    let project_id = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        let existing: Option<i32> = conn.query_row(
            "SELECT id FROM projects WHERE path = ? AND connection_id IS ? AND wsl_connection_id IS ?",
            params![path, connection_id, wsl_connection_id],
            |row| row.get(0),
        ).ok();
        match existing {
            Some(id) => id,
            None => {
                // Create new project in database
                let now = Utc::now().to_rfc3339();
                let name = Path::new(&path)
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("Untitled")
                    .to_string();
                conn.execute(
                    "INSERT INTO projects (name, path, created_at, updated_at, connection_id, wsl_connection_id, last_opened) VALUES (?, ?, ?, ?, ?, ?, ?)",
                    params![name, path, now, now, connection_id, wsl_connection_id, now],
                ).map_err(|e| format!("Failed to insert project '{}': {}", name, e))?;
                conn.last_insert_rowid() as i32
            }
        }
    };

    match connection {
        ConnectionKey::Local => {
            project_storage::create_project_maestro_folder(&path)
                .map_err(|e| format!("Failed to initialize project storage: {}", e))?;
            project_storage::ensure_commit_template_exists(&path)
                .map_err(|e| format!("Failed to initialize commit template: {}", e))?;
        }
        ConnectionKey::Wsl { id: wsl_id } => {
            let distro = {
                let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
                conn.query_row(
                    "SELECT distro_name FROM wsl_connections WHERE id = ?",
                    [wsl_id],
                    |row| row.get::<_, String>(0),
                ).map_err(|e| format!("WSL connection {} not found: {}", wsl_id, e))?
            };
            let unc_path = format!(r"\\wsl$\{}\{}", distro, path.trim_start_matches('/'));
            project_storage::create_project_maestro_folder(&unc_path)
                .map_err(|e| format!("Failed to initialize WSL project storage: {}", e))?;
            project_storage::ensure_commit_template_exists(&unc_path)
                .map_err(|e| format!("Failed to initialize commit template: {}", e))?;
        }
        ConnectionKey::Ssh { .. } => {}
    }

    let project = get_project(app_state, project_id).map_err(|e| e.to_string())?;
    Ok(project)
}

/// Get project-level configuration from .maestro/settings.json
#[tauri::command]
#[specta::specta]
pub async fn get_project_settings(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
) -> Result<crate::models::ProjectConfigResponse, String> {
    let (path, connection_key) = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        conn.query_row(
            "SELECT path, connection_id, wsl_connection_id FROM projects WHERE id = ?",
            [project_id],
            |row| Ok((row.get::<_, String>(0)?, ConnectionKey::from_ids(row.get(1)?, row.get(2)?))),
        ).map_err(|_| format!("Project {} not found", project_id))?
    };

    let settings_path = format!("{}/.maestro/settings.json", path);
    let config = match connection_key {
        ConnectionKey::Ssh { id: conn_id } => {
            let session = app_state.ssh.get_session(conn_id).await
                .ok_or_else(|| format!("No active SSH session for connection {}", conn_id))?;
            match session.execute_command(&format!("cat {}", shell_quote(&settings_path))).await {
                Ok(output) => serde_json::from_str::<crate::models::ProjectConfig>(&output).unwrap_or_default(),
                Err(_) => crate::models::ProjectConfig::default(),
            }
        }
        ConnectionKey::Wsl { id: wsl_id } => {
            let distro: String = {
                let db = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
                db.query_row("SELECT distro_name FROM wsl_connections WHERE id = ?", params![wsl_id], |row| row.get(0))
                    .map_err(|e| format!("WSL connection not found: {}", e))?
            };
            let output = tokio::process::Command::new("wsl.exe")
                .args(["-d", &distro, "--", "cat", &settings_path])
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .no_console_window()
                .output()
                .await
                .map_err(|e| format!("Failed to spawn wsl.exe: {}", e))?;
            if output.status.success() {
                let text = String::from_utf8_lossy(&output.stdout);
                serde_json::from_str::<crate::models::ProjectConfig>(&text).unwrap_or_default()
            } else {
                crate::models::ProjectConfig::default()
            }
        }
        ConnectionKey::Local => {
            crate::models::ProjectConfig::load_from_project(&path).unwrap_or_default()
        }
    };

    Ok(crate::models::ProjectConfigResponse {
        default_agent: config.default_agent,
    })
}

/// Update project-level configuration in .maestro/settings.json
#[tauri::command]
#[specta::specta]
pub async fn update_project_settings(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    settings: crate::models::ProjectConfigRequest,
) -> Result<(), String> {
    let (path, connection_key) = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        conn.query_row(
            "SELECT path, connection_id, wsl_connection_id FROM projects WHERE id = ?",
            [project_id],
            |row| Ok((row.get::<_, String>(0)?, ConnectionKey::from_ids(row.get(1)?, row.get(2)?))),
        ).map_err(|_| format!("Project {} not found", project_id))?
    };

    let config = crate::models::ProjectConfig {
        default_agent: settings.default_agent,
        updated_at: Utc::now().to_rfc3339(),
        issue_tracking: None,
    };

    let maestro_dir = format!("{}/.maestro", path);
    let settings_path = format!("{}/settings.json", maestro_dir);

    match connection_key {
        ConnectionKey::Ssh { id: conn_id } => {
            let session = app_state.ssh.get_session(conn_id).await
                .ok_or_else(|| format!("No active SSH session for connection {}", conn_id))?;
            let json = serde_json::to_string_pretty(&config)
                .map_err(|e| format!("Serialization failed: {}", e))?;
            session.execute_command(&format!(
                "mkdir -p {} && printf '%s' {} > {}",
                shell_quote(&maestro_dir),
                shell_quote(&json),
                shell_quote(&settings_path),
            )).await.map_err(|e| format!("SSH write failed: {}", e))?;
        }
        ConnectionKey::Wsl { id: wsl_id } => {
            let distro: String = {
                let db = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
                db.query_row("SELECT distro_name FROM wsl_connections WHERE id = ?", params![wsl_id], |row| row.get(0))
                    .map_err(|e| format!("WSL connection not found: {}", e))?
            };
            let json = serde_json::to_string_pretty(&config)
                .map_err(|e| format!("Serialization failed: {}", e))?;
            let script = format!(
                "mkdir -p {} && printf '%s' {} > {}",
                shell_quote(&maestro_dir),
                shell_quote(&json),
                shell_quote(&settings_path),
            );
            let output = tokio::process::Command::new("wsl.exe")
                .args(["-d", &distro, "--", "sh", "-c", &script])
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .no_console_window()
                .output()
                .await
                .map_err(|e| format!("Failed to spawn wsl.exe: {}", e))?;
            if !output.status.success() {
                return Err(format!("WSL settings write failed: {}", String::from_utf8_lossy(&output.stderr)));
            }
        }
        ConnectionKey::Local => {
            config.save_to_project(&path)?;
        }
    }

    Ok(())
}

/// Pre-warm the shared maestro-server process for a project and optionally
/// pre-initialize the default agent so the first session spawn is near-instant.
///
/// The frontend should call this fire-and-forget after a successful `open_project`.
/// Failures are benign — subsequent session spawns fall back to the cold path.
///
/// Only applies to local (non-SSH) projects.
#[tauri::command]
#[specta::specta]
pub async fn prime_project_server(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
) -> Result<(), String> {
    let (project_path, connection_key) = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        conn.query_row(
            "SELECT path, connection_id, wsl_connection_id FROM projects WHERE id = ?",
            [project_id],
            |row| Ok((row.get::<_, String>(0)?, ConnectionKey::from_ids(row.get(1)?, row.get(2)?))),
        )
        .map_err(|_| format!("Project {} not found", project_id))?
    };

    match connection_key {
        ConnectionKey::Ssh { id: conn_id } => {
            let ssh = app_state.ssh.get_session(conn_id).await
                .ok_or_else(|| format!("No active SSH session for connection_id {}", conn_id))?;

            let deploy_lock = {
                let mut locks = app_state.acp.deploy_locks.lock().await;
                locks.entry(conn_id).or_insert_with(|| std::sync::Arc::new(tokio::sync::Mutex::new(()))).clone()
            };
            let _deploy_guard = deploy_lock.lock().await;
            let cached_path = {
                let cache = app_state.acp.discovery_cache.lock().await;
                cache.get(&ConnectionKey::Ssh { id: conn_id }).and_then(|e| e.maestro_server_path.clone())
            };
            let maestro_path = match cached_path {
                Some(p) => p,
                None => {
                    let deploy = crate::acp::deploy::ensure_remote_server(
                        &ssh, &app_state.app_handle, conn_id,
                    ).await?;
                    deploy.path
                }
            };

            crate::acp::spawn_connection_server(ConnectionKey::Ssh { id: conn_id }, crate::acp::TransportTarget::Remote { ssh: &ssh, server_path: &maestro_path }, &app_state).await?;

            let (_, default_agent) = tokio::join!(
                crate::acp::discovery_handlers::prefetch_agent_discovery(
                    Arc::clone(&*app_state),
                    ConnectionKey::Ssh { id: conn_id },
                    Some(maestro_path.clone()),
                ),
                async {
                    let settings_path = format!("{}/.maestro/settings.json", project_path);
                    ssh.execute_command(&format!("cat {}", shell_quote(&settings_path))).await
                        .ok()
                        .and_then(|output| serde_json::from_str::<crate::models::ProjectConfig>(&output).ok())
                        .and_then(|c| c.default_agent)
                }
            );
            if let Some(agent_id) = default_agent {
                crate::acp::pre_initialize_via_connection_server(
                    ConnectionKey::Ssh { id: conn_id },
                    &agent_id,
                    &project_path,
                    &app_state,
                )
                .await?;
            }
        }

        ConnectionKey::Wsl { id: wsl_id } => {
            #[cfg(windows)]
            {
                let distro: String = {
                    let db = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
                    db.query_row(
                        "SELECT distro_name FROM wsl_connections WHERE id = ?",
                        params![wsl_id],
                        |row| row.get(0),
                    )
                    .map_err(|e| format!("WSL connection not found: {}", e))?
                };
                let maestro_path = crate::acp::deploy::ensure_wsl_server(&distro, &app_state.app_handle).await?.path;
                crate::acp::spawn_connection_server(
                    ConnectionKey::Wsl { id: wsl_id },
                    crate::acp::TransportTarget::Wsl { distro: &distro, server_path: &maestro_path },
                    &app_state,
                ).await?;
                let (_, default_agent) = tokio::join!(
                    crate::acp::discovery_handlers::prefetch_agent_discovery(
                        Arc::clone(&*app_state),
                        ConnectionKey::Wsl { id: wsl_id },
                        Some(maestro_path.clone()),
                    ),
                    async {
                        let settings_path = format!("{}/.maestro/settings.json", project_path);
                        tokio::process::Command::new("wsl.exe")
                            .args(["-d", &distro, "--", "cat", &settings_path])
                            .stdout(std::process::Stdio::piped())
                            .no_console_window()
                            .output()
                            .await
                            .ok()
                            .filter(|out| out.status.success())
                            .and_then(|out| serde_json::from_slice::<crate::models::ProjectConfig>(&out.stdout).ok())
                            .and_then(|c| c.default_agent)
                    }
                );
                if let Some(agent_id) = default_agent {
                    crate::acp::pre_initialize_via_connection_server(
                        ConnectionKey::Wsl { id: wsl_id },
                        &agent_id,
                        &project_path,
                        &app_state,
                    )
                    .await?;
                }
            }
            #[cfg(not(windows))]
            {
                let _ = wsl_id;
            }
        }

        ConnectionKey::Local => {
            crate::acp::spawn_connection_server(ConnectionKey::Local, crate::acp::TransportTarget::Local, &app_state).await?;

            let default_agent = crate::models::ProjectConfig::load_from_project(&project_path)
                .ok()
                .and_then(|c| c.default_agent);
            if let Some(agent_id) = default_agent {
                crate::acp::pre_initialize_via_connection_server(
                    ConnectionKey::Local,
                    &agent_id,
                    &project_path,
                    &app_state,
                )
                .await?;
            }
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use crate::core::schema::initialize_schema;

    fn test_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        initialize_schema(&conn).unwrap();
        conn
    }

    fn insert_project(conn: &Connection, name: &str, path: &str, connection_id: Option<i32>) {
        conn.execute(
            "INSERT INTO projects (name, path, created_at, updated_at, connection_id) \
             VALUES (?, ?, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z', ?)",
            rusqlite::params![name, path, connection_id],
        )
        .unwrap();
    }

    #[test]
    fn fetch_projects_empty_returns_empty_vec() {
        let conn = test_db();
        let result = fetch_projects_from_db(&conn, ConnectionKey::Local).unwrap();
        assert!(result.is_empty());
    }

    #[test]
    fn fetch_projects_returns_local_projects() {
        let conn = test_db();
        insert_project(&conn, "My Project", "/home/user/my-project", None);
        let projects = fetch_projects_from_db(&conn, ConnectionKey::Local).unwrap();
        assert_eq!(projects.len(), 1);
        assert_eq!(projects[0].name, "My Project");
        assert_eq!(projects[0].path, "/home/user/my-project");
    }

    #[test]
    fn fetch_projects_filters_by_connection_id() {
        let conn = test_db();
        // Insert one SSH connection row so FK is satisfied
        conn.execute(
            "INSERT INTO ssh_connections (connection_string, username, host, port, auth_method, last_used_at, created_at, updated_at) \
             VALUES ('user@host:22', 'user', 'host', 22, 'password', '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z')",
            [],
        )
        .unwrap();
        let ssh_conn_id = conn.last_insert_rowid() as i32;

        insert_project(&conn, "Local Project", "/local/path", None);
        insert_project(&conn, "Remote Project", "/remote/path", Some(ssh_conn_id));

        let local = fetch_projects_from_db(&conn, ConnectionKey::Local).unwrap();
        assert_eq!(local.len(), 1);
        assert_eq!(local[0].name, "Local Project");

        let remote = fetch_projects_from_db(&conn, ConnectionKey::Ssh { id: ssh_conn_id }).unwrap();
        assert_eq!(remote.len(), 1);
        assert_eq!(remote[0].name, "Remote Project");
    }
}
