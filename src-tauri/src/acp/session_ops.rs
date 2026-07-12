//! ACP session lifecycle operations: spawn, load, write, and restore sessions.

use std::sync::Arc;
use tauri::Emitter;
use tokio::io::BufWriter;
use tokio::process::ChildStdin;
use crate::acp::transport::{
    MaestroRpcMessage, ServerRequest, SpawnRequest, SessionLoadRequest,
};
use crate::acp::transport_types::{serialize_message, write_to_acp_session_raw};
use crate::acp::transport_setup::{open_local_transport, open_remote_transport};
#[cfg(windows)]
use crate::acp::transport_setup::open_wsl_transport;
use crate::acp::session_types::{
    AcpProcess, AcpProcessParams, AcpTransportWriter, SessionRequest,
    TaskMetadata, TransportTarget, RestorableSession,
};
use crate::acp::reader_task::spawn_reader_task;
use crate::acp::connection_server::spawn_connection_server;
use tokio::sync::oneshot;

pub fn upsert_session_alias(
    conn: &rusqlite::Connection,
    project_id: i32,
    agent_id: &str,
    acp_session_id: &str,
    display_name: &str,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO session_aliases (project_id, agent_id, acp_session_id, display_name) \
         VALUES (?1, ?2, ?3, ?4) \
         ON CONFLICT(project_id, agent_id, acp_session_id) DO UPDATE SET display_name = excluded.display_name",
        rusqlite::params![project_id, agent_id, acp_session_id, display_name],
    ).map(|_| ())
}

/// Fast path: route a new session through a running `ConnectionServer`.
///
/// Returns `true` if the session was registered via the shared server,
/// `false` if no connection server is running (caller should fall through to cold path).
pub async fn try_spawn_via_connection_server(
    session_id: &str,
    task: TaskMetadata,
    req: &SessionRequest,
) -> Result<bool, String> {
    let writer_tx = {
        let servers = req.app_state.acp.connection_servers.lock().await;
        match servers.get(&req.connection_key) {
            Some(s) => s.writer_tx.clone(),
            None => return Ok(false),
        }
    };
    let spawn_req = MaestroRpcMessage::Request(ServerRequest::Spawn(SpawnRequest {
        agent_id: req.agent_id.clone(),
        session_id: session_id.to_string(),
        cwd: req.cwd.clone(),
    }));
    let bytes = serialize_message(&spawn_req)?;
    writer_tx
        .send(bytes)
        .await
        .map_err(|_| "Connection server writer channel closed".to_string())?;

    let (acp_process, _ctx) = AcpProcess::create(
        AcpProcessParams {
            writer: AcpTransportWriter::SharedServer(writer_tx),
            child: None,
            cancel_tx: None,
            cwd: req.cwd.clone(),
            session_name: req.session_name.clone(),
            agent_id: req.agent_id.clone(),
            project_id: req.project_id,
            connection_key: req.connection_key,
            task,
            initial_acp_session_id: None,
            enable_replay_buffer: true,
        },
        req.log_id,
        req.app_state.app_handle.clone(),
        Arc::clone(&req.app_state),
    );
    req.app_state.acp.sessions.lock().await.insert(req.log_id, acp_process);
    Ok(true)
}

/// Open a transport channel, write the initial message, register the ACP process, and
/// spawn the reader task. Shared by `spawn_acp_session_cold` and `load_acp_session_cold`.
async fn launch_cold_session(
    target: TransportTarget<'_>,
    initial_msg: &MaestroRpcMessage,
    remote_error_label: &str,
    task: TaskMetadata,
    initial_acp_session_id: Option<String>,
    enable_replay_buffer: bool,
    req: &SessionRequest,
) -> Result<(), String> {
    let (writer, source, child) = match target {
        TransportTarget::Local => {
            let (mut stdin_writer, source, child) = open_local_transport(&req.app_state).await?;
            write_to_acp_session_raw(&mut stdin_writer, initial_msg).await?;
            (AcpTransportWriter::Local(Arc::new(tokio::sync::Mutex::new(stdin_writer))), source, Some(child))
        }
        TransportTarget::Remote { ssh, server_path } => {
            let (write_tx, source) = open_remote_transport(ssh, server_path).await?;
            let bytes = serialize_message(initial_msg)?;
            write_tx
                .send(bytes)
                .await
                .map_err(|_| format!("Failed to queue {} for remote channel", remote_error_label))?;
            (AcpTransportWriter::RemoteSsh(write_tx), source, None)
        }
        #[cfg(windows)]
        TransportTarget::Wsl { distro, server_path } => {
            let (mut stdin_writer, source, child) = open_wsl_transport(distro, server_path).await?;
            write_to_acp_session_raw(&mut stdin_writer, initial_msg).await?;
            (AcpTransportWriter::Local(Arc::new(tokio::sync::Mutex::new(stdin_writer))), source, Some(child))
        }
        TransportTarget::Docker { cli, container_name, server_path } => {
            let (mut stdin_writer, source, child) = crate::acp::transport_setup::open_container_transport(cli, container_name, server_path).await?;
            write_to_acp_session_raw(&mut stdin_writer, initial_msg).await?;
            (AcpTransportWriter::Local(Arc::new(tokio::sync::Mutex::new(stdin_writer))), source, Some(child))
        }
    };

    let (cancel_tx, cancel_rx) = oneshot::channel::<()>();
    let (acp_process, ctx) = AcpProcess::create(
        AcpProcessParams {
            writer,
            child,
            cancel_tx: Some(cancel_tx),
            cwd: req.cwd.clone(),
            session_name: req.session_name.clone(),
            agent_id: req.agent_id.clone(),
            project_id: req.project_id,
            connection_key: req.connection_key,
            task,
            initial_acp_session_id,
            enable_replay_buffer,
        },
        req.log_id,
        req.app_state.app_handle.clone(),
        Arc::clone(&req.app_state),
    );

    req.app_state.acp.sessions.lock().await.insert(req.log_id, acp_process);
    spawn_reader_task(source, cancel_rx, ctx);

    Ok(())
}

/// Cold path: spawn a dedicated maestro-server and start a new ACP session.
/// Uses `TransportTarget` to abstract over local subprocess vs remote SSH channel.
pub async fn spawn_acp_session_cold(
    target: TransportTarget<'_>,
    session_id: &str,
    task: TaskMetadata,
    req: &SessionRequest,
) -> Result<(), String> {
    let initial_msg = MaestroRpcMessage::Request(ServerRequest::Spawn(SpawnRequest {
        agent_id: req.agent_id.clone(),
        session_id: session_id.to_string(),
        cwd: req.cwd.clone(),
    }));
    launch_cold_session(target, &initial_msg, "SpawnRequest", task, None, false, req).await
}

/// Cold path: spawn a dedicated maestro-server and resume an existing ACP session.
/// Uses `TransportTarget` to abstract over local subprocess vs remote SSH channel.
pub async fn load_acp_session_cold(
    target: TransportTarget<'_>,
    acp_session_id: &str,
    req: &SessionRequest,
) -> Result<(), String> {
    let initial_msg = MaestroRpcMessage::Request(ServerRequest::SessionLoad(SessionLoadRequest {
        agent_id: req.agent_id.clone(),
        session_id: format!("session-{}", req.log_id),
        resume_session_id: acp_session_id.to_string(),
        cwd: req.cwd.clone(),
    }));
    launch_cold_session(
        target,
        &initial_msg,
        "SessionLoad",
        TaskMetadata::default(),
        Some(acp_session_id.to_string()),
        true,
        req,
    )
    .await
}

/// Write a message to an active ACP session's transport by log_id.
///
/// Acquires the sessions lock only long enough to extract the writer handle, then
/// releases the lock before performing any async I/O, preventing sessions-lock
/// contention while the write is in progress.
pub async fn write_to_acp_session(
    app_state: &crate::core::AppState,
    log_id: i32,
    msg: &MaestroRpcMessage,
) -> Result<(), String> {
    enum WriterHandle {
        Local(Arc<tokio::sync::Mutex<BufWriter<ChildStdin>>>),
        Channel(tokio::sync::mpsc::Sender<Vec<u8>>),
    }

    let writer_handle = {
        let sessions = app_state.acp.sessions.lock().await;
        let session = sessions
            .get(&log_id)
            .ok_or_else(|| format!("No ACP session for log_id {}", log_id))?;
        match &session.writer {
            AcpTransportWriter::Local(writer) => WriterHandle::Local(Arc::clone(writer)),
            AcpTransportWriter::RemoteSsh(tx) | AcpTransportWriter::SharedServer(tx) => {
                WriterHandle::Channel(tx.clone())
            }
        }
    }; // sessions lock released here

    match writer_handle {
        WriterHandle::Local(writer) => {
            let mut guard = writer.lock().await;
            write_to_acp_session_raw(&mut guard, msg).await
        }
        WriterHandle::Channel(tx) => {
            let bytes = serialize_message(msg)?;
            tx.send(bytes).await
                .map_err(|_| format!("ACP session write failed: channel closed for log_id {}", log_id))
        }
    }
}

/// Retrieve the SSH session and cached maestro-server path for a remote connection.
/// Used by IPC handlers and the session restore path.
pub async fn resolve_remote_context(
    app_state: &Arc<crate::core::AppState>,
    conn_id: i32,
) -> Result<(crate::connectivity::ssh::RemoteSshSession, String), String> {
    let maestro_path = app_state
        .acp
        .discovery_cache
        .lock()
        .await
        .get(&crate::acp::ConnectionKey::Ssh { id: conn_id })
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

/// Load a session through the shared connection server (fast path).
/// Returns `Ok(true)` if the server was running and the request was sent.
/// Returns `Ok(false)` if no connection server exists for this connection.
pub async fn try_session_load_via_connection_server(
    acp_session_id: &str,
    req: &SessionRequest,
) -> Result<bool, String> {
    let writer_tx = {
        let servers = req.app_state.acp.connection_servers.lock().await;
        match servers.get(&req.connection_key) {
            Some(s) => s.writer_tx.clone(),
            None => return Ok(false),
        }
    };
    let load_msg = MaestroRpcMessage::Request(ServerRequest::SessionLoad(SessionLoadRequest {
        agent_id: req.agent_id.clone(),
        session_id: format!("session-{}", req.log_id),
        resume_session_id: acp_session_id.to_string(),
        cwd: req.cwd.clone(),
    }));
    let bytes = serialize_message(&load_msg)?;

    // Register session BEFORE sending so the shared reader can route SessionUpdate messages
    // into the replay buffer immediately — avoids silent drops if the server replies fast.
    let (acp_process, _ctx) = AcpProcess::create(
        AcpProcessParams {
            writer: AcpTransportWriter::SharedServer(writer_tx.clone()),
            child: None,
            cancel_tx: None,
            cwd: req.cwd.clone(),
            session_name: req.session_name.clone(),
            agent_id: req.agent_id.clone(),
            project_id: req.project_id,
            connection_key: req.connection_key,
            task: TaskMetadata { task_id: req.task_id, ..TaskMetadata::default() },
            initial_acp_session_id: Some(acp_session_id.to_string()),
            enable_replay_buffer: true,
        },
        req.log_id,
        req.app_state.app_handle.clone(),
        Arc::clone(&req.app_state),
    );
    req.app_state.acp.sessions.lock().await.insert(req.log_id, acp_process);

    if writer_tx.send(bytes).await.is_err() {
        req.app_state.acp.sessions.lock().await.remove(&req.log_id);
        return Err("Connection server writer channel closed".to_string());
    }
    Ok(true)
}

/// Re-spawn the shared maestro-server for a connection and reload sessions that were
/// active when it died. Called after SSH successfully reconnects.
/// Emits `acp://session-ended/{log_id}` for any session that cannot be restored.
pub async fn restore_acp_sessions(
    connection_id: i32,
    app_state: &Arc<crate::core::AppState>,
) -> Result<(), String> {
    let (ssh, server_path) = resolve_remote_context(app_state, connection_id).await?;

    spawn_connection_server(
        crate::acp::ConnectionKey::Ssh { id: connection_id },
        TransportTarget::Remote { ssh: &ssh, server_path: &server_path },
        app_state,
    ).await?;

    let sessions: Vec<RestorableSession> = app_state
        .acp
        .restorable_sessions
        .lock()
        .await
        .remove(&connection_id)
        .unwrap_or_default();

    for s in &sessions {
        let Some(acp_session_id) = &s.acp_session_id else {
            let _ = app_state.app_handle.emit(&format!("acp://session-ended/{}", s.log_id), ());
            continue;
        };

        let new_log_id = app_state
            .pty
            .session_counter
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);

        let req = SessionRequest {
            connection_key: crate::acp::ConnectionKey::Ssh { id: connection_id },
            agent_id: s.agent_id.clone(),
            cwd: s.cwd.clone(),
            log_id: new_log_id,
            session_name: s.session_name.clone(),
            project_id: s.project_id,
            task_id: s.task_id,
            app_state: Arc::clone(app_state),
        };
        match try_session_load_via_connection_server(acp_session_id, &req).await {
            Ok(true) => {}
            _ => {
                let _ = app_state.app_handle.emit(&format!("acp://session-ended/{}", s.log_id), ());
            }
        }
    }

    app_state.app_handle.emit("sessions-changed", ()).ok();
    Ok(())
}
