// Tauri build script marker
#![cfg_attr(all(not(debug_assertions), target_os = "windows"), windows_subsystem = "windows")]

use maestro_lib::core::{init_db, load_settings, logging, AppState};
use maestro_protocol::{CancelRequest, MaestroRpcMessage, ServerRequest};
use std::sync::Arc;
use tauri::Manager;

/// Bring up logging from the stored settings.
///
/// A bundled app has no terminal attached, so anything written to stderr is discarded — the log
/// file is the only thing a user can send back with a bug report. Both the level and the directory
/// are user-settable, which is why this runs after the database is open rather than in the builder
/// chain.
///
/// A bad custom directory must not stop the app from starting, so it falls back to the OS location
/// and says so once logging is up.
fn setup_logging(app: &tauri::App, settings: &maestro_lib::models::AppSettings) {
    let level = logging::effective_level(settings.log_level.as_deref());
    let handle = app.handle();

    let configured = settings
        .log_directory
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());

    if let Some(custom) = configured {
        match logging::install(handle, std::path::Path::new(custom), level) {
            Ok(()) => return,
            Err(error) => {
                if install_default_logging(handle, level) {
                    log::error!("Log directory {custom} is unusable, using the default: {error}");
                } else {
                    // Nowhere left to report this — logging itself is what failed, and in a
                    // bundled app stderr goes nowhere, which is the situation being reported.
                    eprintln!("Logging is disabled: {error}");
                }
                return;
            }
        }
    }

    if !install_default_logging(handle, level) {
        eprintln!("Logging is disabled: the default log directory could not be opened");
    }
}

fn install_default_logging(handle: &tauri::AppHandle, level: log::LevelFilter) -> bool {
    logging::current_log_dir(handle, None)
        .and_then(|directory| logging::install(handle, &directory, level))
        .is_ok()
}

/// Where the database, the project locks and the rest of the app's own state live.
///
/// `MAESTRO_DATA_DIR` overrides the OS location so a development build can be pointed away from
/// the installed app's data. Without it, every checkout shares one `maestro.db`: a worktree
/// carrying a schema migration upgrades that file, and every other build then refuses to open it,
/// because a database is only readable by the version that wrote it or newer. The same collision
/// happens over `locks/`, where a dev build and the installed app fight for the same project.
///
/// A blank value is treated as unset, matching `logging::resolve_log_dir` — an empty string used
/// as a path would put the database in the process working directory.
fn resolve_data_dir(app: &tauri::App) -> Result<std::path::PathBuf, String> {
    if let Some(custom) = std::env::var("MAESTRO_DATA_DIR")
        .ok()
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let dir = std::path::PathBuf::from(custom);
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("MAESTRO_DATA_DIR {custom} is unusable: {e}"))?;
        return Ok(dir);
    }

    app.path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))
}

/// Setup hook for Tauri initialization
fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let app_data_dir = resolve_data_dir(app)?;
    let db_path = app_data_dir.join("maestro.db");

    // Initialize database — init_db returns Result<Connection, String>
    // Use map_err to convert String -> Box<dyn Error> since String doesn't impl Error
    let conn = init_db(db_path)
        .map_err(|e| format!("Failed to initialize database: {}", e))?;

    // Settings drive the log level and directory, so this has to come before any logging.
    let settings = load_settings(&conn).unwrap_or_default();
    setup_logging(app, &settings);

    // The window is created decorated and stays hidden until the frontend calls `show()`, so
    // dropping the frame here costs no visible flash.
    maestro_lib::settings::handlers::apply_window_frame(app.handle(), settings.native_window_frame);

    // First lines of every log: the facts a bug report is useless without. The level and directory
    // are among them — they are user-settable, so a reader cannot assume the defaults.
    log::info!(
        "Maestro {} starting; data dir {}",
        env!("CARGO_PKG_VERSION"),
        app_data_dir.display()
    );
    log::info!(
        "Logging at {} to {}",
        log::max_level(),
        logging::active_directory()
            .map(|directory| directory.display().to_string())
            .unwrap_or_else(|| "(disabled)".to_string())
    );

    // A re-downloadable copy of files read over SFTP, keyed by a log_id that does not outlive the
    // run, so nothing in it is worth keeping. Cleared here rather than when a session ends because
    // SSH sessions — the only ones that populate it — run on a shared connection server and have no
    // per-session reader loop to hang the delete off, and no teardown path runs after a crash.
    let cache_dir = app_data_dir.join("working_file_cache");
    match std::fs::remove_dir_all(&cache_dir) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => log::warn!("Could not clear {}: {error}", cache_dir.display()),
    }

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
        // The log plugin is not here: its level and directory come from the settings table, so it
        // is installed from `setup` once the database is open. See `setup_logging`.
        .setup(setup)
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
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
