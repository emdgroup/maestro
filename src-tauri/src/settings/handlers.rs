use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::acp::connection_server::{query_project_store, query_via_server, reply};
use crate::acp::transport::{MaestroRpcMessage, ServerRequest, ServerResponse};
use crate::core::{logging, AppState};
use crate::models::{AppSettings, ConnectionCapacitySettings};
use crate::settings::models::LogLocation;

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
                log::warn!(
                    "Failed to set window decorations to {}: {}",
                    native_frame,
                    e
                );
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
    let conn = app_state
        .db
        .lock()
        .map_err(|e| format!("Lock failed: {}", e))?;
    crate::core::settings::load_settings(&conn).map_err(|e| e.to_string())
}

/// Save application settings to the database
#[tauri::command]
#[specta::specta]
pub fn save_settings(app_state: State<Arc<AppState>>, settings: AppSettings) -> Result<(), String> {
    {
        let mut conn = app_state
            .db
            .lock()
            .map_err(|e| format!("Lock failed: {}", e))?;
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

/// How many agents may run at once on one connection, as its daemon stores it.
#[tauri::command]
#[specta::specta]
pub async fn get_connection_capacity(
    app_state: State<'_, Arc<AppState>>,
    connection: crate::acp::ConnectionKey,
) -> Result<ConnectionCapacitySettings, String> {
    let status = query_via_server(
        connection,
        &app_state,
        &format!("No connection server for connection {connection:?}"),
        MaestroRpcMessage::Request(ServerRequest::GetCapacity),
        reply!(ServerResponse::GetCapacityOk(status) => status),
        15,
        "The connection's server did not answer within 15s",
    )
    .await?;
    Ok(ConnectionCapacitySettings {
        concurrency_mode: status.settings.concurrency_mode.into(),
        max_concurrent_agents: status.settings.max_concurrent_agents,
    })
}

/// The daemon answers with `PipelineSettingsChanged`, which every window turns into
/// `settings-changed`, so raising a limit can start work at once.
#[tauri::command]
#[specta::specta]
pub async fn save_connection_capacity(
    app_state: State<'_, Arc<AppState>>,
    connection: crate::acp::ConnectionKey,
    settings: ConnectionCapacitySettings,
) -> Result<(), String> {
    query_via_server(
        connection,
        &app_state,
        &format!("No connection server for connection {connection:?}"),
        MaestroRpcMessage::Request(ServerRequest::SetCapacity(
            maestro_protocol::CapacitySettings {
                concurrency_mode: settings.concurrency_mode.into(),
                max_concurrent_agents: settings.max_concurrent_agents,
            },
        )),
        reply!(ServerResponse::SetCapacityOk => ()),
        15,
        "The connection's server did not answer within 15s",
    )
    .await
}

/// Carry this connection's limit from the app's `connection_settings` row, where builds before the
/// daemon kept it, into a daemon never told one. Once: after it the daemon has a stored setting.
pub(crate) async fn seed_connection_capacity(
    app_state: &Arc<AppState>,
    connection: crate::acp::ConnectionKey,
) -> Result<(), String> {
    use rusqlite::OptionalExtension;
    let row = app_state
        .db
        .lock()
        .map_err(|e| format!("Lock failed: {e}"))?
        .query_row(
            "SELECT concurrency_mode, max_concurrent_agents FROM connection_settings
             WHERE connection_key = ?1",
            [connection.storage_id()],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i32>(1)?)),
        )
        .optional()
        .map_err(|e| format!("Failed to read the old agent limit: {e}"))?;
    let Some((mode, max_concurrent_agents)) = row else {
        return Ok(());
    };
    let status = query_via_server(
        connection,
        app_state,
        &format!("No connection server for connection {connection:?}"),
        MaestroRpcMessage::Request(ServerRequest::GetCapacity),
        reply!(ServerResponse::GetCapacityOk(status) => status),
        15,
        "The connection's server did not answer within 15s",
    )
    .await?;
    if status.stored {
        return Ok(());
    }
    query_via_server(
        connection,
        app_state,
        &format!("No connection server for connection {connection:?}"),
        MaestroRpcMessage::Request(ServerRequest::SetCapacity(
            maestro_protocol::CapacitySettings {
                concurrency_mode: if mode == "Hard" {
                    maestro_protocol::ConcurrencyMode::Hard
                } else {
                    maestro_protocol::ConcurrencyMode::Auto
                },
                max_concurrent_agents,
            },
        )),
        reply!(ServerResponse::SetCapacityOk => ()),
        15,
        "The connection's server did not answer within 15s",
    )
    .await
}

/// Whether the project's queued tasks start on their own. The project's, kept by its daemon.
#[tauri::command]
#[specta::specta]
pub async fn get_auto_mode(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
) -> Result<bool, String> {
    query_project_store(
        &app_state,
        project_id,
        |project_path| ServerRequest::GetAutoMode(maestro_protocol::ProjectRef { project_path }),
        reply!(ServerResponse::AutoModeOk(setting) => setting.enabled),
    )
    .await
}

/// Answered by `PipelineSettingsChanged` like the capacity, so the queue drains at once.
#[tauri::command]
#[specta::specta]
pub async fn set_auto_mode(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    enabled: bool,
) -> Result<(), String> {
    query_project_store(
        &app_state,
        project_id,
        |project_path| {
            ServerRequest::SetAutoMode(maestro_protocol::AutoModeSetting {
                project_path,
                enabled,
            })
        },
        reply!(ServerResponse::SetAutoModeOk => ()),
    )
    .await
}

/// The levels the UI offers, quietest first.
#[tauri::command]
#[specta::specta]
pub fn get_log_levels() -> Vec<String> {
    logging::LOG_LEVELS
        .iter()
        .map(|level| level.to_string())
        .collect()
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
        let conn = app_state
            .db
            .lock()
            .map_err(|e| format!("Lock failed: {}", e))?;
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
