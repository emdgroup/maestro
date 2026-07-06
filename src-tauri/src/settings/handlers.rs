use std::sync::Arc;
use tauri::State;

use crate::models::AppSettings;
use crate::core::AppState;

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
    crate::core::settings::save_settings(&mut conn, &settings).map_err(|e| e.to_string())
}
