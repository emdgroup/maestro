use std::path::Path;

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::AppHandle;
use tauri::Emitter;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::connectivity::ssh::{RemoteSshSession, SshError};

const TRANSFER_CHUNK_SIZE: usize = 32 * 1024;

#[derive(Clone, Serialize, Deserialize, Type)]
pub struct FileTransferProgress {
    pub transfer_id: String,
    pub bytes_transferred: u64,
    pub total_bytes: u64,
    pub direction: TransferDirection,
}

#[derive(Clone, Serialize, Deserialize, Type)]
pub enum TransferDirection {
    Upload,
    Download,
}

/// Upload a local file to the remote host via SFTP with progress reporting.
///
/// Emits `sftp://transfer-progress/{transfer_id}` events per chunk.
pub async fn upload_file(
    session: &RemoteSshSession,
    local_path: &Path,
    remote_path: &str,
    transfer_id: &str,
    app_handle: &AppHandle,
) -> Result<u64, SshError> {
    let metadata = tokio::fs::metadata(local_path).await.map_err(|e| {
        SshError::PermissionError(format!(
            "Cannot read local file '{}': {}",
            local_path.display(),
            e
        ))
    })?;
    let total_bytes = metadata.len();

    let mut local_file = tokio::fs::File::open(local_path).await.map_err(|e| {
        SshError::PermissionError(format!(
            "Failed to open local file '{}': {}",
            local_path.display(),
            e
        ))
    })?;

    let sftp = session.open_sftp_session().await?;
    let mut remote_file = sftp.create(remote_path).await.map_err(|e| {
        SshError::PermissionError(format!(
            "Failed to create remote file '{}': {}",
            remote_path, e
        ))
    })?;

    let mut bytes_transferred: u64 = 0;
    let mut buffer = vec![0u8; TRANSFER_CHUNK_SIZE];

    loop {
        let bytes_read = local_file.read(&mut buffer).await.map_err(|e| {
            SshError::ConnectionError(format!("Local read failed: {}", e))
        })?;

        if bytes_read == 0 {
            break;
        }

        remote_file
            .write_all(&buffer[..bytes_read])
            .await
            .map_err(|e| SshError::ConnectionError(format!("Remote write failed: {}", e)))?;

        bytes_transferred += bytes_read as u64;

        let _ = app_handle.emit(
            &format!("sftp://transfer-progress/{}", transfer_id),
            FileTransferProgress {
                transfer_id: transfer_id.to_string(),
                bytes_transferred,
                total_bytes,
                direction: TransferDirection::Upload,
            },
        );
    }

    remote_file
        .flush()
        .await
        .map_err(|e| SshError::ConnectionError(format!("Remote flush failed: {}", e)))?;
    remote_file
        .shutdown()
        .await
        .map_err(|e| SshError::ConnectionError(format!("Remote shutdown failed: {}", e)))?;

    Ok(bytes_transferred)
}

/// Download a remote file to the local filesystem via SFTP with progress reporting.
///
/// Emits `sftp://transfer-progress/{transfer_id}` events per chunk.
pub async fn download_file(
    session: &RemoteSshSession,
    remote_path: &str,
    local_path: &Path,
    transfer_id: &str,
    app_handle: &AppHandle,
) -> Result<u64, SshError> {
    let sftp = session.open_sftp_session().await?;

    let remote_metadata = sftp.metadata(remote_path).await.map_err(|e| {
        SshError::ConnectionError(format!("Failed to stat remote file '{}': {}", remote_path, e))
    })?;
    let total_bytes = remote_metadata.size.unwrap_or(0);

    let mut remote_file = sftp.open(remote_path).await.map_err(|e| {
        SshError::PermissionError(format!(
            "Failed to open remote file '{}': {}",
            remote_path, e
        ))
    })?;

    if let Some(parent) = local_path.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(|e| {
            SshError::PermissionError(format!(
                "Cannot create local directory '{}': {}",
                parent.display(),
                e
            ))
        })?;
    }

    let mut local_file = tokio::fs::File::create(local_path).await.map_err(|e| {
        SshError::PermissionError(format!(
            "Failed to create local file '{}': {}",
            local_path.display(),
            e
        ))
    })?;

    let mut bytes_transferred: u64 = 0;
    let mut buffer = vec![0u8; TRANSFER_CHUNK_SIZE];

    loop {
        let bytes_read = remote_file.read(&mut buffer).await.map_err(|e| {
            SshError::ConnectionError(format!("Remote read failed: {}", e))
        })?;

        if bytes_read == 0 {
            break;
        }

        local_file
            .write_all(&buffer[..bytes_read])
            .await
            .map_err(|e| SshError::PermissionError(format!("Local write failed: {}", e)))?;

        bytes_transferred += bytes_read as u64;

        let _ = app_handle.emit(
            &format!("sftp://transfer-progress/{}", transfer_id),
            FileTransferProgress {
                transfer_id: transfer_id.to_string(),
                bytes_transferred,
                total_bytes,
                direction: TransferDirection::Download,
            },
        );
    }

    local_file
        .flush()
        .await
        .map_err(|e| SshError::PermissionError(format!("Local flush failed: {}", e)))?;

    Ok(bytes_transferred)
}
