// Tauri build script marker
#![cfg_attr(all(not(debug_assertions), target_os = "windows"), windows_subsystem = "windows")]

use maestro::db::{init_db, AppState};
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

    let app_state = Arc::new(AppState::new(conn));

    // Mark stale running sessions as failed — PTY processes don't survive restarts
    {
        let db = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        let now = chrono::Utc::now().to_rfc3339();
        let count = db.execute(
            "UPDATE execution_logs SET status = 'failed', completed_at = ?1 WHERE status = 'running'",
            rusqlite::params![now],
        ).unwrap_or(0);
        let _ = count;
    }

    app.manage(app_state);

    Ok(())
}

fn main() {
    // Generate TypeScript bindings in debug builds
    let builder = maestro::create_builder();

    let app = tauri::Builder::default()
        .setup(setup)
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(builder.invoke_handler())
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        if let tauri::RunEvent::Exit = event {
            // Flush all live SSH PTY session histories to DB on app close.
            // This ensures sessions that are still running when the user quits
            // can be recovered as dead sessions on next launch.
            let app_state = app_handle.state::<std::sync::Arc<AppState>>();
            let rt = tokio::runtime::Handle::current();
            rt.block_on(async {
                // Phase 1: Collect snapshots from tokio Mutexes (async-safe)
                let sessions = app_state.ssh_pty_sessions.lock().await;
                if sessions.is_empty() {
                    return;
                }
                let mut snapshots: Vec<(i32, String)> = Vec::new();
                for (log_id, handle) in sessions.iter() {
                    // Flush all sessions — both live and process_ended — because a session
                    // may have ended while no reader was attached, leaving history in memory
                    // only (attach_terminal only persists on process_ended if it is the
                    // active reader at that moment).
                    let hist = handle.history.lock().await;
                    if !hist.is_empty() {
                        snapshots.push((*log_id, hist.clone()));
                    }
                }
                drop(sessions); // Release tokio Mutex before acquiring std::sync::Mutex

                // Phase 2: Write to DB — std::sync::Mutex only, no .await after this
                if snapshots.is_empty() {
                    return;
                }
                if let Ok(conn) = app_state.db.lock() {
                    for (log_id, snapshot) in &snapshots {
                        let _ = conn.execute(
                            "UPDATE execution_logs SET terminal_output = ?1 WHERE id = ?2",
                            rusqlite::params![snapshot, log_id],
                        );
                    }
                }
            });
        }
    });
}
