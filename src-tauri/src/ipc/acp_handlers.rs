//! IPC command handlers for ACP (Agent Control Protocol) session management.

use std::sync::Arc;
use std::time::Duration;
use tauri::State;
use tauri::Emitter;
use serde::{Deserialize, Serialize};
use specta::Type;

use std::collections::HashSet;
use crate::db::AppState;
use crate::acp::{PooledSession, SessionRequest, TaskMetadata, ConnectionKey};
use crate::models::worktree::{ActiveSessionInfo, ExecutionMode, SessionListEntryDto};

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct AcpPromptCapabilities {
    pub embedded_context: bool,
    pub image: bool,
    pub audio: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct AgentCatalogOptionValue {
    pub name: String,
    pub value: String,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct AgentCatalogOption {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub category: String,
    pub options: Vec<AgentCatalogOptionValue>,
    pub default_value: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct AgentCatalogCommand {
    pub name: String,
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct AgentSessionCapabilities {
    pub supports_session_list: bool,
    pub supports_session_load: bool,
    pub supports_session_close: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct AgentCacheResponse {
    pub config_options: Vec<AgentCatalogOption>,
    pub available_commands: Vec<AgentCatalogCommand>,
    pub prompt_capabilities: Option<AcpPromptCapabilities>,
    pub session_capabilities: AgentSessionCapabilities,
}

use crate::acp::registry::{DiscoveredAgent, AgentDiscoveryResult, AgentDiscoveryCacheEntry, ProjectAgentMatch};
use crate::acp::transport::{
    MaestroRpcMessage, ServerRequest,
    PromptRequest, CancelRequest, InterruptTurnRequest, PermissionResponse,
    ElicitationResponse, SetModelRequest, SetModeRequest, SetConfigOptionRequest,
    FileSearchRequest, FileReadRequest,
    SessionListRequest,
    SessionCloseRequest,
    CheckToolsResponse,
};
use tokio::sync::oneshot;

fn session_id_for(log_id: i32) -> String {
    format!("session-{}", log_id)
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

#[derive(Debug, Clone, Serialize, Type)]
#[specta(export)]
pub struct SpawnSessionResult {
    pub log_id: i32,
    pub ready: bool,
}

/// Spawn a pooled session for the given agent using the running connection server.
/// The session is stored in `app_state.acp.session_pool` and hidden from the active
/// sessions list until claimed by the user creating a session for that agent.
pub async fn spawn_pooled_session(
    app_state: &Arc<AppState>,
    project_id: i32,
    connection_key: ConnectionKey,
    agent_id: &str,
    cwd: &str,
) {
    let log_id = app_state.pty.session_counter.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let session_id = session_id_for(log_id);

    let req = SessionRequest {
        connection_key,
        agent_id: agent_id.to_string(),
        cwd: cwd.to_string(),
        log_id,
        session_name: None,
        project_id: Some(project_id),
        app_state: Arc::clone(app_state),
    };
    let spawned = crate::acp::try_spawn_via_connection_server(&session_id, TaskMetadata::default(), &req).await;

    if matches!(spawned, Ok(true)) {
        app_state.acp.session_pool.lock().await.insert(
            (project_id, agent_id.to_string()),
            PooledSession { log_id, session_id, cwd: cwd.to_string() },
        );
    }
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
    connection: crate::acp::ConnectionKey,
    worktree_branch: Option<String>,
    task_id: Option<i32>,
    task_name: Option<String>,
) -> Result<SpawnSessionResult, String> {
    let connection_id = connection.ssh_id();
    let wsl_connection_id = connection.wsl_id();

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

    // Pool claim: if a session was pre-warmed for this agent at the same cwd, reuse it instantly.
    // Worktree sessions have a different cwd than the pooled project-root session, so they skip
    // this path and proceed to a cold or connection-server spawn.
    {
        let mut pool = app_state.acp.session_pool.lock().await;
        if let Some(pooled) = pool.remove(&(project_id, agent_id.clone())) {
            if pooled.cwd == cwd {
                // Update metadata that wasn't known at warmup time.
                if let Some(proc) = app_state.acp.sessions.lock().await.get_mut(&pooled.log_id) {
                    proc.session_name = session_name;
                    proc.branch_name = branch_name;
                    proc.task_id = task_id;
                    proc.task_name = task_name;
                }
                drop(pool);

                // Replenish pool in background using the pooled cwd (project root, not the claimed cwd).
                let state = Arc::clone(&*app_state);
                let aid = agent_id.clone();
                let pool_cwd = pooled.cwd.clone();
                let pool_connection_key = connection;
                tokio::spawn(async move {
                    spawn_pooled_session(&state, project_id, pool_connection_key, &aid, &pool_cwd).await;
                });

                app_state.app_handle.emit("sessions-changed", ()).ok();
                return Ok(SpawnSessionResult { log_id: pooled.log_id, ready: true });
            } else {
                // cwd mismatch (worktree task) — put the pooled session back and fall through.
                pool.insert((project_id, agent_id.clone()), pooled);
            }
        }
    }

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
    let connection_key = connection;
    let req = SessionRequest {
        connection_key,
        agent_id: agent_id.clone(),
        cwd: cwd.clone(),
        log_id,
        session_name: session_name.clone(),
        project_id: Some(project_id),
        app_state: Arc::clone(&*app_state),
    };
    if crate::acp::try_spawn_via_connection_server(
        &session_id,
        TaskMetadata { task_id, task_name: task_name.clone(), branch_name: branch_name.clone(), session_start_sha: session_start_sha.clone() },
        &req,
    ).await? {
        app_state.app_handle.emit("sessions-changed", ()).ok();
        return Ok(SpawnSessionResult { log_id, ready: false });
    }

    // Cold path: spawn dedicated maestro-server subprocess.
    match ssh_opt {
        Some((conn_id, ssh)) => {
            let maestro_path = {
                let cache = app_state.acp.discovery_cache.lock().await;
                cache.get(&ConnectionKey::Ssh { id: conn_id })
                    .and_then(|e| e.maestro_server_path.clone())
                    .ok_or_else(|| format!(
                        "maestro-server path not cached for connection {}. Reconnect to refresh.",
                        conn_id
                    ))?
            };
            let req = SessionRequest {
                connection_key: ConnectionKey::Ssh { id: conn_id },
                ..req
            };
            crate::acp::spawn_acp_session_cold(
                crate::acp::TransportTarget::Remote { ssh: &ssh, server_path: &maestro_path },
                &session_id,
                TaskMetadata { task_id, task_name: task_name.clone(), branch_name, session_start_sha },
                &req,
            ).await?;
        }
        None => {
            if let Some(wsl_id) = wsl_connection_id {
                let distro = {
                    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
                    conn.query_row(
                        "SELECT distro_name FROM wsl_connections WHERE id = ?",
                        [wsl_id],
                        |row| row.get::<_, String>(0),
                    ).map_err(|e| format!("WSL connection {} not found: {}", wsl_id, e))?
                };
                let req = SessionRequest { connection_key: ConnectionKey::Wsl { id: wsl_id }, ..req };
                #[cfg(windows)]
                {
                    let maestro_path = {
                        let cached = app_state.acp.discovery_cache.lock().await
                            .get(&ConnectionKey::Wsl { id: wsl_id })
                            .and_then(|e| e.maestro_server_path.clone());
                        match cached {
                            Some(p) => p,
                            None => crate::acp::deploy::ensure_wsl_server(&distro, &app_state.app_handle)
                                .await
                                .map_err(|e| format!("Failed to deploy maestro-server to WSL: {}", e))?
                                .path,
                        }
                    };
                    crate::acp::spawn_acp_session_cold(
                        crate::acp::TransportTarget::Wsl { distro: &distro, server_path: &maestro_path },
                        &session_id,
                        TaskMetadata { task_id, task_name: task_name.clone(), branch_name, session_start_sha },
                        &req,
                    ).await?;
                }
                #[cfg(not(windows))]
                {
                    let _ = (distro, req);
                    return Err("WSL connections are only supported on Windows".to_string());
                }
            } else {
                crate::acp::spawn_acp_session_cold(
                    crate::acp::TransportTarget::Local,
                    &session_id,
                    TaskMetadata { task_id, task_name, branch_name, session_start_sha },
                    &req,
                ).await?;
            }
        }
    }

    app_state.app_handle.emit("sessions-changed", ()).ok();
    Ok(SpawnSessionResult { log_id, ready: false })
}

async fn send_prompt_impl(
    app_state: &Arc<AppState>,
    log_id: i32,
    content: serde_json::Value,
) -> Result<(), String> {
    eprintln!("[maestro] send_prompt_impl: log_id={log_id} content={content}");
    let msg = MaestroRpcMessage::Request(ServerRequest::Prompt(PromptRequest {
        session_id: session_id_for(log_id),
        content,
    }));
    let result = crate::acp::write_to_acp_session(app_state, log_id, &msg).await;
    eprintln!("[maestro] send_prompt_impl result: {result:?}");
    result
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
    // Track whether this session used a connection server so we can tear it down if empty.
    // Check remaining sessions in the same lock scope to avoid a second sessions.lock().
    let teardown_key: Option<ConnectionKey> = {
        let mut sessions = app_state.acp.sessions.lock().await;
        let removed = sessions.remove(&log_id);
        // Sessions routed through a connection server have child=None (process owned by server).
        let conn_key = removed.as_ref()
            .filter(|s| s.child.is_none())
            .map(|s| s.connection_key);
        if let Some(mut session) = removed {
            if let Some(cancel_tx) = session.reader_cancel_tx.take() {
                let _ = cancel_tx.send(());
            }
        }
        conn_key
            .filter(|k| !sessions.values().any(|s| &s.connection_key == k && s.child.is_none()))
    };

    // If no other sessions remain on this connection, tear down the connection server.
    // This kills maestro-server (and its agent subprocesses) to free resources.
    // The shared reader task detects EOF and cleans up remaining pool entries.
    if let Some(key) = teardown_key {
        app_state.acp.connection_servers.lock().await.remove(&key);
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

/// Send a SetConfigOption request for a running ACP session.
/// Routes to the appropriate underlying protocol message based on category.
#[tauri::command]
#[specta::specta]
pub async fn set_acp_config_option(
    app_state: State<'_, Arc<AppState>>,
    log_id: i32,
    option_id: String,
    value: String,
) -> Result<(), String> {
    let session_id = session_id_for(log_id);
    let msg = match option_id.as_str() {
        "model" => MaestroRpcMessage::Request(ServerRequest::SetModel(SetModelRequest {
            session_id,
            model_id: value,
        })),
        "mode" => MaestroRpcMessage::Request(ServerRequest::SetMode(SetModeRequest {
            session_id,
            mode_id: value,
        })),
        other => MaestroRpcMessage::Request(ServerRequest::SetConfigOption(SetConfigOptionRequest {
            session_id,
            config_id: other.to_string(),
            value,
        })),
    };
    crate::acp::write_to_acp_session(&app_state, log_id, &msg).await
}

/// Get the full agent-level catalog cache for a (project, agent) pair.
/// Returns None if the agent has not been warmed up or spawned yet.
/// Populated from PreInitialize/SpawnOk/SessionLoadOk/config_option_update.
#[tauri::command]
#[specta::specta]
pub async fn get_agent_cache(
    app_state: State<'_, Arc<AppState>>,
    agent_id: String,
    connection: crate::acp::ConnectionKey,
) -> Result<Option<AgentCacheResponse>, String> {
    let connection_key = connection;
    let cache = app_state.acp.agent_cache.lock().await;
    let entry = match cache.get(&(connection_key, agent_id)) {
        Some(e) => e,
        None => return Ok(None),
    };
    Ok(Some(AgentCacheResponse {
        config_options: entry.config_options.iter().map(|o| AgentCatalogOption {
            id: o.id.clone(),
            name: o.name.clone(),
            description: o.description.clone(),
            category: o.category.clone(),
            options: o.options.iter().map(|v| AgentCatalogOptionValue {
                name: v.name.clone(),
                value: v.value.clone(),
                description: v.description.clone(),
            }).collect(),
            default_value: o.default_value.clone(),
        }).collect(),
        available_commands: entry.available_commands.iter().map(|c| AgentCatalogCommand {
            name: c.name.clone(),
            description: c.description.clone(),
        }).collect(),
        prompt_capabilities: entry.prompt_capabilities.as_ref().map(|c| AcpPromptCapabilities {
            embedded_context: c.embedded_context,
            image: c.image,
            audio: c.audio,
        }),
        session_capabilities: AgentSessionCapabilities {
            supports_session_list: entry.session_capabilities.supports_session_list,
            supports_session_load: entry.session_capabilities.supports_session_load,
            supports_session_close: entry.session_capabilities.supports_session_close,
        },
    }))

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
    connection: crate::acp::ConnectionKey,
) -> Result<PreflightResult, String> {
    let connection_key = connection;
    let server_already_running = app_state
        .acp
        .connection_servers
        .lock()
        .await
        .contains_key(&connection_key);

    if !server_already_running {
        match &connection_key {
            ConnectionKey::Ssh { id: conn_id } => {
                let conn_id = *conn_id;
                let ssh = app_state
                    .ssh
                    .get_session(conn_id)
                    .await
                    .ok_or_else(|| {
                        format!("No active SSH session for connection_id {}. Connect first.", conn_id)
                    })?;
                let deploy_lock = {
                    let mut locks = app_state.acp.deploy_locks.lock().await;
                    locks.entry(conn_id).or_insert_with(|| std::sync::Arc::new(tokio::sync::Mutex::new(()))).clone()
                };
                let _deploy_guard = deploy_lock.lock().await;
                // Re-check cache: background prefetch may have populated it while we waited.
                let cached_path = app_state
                    .acp
                    .discovery_cache
                    .lock()
                    .await
                    .get(&ConnectionKey::Ssh { id: conn_id })
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
                            .entry(ConnectionKey::Ssh { id: conn_id })
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
                    ConnectionKey::Ssh { id: conn_id },
                    crate::acp::TransportTarget::Remote { ssh: &ssh, server_path: &maestro_path },
                    &app_state,
                )
                .await
                .map_err(|e| format!("Failed to start maestro-server: {}", e))?;
            }
            ConnectionKey::Wsl { id: wsl_id } => {
                let wsl_id = *wsl_id;
                let distro = {
                    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
                    conn.query_row(
                        "SELECT distro_name FROM wsl_connections WHERE id = ?",
                        [wsl_id],
                        |row| row.get::<_, String>(0),
                    ).map_err(|e| format!("WSL connection {} not found: {}", wsl_id, e))?
                };
                #[cfg(windows)]
                {
                    let cached_path = app_state
                        .acp
                        .discovery_cache
                        .lock()
                        .await
                        .get(&connection_key)
                        .and_then(|e| e.maestro_server_path.clone());
                    let maestro_path = match cached_path {
                        Some(p) => p,
                        None => {
                            let deploy = crate::acp::deploy::ensure_wsl_server(
                                &distro,
                                &app_state.app_handle,
                            )
                            .await
                            .map_err(|e| format!("Failed to deploy maestro-server to WSL: {}", e))?;
                            deploy.path
                        }
                    };
                    crate::acp::spawn_connection_server(
                        connection_key,
                        crate::acp::TransportTarget::Wsl { distro: &distro, server_path: &maestro_path },
                        &app_state,
                    )
                    .await
                    .map_err(|e| format!("Failed to start WSL maestro-server: {}", e))?;
                }
                #[cfg(not(windows))]
                {
                    let _ = distro;
                    return Err("WSL connections are only supported on Windows".to_string());
                }
            }
            ConnectionKey::Local => {
                crate::acp::resolve::resolve_server_path(&app_state.app_handle)
                    .map_err(|e| format!("maestro-server not found: {}", e))?;
                crate::acp::spawn_connection_server(
                    ConnectionKey::Local,
                    crate::acp::TransportTarget::Local,
                    &app_state,
                )
                .await
                .map_err(|e| format!("Failed to start maestro-server: {}", e))?;
            }
        }
    }

    let (agents, _) = fetch_and_filter_agents(connection_key, &app_state).await;

    let mut tools_to_check: Vec<String> = agents
        .iter()
        .flat_map(|a| a.spawn_deps.iter().cloned())
        .collect::<std::collections::HashSet<_>>()
        .into_iter()
        .collect();
    if !tools_to_check.iter().any(|t| t == "git") {
        tools_to_check.push("git".to_string());
    }

    let tool_results = crate::acp::query_check_tools_via_server(connection_key, tools_to_check, &app_state)
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
        let maestro_server_path = cache.get(&connection_key).and_then(|e| e.maestro_server_path.clone());
        cache.insert(connection_key, AgentDiscoveryCacheEntry {
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

/// Detect which agent tools have configuration markers in the given project directory.
/// Used to suggest a default agent when opening a project.
/// Requires the connection server to be running (call `preflight_connection` first).
#[tauri::command]
#[specta::specta]
pub async fn detect_project_agents(
    app_state: State<'_, Arc<AppState>>,
    connection: crate::acp::ConnectionKey,
    cwd: String,
) -> Result<Vec<ProjectAgentMatch>, String> {
    let response = crate::acp::manager::query_detect_project_agents_via_server(
        connection,
        cwd,
        &app_state,
    )
    .await?;

    Ok(response
        .agents
        .into_iter()
        .map(|a| ProjectAgentMatch {
            agent_id: a.agent_id,
            markers_found: a.markers_found,
        })
        .collect())
}

/// Run agent discovery and store result in the AppState cache.
/// Fire-and-forget safe: returns silently on errors (result stored with error field set).
/// Fetch all agents from registry, detect which are installed on the target host,
/// filter to installed-only, and override display names with tool names from the detection table.
/// Returns (filtered_agents, error). On ListAgents RPC failure returns empty + error string.
async fn fetch_and_filter_agents(
    connection_key: ConnectionKey,
    app_state: &Arc<AppState>,
) -> (Vec<DiscoveredAgent>, Option<String>) {
    let result = crate::acp::query_list_agents_via_connection_server(connection_key, app_state).await;
    let (all_agents, list_error) = match result {
        Ok(a) => (a, None),
        Err(e) => return (Vec::new(), Some(e)),
    };

    let detected = crate::acp::manager::query_detect_installed_via_server(connection_key, app_state)
        .await
        .unwrap_or_else(|_| maestro_protocol::DetectInstalledAgentsResponse {
            agents: Vec::new(),
            all_checked_ids: Vec::new(),
        });

    let detected_tool_names: std::collections::HashMap<String, String> = detected
        .agents.iter().map(|d| (d.agent_id.clone(), d.tool_name.clone())).collect();
    let detected_ids: HashSet<String> = detected.agents.iter().map(|d| d.agent_id.clone()).collect();

    let agents = all_agents.into_iter()
        .filter(|a| detected_ids.contains(&a.id))
        .map(|mut a| {
            if let Some(tool_name) = detected_tool_names.get(&a.id) {
                a.name = tool_name.clone();
            }
            a
        })
        .collect();

    (agents, list_error)
}

/// Called at SSH connect time (connection_id = Some) and on-demand from `discover_agents` IPC.
/// For local discovery (connection_id = None), called on first `discover_agents` query.
/// `known_maestro_path`: skip `ensure_remote_server` when caller already has the path.
pub async fn prefetch_agent_discovery(
    app_state: Arc<AppState>,
    connection_key: ConnectionKey,
    known_maestro_path: Option<String>,
) {
    // Registry is stable (changes only on agent install/uninstall).
    // If preflight already populated the cache, skip redundant fetch.
    {
        let cache = app_state.acp.discovery_cache.lock().await;
        if let Some(entry) = cache.get(&connection_key) {
            if !entry.result.agents.is_empty() {
                return;
            }
        }
    }
    match connection_key {
        ConnectionKey::Ssh { id: conn_id } => {
            let conn_key = ConnectionKey::Ssh { id: conn_id };
            // Fast path: route through already-running connection server — no new process spawn.
            let has_connection_server = app_state.acp.connection_servers.lock().await.contains_key(&conn_key);
            if has_connection_server {
                let maestro_path = known_maestro_path.or_else(|| {
                    let cache = app_state.acp.discovery_cache.try_lock().ok();
                    cache.and_then(|c| c.get(&conn_key).and_then(|e| e.maestro_server_path.clone()))
                });
                let (agents, error) = fetch_and_filter_agents(conn_key, &app_state).await;
                let maestro_server_available = error.is_none();
                let entry = AgentDiscoveryCacheEntry {
                    result: AgentDiscoveryResult { maestro_server_available, agents, error },
                    maestro_server_path: maestro_path,
                    fetched_at: std::time::Instant::now(),
                };
                app_state.acp.discovery_cache.lock().await.insert(conn_key, entry);
                return;
            }

            // Slow path: no connection server yet — deploy + boot it, then query.
            let Some(ssh) = app_state.ssh.get_session(conn_id).await else {
                return;
            };
            let maestro_path = if let Some(p) = known_maestro_path {
                Some(p)
            } else {
                let deploy_lock = {
                    let mut locks = app_state.acp.deploy_locks.lock().await;
                    locks.entry(conn_id).or_insert_with(|| std::sync::Arc::new(tokio::sync::Mutex::new(()))).clone()
                };
                let _deploy_guard = deploy_lock.lock().await;
                // Re-check cache: preflight may have populated it while we waited.
                let cached = app_state.acp.discovery_cache.lock().await
                    .get(&conn_key)
                    .and_then(|e| e.maestro_server_path.clone());
                if let Some(p) = cached {
                    Some(p)
                } else {
                    crate::acp::deploy::ensure_remote_server(&ssh, &app_state.app_handle, conn_id)
                        .await
                        .ok()
                        .map(|r| r.path)
                }
            };
            let Some(path) = maestro_path else {
                app_state.acp.discovery_cache.lock().await.insert(conn_key, AgentDiscoveryCacheEntry {
                    result: AgentDiscoveryResult { maestro_server_available: false, agents: Vec::new(), error: None },
                    maestro_server_path: None,
                    fetched_at: std::time::Instant::now(),
                });
                return;
            };
            if crate::acp::spawn_connection_server(
                conn_key,
                crate::acp::TransportTarget::Remote { ssh: &ssh, server_path: &path },
                &app_state,
            ).await.is_err() {
                return;
            }
            let (agents, error) = fetch_and_filter_agents(conn_key, &app_state).await;
            let maestro_server_available = error.is_none();
            app_state.acp.discovery_cache.lock().await.insert(conn_key, AgentDiscoveryCacheEntry {
                result: AgentDiscoveryResult { maestro_server_available, agents, error },
                maestro_server_path: Some(path),
                fetched_at: std::time::Instant::now(),
            });
        }
        ConnectionKey::Wsl { id: wsl_id } => {
            let wsl_key = ConnectionKey::Wsl { id: wsl_id };
            // Fast path: if connection server already running, just fetch.
            let has_connection_server = app_state.acp.connection_servers.lock().await.contains_key(&wsl_key);
            if has_connection_server {
                let (agents, error) = fetch_and_filter_agents(wsl_key, &app_state).await;
                let maestro_server_available = error.is_none();
                app_state.acp.discovery_cache.lock().await.insert(wsl_key, AgentDiscoveryCacheEntry {
                    result: AgentDiscoveryResult { maestro_server_available, agents, error },
                    maestro_server_path: None,
                    fetched_at: std::time::Instant::now(),
                });
                return;
            }
            let distro = {
                let Ok(conn) = app_state.db.lock() else { return };
                match conn.query_row(
                    "SELECT distro_name FROM wsl_connections WHERE id = ?",
                    [wsl_id],
                    |row| row.get::<_, String>(0),
                ) {
                    Ok(d) => d,
                    Err(_) => return,
                }
            };
            #[cfg(windows)]
            {
                let maestro_path = match crate::acp::deploy::ensure_wsl_server(&distro, &app_state.app_handle).await {
                    Ok(r) => r.path,
                    Err(_) => {
                        app_state.acp.discovery_cache.lock().await.insert(wsl_key, AgentDiscoveryCacheEntry {
                            result: AgentDiscoveryResult { maestro_server_available: false, agents: Vec::new(), error: None },
                            maestro_server_path: None,
                            fetched_at: std::time::Instant::now(),
                        });
                        return;
                    }
                };
                if crate::acp::spawn_connection_server(
                    wsl_key,
                    crate::acp::TransportTarget::Wsl { distro: &distro, server_path: &maestro_path },
                    &app_state,
                ).await.is_err() {
                    return;
                }
                let (agents, error) = fetch_and_filter_agents(wsl_key, &app_state).await;
                let maestro_server_available = error.is_none();
                app_state.acp.discovery_cache.lock().await.insert(wsl_key, AgentDiscoveryCacheEntry {
                    result: AgentDiscoveryResult { maestro_server_available, agents, error },
                    maestro_server_path: Some(maestro_path),
                    fetched_at: std::time::Instant::now(),
                });
            }
            #[cfg(not(windows))]
            {
                let _ = distro;
                app_state.acp.discovery_cache.lock().await.insert(wsl_key, AgentDiscoveryCacheEntry {
                    result: AgentDiscoveryResult { maestro_server_available: false, agents: Vec::new(), error: None },
                    maestro_server_path: None,
                    fetched_at: std::time::Instant::now(),
                });
            }
        }
        ConnectionKey::Local => {
            let maestro_server_available = crate::acp::resolve::resolve_server_path(&app_state.app_handle).is_ok();
            if !maestro_server_available {
                app_state.acp.discovery_cache.lock().await.insert(ConnectionKey::Local, AgentDiscoveryCacheEntry {
                    result: AgentDiscoveryResult { maestro_server_available: false, agents: Vec::new(), error: None },
                    maestro_server_path: None,
                    fetched_at: std::time::Instant::now(),
                });
                return;
            }
            if crate::acp::spawn_connection_server(ConnectionKey::Local, crate::acp::TransportTarget::Local, &app_state)
                .await.is_err() {
                return;
            }
            let (agents, error) = fetch_and_filter_agents(ConnectionKey::Local, &app_state).await;
            app_state.acp.discovery_cache.lock().await.insert(ConnectionKey::Local, AgentDiscoveryCacheEntry {
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
    connection: crate::acp::ConnectionKey,
) -> Result<AgentDiscoveryResult, String> {
    let connection_key = connection;
    {
        let cache = app_state.acp.discovery_cache.lock().await;
        if let Some(entry) = cache.get(&connection_key) {
            if entry.fetched_at.elapsed() < Duration::from_secs(300) {
                return Ok(entry.result.clone());
            }
        }
    }

    let arc = Arc::clone(app_state.inner());
    prefetch_agent_discovery(arc, connection_key, None).await;

    app_state.acp.discovery_cache.lock().await
        .get(&connection_key)
        .map(|e| e.result.clone())
        .ok_or_else(|| match connection_key {
            ConnectionKey::Local => "Local agent discovery failed — is maestro-server installed?".to_string(),
            ConnectionKey::Ssh { id } => format!("No active SSH session for connection_id {}. Connect first.", id),
            ConnectionKey::Wsl { id } => format!("WSL discovery failed for wsl_connection_id {}.", id),
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

/// Read a binary file from the project and return it as a base64-encoded string.
///
/// For local sessions, reads directly from disk.
/// For remote SSH sessions, downloads via SFTP to a local cache under `app_data_dir/working_file_cache/`
/// and returns base64-encoded content. Subsequent calls for the same file return the cached copy.
/// Files larger than 5 MB are rejected.
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
        ConnectionKey::Local | ConnectionKey::Wsl { .. } => {
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
        ConnectionKey::Ssh { id: conn_id } => {
            let cache_dir = app_state.app_data_dir
                .join("working_file_cache")
                .join(log_id.to_string());

            // Use a hash of the relative path to avoid filesystem collisions
            // while preserving the extension for human readability.
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
                crate::ssh::sftp::download_file(
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
    };

    use base64::Engine;
    Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
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

/// Get currently active sessions (ACP + PTY) as a flat list, filtered by project.
/// Used by the Agents sidebar to display live sessions.
#[tauri::command]
#[specta::specta]
pub async fn get_active_sessions(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
) -> Result<Vec<ActiveSessionInfo>, String> {
    let mut sessions = Vec::new();

    // ACP sessions — collect session data first, then look up agent cache separately
    // to avoid holding two tokio::Mutex locks simultaneously (deadlock risk).
    let pooled_log_ids: HashSet<i32> = {
        let pool = app_state.acp.session_pool.lock().await;
        pool.values().map(|p| p.log_id).collect()
    };
    let acp_session_data: Vec<_> = {
        let acp = app_state.acp.sessions.lock().await;
        acp.iter()
            .filter(|(key, proc)| {
                !pooled_log_ids.contains(key)
                    && proc.project_id == Some(project_id)
            })
            .map(|(key, proc)| {
                let native_id = proc.acp_session_id.lock().ok().and_then(|g| g.clone());
                (*key, proc.session_name.clone(), proc.agent_id_meta.clone(),
                 proc.started_at.clone(), proc.task_id, proc.task_name.clone(),
                 proc.branch_name.clone(), native_id, proc.connection_key)
            }).collect()
    };
    {
        let agent_cache = app_state.acp.agent_cache.lock().await;
        for (key, session_name, agent_id, started_at, task_id, task_name, branch_name, native_id, conn_key) in acp_session_data {
            let caps = agent_cache.get(&(conn_key, agent_id.clone()))
                .map(|e| e.session_capabilities.clone())
                .unwrap_or_default();
            sessions.push(ActiveSessionInfo {
                session_key: key,
                session_name,
                agent_id: Some(agent_id),
                execution_mode: ExecutionMode::Acp,
                started_at,
                task_id,
                task_name,
                branch_name,
                acp_session_id: native_id,
                supports_session_list: caps.supports_session_list,
                supports_session_load: caps.supports_session_load,
                supports_session_close: caps.supports_session_close,
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
    connection: crate::acp::ConnectionKey,
) -> Result<(), String> {
    crate::acp::query_session_close_via_server(
        connection,
        SessionCloseRequest { agent_id, session_id, cwd },
        &app_state,
    )
    .await
}


/// Load an existing ACP session — spawns a full session that resumes from a stored agent session.
#[tauri::command]
#[specta::specta]
pub async fn load_acp_session(
    app_state: State<'_, Arc<AppState>>,
    agent_id: String,
    acp_session_id: String,
    cwd: String,
    connection: crate::acp::ConnectionKey,
    session_name: Option<String>,
    project_id: Option<i32>,
    worktree_branch: Option<String>,
) -> Result<i32, String> {
    let log_id = app_state.pty.session_counter.fetch_add(1, std::sync::atomic::Ordering::Relaxed);

    let connection_key = connection;
    let req = SessionRequest {
        connection_key,
        agent_id: agent_id.clone(),
        cwd: cwd.clone(),
        log_id,
        session_name: session_name.clone(),
        project_id,
        app_state: Arc::clone(&*app_state),
    };

    // Fast path: if a connection server is running, route through shared server.
    if crate::acp::try_session_load_via_connection_server(&acp_session_id, &req).await? {
        if let Some(ref branch) = worktree_branch {
            if let Some(proc) = app_state.acp.sessions.lock().await.get_mut(&log_id) {
                proc.branch_name = Some(branch.clone());
            }
        }
        app_state.app_handle.emit("sessions-changed", ()).ok();
        return Ok(log_id);
    }

    // Cold path: spawn dedicated maestro-server subprocess.
    match connection_key {
        ConnectionKey::Ssh { id: conn_id } => {
            let (ssh, maestro_path) = crate::acp::resolve_remote_context(&app_state, conn_id).await?;
            crate::acp::load_acp_session_cold(
                crate::acp::TransportTarget::Remote { ssh: &ssh, server_path: &maestro_path },
                &acp_session_id,
                &req,
            ).await?;
        }
        ConnectionKey::Wsl { id: wsl_id } => {
            let distro = {
                let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
                conn.query_row(
                    "SELECT distro_name FROM wsl_connections WHERE id = ?",
                    [wsl_id],
                    |row| row.get::<_, String>(0),
                ).map_err(|e| format!("WSL connection {} not found: {}", wsl_id, e))?
            };
            #[cfg(windows)]
            {
                let maestro_path = {
                    let cached = app_state.acp.discovery_cache.lock().await
                        .get(&ConnectionKey::Wsl { id: wsl_id })
                        .and_then(|e| e.maestro_server_path.clone());
                    match cached {
                        Some(p) => p,
                        None => crate::acp::deploy::ensure_wsl_server(&distro, &app_state.app_handle)
                            .await
                            .map_err(|e| format!("Failed to deploy maestro-server to WSL: {}", e))?
                            .path,
                    }
                };
                crate::acp::load_acp_session_cold(
                    crate::acp::TransportTarget::Wsl { distro: &distro, server_path: &maestro_path },
                    &acp_session_id,
                    &req,
                ).await?;
            }
            #[cfg(not(windows))]
            {
                let _ = distro;
                return Err("WSL connections are only supported on Windows".to_string());
            }
        }
        ConnectionKey::Local => {
            crate::acp::load_acp_session_cold(
                crate::acp::TransportTarget::Local,
                &acp_session_id,
                &req,
            ).await?;
        }
    }

    if let Some(ref branch) = worktree_branch {
        if let Some(proc) = app_state.acp.sessions.lock().await.get_mut(&log_id) {
            proc.branch_name = Some(branch.clone());
        }
    }

    app_state.app_handle.emit("sessions-changed", ()).ok();
    Ok(log_id)
}

/// Re-emit model/mode state from AcpProcess fields and agent cache.
/// Called during drain for buffered sessions so the frontend gets correct config values
/// even if SpawnOk's direct emissions were lost (frontend not mounted at spawn time).
async fn emit_init_events_from_session(log_id: i32, app_state: &Arc<AppState>) {
    let (model_id, mode_id, connection_key, agent_id) = {
        let sessions = app_state.acp.sessions.lock().await;
        let Some(session) = sessions.get(&log_id) else { return };
        (
            session.current_model_id.lock().ok().and_then(|m| m.clone()),
            session.current_mode_id.lock().ok().and_then(|m| m.clone()),
            session.connection_key,
            session.agent_id_meta.clone(),
        )
    };
    let cache = app_state.acp.agent_cache.lock().await.get(&(connection_key, agent_id)).cloned();
    let Some(cache) = cache else { return };

    if let Some(model_opt) = cache.config_options.iter().find(|o| o.id == "model") {
        let current = model_id.unwrap_or_else(|| {
            model_opt.options.first().map(|v| v.value.clone()).unwrap_or_default()
        });
        let payload = serde_json::json!({
            "current_model_id": current,
            "available_models": model_opt.options.iter().map(|v| serde_json::json!({
                "model_id": v.value, "name": v.name
            })).collect::<Vec<_>>(),
        });
        let _ = app_state.app_handle.emit(&format!("acp://session-models/{}", log_id), &payload);
    }
    if let Some(mode_opt) = cache.config_options.iter().find(|o| o.id == "mode") {
        let current = mode_id.unwrap_or_else(|| {
            mode_opt.options.first().map(|v| v.value.clone()).unwrap_or_default()
        });
        let payload = serde_json::json!({
            "current_mode_id": current,
            "available_modes": mode_opt.options.iter().map(|v| serde_json::json!({
                "mode_id": v.value, "name": v.name
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
        // If not initialized: spawn-ok fires directly when SpawnOk/SessionLoadOk arrives
    }
    Ok(())
}

// ─── External file attachment ───────────────────────────────────────────────

const MAX_IMAGE_BYTES: u64 = 10 * 1024 * 1024; // 10 MB hard reject
const SCALE_THRESHOLD_BYTES: u64 = 5 * 1024 * 1024; // 5 MB triggers scaling

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
        // Within 10% of threshold — not worth scaling
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

/// Prepare external file attachments for inclusion in an ACP prompt.
///
/// For images: reads bytes, validates size (rejects >10 MB, scales down >5 MB), base64-encodes.
/// For text files with embedded_context=true: reads content locally, uploads to remote if needed.
/// For text files with embedded_context=false: uploads to remote if needed, sends path-only ResourceLink.
///
/// Remote uploads go to `{cwd}/.maestro/attachments/{session_id}/{basename}`.
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
            // Image: read, scale if needed, base64-encode
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
            // Text/code file
            let mime = mime_for_extension(&file.path)
                .map(str::to_string);

            // Upload to remote if this is an SSH session
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
                    // Ensure directory exists on remote
                    session
                        .execute_command(&format!("mkdir -p '{attachments_dir}'"))
                        .await
                        .map_err(|e| format!("Failed to create attachments dir: {e}"))?;

                    let remote_path = format!("{attachments_dir}/{display_name}");
                    let transfer_id = format!("attach-{log_id}-{display_name}");
                    crate::ssh::sftp::upload_file(
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

            if embedded_context {
                // Read content locally (have it already regardless of local/remote)
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
                // Path-only — agent reads via fs/read_text_file
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
