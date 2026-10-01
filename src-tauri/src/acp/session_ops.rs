//! ACP session lifecycle operations: spawn, load, write, and restore sessions.

use crate::acp::connection_server::spawn_connection_server;
use crate::acp::reader_task::spawn_reader_task;
use crate::acp::session_types::{
    AcpProcess, AcpProcessParams, AcpTransportWriter, SessionRequest, TaskMetadata, TransportTarget,
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

/// The project's path as this app's own row has it, which is what the daemon files a session
/// under. `None` for a project that is gone, which leaves the session without a row there.
fn project_path(app_state: &crate::core::AppState, project_id: i32) -> Option<String> {
    let conn = app_state.db.lock().ok()?;
    conn.query_row(
        "SELECT path FROM projects WHERE id = ?",
        [project_id],
        |row| row.get(0),
    )
    .map_err(|e| log::warn!("cannot read the path of project {project_id}: {e}"))
    .ok()
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
        project_path: req
            .project_id
            .and_then(|project_id| project_path(&req.app_state, project_id)),
        meta: task.to_session_meta(req.session_name.clone()),
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

/// What opening a project does with one of its open conversations.
#[derive(Debug, PartialEq)]
enum RowAction {
    /// Take the running session over as it stands.
    Adopt,
    /// Close the running session on the agent and load it back, for its transcript.
    Reload,
    /// Load a conversation nothing is running.
    Load,
    Skip,
}

/// `turn_active` is `None` for a conversation the daemon is not running.
///
/// Closing is what makes the reload safe: without it the agent would hold the same conversation
/// open twice, and the server would replace its own entry for the first while its command loop
/// kept running. It also discards a turn in progress, so a session mid-turn is adopted instead and
/// its transcript begins at the reconnect. One the agent cannot load back is never closed, and
/// neither is the single session an automation just started: it has no history yet, and closing it
/// would throw away the prompt it was started with.
fn row_action(turn_active: Option<bool>, can_reload: bool, single: bool) -> RowAction {
    match turn_active {
        Some(false) if can_reload && !single => RowAction::Reload,
        Some(_) => RowAction::Adopt,
        None if can_reload => RowAction::Load,
        None => RowAction::Skip,
    }
}

/// Whether an entry this window holds for a row's conversation is that row's session.
///
/// A running row is held only under the routing id the daemon runs it under. After another window
/// took the project over and reloaded the session, this window's entry names an id the daemon no
/// longer routes, and every prompt sent to it would go nowhere. A dormant row is held only by a load
/// still in flight from here; an entry that had come up is one whose session has since stopped.
fn holds_row(entry_session_id: &str, initialized: bool, live_session_id: Option<&str>) -> bool {
    match live_session_id {
        Some(live_session_id) => entry_session_id == live_session_id,
        None => !initialized,
    }
}

/// Drop entries whose sessions the daemon no longer runs under these ids, without asking it to
/// close anything: the conversation itself belongs to whoever runs it now.
pub(crate) async fn forget_sessions(
    app_state: &Arc<crate::core::AppState>,
    session_ids: &[String],
) {
    if session_ids.is_empty() {
        return;
    }
    {
        let mut sessions = app_state.acp.sessions.lock().await;
        for session_id in session_ids {
            if let Some(mut session) = sessions.remove(session_id) {
                if let Some(cancel_tx) = session.reader_cancel_tx.take() {
                    if cancel_tx.send(()).is_err() {
                        log::debug!("[acp] reader for session_id={session_id} already stopped");
                    }
                }
            }
        }
    }
    log::debug!("[acp] forgot sessions no longer running here: {session_ids:?}");
    if let Err(e) = app_state.app_handle.emit("sessions-changed", ()) {
        log::warn!("[acp] emit sessions-changed failed: {e}");
    }
}

/// The project a `TaskSessionStarted` is for, when it is the one this window holds on that
/// connection. Every other window leaves the session to whoever holds its project.
pub(crate) fn task_session_target(
    held: Option<(i32, crate::acp::ConnectionKey)>,
    connection_key: crate::acp::ConnectionKey,
    project_id: Option<i32>,
) -> Option<i32> {
    match (held, project_id) {
        (Some((held_id, held_key)), Some(project_id))
            if held_id == project_id && held_key == connection_key =>
        {
            Some(project_id)
        }
        _ => None,
    }
}

/// Entries for a task's earlier sessions: the daemon closed them when it started `keep`.
fn superseded_task_sessions<'a>(
    entries: impl Iterator<Item = (&'a String, Option<i32>, Option<i32>)>,
    project_id: i32,
    task_id: i32,
    keep: &str,
) -> Vec<String> {
    entries
        .filter(|(session_id, entry_project, entry_task)| {
            *entry_project == Some(project_id)
                && *entry_task == Some(task_id)
                && session_id.as_str() != keep
        })
        .map(|(session_id, _, _)| session_id.clone())
        .collect()
}

/// Take over a session the daemon started for a task, dropping what this window still held of
/// the task's earlier ones. The row carries the task and role, so the card and the session panel
/// read them as they would for a session this window spawned.
///
/// Boxed as `Send` because the reader spawns it and it reaches the reader again through
/// [`attach_project_sessions`]; without the box the compiler cannot prove that cycle `Send`.
pub(crate) fn adopt_task_session(
    connection_key: crate::acp::ConnectionKey,
    project_id: i32,
    task_id: i32,
    session_id: String,
    app_state: Arc<crate::core::AppState>,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> {
    Box::pin(async move {
        let stale = {
            let sessions = app_state.acp.sessions.lock().await;
            superseded_task_sessions(
                sessions
                    .iter()
                    .map(|(id, proc)| (id, proc.project_id, proc.task_id)),
                project_id,
                task_id,
                &session_id,
            )
        };
        forget_sessions(&app_state, &stale).await;
        attach_project_sessions(connection_key, project_id, Some(&session_id), &app_state).await;
    })
}

/// Bring this project's open conversations into this window, from the daemon's own rows.
///
/// The daemon outlives the app and keeps one row per conversation, so a freshly opened project, a
/// second window taking it over and an SSH connection coming back all ask the same question and get
/// the same answer. Each open row this side does not hold already is handled as [`row_action`]
/// says: a running session is adopted under the id the daemon files it under, so every later
/// prompt, cancel and event routes as it did in the run that started it, and a dormant one is
/// loaded.
///
/// Best effort throughout: a server that cannot answer or an agent that refuses the close must not
/// stop a project from opening. A failed close degrades to plain adoption, and a load that cannot
/// start fails the task that was waiting on it rather than leaving it claiming an agent is at work.
///
/// `only` narrows this to one running session: an automation's, announced while the window was
/// already attached.
///
/// Returns how many were brought in.
pub async fn attach_project_sessions(
    connection_key: crate::acp::ConnectionKey,
    project_id: i32,
    only: Option<&str>,
    app_state: &Arc<crate::core::AppState>,
) -> usize {
    let Some(project_path) = project_path(app_state, project_id) else {
        return 0;
    };
    let rows = match crate::acp::connection_server::query_project_sessions_via_server(
        connection_key,
        project_path.clone(),
        false,
        app_state,
    )
    .await
    {
        Ok(response) => response.sessions,
        Err(e) => {
            log::warn!("could not list the sessions of {project_path} on {connection_key:?}: {e}");
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

    let mut attached = 0;
    for row in rows {
        if row.closed {
            continue;
        }
        let live_session_id = row.live.as_ref().map(|live| live.session_id.as_str());
        if only.is_some_and(|wanted| live_session_id != Some(wanted)) {
            continue;
        }
        let (held, stale) = {
            let sessions = app_state.acp.sessions.lock().await;
            let mut held = false;
            let mut stale = Vec::new();
            for (session_id, proc) in sessions.iter() {
                let same_key = proc.agent_id_meta == row.agent_id
                    && proc
                        .acp_session_id
                        .lock()
                        .is_ok_and(|held| held.as_deref() == Some(row.acp_session_id.as_str()));
                if live_session_id != Some(session_id.as_str()) && !same_key {
                    continue;
                }
                let initialized = proc.initialized.lock().is_ok_and(|done| *done);
                if holds_row(session_id, initialized, live_session_id) {
                    held = true;
                } else {
                    stale.push(session_id.clone());
                }
            }
            (held, stale)
        };
        if held {
            continue;
        }
        forget_sessions(app_state, &stale).await;

        let task = TaskMetadata::from_session_meta(&row.meta);
        let action = row_action(
            row.live.as_ref().map(|live| live.turn_active),
            row.can_reload,
            only.is_some(),
        );
        if action == RowAction::Skip {
            continue;
        }
        let mut live = row.live;
        if action == RowAction::Reload {
            // `SessionClose` drops the server's live entry and leaves the row open, so what
            // follows genuinely is a fresh load. A failed close leaves the session as it was.
            match crate::acp::connection_server::query_session_close_via_server(
                connection_key,
                crate::acp::transport::SessionCloseRequest {
                    agent_id: row.agent_id.clone(),
                    session_id: row.acp_session_id.clone(),
                    cwd: row.cwd.clone(),
                },
                app_state,
            )
            .await
            {
                Ok(()) => live = None,
                Err(e) => log::warn!(
                    "could not close session {} to recover its history, adopting it as-is: {e}",
                    row.acp_session_id
                ),
            }
        }

        let Some(live) = live else {
            let task_key = crate::acp::TaskKey::of(Some(project_id), task.task_id);
            match crate::acp::session_handlers::restore_acp_session(
                app_state,
                row.agent_id,
                row.acp_session_id,
                row.cwd,
                connection_key,
                row.meta.session_name,
                Some(project_id),
                task,
            )
            .await
            {
                Ok(_) => attached += 1,
                // The load could not even be sent, so nothing is known about the conversation and
                // its row stays open for the next attempt. A load the agent refuses is answered
                // later, to the reader, which is also where a row is closed for good. The task
                // is failed either way, or it would go on claiming an agent is at work.
                Err(e) => {
                    log::warn!("[acp] could not restore a session of {project_path}: {e}");
                    crate::acp::reader_task::fail_task_if_still_running(app_state, task_key);
                }
            }
            continue;
        };

        let (acp_process, _ctx) = AcpProcess::create(
            AcpProcessParams {
                writer: AcpTransportWriter::SharedServer(writer_tx.clone()),
                child: None,
                cancel_tx: None,
                cwd: row.cwd,
                session_name: row.meta.session_name,
                agent_id: row.agent_id,
                project_id: Some(project_id),
                connection_key,
                task,
                initial_acp_session_id: Some(row.acp_session_id),
                // Nothing has subscribed to this session yet, so its updates have to be held
                // until the frontend opens it, exactly as for a session being loaded.
                enable_replay_buffer: true,
            },
            live.session_id.clone(),
            app_state.app_handle.clone(),
            Arc::clone(app_state),
        );
        // Initialised already: it is running on the server. `SpawnOk` and `SessionLoadOk` are what
        // normally set this, and an adopted session receives neither, so without it the replay
        // drain never announced `replay-drained` and the view sat on its loading skeleton forever.
        match acp_process.initialized.lock() {
            Ok(mut initialized) => *initialized = true,
            Err(e) => log::warn!("session {} lock poisoned: {e}", live.session_id),
        }
        app_state
            .acp
            .sessions
            .lock()
            .await
            .insert(live.session_id.clone(), acp_process);

        // After the insert, never before: these go through the same routing every live message
        // takes, and that routing drops anything addressed to a session this side does not hold
        // yet. Replaying them is what makes a prompt the previous client was shown answerable
        // again: the agent is still blocked on it, and the message that asked went to a client
        // that is gone.
        //
        // What this window was sent before it held the session goes first, in the order it came:
        // a session the server started on its own talks from its first second, and a canvas
        // asking the user something is exactly what arrives then. A request among them is not
        // replayed a second time from the server's list.
        let unclaimed = crate::acp::reader_task::take_unclaimed(app_state, &live.session_id).await;
        let mut replayed: std::collections::HashSet<String> = std::collections::HashSet::new();
        for msg in unclaimed {
            match &msg {
                MaestroRpcMessage::Response(
                    crate::acp::transport::ServerResponse::PermissionRequest(request),
                ) => {
                    replayed.insert(request.request_id.clone());
                }
                MaestroRpcMessage::Response(
                    crate::acp::transport::ServerResponse::ElicitationRequest(request),
                ) => {
                    replayed.insert(request.request_id.clone());
                }
                _ => {}
            }
            crate::acp::reader_task::handle_shared_server_message(
                msg,
                connection_key,
                &app_state.app_handle,
                app_state,
                &pending,
            )
            .await;
        }
        for request in live.pending_requests {
            let request_id = match &request {
                maestro_protocol::PendingSessionRequest::Permission(request) => &request.request_id,
                maestro_protocol::PendingSessionRequest::Elicitation(request) => {
                    &request.request_id
                }
            };
            if replayed.contains(request_id) {
                continue;
            }
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
        attached += 1;
    }

    if attached > 0 {
        log::info!("attached {attached} session(s) of {project_path} on {connection_key:?}");
        if let Err(e) = app_state.app_handle.emit("sessions-changed", ()) {
            log::warn!("could not announce attached sessions: {e}");
        }
    }
    attached
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
            let (mut stdin_writer, source, child) =
                open_local_transport(&req.app_state, false).await?;
            write_to_acp_session_raw(&mut stdin_writer, initial_msg).await?;
            (
                AcpTransportWriter::Local(Arc::new(tokio::sync::Mutex::new(stdin_writer))),
                source,
                Some(child),
            )
        }
        TransportTarget::Remote { ssh, server_path } => {
            let (write_tx, source) = open_remote_transport(ssh, server_path, false).await?;
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
            let (mut stdin_writer, source, child) =
                open_wsl_transport(distro, server_path, false).await?;
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
                    false,
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
        project_path: req
            .project_id
            .and_then(|project_id| project_path(&req.app_state, project_id)),
        meta: task.to_session_meta(req.session_name.clone()),
    }));
    launch_cold_session(target, &initial_msg, "SpawnRequest", task, None, false, req).await
}

/// Cold path: spawn a dedicated maestro-server and resume an existing ACP session.
/// Uses `TransportTarget` to abstract over local subprocess vs remote SSH channel.
pub async fn load_acp_session_cold(
    target: TransportTarget<'_>,
    acp_session_id: &str,
    task: TaskMetadata,
    req: &SessionRequest,
) -> Result<(), String> {
    let initial_msg = MaestroRpcMessage::Request(ServerRequest::SessionLoad(SessionLoadRequest {
        agent_id: req.agent_id.clone(),
        session_id: req.session_id.clone(),
        resume_session_id: acp_session_id.to_string(),
        cwd: req.cwd.clone(),
        additional_directories: additional_directories_for(req).await,
        project_path: req
            .project_id
            .and_then(|project_id| project_path(&req.app_state, project_id)),
        meta: task.to_session_meta(req.session_name.clone()),
    }));
    launch_cold_session(
        target,
        &initial_msg,
        "SessionLoad",
        task,
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
    let load_msg = MaestroRpcMessage::Request(ServerRequest::SessionLoad(SessionLoadRequest {
        agent_id: req.agent_id.clone(),
        session_id: req.session_id.clone(),
        resume_session_id: acp_session_id.to_string(),
        cwd: req.cwd.clone(),
        additional_directories: additional_directories_for(req).await,
        project_path: req
            .project_id
            .and_then(|project_id| project_path(&req.app_state, project_id)),
        meta: task.to_session_meta(req.session_name.clone()),
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
            task,
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

/// Re-spawn the shared maestro-server for a connection and bring back the sessions that were
/// active when it was lost. Called after SSH successfully reconnects.
///
/// The daemon on the far side may well have kept running them, so this asks it exactly as opening
/// the project does rather than loading each one a second time under a new id.
/// Emits `acp://session-ended/{session_id}` for any session that did not come back.
pub async fn restore_acp_sessions(
    connection_id: i32,
    app_state: &Arc<crate::core::AppState>,
) -> Result<(), String> {
    let connection_key = crate::acp::ConnectionKey::Ssh { id: connection_id };
    let (ssh, server_path) = resolve_remote_context(app_state, connection_id).await?;

    spawn_connection_server(
        connection_key,
        TransportTarget::Remote {
            ssh: &ssh,
            server_path: &server_path,
        },
        app_state,
    )
    .await?;

    let parked = app_state
        .acp
        .restorable_sessions
        .lock()
        .await
        .remove(&connection_id)
        .unwrap_or_default();

    let project_ids: std::collections::BTreeSet<i32> = parked
        .iter()
        .filter_map(|session| session.project_id)
        .collect();
    for project_id in project_ids {
        attach_project_sessions(connection_key, project_id, None, app_state).await;
    }

    let held: std::collections::HashSet<String> = app_state
        .acp
        .sessions
        .lock()
        .await
        .values()
        .filter_map(|proc| proc.acp_session_id.lock().ok().and_then(|id| id.clone()))
        .collect();
    for session in parked {
        if session
            .acp_session_id
            .is_some_and(|acp_session_id| held.contains(&acp_session_id))
        {
            continue;
        }
        if let Err(e) = app_state
            .app_handle
            .emit(&format!("acp://session-ended/{}", session.session_id), ())
        {
            log::warn!(
                "[acp] emit session-ended/{} failed: {e}",
                session.session_id
            );
        }
    }

    if let Err(e) = app_state.app_handle.emit("sessions-changed", ()) {
        log::warn!("[acp] emit sessions-changed failed: {e}");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{holds_row, row_action, superseded_task_sessions, task_session_target, RowAction};
    use crate::acp::ConnectionKey;

    #[test]
    fn a_task_session_is_adopted_only_by_the_window_holding_its_project() {
        let held = Some((7, ConnectionKey::Local));
        assert_eq!(
            task_session_target(held, ConnectionKey::Local, Some(7)),
            Some(7)
        );
        assert_eq!(
            task_session_target(held, ConnectionKey::Local, Some(8)),
            None
        );
        assert_eq!(
            task_session_target(held, ConnectionKey::Ssh { id: 1 }, Some(7)),
            None
        );
        assert_eq!(task_session_target(held, ConnectionKey::Local, None), None);
        assert_eq!(
            task_session_target(None, ConnectionKey::Local, Some(7)),
            None
        );
    }

    #[test]
    fn only_the_tasks_earlier_sessions_are_superseded() {
        let ids: Vec<String> = ["new", "old", "other-task", "other-project", "plain"]
            .map(String::from)
            .into();
        let entries = [
            (&ids[0], Some(7), Some(3)),
            (&ids[1], Some(7), Some(3)),
            (&ids[2], Some(7), Some(4)),
            (&ids[3], Some(8), Some(3)),
            (&ids[4], Some(7), None),
        ];
        assert_eq!(
            superseded_task_sessions(entries.into_iter(), 7, 3, "new"),
            vec!["old".to_string()]
        );
    }

    #[test]
    fn a_running_row_is_held_only_under_its_live_routing_id() {
        assert!(holds_row("live", true, Some("live")));
        // Another window reloaded it under a new id while this one kept the old.
        assert!(!holds_row("old", true, Some("live")));
    }

    #[test]
    fn a_dormant_row_is_held_only_by_a_load_in_flight() {
        assert!(holds_row("loading", false, None));
        assert!(!holds_row("stopped", true, None));
    }

    #[test]
    fn a_row_is_adopted_reloaded_loaded_or_skipped() {
        assert_eq!(row_action(Some(true), true, false), RowAction::Adopt);
        assert_eq!(row_action(Some(false), true, false), RowAction::Reload);
        assert_eq!(row_action(None, true, false), RowAction::Load);
        assert_eq!(row_action(None, false, false), RowAction::Skip);
    }

    /// Closing either of these would lose it: one cannot be loaded back, and the other is an
    /// automation's session holding nothing but the prompt it was started with.
    #[test]
    fn a_session_that_closing_would_lose_is_adopted_between_turns() {
        assert_eq!(row_action(Some(false), false, false), RowAction::Adopt);
        assert_eq!(row_action(Some(false), true, true), RowAction::Adopt);
    }
}
