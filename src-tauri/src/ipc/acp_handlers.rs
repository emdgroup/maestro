//! IPC command handlers for ACP (Agent Control Protocol) session management.

use std::sync::Arc;
use std::time::Duration;
use tauri::State;
use tauri::Emitter;
use serde::{Deserialize, Serialize};
use specta::Type;

use crate::db::AppState;
use crate::models::worktree::{ActiveSessionInfo, SessionListEntryDto};

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct AcpModelInfo {
    pub model_id: String,
    pub name: String,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct AcpSessionModelState {
    pub current_model_id: String,
    pub available_models: Vec<AcpModelInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct AcpPromptCapabilities {
    pub embedded_context: bool,
    pub image: bool,
    pub audio: bool,
}

use crate::acp::registry::{DiscoveredAgent, AgentDiscoveryResult, AgentDiscoveryCacheEntry};
use crate::acp::transport::{
    MaestroRpcMessage, ServerRequest, ServerResponse,
    PromptRequest, CancelRequest, InterruptTurnRequest, PermissionResponse,
    ElicitationResponse, SetModelRequest,
    ListAgentsRequest,
    FileSearchRequest, FileReadRequest,
    SessionListRequest,
    SessionCloseRequest,
    HandshakeRequest, PROTOCOL_VERSION,
    write_message,
};
use tokio::sync::oneshot;

fn session_id_for(log_id: i32) -> String {
    format!("session-{}", log_id)
}

/// Launch a new ACP agent session via maestro-server subprocess.
///
/// Assigns a session key from the in-memory counter, spawns maestro-server with piped
/// stdin/stdout, sends SpawnRequest, and starts a background reader task that emits
/// Tauri events for each session update.
///
/// The session is keyed by the returned session_key in AppState.acp_sessions.
///
/// # Arguments
/// * `app_state` - Tauri app state
/// * `agent_id` - ACP agent identifier (e.g. "claude-code", package name)
/// * `cwd` - Working directory for the agent
/// * `session_name` - Optional display name for the session
///
/// # Returns
/// Session key (i32) — used as the key for send_acp_prompt, respond_acp_permission,
/// cancel_acp_session, and Tauri event subscription (acp://session-update/{key}, etc.)
#[tauri::command]
#[specta::specta]
pub async fn spawn_acp_session(
    app_state: State<'_, Arc<AppState>>,
    agent_id: String,
    cwd: String,
    session_name: Option<String>,
    project_id: i32,
    connection_id: Option<i32>,
    worktree_branch: Option<String>,
) -> Result<i32, String> {
    // Resolve branch_name from worktree path if not provided
    let branch_name: Option<String> = worktree_branch.or_else(|| {
        std::path::Path::new(&cwd)
            .file_name()
            .and_then(|n| n.to_str())
            .and_then(|basename| {
                let conn = app_state.db.lock().ok()?;
                conn.query_row(
                    "SELECT branch_name FROM worktrees WHERE project_id = ?1 AND (path = ?2 OR path LIKE '%/' || ?2) LIMIT 1",
                    rusqlite::params![project_id, basename],
                    |row| row.get(0),
                ).ok()
            })
    });

    let log_id = app_state.pty.session_counter.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let session_id = session_id_for(log_id);

    if let Some(conn_id) = connection_id {
        let maestro_path = {
            let cache = app_state.acp.discovery_cache.lock().await;
            cache.get(&Some(conn_id))
                .and_then(|e| e.maestro_server_path.clone())
                .ok_or_else(|| format!(
                    "maestro-server path not cached for connection {}. Reconnect to refresh.",
                    conn_id
                ))?
        };
        let ssh = app_state.ssh.get_session(conn_id).await
            .ok_or_else(|| format!("No active SSH session for connection_id {}. Connect first.", conn_id))?;
        crate::acp::spawn_acp_process_remote(
            &agent_id, &cwd, log_id, &session_id, &app_state, &ssh,
            &maestro_path,
            session_name,
            None,
            None,
            branch_name,
        ).await?;
    } else {
        crate::acp::spawn_acp_process(
            &agent_id, &cwd, log_id, &session_id, &app_state,
            session_name,
            None,
            None,
            branch_name,
        ).await?;
    }

    app_state.app_handle.emit("sessions-changed", ()).ok();
    Ok(log_id)
}

async fn send_prompt_impl(
    app_state: &Arc<AppState>,
    log_id: i32,
    content: serde_json::Value,
) -> Result<(), String> {
    let msg = MaestroRpcMessage::Request(ServerRequest::Prompt(PromptRequest {
        session_id: session_id_for(log_id),
        content,
    }));
    crate::acp::write_to_acp_session(app_state, log_id, &msg).await
}

/// Send a plain-text prompt to a running ACP session.
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
    send_prompt_impl(&app_state, log_id, serde_json::Value::String(content)).await
}

/// Send a structured prompt (JSON array of ContentBlock objects) enabling file attachments.
#[tauri::command]
#[specta::specta]
pub async fn send_acp_prompt_structured(
    app_state: State<'_, Arc<AppState>>,
    log_id: i32,
    content_blocks: serde_json::Value,
) -> Result<(), String> {
    send_prompt_impl(&app_state, log_id, content_blocks).await
}

/// Respond to a permission request from the agent.
///
/// # Arguments
/// * `app_state` - Tauri app state
/// * `log_id` - Session key
/// * `request_id` - The permission request ID from the agent's PermissionRequest event
/// # Security
/// T-44-01: write_to_acp_session returns Err if log_id not in acp_sessions map — only
/// valid sessions can receive messages (inherited from Phase 43).
#[tauri::command]
#[specta::specta]
pub async fn respond_acp_permission(
    app_state: State<'_, Arc<AppState>>,
    log_id: i32,
    request_id: String,
    option_id: Option<String>,
) -> Result<(), String> {
    let session_id = session_id_for(log_id);
    let msg = MaestroRpcMessage::Request(ServerRequest::PermitResponse(PermissionResponse {
        session_id,
        request_id,
        option_id,
    }));
    crate::acp::write_to_acp_session(&app_state, log_id, &msg).await
}

/// Respond to an elicitation request from the agent.
#[tauri::command]
#[specta::specta]
pub async fn respond_acp_elicitation(
    app_state: State<'_, Arc<AppState>>,
    log_id: i32,
    request_id: String,
    response: serde_json::Value,
) -> Result<(), String> {
    let session_id = session_id_for(log_id);
    let msg = MaestroRpcMessage::Request(ServerRequest::ElicitationResponse(ElicitationResponse {
        session_id,
        request_id,
        response,
    }));
    crate::acp::write_to_acp_session(&app_state, log_id, &msg).await
}

/// Cancel a running ACP session — kills the maestro-server subprocess and cleans up.
///
/// Steps:
/// 1. Send CancelRequest to maestro-server (best-effort, ignored if session already gone)
/// 2. Remove session from AppState.acp_sessions (drops AcpProcess, which kills subprocess via kill_on_drop)
/// 3. Send cancel signal to the background reader task
///
/// # Security
/// T-43-08: cancel_acp_session sends CancelRequest then removes from map (drops Child with
/// kill_on_drop). Reader task also removes on EOF. Double-cleanup is safe.
///
/// # Arguments
/// * `app_state` - Tauri app state
/// * `log_id` - Session key
#[tauri::command]
#[specta::specta]
pub async fn cancel_acp_session(
    app_state: State<'_, Arc<AppState>>,
    log_id: i32,
) -> Result<(), String> {
    // Send CancelRequest to maestro-server first (best-effort — server may already be gone).
    let session_id = session_id_for(log_id);
    let cancel_msg = MaestroRpcMessage::Request(ServerRequest::Cancel(CancelRequest { session_id }));
    let _ = crate::acp::write_to_acp_session(&app_state, log_id, &cancel_msg).await;

    // Remove from acp_sessions — this drops AcpProcess which drops Child (kill_on_drop).
    let removed = app_state.acp.sessions.lock().await.remove(&log_id);

    // If the session had a cancel token, send it to stop the reader task.
    if let Some(mut session) = removed {
        if let Some(cancel_tx) = session.reader_cancel_tx.take() {
            let _ = cancel_tx.send(());
        }
    }

    app_state.app_handle.emit("sessions-changed", ()).ok();
    Ok(())
}

/// Interrupt the current ACP turn without killing the session.
///
/// Sends InterruptTurn to maestro-server, which forwards a CancelNotification
/// to the agent. The agent responds with StopReason::Cancelled, keeping the
/// session alive for subsequent prompts.
#[tauri::command]
#[specta::specta]
pub async fn interrupt_acp_turn(
    app_state: State<'_, Arc<AppState>>,
    log_id: i32,
) -> Result<(), String> {
    let session_id = session_id_for(log_id);
    let msg = MaestroRpcMessage::Request(ServerRequest::InterruptTurn(InterruptTurnRequest {
        session_id,
    }));
    crate::acp::write_to_acp_session(&app_state, log_id, &msg).await
}

/// Send a SetModel request to change the active model for a running ACP session.
#[tauri::command]
#[specta::specta]
pub async fn set_acp_model(
    app_state: State<'_, Arc<AppState>>,
    log_id: i32,
    model_id: String,
) -> Result<(), String> {
    let session_id = session_id_for(log_id);
    let msg = MaestroRpcMessage::Request(ServerRequest::SetModel(SetModelRequest {
        session_id,
        model_id,
    }));
    crate::acp::write_to_acp_session(&app_state, log_id, &msg).await
}

/// Get cached model state for a running ACP session.
/// Returns None if the session hasn't reported models yet or session not found.
#[tauri::command]
#[specta::specta]
pub async fn get_acp_models(
    app_state: State<'_, Arc<AppState>>,
    log_id: i32,
) -> Result<Option<AcpSessionModelState>, String> {
    let models_arc = {
        let sessions = app_state.acp.sessions.lock().await;
        sessions.get(&log_id).map(|s| Arc::clone(&s.models))
    };
    let Some(models_arc) = models_arc else {
        return Ok(None);
    };
    let cloned = models_arc
        .lock()
        .map_err(|e| format!("Lock poisoned: {}", e))?
        .clone();
    Ok(cloned.map(|m| AcpSessionModelState {
        current_model_id: m.current_model_id,
        available_models: m.available_models.into_iter().map(|mi| AcpModelInfo {
            model_id: mi.model_id,
            name: mi.name,
            description: mi.description,
        }).collect(),
    }))
}

/// Get cached prompt capabilities for a running ACP session.
/// Returns None if the session hasn't reported capabilities yet or session not found.
#[tauri::command]
#[specta::specta]
pub async fn get_acp_capabilities(
    app_state: State<'_, Arc<AppState>>,
    log_id: i32,
) -> Result<Option<AcpPromptCapabilities>, String> {
    let capabilities_arc = {
        let sessions = app_state.acp.sessions.lock().await;
        sessions.get(&log_id).map(|s| Arc::clone(&s.prompt_capabilities))
    };
    let Some(capabilities_arc) = capabilities_arc else {
        return Ok(None);
    };
    let cloned = capabilities_arc
        .lock()
        .map_err(|e| format!("Lock poisoned: {}", e))?
        .clone();
    Ok(cloned.map(|c| AcpPromptCapabilities {
        embedded_context: c.embedded_context,
        image: c.image,
        audio: c.audio,
    }))
}

/// Run agent discovery and store result in the AppState cache.
/// Fire-and-forget safe: returns silently on errors (result stored with error field set).
/// Called at SSH connect time (connection_id = Some) and on-demand from `discover_agents` IPC.
/// For local discovery (connection_id = None), called on first `discover_agents` query.
pub async fn prefetch_agent_discovery(app_state: Arc<AppState>, connection_id: Option<i32>) {
    match connection_id {
        Some(conn_id) => {
            let Some(ssh) = app_state.ssh.get_session(conn_id).await else {
                return;
            };
            let maestro_path = ssh
                .execute_command("which maestro-server 2>/dev/null")
                .await
                .ok()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());
            let maestro_server_available = maestro_path.is_some();
            let (agents, error) = match &maestro_path {
                Some(path) => match query_list_agents_remote(&ssh, path).await {
                    Ok(a) => (a, None),
                    Err(e) => (Vec::new(), Some(e)),
                },
                None => (Vec::new(), None),
            };
            let entry = AgentDiscoveryCacheEntry {
                result: AgentDiscoveryResult { maestro_server_available, agents, error },
                maestro_server_path: maestro_path,
                fetched_at: std::time::Instant::now(),
            };
            app_state.acp.discovery_cache.lock().await.insert(Some(conn_id), entry);
        }
        None => {
            let maestro_path = which::which("maestro-server").ok()
                .map(|p| p.to_string_lossy().to_string());
            let maestro_server_available = maestro_path.is_some();
            let (agents, error) = if maestro_server_available {
                match query_list_agents_local().await {
                    Ok(a) => (a, None),
                    Err(e) => (Vec::new(), Some(e)),
                }
            } else {
                (Vec::new(), None)
            };
            let entry = AgentDiscoveryCacheEntry {
                result: AgentDiscoveryResult { maestro_server_available, agents, error },
                maestro_server_path: None,
                fetched_at: std::time::Instant::now(),
            };
            app_state.acp.discovery_cache.lock().await.insert(None, entry);
        }
    }
}

async fn query_list_agents_local() -> Result<Vec<DiscoveredAgent>, String> {
    let msg = MaestroRpcMessage::Request(ServerRequest::ListAgents(ListAgentsRequest {}));
    let result = crate::acp::rpc::one_shot_rpc_local(&msg, 15).await?;
    match result {
        Some(MaestroRpcMessage::Response(ServerResponse::ListAgentsOk(resp))) => {
            Ok(resp.agents.into_iter().map(|a| DiscoveredAgent { id: a.id, name: a.name, icon: a.icon }).collect())
        }
        Some(MaestroRpcMessage::Response(ServerResponse::Error(e))) => Err(e.message),
        _ => Err("No valid ListAgentsOk response from local maestro-server".to_string()),
    }
}

async fn query_list_agents_remote(
    ssh: &crate::ssh::RemoteSshSession,
    maestro_server_path: &str,
) -> Result<Vec<DiscoveredAgent>, String> {
    let msg = MaestroRpcMessage::Request(ServerRequest::ListAgents(ListAgentsRequest {}));
    let result = crate::acp::rpc::one_shot_rpc_remote(ssh, maestro_server_path, &msg, 30).await?;
    match result {
        Some(MaestroRpcMessage::Response(ServerResponse::ListAgentsOk(resp))) => {
            Ok(resp.agents.into_iter().map(|a| DiscoveredAgent { id: a.id, name: a.name, icon: a.icon }).collect())
        }
        Some(MaestroRpcMessage::Response(ServerResponse::Error(e))) => Err(e.message),
        _ => Err("No valid ListAgentsOk response from maestro-server".to_string()),
    }
}

/// Discover available ACP agents via maestro-server.
/// Works for both local (connection_id = None) and remote SSH (connection_id = Some(id)).
/// Returns cached result if within 5-minute TTL; otherwise re-runs discovery.
#[tauri::command]
#[specta::specta]
pub async fn discover_agents(
    app_state: State<'_, Arc<AppState>>,
    connection_id: Option<i32>,
) -> Result<AgentDiscoveryResult, String> {
    {
        let cache = app_state.acp.discovery_cache.lock().await;
        if let Some(entry) = cache.get(&connection_id) {
            if entry.fetched_at.elapsed() < Duration::from_secs(300) {
                return Ok(entry.result.clone());
            }
        }
    }

    let arc = Arc::clone(app_state.inner());
    prefetch_agent_discovery(arc, connection_id).await;

    app_state.acp.discovery_cache.lock().await
        .get(&connection_id)
        .map(|e| e.result.clone())
        .ok_or_else(|| match connection_id {
            None => "Local agent discovery failed — is maestro-server installed?".to_string(),
            Some(id) => format!("No active SSH session for connection_id {}. Connect first.", id),
        })
}

/// Search files in the project directory via the active maestro-server session.
/// Routes the FileSearch request through the existing session transport so it works
/// for both local and remote (SSH) projects.
#[tauri::command]
#[specta::specta]
pub async fn search_session_files(
    app_state: State<'_, Arc<AppState>>,
    log_id: i32,
    query: String,
    limit: Option<u32>,
) -> Result<Vec<String>, String> {
    let (cwd, pending_search) = {
        let sessions = app_state.acp.sessions.lock().await;
        let session = sessions
            .get(&log_id)
            .ok_or_else(|| format!("No ACP session for log_id {}", log_id))?;
        (session.cwd.clone(), Arc::clone(&session.pending_file_search))
    };

    let (tx, rx) = oneshot::channel::<Result<Vec<String>, String>>();
    {
        let mut guard = pending_search
            .lock()
            .map_err(|_| "pending_file_search lock poisoned".to_string())?;
        *guard = Some(tx);
    }

    crate::acp::write_to_acp_session(
        &app_state,
        log_id,
        &MaestroRpcMessage::Request(ServerRequest::FileSearch(FileSearchRequest {
            cwd,
            query,
            limit,
        })),
    )
    .await?;

    tokio::time::timeout(Duration::from_secs(15), rx)
        .await
        .map_err(|_| "File search timed out".to_string())?
        .map_err(|_| "File search response channel closed".to_string())?
}

/// Read a file from the project via the active maestro-server session.
/// Routes the FileRead request through the existing session transport so it works
/// for both local and remote (SSH) projects.
#[tauri::command]
#[specta::specta]
pub async fn read_session_file(
    app_state: State<'_, Arc<AppState>>,
    log_id: i32,
    relative_path: String,
) -> Result<String, String> {
    let (cwd, pending_read) = {
        let sessions = app_state.acp.sessions.lock().await;
        let session = sessions
            .get(&log_id)
            .ok_or_else(|| format!("No ACP session for log_id {}", log_id))?;
        (session.cwd.clone(), Arc::clone(&session.pending_file_read))
    };

    let (tx, rx) = oneshot::channel::<Result<String, String>>();
    {
        let mut guard = pending_read
            .lock()
            .map_err(|_| "pending_file_read lock poisoned".to_string())?;
        *guard = Some(tx);
    }

    crate::acp::write_to_acp_session(
        &app_state,
        log_id,
        &MaestroRpcMessage::Request(ServerRequest::FileRead(FileReadRequest {
            cwd,
            relative_path,
        })),
    )
    .await?;

    tokio::time::timeout(Duration::from_secs(15), rx)
        .await
        .map_err(|_| "File read timed out".to_string())?
        .map_err(|_| "File read response channel closed".to_string())?
}

/// Get all currently active sessions (ACP + PTY) as a flat list.
/// Used by the Agents sidebar to display live sessions.
#[tauri::command]
#[specta::specta]
pub async fn get_active_sessions(
    app_state: State<'_, Arc<AppState>>,
) -> Result<Vec<ActiveSessionInfo>, String> {
    let mut sessions = Vec::new();

    // ACP sessions
    {
        let acp = app_state.acp.sessions.lock().await;
        for (key, proc) in acp.iter() {
            let caps = proc.session_capabilities.lock()
                .map(|c| c.clone())
                .unwrap_or_default();
            let native_id = proc.acp_session_id.lock().ok().and_then(|g| g.clone());
            sessions.push(ActiveSessionInfo {
                session_key: *key,
                session_name: proc.session_name.clone(),
                agent_id: Some(proc.agent_id_meta.clone()),
                execution_mode: "acp".to_string(),
                started_at: proc.started_at.clone(),
                task_id: proc.task_id,
                task_name: proc.task_name.clone(),
                branch_name: proc.branch_name.clone(),
                acp_session_id: native_id,
                supports_session_list: caps.supports_session_list,
                supports_session_load: caps.supports_session_load,
                supports_session_close: caps.supports_session_close,
            });
        }
    }

    // PTY sessions
    {
        let pty_meta = app_state.pty.session_meta.lock().await;
        for (key, meta) in pty_meta.iter() {
            sessions.push(ActiveSessionInfo {
                session_key: *key,
                session_name: meta.session_name.clone(),
                agent_id: None,
                execution_mode: "pty".to_string(),
                started_at: meta.started_at.clone(),
                task_id: meta.task_id,
                task_name: meta.task_name.clone(),
                branch_name: meta.branch_name.clone(),
                acp_session_id: None,
                supports_session_list: false,
                supports_session_load: false,
                supports_session_close: false,
            });
        }
    }

    sessions.sort_by(|a, b| a.started_at.cmp(&b.started_at));
    Ok(sessions)
}

/// List ACP sessions available for a given agent via a one-shot maestro-server connection.
/// Applies user-defined aliases over agent-provided titles. When the full list is returned
/// (no next page), prunes stale aliases for sessions the agent no longer knows about.
#[tauri::command]
#[specta::specta]
pub async fn list_acp_sessions(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    agent_id: String,
    cwd: String,
    connection_id: Option<i32>,
    cursor: Option<String>,
) -> Result<Vec<SessionListEntryDto>, String> {
    let (mut entries, next_cursor) = if let Some(conn_id) = connection_id {
        let maestro_path = {
            let cache = app_state.acp.discovery_cache.lock().await;
            cache.get(&Some(conn_id))
                .and_then(|e| e.maestro_server_path.clone())
                .ok_or_else(|| format!(
                    "maestro-server path not cached for connection {}. Reconnect to refresh.",
                    conn_id
                ))?
        };
        let ssh = app_state.ssh.get_session(conn_id).await
            .ok_or_else(|| format!("No active SSH session for connection_id {}. Connect first.", conn_id))?;
        query_session_list_remote(&ssh, &maestro_path, &agent_id, &cwd, cursor).await?
    } else {
        query_session_list_local(&agent_id, &cwd, cursor).await?
    };

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

    // Overlay aliases over agent-provided titles
    for entry in &mut entries {
        if let Some(alias) = aliases.get(&entry.session_id) {
            entry.title = Some(alias.clone());
        }
    }

    // Prune stale aliases only when we have the complete list (no pagination)
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
            // No sessions at all — remove all aliases for this agent
            conn.execute(
                "DELETE FROM session_aliases WHERE project_id = ?1 AND agent_id = ?2",
                rusqlite::params![project_id, agent_id],
            ).map_err(|e| format!("Prune aliases failed: {}", e))?;
        }
    }

    Ok(entries)
}

/// Rename an ACP session by storing a user-defined display name in the local DB.
/// Only creates a DB entry on explicit rename — not on session creation.
/// Also updates the in-memory session_name if the session is currently active.
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
        conn.execute(
            "INSERT INTO session_aliases (project_id, agent_id, acp_session_id, display_name)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(project_id, agent_id, acp_session_id) DO UPDATE SET display_name = excluded.display_name",
            rusqlite::params![project_id, agent_id, acp_session_id, display_name],
        ).map_err(|e| format!("Upsert alias failed: {}", e))?;
    }

    // Update in-memory name if this session is currently active.
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

/// Close an ACP session stored on the agent server (not a live Tauri session).
#[tauri::command]
#[specta::specta]
pub async fn close_acp_session(
    app_state: State<'_, Arc<AppState>>,
    agent_id: String,
    session_id: String,
    cwd: String,
    connection_id: Option<i32>,
) -> Result<(), String> {
    if let Some(conn_id) = connection_id {
        let maestro_path = {
            let cache = app_state.acp.discovery_cache.lock().await;
            cache.get(&Some(conn_id))
                .and_then(|e| e.maestro_server_path.clone())
                .ok_or_else(|| format!(
                    "maestro-server path not cached for connection {}. Reconnect to refresh.",
                    conn_id
                ))?
        };
        let ssh = app_state.ssh.get_session(conn_id).await
            .ok_or_else(|| format!("No active SSH session for connection_id {}. Connect first.", conn_id))?;
        query_session_close_remote(&ssh, &maestro_path, &agent_id, &session_id, &cwd).await
    } else {
        query_session_close_local(&agent_id, &session_id, &cwd).await
    }
}

/// Load an existing ACP session — spawns a full session that resumes from a stored agent session.
#[tauri::command]
#[specta::specta]
pub async fn load_acp_session(
    app_state: State<'_, Arc<AppState>>,
    agent_id: String,
    acp_session_id: String,
    cwd: String,
    connection_id: Option<i32>,
    session_name: Option<String>,
) -> Result<i32, String> {
    let log_id = app_state.pty.session_counter.fetch_add(1, std::sync::atomic::Ordering::Relaxed);

    if let Some(conn_id) = connection_id {
        let maestro_path = {
            let cache = app_state.acp.discovery_cache.lock().await;
            cache.get(&Some(conn_id))
                .and_then(|e| e.maestro_server_path.clone())
                .ok_or_else(|| format!(
                    "maestro-server path not cached for connection {}. Reconnect to refresh.",
                    conn_id
                ))?
        };
        let ssh = app_state.ssh.get_session(conn_id).await
            .ok_or_else(|| format!("No active SSH session for connection_id {}. Connect first.", conn_id))?;
        spawn_loaded_acp_session_remote(
            &agent_id, &cwd, log_id, &acp_session_id,
            &app_state, &ssh, &maestro_path, session_name,
        ).await?;
    } else {
        spawn_loaded_acp_session(
            &agent_id, &cwd, log_id, &acp_session_id,
            &app_state, session_name,
        ).await?;
    }

    app_state.app_handle.emit("sessions-changed", ()).ok();
    Ok(log_id)
}

// ============================================================================
// One-shot session list/close helpers
// ============================================================================

async fn query_session_list_local(
    agent_id: &str,
    cwd: &str,
    cursor: Option<String>,
) -> Result<(Vec<SessionListEntryDto>, Option<String>), String> {
    let msg = MaestroRpcMessage::Request(ServerRequest::SessionList(SessionListRequest {
        agent_id: agent_id.to_string(),
        cwd: cwd.to_string(),
        cursor,
    }));
    let result = crate::acp::rpc::one_shot_rpc_local(&msg, 15).await?;
    match result {
        Some(MaestroRpcMessage::Response(ServerResponse::SessionListOk(resp))) => Ok((
            resp.sessions.into_iter().map(|e| SessionListEntryDto { session_id: e.session_id, title: e.title, updated_at: e.updated_at }).collect(),
            resp.next_cursor,
        )),
        Some(MaestroRpcMessage::Response(ServerResponse::Error(e))) => Err(e.message),
        _ => Err("No valid SessionListOk response from local maestro-server".to_string()),
    }
}

async fn query_session_list_remote(
    ssh: &crate::ssh::RemoteSshSession,
    maestro_server_path: &str,
    agent_id: &str,
    cwd: &str,
    cursor: Option<String>,
) -> Result<(Vec<SessionListEntryDto>, Option<String>), String> {
    let msg = MaestroRpcMessage::Request(ServerRequest::SessionList(SessionListRequest {
        agent_id: agent_id.to_string(),
        cwd: cwd.to_string(),
        cursor,
    }));
    let result = crate::acp::rpc::one_shot_rpc_remote(ssh, maestro_server_path, &msg, 30).await?;
    match result {
        Some(MaestroRpcMessage::Response(ServerResponse::SessionListOk(resp))) => Ok((
            resp.sessions.into_iter().map(|e| SessionListEntryDto { session_id: e.session_id, title: e.title, updated_at: e.updated_at }).collect(),
            resp.next_cursor,
        )),
        Some(MaestroRpcMessage::Response(ServerResponse::Error(e))) => Err(e.message),
        _ => Err("No valid SessionListOk response from remote maestro-server".to_string()),
    }
}

async fn query_session_close_local(
    agent_id: &str,
    session_id: &str,
    cwd: &str,
) -> Result<(), String> {
    let msg = MaestroRpcMessage::Request(ServerRequest::SessionClose(SessionCloseRequest {
        agent_id: agent_id.to_string(),
        session_id: session_id.to_string(),
        cwd: cwd.to_string(),
    }));
    let result = crate::acp::rpc::one_shot_rpc_local(&msg, 15).await?;
    match result {
        Some(MaestroRpcMessage::Response(ServerResponse::SessionCloseOk)) => Ok(()),
        Some(MaestroRpcMessage::Response(ServerResponse::Error(e))) => Err(e.message),
        _ => Err("No valid SessionCloseOk response from local maestro-server".to_string()),
    }
}

async fn query_session_close_remote(
    ssh: &crate::ssh::RemoteSshSession,
    maestro_server_path: &str,
    agent_id: &str,
    session_id: &str,
    cwd: &str,
) -> Result<(), String> {
    let msg = MaestroRpcMessage::Request(ServerRequest::SessionClose(SessionCloseRequest {
        agent_id: agent_id.to_string(),
        session_id: session_id.to_string(),
        cwd: cwd.to_string(),
    }));
    let result = crate::acp::rpc::one_shot_rpc_remote(ssh, maestro_server_path, &msg, 30).await?;
    match result {
        Some(MaestroRpcMessage::Response(ServerResponse::SessionCloseOk)) => Ok(()),
        Some(MaestroRpcMessage::Response(ServerResponse::Error(e))) => Err(e.message),
        _ => Err("No valid SessionCloseOk response from remote maestro-server".to_string()),
    }
}

// ============================================================================
// Session load (resume existing ACP session)
// ============================================================================

/// Spawn a new Tauri ACP session that loads/resumes an existing agent-side session.
/// Uses SessionLoad protocol instead of Spawn.
async fn spawn_loaded_acp_session(
    agent_id: &str,
    cwd: &str,
    log_id: i32,
    acp_session_id: &str,
    app_state: &Arc<crate::db::AppState>,
    session_name: Option<String>,
) -> Result<(), String> {
    use crate::acp::transport::SessionLoadRequest;
    use std::process::Stdio;

    let server_path = which::which("maestro-server")
        .map_err(|e| format!("maestro-server not found on PATH: {}", e))?;

    let mut child = tokio::process::Command::new(server_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("Failed to spawn maestro-server: {}", e))?;

    let child_stdin = child.stdin.take().expect("child stdin must be piped");
    let mut child_stdout = child.stdout.take().expect("child stdout must be piped");
    let mut stdin_writer = tokio::io::BufWriter::new(child_stdin);

    use tokio::io::AsyncWriteExt;
    let handshake = MaestroRpcMessage::Request(ServerRequest::Handshake(HandshakeRequest {
        protocol_version: PROTOCOL_VERSION,
    }));
    write_message(&mut stdin_writer, &handshake)
        .await
        .map_err(|e| format!("write failed: {}", e))?;
    stdin_writer.flush().await.map_err(|e| format!("flush failed: {}", e))?;
    crate::acp::manager::perform_handshake_local(&mut child_stdout).await?;

    let load_req = MaestroRpcMessage::Request(ServerRequest::SessionLoad(SessionLoadRequest {
        agent_id: agent_id.to_string(),
        session_id: session_id_for(log_id),
        resume_session_id: acp_session_id.to_string(),
        cwd: cwd.to_string(),
    }));
    write_message(&mut stdin_writer, &load_req)
        .await
        .map_err(|e| format!("write failed: {}", e))?;
    stdin_writer.flush().await.map_err(|e| format!("flush failed: {}", e))?;

    let (cancel_tx, cancel_rx) = tokio::sync::oneshot::channel::<()>();

    let models_cache: Arc<std::sync::Mutex<Option<crate::acp::transport::SessionModelState>>> = Arc::new(std::sync::Mutex::new(None));
    let capabilities_cache: Arc<std::sync::Mutex<Option<crate::acp::transport::PromptCapabilitiesInfo>>> = Arc::new(std::sync::Mutex::new(None));
    let pending_file_search: Arc<std::sync::Mutex<Option<tokio::sync::oneshot::Sender<Result<Vec<String>, String>>>>> = Arc::new(std::sync::Mutex::new(None));
    let pending_file_read: Arc<std::sync::Mutex<Option<tokio::sync::oneshot::Sender<Result<String, String>>>>> = Arc::new(std::sync::Mutex::new(None));
    let session_capabilities: Arc<std::sync::Mutex<crate::acp::SessionCapabilitiesCache>> = Arc::new(std::sync::Mutex::new(crate::acp::SessionCapabilitiesCache::default()));
    let acp_session_id_cache: Arc<std::sync::Mutex<Option<String>>> = Arc::new(std::sync::Mutex::new(Some(acp_session_id.to_string())));
    let replay_buffer: Arc<std::sync::Mutex<Option<Vec<serde_json::Value>>>> = Arc::new(std::sync::Mutex::new(Some(Vec::new())));

    let acp_process = crate::acp::AcpProcess {
        writer: crate::acp::AcpTransportWriter::Local(stdin_writer),
        child: Some(child),
        reader_cancel_tx: Some(cancel_tx),
        models: Arc::clone(&models_cache),
        prompt_capabilities: Arc::clone(&capabilities_cache),
        cwd: cwd.to_string(),
        pending_file_search: Arc::clone(&pending_file_search),
        pending_file_read: Arc::clone(&pending_file_read),
        session_name,
        agent_id_meta: agent_id.to_string(),
        started_at: chrono::Utc::now().to_rfc3339(),
        task_id: None,
        task_name: None,
        branch_name: None,
        acp_session_id: Arc::clone(&acp_session_id_cache),
        session_capabilities: Arc::clone(&session_capabilities),
        replay_buffer: Arc::clone(&replay_buffer),
    };

    app_state.acp.sessions.lock().await.insert(log_id, acp_process);

    crate::acp::manager::spawn_reader_task(
        child_stdout,
        log_id,
        app_state.app_handle.clone(),
        Arc::clone(app_state),
        cancel_rx,
        models_cache,
        capabilities_cache,
        pending_file_search,
        pending_file_read,
        session_capabilities,
        acp_session_id_cache,
        replay_buffer,
    );

    Ok(())
}

async fn spawn_loaded_acp_session_remote(
    agent_id: &str,
    cwd: &str,
    log_id: i32,
    acp_session_id: &str,
    app_state: &Arc<crate::db::AppState>,
    ssh_session: &crate::ssh::RemoteSshSession,
    maestro_server_path: &str,
    session_name: Option<String>,
) -> Result<(), String> {
    use crate::acp::transport::SessionLoadRequest;

    let channel = ssh_session
        .open_exec_channel(maestro_server_path)
        .await
        .map_err(|e| format!("Failed to open remote ACP channel for load: {}", e))?;

    let (mut read_half, write_half) = channel.split();

    {
        use tokio::io::AsyncWriteExt;
        let handshake = MaestroRpcMessage::Request(ServerRequest::Handshake(HandshakeRequest {
            protocol_version: PROTOCOL_VERSION,
        }));
        let mut writer = write_half.make_writer();
        write_message(&mut writer, &handshake)
            .await
            .map_err(|e| format!("remote handshake write failed: {}", e))?;
        writer.flush().await.map_err(|e| format!("remote handshake flush failed: {}", e))?;
    }
    crate::acp::manager::perform_handshake_remote(&mut read_half).await?;

    let (write_tx, mut write_rx) = tokio::sync::mpsc::channel::<Vec<u8>>(32);

    let load_req = MaestroRpcMessage::Request(ServerRequest::SessionLoad(SessionLoadRequest {
        agent_id: agent_id.to_string(),
        session_id: session_id_for(log_id),
        resume_session_id: acp_session_id.to_string(),
        cwd: cwd.to_string(),
    }));
    let load_bytes = crate::acp::manager::serialize_message(&load_req)?;
    write_tx.send(load_bytes).await
        .map_err(|_| "Failed to queue SessionLoad for remote channel".to_string())?;

    tokio::spawn(async move {
        use tokio::io::AsyncWriteExt;
        let mut writer = write_half.make_writer();
        while let Some(bytes) = write_rx.recv().await {
            if writer.write_all(&bytes).await.is_err() {
                break;
            }
            let _ = writer.flush().await;
        }
    });

    let (cancel_tx, cancel_rx) = tokio::sync::oneshot::channel::<()>();

    let models_cache: Arc<std::sync::Mutex<Option<crate::acp::transport::SessionModelState>>> = Arc::new(std::sync::Mutex::new(None));
    let capabilities_cache: Arc<std::sync::Mutex<Option<crate::acp::transport::PromptCapabilitiesInfo>>> = Arc::new(std::sync::Mutex::new(None));
    let pending_file_search: Arc<std::sync::Mutex<Option<tokio::sync::oneshot::Sender<Result<Vec<String>, String>>>>> = Arc::new(std::sync::Mutex::new(None));
    let pending_file_read: Arc<std::sync::Mutex<Option<tokio::sync::oneshot::Sender<Result<String, String>>>>> = Arc::new(std::sync::Mutex::new(None));
    let session_capabilities: Arc<std::sync::Mutex<crate::acp::SessionCapabilitiesCache>> = Arc::new(std::sync::Mutex::new(crate::acp::SessionCapabilitiesCache::default()));
    let acp_session_id_cache: Arc<std::sync::Mutex<Option<String>>> = Arc::new(std::sync::Mutex::new(Some(acp_session_id.to_string())));
    let replay_buffer: Arc<std::sync::Mutex<Option<Vec<serde_json::Value>>>> = Arc::new(std::sync::Mutex::new(Some(Vec::new())));

    let acp_process = crate::acp::AcpProcess {
        writer: crate::acp::AcpTransportWriter::RemoteSsh(write_tx),
        child: None,
        reader_cancel_tx: Some(cancel_tx),
        models: Arc::clone(&models_cache),
        prompt_capabilities: Arc::clone(&capabilities_cache),
        cwd: cwd.to_string(),
        pending_file_search: Arc::clone(&pending_file_search),
        pending_file_read: Arc::clone(&pending_file_read),
        session_name,
        agent_id_meta: agent_id.to_string(),
        started_at: chrono::Utc::now().to_rfc3339(),
        task_id: None,
        task_name: None,
        branch_name: None,
        acp_session_id: Arc::clone(&acp_session_id_cache),
        session_capabilities: Arc::clone(&session_capabilities),
        replay_buffer: Arc::clone(&replay_buffer),
    };

    app_state.acp.sessions.lock().await.insert(log_id, acp_process);

    crate::acp::manager::spawn_remote_reader_task(
        read_half,
        log_id,
        app_state.app_handle.clone(),
        Arc::clone(app_state),
        cancel_rx,
        models_cache,
        capabilities_cache,
        pending_file_search,
        pending_file_read,
        session_capabilities,
        acp_session_id_cache,
        replay_buffer,
    );

    Ok(())
}

// ── Agent models cache ────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct AgentModelsCache {
    pub agent_id: String,
    pub models: Vec<AcpModelInfo>,
    pub fetched_at: String,
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
        buf.take().unwrap_or_default()
    };
    for payload in buffered {
        let _ = app_state.app_handle.emit(&format!("acp://session-update/{}", log_id), &payload);
    }
    Ok(())
}

/// Get cached models for an agent from the project's .maestro/agent_models_cache.json.
/// Returns None if no cache entry exists for the agent.
#[tauri::command]
#[specta::specta]
pub async fn get_agent_models_cache(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    agent_id: String,
) -> Result<Option<AgentModelsCache>, String> {
    let (path, connection_id) = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        conn.query_row(
            "SELECT path, connection_id FROM projects WHERE id = ?",
            [project_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<i32>>(1)?)),
        ).map_err(|_| format!("Project {} not found", project_id))?
    };

    let map = if let Some(conn_id) = connection_id {
        let session = app_state.ssh.get_session(conn_id).await
            .ok_or_else(|| format!("No active SSH session for connection {}", conn_id))?;
        let cache_path = format!("{}/.maestro/agent_models_cache.json", path);
        match session.execute_command(&format!("cat {}", crate::git::remote::shell_quote(&cache_path))).await {
            Ok(output) => serde_json::from_str::<crate::models::project_config::AgentModelsMap>(&output)
                .unwrap_or_default(),
            Err(_) => Default::default(),
        }
    } else {
        crate::models::project_config::load_agent_models_cache(&path).unwrap_or_default()
    };

    Ok(map.get(&agent_id).map(|entry| AgentModelsCache {
        agent_id: agent_id.clone(),
        models: entry.models.iter().map(|m| AcpModelInfo {
            model_id: m.model_id.clone(),
            name: m.name.clone(),
            description: m.description.clone(),
        }).collect(),
        fetched_at: entry.fetched_at.clone(),
    }))
}

/// Spawn a one-shot agent session to discover its available models, then cache the result
/// in the project's .maestro/agent_models_cache.json.
#[tauri::command]
#[specta::specta]
pub async fn refresh_agent_models(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    agent_id: String,
) -> Result<AgentModelsCache, String> {
    use crate::acp::transport::SpawnRequest;

    let (path, connection_id) = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        conn.query_row(
            "SELECT path, connection_id FROM projects WHERE id = ?",
            [project_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<i32>>(1)?)),
        ).map_err(|_| format!("Project {} not found", project_id))?
    };

    let spawn_req = MaestroRpcMessage::Request(ServerRequest::Spawn(SpawnRequest {
        agent_id: agent_id.clone(),
        session_id: "probe-0".to_string(),
        cwd: path.clone(),
    }));

    let models = if let Some(conn_id) = connection_id {
        probe_models_remote(&app_state, conn_id, spawn_req).await?
    } else {
        probe_models_local(spawn_req).await?
    };

    let fetched_at = chrono::Utc::now().to_rfc3339();
    let entry = crate::models::project_config::AgentModelEntry {
        models: models.iter().map(|m| crate::models::project_config::ProjectModelInfo {
            model_id: m.model_id.clone(),
            name: m.name.clone(),
            description: m.description.clone(),
        }).collect(),
        fetched_at: fetched_at.clone(),
    };

    // Load existing cache, insert/update, save back
    if let Some(conn_id) = connection_id {
        let session = app_state.ssh.get_session(conn_id).await
            .ok_or_else(|| format!("No active SSH session for connection {}", conn_id))?;
        let cache_path_str = format!("{}/.maestro/agent_models_cache.json", path);
        let maestro_dir = format!("{}/.maestro", path);
        let mut map: crate::models::project_config::AgentModelsMap = match session
            .execute_command(&format!("cat {}", crate::git::remote::shell_quote(&cache_path_str)))
            .await
        {
            Ok(output) => serde_json::from_str(&output).unwrap_or_default(),
            Err(_) => Default::default(),
        };
        map.insert(agent_id.clone(), entry);
        let json = serde_json::to_string_pretty(&map)
            .map_err(|e| format!("Serialization failed: {}", e))?;
        session.execute_command(&format!(
            "mkdir -p {} && printf '%s' {} > {}",
            crate::git::remote::shell_quote(&maestro_dir),
            crate::git::remote::shell_quote(&json),
            crate::git::remote::shell_quote(&cache_path_str),
        )).await.map_err(|e| format!("SSH write failed: {}", e))?;
    } else {
        let mut map = crate::models::project_config::load_agent_models_cache(&path)
            .unwrap_or_default();
        map.insert(agent_id.clone(), entry);
        crate::models::project_config::save_agent_models_cache(&path, &map)?;
    }

    Ok(AgentModelsCache { agent_id, models, fetched_at })
}

async fn probe_models_local(spawn_req: MaestroRpcMessage) -> Result<Vec<AcpModelInfo>, String> {
    let result = crate::acp::rpc::one_shot_rpc_local(&spawn_req, 30).await?;
    extract_models_from_spawn_ok(result)
}

async fn probe_models_remote(
    app_state: &Arc<crate::db::AppState>,
    conn_id: i32,
    spawn_req: MaestroRpcMessage,
) -> Result<Vec<AcpModelInfo>, String> {
    let maestro_path = {
        let cache = app_state.acp.discovery_cache.lock().await;
        cache.get(&Some(conn_id))
            .and_then(|e| e.maestro_server_path.clone())
            .ok_or_else(|| format!(
                "maestro-server path not cached for connection {}. Reconnect to refresh.",
                conn_id
            ))?
    };
    let ssh = app_state.ssh.get_session(conn_id).await
        .ok_or_else(|| format!("No active SSH session for connection_id {}", conn_id))?;
    let result = crate::acp::rpc::one_shot_rpc_remote(&ssh, &maestro_path, &spawn_req, 30).await?;
    extract_models_from_spawn_ok(result)
}

fn extract_models_from_spawn_ok(result: Option<MaestroRpcMessage>) -> Result<Vec<AcpModelInfo>, String> {
    match result {
        Some(MaestroRpcMessage::Response(ServerResponse::SpawnOk(resp))) => {
            Ok(resp.models.map(|m| m.available_models.into_iter().map(|mi| AcpModelInfo {
                model_id: mi.model_id,
                name: mi.name,
                description: mi.description,
            }).collect()).unwrap_or_default())
        }
        Some(MaestroRpcMessage::Response(ServerResponse::Error(e))) => Err(e.message),
        _ => Err("No valid SpawnOk response from maestro-server".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use crate::acp::transport::{MaestroRpcMessage, ServerRequest, PromptRequest, PermissionResponse};
    use super::session_id_for;

    /// PERSIST-03: send_acp_prompt constructs a PromptRequest with correct session_id and content.
    /// Verifies the exact JSON shape that write_to_acp_session will frame and send to maestro-server.
    #[test]
    fn test_send_acp_prompt_message_structure() {
        let log_id: i32 = 42;
        let content = "fix the auth bug";
        let session_id = session_id_for(log_id);

        let msg = MaestroRpcMessage::Request(ServerRequest::Prompt(PromptRequest {
            session_id: session_id.clone(),
            content: serde_json::Value::String(content.to_string()),
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
    /// Verifies that option_id=Some and option_id=None produce distinct, correct JSON.
    #[test]
    fn test_respond_acp_permission_message_structure() {
        let log_id: i32 = 7;
        let request_id = "perm-001";
        let session_id = session_id_for(log_id);

        // option_id=Some
        let allow_msg = MaestroRpcMessage::Request(ServerRequest::PermitResponse(PermissionResponse {
            session_id: session_id.clone(),
            request_id: request_id.to_string(),
            option_id: Some("allow_once".into()),
        }));
        let allow_json = serde_json::to_string(&allow_msg).unwrap();
        assert!(allow_json.contains("\"type\":\"permit_response\""), "must have type=permit_response");
        assert!(allow_json.contains("\"option_id\""), "option_id must be present");
        assert!(allow_json.contains(&format!("\"request_id\":\"{}\"", request_id)));

        // option_id=None (cancelled)
        let cancel_msg = MaestroRpcMessage::Request(ServerRequest::PermitResponse(PermissionResponse {
            session_id: session_id.clone(),
            request_id: request_id.to_string(),
            option_id: None,
        }));
        let cancel_json = serde_json::to_string(&cancel_msg).unwrap();
        assert_ne!(allow_json, cancel_json, "allow and cancel must produce different JSON");

        // Roundtrip
        let back: MaestroRpcMessage = serde_json::from_str(&allow_json).unwrap();
        assert_eq!(allow_msg, back);
    }

}
