use std::sync::Arc;
use tauri::State;
use crate::core::AppState;
use crate::wsl::{WslConnection, WslDistro};

/// List installed WSL distros. Returns empty vec on non-Windows.
#[tauri::command]
#[specta::specta]
pub fn list_wsl_distros() -> Result<Vec<WslDistro>, String> {
    crate::wsl::list_distros()
}

/// List entries in a WSL distro directory.
#[tauri::command]
#[specta::specta]
pub fn list_wsl_directories(distro: String, path: String) -> Result<Vec<String>, String> {
    crate::wsl::list_directories(&distro, &path)
}

/// Get the home directory for the default user in a WSL distro.
#[tauri::command]
#[specta::specta]
pub fn get_wsl_home(distro: String) -> Result<String, String> {
    crate::wsl::get_home_dir(&distro)
}

/// Upsert a WSL connection record and return the saved row.
#[tauri::command]
#[specta::specta]
pub fn save_wsl_connection(
    app_state: State<Arc<AppState>>,
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

/// List all saved WSL connections from the database.
#[tauri::command]
#[specta::specta]
pub fn list_wsl_connections(app_state: State<Arc<AppState>>) -> Result<Vec<WslConnection>, String> {
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
