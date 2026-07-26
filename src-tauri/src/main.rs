// Tauri build script marker
#![cfg_attr(all(not(debug_assertions), target_os = "windows"), windows_subsystem = "windows")]

use maestro_lib::core::{init_db, AppState};
use maestro_protocol::{CancelRequest, MaestroRpcMessage, ServerRequest};
use std::sync::Arc;
use tauri::Manager;
use tauri_plugin_log::{RotationStrategy, Target, TargetKind};

/// A bundled app has no terminal attached, so anything written to stderr is discarded — which is
/// why a log file exists at all: it is the only thing a user can send back with a bug report.
///
/// The level is deliberately conservative. `trace` carries the raw ACP frames, and those contain
/// prompt text, agent output and the contents of files the agent read, so it stays off unless
/// someone sets `MAESTRO_LOG` for a debugging session.
fn log_plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    let level = std::env::var("MAESTRO_LOG")
        .ok()
        .and_then(|requested| requested.parse::<log::LevelFilter>().ok())
        .unwrap_or(log::LevelFilter::Info);

    tauri_plugin_log::Builder::new()
        // The default targets are stdout plus the log directory; stderr is the conventional
        // stream for diagnostics and keeps stdout free for anything that needs to pipe.
        .clear_targets()
        .target(Target::new(TargetKind::Stderr))
        .target(Target::new(TargetKind::LogDir { file_name: None }))
        // Dependencies only get a say when something is wrong. At debug they are a firehose —
        // keyring narrates every credential lookup, rustls every handshake, the updater dumps the
        // whole release manifest — and `MAESTRO_LOG=debug` would bury our own lines in it.
        .level(log::LevelFilter::Warn)
        .level_for("maestro", level)
        .level_for("maestro_lib", level)
        // The plugin defaults to a 40 KB file and keeps one. At trace level that truncates to
        // the last few seconds, which is useless for the session that produced a bug.
        .max_file_size(5 * 1024 * 1024)
        .rotation_strategy(RotationStrategy::KeepSome(2))
        .build()
}

/// Setup hook for Tauri initialization
fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let app_data_dir = app.path().app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))?;
    // First line of every log: the two facts a bug report is useless without.
    log::info!(
        "Maestro {} starting; data dir {}",
        env!("CARGO_PKG_VERSION"),
        app_data_dir.display()
    );

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
    let builder = maestro_lib::create_builder();

    let tauri_builder = tauri::Builder::default();

    // Only present in `--features wdio` builds; a shipped binary must not expose an automation
    // server that can drive the UI and reach every IPC command.
    #[cfg(feature = "wdio")]
    let tauri_builder = tauri_builder.plugin(tauri_plugin_wdio_webdriver::init());

    let app = tauri_builder
        // Registered first so failures in the plugins and setup below are captured.
        .plugin(log_plugin())
        .setup(setup)
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
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

                    // Block saves triggered by session cancel events during shutdown — state.json
                    // was already written on the last spawn/cancel before close was requested.
                    state.is_closing.store(true, std::sync::atomic::Ordering::Relaxed);

                    let session_keys: Vec<i32> = state.acp.sessions.lock().await.keys().copied().collect();
                    for log_id in session_keys {
                        let session_id = format!("session-{}", log_id);
                        let cancel_msg = MaestroRpcMessage::Request(
                            ServerRequest::Cancel(CancelRequest { session_id }),
                        );
                        let _ = maestro_lib::acp::write_to_acp_session(&state, log_id, &cancel_msg).await;
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
