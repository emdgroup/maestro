//! External file attachment preparation for ACP sessions.

use std::sync::Arc;
use tauri::State;
use serde::{Deserialize, Serialize};
use specta::Type;
use crate::core::AppState;
use crate::acp::ConnectionKey;

const MAX_IMAGE_BYTES: u64 = 10 * 1024 * 1024;
const SCALE_THRESHOLD_BYTES: u64 = 5 * 1024 * 1024;

fn prepare_image_bytes(bytes: Vec<u8>) -> Result<Vec<u8>, String> {
    let size = bytes.len() as u64;
    if size > MAX_IMAGE_BYTES {
        return Err(format!(
            "Image too large ({} MB, max 10 MB)",
            size / 1_048_576
        ));
    }
    if size <= SCALE_THRESHOLD_BYTES {
        return Ok(bytes);
    }

    let ratio = (SCALE_THRESHOLD_BYTES as f64 / size as f64).sqrt();
    if ratio >= 0.9 {
        return Ok(bytes);
    }

    let img = image::load_from_memory(&bytes).map_err(|e| e.to_string())?;
    let new_w = (img.width() as f64 * ratio) as u32;
    let new_h = (img.height() as f64 * ratio) as u32;
    let resized = img.resize(new_w, new_h, image::imageops::FilterType::Triangle);

    let mut output = Vec::new();
    resized
        .write_to(
            &mut std::io::Cursor::new(&mut output),
            image::ImageFormat::Png,
        )
        .map_err(|e| e.to_string())?;
    Ok(output)
}

fn mime_for_extension(path: &str) -> Option<&'static str> {
    let ext = std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    match ext.as_str() {
        "rs" => Some("text/x-rust"),
        "ts" | "tsx" => Some("text/typescript"),
        "js" | "jsx" => Some("text/javascript"),
        "py" => Some("text/x-python"),
        "go" => Some("text/x-go"),
        "rb" => Some("text/x-ruby"),
        "java" => Some("text/x-java"),
        "c" | "h" => Some("text/x-c"),
        "cpp" => Some("text/x-c++"),
        "toml" => Some("text/x-toml"),
        "json" => Some("application/json"),
        "md" => Some("text/markdown"),
        "yaml" | "yml" => Some("text/yaml"),
        "sh" => Some("text/x-sh"),
        "html" => Some("text/html"),
        "css" => Some("text/css"),
        "sql" => Some("text/x-sql"),
        "graphql" => Some("text/x-graphql"),
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "svg" => Some("image/svg+xml"),
        "pdf" => Some("application/pdf"),
        _ => None,
    }
}

fn is_image_extension(path: &str) -> bool {
    let ext = std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    matches!(
        ext.as_str(),
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "tiff" | "bmp" | "ico" | "svg"
    )
}

fn is_pdf_extension(path: &str) -> bool {
    std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("pdf"))
        .unwrap_or(false)
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct ExternalFileRequest {
    pub path: String,
    pub is_image: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct PreparedAttachment {
    pub display_name: String,
    pub local_path: String,
    pub content_block: serde_json::Value,
}

#[tauri::command]
#[specta::specta]
pub async fn prepare_external_attachments(
    app_state: State<'_, Arc<AppState>>,
    log_id: i32,
    files: Vec<ExternalFileRequest>,
    embedded_context: bool,
) -> Result<Vec<PreparedAttachment>, String> {
    let (cwd, connection_key) = {
        let sessions = app_state.acp.sessions.lock().await;
        let s = sessions
            .get(&log_id)
            .ok_or_else(|| format!("No ACP session for log_id {log_id}"))?;
        (s.cwd.clone(), s.connection_key)
    };

    let mut results = Vec::with_capacity(files.len());

    for file in files {
        let local_path = std::path::Path::new(&file.path);
        let display_name = local_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(&file.path)
            .to_string();

        let content_block = if file.is_image || is_image_extension(&file.path) {
            let bytes = tokio::fs::read(local_path)
                .await
                .map_err(|e| format!("Cannot read '{}': {e}", file.path))?;
            let prepared = prepare_image_bytes(bytes)?;
            let mime = mime_for_extension(&file.path)
                .unwrap_or("image/png")
                .to_string();
            use base64::Engine;
            let data = base64::engine::general_purpose::STANDARD.encode(&prepared);
            let uri = format!("file://{}", file.path);
            serde_json::json!({
                "type": "image",
                "data": data,
                "mimeType": mime,
                "uri": uri,
            })
        } else {
            let mime = mime_for_extension(&file.path)
                .map(str::to_string);

            let uri = match &connection_key {
                ConnectionKey::Ssh { id: conn_id } => {
                    let conn_id = *conn_id;
                    let session = app_state
                        .ssh
                        .get_session(conn_id)
                        .await
                        .ok_or_else(|| format!("No active SSH session for connection {conn_id}"))?;

                    let attachments_dir = format!(
                        "{}/.maestro/attachments/{}",
                        cwd.trim_end_matches('/'),
                        log_id
                    );
                    session
                        .execute_command(&format!("mkdir -p '{attachments_dir}'"))
                        .await
                        .map_err(|e| format!("Failed to create attachments dir: {e}"))?;

                    let remote_path = format!("{attachments_dir}/{display_name}");
                    let transfer_id = format!("attach-{log_id}-{display_name}");
                    crate::connectivity::ssh::sftp::upload_file(
                        &session,
                        local_path,
                        &remote_path,
                        &transfer_id,
                        &app_state.app_handle,
                    )
                    .await
                    .map_err(|e| e.to_string())?;

                    format!("file://{remote_path}")
                }
                _ => format!("file://{}", file.path),
            };

            if embedded_context && !is_pdf_extension(&file.path) {
                let text = tokio::fs::read_to_string(local_path)
                    .await
                    .map_err(|e| format!("Cannot read '{}': {e}", file.path))?;
                let mut resource = serde_json::json!({
                    "uri": uri,
                    "text": text,
                });
                if let Some(m) = mime {
                    resource["mimeType"] = serde_json::Value::String(m);
                }
                serde_json::json!({
                    "type": "resource",
                    "resource": resource,
                })
            } else {
                let metadata = tokio::fs::metadata(local_path).await.ok();
                let size = metadata.map(|m| m.len());
                let mut block = serde_json::json!({
                    "type": "resource_link",
                    "name": display_name,
                    "uri": uri,
                });
                if let Some(m) = mime {
                    block["mimeType"] = serde_json::Value::String(m);
                }
                if let Some(s) = size {
                    block["size"] = serde_json::Value::Number(s.into());
                }
                block
            }
        };

        results.push(PreparedAttachment {
            display_name,
            local_path: file.path,
            content_block,
        });
    }

    Ok(results)
}

#[tauri::command]
#[specta::specta]
pub async fn save_clipboard_image(
    base64_data: String,
    mime_type: String,
) -> Result<String, String> {
    use base64::Engine;

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&base64_data)
        .map_err(|e| format!("Invalid base64 data: {e}"))?;

    if bytes.is_empty() {
        return Err("Empty image data".to_string());
    }

    let ext = match mime_type.as_str() {
        "image/png" => "png",
        "image/jpeg" | "image/jpg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/bmp" => "bmp",
        "image/svg+xml" => "svg",
        _ => "png",
    };

    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let random_suffix: u32 = rand::random();

    let tmp_path = std::env::temp_dir()
        .join(format!("maestro-clipboard-{timestamp}-{random_suffix}.{ext}"));

    tokio::fs::write(&tmp_path, &bytes)
        .await
        .map_err(|e| format!("Failed to write temp file: {e}"))?;

    Ok(tmp_path.to_string_lossy().to_string())
}
