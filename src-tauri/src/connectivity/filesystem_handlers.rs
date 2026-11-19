use serde::{Deserialize, Serialize};
use specta::Type;

use crate::connectivity::docker_handlers::run_blocking;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct FileEntry {
    pub name: String,
    pub is_dir: bool,
}

/// Read a local file's raw content as a base64-encoded string. Rejects files over
/// [`maestro_protocol::fs::BINARY_LIMIT`].
#[tauri::command]
#[specta::specta]
pub async fn read_local_file_binary(path: String) -> Result<String, String> {
    run_blocking(move || {
        match maestro_protocol::fs::apply(maestro_protocol::fs::FsOp::ReadBinary { path })? {
            maestro_protocol::fs::FsReply::Text(encoded) => Ok(encoded),
            other => Err(format!("unexpected reply to a file read: {other:?}")),
        }
    })
    .await
}

/// Get the default file picker path based on the current platform
#[tauri::command]
#[specta::specta]
pub fn get_default_file_picker_path() -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        // On Windows, default to C:/Users
        Ok("C:/Users".to_string())
    }

    #[cfg(target_os = "macos")]
    {
        // On macOS, default to /Users
        Ok("/Users".to_string())
    }

    #[cfg(target_os = "linux")]
    {
        // On Linux, default to /home
        Ok("/home".to_string())
    }
}

/// List available drives (Windows only)
#[tauri::command]
#[specta::specta]
pub async fn list_drives() -> Result<Vec<String>, String> {
    run_blocking(
        || match maestro_protocol::fs::apply(maestro_protocol::fs::FsOp::Drives)? {
            maestro_protocol::fs::FsReply::Names(drives) => Ok(drives),
            other => Err(format!("unexpected reply to a drive listing: {other:?}")),
        },
    )
    .await
}

#[tauri::command]
#[specta::specta]
pub fn open_path_native(app: tauri::AppHandle, path: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_path(path, None::<&str>)
        .map_err(|e| e.to_string())
}
