use std::sync::Arc;
use tauri::State;
use crate::core::AppState;
use crate::connectivity::wsl::{WslConnection, WslDistro};

/// List installed WSL distros. Returns empty vec on non-Windows.
#[tauri::command]
#[specta::specta]
pub async fn list_wsl_distros() -> Result<Vec<WslDistro>, String> {
    crate::connectivity::wsl::list_distros().await
}

/// List entries in a WSL distro directory.
#[tauri::command]
#[specta::specta]
pub async fn list_wsl_directories(distro: String, path: String) -> Result<Vec<String>, String> {
    crate::connectivity::wsl::list_directories(&distro, &path).await
}

/// Get the home directory for the default user in a WSL distro.
#[tauri::command]
#[specta::specta]
pub async fn get_wsl_home(distro: String) -> Result<String, String> {
    crate::connectivity::wsl::get_home_dir(&distro).await
}

/// Translate a path inside a WSL distro to the Windows path naming the same file, for handing to
/// a Windows application.
#[tauri::command]
#[specta::specta]
pub async fn wsl_to_windows_path(distro: String, path: String) -> Result<String, String> {
    crate::connectivity::wsl::to_windows_path(&distro, &path).await
}

/// Copy a file out of a WSL distro to somewhere on the host.
///
/// The distro counterpart to [`crate::connectivity::sftp_handlers::sftp_download`] and
/// [`crate::connectivity::docker_handlers::docker_download_file`], without the progress plumbing.
/// Unlike either of those nothing streams through a shell: the distro's files are already
/// reachable under a Windows path, so this is an ordinary host-side copy.
#[tauri::command]
#[specta::specta]
pub async fn wsl_download_file(
    app_state: State<'_, Arc<AppState>>,
    connection_id: i32,
    distro_path: String,
    local_path: String,
) -> Result<(), String> {
    let conn = crate::core::git_connection_for(
        &app_state,
        distro_path.clone(),
        crate::acp::ConnectionKey::Wsl { id: connection_id },
    )
    .await?;
    let crate::models::GitConnection::Wsl { distro, .. } = conn else {
        return Err(format!("Connection {connection_id} is not a WSL distro"));
    };

    let windows_path = crate::connectivity::wsl::to_windows_path(&distro, &distro_path).await?;

    // `copy` will not create the destination's parent, and the callers that stage a file under the
    // temp dir rely on it being made for them — same as the container path does.
    if let Some(parent) = std::path::Path::new(&local_path).parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("Failed to create {}: {e}", parent.display()))?;
    }
    tokio::fs::copy(&windows_path, &local_path)
        .await
        .map_err(|e| format!("Failed to copy {windows_path} to {local_path}: {e}"))?;
    Ok(())
}

/// Upsert a WSL connection record and return the saved row.
#[tauri::command]
#[specta::specta]
pub async fn save_wsl_connection(
    app_state: State<'_, Arc<AppState>>,
    distro_name: String,
    display_name: Option<String>,
) -> Result<WslConnection, String> {
    let now = chrono::Utc::now().to_rfc3339();
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {e}"))?;
    conn.execute(
        "INSERT INTO wsl_connections (distro_name, display_name, last_used_at, created_at)
         VALUES (?1, ?2, ?3, ?3)
         ON CONFLICT(distro_name) DO UPDATE SET display_name = excluded.display_name, last_used_at = excluded.last_used_at",
        rusqlite::params![distro_name, display_name, now],
    ).map_err(|e| format!("Failed to save WSL connection: {e}"))?;

    let row = conn.query_row(
        "SELECT id, distro_name, display_name, last_used_at, created_at FROM wsl_connections WHERE distro_name = ?",
        [&distro_name],
        |row| Ok(WslConnection {
            id: row.get(0)?,
            distro_name: row.get(1)?,
            display_name: row.get(2)?,
            last_used_at: row.get(3)?,
            created_at: row.get(4)?,
        }),
    ).map_err(|e| format!("Failed to read WSL connection: {e}"))?;
    Ok(row)
}

/// Delete a WSL connection and its associated project history.
#[tauri::command]
#[specta::specta]
pub async fn delete_wsl_connection(
    app_state: State<'_, Arc<AppState>>,
    connection_id: i32,
) -> Result<(), String> {
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {e}"))?;
    conn.execute(
        "DELETE FROM projects WHERE wsl_connection_id = ?",
        [connection_id],
    )
    .map_err(|e| format!("Failed to remove projects: {e}"))?;
    let rows_deleted = conn
        .execute(
            "DELETE FROM wsl_connections WHERE id = ?",
            [connection_id],
        )
        .map_err(|e| format!("Failed to delete WSL connection: {e}"))?;
    if rows_deleted == 0 {
        return Err(format!("WSL connection {connection_id} not found"));
    }
    Ok(())
}

/// List all saved WSL connections from the database.
#[tauri::command]
#[specta::specta]
pub async fn list_wsl_connections(app_state: State<'_, Arc<AppState>>) -> Result<Vec<WslConnection>, String> {
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {e}"))?;
    let mut stmt = conn
        .prepare("SELECT id, distro_name, display_name, last_used_at, created_at FROM wsl_connections ORDER BY last_used_at DESC")
        .map_err(|e| format!("DB prepare failed: {e}"))?;
    let rows = stmt
        .query_map([], |row| Ok(WslConnection {
            id: row.get(0)?,
            distro_name: row.get(1)?,
            display_name: row.get(2)?,
            last_used_at: row.get(3)?,
            created_at: row.get(4)?,
        }))
        .map_err(|e| format!("DB query failed: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("DB row failed: {e}"))?;
    Ok(rows)
}
