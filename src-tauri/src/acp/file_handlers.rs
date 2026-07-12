use std::sync::Arc;
use std::time::Duration;
use tauri::State;
use tokio::sync::oneshot;

use crate::core::AppState;
use crate::acp::ConnectionKey;
use crate::acp::transport::{MaestroRpcMessage, ServerRequest, FileSearchRequest, FileReadRequest};

/// Send a request to a session and await a oneshot response with a 15-second timeout.
async fn session_file_rpc<T>(
    app_state: &AppState,
    log_id: i32,
    pending_field: impl Fn(&crate::acp::AcpProcess) -> &Arc<std::sync::Mutex<Option<oneshot::Sender<Result<T, String>>>>>,
    build_request: impl FnOnce(&str) -> MaestroRpcMessage,
) -> Result<T, String> {
    let (cwd, pending) = {
        let sessions = app_state.acp.sessions.lock().await;
        let s = sessions
            .get(&log_id)
            .ok_or_else(|| format!("No ACP session for log_id {log_id}"))?;
        (s.cwd.clone(), Arc::clone(pending_field(s)))
    };
    let (tx, rx) = oneshot::channel();
    {
        *pending.lock().map_err(|_| "pending channel lock poisoned".to_string())? = Some(tx);
    }
    crate::acp::write_to_acp_session(app_state, log_id, &build_request(&cwd)).await?;
    tokio::time::timeout(Duration::from_secs(15), rx)
        .await
        .map_err(|_| "File operation timed out".to_string())?
        .map_err(|_| "File operation response channel closed".to_string())?
}

#[tauri::command]
#[specta::specta]
pub async fn search_session_files(
    app_state: State<'_, Arc<AppState>>,
    log_id: i32,
    query: String,
    limit: Option<u32>,
) -> Result<Vec<String>, String> {
    session_file_rpc(&app_state, log_id, |s| &s.pending_file_search, |cwd| {
        MaestroRpcMessage::Request(ServerRequest::FileSearch(FileSearchRequest {
            cwd: cwd.to_string(),
            query,
            limit,
        }))
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn read_session_file(
    app_state: State<'_, Arc<AppState>>,
    log_id: i32,
    relative_path: String,
) -> Result<String, String> {
    session_file_rpc(&app_state, log_id, |s| &s.pending_file_read, |cwd| {
        MaestroRpcMessage::Request(ServerRequest::FileRead(FileReadRequest {
            cwd: cwd.to_string(),
            relative_path,
        }))
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn read_session_file_binary(
    app_state: State<'_, Arc<AppState>>,
    log_id: i32,
    relative_path: String,
) -> Result<String, String> {
    if relative_path.starts_with('/') || relative_path.contains("..") {
        return Err("Invalid path: must be relative and contain no '..'".to_string());
    }

    let (cwd, connection_key) = {
        let sessions = app_state.acp.sessions.lock().await;
        let s = sessions
            .get(&log_id)
            .ok_or_else(|| format!("No ACP session for log_id {log_id}"))?;
        (s.cwd.clone(), s.connection_key)
    };

    const MAX_BINARY_SIZE: u64 = 5 * 1024 * 1024;

    let bytes = match connection_key {
        ConnectionKey::Local => {
            let full_path = std::path::Path::new(&cwd).join(&relative_path);
            let metadata = tokio::fs::metadata(&full_path)
                .await
                .map_err(|e| format!("Cannot stat file: {e}"))?;
            if metadata.len() > MAX_BINARY_SIZE {
                return Err(format!("File too large ({} bytes, max 5 MB)", metadata.len()));
            }
            tokio::fs::read(&full_path)
                .await
                .map_err(|e| format!("Cannot read file: {e}"))?
        }
        ConnectionKey::Wsl { id: wsl_id } => {
            let distro = {
                let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {e}"))?;
                conn.query_row(
                    "SELECT distro_name FROM wsl_connections WHERE id = ?",
                    [wsl_id],
                    |row| row.get::<_, String>(0),
                ).map_err(|e| format!("WSL connection {wsl_id} not found: {e}"))?
            };
            let linux_path = format!("{}/{}", cwd, relative_path);
            let unc_path = format!(r"\\wsl$\{}\{}", distro, linux_path.trim_start_matches('/'));
            let full_path = std::path::Path::new(&unc_path);
            let metadata = tokio::fs::metadata(full_path)
                .await
                .map_err(|e| format!("Cannot stat file: {e}"))?;
            if metadata.len() > MAX_BINARY_SIZE {
                return Err(format!("File too large ({} bytes, max 5 MB)", metadata.len()));
            }
            tokio::fs::read(full_path)
                .await
                .map_err(|e| format!("Cannot read file: {e}"))?
        }
        ConnectionKey::Ssh { id: conn_id } => {
            let cache_dir = app_state.app_data_dir
                .join("working_file_cache")
                .join(log_id.to_string());

            let path_hash = {
                use std::hash::{Hash, Hasher};
                let mut h = std::collections::hash_map::DefaultHasher::new();
                relative_path.hash(&mut h);
                h.finish()
            };
            let ext = std::path::Path::new(&relative_path)
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("bin");
            let cache_path = cache_dir.join(format!("{path_hash}.{ext}"));

            if cache_path.exists() {
                tokio::fs::read(&cache_path)
                    .await
                    .map_err(|e| format!("Cannot read cached file: {e}"))?
            } else {
                let session = app_state
                    .ssh
                    .get_session(conn_id)
                    .await
                    .ok_or_else(|| format!("No active SSH session for connection {conn_id}"))?;
                let remote_path = format!("{}/{}", cwd.trim_end_matches('/'), relative_path);
                tokio::fs::create_dir_all(&cache_dir)
                    .await
                    .map_err(|e| format!("Cannot create cache directory: {e}"))?;
                let transfer_id = format!("working-file-{log_id}-{path_hash}");
                crate::connectivity::ssh::sftp::download_file(
                    &session,
                    &remote_path,
                    &cache_path,
                    &transfer_id,
                    &app_state.app_handle,
                )
                .await
                .map_err(|e| e.to_string())?;

                let downloaded_size = tokio::fs::metadata(&cache_path)
                    .await
                    .map(|m| m.len())
                    .unwrap_or(0);
                if downloaded_size > MAX_BINARY_SIZE {
                    let _ = tokio::fs::remove_file(&cache_path).await;
                    return Err(format!("File too large ({downloaded_size} bytes, max 5 MB)"));
                }
                tokio::fs::read(&cache_path)
                    .await
                    .map_err(|e| format!("Cannot read downloaded file: {e}"))?
            }
        }
        ConnectionKey::Docker { id: docker_id } => {
            let (container_name, path_in_container) = {
                let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {e}"))?;
                let container_name: String = conn.query_row(
                    "SELECT container_name FROM docker_connections WHERE id = ?",
                    [docker_id],
                    |row| row.get(0),
                ).map_err(|e| format!("Docker connection {docker_id} not found: {e}"))?;
                (container_name, format!("{}/{}", cwd, relative_path))
            };
            let cli = crate::connectivity::docker::ContainerCli::detect()
                .unwrap_or(crate::connectivity::docker::ContainerCli::Docker);
            let b64 = crate::connectivity::docker::read_file_binary(&cli, &container_name, &path_in_container)
                .map_err(|e| format!("Cannot read file from container: {e}"))?;
            use base64::Engine;
            base64::engine::general_purpose::STANDARD.decode(b64.trim())
                .map_err(|e| format!("Base64 decode failed: {e}"))?
        }
    };

    use base64::Engine;
    Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
}
