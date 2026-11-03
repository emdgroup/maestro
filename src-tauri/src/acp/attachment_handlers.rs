//! External file attachment preparation for ACP sessions.

use crate::acp::ConnectionKey;
use crate::connectivity::GitConnection;
use crate::core::AppState;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::sync::Arc;
use tauri::State;

use maestro_protocol::attachments::{
    image_too_large, is_image_extension, is_pdf_extension, mime_for_extension, scale_image,
};

fn prepare_image_bytes(bytes: Vec<u8>) -> Result<Vec<u8>, String> {
    if let Some(reason) = image_too_large(bytes.len() as u64) {
        return Err(reason);
    }
    scale_image(bytes)
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct ExternalFileRequest {
    pub path: String,
    pub is_image: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct AttachmentValidation {
    pub size_bytes: u64,
    /// `None` when the file can be attached. Otherwise the reason to show the user, phrased for
    /// them rather than for a log.
    pub rejection: Option<String>,
}

/// Check a file against the limits [`prepare_external_attachments`] enforces, reading only its
/// metadata. Lets the compose bar reject a file the moment it is picked instead of on send, without
/// the limits having to be restated on the TypeScript side.
#[tauri::command]
#[specta::specta]
pub async fn validate_attachment(
    path: String,
    is_image: bool,
) -> Result<AttachmentValidation, String> {
    let metadata = tokio::fs::metadata(&path)
        .await
        .map_err(|e| format!("Cannot read '{path}': {e}"))?;
    let size_bytes = metadata.len();

    let rejection = if is_image || is_image_extension(&path) {
        image_too_large(size_bytes)
    } else {
        None
    };

    Ok(AttachmentValidation {
        size_bytes,
        rejection,
    })
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct PreparedAttachment {
    pub display_name: String,
    pub local_path: String,
    pub content_block: serde_json::Value,
}

/// Where an attachment lands on the far side. Shared by every connection type so an agent finds
/// attachments in one place however the project is reached.
fn attachments_dir(cwd: &str, session_id: &str) -> String {
    format!(
        "{}/.maestro/attachments/{}",
        cwd.trim_end_matches('/'),
        session_id
    )
}

/// The prompt block for a task attachment at `path` on the project's machine, in the shape
/// [`prepare_external_attachments`] gives a file picked in the compose bar: an image inline, text
/// pasted in, a PDF linked. The bytes are read where the project lives, since that is where the
/// copy is. `Err` is the reason the file cannot be sent, phrased for the user.
pub(crate) async fn task_attachment_block(
    conn: &GitConnection,
    path: &str,
    size_bytes: i64,
) -> Result<serde_json::Value, String> {
    use base64::Engine;
    let uri = format!("file://{path}");

    if is_image_extension(path) {
        let size = u64::try_from(size_bytes).unwrap_or(0);
        if let Some(reason) = image_too_large(size) {
            return Err(reason);
        }
        let prepared = prepare_image_bytes(read_bytes(conn, path).await?)?;
        let mime = mime_for_extension(path).unwrap_or("image/png");
        return Ok(serde_json::json!({
            "type": "image",
            "data": base64::engine::general_purpose::STANDARD.encode(&prepared),
            "mimeType": mime,
            "uri": uri,
        }));
    }

    let mime = mime_for_extension(path);
    if is_pdf_extension(path) {
        let name = path.rsplit(['/', '\\']).next().unwrap_or(path);
        let mut block = serde_json::json!({
            "type": "resource_link",
            "name": name,
            "uri": uri,
        });
        if let Some(m) = mime {
            block["mimeType"] = m.into();
        }
        if size_bytes >= 0 {
            block["size"] = size_bytes.into();
        }
        return Ok(block);
    }

    let text = String::from_utf8(read_bytes(conn, path).await?)
        .map_err(|e| format!("Cannot read '{path}': {e}"))?;
    let mut resource = serde_json::json!({
        "uri": uri,
        "text": text,
    });
    if let Some(m) = mime {
        resource["mimeType"] = m.into();
    }
    Ok(serde_json::json!({
        "type": "resource",
        "resource": resource,
    }))
}

/// A file's bytes on the connection's machine: read in place locally, through the connection's
/// shell otherwise, capped at [`crate::connectivity::files::BINARY_LIMIT`].
async fn read_bytes(conn: &GitConnection, path: &str) -> Result<Vec<u8>, String> {
    use base64::Engine;
    let encoded = crate::connectivity::files::read_binary(conn, path)
        .await
        .map_err(|e| format!("Cannot read '{path}': {e}"))?;
    base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|e| format!("Cannot read '{path}': {e}"))
}

#[tauri::command]
#[specta::specta]
pub async fn prepare_external_attachments(
    app_state: State<'_, Arc<AppState>>,
    session_id: &str,
    files: Vec<ExternalFileRequest>,
    embedded_context: bool,
) -> Result<Vec<PreparedAttachment>, String> {
    let (cwd, connection_key) = {
        let sessions = app_state.acp.sessions.lock().await;
        let s = sessions
            .get(session_id)
            .ok_or_else(|| format!("No ACP session for session_id {session_id}"))?;
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
            let mime = mime_for_extension(&file.path).map(str::to_string);

            // The picker returns a host path, which an agent running anywhere but the host cannot
            // open. Every non-local connection needs the file moved to a path that means
            // something on its side.
            let uri = if matches!(connection_key, ConnectionKey::Local) {
                format!("file://{}", file.path)
            } else {
                let conn = crate::core::git_connection_for(&app_state, cwd.clone(), connection_key)
                    .await?;
                let dir = attachments_dir(&cwd, session_id);
                let dest = format!("{dir}/{display_name}");
                crate::connectivity::files::copy_to_machine(
                    &app_state, &conn, local_path, &dir, &dest,
                )
                .await?;
                format!("file://{dest}")
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

    let tmp_path = std::env::temp_dir().join(format!(
        "maestro-clipboard-{timestamp}-{random_suffix}.{ext}"
    ));

    tokio::fs::write(&tmp_path, &bytes)
        .await
        .map_err(|e| format!("Failed to write temp file: {e}"))?;

    Ok(tmp_path.to_string_lossy().to_string())
}
