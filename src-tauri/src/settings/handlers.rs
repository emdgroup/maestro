use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};

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

/// Put the main window on the OS frame or on Maestro's own title bar.
///
/// Called from `setup` while the window is still hidden, and again on every settings save. The
/// `is_decorated` check is what keeps the second case cheap: a save fires for unrelated changes
/// like the theme, and Windows repaints the whole frame on every `set_decorations` call.
///
/// A frame that failed to change is not worth failing a settings save over, so this reports and
/// returns rather than propagating.
#[cfg(not(target_os = "macos"))]
pub fn apply_window_frame(app: &AppHandle, native_frame: bool) {
    let Some(window) = app.get_webview_window("main") else {
        log::warn!("No main window to apply the window frame to");
        return;
    };
    match window.is_decorated() {
        Ok(current) if current == native_frame => {}
        Ok(_) => {
            if let Err(e) = window.set_decorations(native_frame) {
                log::warn!("Failed to set window decorations to {}: {}", native_frame, e);
            }
        }
        Err(e) => log::warn!("Failed to read the window decoration state: {}", e),
    }
}

/// macOS keeps its native title bar either way, so there is nothing to switch.
#[cfg(target_os = "macos")]
pub fn apply_window_frame(_app: &AppHandle, _native_frame: bool) {}

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
    {
        let mut conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        crate::core::settings::save_settings(&mut conn, &settings).map_err(|e| e.to_string())?;
    }

    // The level is a global gate, so it takes effect without a restart. The directory cannot —
    // fern's targets are fixed once built — which is why the UI says so.
    logging::apply_stored_level(settings.log_level.as_deref());

    apply_window_frame(&app_state.app_handle, settings.native_window_frame);

    // Switching auto-mode on, or raising the concurrency limit, has to be able to start work
    // immediately. Without this the change would sit inert until a task happened to move, which
    // is what made the auto-mode switch look broken.
    app_state.app_handle.emit("settings-changed", ()).ok();
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
