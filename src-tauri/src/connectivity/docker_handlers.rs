use std::sync::Arc;
use tauri::State;
use crate::core::AppState;
use crate::connectivity::docker::{ContainerCli, DockerConnection, DockerContainer};

fn detect_cli() -> Result<ContainerCli, String> {
    ContainerCli::detect()
}

fn get_docker_container_name(app_state: &State<Arc<AppState>>, connection_id: i32) -> Result<String, String> {
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {e}"))?;
    conn.query_row(
        "SELECT container_name FROM docker_connections WHERE id = ?",
        [connection_id],
        |row| row.get(0),
    ).map_err(|_| format!("Docker connection {connection_id} not found"))
}

/// List running and stopped containers using the detected container CLI.
#[tauri::command]
#[specta::specta]
pub fn list_docker_containers() -> Result<Vec<DockerContainer>, String> {
    let cli = detect_cli()?;
    crate::connectivity::docker::list_containers(&cli)
}

/// Get the home directory for the default user in a container.
#[tauri::command]
#[specta::specta]
pub fn get_docker_home(container_name: String) -> Result<String, String> {
    let cli = detect_cli()?;
    crate::connectivity::docker::get_home_dir(&cli, &container_name)
}

/// List entries in a container directory.
#[tauri::command]
#[specta::specta]
pub fn list_docker_directories(container_name: String, path: String) -> Result<Vec<String>, String> {
    let cli = detect_cli()?;
    crate::connectivity::docker::list_directories(&cli, &container_name, &path)
}

/// Upsert a container connection record and return the saved row.
#[tauri::command]
#[specta::specta]
pub fn save_docker_connection(
    app_state: State<Arc<AppState>>,
    container_name: String,
    image_name: Option<String>,
    display_name: Option<String>,
) -> Result<DockerConnection, String> {
    let now = chrono::Utc::now().to_rfc3339();
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {e}"))?;
    conn.execute(
        "INSERT INTO docker_connections (container_name, image_name, display_name, last_used_at, created_at)
         VALUES (?1, ?2, ?3, ?4, ?4)
         ON CONFLICT(container_name) DO UPDATE SET image_name = excluded.image_name, display_name = excluded.display_name, last_used_at = excluded.last_used_at",
        rusqlite::params![container_name, image_name, display_name, now],
    ).map_err(|e| format!("Failed to save Docker connection: {e}"))?;

    let row = conn.query_row(
        "SELECT id, container_name, image_name, display_name, last_used_at, created_at FROM docker_connections WHERE container_name = ?",
        [&container_name],
        DockerConnection::from_row,
    ).map_err(|e| format!("Failed to read Docker connection: {e}"))?;
    Ok(row)
}

/// List all saved container connections from the database.
#[tauri::command]
#[specta::specta]
pub fn list_docker_connections(app_state: State<Arc<AppState>>) -> Result<Vec<DockerConnection>, String> {
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {e}"))?;
    let mut stmt = conn
        .prepare("SELECT id, container_name, image_name, display_name, last_used_at, created_at FROM docker_connections ORDER BY last_used_at DESC")
        .map_err(|e| format!("DB prepare failed: {e}"))?;
    let rows = stmt
        .query_map([], DockerConnection::from_row)
        .map_err(|e| format!("DB query failed: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("DB row failed: {e}"))?;
    Ok(rows)
}

/// List all non-hidden workspace files in a container path.
#[tauri::command]
#[specta::specta]
pub fn list_docker_workspace_files(
    app_state: State<Arc<AppState>>,
    connection_id: i32,
    path: String,
) -> Result<Vec<String>, String> {
    let container_name = get_docker_container_name(&app_state, connection_id)?;
    let cli = detect_cli()?;
    let script = format!(
        "find {} -maxdepth 8 -not -path '*/.*' -not -path '*/node_modules/*' -not -path '*/__pycache__/*' -type f 2>/dev/null | head -2000",
        crate::git::remote::shell_quote(&path)
    );
    let output = std::process::Command::new(cli.binary())
        .args(["exec", &container_name, "sh", "-c", &script])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .output()
        .map_err(|e| format!("Failed to exec in container: {e}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(|l| l.to_string())
        .collect())
}

/// Read a text file from a container. Rejects files over 512 KB.
#[tauri::command]
#[specta::specta]
pub fn read_docker_file(
    app_state: State<Arc<AppState>>,
    connection_id: i32,
    path: String,
) -> Result<String, String> {
    let container_name = get_docker_container_name(&app_state, connection_id)?;
    let cli = detect_cli()?;
    crate::connectivity::docker::read_file(&cli, &container_name, &path)
}

/// Read a file from a container as base64. Rejects files over 5 MB.
#[tauri::command]
#[specta::specta]
pub fn read_docker_file_binary(
    app_state: State<Arc<AppState>>,
    connection_id: i32,
    path: String,
) -> Result<String, String> {
    let container_name = get_docker_container_name(&app_state, connection_id)?;
    let cli = detect_cli()?;
    crate::connectivity::docker::read_file_binary(&cli, &container_name, &path)
}
