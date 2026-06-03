use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::State;

use crate::core::AppState;
use crate::connectivity::ssh::sftp;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct FileTransferResult {
    pub transfer_id: String,
    pub bytes_transferred: f64,
}

/// Upload a local file to the remote host via SFTP.
///
/// Progress events emitted on `sftp://transfer-progress/{transfer_id}` during transfer.
#[tauri::command]
#[specta::specta]
pub async fn sftp_upload(
    app_state: State<'_, Arc<AppState>>,
    connection_id: i32,
    local_path: String,
    remote_path: String,
    transfer_id: String,
) -> Result<FileTransferResult, String> {
    let session = app_state
        .ssh.get_session(connection_id)
        .await
        .ok_or_else(|| format!("No active SSH session for connection {}", connection_id))?;

    let local = PathBuf::from(&local_path);
    if !local.exists() {
        return Err(format!("Local file not found: {}", local_path));
    }

    let bytes_transferred = sftp::upload_file(
        &session,
        &local,
        &remote_path,
        &transfer_id,
        &app_state.app_handle,
    )
    .await
    .map_err(|e| e.to_string())?;

    Ok(FileTransferResult {
        transfer_id,
        bytes_transferred: bytes_transferred as f64,
    })
}

/// Download a remote file to the local filesystem via SFTP.
///
/// Progress events emitted on `sftp://transfer-progress/{transfer_id}` during transfer.
#[tauri::command]
#[specta::specta]
pub async fn sftp_download(
    app_state: State<'_, Arc<AppState>>,
    connection_id: i32,
    remote_path: String,
    local_path: String,
    transfer_id: String,
) -> Result<FileTransferResult, String> {
    let session = app_state
        .ssh.get_session(connection_id)
        .await
        .ok_or_else(|| format!("No active SSH session for connection {}", connection_id))?;

    let local = PathBuf::from(&local_path);

    let bytes_transferred = sftp::download_file(
        &session,
        &remote_path,
        &local,
        &transfer_id,
        &app_state.app_handle,
    )
    .await
    .map_err(|e| e.to_string())?;

    Ok(FileTransferResult {
        transfer_id,
        bytes_transferred: bytes_transferred as f64,
    })
}
