use std::path::Path;
use std::sync::Arc;
use tauri::State;
use chrono::Utc;
use rusqlite::params;
use crate::models::Project;
use crate::core::{AppState, project_storage};
use crate::git::remote::shell_quote;
use crate::acp::ConnectionKey;
use crate::command_ext::NoConsoleWindow;

/// Register a project in the database (check-or-insert) and initialize .maestro folder.
/// Returns the full Project row.
pub(crate) fn register_project_in_db(
    app_state: &Arc<AppState>,
    path: &str,
    name: &str,
    connection_key: ConnectionKey,
) -> Result<Project, String> {
    let path = path.trim_end_matches('/');
    let connection_id = connection_key.ssh_id();
    let wsl_connection_id = connection_key.wsl_id();
    let docker_connection_id = connection_key.docker_id();
    let project_id = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        let existing: Option<i32> = conn.query_row(
            "SELECT id FROM projects WHERE path = ? AND connection_id IS ? AND wsl_connection_id IS ? AND docker_connection_id IS ?",
            params![path, connection_id, wsl_connection_id, docker_connection_id],
            |row| row.get(0),
        ).ok();
        match existing {
            Some(id) => id,
            None => {
                let now = chrono::Utc::now().to_rfc3339();
                conn.execute(
                    "INSERT INTO projects (name, path, created_at, updated_at, connection_id, wsl_connection_id, docker_connection_id, last_opened) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    params![name, path, now, now, connection_id, wsl_connection_id, docker_connection_id, now],
                ).map_err(|e| format!("Failed to insert project: {}", e))?;
                conn.last_insert_rowid() as i32
            }
        }
    };

    // Init .maestro folder for local, WSL, and Docker projects.
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
        ConnectionKey::Docker { id: docker_id } => {
            let container_name: Option<String> = app_state.db.lock().ok().and_then(|conn| {
                conn.query_row(
                    "SELECT container_name FROM docker_connections WHERE id = ?",
                    [docker_id],
                    |row| row.get::<_, String>(0),
                ).ok()
            });
            if let Some(container_name) = container_name {
                let cli = crate::connectivity::docker::ContainerCli::detect()
                    .unwrap_or(crate::connectivity::docker::ContainerCli::Docker);
                let maestro_dir = format!("{}/.maestro", path);
                let _ = std::process::Command::new(cli.binary())
                    .args(["exec", &container_name, "mkdir", "-p", &maestro_dir])
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .status();
            }
        }
        ConnectionKey::Ssh { .. } => {}
    }

    // Read back full project row
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
    conn.query_row(
        "SELECT id, name, path, created_at, updated_at, last_opened, connection_id, wsl_connection_id, docker_connection_id FROM projects WHERE id = ?",
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
    let select = "SELECT id, name, path, created_at, updated_at, last_opened, connection_id, wsl_connection_id, docker_connection_id FROM projects";
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
        ConnectionKey::Docker { id } => {
            let query = format!("{} WHERE docker_connection_id = ? {}", select, order);
            let mut stmt = conn.prepare(&query).map_err(|e| e.to_string())?;
            let projects: Vec<Project> = stmt
                .query_map([id], Project::from_row)
                .map_err(|e| e.to_string())?
                .collect::<Result<_, _>>()
                .map_err(|e: rusqlite::Error| e.to_string())?;
            Ok(projects)
        }
        ConnectionKey::Local => {
            let query = format!("{} WHERE connection_id IS NULL AND wsl_connection_id IS NULL AND docker_connection_id IS NULL {}", select, order);
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
        .prepare("SELECT id, name, path, created_at, updated_at, last_opened, connection_id, wsl_connection_id, docker_connection_id FROM projects ORDER BY last_opened DESC NULLS LAST")
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

        ConnectionKey::Docker { id: docker_id } => {
            let container_name: String = {
                let db = match app_state.db.lock() {
                    Ok(d) => d,
                    Err(_) => return vec![],
                };
                match db.query_row(
                    "SELECT container_name FROM docker_connections WHERE id = ?",
                    params![docker_id],
                    |row| row.get(0),
                ) {
                    Ok(name) => name,
                    Err(_) => return vec![],
                }
            };
            let cli = match crate::connectivity::docker::ContainerCli::detect() {
                Ok(c) => c,
                Err(_) => return vec![],
            };
            let mut stale = Vec::new();
            for project in projects {
                let output = tokio::process::Command::new(cli.binary())
                    .args(["exec", &container_name, "test", "-d", &project.path])
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
        "SELECT id, name, path, created_at, updated_at, last_opened, connection_id, wsl_connection_id, docker_connection_id FROM projects WHERE id = ?",
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
            "SELECT id, name, path, created_at, updated_at, last_opened, connection_id, wsl_connection_id, docker_connection_id FROM projects WHERE id = ?",
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
    if !project.is_remote() && !project.is_docker() {
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
        crate::core::project_storage::write_canvas_catalog(&effective_path)
            .map_err(|e| format!("Failed to write canvas catalog: {}", e))?;
        crate::core::project_storage::write_canvas_base_skill(&effective_path)
            .map_err(|e| format!("Failed to write canvas base skill: {}", e))?;
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
    let docker_connection_id = connection.docker_id();
    // NOTE: This older handler has similar logic to register_project_in_db but also
    // updates last_opened via get_project(). Could be unified in a future cleanup.
    let project_id = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        let existing: Option<i32> = conn.query_row(
            "SELECT id FROM projects WHERE path = ? AND connection_id IS ? AND wsl_connection_id IS ? AND docker_connection_id IS ?",
            params![path, connection_id, wsl_connection_id, docker_connection_id],
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
                    "INSERT INTO projects (name, path, created_at, updated_at, connection_id, wsl_connection_id, docker_connection_id, last_opened) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    params![name, path, now, now, connection_id, wsl_connection_id, docker_connection_id, now],
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
        ConnectionKey::Docker { id: docker_id } => {
            let container_name: Option<String> = app_state.db.lock().ok().and_then(|conn| {
                conn.query_row(
                    "SELECT container_name FROM docker_connections WHERE id = ?",
                    [docker_id],
                    |row| row.get::<_, String>(0),
                ).ok()
            });
            if let Some(container_name) = container_name {
                let cli = crate::connectivity::docker::ContainerCli::detect()
                    .unwrap_or(crate::connectivity::docker::ContainerCli::Docker);
                let maestro_dir = format!("{}/.maestro", path);
                let _ = std::process::Command::new(cli.binary())
                    .args(["exec", &container_name, "mkdir", "-p", &maestro_dir])
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .status();
            }
        }
        ConnectionKey::Ssh { .. } => {}
    }

    let project = get_project(app_state, project_id).map_err(|e| e.to_string())?;
    Ok(project)
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
