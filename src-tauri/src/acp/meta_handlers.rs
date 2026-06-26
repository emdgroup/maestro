use std::sync::Arc;
use tauri::State;
use tauri::Emitter;
use serde::{Deserialize, Serialize};
use specta::Type;

use crate::core::AppState;
use crate::acp::ConnectionKey;
use crate::acp::transport::SessionListRequest;
use crate::models::worktree::{ActiveSessionInfo, ExecutionMode, SessionListEntryDto};


#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct AcpSessionMeta {
    pub cwd: String,
    pub project_id: Option<i32>,
    pub session_start_sha: Option<String>,
}

#[tauri::command]
#[specta::specta]
pub async fn get_acp_session_meta(
    app_state: State<'_, Arc<AppState>>,
    session_key: i32,
) -> Result<AcpSessionMeta, String> {
    let sessions = app_state.acp.sessions.lock().await;
    let session = sessions
        .get(&session_key)
        .ok_or_else(|| format!("No ACP session for key {}", session_key))?;
    Ok(AcpSessionMeta {
        cwd: session.cwd.clone(),
        project_id: session.project_id,
        session_start_sha: session.session_start_sha.clone(),
    })
}

#[tauri::command]
#[specta::specta]
pub async fn get_active_sessions(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
) -> Result<Vec<ActiveSessionInfo>, String> {
    let mut sessions = Vec::new();

    {
        let acp = app_state.acp.sessions.lock().await;
        for (key, proc) in acp.iter().filter(|(_, p)| p.project_id == Some(project_id)) {
            let native_id = proc.acp_session_id.lock().ok().and_then(|g| g.clone());
            sessions.push(ActiveSessionInfo {
                session_key: *key,
                session_name: proc.session_name.clone(),
                agent_id: Some(proc.agent_id_meta.clone()),
                execution_mode: ExecutionMode::Acp,
                started_at: proc.started_at.clone(),
                task_id: proc.task_id,
                task_name: proc.task_name.clone(),
                branch_name: proc.branch_name.clone(),
                acp_session_id: native_id,
                supports_session_list: proc.session_capabilities.supports_session_list,
                supports_session_load: proc.session_capabilities.supports_session_load,
                supports_session_close: proc.session_capabilities.supports_session_close,
                project_id: Some(project_id),
            });
        }
    }

    // PTY sessions
    {
        let pty_meta = app_state.pty.session_meta.lock().await;
        for (key, meta) in pty_meta.iter() {
            if meta.project_id != Some(project_id) {
                continue;
            }
            sessions.push(ActiveSessionInfo {
                session_key: *key,
                session_name: meta.session_name.clone(),
                agent_id: None,
                execution_mode: ExecutionMode::Pty,
                started_at: meta.started_at.clone(),
                task_id: meta.task_id,
                task_name: meta.task_name.clone(),
                branch_name: meta.branch_name.clone(),
                acp_session_id: None,
                supports_session_list: false,
                supports_session_load: false,
                supports_session_close: false,
                project_id: meta.project_id,
            });
        }
    }

    sessions.sort_by(|a, b| a.started_at.cmp(&b.started_at));
    Ok(sessions)
}

#[tauri::command]
#[specta::specta]
pub async fn list_acp_sessions(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    agent_id: String,
    cwd: String,
    connection: crate::acp::ConnectionKey,
    cursor: Option<String>,
) -> Result<Vec<SessionListEntryDto>, String> {
    let resp = crate::acp::query_session_list_via_server(
        connection,
        SessionListRequest { agent_id: agent_id.clone(), cwd: cwd.clone(), cursor },
        &app_state,
    )
    .await?;
    let (mut entries, next_cursor): (Vec<SessionListEntryDto>, Option<String>) = (
        resp.sessions.into_iter().map(|e| SessionListEntryDto {
            session_id: e.session_id,
            title: e.title,
            updated_at: e.updated_at,
        }).collect(),
        resp.next_cursor,
    );

    let aliases = {
        let conn = app_state.db.lock().map_err(|e| format!("DB lock failed: {}", e))?;
        let mut stmt = conn.prepare(
            "SELECT acp_session_id, display_name FROM session_aliases WHERE project_id = ?1 AND agent_id = ?2"
        ).map_err(|e| format!("DB prepare failed: {}", e))?;
        let map: std::collections::HashMap<String, String> = stmt
            .query_map(rusqlite::params![project_id, agent_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|e| format!("DB query failed: {}", e))?
            .filter_map(|r| r.ok())
            .collect();
        map
    };

    for entry in &mut entries {
        if let Some(alias) = aliases.get(&entry.session_id) {
            entry.title = Some(alias.clone());
        }
    }

    if next_cursor.is_none() && !aliases.is_empty() {
        let known_ids: Vec<String> = entries.iter().map(|e| e.session_id.clone()).collect();
        let conn = app_state.db.lock().map_err(|e| format!("DB lock failed: {}", e))?;
        if !known_ids.is_empty() {
            let placeholders = (0..known_ids.len())
                .map(|i| format!("?{}", i + 3))
                .collect::<Vec<_>>()
                .join(", ");
            let sql = format!(
                "DELETE FROM session_aliases WHERE project_id = ?1 AND agent_id = ?2 AND acp_session_id NOT IN ({})",
                placeholders
            );
            let mut params: Vec<rusqlite::types::Value> = vec![
                rusqlite::types::Value::Integer(project_id as i64),
                rusqlite::types::Value::Text(agent_id.clone()),
            ];
            for id in &known_ids {
                params.push(rusqlite::types::Value::Text(id.clone()));
            }
            conn.execute(&sql, rusqlite::params_from_iter(params))
                .map_err(|e| format!("Prune aliases failed: {}", e))?;
        } else {
            conn.execute(
                "DELETE FROM session_aliases WHERE project_id = ?1 AND agent_id = ?2",
                rusqlite::params![project_id, agent_id],
            ).map_err(|e| format!("Prune aliases failed: {}", e))?;
        }
    }

    Ok(entries)
}

#[tauri::command]
#[specta::specta]
pub async fn rename_acp_session(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    agent_id: String,
    acp_session_id: String,
    display_name: String,
) -> Result<(), String> {
    {
        let conn = app_state.db.lock().map_err(|e| format!("DB lock failed: {}", e))?;
        crate::acp::manager::upsert_session_alias(&conn, project_id, &agent_id, &acp_session_id, &display_name)
            .map_err(|e| format!("Upsert alias failed: {}", e))?;
    }

    {
        let mut sessions = app_state.acp.sessions.lock().await;
        for proc in sessions.values_mut() {
            let matches = proc.acp_session_id.lock()
                .map(|g| g.as_deref() == Some(&acp_session_id))
                .unwrap_or(false);
            if matches {
                proc.session_name = Some(display_name.clone());
                break;
            }
        }
    }

    app_state.app_handle.emit("sessions-changed", ()).ok();
    Ok(())
}

/// Re-emit model/mode state from session fields during replay drain.
async fn emit_init_events_from_session(log_id: i32, app_state: &Arc<AppState>) {
    let (model_id, mode_id, config_options) = {
        let sessions = app_state.acp.sessions.lock().await;
        let Some(session) = sessions.get(&log_id) else { return };
        (
            session.current_model_id.lock().ok().and_then(|m| m.clone()),
            session.current_mode_id.lock().ok().and_then(|m| m.clone()),
            session.config_options.clone(),
        )
    };

    let find_opt = |id: &str| -> Option<&serde_json::Value> {
        config_options.iter().find(|o| o.get("id").and_then(|v| v.as_str()) == Some(id))
    };

    if let Some(model_opt) = find_opt("model") {
        let options = model_opt.get("options").and_then(|v| v.as_array()).map(|a| a.as_slice()).unwrap_or(&[]);
        let current = model_id.unwrap_or_else(|| {
            options.first().and_then(|v| v.get("value")).and_then(|v| v.as_str()).unwrap_or("").to_string()
        });
        let payload = serde_json::json!({
            "current_model_id": current,
            "available_models": options.iter().map(|v| serde_json::json!({
                "model_id": v.get("value").and_then(|s| s.as_str()).unwrap_or(""),
                "name": v.get("name").and_then(|s| s.as_str()).unwrap_or(""),
            })).collect::<Vec<_>>(),
        });
        let _ = app_state.app_handle.emit(&format!("acp://session-models/{}", log_id), &payload);
    }
    if let Some(mode_opt) = find_opt("mode") {
        let options = mode_opt.get("options").and_then(|v| v.as_array()).map(|a| a.as_slice()).unwrap_or(&[]);
        let current = mode_id.unwrap_or_else(|| {
            options.first().and_then(|v| v.get("value")).and_then(|v| v.as_str()).unwrap_or("").to_string()
        });
        let payload = serde_json::json!({
            "current_mode_id": current,
            "available_modes": options.iter().map(|v| serde_json::json!({
                "mode_id": v.get("value").and_then(|s| s.as_str()).unwrap_or(""),
                "name": v.get("name").and_then(|s| s.as_str()).unwrap_or(""),
            })).collect::<Vec<_>>(),
        });
        let _ = app_state.app_handle.emit(&format!("acp://session-modes/{}", log_id), &payload);
    }
}

#[tauri::command]
#[specta::specta]
pub async fn drain_acp_replay(
    app_state: State<'_, Arc<AppState>>,
    log_id: i32,
) -> Result<(), String> {
    let replay_arc = {
        let sessions = app_state.acp.sessions.lock().await;
        sessions
            .get(&log_id)
            .map(|s| Arc::clone(&s.replay_buffer))
    };
    let Some(replay_arc) = replay_arc else {
        return Ok(());
    };
    let buffered = {
        let mut buf = replay_arc
            .lock()
            .map_err(|e| format!("Lock poisoned: {}", e))?;
        buf.take()
    };
    if let Some(events) = buffered {
        let is_initialized = {
            let sessions = app_state.acp.sessions.lock().await;
            sessions.get(&log_id)
                .and_then(|s| s.initialized.lock().ok().map(|g| *g))
                .unwrap_or(false)
        };
        for payload in events {
            let _ = app_state.app_handle.emit(&format!("acp://session-update/{}", log_id), &payload);
        }
        if is_initialized {
            emit_init_events_from_session(log_id, &app_state).await;
            let _ = app_state.app_handle.emit(&format!("acp://replay-drained/{}", log_id), ());
        }
    }
    Ok(())
}

// ─── External file attachment ───────────────────────────────────────────────

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
