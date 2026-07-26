use std::sync::Arc;
use tauri::{AppHandle, State};

use crate::models::AppSettings;
use crate::settings::models::LogLocation;
use crate::core::{logging, AppState};

#[tauri::command]
#[specta::specta]
pub fn get_linux_install_type() -> &'static str {
    #[cfg(target_os = "linux")]
    {
        if std::env::var("APPIMAGE").is_ok() {
            "appimage"
        } else {
            "package"
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        "native"
    }
}

/// Get current application settings from the database
#[tauri::command]
#[specta::specta]
pub fn get_settings(app_state: State<Arc<AppState>>) -> Result<AppSettings, String> {
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
    crate::core::settings::load_settings(&conn).map_err(|e| e.to_string())
}

/// Save application settings to the database
#[tauri::command]
#[specta::specta]
pub fn save_settings(
    app_state: State<Arc<AppState>>,
    settings: AppSettings,
) -> Result<(), String> {
    let mut conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
    crate::core::settings::save_settings(&mut conn, &settings).map_err(|e| e.to_string())?;

    // The level is a global gate, so it takes effect without a restart. The directory cannot —
    // fern's targets are fixed once built — which is why the UI says so.
    logging::apply_stored_level(settings.log_level.as_deref());
    Ok(())
}

/// The levels the UI offers, quietest first.
#[tauri::command]
#[specta::specta]
pub fn get_log_levels() -> Vec<String> {
    logging::LOG_LEVELS.iter().map(|level| level.to_string()).collect()
}

/// Where logs are being written, and where they will be written next launch.
///
/// This doubles as the answer to "where are my logs" — a user cannot attach a file they cannot
/// find, and the path differs on every platform.
#[tauri::command]
#[specta::specta]
pub fn get_log_directory(
    app: AppHandle,
    app_state: State<Arc<AppState>>,
) -> Result<LogLocation, String> {
    let configured = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        crate::core::settings::load_settings(&conn)?.log_directory
    };
    let resolved = logging::current_log_dir(&app, configured.as_deref())?;

    Ok(LogLocation {
        active_directory: logging::active_directory()
            .map(|directory| directory.display().to_string())
            .unwrap_or_default(),
        configured_directory: resolved.display().to_string(),
    })
}
