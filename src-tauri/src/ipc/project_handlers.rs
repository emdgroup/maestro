use std::path::Path;
use std::sync::Arc;
use tauri::State;
use chrono::Utc;
use rusqlite::{params, ToSql};
use crate::models::Project;
use crate::db::{AppState, project_storage};

/// Fetch projects for a connection from an open DB connection.
/// Isolated into a helper so all borrow-checker temporaries are fully dropped
/// before the caller proceeds to async SSH I/O.
fn fetch_projects_from_db(
    conn: &rusqlite::Connection,
    connection_id: Option<i32>,
) -> Result<Vec<Project>, String> {

    let (query, params): (&str, &[&dyn ToSql]) = match connection_id {
        Some(id) => ("SELECT * FROM projects WHERE connection_id = ? ORDER BY created_at DESC", params![id.clone()]),
        None => ("SELECT * FROM projects WHERE connection_id IS NULL ORDER BY created_at DESC", params![])
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
    println!("get_projects() called via IPC");
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;

    let mut stmt = conn
        .prepare("SELECT * FROM projects")
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
    println!("get_connection_projects({}) called via IPC", connection_id.unwrap_or(0));

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
        println!(
            "get_connection_projects: removing {} stale project(s): {:?}",
            stale_ids.len(),
            stale_ids
        );
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
            let session = match app_state.get_ssh_session(conn_id).await {
                Some(s) => s,
                None => {
                    println!(
                        "collect_stale_project_ids: no SSH session for connection {}, skipping validation",
                        conn_id
                    );
                    return vec![];
                }
            };

            let mut stale = Vec::new();
            for project in projects {
                // Escape any double-quotes in the path to prevent shell injection
                let safe_path = project.path.replace('"', "\\\"");
                let cmd = format!("test -d \"{}\" && echo ok || echo missing", safe_path);
                match session.execute_command(&cmd).await {
                    Ok(output) => {
                        if output.trim() != "ok" {
                            stale.push(project.id);
                        }
                    }
                    Err(e) => {
                        // On command error, err on the side of caution: keep the project
                        println!(
                            "collect_stale_project_ids: failed to check path '{}': {}",
                            project.path, e
                        );
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
    println!("get_project({}) called via IPC", project_id);
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;

    // Try to find existing project
    let existing: Result<Project, _> = conn.query_row(
        "SELECT * FROM projects WHERE id = ?",
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

/// remove project by id
#[tauri::command]
#[specta::specta]
pub fn remove_project(
    app_state: State<Arc<AppState>>,
    project_id: i32,
) -> Result<(), String> {
    println!("remove_project({}) called via IPC", project_id);
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;

    // Delete from database
    conn.execute("DELETE FROM projects WHERE id = ?",[project_id])
        .map_err(|e| e.to_string())?;

    println!("Deleted project: {}", project_id);
    Ok(())
}

/// remove projects by connection id
#[tauri::command]
pub fn remove_projects_by_connection_id(
    app_state: State<Arc<AppState>>,
    connection_id: i32,
) -> Result<(), String> {
    println!("remove_projects_by_connection_id({}) called via IPC", connection_id);
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;

    // Delete from database
    conn.execute("DELETE FROM projects WHERE connection_id = ?",[connection_id])
        .map_err(|e| e.to_string())?;

    println!("Deleted projects matching connection: {}", connection_id);
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
                .get_ssh_session(conn_id)
                .await
                .ok_or_else(|| format!("No active SSH session for connection {}", conn_id))?;
            let safe_path = path.replace('"', "\\\"");
            // No-op if already a git repo
            let check = session
                .execute_command(&format!("test -d \"{}/.git\" && echo yes || echo no", safe_path))
                .await
                .map_err(|e| format!("SSH check failed: {}", e))?;
            if check.trim() == "yes" {
                return Ok(());
            }
            let output = session
                .execute_command(&format!("git init \"{}\"", safe_path))
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
                .args(["init", &path])
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
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

/// Clone a git repository and register it as a project
#[tauri::command]
#[specta::specta]
pub async fn clone_project(
    app_state: State<'_, Arc<AppState>>,
    url: String,
    target_path: String,
    connection_id: Option<i32>,
) -> Result<Project, String> {
    // Step 1: git clone (local or remote)
    match connection_id {
        Some(conn_id) => {
            let session = app_state
                .get_ssh_session(conn_id)
                .await
                .ok_or_else(|| format!("No active SSH session for connection {}", conn_id))?;
            let safe_url = url.replace('"', "\\\"");
            let safe_path = target_path.replace('"', "\\\"");
            let output = session
                .execute_command(&format!("git clone \"{}\" \"{}\"", safe_url, safe_path))
                .await
                .map_err(|e| format!("SSH git clone failed: {}", e))?;
            if output.contains("error:") || output.contains("fatal:") {
                return Err(format!("git clone failed: {}", output));
            }
        }
        None => {
            let output = tokio::process::Command::new("git")
                .args(["clone", &url, &target_path])
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .output()
                .await
                .map_err(|e| format!("Failed to spawn git: {}", e))?;
            if !output.status.success() {
                return Err(format!("git clone failed: {}", String::from_utf8_lossy(&output.stderr)));
            }
        }
    }

    // Step 2: Register in DB
    let db = app_state.inner().clone();
    let project_id = {
        let conn = db.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        let existing: Option<i32> = conn.query_row(
            "SELECT id FROM projects WHERE path = ? AND connection_id IS ?",
            rusqlite::params![target_path, connection_id],
            |row| row.get(0),
        ).ok();
        match existing {
            Some(id) => id,
            None => {
                let now = chrono::Utc::now().to_rfc3339();
                let name = std::path::Path::new(&target_path)
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("Untitled")
                    .to_string();
                conn.execute(
                    "INSERT INTO projects (name, path, created_at, updated_at, connection_id, last_opened) VALUES (?, ?, ?, ?, ?, ?)",
                    rusqlite::params![name, target_path, now, now, connection_id, now],
                ).map_err(|e| format!("Failed to insert project: {}", e))?;
                conn.last_insert_rowid() as i32
            }
        }
    };

    // Step 3: Init .maestro folder (local only — no local fs path for remote projects)
    if connection_id.is_none() {
        crate::db::project_storage::create_project_maestro_folder(&target_path)
            .map_err(|e| format!("Failed to initialize project storage: {}", e))?;
    }

    let conn = db.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
    conn.query_row(
        "SELECT * FROM projects WHERE id = ?",
        rusqlite::params![project_id],
        Project::from_row,
    ).map_err(|e| e.to_string())
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
                .get_ssh_session(conn_id)
                .await
                .ok_or_else(|| format!("No active SSH session for connection {}", conn_id))?;
            let safe_path = full_path_str.replace('"', "\\\"");
            // Step 1: Check existence
            let exists = session
                .execute_command(&format!("test -d \"{}\" && echo yes || echo no", safe_path))
                .await
                .map_err(|e| format!("SSH check failed: {}", e))?;
            if exists.trim() == "yes" {
                return Err("Directory already exists. Choose a different path or use Select Existing.".to_string());
            }
            // Step 2: Create dir + git init
            let output = session
                .execute_command(&format!("mkdir -p \"{}\" && git init \"{}\"", safe_path, safe_path))
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
                .args(["init", &full_path_str])
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .output()
                .await
                .map_err(|e| format!("Failed to spawn git: {}", e))?;
            if !output.status.success() {
                return Err(format!("git init failed: {}", String::from_utf8_lossy(&output.stderr)));
            }
        }
    }

    // Register in DB
    let db = app_state.inner().clone();
    let project_id = {
        let conn = db.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        let existing: Option<i32> = conn.query_row(
            "SELECT id FROM projects WHERE path = ? AND connection_id IS ?",
            rusqlite::params![full_path_str, connection_id],
            |row| row.get(0),
        ).ok();
        match existing {
            Some(id) => id,
            None => {
                let now = chrono::Utc::now().to_rfc3339();
                conn.execute(
                    "INSERT INTO projects (name, path, created_at, updated_at, connection_id, last_opened) VALUES (?, ?, ?, ?, ?, ?)",
                    rusqlite::params![folder_name, full_path_str, now, now, connection_id, now],
                ).map_err(|e| format!("Failed to insert project: {}", e))?;
                conn.last_insert_rowid() as i32
            }
        }
    };

    // Init .maestro folder (local only)
    if connection_id.is_none() {
        crate::db::project_storage::create_project_maestro_folder(&full_path_str)
            .map_err(|e| format!("Failed to initialize project storage: {}", e))?;
    }

    let conn = db.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
    conn.query_row(
        "SELECT * FROM projects WHERE id = ?",
        rusqlite::params![project_id],
        Project::from_row,
    ).map_err(|e| e.to_string())
}

/// Create a new project
#[tauri::command]
#[specta::specta]
pub fn create_project(
    app_state: State<Arc<AppState>>,
    path: String,
    connection_id: Option<i32>
) -> Result<Project, String> {
    println!("create_project() called via IPC with path {} and connection_id {:?}", path, connection_id);
    let project_id = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        let existing: Option<i32> = conn.query_row(
            "SELECT id FROM projects WHERE path = ? AND connection_id = ?",
            params![path, connection_id],
            |row| row.get(0),
        ).ok();
        match existing {
            Some(id) => id,
            None => {
                // Create new remote project in database
                let now = Utc::now().to_rfc3339();
                let name = Path::new(&path)
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("Untitled")
                    .to_string();
                conn.execute(
                    "INSERT INTO projects (name, path, created_at, updated_at, connection_id, last_opened) VALUES (?, ?, ?, ?, ?, ?)",
                    params![name, path, now, now, connection_id, now],
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

/// Get project-level configuration (model default, MCP allowlist, skills default)
#[tauri::command]
#[specta::specta]
pub fn get_project_settings(
    app_state: State<Arc<AppState>>,
    _project_id: i32,
) -> Result<crate::models::ProjectConfigResponse, String> {
    println!("get_project_settings() called via IPC");
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;

    // Query settings table for configuration keys
    let mut stmt = conn
        .prepare("SELECT key, value FROM settings WHERE key IN ('model_default', 'mcp_allowlist', 'skills_default')")
        .map_err(|e| e.to_string())?;

    let mut settings_map: std::collections::HashMap<String, String> = std::collections::HashMap::new();

    let settings_iter = stmt
        .query_map([], |row| {
            let key: String = row.get(0)?;
            let value: String = row.get(1)?;
            Ok((key, value))
        })
        .map_err(|e| e.to_string())?;

    for result in settings_iter {
        let (key, value) = result.map_err(|e| e.to_string())?;
        settings_map.insert(key, value);
    }

    // Extract values with defaults
    let model_default = settings_map
        .get("model_default")
        .cloned()
        .unwrap_or_else(|| "claude-opus-4-5".to_string());

    let mcp_allowlist: Vec<String> = settings_map
        .get("mcp_allowlist")
        .and_then(|v| serde_json::from_str(v).ok())
        .unwrap_or_default();

    let skills_default: Vec<String> = settings_map
        .get("skills_default")
        .and_then(|v| serde_json::from_str(v).ok())
        .unwrap_or_default();

    Ok(crate::models::ProjectConfigResponse {
        model_default,
        mcp_allowlist,
        skills_default,
    })
}

/// Update project-level configuration
#[tauri::command]
#[specta::specta]
pub fn update_project_settings(
    app_state: State<Arc<AppState>>,
    _project_id: i32,
    settings: crate::models::ProjectConfigRequest,
) -> Result<(), String> {
    println!("update_project_settings() called via IPC");
    let mut conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;

    // Serialize arrays to JSON
    let mcp_allowlist_json = serde_json::to_string(&settings.mcp_allowlist)
        .map_err(|e| format!("Failed to serialize mcp_allowlist: {}", e))?;

    let skills_default_json = serde_json::to_string(&settings.skills_default)
        .map_err(|e| format!("Failed to serialize skills_default: {}", e))?;

    let now = Utc::now().to_rfc3339();

    // Use transaction for atomic writes
    let tx = conn
        .transaction()
        .map_err(|e| format!("Failed to start transaction: {}", e))?;

    // Upsert each setting
    tx.execute(
        "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('model_default', ?, ?)",
        rusqlite::params![&settings.model_default, &now],
    )
    .map_err(|e| format!("Failed to update model_default: {}", e))?;

    tx.execute(
        "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('mcp_allowlist', ?, ?)",
        rusqlite::params![&mcp_allowlist_json, &now],
    )
    .map_err(|e| format!("Failed to update mcp_allowlist: {}", e))?;

    tx.execute(
        "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('skills_default', ?, ?)",
        rusqlite::params![&skills_default_json, &now],
    )
    .map_err(|e| format!("Failed to update skills_default: {}", e))?;

    tx.commit()
        .map_err(|e| format!("Failed to commit transaction: {}", e))?;

    println!("✓ Project settings updated");
    Ok(())
}

