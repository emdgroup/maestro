//! ACP session lifecycle operations: spawn, load, write, and restore sessions.

use crate::acp::connection_server::spawn_connection_server;
use crate::acp::reader_task::spawn_reader_task;
use crate::acp::session_types::{
    AcpProcess, AcpProcessParams, AcpTransportWriter, RestorableSession, SessionHostMeta,
    SessionRequest, TaskMetadata, TransportTarget,
};
use crate::acp::transport::{MaestroRpcMessage, ServerRequest, SessionLoadRequest, SpawnRequest};
#[cfg(windows)]
use crate::acp::transport_setup::open_wsl_transport;
use crate::acp::transport_setup::{open_local_transport, open_remote_transport};
use crate::acp::transport_types::{serialize_message, write_to_acp_session_raw};
use std::sync::Arc;
use tauri::Emitter;
use tokio::io::BufWriter;
use tokio::process::ChildStdin;
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

/// Extra workspace roots for this session, read from the project's `.maestro/settings.json`.
///
/// Best-effort by design: a session must still start when the settings file is missing or
/// unreadable, so a failure here yields no directories rather than aborting the spawn. Paths are
/// passed through verbatim — `~` is expanded by `maestro-server`, which runs on the machine the
/// paths refer to.
async fn additional_directories_for(req: &SessionRequest) -> Vec<String> {
    let Some(project_id) = req.project_id else {
        return Vec::new();
    };
    match crate::project::settings::load_project_config_for(&req.app_state, project_id).await {
        Ok(config) => config.additional_directories.unwrap_or_default(),
        Err(e) => {
            log::warn!("could not read additional directories for project {project_id}: {e}");
            Vec::new()
        }
    }
}

/// The blob `maestro-server` stores against a session and hands back when a later app run
/// re-adopts it. See [`SessionHostMeta`].
///
/// Serialization cannot fail for this shape, so a failure is reported and the session still
/// starts: losing the ability to re-adopt it later is not a reason to refuse to run it now.
fn host_meta_for(req: &SessionRequest, task: &TaskMetadata) -> Option<serde_json::Value> {
    let meta = SessionHostMeta {
        project_id: req.project_id,
        session_name: req.session_name.clone(),
        connection_key: req.connection_key,
        task: task.clone(),
    };
    match serde_json::to_value(&meta) {
        Ok(value) => Some(value),
        Err(e) => {
            log::warn!(
                "could not record session metadata for {}: {e}",
                req.session_id
            );
            None
        }
    }
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
        additional_directories: additional_directories_for(req).await,
        host_meta: host_meta_for(req, &task),
    }));
    let bytes = serialize_message(&spawn_req)?;
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
            task,
            initial_acp_session_id: None,
            enable_replay_buffer: true,
        },
        req.session_id.clone(),
        req.app_state.app_handle.clone(),
        Arc::clone(&req.app_state),
    );
    req.app_state
        .acp
        .sessions
        .lock()
        .await
        .insert(req.session_id.clone(), acp_process);

    // Register before sending so a fast SpawnOk can always be routed to this session.
    if writer_tx.send(bytes).await.is_err() {
        req.app_state
            .acp
            .sessions
            .lock()
            .await
            .remove(&req.session_id);
        return Err("Connection server writer channel closed".to_string());
    }
    Ok(true)
}

/// Close an idle live session on the agent and load it back, so its transcript comes with it.
///
/// The close is what makes the load safe. Without it the agent would hold the same conversation
/// open twice, and the server would replace its own entry for the first while its command loop
/// kept running — an agent nothing routes to, still consuming tokens. `SessionClose` also drops
/// the server's live entry, so what follows genuinely is a fresh load.
///
/// Returns whether the session ended up loaded. `false` means the caller should adopt it plainly,
/// which is always still possible: a failed close leaves the session exactly as it was.
async fn reload_for_history(
    session: &maestro_protocol::ListLiveSession,
    acp_session_id: &str,
    meta: &SessionHostMeta,
    connection_key: crate::acp::ConnectionKey,
    app_state: &Arc<crate::core::AppState>,
) -> bool {
    let close = crate::acp::connection_server::query_session_close_via_server(
        connection_key,
        crate::acp::transport::SessionCloseRequest {
            agent_id: session.agent_id.clone(),
            session_id: acp_session_id.to_string(),
            cwd: session.cwd.clone(),
        },
        app_state,
    )
    .await;
    if let Err(e) = close {
        log::warn!(
            "could not close session {} to recover its history, adopting it as-is: {e}",
            session.session_id
        );
        return false;
    }

    // A new routing key: the server forgot the old one when it closed the session, and reusing it
    // would name a session that no longer exists on either side.
    let req = SessionRequest {
        connection_key,
        agent_id: session.agent_id.clone(),
        cwd: session.cwd.clone(),
        session_id: crate::core::new_session_id(),
        session_name: meta.session_name.clone(),
        project_id: meta.project_id,
        task_id: meta.task.task_id,
        app_state: Arc::clone(app_state),
    };
    match try_session_load_via_connection_server(acp_session_id, &req).await {
        Ok(true) => true,
        // The session is gone from the server either way now, so there is nothing left to adopt
        // and the user has to reopen it from the session history.
        Ok(false) | Err(_) => {
            log::warn!(
                "closed session {} but could not load it back",
                session.session_id
            );
            true
        }
    }
}

/// Sessions this project's automation runs are happening in, as the server's own records name them.
///
/// Best effort: a server too old to know about automations, or one whose store would not open,
/// leaves this empty and costs nothing but an unadopted automation session.
async fn automation_session_ids(
    project_id: i32,
    app_state: &Arc<crate::core::AppState>,
) -> std::collections::HashSet<String> {
    let (connection_key, project_path) =
        match crate::core::get_project_with_git_conn(app_state, project_id).await {
            Ok((project, _)) => (
                crate::acp::ConnectionKey::from_all_ids(
                    project.connection_id,
                    project.wsl_connection_id,
                    project.docker_connection_id,
                ),
                project.path,
            ),
            Err(e) => {
                log::warn!("cannot read project {project_id} to find its automation runs: {e}");
                return std::collections::HashSet::new();
            }
        };

    match crate::acp::connection_server::query_automation_runs_via_server(
        connection_key,
        project_path,
        None,
        app_state,
    )
    .await
    {
        Ok(response) => response
            .runs
            .into_iter()
            .filter(|run| matches!(run.status, maestro_protocol::AutomationRunStatus::Running))
            .filter_map(|run| run.session_id)
            .collect(),
        Err(e) => {
            log::warn!("cannot list automation runs on {connection_key:?}: {e}");
            std::collections::HashSet::new()
        }
    }
}

/// Take ownership of sessions the connection's server is already running.
///
/// The server outlives the app now, so a freshly started app finds sessions it has no record of:
/// its own map is empty while the server's is not. This rebuilds a host-side entry for each of
/// them, keyed by the same id the server files it under, so every later prompt, cancel and event
/// routes exactly as it did in the run that started the session.
///
/// Scoped to one project because the app is: a machine's server holds sessions for every project
/// opened against it, and the ones belonging to other projects are adopted when those are opened.
///
/// A session that is **not** mid-turn is closed on the agent and loaded straight back instead,
/// which is the only way to recover the transcript it produced while nobody was attached: the
/// agent persists its own history and `session/load` is what replays it. That cannot be done to a
/// session mid-turn — closing discards the turn in progress — so those are adopted as they are and
/// their transcript begins where the app reconnected.
///
/// Best effort throughout — a server too old to answer, a session whose metadata cannot be read,
/// an agent that refuses the reload — must not stop a project from opening. Each failure degrades
/// to plain adoption rather than to a lost session.
///
/// Returns how many were taken over, reloaded or not.
pub async fn adopt_live_sessions(
    connection_key: crate::acp::ConnectionKey,
    project_id: i32,
    app_state: &Arc<crate::core::AppState>,
) -> usize {
    let live = match crate::acp::connection_server::query_live_sessions_via_server(
        connection_key,
        app_state,
    )
    .await
    {
        Ok(response) => response.sessions,
        Err(e) => {
            log::warn!("could not list live sessions on {connection_key:?}: {e}");
            return 0;
        }
    };

    let (writer_tx, pending) = {
        let servers = app_state.acp.connection_servers.lock().await;
        match servers.get(&connection_key) {
            Some(server) => (server.writer_tx.clone(), server.pending.clone()),
            None => return 0,
        }
    };

    // Sessions an automation started carry nothing of ours: the server spawned them with no
    // `host_meta` because it had none to attach. The run rows pointing at them are what says they
    // belong to this project, so they are adopted on that evidence instead.
    let automation_sessions = automation_session_ids(project_id, app_state).await;

    let mut adopted = 0;
    for session in live {
        let from_automation = automation_sessions.contains(&session.session_id);
        let meta = session
            .host_meta
            .as_ref()
            .and_then(|value| {
                serde_json::from_value::<SessionHostMeta>(value.clone())
                    .map_err(|e| {
                        log::warn!(
                            "session {} has unreadable metadata: {e}",
                            session.session_id
                        )
                    })
                    .ok()
            })
            // An automation's session has none, so one is made up from what is known: the project
            // it belongs to, and the connection it is already running on.
            .or_else(|| {
                from_automation.then(|| SessionHostMeta {
                    project_id: Some(project_id),
                    session_name: None,
                    connection_key,
                    task: TaskMetadata::default(),
                })
            });
        let Some(meta) = meta else { continue };
        if meta.project_id != Some(project_id) {
            continue;
        }
        if app_state
            .acp
            .sessions
            .lock()
            .await
            .contains_key(&session.session_id)
        {
            continue;
        }

        if let Some(acp_session_id) = session.acp_session_id.as_deref() {
            if !session.turn_active
                && reload_for_history(&session, acp_session_id, &meta, connection_key, app_state)
                    .await
            {
                adopted += 1;
                continue;
            }
        }

        let (acp_process, _ctx) = AcpProcess::create(
            AcpProcessParams {
                writer: AcpTransportWriter::SharedServer(writer_tx.clone()),
                child: None,
                cancel_tx: None,
                cwd: session.cwd.clone(),
                session_name: meta.session_name.clone(),
                agent_id: session.agent_id.clone(),
                project_id: meta.project_id,
                connection_key,
                task: meta.task.clone(),
                initial_acp_session_id: session.acp_session_id.clone(),
                // Nothing has subscribed to this session yet, so its updates have to be held
                // until the frontend opens it, exactly as for a session being loaded.
                enable_replay_buffer: true,
            },
            session.session_id.clone(),
            app_state.app_handle.clone(),
            Arc::clone(app_state),
        );
        app_state
            .acp
            .sessions
            .lock()
            .await
            .insert(session.session_id.clone(), acp_process);

        // After the insert, never before: these go through the same routing every live message
        // takes, and that routing drops anything addressed to a session this side does not hold
        // yet. Replaying them is what makes a prompt the previous client was shown answerable
        // again — the agent is still blocked on it, and the message that asked went to a client
        // that is gone.
        for request in session.pending_requests {
            let msg = match request {
                maestro_protocol::PendingSessionRequest::Permission(request) => {
                    MaestroRpcMessage::Response(
                        crate::acp::transport::ServerResponse::PermissionRequest(request),
                    )
                }
                maestro_protocol::PendingSessionRequest::Elicitation(request) => {
                    MaestroRpcMessage::Response(
                        crate::acp::transport::ServerResponse::ElicitationRequest(request),
                    )
                }
            };
            crate::acp::reader_task::handle_shared_server_message(
                msg,
                connection_key,
                &app_state.app_handle,
                app_state,
                &pending,
            )
            .await;
        }
        adopted += 1;
    }

    if adopted > 0 {
        log::info!("adopted {adopted} running session(s) on {connection_key:?}");
        if let Err(e) = app_state.app_handle.emit("sessions-changed", ()) {
            log::warn!("could not announce adopted sessions: {e}");
        }
    }
    adopted
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
            (
                AcpTransportWriter::Local(Arc::new(tokio::sync::Mutex::new(stdin_writer))),
                source,
                Some(child),
            )
        }
        TransportTarget::Remote { ssh, server_path } => {
            let (write_tx, source) = open_remote_transport(ssh, server_path).await?;
            let bytes = serialize_message(initial_msg)?;
            write_tx.send(bytes).await.map_err(|_| {
                format!("Failed to queue {} for remote channel", remote_error_label)
            })?;
            (AcpTransportWriter::RemoteSsh(write_tx), source, None)
        }
        #[cfg(windows)]
        TransportTarget::Wsl {
            distro,
            server_path,
        } => {
            let (mut stdin_writer, source, child) = open_wsl_transport(distro, server_path).await?;
            write_to_acp_session_raw(&mut stdin_writer, initial_msg).await?;
            (
                AcpTransportWriter::Local(Arc::new(tokio::sync::Mutex::new(stdin_writer))),
                source,
                Some(child),
            )
        }
        TransportTarget::Docker {
            cli,
            container_name,
            server_path,
        } => {
            let (mut stdin_writer, source, child) =
                crate::acp::transport_setup::open_container_transport(
                    cli,
                    container_name,
                    server_path,
                )
                .await?;
            write_to_acp_session_raw(&mut stdin_writer, initial_msg).await?;
            (
                AcpTransportWriter::Local(Arc::new(tokio::sync::Mutex::new(stdin_writer))),
                source,
                Some(child),
            )
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
        req.session_id.clone(),
        req.app_state.app_handle.clone(),
        Arc::clone(&req.app_state),
    );

    req.app_state
        .acp
        .sessions
        .lock()
        .await
        .insert(req.session_id.clone(), acp_process);
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
        additional_directories: additional_directories_for(req).await,
        host_meta: host_meta_for(req, &task),
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
        session_id: req.session_id.clone(),
        resume_session_id: acp_session_id.to_string(),
        cwd: req.cwd.clone(),
        additional_directories: additional_directories_for(req).await,
        host_meta: host_meta_for(
            req,
            &TaskMetadata {
                task_id: req.task_id,
                ..TaskMetadata::default()
            },
        ),
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

/// Write a message to an active ACP session's transport by session_id.
///
/// Acquires the sessions lock only long enough to extract the writer handle, then
/// releases the lock before performing any async I/O, preventing sessions-lock
/// contention while the write is in progress.
pub async fn write_to_acp_session(
    app_state: &crate::core::AppState,
    session_id: &str,
    msg: &MaestroRpcMessage,
) -> Result<(), String> {
    enum WriterHandle {
        Local(Arc<tokio::sync::Mutex<BufWriter<ChildStdin>>>),
        Channel(tokio::sync::mpsc::Sender<Vec<u8>>),
    }

    let writer_handle = {
        let sessions = app_state.acp.sessions.lock().await;
        let session = sessions
            .get(session_id)
            .ok_or_else(|| format!("No ACP session for session_id {}", session_id))?;
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
            tx.send(bytes).await.map_err(|_| {
                format!(
                    "ACP session write failed: channel closed for session_id {}",
                    session_id
                )
            })
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
            format!(
                "maestro-server path not cached for connection {conn_id}. Reconnect to refresh."
            )
        })?;
    let ssh = app_state.ssh.get_session(conn_id).await.ok_or_else(|| {
        format!("No active SSH session for connection_id {conn_id}. Connect first.")
    })?;
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
        session_id: req.session_id.clone(),
        resume_session_id: acp_session_id.to_string(),
        cwd: req.cwd.clone(),
        additional_directories: additional_directories_for(req).await,
        host_meta: host_meta_for(
            req,
            &TaskMetadata {
                task_id: req.task_id,
                ..TaskMetadata::default()
            },
        ),
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
            task: TaskMetadata {
                task_id: req.task_id,
                ..TaskMetadata::default()
            },
            initial_acp_session_id: Some(acp_session_id.to_string()),
            enable_replay_buffer: true,
        },
        req.session_id.clone(),
        req.app_state.app_handle.clone(),
        Arc::clone(&req.app_state),
    );
    req.app_state
        .acp
        .sessions
        .lock()
        .await
        .insert(req.session_id.clone(), acp_process);

    if writer_tx.send(bytes).await.is_err() {
        req.app_state
            .acp
            .sessions
            .lock()
            .await
            .remove(&req.session_id);
        return Err("Connection server writer channel closed".to_string());
    }
    Ok(true)
}

/// Re-spawn the shared maestro-server for a connection and reload sessions that were
/// active when it died. Called after SSH successfully reconnects.
/// Emits `acp://session-ended/{session_id}` for any session that cannot be restored.
pub async fn restore_acp_sessions(
    connection_id: i32,
    app_state: &Arc<crate::core::AppState>,
) -> Result<(), String> {
    let (ssh, server_path) = resolve_remote_context(app_state, connection_id).await?;

    spawn_connection_server(
        crate::acp::ConnectionKey::Ssh { id: connection_id },
        TransportTarget::Remote {
            ssh: &ssh,
            server_path: &server_path,
        },
        app_state,
    )
    .await?;

    let sessions: Vec<RestorableSession> = app_state
        .acp
        .restorable_sessions
        .lock()
        .await
        .remove(&connection_id)
        .unwrap_or_default();

    for s in &sessions {
        let Some(acp_session_id) = &s.acp_session_id else {
            let _ = app_state
                .app_handle
                .emit(&format!("acp://session-ended/{}", s.session_id), ());
            continue;
        };

        let reloaded_session_id = crate::core::new_session_id();

        let req = SessionRequest {
            connection_key: crate::acp::ConnectionKey::Ssh { id: connection_id },
            agent_id: s.agent_id.clone(),
            cwd: s.cwd.clone(),
            session_id: reloaded_session_id,
            session_name: s.session_name.clone(),
            project_id: s.project_id,
            task_id: s.task_id,
            app_state: Arc::clone(app_state),
        };
        match try_session_load_via_connection_server(acp_session_id, &req).await {
            Ok(true) => {}
            _ => {
                let _ = app_state
                    .app_handle
                    .emit(&format!("acp://session-ended/{}", s.session_id), ());
            }
        }
    }

    app_state.app_handle.emit("sessions-changed", ()).ok();
    Ok(())
}
