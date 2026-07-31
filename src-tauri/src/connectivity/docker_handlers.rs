use std::sync::Arc;
use tauri::State;
use crate::core::AppState;
use crate::connectivity::docker::{ContainerCli, DockerConnection, DockerContainer};

fn detect_cli() -> Result<ContainerCli, String> {
    ContainerCli::detect()
}


// The docker helpers in connectivity/docker.rs stay synchronous because git/acp
// modules also call them from worker threads; here they must not run on the main
// thread (CLI calls can hang for seconds when the container runtime is down), so
// each handler moves the blocking work onto the blocking pool.
pub(crate) async fn run_blocking<T: Send + 'static>(
    task: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|e| format!("Task join failed: {e}"))?
}

/// List running and stopped containers using the detected container CLI.
#[tauri::command]
#[specta::specta]
pub async fn list_docker_containers() -> Result<Vec<DockerContainer>, String> {
    run_blocking(|| {
        let cli = detect_cli()?;
        crate::connectivity::docker::list_containers(&cli)
    })
    .await
}

/// Get the home directory for the default user in a container.
#[tauri::command]
#[specta::specta]
pub async fn get_docker_home(container_name: String) -> Result<String, String> {
    let cli = detect_cli()?;
    crate::connectivity::docker::get_home_dir(&cli, &container_name).await
}

/// List entries in a container directory.
#[tauri::command]
#[specta::specta]
pub async fn list_docker_directories(container_name: String, path: String) -> Result<Vec<String>, String> {
    let cli = detect_cli()?;
    crate::connectivity::docker::list_directories(&cli, &container_name, &path).await
}

/// Copy a file out of a container onto the host, so a host application can open it.
///
/// The container counterpart to [`crate::connectivity::sftp_handlers::sftp_download`], without the
/// progress plumbing: `cp` is one opaque call with no byte-level reporting to forward.
#[tauri::command]
#[specta::specta]
pub async fn docker_download_file(
    app_state: State<'_, Arc<AppState>>,
    connection_id: i32,
    container_path: String,
    local_path: String,
) -> Result<(), String> {
    let conn = crate::core::git_connection_for(
        &app_state,
        container_path.clone(),
        crate::acp::ConnectionKey::Docker { id: connection_id },
    )
    .await?;
    let crate::models::GitConnection::Docker { container_name, .. } = conn else {
        return Err(format!("Connection {connection_id} is not a container"));
    };

    let cli = detect_cli()?;
    crate::connectivity::docker::copy_from(
        &cli,
        &container_name,
        &container_path,
        std::path::Path::new(&local_path),
    )
    .await
}

/// Upsert a container connection record and return the saved row.
#[tauri::command]
#[specta::specta]
pub async fn save_docker_connection(
    app_state: State<'_, Arc<AppState>>,
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
pub async fn list_docker_connections(app_state: State<'_, Arc<AppState>>) -> Result<Vec<DockerConnection>, String> {
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

