//! ACP session manager: spawns maestro-server as a managed subprocess (local)
//! or via SSH exec channel (remote), tracks sessions in AppState, and streams
//! typed Tauri events from a background reader task.

use std::sync::Arc;
use tokio::io::{AsyncWriteExt, BufReader, BufWriter};
use tokio::process::{Child, ChildStdin};
use tokio::sync::oneshot;
use tauri::Emitter;
use russh::ChannelMsg;
use crate::acp::transport::{
    HandshakeRequest, MaestroRpcMessage, PROTOCOL_VERSION, ServerRequest, ServerResponse,
    SpawnRequest, SessionModelState, PromptCapabilitiesInfo, read_message, write_message,
    FileSearchResponse, FileReadResponse,
};

/// Write transport for a live ACP session.
/// Local sessions write to the child process stdin.
/// Remote sessions send framed bytes to a writer task via mpsc.
pub enum AcpTransportWriter {
    Local(BufWriter<ChildStdin>),
    RemoteSsh(tokio::sync::mpsc::Sender<Vec<u8>>),
}

/// Cached session capabilities reported by the agent on SpawnOk.
#[derive(Default, Clone)]
pub struct SessionCapabilitiesCache {
    pub supports_session_list: bool,
    pub supports_session_load: bool,
    pub supports_session_close: bool,
}

/// A live ACP session — local subprocess or remote SSH exec channel.
///
/// Stored in `AppState.acp_sessions` keyed by session key.
/// Dropping this struct cleanly shuts down the session:
/// - Local: `child` drops with `kill_on_drop(true)`, killing maestro-server.
/// - Remote: `writer` channel closes, writer task exits, SSH channel closes.
pub struct AcpProcess {
    pub writer: AcpTransportWriter,
    /// Local sessions only — kill_on_drop(true) ensures cleanup on drop.
    pub child: Option<Child>,
    /// Cancel signal for the background reader task.
    pub reader_cancel_tx: Option<oneshot::Sender<()>>,
    /// Last known model state from SpawnOk/SetModelOk. Cached so the frontend
    /// can query it on mount even if the event fired before the listener registered.
    pub models: Arc<std::sync::Mutex<Option<SessionModelState>>>,
    /// Prompt capabilities reported by the agent in InitializeResponse. Cached so the
    /// frontend can query even if the SpawnOk event fired before the listener registered.
    pub prompt_capabilities: Arc<std::sync::Mutex<Option<PromptCapabilitiesInfo>>>,
    /// Working directory on the server host — passed in FileSearch/FileRead requests.
    pub cwd: String,
    /// Pending file search response channel. One request at a time.
    pub pending_file_search: Arc<std::sync::Mutex<Option<oneshot::Sender<Result<Vec<String>, String>>>>>,
    /// Pending file read response channel. One request at a time.
    pub pending_file_read: Arc<std::sync::Mutex<Option<oneshot::Sender<Result<String, String>>>>>,
    // Session metadata
    pub session_name: Option<String>,
    pub agent_id_meta: String,
    pub started_at: String,
    pub task_id: Option<i32>,
    pub task_name: Option<String>,
    pub branch_name: Option<String>,
    /// Agent's native ACP session ID (returned by NewSessionRequest). Used for alias persistence.
    pub acp_session_id: Arc<std::sync::Mutex<Option<String>>>,
    /// Session capabilities (supports_session_list/load/close), updated on SpawnOk.
    pub session_capabilities: Arc<std::sync::Mutex<SessionCapabilitiesCache>>,
}

pub(crate) fn serialize_message(msg: &MaestroRpcMessage) -> Result<Vec<u8>, String> {
    let json_bytes = serde_json::to_vec(msg)
        .map_err(|e| format!("Failed to serialize ACP message: {}", e))?;
    let len = json_bytes.len() as u32;
    let mut frame = Vec::with_capacity(4 + json_bytes.len());
    frame.extend_from_slice(&len.to_le_bytes());
    frame.extend_from_slice(&json_bytes);
    Ok(frame)
}

/// Read one framed response from `child_stdout` and verify it is HandshakeOk.
/// Returns an error if the response is not HandshakeOk, indicates a version
/// mismatch, or does not arrive within 10 seconds.
async fn perform_handshake_local(child_stdout: &mut tokio::process::ChildStdout) -> Result<(), String> {
    use tokio::io::AsyncReadExt;

    let mut buf = Vec::<u8>::new();
    let hs_resp = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        async {
            let mut tmp = [0u8; 4096];
            loop {
                let n = child_stdout
                    .read(&mut tmp)
                    .await
                    .map_err(|e| format!("handshake read: {}", e))?;
                if n == 0 {
                    return Err::<MaestroRpcMessage, String>("EOF before HandshakeOk".to_string());
                }
                buf.extend_from_slice(&tmp[..n]);
                if let Some(rpc_msg) = try_parse_acp_frame(&mut buf) {
                    return Ok(rpc_msg);
                }
            }
        },
    )
    .await
    .map_err(|_| "maestro-server handshake timed out".to_string())??;

    match hs_resp {
        MaestroRpcMessage::Response(ServerResponse::HandshakeOk(_)) => Ok(()),
        MaestroRpcMessage::Response(ServerResponse::Error(error)) => {
            Err(format!("maestro-server handshake rejected: {}", error.message))
        }
        _ => Err("maestro-server did not respond with HandshakeOk".to_string()),
    }
}

/// Read one framed response from a remote SSH channel read half and verify it is HandshakeOk.
async fn perform_handshake_remote(read_half: &mut russh::ChannelReadHalf) -> Result<(), String> {
    use russh::ChannelMsg;

    let mut buf = Vec::<u8>::new();
    let hs_resp = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        async {
            loop {
                match read_half.wait().await {
                    Some(ChannelMsg::Data { data }) => {
                        buf.extend_from_slice(&data);
                        if let Some(rpc_msg) = try_parse_acp_frame(&mut buf) {
                            return Some(rpc_msg);
                        }
                    }
                    _ => return None,
                }
            }
        },
    )
    .await
    .map_err(|_| "remote maestro-server handshake timed out".to_string())?;

    match hs_resp {
        Some(MaestroRpcMessage::Response(ServerResponse::HandshakeOk(_))) => Ok(()),
        Some(MaestroRpcMessage::Response(ServerResponse::Error(error))) => {
            Err(format!("maestro-server handshake rejected: {}", error.message))
        }
        _ => Err("maestro-server did not respond with HandshakeOk".to_string()),
    }
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
    session_name: Option<String>,
    task_id: Option<i32>,
    task_name: Option<String>,
    branch_name: Option<String>,
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
    let mut child_stdout = child.stdout.take().expect("child stdout must be piped");
    let mut stdin_writer = BufWriter::new(child_stdin);

    let handshake = MaestroRpcMessage::Request(ServerRequest::Handshake(HandshakeRequest {
        protocol_version: PROTOCOL_VERSION,
    }));
    write_to_acp_session_raw(&mut stdin_writer, &handshake).await?;
    perform_handshake_local(&mut child_stdout).await?;

    let spawn_req = MaestroRpcMessage::Request(ServerRequest::Spawn(SpawnRequest {
        agent_id: agent_id.to_string(),
        session_id: session_id.to_string(),
        cwd: cwd.to_string(),
    }));
    write_to_acp_session_raw(&mut stdin_writer, &spawn_req).await?;

    let (cancel_tx, cancel_rx) = oneshot::channel::<()>();

    let models_cache: Arc<std::sync::Mutex<Option<SessionModelState>>> = Arc::new(std::sync::Mutex::new(None));
    let capabilities_cache: Arc<std::sync::Mutex<Option<PromptCapabilitiesInfo>>> = Arc::new(std::sync::Mutex::new(None));
    let pending_file_search: Arc<std::sync::Mutex<Option<oneshot::Sender<Result<Vec<String>, String>>>>> = Arc::new(std::sync::Mutex::new(None));
    let pending_file_read: Arc<std::sync::Mutex<Option<oneshot::Sender<Result<String, String>>>>> = Arc::new(std::sync::Mutex::new(None));
    let session_capabilities: Arc<std::sync::Mutex<SessionCapabilitiesCache>> = Arc::new(std::sync::Mutex::new(SessionCapabilitiesCache::default()));
    let acp_session_id_cache: Arc<std::sync::Mutex<Option<String>>> = Arc::new(std::sync::Mutex::new(None));

    let acp_process = AcpProcess {
        writer: AcpTransportWriter::Local(stdin_writer),
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
        task_id,
        task_name,
        branch_name,
        acp_session_id: Arc::clone(&acp_session_id_cache),
        session_capabilities: Arc::clone(&session_capabilities),
    };

    app_state.acp_sessions.lock().await.insert(log_id, acp_process);

    spawn_reader_task(
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
    session_name: Option<String>,
    task_id: Option<i32>,
    task_name: Option<String>,
    branch_name: Option<String>,
) -> Result<(), String> {
    // Open a new exec channel using the absolute maestro-server path (resolved at connect time).
    let channel = ssh_session
        .open_exec_channel(maestro_server_path)
        .await
        .map_err(|e| format!("Failed to open remote ACP channel: {}", e))?;

    let (mut read_half, write_half) = channel.split();

    // Protocol handshake — write directly to the channel before starting tasks.
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
    perform_handshake_remote(&mut read_half).await?;

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

    let models_cache: Arc<std::sync::Mutex<Option<SessionModelState>>> = Arc::new(std::sync::Mutex::new(None));
    let capabilities_cache: Arc<std::sync::Mutex<Option<PromptCapabilitiesInfo>>> = Arc::new(std::sync::Mutex::new(None));
    let pending_file_search: Arc<std::sync::Mutex<Option<oneshot::Sender<Result<Vec<String>, String>>>>> = Arc::new(std::sync::Mutex::new(None));
    let pending_file_read: Arc<std::sync::Mutex<Option<oneshot::Sender<Result<String, String>>>>> = Arc::new(std::sync::Mutex::new(None));
    let session_capabilities: Arc<std::sync::Mutex<SessionCapabilitiesCache>> = Arc::new(std::sync::Mutex::new(SessionCapabilitiesCache::default()));
    let acp_session_id_cache: Arc<std::sync::Mutex<Option<String>>> = Arc::new(std::sync::Mutex::new(None));

    let acp_process = AcpProcess {
        writer: AcpTransportWriter::RemoteSsh(write_tx),
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
        task_id,
        task_name,
        branch_name,
        acp_session_id: Arc::clone(&acp_session_id_cache),
        session_capabilities: Arc::clone(&session_capabilities),
    };

    app_state.acp_sessions.lock().await.insert(log_id, acp_process);

    spawn_remote_reader_task(
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
    );

    Ok(())
}

pub(crate) fn spawn_reader_task(
    child_stdout: tokio::process::ChildStdout,
    log_id: i32,
    app_handle: tauri::AppHandle,
    app_state: Arc<crate::db::AppState>,
    cancel_rx: oneshot::Receiver<()>,
    models_cache: Arc<std::sync::Mutex<Option<SessionModelState>>>,
    capabilities_cache: Arc<std::sync::Mutex<Option<PromptCapabilitiesInfo>>>,
    pending_file_search: Arc<std::sync::Mutex<Option<oneshot::Sender<Result<Vec<String>, String>>>>>,
    pending_file_read: Arc<std::sync::Mutex<Option<oneshot::Sender<Result<String, String>>>>>,
    session_capabilities: Arc<std::sync::Mutex<SessionCapabilitiesCache>>,
    acp_session_id_cache: Arc<std::sync::Mutex<Option<String>>>,
) {
    tokio::spawn(async move {
        let mut stdout_reader = BufReader::new(child_stdout);
        let mut cancel_rx = cancel_rx;

        loop {
            tokio::select! {
                biased;

                _ = &mut cancel_rx => break,

                result = read_message(&mut stdout_reader) => {
                    match result {
                        Ok(msg) => handle_server_message(msg, log_id, &app_handle, &models_cache, &capabilities_cache, &pending_file_search, &pending_file_read, &session_capabilities, &acp_session_id_cache),
                        Err(_) => break,
                    }
                }
            }
        }

        app_state.acp_sessions.lock().await.remove(&log_id);
        app_state.app_handle.emit("sessions-changed", ()).ok();
        let _ = app_handle.emit(&format!("acp://session-ended/{}", log_id), ());
    });
}

pub(crate) fn spawn_remote_reader_task(
    mut read_half: russh::ChannelReadHalf,
    log_id: i32,
    app_handle: tauri::AppHandle,
    app_state: Arc<crate::db::AppState>,
    cancel_rx: oneshot::Receiver<()>,
    models_cache: Arc<std::sync::Mutex<Option<SessionModelState>>>,
    capabilities_cache: Arc<std::sync::Mutex<Option<PromptCapabilitiesInfo>>>,
    pending_file_search: Arc<std::sync::Mutex<Option<oneshot::Sender<Result<Vec<String>, String>>>>>,
    pending_file_read: Arc<std::sync::Mutex<Option<oneshot::Sender<Result<String, String>>>>>,
    session_capabilities: Arc<std::sync::Mutex<SessionCapabilitiesCache>>,
    acp_session_id_cache: Arc<std::sync::Mutex<Option<String>>>,
) {
    tokio::spawn(async move {
        let mut cancel_rx = cancel_rx;
        let mut msg_buf: Vec<u8> = Vec::new();

        loop {
            tokio::select! {
                biased;

                _ = &mut cancel_rx => break,

                channel_msg = read_half.wait() => {
                    match channel_msg {
                        Some(ChannelMsg::Data { data }) => {
                            msg_buf.extend_from_slice(&data);
                            while let Some(rpc_msg) = try_parse_acp_frame(&mut msg_buf) {
                                handle_server_message(rpc_msg, log_id, &app_handle, &models_cache, &capabilities_cache, &pending_file_search, &pending_file_read, &session_capabilities, &acp_session_id_cache);
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

        app_state.acp_sessions.lock().await.remove(&log_id);
        app_state.app_handle.emit("sessions-changed", ()).ok();
        let _ = app_handle.emit(&format!("acp://session-ended/{}", log_id), ());
    });
}

/// Emit Tauri events for a parsed server response.
fn handle_server_message(
    msg: MaestroRpcMessage,
    log_id: i32,
    app_handle: &tauri::AppHandle,
    models_cache: &Arc<std::sync::Mutex<Option<SessionModelState>>>,
    capabilities_cache: &Arc<std::sync::Mutex<Option<PromptCapabilitiesInfo>>>,
    pending_file_search: &Arc<std::sync::Mutex<Option<oneshot::Sender<Result<Vec<String>, String>>>>>,
    pending_file_read: &Arc<std::sync::Mutex<Option<oneshot::Sender<Result<String, String>>>>>,
    session_capabilities: &Arc<std::sync::Mutex<SessionCapabilitiesCache>>,
    acp_session_id_cache: &Arc<std::sync::Mutex<Option<String>>>,
) {
    match msg {
        MaestroRpcMessage::Response(ServerResponse::SessionUpdate(upd)) => {
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
        MaestroRpcMessage::Response(ServerResponse::SpawnOk(spawn_ok)) => {
            if let Some(models) = &spawn_ok.models {
                if let Ok(mut cache) = models_cache.lock() {
                    *cache = Some(models.clone());
                }
                let _ = app_handle.emit(&format!("acp://session-models/{}", log_id), models);
            }
            if let Some(caps) = &spawn_ok.prompt_capabilities {
                if let Ok(mut cache) = capabilities_cache.lock() {
                    *cache = Some(caps.clone());
                }
                let _ = app_handle.emit(&format!("acp://session-capabilities/{}", log_id), caps);
            }
            if let Ok(mut caps) = session_capabilities.lock() {
                caps.supports_session_list = spawn_ok.supports_session_list;
                caps.supports_session_load = spawn_ok.supports_session_load;
                caps.supports_session_close = spawn_ok.supports_session_close;
            }
            if let Some(native_id) = spawn_ok.acp_session_id {
                if let Ok(mut cache) = acp_session_id_cache.lock() {
                    *cache = Some(native_id);
                }
            }
            let _ = app_handle.emit("sessions-changed", ());
        }
        MaestroRpcMessage::Response(ServerResponse::SessionLoadOk(load_ok)) => {
            if let Some(models) = &load_ok.models {
                if let Ok(mut cache) = models_cache.lock() {
                    *cache = Some(models.clone());
                }
                let _ = app_handle.emit(&format!("acp://session-models/{}", log_id), models);
            }
            if let Some(caps) = &load_ok.prompt_capabilities {
                if let Ok(mut cache) = capabilities_cache.lock() {
                    *cache = Some(caps.clone());
                }
                let _ = app_handle.emit(&format!("acp://session-capabilities/{}", log_id), caps);
            }
        }
        MaestroRpcMessage::Response(ServerResponse::SetModelOk(ok)) => {
            if let Ok(mut cache) = models_cache.lock() {
                if let Some(state) = cache.as_mut() {
                    state.current_model_id = ok.model_id.clone();
                }
            }
            let _ = app_handle.emit(&format!("acp://model-changed/{}", log_id), &ok.model_id);
        }
        MaestroRpcMessage::Response(ServerResponse::FileSearchOk(FileSearchResponse { files })) => {
            if let Ok(mut guard) = pending_file_search.lock() {
                if let Some(tx) = guard.take() {
                    let _ = tx.send(Ok(files));
                }
            }
        }
        MaestroRpcMessage::Response(ServerResponse::FileReadOk(FileReadResponse { content })) => {
            if let Ok(mut guard) = pending_file_read.lock() {
                if let Some(tx) = guard.take() {
                    let _ = tx.send(Ok(content));
                }
            }
        }
        MaestroRpcMessage::Response(ServerResponse::Error(err)) => {
            // Resolve any pending file op with the error before emitting the session-error event.
            if let Ok(mut guard) = pending_file_search.lock() {
                if let Some(tx) = guard.take() {
                    let _ = tx.send(Err(err.message.clone()));
                }
            }
            if let Ok(mut guard) = pending_file_read.lock() {
                if let Some(tx) = guard.take() {
                    let _ = tx.send(Err(err.message.clone()));
                }
            }
            let _ = app_handle.emit(&format!("acp://session-error/{}", log_id), &err.message);
        }
        MaestroRpcMessage::Response(ServerResponse::TurnEnded(turn_ended)) => {
            let _ = app_handle.emit(
                &format!("acp://turn-ended/{}", log_id),
                &turn_ended.stop_reason,
            );
        }
        _ => {
            // Ignore Request variants arriving on stdout — wrong direction.
        }
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
