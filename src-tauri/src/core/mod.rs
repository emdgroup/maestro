pub mod connection;
pub mod logging;
pub mod project_storage;
pub mod schema;
pub mod settings;

pub use connection::{
    get_git_connection, get_project_with_git_conn, git_connection_for, init_db, AcpState, AppState,
    PtyState, SshState,
};
pub use project_storage::{read_maestro_json, write_maestro_file, write_maestro_json};
pub use schema::initialize_schema;
pub use settings::{load_settings, save_settings};

/// Emit a Tauri event, reporting a failure rather than dropping it.
///
/// An emit fails when the webview is gone or serialization broke. Neither is worth failing the
/// caller's operation over — the work is already done and the event only asks the UI to refetch —
/// but a dropped one leaves the interface showing stale state with no other trace, which is
/// exactly the kind of "the app just didn't update" report that cannot be diagnosed afterwards.
pub fn emit_or_log<S: serde::Serialize + Clone>(
    app_handle: &tauri::AppHandle,
    event: &str,
    payload: S,
) {
    use tauri::Emitter;
    if let Err(e) = app_handle.emit(event, payload) {
        log::warn!("Could not emit `{}`: {}", event, e);
    }
}
