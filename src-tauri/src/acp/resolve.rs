use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// Return the path to a locally-available maestro-server binary.
/// Checks the app data dir cache (populated by ensure_local_server) first,
/// then falls back to a sibling of the current exe and PATH for dev builds.
pub fn resolve_server_path(app_handle: &AppHandle) -> Result<PathBuf, String> {
    let bin_name = crate::acp::deploy::asset_filename(crate::acp::HOST_TRIPLE);

    if let Ok(data_dir) = app_handle.path().app_data_dir() {
        let p = data_dir.join("bin").join(&bin_name);
        if p.exists() {
            return Ok(p);
        }
    }

    // Dev fallback: sibling of the current executable (e.g. cargo run target dir)
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let p = dir.join("maestro-server");
            if p.exists() {
                return Ok(p);
            }
        }
    }

    which::which("maestro-server")
        .map_err(|e| format!("maestro-server not found: {}", e))
}
