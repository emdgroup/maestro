// Tauri build script marker
#![cfg_attr(all(not(debug_assertions), target_os = "windows"), windows_subsystem = "windows")]

use maestro::core::{init_db, AppState};
use maestro_protocol::{CancelRequest, MaestroRpcMessage, ServerRequest};
use std::sync::Arc;
use tauri::Manager;

/// Setup hook for Tauri initialization
fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let app_data_dir = app.path().app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))?;
    let db_path = app_data_dir.join("maestro.db");

    // Initialize database — init_db returns Result<Connection, String>
    // Use map_err to convert String -> Box<dyn Error> since String doesn't impl Error
    let conn = init_db(db_path)
        .map_err(|e| format!("Failed to initialize database: {}", e))?;

    let app_state = Arc::new(AppState::new(conn, app.handle().clone(), app_data_dir.clone()));

    app.manage(app_state);

    Ok(())
}

fn main() {
    // Generate TypeScript bindings in debug builds
    let builder = maestro::create_builder();

    let app = tauri::Builder::default()
        .setup(setup)
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(builder.invoke_handler())
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // Prevent immediate close so we can cancel active ACP sessions first.
                // This gives maestro-server a chance to send CloseSessionRequest to agents,
                // freeing their in-memory session state rather than orphaning it.
                api.prevent_close();
                let handle = window.app_handle().clone();
                tauri::async_runtime::spawn(async move {
                    let state = handle.state::<Arc<AppState>>();
                    let session_keys: Vec<i32> = state.acp.sessions.lock().await.keys().copied().collect();
                    for log_id in session_keys {
                        let session_id = format!("session-{}", log_id);
                        let cancel_msg = MaestroRpcMessage::Request(
                            ServerRequest::Cancel(CancelRequest { session_id }),
                        );
                        let _ = maestro::acp::write_to_acp_session(&state, log_id, &cancel_msg).await;
                    }
                    // Give maestro-server time to forward CloseSessionRequest to agents.
                    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                    handle.exit(0);
                });
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        if let tauri::RunEvent::Exit = event {
            // We CANNOT use Handle::current().block_on() here: Tauri 2's event loop runs
            // inside the tokio runtime, so block_on panics ("cannot call block_on inside
            // an async context"). Use try_lock (synchronous, safe from any context) instead.
            let app_state = app_handle.state::<std::sync::Arc<AppState>>();

            // Release project lock so other instances can open this project immediately.
            app_state.release_active_project_lock();
        }
    });
}
