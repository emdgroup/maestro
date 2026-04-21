//! IPC command handlers for ACP (Agent Control Protocol) session management.
//!
//! Exposes four Tauri IPC commands to the frontend:
//! - `spawn_acp_session`: Launch a new ACP agent session via maestro-server subprocess
//! - `send_acp_prompt`: Send a prompt message to a running session
//! - `respond_acp_permission`: Respond to a permission request from the agent
//! - `cancel_acp_session`: Stop a running session and clean up resources

use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::State;
use chrono::Utc;

use crate::db::AppState;
use crate::acp::registry::{RegistryResponse, ResolvedLaunchCommand, RemoteAgentStatus, check_agent_on_remote};
use crate::acp::transport::{
    MaestroRpcMessage, ServerRequest,
    PromptRequest, CancelRequest, PermissionResponse,
};

/// Launch a new ACP agent session via maestro-server subprocess.
///
/// Creates an execution_log row with status='running', execution_mode='acp', and agent_id set,
/// spawns maestro-server with piped stdin/stdout, sends SpawnRequest, and starts a background
/// reader task that emits Tauri events for each session update.
///
/// The session is keyed by the returned log_id in AppState.acp_sessions.
///
/// # Arguments
/// * `app_state` - Tauri app state
/// * `agent_id` - ACP agent identifier (e.g. "claude-code", package name)
/// * `cwd` - Working directory for the agent
/// * `session_name` - Optional display name for the session
///
/// # Returns
/// Execution log ID (i32) — used as session key for send_acp_prompt, respond_acp_permission,
/// cancel_acp_session, and Tauri event subscription (acp://session-update/{log_id}, etc.)
#[tauri::command]
#[specta::specta]
pub async fn spawn_acp_session(
    app_state: State<'_, Arc<AppState>>,
    agent_id: String,
    cwd: String,
    session_name: Option<String>,
    connection_id: Option<i32>,
) -> Result<i32, String> {
    let now = Utc::now().to_rfc3339();

    let log_id: i32 = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        conn.execute(
            "INSERT INTO execution_logs (task_id, branch_name, session_name, status, execution_mode, agent_id, started_at) VALUES (NULL, NULL, ?1, 'running', 'acp', ?2, ?3)",
            rusqlite::params![&session_name, &agent_id, &now],
        ).map_err(|e| format!("Failed to create execution log: {}", e))?;
        conn.last_insert_rowid() as i32
    };

    let session_id = format!("session-{}", log_id);

    if let Some(conn_id) = connection_id {
        let ssh = app_state.get_ssh_session(conn_id).await
            .ok_or_else(|| format!("No active SSH session for connection_id {}. Connect first.", conn_id))?;
        crate::acp::spawn_acp_process_remote(&agent_id, &cwd, log_id, &session_id, &app_state, &ssh).await?;
    } else {
        crate::acp::spawn_acp_process(&agent_id, &cwd, log_id, &session_id, &app_state).await?;
    }

    Ok(log_id)
}

/// Send a prompt message to a running ACP session.
///
/// # Arguments
/// * `app_state` - Tauri app state
/// * `log_id` - Session key (execution log ID)
/// * `content` - The prompt text to send to the agent
///
/// # Security
/// T-44-01: write_to_acp_session returns Err if log_id not in acp_sessions map — only
/// valid sessions can receive messages (inherited from Phase 43).
#[tauri::command]
#[specta::specta]
pub async fn send_acp_prompt(
    app_state: State<'_, Arc<AppState>>,
    log_id: i32,
    content: String,
) -> Result<(), String> {
    let session_id = format!("session-{}", log_id);
    let msg = MaestroRpcMessage::Request(ServerRequest::Prompt(PromptRequest {
        session_id,
        content,
    }));
    crate::acp::write_to_acp_session(&app_state, log_id, &msg).await
}

/// Respond to a permission request from the agent.
///
/// # Arguments
/// * `app_state` - Tauri app state
/// * `log_id` - Session key (execution log ID)
/// * `request_id` - The permission request ID from the agent's PermissionRequest event
/// * `allowed` - Whether to allow the requested action
///
/// # Security
/// T-44-01: write_to_acp_session returns Err if log_id not in acp_sessions map — only
/// valid sessions can receive messages (inherited from Phase 43).
#[tauri::command]
#[specta::specta]
pub async fn respond_acp_permission(
    app_state: State<'_, Arc<AppState>>,
    log_id: i32,
    request_id: String,
    allowed: bool,
) -> Result<(), String> {
    let session_id = format!("session-{}", log_id);
    let msg = MaestroRpcMessage::Request(ServerRequest::PermitResponse(PermissionResponse {
        session_id,
        request_id,
        allowed,
    }));
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

/// Fetch the ACP agent registry from CDN, returning cached results when available.
///
/// Respects a 5-minute TTL on cached data. When CDN is unreachable but a cached
/// result exists, returns stale data with `stale: true`. When no cache exists and
/// CDN is unreachable, returns Err.
///
/// # Arguments
/// * `app_state` - Tauri app state
/// * `force_refresh` - When true, bypasses TTL and re-fetches from CDN
///
/// # Returns
/// RegistryResponse { agents, cached, stale }
#[tauri::command]
#[specta::specta]
pub async fn fetch_agent_registry(
    app_state: State<'_, Arc<AppState>>,
    force_refresh: bool,
) -> Result<RegistryResponse, String> {
    crate::acp::registry::fetch_or_return_cached(
        &app_state.agent_registry_cache,
        force_refresh,
    ).await
}

/// Resolve the launch command for a specific agent from the cached registry.
///
/// Looks up the agent by ID in the cached registry (must have been fetched first
/// via `fetch_agent_registry`), then resolves the distribution using priority order:
/// npx (preferred) -> binary (compile-time platform key) -> uvx (last resort).
///
/// # Arguments
/// * `app_state` - Tauri app state
/// * `agent_id` - The agent identifier (e.g. "claude-code")
///
/// # Returns
/// ResolvedLaunchCommand { cmd, args } ready for subprocess spawn
///
/// # Errors
/// - Registry not loaded (call fetch_agent_registry first)
/// - Agent not found in registry
/// - No compatible distribution for current platform
#[tauri::command]
#[specta::specta]
pub async fn resolve_agent_launch_command(
    app_state: State<'_, Arc<AppState>>,
    agent_id: String,
) -> Result<ResolvedLaunchCommand, String> {
    let guard = app_state.agent_registry_cache.lock().await;
    let entry = guard.as_ref()
        .ok_or_else(|| "Registry not loaded — call fetch_agent_registry first".to_string())?;
    let agent = entry.registry.agents.iter()
        .find(|a| a.id == agent_id)
        .ok_or_else(|| format!("Agent '{}' not found in registry", agent_id))?;
    crate::acp::registry::resolve_distribution(&agent.distribution)
        .ok_or_else(|| format!("No compatible distribution found for agent '{}'", agent_id))
}

/// Check which ACP agents (and maestro-server itself) are available on a remote SSH host.
///
/// Runs `which <cmd>` for each agent's launch binary over the existing SSH session.
/// Results are cached in AppState for 5 minutes to avoid re-checking on every dialog open.
///
/// # Arguments
/// * `connection_id` - SSH connection ID (must have an active session in AppState)
///
/// # Returns
/// RemoteAgentStatus { maestro_server_available, available_agent_ids }
#[tauri::command]
#[specta::specta]
pub async fn check_remote_agents(
    app_state: State<'_, Arc<AppState>>,
    connection_id: i32,
) -> Result<RemoteAgentStatus, String> {
    // Return cached result if still fresh (5-min TTL)
    {
        let cache = app_state.remote_agent_status.lock().await;
        if let Some((ts, status)) = cache.get(&connection_id) {
            if ts.elapsed() < Duration::from_secs(300) {
                return Ok(status.clone());
            }
        }
    }

    let ssh = app_state.get_ssh_session(connection_id).await
        .ok_or_else(|| format!("No active SSH session for connection_id {}. Connect first.", connection_id))?;

    let maestro_server_available = ssh
        .execute_command("which maestro-server 2>/dev/null")
        .await
        .is_ok();

    let registry = crate::acp::registry::fetch_or_return_cached(
        &app_state.agent_registry_cache,
        false,
    ).await.map_err(|e| format!("Failed to fetch registry: {}", e))?;

    let mut available_agent_ids = Vec::new();
    for agent in &registry.agents {
        if check_agent_on_remote(agent, &ssh).await {
            available_agent_ids.push(agent.id.clone());
        }
    }

    let status = RemoteAgentStatus {
        maestro_server_available,
        available_agent_ids,
    };

    app_state.remote_agent_status.lock().await
        .insert(connection_id, (Instant::now(), status.clone()));

    Ok(status)
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;
    use crate::db::schema::initialize_schema;
    use crate::acp::transport::{MaestroRpcMessage, ServerRequest, PromptRequest, PermissionResponse};

    /// PERSIST-02: spawn_acp_session INSERT writes execution_mode='acp' and agent_id.
    /// Tests the exact SQL the handler uses, against an in-memory v11 schema.
    #[test]
    fn test_spawn_acp_session_creates_log() {
        let conn = Connection::open_in_memory().unwrap();
        initialize_schema(&conn).unwrap();

        let session_name = "test-session";
        let agent_id = "claude-code";
        let now = "2026-04-20T00:00:00Z";

        conn.execute(
            "INSERT INTO execution_logs (task_id, branch_name, session_name, status, execution_mode, agent_id, started_at) VALUES (NULL, NULL, ?1, 'running', 'acp', ?2, ?3)",
            rusqlite::params![session_name, agent_id, now],
        ).unwrap();

        let log_id = conn.last_insert_rowid();

        let (mode, stored_agent_id, status): (String, Option<String>, String) = conn
            .query_row(
                "SELECT execution_mode, agent_id, status FROM execution_logs WHERE id = ?1",
                [log_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();

        assert_eq!(mode, "acp", "execution_mode must be 'acp'");
        assert_eq!(stored_agent_id, Some("claude-code".to_string()), "agent_id must be set");
        assert_eq!(status, "running", "initial status must be 'running'");
    }

    /// PERSIST-05: cancel_acp_session UPDATE sets status='cancelled' and completed_at.
    /// Tests the exact SQL the handler uses, against an in-memory v11 schema.
    #[test]
    fn test_cancel_acp_session_updates_status() {
        let conn = Connection::open_in_memory().unwrap();
        initialize_schema(&conn).unwrap();

        // Create an execution_log row first (simulates spawn).
        let now = "2026-04-20T00:00:00Z";
        conn.execute(
            "INSERT INTO execution_logs (task_id, branch_name, session_name, status, execution_mode, agent_id, started_at) VALUES (NULL, NULL, 'test', 'running', 'acp', 'claude-code', ?1)",
            rusqlite::params![now],
        ).unwrap();
        let log_id = conn.last_insert_rowid();

        // Execute the same UPDATE that cancel_acp_session uses.
        let cancel_time = "2026-04-20T00:01:00Z";
        let rows_updated = conn.execute(
            "UPDATE execution_logs SET status = 'cancelled', completed_at = ?1 WHERE id = ?2",
            rusqlite::params![cancel_time, log_id],
        ).unwrap();

        assert_eq!(rows_updated, 1, "exactly one row should be updated");

        let (status, completed_at): (String, Option<String>) = conn
            .query_row(
                "SELECT status, completed_at FROM execution_logs WHERE id = ?1",
                [log_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();

        assert_eq!(status, "cancelled", "status must be 'cancelled' after cancel");
        assert_eq!(completed_at, Some("2026-04-20T00:01:00Z".to_string()), "completed_at must be set");
    }

    /// PERSIST-03: send_acp_prompt constructs a PromptRequest with correct session_id and content.
    /// Verifies the exact JSON shape that write_to_acp_session will frame and send to maestro-server.
    #[test]
    fn test_send_acp_prompt_message_structure() {
        let log_id: i32 = 42;
        let content = "fix the auth bug";
        let session_id = format!("session-{}", log_id);

        let msg = MaestroRpcMessage::Request(ServerRequest::Prompt(PromptRequest {
            session_id: session_id.clone(),
            content: content.to_string(),
        }));

        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("\"direction\":\"request\""), "must be a request direction");
        assert!(json.contains("\"type\":\"prompt\""), "must have type=prompt");
        assert!(json.contains(&format!("\"session_id\":\"{}\"", session_id)), "session_id must match log_id pattern");
        assert!(json.contains(&format!("\"content\":\"{}\"", content)), "content must be preserved verbatim");

        // Roundtrip: maestro-server must deserialize this back to the same message
        let back: MaestroRpcMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(msg, back, "PromptRequest must roundtrip through JSON");
    }

    /// PERSIST-04: respond_acp_permission constructs a PermitResponse with correct fields.
    /// Verifies that both allowed=true and allowed=false produce distinct, correct JSON.
    #[test]
    fn test_respond_acp_permission_message_structure() {
        let log_id: i32 = 7;
        let request_id = "perm-001";
        let session_id = format!("session-{}", log_id);

        // allowed=true
        let allow_msg = MaestroRpcMessage::Request(ServerRequest::PermitResponse(PermissionResponse {
            session_id: session_id.clone(),
            request_id: request_id.to_string(),
            allowed: true,
        }));
        let allow_json = serde_json::to_string(&allow_msg).unwrap();
        assert!(allow_json.contains("\"type\":\"permit_response\""), "must have type=permit_response");
        assert!(allow_json.contains("\"allowed\":true"), "allowed=true must be present");
        assert!(allow_json.contains(&format!("\"request_id\":\"{}\"", request_id)));

        // allowed=false
        let deny_msg = MaestroRpcMessage::Request(ServerRequest::PermitResponse(PermissionResponse {
            session_id: session_id.clone(),
            request_id: request_id.to_string(),
            allowed: false,
        }));
        let deny_json = serde_json::to_string(&deny_msg).unwrap();
        assert!(deny_json.contains("\"allowed\":false"), "allowed=false must be present");
        assert_ne!(allow_json, deny_json, "allow and deny must produce different JSON");

        // Roundtrip
        let back: MaestroRpcMessage = serde_json::from_str(&allow_json).unwrap();
        assert_eq!(allow_msg, back);
    }

    /// PERSIST-06: structured_output flush SQL writes JSON array to the correct column.
    /// Tests the exact UPDATE statement used in spawn_reader_task's periodic and final flush.
    #[test]
    fn test_structured_output_flush_sql() {
        let conn = Connection::open_in_memory().unwrap();
        initialize_schema(&conn).unwrap();

        let now = "2026-04-21T00:00:00Z";
        conn.execute(
            "INSERT INTO execution_logs (task_id, branch_name, session_name, status, execution_mode, agent_id, started_at) VALUES (NULL, NULL, 'flush-test', 'running', 'acp', 'test-agent', ?1)",
            rusqlite::params![now],
        ).unwrap();
        let log_id = conn.last_insert_rowid();

        // Simulate what spawn_reader_task's flush branch does
        let updates = serde_json::json!([
            {"seq": 1, "text": "chunk-one"},
            {"seq": 2, "text": "chunk-two"},
            {"seq": 3, "text": "chunk-three"}
        ]);
        let json = serde_json::to_string(&updates).unwrap();

        let rows = conn.execute(
            "UPDATE execution_logs SET structured_output = ?1 WHERE id = ?2",
            rusqlite::params![&json, log_id],
        ).unwrap();
        assert_eq!(rows, 1, "exactly one row must be updated");

        let stored: Option<String> = conn.query_row(
            "SELECT structured_output FROM execution_logs WHERE id = ?1",
            [log_id],
            |row| row.get(0),
        ).unwrap();

        let stored_str = stored.expect("structured_output must not be NULL after flush");
        let parsed: Vec<serde_json::Value> = serde_json::from_str(&stored_str).unwrap();
        assert_eq!(parsed.len(), 3, "all 3 updates must be stored");
        assert_eq!(parsed[0]["seq"], 1);
        assert_eq!(parsed[2]["text"], "chunk-three");
    }

    /// PERSIST-06 (overwrite semantics): second flush overwrites first — no .clear() means
    /// the array always grows and the DB column always holds the full accumulated list.
    #[test]
    fn test_structured_output_flush_overwrites_accumulates() {
        let conn = Connection::open_in_memory().unwrap();
        initialize_schema(&conn).unwrap();

        let now = "2026-04-21T00:00:00Z";
        conn.execute(
            "INSERT INTO execution_logs (task_id, branch_name, session_name, status, execution_mode, agent_id, started_at) VALUES (NULL, NULL, 'overwrite-test', 'running', 'acp', 'test-agent', ?1)",
            rusqlite::params![now],
        ).unwrap();
        let log_id = conn.last_insert_rowid();

        // First flush: 2 items
        let first = serde_json::to_string(&serde_json::json!([{"seq":1},{"seq":2}])).unwrap();
        conn.execute("UPDATE execution_logs SET structured_output = ?1 WHERE id = ?2",
            rusqlite::params![&first, log_id]).unwrap();

        // Second flush: 4 items (accumulation — no clear between ticks)
        let second = serde_json::to_string(&serde_json::json!([{"seq":1},{"seq":2},{"seq":3},{"seq":4}])).unwrap();
        conn.execute("UPDATE execution_logs SET structured_output = ?1 WHERE id = ?2",
            rusqlite::params![&second, log_id]).unwrap();

        let stored: String = conn.query_row(
            "SELECT structured_output FROM execution_logs WHERE id = ?1",
            [log_id], |row| row.get::<_, String>(0),
        ).unwrap();
        let parsed: Vec<serde_json::Value> = serde_json::from_str(&stored).unwrap();
        assert_eq!(parsed.len(), 4, "second flush must overwrite with full accumulated array");
        assert_eq!(parsed[3]["seq"], 4);
    }
}
