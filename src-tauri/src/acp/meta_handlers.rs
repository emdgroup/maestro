use std::sync::Arc;
use tauri::State;
use tauri::Emitter;
use serde::{Deserialize, Serialize};
use specta::Type;

use crate::core::AppState;
use crate::acp::transport::SessionListRequest;
use crate::models::worktree::{ActiveSessionInfo, ExecutionMode, SessionListEntryDto};

// Re-export attachment types and handlers (including macro-generated tauri/specta symbols)
// so ipc/mod.rs glob import still resolves them.
pub use crate::acp::attachment_handlers::*;

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
