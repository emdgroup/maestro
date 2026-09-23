// Tauri build script marker
#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

use maestro_lib::core::{init_db, load_settings, logging, AppState};
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

/// Drop this instance's relays to the resident servers, before the app exits.
///
/// What is being dropped is `maestro-server attach`, one process per connection, whose only job is
/// to carry bytes between this app and the daemon. Without this they are orphaned:
/// `kill_on_drop(true)` only fires when the `Child` is dropped inside the runtime, and
/// `handle.exit(0)` drops neither map. Clearing them is exactly what `release_active_project_lock`
/// does when the user leaves a project.
///
/// The sessions those relays carried keep running, in a daemon this app never owned. Clearing
/// `acp.sessions` discards the host's bookkeeping for them and nothing else; the next run adopts
/// them back through `adopt_live_sessions`.
async fn stop_connection_servers(state: &Arc<AppState>) {
    state.acp.sessions.lock().await.clear();
    state.acp.connection_servers.lock().await.clear();
}

/// Setup hook for Tauri initialization
fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let app_data_dir = resolve_data_dir(app)?;
    let db_path = app_data_dir.join("maestro.db");

    // Initialize database — init_db returns Result<Connection, String>
    // Use map_err to convert String -> Box<dyn Error> since String doesn't impl Error
    let conn = init_db(db_path).map_err(|e| format!("Failed to initialize database: {}", e))?;

    // Settings drive the log level and directory, so this has to come before any logging.
    let settings = load_settings(&conn).unwrap_or_default();
    setup_logging(app, &settings);

    // The window is created decorated and stays hidden until the frontend calls `show()`, so
    // dropping the frame here costs no visible flash.
    maestro_lib::settings::handlers::apply_window_frame(app.handle(), settings.native_window_frame);

    // First lines of every log: the facts a bug report is useless without. The level and directory
    // are among them — they are user-settable, so a reader cannot assume the defaults. PATH is
    // there because local children inherit it: on macOS it is the only way to tell from a log
    // whether the bundle's LSEnvironment applied, and exactly /usr/bin:/bin:/usr/sbin:/sbin means
    // it did not.
    log::info!(
        "Maestro {} starting; data dir {}; PATH {}",
        env!("CARGO_PKG_VERSION"),
        app_data_dir.display(),
        std::env::var("PATH").unwrap_or_else(|_| "(unset)".to_string())
    );
    log::info!(
        "Logging at {} to {}",
        log::max_level(),
        logging::active_directory()
            .map(|directory| directory.display().to_string())
            .unwrap_or_else(|| "(disabled)".to_string())
    );

    // No-op unless this is an AppImage: gives the running window an icon the desktop can find.
    maestro_lib::core::desktop_entry::install_for_appimage();

    // A re-downloadable copy of files read over SFTP, keyed by a session id that does not outlive the
    // run, so nothing in it is worth keeping. Cleared here rather than when a session ends because
    // SSH sessions — the only ones that populate it — run on a shared connection server and have no
    // per-session reader loop to hang the delete off, and no teardown path runs after a crash.
    let cache_dir = app_data_dir.join("working_file_cache");
    match std::fs::remove_dir_all(&cache_dir) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => log::warn!("Could not clear {}: {error}", cache_dir.display()),
    }

    let app_state = Arc::new(AppState::new(
        conn,
        app.handle().clone(),
        app_data_dir.clone(),
    ));

    app.manage(app_state);

    Ok(())
}

fn main() {
    fix_path_env::fix().expect("failed to fix PATH");

    // The login entry "Start automatically" writes. After the PATH fix, which the server and the
    // agents it spawns inherit, and before anything that would open a window.
    let args: Vec<std::ffi::OsString> = std::env::args_os().collect();
    if args
        .get(1)
        .is_some_and(|arg| arg == maestro_lib::acp::server_control::START_SERVER_FLAG)
    {
        std::process::exit(maestro_lib::acp::server_control::start_server_at_login(
            args.get(2..).unwrap_or_default(),
        ));
    }

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
                // Prevent immediate close so the relays to the resident servers are dropped
                // cleanly rather than orphaned. Sessions are deliberately *not* cancelled here:
                // they run in a server that outlives this window, and the next run adopts them.
                api.prevent_close();
                let handle = window.app_handle().clone();
                tauri::async_runtime::spawn(async move {
                    let state = handle.state::<Arc<AppState>>();

                    // Block saves triggered by session events during shutdown — state.json was
                    // already written on the last spawn before close was requested.
                    state
                        .is_closing
                        .store(true, std::sync::atomic::Ordering::Relaxed);

                    stop_connection_servers(&state).await;
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
