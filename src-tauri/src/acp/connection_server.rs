//! Connection server management: spawn and query the shared per-connection maestro-server process.

use std::sync::Arc;
use std::sync::atomic::AtomicU64;
use crate::acp::transport::{
    MaestroRpcMessage, ServerRequest, ListAgentsRequest,
    PreInitializeRequest, PreInitializeResponse,
    SessionListOkResponse, SessionCloseRequest,
    CheckToolsRequest, CheckToolsResponse,
};
use crate::acp::transport_types::serialize_message;
use crate::acp::session_types::{ConnectionServer, PendingChannels, TransportTarget};
use crate::acp::transport_setup::{
    open_local_transport, open_remote_transport, spawn_stdin_writer_task,
};
#[cfg(windows)]
use crate::acp::transport_setup::open_wsl_transport;
use crate::acp::reader_task::spawn_shared_reader_task;
use crate::acp::manager::append_debug_log;
use maestro_protocol::{
    DetectInstalledAgentsRequest, DetectInstalledAgentsResponse,
    DetectProjectAgentsRequest, DetectProjectAgentsResponse,
};
use tokio::sync::oneshot;

/// Generic helper: lock→insert→send→await pattern shared by all connection-server query functions.
async fn query_via_server<T: Send + 'static>(
    connection_key: crate::acp::ConnectionKey,
    app_state: &Arc<crate::core::AppState>,
    not_found_err: &str,
    get_pending: impl FnOnce(&ConnectionServer) -> Arc<std::sync::Mutex<Option<oneshot::Sender<Result<T, String>>>>>,
    already_in_progress_err: &str,
    request: MaestroRpcMessage,
    timeout_secs: u64,
    timeout_err: &str,
) -> Result<T, String> {
    let (writer_tx, pending) = {
        let servers = app_state.acp.connection_servers.lock().await;
        let server = servers.get(&connection_key).ok_or_else(|| not_found_err.to_string())?;
        (server.writer_tx.clone(), get_pending(server))
    };
    let (tx, rx) = oneshot::channel();

    // If another request of the same type is already in-flight, wait up to 10s for it to
    // complete rather than failing immediately. This handles the common case where the user
    // switches between agents in the history panel while the first query is still loading.
    let slot_deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
    let mut pending_tx = Some(tx);
    loop {
        {
            let mut guard = pending.lock().map_err(|e| format!("Lock poisoned: {}", e))?;
            if guard.is_none() {
                *guard = pending_tx.take();
                break;
            }
        }
        if tokio::time::Instant::now() >= slot_deadline {
            return Err(already_in_progress_err.to_string());
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }

    let bytes = serialize_message(&request)?;
    writer_tx.send(bytes).await.map_err(|_| "Connection server writer channel closed".to_string())?;
    let result = tokio::time::timeout(std::time::Duration::from_secs(timeout_secs), rx).await;
    match result {
        Err(_) => {
            // Timeout: clear the pending slot so future requests aren't permanently blocked.
            if let Ok(mut guard) = pending.lock() {
                guard.take();
            }
            Err(timeout_err.to_string())
        }
        Ok(inner) => inner.map_err(|_| "Response channel dropped".to_string())?,
    }
}

/// Send `ListAgents` through the running connection server and return the result.
/// Much faster than `one_shot_rpc` — reuses the existing process and registry cache.
pub async fn query_list_agents_via_connection_server(
    connection_key: crate::acp::ConnectionKey,
    app_state: &Arc<crate::core::AppState>,
) -> Result<Vec<crate::acp::registry::DiscoveredAgent>, String> {
    query_via_server(
        connection_key, app_state,
        &format!("No connection server for connection {:?}", connection_key),
        |s| s.pending.list_agents.clone(),
        "ListAgents already in progress",
        MaestroRpcMessage::Request(ServerRequest::ListAgents(ListAgentsRequest {})),
        15, "ListAgents via connection server timed out after 15s",
    ).await
}

/// Send `SessionList` through the running connection server and return the result.
pub async fn query_session_list_via_server(
    connection_key: crate::acp::ConnectionKey,
    request: crate::acp::transport::SessionListRequest,
    app_state: &Arc<crate::core::AppState>,
) -> Result<SessionListOkResponse, String> {
    query_via_server(
        connection_key, app_state,
        "Connection not initialized. Run preflight first.",
        |s| s.pending.session_list.clone(),
        "SessionList already in progress",
        MaestroRpcMessage::Request(ServerRequest::SessionList(request)),
        30, "SessionList via connection server timed out after 30s",
    ).await
}

/// Send `SessionClose` through the running connection server.
pub async fn query_session_close_via_server(
    connection_key: crate::acp::ConnectionKey,
    request: SessionCloseRequest,
    app_state: &Arc<crate::core::AppState>,
) -> Result<(), String> {
    query_via_server(
        connection_key, app_state,
        "Connection not initialized. Run preflight first.",
        |s| s.pending.session_close.clone(),
        "SessionClose already in progress",
        MaestroRpcMessage::Request(ServerRequest::SessionClose(request)),
        30, "SessionClose via connection server timed out after 30s",
    ).await
}

/// Send `CheckTools` through the running connection server and return the result.
pub async fn query_check_tools_via_server(
    connection_key: crate::acp::ConnectionKey,
    tools: Vec<String>,
    app_state: &Arc<crate::core::AppState>,
) -> Result<CheckToolsResponse, String> {
    query_via_server(
        connection_key, app_state,
        "Connection not initialized. Run preflight first.",
        |s| s.pending.check_tools.clone(),
        "CheckTools already in progress",
        MaestroRpcMessage::Request(ServerRequest::CheckTools(CheckToolsRequest { tools })),
        15, "CheckTools via connection server timed out after 15s",
    ).await
}

/// Send `DetectInstalledAgents` through the running connection server and return the result.
pub async fn query_detect_installed_via_server(
    connection_key: crate::acp::ConnectionKey,
    app_state: &Arc<crate::core::AppState>,
) -> Result<DetectInstalledAgentsResponse, String> {
    query_via_server(
        connection_key, app_state,
        "Connection not initialized. Run preflight first.",
        |s| s.pending.detect_installed.clone(),
        "DetectInstalledAgents already in progress",
        MaestroRpcMessage::Request(ServerRequest::DetectInstalledAgents(DetectInstalledAgentsRequest {})),
        30, "DetectInstalledAgents timed out after 30s",
    ).await
}

/// Send `DetectProjectAgents` through the running connection server and return the result.
pub async fn query_detect_project_agents_via_server(
    connection_key: crate::acp::ConnectionKey,
    cwd: String,
    app_state: &Arc<crate::core::AppState>,
) -> Result<DetectProjectAgentsResponse, String> {
    query_via_server(
        connection_key, app_state,
        "Connection not initialized. Run preflight first.",
        |s| s.pending.detect_project.clone(),
        "DetectProjectAgents already in progress",
        MaestroRpcMessage::Request(ServerRequest::DetectProjectAgents(DetectProjectAgentsRequest { cwd })),
        15, "DetectProjectAgents timed out after 15s",
    ).await
}

/// Spawn a long-lived maestro-server shared across all sessions for `connection_id`.
/// Idempotent — returns `Ok(())` if already running.
/// Uses `TransportTarget` to handle both local subprocess and remote SSH exec channel.
pub async fn spawn_connection_server(
    connection_key: crate::acp::ConnectionKey,
    target: TransportTarget<'_>,
    app_state: &Arc<crate::core::AppState>,
) -> Result<(), String> {
    {
        let servers = app_state.acp.connection_servers.lock().await;
        if servers.contains_key(&connection_key) {
            return Ok(());
        }
    }

    append_debug_log(&format!("[acp] spawning connection server for {connection_key:?}"));

    let (write_tx, source, child) = match target {
        TransportTarget::Local => {
            let (stdin_writer, source, child) = open_local_transport(app_state).await?;
            (spawn_stdin_writer_task(stdin_writer), source, Some(child))
        }
        TransportTarget::Remote { ssh, server_path } => {
            let (write_tx, source) = open_remote_transport(ssh, server_path).await?;
            (write_tx, source, None)
        }
        #[cfg(windows)]
        TransportTarget::Wsl { distro, server_path } => {
            let (stdin_writer, source, child) = open_wsl_transport(distro, server_path).await?;
            (spawn_stdin_writer_task(stdin_writer), source, Some(child))
        }
    };

    let pending = PendingChannels::new();
    let last_ping_at = Arc::new(AtomicU64::new(0));
    let writer_tx_for_reader = write_tx.clone();

    let connection_server = ConnectionServer {
        child,
        writer_tx: write_tx,
        pending: pending.clone(),
        last_ping_at: Arc::clone(&last_ping_at),
    };

    // Re-check under lock to avoid double-spawn race.
    {
        let mut servers = app_state.acp.connection_servers.lock().await;
        if servers.contains_key(&connection_key) {
            return Ok(());
        }
        servers.insert(connection_key, connection_server);
    }

    spawn_shared_reader_task(
        source,
        connection_key,
        last_ping_at,
        writer_tx_for_reader,
        app_state.app_handle.clone(),
        Arc::clone(app_state),
        pending,
    );

    Ok(())
}

/// Send a `PreInitialize` request on the connection's shared maestro-server and wait
/// for the `PreInitializeOk` response (or an error). The connection server must be
/// running before calling this (use `spawn_connection_server` first).
pub async fn pre_initialize_via_connection_server(
    connection_key: crate::acp::ConnectionKey,
    agent_id: &str,
    cwd: &str,
    app_state: &Arc<crate::core::AppState>,
) -> Result<PreInitializeResponse, String> {
    let (writer_tx, pre_init_pending) = {
        let servers = app_state.acp.connection_servers.lock().await;
        let server = servers
            .get(&connection_key)
            .ok_or_else(|| format!("No connection server for connection {:?}", connection_key))?;
        (server.writer_tx.clone(), server.pending.pre_init.clone())
    };

    let (tx, rx) = oneshot::channel();
    pre_init_pending
        .lock()
        .map_err(|e| format!("Lock poisoned: {}", e))?
        .insert(agent_id.to_string(), tx);

    let req = MaestroRpcMessage::Request(ServerRequest::PreInitialize(PreInitializeRequest {
        agent_id: agent_id.to_string(),
        cwd: cwd.to_string(),
    }));
    let bytes = serialize_message(&req)?;
    writer_tx
        .send(bytes)
        .await
        .map_err(|_| "Connection server writer channel closed".to_string())?;

    let response = tokio::time::timeout(std::time::Duration::from_secs(60), rx)
        .await
        .map_err(|_| format!("PreInitialize timed out for agent {}", agent_id))?
        .map_err(|_| "PreInitialize response channel dropped".to_string())??;

    Ok(response)
}
