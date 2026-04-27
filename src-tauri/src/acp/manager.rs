//! ACP session manager: spawns maestro-server as a managed subprocess (local)
//! or via SSH exec channel (remote), tracks sessions in AppState, and streams
//! typed Tauri events from a background reader task.

use std::sync::Arc;
use tokio::io::{AsyncWriteExt, BufReader, BufWriter};
use tokio::process::{Child, ChildStdin};
use tokio::sync::oneshot;
use tokio::time::{interval, Duration};
use tauri::Emitter;
use russh::ChannelMsg;
use crate::acp::transport::{
    MaestroRpcMessage, ServerRequest, ServerResponse,
    SpawnRequest, read_message, write_message,
};

/// Write transport for a live ACP session.
/// Local sessions write to the child process stdin.
/// Remote sessions send framed bytes to a writer task via mpsc.
pub enum AcpTransportWriter {
    Local(BufWriter<ChildStdin>),
    RemoteSsh(tokio::sync::mpsc::Sender<Vec<u8>>),
}

/// A live ACP session — local subprocess or remote SSH exec channel.
///
/// Stored in `AppState.acp_sessions` keyed by execution log ID.
/// Dropping this struct cleanly shuts down the session:
/// - Local: `child` drops with `kill_on_drop(true)`, killing maestro-server.
/// - Remote: `writer` channel closes, writer task exits, SSH channel closes.
pub struct AcpProcess {
    pub writer: AcpTransportWriter,
    /// Local sessions only — kill_on_drop(true) ensures cleanup on drop.
    pub child: Option<Child>,
    /// Cancel signal for the background reader task.
    pub reader_cancel_tx: Option<oneshot::Sender<()>>,
}

/// Serialize a MaestroRpcMessage into a length-prefixed frame (4-byte LE length + JSON body).
fn serialize_message(msg: &MaestroRpcMessage) -> Result<Vec<u8>, String> {
    let json_bytes = serde_json::to_vec(msg)
        .map_err(|e| format!("Failed to serialize ACP message: {}", e))?;
    let len = json_bytes.len() as u32;
    let mut frame = Vec::with_capacity(4 + json_bytes.len());
    frame.extend_from_slice(&len.to_le_bytes());
    frame.extend_from_slice(&json_bytes);
    Ok(frame)
}

/// Parse one complete framed message from `buf`, consuming its bytes on success.
pub(crate) fn try_parse_acp_frame(buf: &mut Vec<u8>) -> Option<MaestroRpcMessage> {
    if buf.len() < 4 {
        return None;
    }
    let len = u32::from_le_bytes([buf[0], buf[1], buf[2], buf[3]]) as usize;
    if buf.len() < 4 + len {
        return None;
    }
    let msg: MaestroRpcMessage = serde_json::from_slice(&buf[4..4 + len]).ok()?;
    buf.drain(..4 + len);
    Some(msg)
}

/// Spawn maestro-server as a local subprocess for a new ACP session.
///
/// Steps:
/// 1. Resolve the maestro-server binary via PATH (using `which`)
/// 2. Spawn the process with piped stdin/stdout, stderr inherited
/// 3. Send the initial `SpawnRequest` to maestro-server stdin
/// 4. Insert the `AcpProcess` into `app_state.acp_sessions`
/// 5. Start a background reader task that emits Tauri events per response variant
pub async fn spawn_acp_process(
    agent_id: &str,
    cwd: &str,
    log_id: i32,
    session_id: &str,
    app_state: &Arc<crate::db::AppState>,
) -> Result<(), String> {
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
    let child_stdout = child.stdout.take().expect("child stdout must be piped");
    let mut stdin_writer = BufWriter::new(child_stdin);

    let spawn_req = MaestroRpcMessage::Request(ServerRequest::Spawn(SpawnRequest {
        agent_id: agent_id.to_string(),
        session_id: session_id.to_string(),
        cwd: cwd.to_string(),
    }));
    write_to_acp_session_raw(&mut stdin_writer, &spawn_req).await?;

    let (cancel_tx, cancel_rx) = oneshot::channel::<()>();

    let acp_process = AcpProcess {
        writer: AcpTransportWriter::Local(stdin_writer),
        child: Some(child),
        reader_cancel_tx: Some(cancel_tx),
    };

    app_state.acp_sessions.lock().await.insert(log_id, acp_process);

    spawn_reader_task(
        child_stdout,
        log_id,
        app_state.app_handle.clone(),
        Arc::clone(app_state),
        cancel_rx,
    );

    Ok(())
}

/// Spawn maestro-server on a remote host via SSH exec channel for a new ACP session.
///
/// Steps:
/// 1. Verify maestro-server is on the remote PATH
/// 2. Open an SSH exec channel and run `maestro-server`
/// 3. Send the initial `SpawnRequest` via the channel stdin
/// 4. Spawn a writer task (mpsc → channel stdin) and a reader task (channel stdout → Tauri events)
/// 5. Insert the `AcpProcess` into `app_state.acp_sessions`
pub async fn spawn_acp_process_remote(
    agent_id: &str,
    cwd: &str,
    log_id: i32,
    session_id: &str,
    app_state: &Arc<crate::db::AppState>,
    ssh_session: &crate::ssh::RemoteSshSession,
    maestro_server_path: &str,
) -> Result<(), String> {
    // Open a new exec channel using the absolute maestro-server path (resolved at connect time).
    let channel = ssh_session
        .open_exec_channel(maestro_server_path)
        .await
        .map_err(|e| format!("Failed to open remote ACP channel: {}", e))?;

    let (read_half, write_half) = channel.split();

    // Set up mpsc channel: AcpProcess holds the sender, writer task owns the receiver.
    let (write_tx, mut write_rx) = tokio::sync::mpsc::channel::<Vec<u8>>(32);

    // Send initial SpawnRequest before starting tasks.
    let spawn_req = MaestroRpcMessage::Request(ServerRequest::Spawn(SpawnRequest {
        agent_id: agent_id.to_string(),
        session_id: session_id.to_string(),
        cwd: cwd.to_string(),
    }));
    let spawn_bytes = serialize_message(&spawn_req)?;
    write_tx.send(spawn_bytes).await
        .map_err(|_| "Failed to queue SpawnRequest for remote channel".to_string())?;

    // Writer task: owns write_half, drains the mpsc receiver, writes framed bytes.
    tokio::spawn(async move {
        let mut writer = write_half.make_writer();
        while let Some(bytes) = write_rx.recv().await {
            if writer.write_all(&bytes).await.is_err() {
                break;
            }
            let _ = writer.flush().await;
        }
    });

    let (cancel_tx, cancel_rx) = oneshot::channel::<()>();

    let acp_process = AcpProcess {
        writer: AcpTransportWriter::RemoteSsh(write_tx),
        child: None,
        reader_cancel_tx: Some(cancel_tx),
    };

    app_state.acp_sessions.lock().await.insert(log_id, acp_process);

    spawn_remote_reader_task(
        read_half,
        log_id,
        app_state.app_handle.clone(),
        Arc::clone(app_state),
        cancel_rx,
    );

    Ok(())
}

/// Background task that reads responses from maestro-server stdout and emits
/// typed Tauri events. Local variant — reads from child process stdout.
fn spawn_reader_task(
    child_stdout: tokio::process::ChildStdout,
    log_id: i32,
    app_handle: tauri::AppHandle,
    app_state: Arc<crate::db::AppState>,
    cancel_rx: oneshot::Receiver<()>,
) {
    tokio::spawn(async move {
        let mut stdout_reader = BufReader::new(child_stdout);
        let mut cancel_rx = cancel_rx;
        let mut flush_interval = interval(Duration::from_secs(10));
        let mut structured_updates: Vec<serde_json::Value> = Vec::new();

        loop {
            tokio::select! {
                biased;

                _ = &mut cancel_rx => break,

                _ = flush_interval.tick() => {
                    flush_structured_updates(&app_state, log_id, &mut structured_updates);
                }

                result = read_message(&mut stdout_reader) => {
                    match result {
                        Ok(msg) => handle_server_message(msg, log_id, &app_handle, &mut structured_updates),
                        Err(_) => break,
                    }
                }
            }
        }

        flush_structured_updates(&app_state, log_id, &mut structured_updates);
        app_state.acp_sessions.lock().await.remove(&log_id);
        let _ = app_handle.emit(&format!("acp://session-ended/{}", log_id), ());
    });
}

/// Background task that reads framed responses from a remote maestro-server via SSH channel
/// and emits typed Tauri events. Accumulates SSH Data chunks into a frame buffer.
fn spawn_remote_reader_task(
    mut read_half: russh::ChannelReadHalf,
    log_id: i32,
    app_handle: tauri::AppHandle,
    app_state: Arc<crate::db::AppState>,
    cancel_rx: oneshot::Receiver<()>,
) {
    tokio::spawn(async move {
        let mut cancel_rx = cancel_rx;
        let mut flush_interval = interval(Duration::from_secs(10));
        let mut structured_updates: Vec<serde_json::Value> = Vec::new();
        let mut msg_buf: Vec<u8> = Vec::new();

        loop {
            tokio::select! {
                biased;

                _ = &mut cancel_rx => break,

                _ = flush_interval.tick() => {
                    flush_structured_updates(&app_state, log_id, &mut structured_updates);
                }

                channel_msg = read_half.wait() => {
                    match channel_msg {
                        Some(ChannelMsg::Data { data }) => {
                            msg_buf.extend_from_slice(&data);
                            while let Some(rpc_msg) = try_parse_acp_frame(&mut msg_buf) {
                                handle_server_message(rpc_msg, log_id, &app_handle, &mut structured_updates);
                            }
                        }
                        Some(ChannelMsg::ExtendedData { data, .. }) => {
                            // stderr from maestro-server — ignore in normal flow
                            drop(data);
                        }
                        Some(ChannelMsg::Eof)
                        | Some(ChannelMsg::Close)
                        | Some(ChannelMsg::ExitStatus { .. }) => break,
                        None => break,
                        _ => {}
                    }
                }
            }
        }

        flush_structured_updates(&app_state, log_id, &mut structured_updates);
        app_state.acp_sessions.lock().await.remove(&log_id);
        let _ = app_handle.emit(&format!("acp://session-ended/{}", log_id), ());
    });
}

/// Emit Tauri events and accumulate structured updates for a parsed server response.
fn handle_server_message(
    msg: MaestroRpcMessage,
    log_id: i32,
    app_handle: &tauri::AppHandle,
    structured_updates: &mut Vec<serde_json::Value>,
) {
    match msg {
        MaestroRpcMessage::Response(ServerResponse::SessionUpdate(upd)) => {
            structured_updates.push(upd.payload.clone());
            let _ = app_handle.emit(&format!("acp://session-update/{}", log_id), &upd.payload);
        }
        MaestroRpcMessage::Response(ServerResponse::TerminalOutput(out)) => {
            let _ = app_handle.emit(&format!("acp://terminal-output/{}", log_id), &out.bytes);
        }
        MaestroRpcMessage::Response(ServerResponse::PermissionRequest(req)) => {
            let _ = app_handle.emit(&format!("acp://permission-request/{}", log_id), &req);
        }
        MaestroRpcMessage::Response(ServerResponse::ElicitationRequest(req)) => {
            let _ = app_handle.emit(&format!("acp://elicitation-request/{}", log_id), &req);
        }
        MaestroRpcMessage::Response(ServerResponse::SpawnOk(_)) => {
            // Implied by spawn_acp_process returning Ok(()) — no event needed.
        }
        MaestroRpcMessage::Response(ServerResponse::Error(err)) => {
            let _ = app_handle.emit(&format!("acp://session-error/{}", log_id), &err.message);
        }
        _ => {
            // Ignore Request variants arriving on stdout — wrong direction.
        }
    }
}

/// Write accumulated structured updates to the DB. Clears the vec on success.
fn flush_structured_updates(
    app_state: &Arc<crate::db::AppState>,
    log_id: i32,
    structured_updates: &mut Vec<serde_json::Value>,
) {
    if structured_updates.is_empty() {
        return;
    }
    let json = serde_json::to_string(&structured_updates).unwrap_or_default();
    if let Ok(conn) = app_state.db.lock() {
        let _ = conn.execute(
            "UPDATE execution_logs SET structured_output = ?1 WHERE id = ?2",
            rusqlite::params![&json, log_id],
        );
    }
}

/// Write a message to an active ACP session's transport by log_id.
pub async fn write_to_acp_session(
    app_state: &crate::db::AppState,
    log_id: i32,
    msg: &MaestroRpcMessage,
) -> Result<(), String> {
    let mut sessions = app_state.acp_sessions.lock().await;
    let session = sessions
        .get_mut(&log_id)
        .ok_or_else(|| format!("No ACP session for log_id {}", log_id))?;
    match &mut session.writer {
        AcpTransportWriter::Local(stdin_writer) => {
            write_to_acp_session_raw(stdin_writer, msg).await
        }
        AcpTransportWriter::RemoteSsh(write_tx) => {
            let bytes = serialize_message(msg)?;
            write_tx.send(bytes).await
                .map_err(|_| format!("Remote ACP session write failed: channel closed for log_id {}", log_id))
        }
    }
}

/// Low-level write + flush to a `BufWriter<ChildStdin>`.
async fn write_to_acp_session_raw(
    stdin_writer: &mut BufWriter<ChildStdin>,
    msg: &MaestroRpcMessage,
) -> Result<(), String> {
    write_message(stdin_writer, msg)
        .await
        .map_err(|e| format!("write failed: {}", e))?;
    stdin_writer
        .flush()
        .await
        .map_err(|e| format!("flush failed: {}", e))?;
    Ok(())
}
