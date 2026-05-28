use std::path::PathBuf;
use tauri::{AppHandle, Manager};

pub fn resolve_server_path(app_handle: &AppHandle) -> Result<PathBuf, String> {
    let bin_name = if cfg!(target_os = "windows") {
        "maestro-server.exe"
    } else {
        "maestro-server"
    };

    if let Ok(dir) = app_handle.path().resource_dir() {
        let p = dir.join(bin_name);
        if p.exists() {
            return Ok(p);
        }
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let p = dir.join(bin_name);
            if p.exists() {
                return Ok(p);
            }
        }
    }

    which::which("maestro-server")
        .map_err(|e| format!("maestro-server not found: {}", e))
}

