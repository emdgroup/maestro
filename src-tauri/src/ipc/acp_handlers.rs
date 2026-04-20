//! IPC command handlers for ACP (Agent Control Protocol) session management.
//!
//! Exposes three Tauri IPC commands to the frontend:
//! - `start_acp_session`: Launch a new ACP agent session via maestro-server subprocess
//! - `send_to_acp_session`: Write a prompt or permission response to a running session
//! - `cancel_acp_session`: Stop a running session and clean up resources

use std::sync::Arc;
use tauri::State;
use chrono::Utc;

use crate::db::AppState;
use crate::acp::transport::{
    MaestroRpcMessage, ServerRequest,
    PromptRequest, CancelRequest, PermissionResponse,
};

/// Launch a new ACP agent session via maestro-server subprocess.
///
/// Creates an execution_log row with status='running', spawns maestro-server with
/// piped stdin/stdout, sends SpawnRequest, and starts a background reader task
/// that emits Tauri events for each session update.
///
/// The session is keyed by the returned log_id in AppState.acp_sessions.
/// Phase 44 will add execution_mode='acp' and agent_id columns to execution_logs.
///
/// # Arguments
/// * `app_state` - Tauri app state
/// * `agent_id` - ACP agent identifier (e.g. "claude-code", package name)
/// * `cwd` - Working directory for the agent
/// * `session_name` - Optional display name for the session
///
/// # Returns
/// Execution log ID (i32) — used as session key for send_to_acp_session, cancel_acp_session,
/// and Tauri event subscription (acp://session-update/{log_id}, etc.)
#[tauri::command]
#[specta::specta]
pub async fn start_acp_session(
    app_state: State<'_, Arc<AppState>>,
    agent_id: String,
    cwd: String,
    session_name: Option<String>,
) -> Result<i32, String> {
    let now = Utc::now().to_rfc3339();

    // Insert execution_log row in a scoped block to drop the lock before async operations.
    let log_id: i32 = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        conn.execute(
            "INSERT INTO execution_logs (task_id, branch_name, session_name, status, started_at) VALUES (NULL, NULL, ?1, 'running', ?2)",
            rusqlite::params![&session_name, &now],
        ).map_err(|e| format!("Failed to create execution log: {}", e))?;
        conn.last_insert_rowid() as i32
    };

    // Derive session_id from log_id for the ACP protocol.
    let session_id = format!("session-{}", log_id);

    // Spawn maestro-server subprocess and register the session in AppState.
    crate::acp::spawn_acp_process(&agent_id, &cwd, log_id, &session_id, &app_state).await?;

    Ok(log_id)
}

/// Send a message to a running ACP session (prompt or permission response).
///
/// # Arguments
/// * `app_state` - Tauri app state
/// * `log_id` - Session key (execution log ID)
/// * `message_type` - "prompt" or "permission_response"
/// * `content` - For prompt: the prompt text. For permission_response: unused.
/// * `request_id` - For permission_response: the permission request ID. For prompt: unused.
/// * `allowed` - For permission_response: whether to allow. For prompt: unused.
///
/// # Security
/// T-43-06: message_type is strictly matched — unknown values return Err immediately.
#[tauri::command]
#[specta::specta]
pub async fn send_to_acp_session(
    app_state: State<'_, Arc<AppState>>,
    log_id: i32,
    message_type: String,
    content: Option<String>,
    request_id: Option<String>,
    allowed: Option<bool>,
) -> Result<(), String> {
    let session_id = format!("session-{}", log_id);

    let msg = match message_type.as_str() {
        "prompt" => MaestroRpcMessage::Request(ServerRequest::Prompt(PromptRequest {
            session_id,
            content: content.unwrap_or_default(),
        })),
        "permission_response" => MaestroRpcMessage::Request(ServerRequest::PermitResponse(PermissionResponse {
            session_id,
            request_id: request_id.ok_or("request_id required for permission_response")?,
            allowed: allowed.unwrap_or(false),
        })),
        _ => return Err(format!("Unknown message_type: {}", message_type)),
    };

    crate::acp::write_to_acp_session(&app_state, log_id, &msg).await
}

/// Cancel a running ACP session — kills the maestro-server subprocess and cleans up.
///
/// Steps:
/// 1. Send CancelRequest to maestro-server (best-effort, ignored if session already gone)
/// 2. Remove session from AppState.acp_sessions (drops AcpProcess, which kills subprocess via kill_on_drop)
/// 3. Send cancel signal to the background reader task
/// 4. Update execution_log status to 'cancelled'
///
/// # Security
/// T-43-08: cancel_acp_session sends CancelRequest then removes from map (drops Child with
/// kill_on_drop). Reader task also removes on EOF. Double-cleanup is safe.
///
/// # Arguments
/// * `app_state` - Tauri app state
/// * `log_id` - Session key (execution log ID)
#[tauri::command]
#[specta::specta]
pub async fn cancel_acp_session(
    app_state: State<'_, Arc<AppState>>,
    log_id: i32,
) -> Result<(), String> {
    // Send CancelRequest to maestro-server first (best-effort — server may already be gone).
    let session_id = format!("session-{}", log_id);
    let cancel_msg = MaestroRpcMessage::Request(ServerRequest::Cancel(CancelRequest { session_id }));
    let _ = crate::acp::write_to_acp_session(&app_state, log_id, &cancel_msg).await;

    // Remove from acp_sessions — this drops AcpProcess which drops Child (kill_on_drop).
    let removed = app_state.acp_sessions.lock().await.remove(&log_id);

    // If the session had a cancel token, send it to stop the reader task.
    if let Some(mut session) = removed {
        if let Some(cancel_tx) = session.reader_cancel_tx.take() {
            let _ = cancel_tx.send(());
        }
    }

    // Update execution_log status to 'cancelled'.
    let now = Utc::now().to_rfc3339();
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
    let _ = conn.execute(
        "UPDATE execution_logs SET status = 'cancelled', completed_at = ?1 WHERE id = ?2",
        rusqlite::params![&now, log_id],
    );

    Ok(())
}
