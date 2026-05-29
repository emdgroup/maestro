use std::path::Path;
use std::sync::Arc;
use tauri::State;
use crate::command_ext::NoConsoleWindow;
use chrono::Utc;
use rusqlite::{params, ToSql};
use serde_json;
use crate::models::Project;
use crate::db::{AppState, project_storage};
use crate::git::remote::shell_quote;
use crate::acp::ConnectionKey;

/// Register a project in the database (check-or-insert) and initialize .maestro folder.
/// Returns the full Project row.
///
/// Uses `connection_id IS ?` for nullable column comparison (SQLite NULL semantics).
fn register_project_in_db(
    app_state: &Arc<AppState>,
    path: &str,
    name: &str,
    connection_id: Option<i32>,
) -> Result<Project, String> {
    let project_id = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        let existing: Option<i32> = conn.query_row(
            "SELECT id FROM projects WHERE path = ? AND connection_id IS ?",
            rusqlite::params![path, connection_id],
            |row| row.get(0),
        ).ok();
        match existing {
            Some(id) => id,
            None => {
                let now = chrono::Utc::now().to_rfc3339();
                conn.execute(
                    "INSERT INTO projects (name, path, created_at, updated_at, connection_id, last_opened) VALUES (?, ?, ?, ?, ?, ?)",
                    rusqlite::params![name, path, now, now, connection_id, now],
                ).map_err(|e| format!("Failed to insert project: {}", e))?;
                conn.last_insert_rowid() as i32
            }
        }
    };

    // Init .maestro folder (local only — remote projects have no local filesystem path)
    if connection_id.is_none() {
        crate::db::project_storage::create_project_maestro_folder(path)
            .map_err(|e| format!("Failed to initialize project storage: {}", e))?;
    }

    // Read back full project row
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
    conn.query_row(
        "SELECT id, name, path, created_at, updated_at, last_opened, connection_id, wsl_connection_id FROM projects WHERE id = ?",
        rusqlite::params![project_id],
        Project::from_row,
    ).map_err(|e| e.to_string())
}

/// Fetch projects for a connection from an open DB connection.
/// Isolated into a helper so all borrow-checker temporaries are fully dropped
/// before the caller proceeds to async SSH I/O.
fn fetch_projects_from_db(
    conn: &rusqlite::Connection,
    connection_id: Option<i32>,
) -> Result<Vec<Project>, String> {

    let (query, params): (&str, &[&dyn ToSql]) = match connection_id {
        Some(id) => ("SELECT id, name, path, created_at, updated_at, last_opened, connection_id, wsl_connection_id FROM projects WHERE connection_id = ? ORDER BY last_opened DESC NULLS LAST, created_at DESC", params![id.clone()]),
        None => ("SELECT id, name, path, created_at, updated_at, last_opened, connection_id, wsl_connection_id FROM projects WHERE connection_id IS NULL ORDER BY last_opened DESC NULLS LAST, created_at DESC", params![])
    };
    let mut stmt = conn.prepare(query)
        .map_err(|e| e.to_string())?;

    let projects = stmt
        .query_map(params, Project::from_row)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(projects)
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

/// Get list of all projects per connections
#[tauri::command]
#[specta::specta]
pub async fn get_connection_projects(app_state: State<'_, Arc<AppState>>, connection_id: Option<i32>) -> Result<Vec<Project>, String> {
    // ── Step 1: fetch projects (db lock acquired and released in this block) ─
    let projects: Vec<Project> = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        fetch_projects_from_db(&conn, connection_id)?
        // conn drops here — lock released before async work below
    };

    // ── Step 2: validate paths ───────────────────────────────────────────────
    let stale_ids = collect_stale_project_ids(&projects, connection_id, &app_state).await;

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
/// - Local connections: checks path existence with std::fs.
/// - SSH connections: runs `test -d` via the active SSH session.
///   If no session is found (should not happen in normal flow), skips validation.
async fn collect_stale_project_ids(
    projects: &[Project],
    connection_id: Option<i32>,
    app_state: &Arc<AppState>,
) -> Vec<i32> {
    match connection_id {
        // ── Local: synchronous filesystem check ─────────────────────────────
        None => projects
            .iter()
            .filter(|p| !std::path::Path::new(&p.path).exists())
            .map(|p| p.id)
            .collect(),

        // ── SSH: check via active session ────────────────────────────────────
        Some(conn_id) => {
            let session = match app_state.ssh.get_session(conn_id).await {
                Some(s) => s,
                None => {
                    return vec![];
                }
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
                    Err(_) => {
                        // On command error, err on the side of caution: keep the project
                    }
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
        .filter(|&id| crate::project_lock::is_project_locked(&app_state.app_data_dir, id))
        .collect()
}

/// remove project by id
#[tauri::command]
#[specta::specta]
pub fn remove_project(
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
) -> Result<(), String> {
    match connection_id {
        Some(conn_id) => {
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
                Ok(())
            } else {
                Err(format!("git init failed: {}", output))
            }
        }
        None => {
            let git_dir = std::path::Path::new(&path).join(".git");
            if git_dir.exists() {
                return Ok(()); // Already a git repo, nothing to do
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
    }
}

fn build_provider_auth_header(
    provider: &str,
    app_state: &AppState,
) -> Result<Option<String>, String> {
    use base64::Engine as _;

    let creds = crate::ipc::issue_tracking_handlers::get_integration_creds(provider, app_state)?;

    let header = match provider {
        "bitbucket" => match creds.instance_url {
            Some(_) => format!("Authorization: Bearer {}", creds.token),
            None => {
                let email = creds.email.ok_or("Bitbucket Cloud credentials missing email")?;
                let basic = base64::engine::general_purpose::STANDARD
                    .encode(format!("{}:{}", email, creds.token).as_bytes());
                format!("Authorization: Basic {}", basic)
            }
        },
        "github" | "gitlab" => format!("Authorization: Bearer {}", creds.token),
        "forgejo" | "gitea" => format!("Authorization: token {}", creds.token),
        "azuredevops" => {
            let basic = base64::engine::general_purpose::STANDARD
                .encode(format!(":{}", creds.token).as_bytes());
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
    provider: Option<String>,
) -> Result<Project, String> {
    let auth_header = match provider.as_deref() {
        Some(provider_key) if url.starts_with("http://") || url.starts_with("https://") => {
            build_provider_auth_header(provider_key, &app_state)?
        }
        _ => None,
    };

    // Step 1: git clone (local or remote)
    match connection_id {
        Some(conn_id) => {
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
        None => {
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

    // Step 2: Register in DB and init .maestro folder
    let name = std::path::Path::new(&target_path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("Untitled")
        .to_string();

    register_project_in_db(app_state.inner(), &target_path, &name, connection_id)
}

/// Create a new project directory, git init it, and register as a project
#[tauri::command]
#[specta::specta]
pub async fn create_new_project(
    app_state: State<'_, Arc<AppState>>,
    parent_dir: String,
    folder_name: String,
    connection_id: Option<i32>,
) -> Result<Project, String> {
    // Build full path string (works for both local and remote — remote paths are POSIX)
    let full_path_str = format!("{}/{}", parent_dir.trim_end_matches('/'), folder_name);

    match connection_id {
        Some(conn_id) => {
            let session = app_state
                .ssh.get_session(conn_id)
                .await
                .ok_or_else(|| format!("No active SSH session for connection {}", conn_id))?;
            // Step 1: Check existence
            let exists = session
                .execute_command(&format!("test -d {} && echo yes || echo no", shell_quote(&full_path_str)))
                .await
                .map_err(|e| format!("SSH check failed: {}", e))?;
            if exists.trim() == "yes" {
                return Err("Directory already exists. Choose a different path or use Select Existing.".to_string());
            }
            // Step 2: Create dir + git init
            let output = session
                .execute_command(&format!("mkdir -p {} && git init -b main {}", shell_quote(&full_path_str), shell_quote(&full_path_str)))
                .await
                .map_err(|e| format!("SSH create failed: {}", e))?;
            if output.contains("error:") || output.contains("fatal:") {
                return Err(format!("Remote create failed: {}", output));
            }
        }
        None => {
            let full_path = std::path::Path::new(&parent_dir).join(&folder_name);
            // Step 1: Check if directory already exists
            if full_path.exists() {
                return Err("Directory already exists. Choose a different path or use Select Existing.".to_string());
            }
            // Step 2: Create directory
            std::fs::create_dir_all(&full_path)
                .map_err(|e| format!("Failed to create directory: {}", e))?;
            // Step 3: git init
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

    // Register in DB and init .maestro folder
    register_project_in_db(app_state.inner(), &full_path_str, &folder_name, connection_id)
}

/// Create a new project
#[tauri::command]
#[specta::specta]
pub fn create_project(
    app_state: State<Arc<AppState>>,
    path: String,
    connection_id: Option<i32>,
    wsl_connection_id: Option<i32>,
) -> Result<Project, String> {
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

    // Initialize .maestro folder structure for project-local storage
    // (Phase 18 architectural change: state stored locally, not in global database)
    project_storage::create_project_maestro_folder(&path)
        .map_err(|e| format!("Failed to initialize project storage: {}", e))?;

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
    let (path, connection_id) = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        conn.query_row(
            "SELECT path, connection_id FROM projects WHERE id = ?",
            [project_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<i32>>(1)?)),
        ).map_err(|_| format!("Project {} not found", project_id))?
    };

    let config = if let Some(conn_id) = connection_id {
        let session = app_state.ssh.get_session(conn_id).await
            .ok_or_else(|| format!("No active SSH session for connection {}", conn_id))?;
        let settings_path = format!("{}/.maestro/settings.json", path);
        match session.execute_command(&format!("cat {}", shell_quote(&settings_path))).await {
            Ok(output) => serde_json::from_str::<crate::models::ProjectConfig>(&output)
                .unwrap_or_default(),
            Err(_) => crate::models::ProjectConfig::default(),
        }
    } else {
        crate::models::ProjectConfig::load_from_project(&path).unwrap_or_default()
    };

    Ok(crate::models::ProjectConfigResponse {
        default_agent: config.default_agent,
        default_model: config.default_model,
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
    let (path, connection_id) = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        conn.query_row(
            "SELECT path, connection_id FROM projects WHERE id = ?",
            [project_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<i32>>(1)?)),
        ).map_err(|_| format!("Project {} not found", project_id))?
    };

    let config = crate::models::ProjectConfig {
        default_agent: settings.default_agent,
        default_model: settings.default_model,
        updated_at: Utc::now().to_rfc3339(),
        issue_tracking: None,
    };

    if let Some(conn_id) = connection_id {
        let session = app_state.ssh.get_session(conn_id).await
            .ok_or_else(|| format!("No active SSH session for connection {}", conn_id))?;
        let maestro_dir = format!("{}/.maestro", path);
        let settings_path = format!("{}/settings.json", maestro_dir);
        let json = serde_json::to_string_pretty(&config)
            .map_err(|e| format!("Serialization failed: {}", e))?;
        session.execute_command(&format!(
            "mkdir -p {} && printf '%s' {} > {}",
            shell_quote(&maestro_dir),
            shell_quote(&json),
            shell_quote(&settings_path),
        )).await.map_err(|e| format!("SSH write failed: {}", e))?;
    } else {
        config.save_to_project(&path)?;
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
    let (project_path, connection_id) = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        conn.query_row(
            "SELECT path, connection_id FROM projects WHERE id = ?",
            [project_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<i32>>(1)?)),
        )
        .map_err(|_| format!("Project {} not found", project_id))?
    };

    if let Some(conn_id) = connection_id {
        let ssh = app_state.ssh.get_session(conn_id).await
            .ok_or_else(|| format!("No active SSH session for connection_id {}", conn_id))?;

        let deploy_lock = {
            let mut locks = app_state.acp.deploy_locks.lock().await;
            locks.entry(conn_id).or_insert_with(|| std::sync::Arc::new(tokio::sync::Mutex::new(()))).clone()
        };
        let _deploy_guard = deploy_lock.lock().await;
        // Re-check cache after acquiring lock: preflight or prefetch may have populated it.
        let cached_path = {
            let cache = app_state.acp.discovery_cache.lock().await;
            cache.get(&ConnectionKey::Ssh(conn_id)).and_then(|e| e.maestro_server_path.clone())
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

        crate::acp::spawn_connection_server(ConnectionKey::Ssh(conn_id), crate::acp::TransportTarget::Remote { ssh: &ssh, server_path: &maestro_path }, &app_state).await?;

        // Run discovery and settings read in parallel. Discovery reuses the already-known
        // maestro_path so ensure_remote_server is not called a second time.
        let (_, default_agent) = tokio::join!(
            crate::ipc::acp_handlers::prefetch_agent_discovery(
                Arc::clone(&*app_state),
                Some(conn_id),
                None,
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
                ConnectionKey::Ssh(conn_id),
                Some(project_id),
                &agent_id,
                &project_path,
                &app_state,
            )
            .await?;
            crate::ipc::acp_handlers::spawn_pooled_session(
                &*app_state,
                project_id,
                ConnectionKey::Ssh(conn_id),
                &agent_id,
                &project_path,
            )
            .await;
        }
    } else {
        crate::acp::spawn_connection_server(ConnectionKey::Local, crate::acp::TransportTarget::Local, &app_state).await?;

        let default_agent = crate::models::ProjectConfig::load_from_project(&project_path)
            .ok()
            .and_then(|c| c.default_agent);
        if let Some(agent_id) = default_agent {
            crate::acp::pre_initialize_via_connection_server(
                ConnectionKey::Local,
                Some(project_id),
                &agent_id,
                &project_path,
                &app_state,
            )
            .await?;
            crate::ipc::acp_handlers::spawn_pooled_session(
                &*app_state,
                project_id,
                ConnectionKey::Local,
                &agent_id,
                &project_path,
            )
            .await;
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use crate::db::schema::initialize_schema;

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
        let result = fetch_projects_from_db(&conn, None).unwrap();
        assert!(result.is_empty());
    }

    #[test]
    fn fetch_projects_returns_local_projects() {
        let conn = test_db();
        insert_project(&conn, "My Project", "/home/user/my-project", None);
        let projects = fetch_projects_from_db(&conn, None).unwrap();
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

        let local = fetch_projects_from_db(&conn, None).unwrap();
        assert_eq!(local.len(), 1);
        assert_eq!(local[0].name, "Local Project");

        let remote = fetch_projects_from_db(&conn, Some(ssh_conn_id)).unwrap();
        assert_eq!(remote.len(), 1);
        assert_eq!(remote[0].name, "Remote Project");
    }
}
