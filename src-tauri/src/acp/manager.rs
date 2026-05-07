//! ACP session manager: spawns maestro-server as a managed subprocess (local)
//! or via SSH exec channel (remote), tracks sessions in AppState, and streams
//! typed Tauri events from a background reader task.

use std::collections::HashMap;
use std::sync::Arc;
use tokio::io::{AsyncWriteExt, BufReader, BufWriter};
use tokio::process::{Child, ChildStdin};
use tokio::sync::oneshot;
use tauri::Emitter;
use russh::ChannelMsg;
use crate::acp::transport::{
    HandshakeRequest, MaestroRpcMessage, PROTOCOL_VERSION, ServerRequest, ServerResponse,
    SpawnRequest, SessionModelState, SessionModeState, PromptCapabilitiesInfo, read_message,
    write_message, FileSearchResponse, FileReadResponse,
    PreInitializeRequest, PreInitializeResponse,
};

/// Write transport for a live ACP session.
/// Local sessions write to the child process stdin.
/// Remote sessions send framed bytes to a writer task via mpsc.
/// Shared-server sessions route to a project-level maestro-server via mpsc.
pub enum AcpTransportWriter {
    Local(BufWriter<ChildStdin>),
    RemoteSsh(tokio::sync::mpsc::Sender<Vec<u8>>),
    /// Session shares a project-level maestro-server process. The sender routes
    /// to the writer task that owns the child's stdin.
    SharedServer(tokio::sync::mpsc::Sender<Vec<u8>>),
}

/// A long-lived maestro-server process shared across all sessions in one project.
///
/// Created on project open (or lazily on first session spawn). All sessions for
/// the project write through `writer_tx`; the single shared reader task routes
/// responses back to individual `AcpProcess` instances by extracting `log_id`
/// from the `session_id` field in each response.
pub struct ProjectServer {
    /// The child process. `kill_on_drop(true)` ensures cleanup when dropped.
    pub child: Child,
    /// Channel to the writer task (framed bytes → child stdin). Cloned into each
    /// session's `AcpTransportWriter::SharedServer`.
    pub writer_tx: tokio::sync::mpsc::Sender<Vec<u8>>,
    /// Pending `PreInitialize` oneshot channels keyed by `agent_id`. The shared
    /// reader delivers `PreInitializeOk` / error responses here.
    pub pre_init_pending: Arc<std::sync::Mutex<HashMap<String,
        oneshot::Sender<Result<PreInitializeResponse, String>>>>>,
}

/// Remote equivalent of `ProjectServer` — a long-lived maestro-server running
/// on a remote host via SSH exec channel, shared across all sessions for one
/// remote project.
pub struct RemoteProjectServer {
    pub writer_tx: tokio::sync::mpsc::Sender<Vec<u8>>,
    pub pre_init_pending: Arc<std::sync::Mutex<HashMap<String,
        oneshot::Sender<Result<PreInitializeResponse, String>>>>>,
}

/// Cached session capabilities reported by the agent on SpawnOk.
#[derive(Default, Clone)]
pub struct SessionCapabilitiesCache {
    pub supports_session_list: bool,
    pub supports_session_load: bool,
    pub supports_session_close: bool,
}

/// Agent-level cache for models/modes/capabilities. Keyed by (project_id, agent_id).
/// Populated from PreInitializeResponse (warm session) and updated on each SpawnOk/SessionLoadOk.
#[derive(Default, Clone)]
pub struct AgentCache {
    pub models: Option<SessionModelState>,
    pub modes: Option<SessionModeState>,
    pub prompt_capabilities: Option<PromptCapabilitiesInfo>,
}

pub type AgentCacheMap = HashMap<(i32, String), AgentCache>;

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
    /// Last known mode state from SpawnOk/SessionLoadOk/SetModeOk. Cached for
    /// the same reason as models.
    pub modes: Arc<std::sync::Mutex<Option<SessionModeState>>>,
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
    pub project_id: Option<i32>,
    pub started_at: String,
    pub task_id: Option<i32>,
    pub task_name: Option<String>,
    pub branch_name: Option<String>,
    /// Git HEAD SHA captured at session spawn time. Used for session-scoped diffs.
    pub session_start_sha: Option<String>,
    /// Agent's native ACP session ID (returned by NewSessionRequest). Used for alias persistence.
    pub acp_session_id: Arc<std::sync::Mutex<Option<String>>>,
    /// Session capabilities (supports_session_list/load/close), updated on SpawnOk.
    pub session_capabilities: Arc<std::sync::Mutex<SessionCapabilitiesCache>>,
    /// Replay buffer for session-load sessions. `Some(vec)` while waiting for the frontend
    /// listener to register; `None` after drain — events emit directly.
    /// Fresh spawn sessions use `None` (no buffering needed).
    pub replay_buffer: Arc<std::sync::Mutex<Option<Vec<serde_json::Value>>>>,
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
pub(crate) async fn perform_handshake_local(child_stdout: &mut tokio::process::ChildStdout) -> Result<(), String> {
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
pub(crate) async fn perform_handshake_remote(read_half: &mut russh::ChannelReadHalf) -> Result<(), String> {
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
                    // Ignore stderr output and SSH flow-control/informational messages.
                    Some(ChannelMsg::ExtendedData { .. })
                    | Some(ChannelMsg::WindowAdjusted { .. }) => {}
                    // Channel closed or process exited before sending HandshakeOk.
                    Some(ChannelMsg::Eof)
                    | Some(ChannelMsg::Close)
                    | Some(ChannelMsg::ExitStatus { .. })
                    | None => return None,
                    // Ignore any other SSH control messages.
                    _ => {}
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

/// Spawn a new ACP session as a local process.
///
/// Fast path: if a `ProjectServer` is already running for `project_id`, the
/// `SpawnRequest` is written to its shared writer and no new child is spawned.
/// The shared reader task routes subsequent responses to this session.
///
/// Cold path: spawn a new dedicated maestro-server subprocess (legacy behaviour),
/// used when no project server is running or `project_id` is `None`.
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
    project_id: Option<i32>,
    session_start_sha: Option<String>,
) -> Result<(), String> {
    // Fast path: if a ProjectServer is already running for this project, write the
    // SpawnRequest to its shared writer and register a lightweight AcpProcess that
    // routes through the shared reader task — no new subprocess needed.
    if let Some(pid) = project_id {
        let writer_tx = {
            let servers = app_state.acp.project_servers.lock().await;
            servers.get(&pid).map(|s| s.writer_tx.clone())
        };
        if let Some(writer_tx) = writer_tx {
            let spawn_req = MaestroRpcMessage::Request(ServerRequest::Spawn(SpawnRequest {
                agent_id: agent_id.to_string(),
                session_id: session_id.to_string(),
                cwd: cwd.to_string(),
            }));
            let bytes = serialize_message(&spawn_req)?;
            writer_tx
                .send(bytes)
                .await
                .map_err(|_| "Project server writer channel closed".to_string())?;

            let acp_process = AcpProcess {
                writer: AcpTransportWriter::SharedServer(writer_tx),
                child: None,
                reader_cancel_tx: None,
                models: Arc::new(std::sync::Mutex::new(None)),
                modes: Arc::new(std::sync::Mutex::new(None)),
                prompt_capabilities: Arc::new(std::sync::Mutex::new(None)),
                cwd: cwd.to_string(),
                pending_file_search: Arc::new(std::sync::Mutex::new(None)),
                pending_file_read: Arc::new(std::sync::Mutex::new(None)),
                session_name,
                agent_id_meta: agent_id.to_string(),
                project_id,
                started_at: chrono::Utc::now().to_rfc3339(),
                task_id,
                task_name,
                branch_name,
                session_start_sha,
                acp_session_id: Arc::new(std::sync::Mutex::new(None)),
                session_capabilities: Arc::new(std::sync::Mutex::new(SessionCapabilitiesCache::default())),
                replay_buffer: Arc::new(std::sync::Mutex::new(None)),
            };
            // Emit cached models/modes/capabilities immediately so the frontend
            // doesn't have to wait for SpawnOk from the agent.
            if let Some(cache) = app_state.acp.agent_cache.lock().await.get(&(pid, agent_id.to_string())) {
                if let Some(models) = &cache.models {
                    if let Ok(mut m) = acp_process.models.lock() {
                        *m = Some(models.clone());
                    }
                    let _ = app_state.app_handle.emit(&format!("acp://session-models/{}", log_id), models);
                }
                if let Some(modes) = &cache.modes {
                    if let Ok(mut m) = acp_process.modes.lock() {
                        *m = Some(modes.clone());
                    }
                    let _ = app_state.app_handle.emit(&format!("acp://session-modes/{}", log_id), modes);
                }
                if let Some(caps) = &cache.prompt_capabilities {
                    if let Ok(mut c) = acp_process.prompt_capabilities.lock() {
                        *c = Some(caps.clone());
                    }
                    let _ = app_state.app_handle.emit(&format!("acp://session-capabilities/{}", log_id), caps);
                }
            }

            app_state.acp.sessions.lock().await.insert(log_id, acp_process);
            return Ok(());
        }
    }

    // Cold path: spawn a dedicated maestro-server subprocess for this session.
    use std::process::Stdio;

    let server_path = crate::acp::resolve::resolve_server_path(&app_state.app_handle)?;

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
    let modes_cache: Arc<std::sync::Mutex<Option<SessionModeState>>> = Arc::new(std::sync::Mutex::new(None));
    let capabilities_cache: Arc<std::sync::Mutex<Option<PromptCapabilitiesInfo>>> = Arc::new(std::sync::Mutex::new(None));
    let pending_file_search: Arc<std::sync::Mutex<Option<oneshot::Sender<Result<Vec<String>, String>>>>> = Arc::new(std::sync::Mutex::new(None));
    let pending_file_read: Arc<std::sync::Mutex<Option<oneshot::Sender<Result<String, String>>>>> = Arc::new(std::sync::Mutex::new(None));
    let session_capabilities: Arc<std::sync::Mutex<SessionCapabilitiesCache>> = Arc::new(std::sync::Mutex::new(SessionCapabilitiesCache::default()));
    let acp_session_id_cache: Arc<std::sync::Mutex<Option<String>>> = Arc::new(std::sync::Mutex::new(None));

    let replay_buffer: Arc<std::sync::Mutex<Option<Vec<serde_json::Value>>>> = Arc::new(std::sync::Mutex::new(None));

    let reader_session_name = session_name.clone();
    let acp_process = AcpProcess {
        writer: AcpTransportWriter::Local(stdin_writer),
        child: Some(child),
        reader_cancel_tx: Some(cancel_tx),
        models: Arc::clone(&models_cache),
        modes: Arc::clone(&modes_cache),
        prompt_capabilities: Arc::clone(&capabilities_cache),
        cwd: cwd.to_string(),
        pending_file_search: Arc::clone(&pending_file_search),
        pending_file_read: Arc::clone(&pending_file_read),
        session_name,
        agent_id_meta: agent_id.to_string(),
        project_id,
        started_at: chrono::Utc::now().to_rfc3339(),
        task_id,
        task_name,
        branch_name,
        session_start_sha,
        acp_session_id: Arc::clone(&acp_session_id_cache),
        session_capabilities: Arc::clone(&session_capabilities),
        replay_buffer: Arc::clone(&replay_buffer),
    };

    app_state.acp.sessions.lock().await.insert(log_id, acp_process);

    spawn_reader_task(child_stdout, cancel_rx, ReaderTaskContext {
        log_id,
        app_handle: app_state.app_handle.clone(),
        app_state: Arc::clone(app_state),
        models_cache,
        modes_cache,
        capabilities_cache,
        pending_file_search,
        pending_file_read,
        session_capabilities,
        acp_session_id_cache,
        replay_buffer,
        session_name: reader_session_name,
        agent_id: agent_id.to_string(),
        project_id,
    });

    Ok(())
}

/// Spawn maestro-server on a remote host via SSH exec channel for a new ACP session.
///
/// Steps:
/// 1. Verify maestro-server is on the remote PATH
/// 2. Open an SSH exec channel and run `maestro-server`
/// 3. Send the initial `SpawnRequest` via the channel stdin
/// 4. Spawn a writer task (mpsc → channel stdin) and a reader task (channel stdout → Tauri events)
/// 5. Insert the `AcpProcess` into `app_state.acp.sessions`
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
    project_id: Option<i32>,
    session_start_sha: Option<String>,
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
    let modes_cache: Arc<std::sync::Mutex<Option<SessionModeState>>> = Arc::new(std::sync::Mutex::new(None));
    let capabilities_cache: Arc<std::sync::Mutex<Option<PromptCapabilitiesInfo>>> = Arc::new(std::sync::Mutex::new(None));
    let pending_file_search: Arc<std::sync::Mutex<Option<oneshot::Sender<Result<Vec<String>, String>>>>> = Arc::new(std::sync::Mutex::new(None));
    let pending_file_read: Arc<std::sync::Mutex<Option<oneshot::Sender<Result<String, String>>>>> = Arc::new(std::sync::Mutex::new(None));
    let session_capabilities: Arc<std::sync::Mutex<SessionCapabilitiesCache>> = Arc::new(std::sync::Mutex::new(SessionCapabilitiesCache::default()));
    let acp_session_id_cache: Arc<std::sync::Mutex<Option<String>>> = Arc::new(std::sync::Mutex::new(None));

    let replay_buffer: Arc<std::sync::Mutex<Option<Vec<serde_json::Value>>>> = Arc::new(std::sync::Mutex::new(None));

    let reader_session_name = session_name.clone();
    let acp_process = AcpProcess {
        writer: AcpTransportWriter::RemoteSsh(write_tx),
        child: None,
        reader_cancel_tx: Some(cancel_tx),
        models: Arc::clone(&models_cache),
        modes: Arc::clone(&modes_cache),
        prompt_capabilities: Arc::clone(&capabilities_cache),
        cwd: cwd.to_string(),
        pending_file_search: Arc::clone(&pending_file_search),
        pending_file_read: Arc::clone(&pending_file_read),
        session_name,
        agent_id_meta: agent_id.to_string(),
        project_id,
        started_at: chrono::Utc::now().to_rfc3339(),
        task_id,
        task_name,
        branch_name,
        session_start_sha,
        acp_session_id: Arc::clone(&acp_session_id_cache),
        session_capabilities: Arc::clone(&session_capabilities),
        replay_buffer: Arc::clone(&replay_buffer),
    };

    app_state.acp.sessions.lock().await.insert(log_id, acp_process);

    spawn_remote_reader_task(read_half, cancel_rx, ReaderTaskContext {
        log_id,
        app_handle: app_state.app_handle.clone(),
        app_state: Arc::clone(app_state),
        models_cache,
        modes_cache,
        capabilities_cache,
        pending_file_search,
        pending_file_read,
        session_capabilities,
        acp_session_id_cache,
        replay_buffer,
        session_name: reader_session_name,
        agent_id: agent_id.to_string(),
        project_id,
    });

    Ok(())
}

pub(crate) struct ReaderTaskContext {
    pub log_id: i32,
    pub app_handle: tauri::AppHandle,
    pub app_state: Arc<crate::db::AppState>,
    pub models_cache: Arc<std::sync::Mutex<Option<SessionModelState>>>,
    pub modes_cache: Arc<std::sync::Mutex<Option<SessionModeState>>>,
    pub capabilities_cache: Arc<std::sync::Mutex<Option<PromptCapabilitiesInfo>>>,
    pub pending_file_search: Arc<std::sync::Mutex<Option<oneshot::Sender<Result<Vec<String>, String>>>>>,
    pub pending_file_read: Arc<std::sync::Mutex<Option<oneshot::Sender<Result<String, String>>>>>,
    pub session_capabilities: Arc<std::sync::Mutex<SessionCapabilitiesCache>>,
    pub acp_session_id_cache: Arc<std::sync::Mutex<Option<String>>>,
    pub replay_buffer: Arc<std::sync::Mutex<Option<Vec<serde_json::Value>>>>,
    pub session_name: Option<String>,
    pub agent_id: String,
    pub project_id: Option<i32>,
}

pub(crate) fn spawn_reader_task(
    child_stdout: tokio::process::ChildStdout,
    cancel_rx: oneshot::Receiver<()>,
    ctx: ReaderTaskContext,
) {
    let ReaderTaskContext {
        log_id, app_handle, app_state,
        models_cache, modes_cache, capabilities_cache,
        pending_file_search, pending_file_read, session_capabilities,
        acp_session_id_cache, replay_buffer,
        session_name, agent_id, project_id,
    } = ctx;
    tokio::spawn(async move {
        let mut stdout_reader = BufReader::new(child_stdout);
        let mut cancel_rx = cancel_rx;

        loop {
            let msg = tokio::select! {
                biased;
                _ = &mut cancel_rx => break,
                result = read_message(&mut stdout_reader) => match result {
                    Ok(msg) => msg,
                    Err(_) => break,
                },
            };
            if let Some(pid) = project_id {
                update_agent_cache_from_response(&msg, pid, &app_state).await;
            }
            if let Some(native_id) = handle_server_message(msg, log_id, &app_handle, &models_cache, &modes_cache, &capabilities_cache, &pending_file_search, &pending_file_read, &session_capabilities, &acp_session_id_cache, &replay_buffer) {
                if let (Some(pid), Some(ref name)) = (project_id, &session_name) {
                    if let Ok(conn) = app_state.db.lock() {
                        let _ = upsert_session_alias(&conn, pid, &agent_id, &native_id, name);
                    }
                }
            }
        }

        app_state.acp.sessions.lock().await.remove(&log_id);
        app_state.app_handle.emit("sessions-changed", ()).ok();
        let _ = app_handle.emit(&format!("acp://session-ended/{}", log_id), ());
    });
}

pub(crate) fn spawn_remote_reader_task(
    mut read_half: russh::ChannelReadHalf,
    cancel_rx: oneshot::Receiver<()>,
    ctx: ReaderTaskContext,
) {
    let ReaderTaskContext {
        log_id, app_handle, app_state,
        models_cache, modes_cache, capabilities_cache,
        pending_file_search, pending_file_read, session_capabilities,
        acp_session_id_cache, replay_buffer,
        session_name, agent_id, project_id,
    } = ctx;
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
                                if let Some(pid) = project_id {
                                    update_agent_cache_from_response(&rpc_msg, pid, &app_state).await;
                                }
                                if let Some(native_id) = handle_server_message(rpc_msg, log_id, &app_handle, &models_cache, &modes_cache, &capabilities_cache, &pending_file_search, &pending_file_read, &session_capabilities, &acp_session_id_cache, &replay_buffer) {
                                    if let (Some(pid), Some(ref name)) = (project_id, &session_name) {
                                        if let Ok(conn) = app_state.db.lock() {
                                            let _ = upsert_session_alias(&conn, pid, &agent_id, &native_id, name);
                                        }
                                    }
                                }
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

        app_state.acp.sessions.lock().await.remove(&log_id);
        app_state.app_handle.emit("sessions-changed", ()).ok();
        let _ = app_handle.emit(&format!("acp://session-ended/{}", log_id), ());
    });
}

/// Emit Tauri events for a parsed server response.
/// Returns the native ACP session ID when a SpawnOk message is processed, None otherwise.
fn handle_server_message(
    msg: MaestroRpcMessage,
    log_id: i32,
    app_handle: &tauri::AppHandle,
    models_cache: &Arc<std::sync::Mutex<Option<SessionModelState>>>,
    modes_cache: &Arc<std::sync::Mutex<Option<SessionModeState>>>,
    capabilities_cache: &Arc<std::sync::Mutex<Option<PromptCapabilitiesInfo>>>,
    pending_file_search: &Arc<std::sync::Mutex<Option<oneshot::Sender<Result<Vec<String>, String>>>>>,
    pending_file_read: &Arc<std::sync::Mutex<Option<oneshot::Sender<Result<String, String>>>>>,
    session_capabilities: &Arc<std::sync::Mutex<SessionCapabilitiesCache>>,
    acp_session_id_cache: &Arc<std::sync::Mutex<Option<String>>>,
    replay_buffer: &Arc<std::sync::Mutex<Option<Vec<serde_json::Value>>>>,
) -> Option<String> {
    match msg {
        MaestroRpcMessage::Response(ServerResponse::SessionUpdate(upd)) => {
            // Detect CurrentModeUpdate to keep the modes cache current.
            if upd.payload.get("sessionUpdate").and_then(|v| v.as_str()) == Some("current_mode_update") {
                if let Some(mode_id) = upd.payload.get("currentModeId").and_then(|v| v.as_str()) {
                    if let Ok(mut cache) = modes_cache.lock() {
                        if let Some(state) = cache.as_mut() {
                            state.current_mode_id = mode_id.to_string();
                        }
                    }
                    let _ = app_handle.emit(&format!("acp://mode-changed/{}", log_id), mode_id);
                }
            }
            // If a replay buffer is active (Some), accumulate events until the frontend
            // listener is ready and calls drain_session_replay. This prevents race-condition
            // message loss where the reader task fires before the React useEffect registers.
            if let Ok(mut buf) = replay_buffer.lock() {
                if let Some(ref mut vec) = *buf {
                    vec.push(upd.payload);
                    return None;
                }
            }
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
            apply_capabilities_to_caches(
                spawn_ok.models.as_ref(),
                spawn_ok.modes.as_ref(),
                spawn_ok.prompt_capabilities.as_ref(),
                models_cache,
                modes_cache,
                capabilities_cache,
                app_handle,
                log_id,
            );
            if let Ok(mut caps) = session_capabilities.lock() {
                caps.supports_session_list = spawn_ok.supports_session_list;
                caps.supports_session_load = spawn_ok.supports_session_load;
                caps.supports_session_close = spawn_ok.supports_session_close;
            }
            let new_native_id = if let Some(native_id) = spawn_ok.acp_session_id {
                if let Ok(mut cache) = acp_session_id_cache.lock() {
                    *cache = Some(native_id.clone());
                }
                Some(native_id)
            } else {
                None
            };
            let _ = app_handle.emit("sessions-changed", ());
            return new_native_id;
        }
        MaestroRpcMessage::Response(ServerResponse::SessionLoadOk(load_ok)) => {
            apply_capabilities_to_caches(
                load_ok.models.as_ref(),
                load_ok.modes.as_ref(),
                load_ok.prompt_capabilities.as_ref(),
                models_cache,
                modes_cache,
                capabilities_cache,
                app_handle,
                log_id,
            );
        }
        MaestroRpcMessage::Response(ServerResponse::SetModelOk(ok)) => {
            if let Ok(mut cache) = models_cache.lock() {
                if let Some(state) = cache.as_mut() {
                    state.current_model_id = ok.model_id.clone();
                }
            }
            let _ = app_handle.emit(&format!("acp://model-changed/{}", log_id), &ok.model_id);
        }
        MaestroRpcMessage::Response(ServerResponse::SetModeOk(ok)) => {
            if let Ok(mut cache) = modes_cache.lock() {
                if let Some(state) = cache.as_mut() {
                    state.current_mode_id = ok.mode_id.clone();
                }
            }
            let _ = app_handle.emit(&format!("acp://mode-changed/{}", log_id), &ok.mode_id);
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
    None
}

/// Write a message to an active ACP session's transport by log_id.
pub async fn write_to_acp_session(
    app_state: &crate::db::AppState,
    log_id: i32,
    msg: &MaestroRpcMessage,
) -> Result<(), String> {
    let mut sessions = app_state.acp.sessions.lock().await;
    let session = sessions
        .get_mut(&log_id)
        .ok_or_else(|| format!("No ACP session for log_id {}", log_id))?;
    match &mut session.writer {
        AcpTransportWriter::Local(stdin_writer) => {
            write_to_acp_session_raw(stdin_writer, msg).await
        }
        AcpTransportWriter::RemoteSsh(write_tx) | AcpTransportWriter::SharedServer(write_tx) => {
            let bytes = serialize_message(msg)?;
            write_tx.send(bytes).await
                .map_err(|_| format!("ACP session write failed: channel closed for log_id {}", log_id))
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

fn apply_capabilities_to_caches(
    models: Option<&SessionModelState>,
    modes: Option<&SessionModeState>,
    caps: Option<&PromptCapabilitiesInfo>,
    models_cache: &std::sync::Mutex<Option<SessionModelState>>,
    modes_cache: &std::sync::Mutex<Option<SessionModeState>>,
    capabilities_cache: &std::sync::Mutex<Option<PromptCapabilitiesInfo>>,
    app_handle: &tauri::AppHandle,
    log_id: i32,
) {
    if let Some(m) = models {
        if let Ok(mut cache) = models_cache.lock() {
            *cache = Some(m.clone());
        }
        let _ = app_handle.emit(&format!("acp://session-models/{}", log_id), m);
    }
    if let Some(m) = modes {
        if let Ok(mut cache) = modes_cache.lock() {
            *cache = Some(m.clone());
        }
        let _ = app_handle.emit(&format!("acp://session-modes/{}", log_id), m);
    }
    if let Some(c) = caps {
        if let Ok(mut cache) = capabilities_cache.lock() {
            *cache = Some(c.clone());
        }
        let _ = app_handle.emit(&format!("acp://session-capabilities/{}", log_id), c);
    }
}

pub(crate) fn upsert_session_alias(
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

/// Parse the Tauri `log_id` (i32) from a maestro session ID like `"session-42"`.
fn log_id_from_session_id(session_id: &str) -> Option<i32> {
    session_id.strip_prefix("session-")?.parse().ok()
}

/// Return the `log_id` embedded in a response message's session_id field, if present.
fn extract_session_log_id(msg: &MaestroRpcMessage) -> Option<i32> {
    match msg {
        MaestroRpcMessage::Response(ServerResponse::SpawnOk(r)) => log_id_from_session_id(&r.session_id),
        MaestroRpcMessage::Response(ServerResponse::SessionUpdate(r)) => log_id_from_session_id(&r.session_id),
        MaestroRpcMessage::Response(ServerResponse::PermissionRequest(r)) => log_id_from_session_id(&r.session_id),
        MaestroRpcMessage::Response(ServerResponse::ElicitationRequest(r)) => log_id_from_session_id(&r.session_id),
        MaestroRpcMessage::Response(ServerResponse::TerminalOutput(r)) => log_id_from_session_id(&r.session_id),
        MaestroRpcMessage::Response(ServerResponse::TurnEnded(r)) => log_id_from_session_id(&r.session_id),
        MaestroRpcMessage::Response(ServerResponse::SetModelOk(r)) => log_id_from_session_id(&r.session_id),
        MaestroRpcMessage::Response(ServerResponse::SetModeOk(r)) => log_id_from_session_id(&r.session_id),
        MaestroRpcMessage::Response(ServerResponse::SessionLoadOk(r)) => log_id_from_session_id(&r.session_id),
        _ => None,
    }
}

/// Update the agent-level cache when SpawnOk or SessionLoadOk arrives with models/modes.
/// Looks up the agent_id from the AcpProcess metadata to key the cache.
async fn update_agent_cache_from_response(
    msg: &MaestroRpcMessage,
    project_id: i32,
    app_state: &Arc<crate::db::AppState>,
) {
    let (models, modes, caps) = match msg {
        MaestroRpcMessage::Response(ServerResponse::SpawnOk(r)) => {
            (r.models.as_ref(), r.modes.as_ref(), r.prompt_capabilities.as_ref())
        }
        MaestroRpcMessage::Response(ServerResponse::SessionLoadOk(r)) => {
            (r.models.as_ref(), r.modes.as_ref(), r.prompt_capabilities.as_ref())
        }
        _ => return,
    };

    if models.is_none() && modes.is_none() && caps.is_none() {
        return;
    }

    let agent_id = if let Some(log_id) = extract_session_log_id(msg) {
        let sessions = app_state.acp.sessions.lock().await;
        sessions.get(&log_id).map(|s| s.agent_id_meta.clone())
    } else {
        None
    };

    if let Some(agent_id) = agent_id {
        let mut cache_map = app_state.acp.agent_cache.lock().await;
        let entry = cache_map
            .entry((project_id, agent_id))
            .or_insert_with(AgentCache::default);
        if let Some(m) = models {
            entry.models = Some(m.clone());
        }
        if let Some(m) = modes {
            entry.modes = Some(m.clone());
        }
        if let Some(c) = caps {
            entry.prompt_capabilities = Some(c.clone());
        }
    }
}

/// Route a shared-reader message to the correct per-session handler or to
/// project-level pending channels (PreInitialize, file ops, errors).
async fn handle_shared_server_message(
    msg: MaestroRpcMessage,
    project_id: i32,
    app_handle: &tauri::AppHandle,
    app_state: &Arc<crate::db::AppState>,
    pre_init_pending: &Arc<std::sync::Mutex<HashMap<String,
        oneshot::Sender<Result<PreInitializeResponse, String>>>>>,
) {
    // Session-bearing messages: extract log_id, borrow caches from AcpProcess,
    // then call the existing single-session handler.
    if let Some(log_id) = extract_session_log_id(&msg) {
        // Update agent-level cache on SpawnOk/SessionLoadOk before dispatching.
        update_agent_cache_from_response(&msg, project_id, app_state).await;

        let caches = {
            let sessions = app_state.acp.sessions.lock().await;
            sessions.get(&log_id).map(|s| (
                Arc::clone(&s.models),
                Arc::clone(&s.modes),
                Arc::clone(&s.prompt_capabilities),
                Arc::clone(&s.pending_file_search),
                Arc::clone(&s.pending_file_read),
                Arc::clone(&s.session_capabilities),
                Arc::clone(&s.acp_session_id),
                Arc::clone(&s.replay_buffer),
                s.session_name.clone(),
                s.agent_id_meta.clone(),
                s.project_id,
            ))
        };
        if let Some((models, modes, caps, pfs, pfr, sess_caps, acp_sid, replay,
                      session_name, agent_id, pid)) = caches {
            let native_id = handle_server_message(
                msg, log_id, app_handle,
                &models, &modes, &caps, &pfs, &pfr, &sess_caps, &acp_sid, &replay,
            );
            if let Some(native_id) = native_id {
                if let (Some(project_id_val), Some(ref name)) = (pid, &session_name) {
                    if let Ok(conn) = app_state.db.lock() {
                        let _ = upsert_session_alias(&conn, project_id_val, &agent_id, &native_id, name);
                    }
                }
            }
        }
        return;
    }

    // Sessionless messages.
    match msg {
        MaestroRpcMessage::Response(ServerResponse::PreInitializeOk(resp)) => {
            let tx = pre_init_pending
                .lock()
                .ok()
                .and_then(|mut map| map.remove(&resp.agent_id));
            if let Some(tx) = tx {
                let _ = tx.send(Ok(resp));
            }
        }
        MaestroRpcMessage::Response(ServerResponse::AgentConnectionLost(lost)) => {
            for session_id_str in &lost.affected_session_ids {
                if let Some(log_id) = log_id_from_session_id(session_id_str) {
                    app_state.acp.sessions.lock().await.remove(&log_id);
                    let _ = app_handle.emit(&format!("acp://session-ended/{}", log_id), ());
                }
            }
            app_state.app_handle.emit("sessions-changed", ()).ok();
        }
        MaestroRpcMessage::Response(ServerResponse::FileSearchOk(FileSearchResponse { files })) => {
            // Deliver to the first project session that has a pending file search.
            let sessions = app_state.acp.sessions.lock().await;
            for (_, session) in sessions.iter().filter(|(_, s)| s.project_id == Some(project_id)) {
                if let Ok(mut guard) = session.pending_file_search.lock() {
                    if guard.is_some() {
                        if let Some(tx) = guard.take() {
                            let _ = tx.send(Ok(files));
                        }
                        break;
                    }
                }
            }
        }
        MaestroRpcMessage::Response(ServerResponse::FileReadOk(FileReadResponse { content })) => {
            let sessions = app_state.acp.sessions.lock().await;
            for (_, session) in sessions.iter().filter(|(_, s)| s.project_id == Some(project_id)) {
                if let Ok(mut guard) = session.pending_file_read.lock() {
                    if guard.is_some() {
                        if let Some(tx) = guard.take() {
                            let _ = tx.send(Ok(content));
                        }
                        break;
                    }
                }
            }
        }
        MaestroRpcMessage::Response(ServerResponse::Error(err)) => {
            // Try pending file ops first, then pending PreInitialize, then emit globally.
            let mut resolved = false;
            {
                let sessions = app_state.acp.sessions.lock().await;
                'outer: for (_, session) in
                    sessions.iter().filter(|(_, s)| s.project_id == Some(project_id))
                {
                    if let Ok(mut guard) = session.pending_file_search.lock() {
                        if guard.is_some() {
                            if let Some(tx) = guard.take() {
                                let _ = tx.send(Err(err.message.clone()));
                            }
                            resolved = true;
                            break 'outer;
                        }
                    }
                    if let Ok(mut guard) = session.pending_file_read.lock() {
                        if guard.is_some() {
                            if let Some(tx) = guard.take() {
                                let _ = tx.send(Err(err.message.clone()));
                            }
                            resolved = true;
                            break 'outer;
                        }
                    }
                }
            }
            if !resolved {
                // Try pending PreInitialize.
                let pre_init_tx = pre_init_pending.lock().ok().and_then(|mut map| {
                    let key = map.keys().next().cloned()?;
                    map.remove(&key)
                });
                if let Some(tx) = pre_init_tx {
                    let _ = tx.send(Err(err.message));
                } else {
                    // Emit as session-error for all project sessions.
                    let log_ids: Vec<i32> = {
                        let sessions = app_state.acp.sessions.lock().await;
                        sessions
                            .iter()
                            .filter(|(_, s)| s.project_id == Some(project_id))
                            .map(|(id, _)| *id)
                            .collect()
                    };
                    for log_id in log_ids {
                        let _ = app_handle.emit(
                            &format!("acp://session-error/{}", log_id),
                            &err.message,
                        );
                    }
                }
            }
        }
        _ => {}
    }
}

fn spawn_shared_reader_task(
    child_stdout: tokio::process::ChildStdout,
    project_id: i32,
    app_handle: tauri::AppHandle,
    app_state: Arc<crate::db::AppState>,
    pre_init_pending: Arc<std::sync::Mutex<HashMap<String,
        oneshot::Sender<Result<PreInitializeResponse, String>>>>>,
) {
    tokio::spawn(async move {
        let mut stdout_reader = BufReader::new(child_stdout);
        loop {
            // Consume the Result (non-Send error) before the next await point.
            let msg = match read_message(&mut stdout_reader).await {
                Ok(msg) => msg,
                Err(_) => break,
            };
            handle_shared_server_message(
                msg,
                project_id,
                &app_handle,
                &app_state,
                &pre_init_pending,
            )
            .await;
        }

        // Server process died — clean up all shared sessions for this project.
        app_state.acp.project_servers.lock().await.remove(&project_id);

        let to_remove: Vec<i32> = {
            let sessions = app_state.acp.sessions.lock().await;
            sessions
                .iter()
                .filter(|(_, s)| s.project_id == Some(project_id))
                .map(|(id, _)| *id)
                .collect()
        };
        {
            let mut sessions = app_state.acp.sessions.lock().await;
            for log_id in &to_remove {
                sessions.remove(log_id);
            }
        }
        for log_id in to_remove {
            let _ = app_handle.emit(&format!("acp://session-ended/{}", log_id), ());
        }
        app_state.app_handle.emit("sessions-changed", ()).ok();
    });
}

/// Spawn and handshake a single maestro-server process to be shared across all
/// sessions for `project_id`. Idempotent — returns `Ok(())` if already running.
pub async fn spawn_project_server(
    project_id: i32,
    app_state: &Arc<crate::db::AppState>,
) -> Result<(), String> {
    // Fast-exit if already running.
    {
        let servers = app_state.acp.project_servers.lock().await;
        if servers.contains_key(&project_id) {
            return Ok(());
        }
    }

    use std::process::Stdio;
    let server_path = crate::acp::resolve::resolve_server_path(&app_state.app_handle)?;

    let mut child = tokio::process::Command::new(server_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("Failed to spawn project maestro-server: {}", e))?;

    let child_stdin = child.stdin.take().expect("child stdin must be piped");
    let mut child_stdout = child.stdout.take().expect("child stdout must be piped");
    let mut stdin_writer = BufWriter::new(child_stdin);

    let handshake = MaestroRpcMessage::Request(ServerRequest::Handshake(HandshakeRequest {
        protocol_version: PROTOCOL_VERSION,
    }));
    write_to_acp_session_raw(&mut stdin_writer, &handshake).await?;
    perform_handshake_local(&mut child_stdout).await?;

    // Writer task: drains mpsc → child stdin.
    let (write_tx, mut write_rx) = tokio::sync::mpsc::channel::<Vec<u8>>(32);
    tokio::spawn(async move {
        while let Some(bytes) = write_rx.recv().await {
            if stdin_writer.write_all(&bytes).await.is_err() {
                break;
            }
            let _ = stdin_writer.flush().await;
        }
    });

    let pre_init_pending: Arc<std::sync::Mutex<HashMap<String,
        oneshot::Sender<Result<PreInitializeResponse, String>>>>> =
        Arc::new(std::sync::Mutex::new(HashMap::new()));

    let project_server = ProjectServer {
        child,
        writer_tx: write_tx,
        pre_init_pending: Arc::clone(&pre_init_pending),
    };

    // Re-check under lock to avoid double-spawn race.
    {
        let mut servers = app_state.acp.project_servers.lock().await;
        if servers.contains_key(&project_id) {
            // Lost race — the child we spawned will be killed when `project_server` drops.
            return Ok(());
        }
        servers.insert(project_id, project_server);
    }

    spawn_shared_reader_task(
        child_stdout,
        project_id,
        app_state.app_handle.clone(),
        Arc::clone(app_state),
        pre_init_pending,
    );

    Ok(())
}

/// Send a `PreInitialize` request on the project's shared maestro-server and wait
/// for the `PreInitializeOk` response (or an error).  The project server must be
/// running before calling this (use `spawn_project_server` first).
pub async fn pre_initialize_via_project_server(
    project_id: i32,
    agent_id: &str,
    cwd: &str,
    app_state: &Arc<crate::db::AppState>,
) -> Result<PreInitializeResponse, String> {
    let (writer_tx, pre_init_pending) = {
        let servers = app_state.acp.project_servers.lock().await;
        let server = servers
            .get(&project_id)
            .ok_or_else(|| format!("No project server for project {}", project_id))?;
        (server.writer_tx.clone(), Arc::clone(&server.pre_init_pending))
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
        .map_err(|_| "Project server writer channel closed".to_string())?;

    let response = tokio::time::timeout(std::time::Duration::from_secs(60), rx)
        .await
        .map_err(|_| format!("PreInitialize timed out for agent {}", agent_id))?
        .map_err(|_| "PreInitialize response channel dropped".to_string())??;

    // Populate agent-level cache from the warm session's models/modes/capabilities.
    if response.models.is_some() || response.modes.is_some() || response.prompt_capabilities.is_some() {
        let cache_entry = AgentCache {
            models: response.models.clone(),
            modes: response.modes.clone(),
            prompt_capabilities: response.prompt_capabilities.clone(),
        };
        app_state
            .acp
            .agent_cache
            .lock()
            .await
            .insert((project_id, agent_id.to_string()), cache_entry);
    }

    Ok(response)
}

/// Spawn a long-lived maestro-server on a remote host via SSH exec channel,
/// shared across all sessions for `project_id`. Idempotent.
pub async fn spawn_remote_project_server(
    project_id: i32,
    app_state: &Arc<crate::db::AppState>,
    ssh: &crate::ssh::RemoteSshSession,
    maestro_server_path: &str,
) -> Result<(), String> {
    {
        let servers = app_state.acp.remote_project_servers.lock().await;
        if servers.contains_key(&project_id) {
            return Ok(());
        }
    }

    let channel = ssh
        .open_exec_channel(maestro_server_path)
        .await
        .map_err(|e| format!("Failed to open remote project server channel: {}", e))?;

    let (mut read_half, write_half) = channel.split();

    {
        use tokio::io::AsyncWriteExt;
        let handshake = MaestroRpcMessage::Request(ServerRequest::Handshake(HandshakeRequest {
            protocol_version: PROTOCOL_VERSION,
        }));
        let mut writer = write_half.make_writer();
        write_message(&mut writer, &handshake)
            .await
            .map_err(|e| format!("remote project server handshake write failed: {}", e))?;
        writer.flush().await.map_err(|e| format!("remote project server handshake flush failed: {}", e))?;
    }
    perform_handshake_remote(&mut read_half).await?;

    let (write_tx, mut write_rx) = tokio::sync::mpsc::channel::<Vec<u8>>(32);

    tokio::spawn(async move {
        let mut writer = write_half.make_writer();
        while let Some(bytes) = write_rx.recv().await {
            if writer.write_all(&bytes).await.is_err() {
                break;
            }
            let _ = writer.flush().await;
        }
    });

    let pre_init_pending: Arc<std::sync::Mutex<HashMap<String,
        oneshot::Sender<Result<PreInitializeResponse, String>>>>> =
        Arc::new(std::sync::Mutex::new(HashMap::new()));

    let server = RemoteProjectServer {
        writer_tx: write_tx,
        pre_init_pending: Arc::clone(&pre_init_pending),
    };

    {
        let mut servers = app_state.acp.remote_project_servers.lock().await;
        if servers.contains_key(&project_id) {
            return Ok(());
        }
        servers.insert(project_id, server);
    }

    spawn_shared_remote_reader_task(
        read_half,
        project_id,
        app_state.app_handle.clone(),
        Arc::clone(app_state),
        pre_init_pending,
    );

    Ok(())
}

/// Send a `PreInitialize` request on a remote project's shared maestro-server.
pub async fn pre_initialize_via_remote_project_server(
    project_id: i32,
    agent_id: &str,
    cwd: &str,
    app_state: &Arc<crate::db::AppState>,
) -> Result<PreInitializeResponse, String> {
    let (writer_tx, pre_init_pending) = {
        let servers = app_state.acp.remote_project_servers.lock().await;
        let server = servers
            .get(&project_id)
            .ok_or_else(|| format!("No remote project server for project {}", project_id))?;
        (server.writer_tx.clone(), Arc::clone(&server.pre_init_pending))
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
        .map_err(|_| "Remote project server writer channel closed".to_string())?;

    let response = tokio::time::timeout(std::time::Duration::from_secs(60), rx)
        .await
        .map_err(|_| format!("PreInitialize timed out for agent {}", agent_id))?
        .map_err(|_| "PreInitialize response channel dropped".to_string())??;

    if response.models.is_some() || response.modes.is_some() || response.prompt_capabilities.is_some() {
        let cache_entry = AgentCache {
            models: response.models.clone(),
            modes: response.modes.clone(),
            prompt_capabilities: response.prompt_capabilities.clone(),
        };
        app_state
            .acp
            .agent_cache
            .lock()
            .await
            .insert((project_id, agent_id.to_string()), cache_entry);
    }

    Ok(response)
}

fn spawn_shared_remote_reader_task(
    mut read_half: russh::ChannelReadHalf,
    project_id: i32,
    app_handle: tauri::AppHandle,
    app_state: Arc<crate::db::AppState>,
    pre_init_pending: Arc<std::sync::Mutex<HashMap<String,
        oneshot::Sender<Result<PreInitializeResponse, String>>>>>,
) {
    tokio::spawn(async move {
        let mut msg_buf: Vec<u8> = Vec::new();
        loop {
            match read_half.wait().await {
                Some(ChannelMsg::Data { data }) => {
                    msg_buf.extend_from_slice(&data);
                    while let Some(rpc_msg) = try_parse_acp_frame(&mut msg_buf) {
                        handle_shared_server_message(
                            rpc_msg,
                            project_id,
                            &app_handle,
                            &app_state,
                            &pre_init_pending,
                        )
                        .await;
                    }
                }
                Some(ChannelMsg::ExtendedData { .. })
                | Some(ChannelMsg::WindowAdjusted { .. }) => {}
                Some(ChannelMsg::Eof)
                | Some(ChannelMsg::Close)
                | Some(ChannelMsg::ExitStatus { .. })
                | None => break,
                _ => {}
            }
        }

        app_state.acp.remote_project_servers.lock().await.remove(&project_id);

        let to_remove: Vec<i32> = {
            let sessions = app_state.acp.sessions.lock().await;
            sessions
                .iter()
                .filter(|(_, s)| s.project_id == Some(project_id))
                .map(|(id, _)| *id)
                .collect()
        };
        {
            let mut sessions = app_state.acp.sessions.lock().await;
            for log_id in &to_remove {
                sessions.remove(log_id);
            }
        }
        for log_id in to_remove {
            let _ = app_handle.emit(&format!("acp://session-ended/{}", log_id), ());
        }
        app_state.app_handle.emit("sessions-changed", ()).ok();
    });
}
