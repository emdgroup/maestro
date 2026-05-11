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
    MaestroRpcMessage, ServerRequest,
    PromptRequest, CancelRequest, InterruptTurnRequest, PermissionResponse,
    ElicitationResponse, SetModelRequest, SetModeRequest,
    FileSearchRequest, FileReadRequest,
    SessionListRequest,
    SessionCloseRequest,
    CheckToolsResponse,
};
use tokio::sync::oneshot;

fn session_id_for(log_id: i32) -> String {
    format!("session-{}", log_id)
}

/// Resolve SSH session + maestro-server path for a remote connection.
/// Errors with user-readable messages if either is missing.
async fn resolve_remote_context(
    app_state: &AppState,
    conn_id: i32,
) -> Result<(crate::ssh::RemoteSshSession, String), String> {
    let maestro_path = app_state
        .acp
        .discovery_cache
        .lock()
        .await
        .get(&Some(conn_id))
        .and_then(|e| e.maestro_server_path.clone())
        .ok_or_else(|| {
            format!("maestro-server path not cached for connection {conn_id}. Reconnect to refresh.")
        })?;
    let ssh = app_state
        .ssh
        .get_session(conn_id)
        .await
        .ok_or_else(|| format!("No active SSH session for connection_id {conn_id}. Connect first."))?;
    Ok((ssh, maestro_path))
}

/// Read a cached field from a live ACP session and map it to a DTO.
/// Returns None if the session is not found or the field has not been populated yet.
async fn get_session_cache<T, U>(
    app_state: &AppState,
    log_id: i32,
    field: impl Fn(&crate::acp::AcpProcess) -> &Arc<std::sync::Mutex<Option<T>>>,
    map: impl FnOnce(T) -> U,
) -> Result<Option<U>, String>
where
    T: Clone,
{
    let arc = {
        let sessions = app_state.acp.sessions.lock().await;
        sessions.get(&log_id).map(|s| Arc::clone(field(s)))
    };
    let Some(arc) = arc else { return Ok(None) };
    let cloned = arc.lock().map_err(|e| format!("Lock poisoned: {e}"))?.clone();
    Ok(cloned.map(map))
}

/// Send a request to a session and await a oneshot response with a 15-second timeout.
/// Used for file search and file read operations.
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

    // Compute SHA and (for remote) acquire SSH session — both fast and cold paths need these.
    let (session_start_sha, ssh_opt) = if let Some(conn_id) = connection_id {
        let ssh = app_state.ssh.get_session(conn_id).await
            .ok_or_else(|| format!("No active SSH session for connection_id {}. Connect first.", conn_id))?;
        let git_conn = crate::models::GitConnection::Remote {
            ssh: std::sync::Arc::new(ssh.clone()),
            remote_path: cwd.clone(),
        };
        let sha = crate::git::run_git_in_dir(&git_conn, &cwd, &["rev-parse", "HEAD"])
            .await.ok().map(|s| s.trim().to_string());
        (sha, Some((conn_id, ssh)))
    } else {
        let git_conn = crate::models::GitConnection::Local { path: cwd.clone() };
        let sha = crate::git::run_git_in_dir(&git_conn, &cwd, &["rev-parse", "HEAD"])
            .await.ok().map(|s| s.trim().to_string());
        (sha, None)
    };

    // Fast path: if a connection server is running, route through shared server.
    if crate::acp::try_spawn_via_connection_server(
        connection_id, Some(project_id), &agent_id, &cwd, &session_id, session_name.clone(),
        None, None, branch_name.clone(), session_start_sha.clone(), log_id, &app_state,
    ).await? {
        app_state.app_handle.emit("sessions-changed", ()).ok();
        return Ok(log_id);
    }

    // Cold path: spawn dedicated maestro-server subprocess.
    match ssh_opt {
        Some((conn_id, ssh)) => {
            let maestro_path = {
                let cache = app_state.acp.discovery_cache.lock().await;
                cache.get(&Some(conn_id))
                    .and_then(|e| e.maestro_server_path.clone())
                    .ok_or_else(|| format!(
                        "maestro-server path not cached for connection {}. Reconnect to refresh.",
                        conn_id
                    ))?
            };
            crate::acp::spawn_acp_session_cold(
                crate::acp::TransportTarget::Remote { ssh: &ssh, server_path: &maestro_path },
                &agent_id, &cwd, log_id, &session_id, &app_state,
                session_name, None, None, branch_name, Some(project_id), Some(conn_id), session_start_sha,
            ).await?;
        }
        None => {
            crate::acp::spawn_acp_session_cold(
                crate::acp::TransportTarget::Local,
                &agent_id, &cwd, log_id, &session_id, &app_state,
                session_name, None, None, branch_name, Some(project_id), None, session_start_sha,
            ).await?;
        }
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
    get_session_cache(&app_state, log_id, |s| &s.models, |m| AcpSessionModelState {
        current_model_id: m.current_model_id,
        available_models: m.available_models.into_iter().map(|mi| AcpModelInfo {
            model_id: mi.model_id,
            name: mi.name,
            description: mi.description,
        }).collect(),
    }).await
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct AcpModeInfo {
    pub mode_id: String,
    pub name: String,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct AcpSessionModeState {
    pub current_mode_id: String,
    pub available_modes: Vec<AcpModeInfo>,
}

/// Send a SetMode request to change the active mode for a running ACP session.
#[tauri::command]
#[specta::specta]
pub async fn set_acp_mode(
    app_state: State<'_, Arc<AppState>>,
    log_id: i32,
    mode_id: String,
) -> Result<(), String> {
    let session_id = session_id_for(log_id);
    let msg = MaestroRpcMessage::Request(ServerRequest::SetMode(SetModeRequest {
        session_id,
        mode_id,
    }));
    crate::acp::write_to_acp_session(&app_state, log_id, &msg).await
}

/// Get cached mode state for a running ACP session.
/// Returns None if the session hasn't reported modes yet or session not found.
#[tauri::command]
#[specta::specta]
pub async fn get_acp_modes(
    app_state: State<'_, Arc<AppState>>,
    log_id: i32,
) -> Result<Option<AcpSessionModeState>, String> {
    get_session_cache(&app_state, log_id, |s| &s.modes, |m| AcpSessionModeState {
        current_mode_id: m.current_mode_id,
        available_modes: m.available_modes.into_iter().map(|mi| AcpModeInfo {
            mode_id: mi.mode_id,
            name: mi.name,
            description: mi.description,
        }).collect(),
    }).await
}

/// Get cached prompt capabilities for a running ACP session.
/// Returns None if the session hasn't reported capabilities yet or session not found.
#[tauri::command]
#[specta::specta]
pub async fn get_acp_capabilities(
    app_state: State<'_, Arc<AppState>>,
    log_id: i32,
) -> Result<Option<AcpPromptCapabilities>, String> {
    get_session_cache(&app_state, log_id, |s| &s.prompt_capabilities, |c| AcpPromptCapabilities {
        embedded_context: c.embedded_context,
        image: c.image,
        audio: c.audio,
    }).await
}

// ── Preflight ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct PreflightCheck {
    pub ok: bool,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct ToolCheckEntry {
    pub tool: String,
    pub available: bool,
    pub version: Option<String>,
    /// Agent IDs that require this tool to spawn.
    pub required_by: Vec<String>,
    /// `true` for `git` — the session cannot function without it.
    pub mandatory: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct PreflightResult {
    pub maestro_server: PreflightCheck,
    pub agents: Vec<DiscoveredAgent>,
    pub tool_checks: Vec<ToolCheckEntry>,
}

/// Validate the environment for a connection and boot the persistent server.
///
/// Idempotent: if the server is already running the spawn step is skipped and only
/// agent discovery + tool checks are refreshed. The server process lives until app quit.
#[tauri::command]
#[specta::specta]
pub async fn preflight_connection(
    app_state: State<'_, Arc<AppState>>,
    connection_id: Option<i32>,
) -> Result<PreflightResult, String> {
    let server_already_running = app_state
        .acp
        .connection_servers
        .lock()
        .await
        .contains_key(&connection_id);

    if !server_already_running {
        match connection_id {
            Some(conn_id) => {
                let ssh = app_state
                    .ssh
                    .get_session(conn_id)
                    .await
                    .ok_or_else(|| {
                        format!("No active SSH session for connection_id {}. Connect first.", conn_id)
                    })?;
                let cached_path = app_state
                    .acp
                    .discovery_cache
                    .lock()
                    .await
                    .get(&Some(conn_id))
                    .and_then(|e| e.maestro_server_path.clone());
                let maestro_path = match cached_path {
                    Some(p) => p,
                    None => {
                        let deploy = crate::acp::deploy::ensure_remote_server(
                            &ssh,
                            &app_state.app_handle,
                            conn_id,
                        )
                        .await
                        .map_err(|e| format!("Failed to deploy maestro-server: {}", e))?;
                        let path = deploy.path.clone();
                        app_state
                            .acp
                            .discovery_cache
                            .lock()
                            .await
                            .entry(Some(conn_id))
                            .or_insert_with(|| AgentDiscoveryCacheEntry {
                                result: AgentDiscoveryResult {
                                    maestro_server_available: true,
                                    agents: Vec::new(),
                                    error: None,
                                },
                                maestro_server_path: None,
                                fetched_at: std::time::Instant::now(),
                            })
                            .maestro_server_path = Some(path.clone());
                        path
                    }
                };
                crate::acp::spawn_connection_server(
                    Some(conn_id),
                    crate::acp::TransportTarget::Remote { ssh: &ssh, server_path: &maestro_path },
                    &app_state,
                )
                .await
                .map_err(|e| format!("Failed to start maestro-server: {}", e))?;
            }
            None => {
                crate::acp::resolve::resolve_server_path_standalone()
                    .map_err(|e| format!("maestro-server not found: {}", e))?;
                crate::acp::spawn_connection_server(
                    None,
                    crate::acp::TransportTarget::Local,
                    &app_state,
                )
                .await
                .map_err(|e| format!("Failed to start maestro-server: {}", e))?;
            }
        }
    }

    let agents = crate::acp::query_list_agents_via_connection_server(connection_id, &app_state)
        .await
        .unwrap_or_default();

    let mut tools_to_check: Vec<String> = agents
        .iter()
        .flat_map(|a| a.spawn_deps.iter().cloned())
        .collect::<std::collections::HashSet<_>>()
        .into_iter()
        .collect();
    if !tools_to_check.iter().any(|t| t == "git") {
        tools_to_check.push("git".to_string());
    }

    let tool_results = crate::acp::query_check_tools_via_server(connection_id, tools_to_check, &app_state)
        .await
        .unwrap_or_else(|_| CheckToolsResponse { results: Vec::new() });

    let mandatory_tools: std::collections::HashSet<&str> = ["git"].into();
    let tool_checks: Vec<ToolCheckEntry> = tool_results
        .results
        .into_iter()
        .map(|r| {
            let required_by: Vec<String> = agents
                .iter()
                .filter(|a| a.spawn_deps.contains(&r.tool))
                .map(|a| a.id.clone())
                .collect();
            ToolCheckEntry {
                mandatory: mandatory_tools.contains(r.tool.as_str()),
                tool: r.tool,
                available: r.available,
                version: r.version,
                required_by,
            }
        })
        .collect();

    {
        let mut cache = app_state.acp.discovery_cache.lock().await;
        let maestro_server_path = cache.get(&connection_id).and_then(|e| e.maestro_server_path.clone());
        cache.insert(connection_id, AgentDiscoveryCacheEntry {
            result: AgentDiscoveryResult {
                maestro_server_available: true,
                agents: agents.clone(),
                error: None,
            },
            maestro_server_path,
            fetched_at: std::time::Instant::now(),
        });
    }

    Ok(PreflightResult {
        maestro_server: PreflightCheck { ok: true, message: None },
        agents,
        tool_checks,
    })
}

/// Run agent discovery and store result in the AppState cache.
/// Fire-and-forget safe: returns silently on errors (result stored with error field set).
/// Called at SSH connect time (connection_id = Some) and on-demand from `discover_agents` IPC.
/// For local discovery (connection_id = None), called on first `discover_agents` query.
/// `known_maestro_path`: skip `ensure_remote_server` when caller already has the path.
pub async fn prefetch_agent_discovery(
    app_state: Arc<AppState>,
    connection_id: Option<i32>,
    known_maestro_path: Option<String>,
) {
    match connection_id {
        Some(conn_id) => {
            // Fast path: route through already-running connection server — no new process spawn.
            let has_connection_server = app_state.acp.connection_servers.lock().await.contains_key(&Some(conn_id));
            if has_connection_server {
                let maestro_path = known_maestro_path.or_else(|| {
                    let cache = app_state.acp.discovery_cache.try_lock().ok();
                    cache.and_then(|c| c.get(&Some(conn_id)).and_then(|e| e.maestro_server_path.clone()))
                });
                let result = crate::acp::query_list_agents_via_connection_server(Some(conn_id), &app_state).await;
                let maestro_server_available = result.is_ok();
                let (agents, error) = match result {
                    Ok(a) => (a, None),
                    Err(e) => (Vec::new(), Some(e)),
                };
                let entry = AgentDiscoveryCacheEntry {
                    result: AgentDiscoveryResult { maestro_server_available, agents, error },
                    maestro_server_path: maestro_path,
                    fetched_at: std::time::Instant::now(),
                };
                app_state.acp.discovery_cache.lock().await.insert(Some(conn_id), entry);
                return;
            }

            // Slow path: no connection server yet — deploy + boot it, then query.
            let Some(ssh) = app_state.ssh.get_session(conn_id).await else {
                return;
            };
            let maestro_path = if let Some(p) = known_maestro_path {
                Some(p)
            } else {
                crate::acp::deploy::ensure_remote_server(&ssh, &app_state.app_handle, conn_id)
                    .await
                    .ok()
                    .map(|r| r.path)
            };
            let Some(path) = maestro_path else {
                app_state.acp.discovery_cache.lock().await.insert(Some(conn_id), AgentDiscoveryCacheEntry {
                    result: AgentDiscoveryResult { maestro_server_available: false, agents: Vec::new(), error: None },
                    maestro_server_path: None,
                    fetched_at: std::time::Instant::now(),
                });
                return;
            };
            if crate::acp::spawn_connection_server(
                Some(conn_id),
                crate::acp::TransportTarget::Remote { ssh: &ssh, server_path: &path },
                &app_state,
            ).await.is_err() {
                return;
            }
            let result = crate::acp::query_list_agents_via_connection_server(Some(conn_id), &app_state).await;
            let maestro_server_available = result.is_ok();
            let (agents, error) = match result { Ok(a) => (a, None), Err(e) => (Vec::new(), Some(e)) };
            app_state.acp.discovery_cache.lock().await.insert(Some(conn_id), AgentDiscoveryCacheEntry {
                result: AgentDiscoveryResult { maestro_server_available, agents, error },
                maestro_server_path: Some(path),
                fetched_at: std::time::Instant::now(),
            });
        }
        None => {
            let maestro_server_available = crate::acp::resolve::resolve_server_path_standalone().is_ok();
            if !maestro_server_available {
                app_state.acp.discovery_cache.lock().await.insert(None, AgentDiscoveryCacheEntry {
                    result: AgentDiscoveryResult { maestro_server_available: false, agents: Vec::new(), error: None },
                    maestro_server_path: None,
                    fetched_at: std::time::Instant::now(),
                });
                return;
            }
            if crate::acp::spawn_connection_server(None, crate::acp::TransportTarget::Local, &app_state)
                .await.is_err() {
                return;
            }
            let result = crate::acp::query_list_agents_via_connection_server(None, &app_state).await;
            let (agents, error) = match result { Ok(a) => (a, None), Err(e) => (Vec::new(), Some(e)) };
            app_state.acp.discovery_cache.lock().await.insert(None, AgentDiscoveryCacheEntry {
                result: AgentDiscoveryResult { maestro_server_available: true, agents, error },
                maestro_server_path: None,
                fetched_at: std::time::Instant::now(),
            });
        }
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
    prefetch_agent_discovery(arc, connection_id, None).await;

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
    session_file_rpc(&app_state, log_id, |s| &s.pending_file_search, |cwd| {
        MaestroRpcMessage::Request(ServerRequest::FileSearch(FileSearchRequest {
            cwd: cwd.to_string(),
            query,
            limit,
        }))
    })
    .await
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
    session_file_rpc(&app_state, log_id, |s| &s.pending_file_read, |cwd| {
        MaestroRpcMessage::Request(ServerRequest::FileRead(FileReadRequest {
            cwd: cwd.to_string(),
            relative_path,
        }))
    })
    .await
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct AcpSessionMeta {
    pub cwd: String,
    pub project_id: Option<i32>,
    pub session_start_sha: Option<String>,
}

/// Return metadata for a running ACP session needed to scope a session diff.
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

/// List ACP sessions available for a given agent via the persistent connection server.
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
    let resp = crate::acp::query_session_list_via_server(
        connection_id,
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
        crate::acp::manager::upsert_session_alias(&conn, project_id, &agent_id, &acp_session_id, &display_name)
            .map_err(|e| format!("Upsert alias failed: {}", e))?;
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
    crate::acp::query_session_close_via_server(
        connection_id,
        SessionCloseRequest { agent_id, session_id, cwd },
        &app_state,
    )
    .await
}

async fn try_session_load_via_connection_server(
    connection_id: Option<i32>,
    project_id: Option<i32>,
    agent_id: &str,
    acp_session_id: &str,
    cwd: &str,
    session_name: Option<String>,
    log_id: i32,
    app_state: &Arc<AppState>,
) -> Result<bool, String> {
    use crate::acp::transport::SessionLoadRequest;
    let writer_tx = {
        let servers = app_state.acp.connection_servers.lock().await;
        match servers.get(&connection_id) { Some(s) => s.writer_tx.clone(), None => return Ok(false) }
    };
    let load_msg = MaestroRpcMessage::Request(ServerRequest::SessionLoad(SessionLoadRequest {
        agent_id: agent_id.to_string(),
        session_id: session_id_for(log_id),
        resume_session_id: acp_session_id.to_string(),
        cwd: cwd.to_string(),
    }));
    let bytes = crate::acp::manager::serialize_message(&load_msg)?;

    // Register session BEFORE sending request so the shared reader can route
    // SessionUpdate messages into the replay buffer immediately.
    // Sending first risks the server replying before the session is in the map,
    // causing the shared reader to drop all history events silently.
    let (acp_process, _ctx) = crate::acp::AcpProcess::create(
        crate::acp::AcpProcessParams {
            writer: crate::acp::AcpTransportWriter::SharedServer(writer_tx.clone()),
            child: None,
            cancel_tx: None,
            cwd: cwd.to_string(),
            session_name,
            agent_id: agent_id.to_string(),
            project_id,
            connection_id,
            task_id: None,
            task_name: None,
            branch_name: None,
            session_start_sha: None,
            initial_acp_session_id: Some(acp_session_id.to_string()),
            enable_replay_buffer: true,
        },
        log_id,
        app_state.app_handle.clone(),
        Arc::clone(app_state),
    );
    crate::acp::manager::emit_cached_capabilities(&acp_process, project_id, agent_id, log_id, app_state).await;
    app_state.acp.sessions.lock().await.insert(log_id, acp_process);

    if writer_tx.send(bytes).await.is_err() {
        app_state.acp.sessions.lock().await.remove(&log_id);
        return Err("Connection server writer channel closed".to_string());
    }
    Ok(true)
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
    project_id: Option<i32>,
) -> Result<i32, String> {
    let log_id = app_state.pty.session_counter.fetch_add(1, std::sync::atomic::Ordering::Relaxed);

    // Fast path: if a connection server is running, route through shared server.
    if try_session_load_via_connection_server(
        connection_id, project_id, &agent_id, &acp_session_id, &cwd, session_name.clone(), log_id, &app_state,
    ).await? {
        app_state.app_handle.emit("sessions-changed", ()).ok();
        return Ok(log_id);
    }

    // Cold path: spawn dedicated maestro-server subprocess.
    match connection_id {
        Some(conn_id) => {
            let (ssh, maestro_path) = resolve_remote_context(&app_state, conn_id).await?;
            crate::acp::load_acp_session_cold(
                crate::acp::TransportTarget::Remote { ssh: &ssh, server_path: &maestro_path },
                &agent_id, &cwd, log_id, &acp_session_id, &app_state, session_name, Some(conn_id),
            ).await?;
        }
        None => {
            crate::acp::load_acp_session_cold(
                crate::acp::TransportTarget::Local,
                &agent_id, &cwd, log_id, &acp_session_id, &app_state, session_name, None,
            ).await?;
        }
    }

    app_state.app_handle.emit("sessions-changed", ()).ok();
    Ok(log_id)
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

/// Get cached models for an agent from the in-memory AgentCache.
/// Returns None if no session has been spawned for this agent yet.
#[tauri::command]
#[specta::specta]
pub async fn get_cached_agent_models(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    agent_id: String,
) -> Result<Option<AgentModelsCache>, String> {
    let cache = app_state.acp.agent_cache.lock().await;
    let entry = cache.get(&(project_id, agent_id.clone()));
    Ok(entry.and_then(|e| e.models.as_ref()).map(|state| AgentModelsCache {
        agent_id: agent_id.clone(),
        models: state.available_models.iter().map(|m| AcpModelInfo {
            model_id: m.model_id.clone(),
            name: m.name.clone(),
            description: m.description.clone(),
        }).collect(),
        fetched_at: chrono::Utc::now().to_rfc3339(),
    }))
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
