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
    HandshakeRequest, ListAgentsRequest, MaestroRpcMessage, PROTOCOL_VERSION, ServerRequest,
    ServerResponse, SpawnRequest, SessionModelState, SessionModeState, PromptCapabilitiesInfo,
    read_message, write_message, FileSearchResponse, FileReadResponse,
    PreInitializeRequest, PreInitializeResponse, SessionLoadRequest,
    SessionListOkResponse, SessionCloseRequest,
    CheckToolsRequest, CheckToolsResponse, SetModeRequest, PermissionResponse,
};
use maestro_protocol::{
    DetectInstalledAgentsRequest, DetectInstalledAgentsResponse,
    DetectProjectAgentsRequest, DetectProjectAgentsResponse,
};


/// A pre-warmed session held in the pool, keyed by (project_id, agent_id).
/// The AcpProcess itself lives in AppState.acp.sessions under this log_id.
pub struct PooledSession {
    pub log_id: i32,
    pub session_id: String,
    pub cwd: String,
}

/// Metadata captured for sessions that were active when the connection server died.
/// Used to reload them after SSH reconnects via the session/load mechanism.
pub struct RestorableSession {
    pub log_id: i32,
    pub agent_id: String,
    /// None when the session hadn't received SpawnOk yet — cannot be restored.
    pub acp_session_id: Option<String>,
    pub cwd: String,
    pub session_name: Option<String>,
    pub project_id: Option<i32>,
    pub task_id: Option<i32>,
}

/// Write transport for a live ACP session.
/// Local sessions write to the child process stdin.
/// Remote sessions send framed bytes to a writer task via mpsc.
/// Shared-server sessions route to a connection-level maestro-server via mpsc.
pub enum AcpTransportWriter {
    Local(BufWriter<ChildStdin>),
    RemoteSsh(tokio::sync::mpsc::Sender<Vec<u8>>),
    /// Session shares a connection-level maestro-server process. The sender routes
    /// to the writer task that owns the child's stdin.
    SharedServer(tokio::sync::mpsc::Sender<Vec<u8>>),
}

/// Pending oneshot channels for a shared `ConnectionServer`.
/// Arc-wrapped so the reader task can hold clones without borrowing the server.
#[derive(Clone)]
pub struct PendingChannels {
    pub pre_init: Arc<std::sync::Mutex<HashMap<String,
        oneshot::Sender<Result<PreInitializeResponse, String>>>>>,
    pub list_agents: Arc<std::sync::Mutex<Option<
        oneshot::Sender<Result<Vec<crate::acp::registry::DiscoveredAgent>, String>>>>>,
    pub session_list: Arc<std::sync::Mutex<Option<
        oneshot::Sender<Result<SessionListOkResponse, String>>>>>,
    pub session_close: Arc<std::sync::Mutex<Option<
        oneshot::Sender<Result<(), String>>>>>,
    pub check_tools: Arc<std::sync::Mutex<Option<
        oneshot::Sender<Result<CheckToolsResponse, String>>>>>,
    pub detect_installed: Arc<std::sync::Mutex<Option<
        oneshot::Sender<Result<DetectInstalledAgentsResponse, String>>>>>,
    pub detect_project: Arc<std::sync::Mutex<Option<
        oneshot::Sender<Result<DetectProjectAgentsResponse, String>>>>>,
}

impl PendingChannels {
    pub fn new() -> Self {
        Self {
            pre_init: Arc::new(std::sync::Mutex::new(HashMap::new())),
            list_agents: Arc::new(std::sync::Mutex::new(None)),
            session_list: Arc::new(std::sync::Mutex::new(None)),
            session_close: Arc::new(std::sync::Mutex::new(None)),
            check_tools: Arc::new(std::sync::Mutex::new(None)),
            detect_installed: Arc::new(std::sync::Mutex::new(None)),
            detect_project: Arc::new(std::sync::Mutex::new(None)),
        }
    }
}

/// A long-lived maestro-server process shared across all sessions for one connection.
///
/// Keyed by `connection_id`: `None` for local, `Some(id)` for remote SSH.
/// All sessions for the connection write through `writer_tx`; the single shared
/// reader task routes responses back to individual `AcpProcess` instances.
pub struct ConnectionServer {
    /// Local subprocess only. `kill_on_drop(true)` ensures cleanup when dropped.
    /// `None` for remote (SSH exec channel) connection servers.
    pub child: Option<Child>,
    /// Channel to the writer task (framed bytes → child stdin / SSH channel).
    /// Cloned into each session's `AcpTransportWriter::SharedServer`.
    pub writer_tx: tokio::sync::mpsc::Sender<Vec<u8>>,
    pub pending: PendingChannels,
}

/// A single option value within a config option catalog entry.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct CatalogOptionValue {
    pub name: String,
    pub value: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct CatalogOption {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub category: String,
    pub options: Vec<CatalogOptionValue>,
    // Agent's default value from initial SpawnOk — used as starting selection for new sessions.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_value: Option<String>,
}

/// A slash command available for an agent.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct CatalogCommand {
    pub name: String,
    pub description: String,
}

/// Session capability flags reported by the agent on SpawnOk. Static per agent.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct SessionCapabilitiesInfo {
    pub supports_session_list: bool,
    pub supports_session_load: bool,
    pub supports_session_close: bool,
}

/// Agent-level catalog cache. Keyed by (project_id, agent_id).
/// Populated from PreInitializeResponse and updated on each SpawnOk/SessionLoadOk/config_option_update.
/// Session-agnostic: no current values stored here.
#[derive(Default, Clone)]
pub struct AgentCache {
    pub config_options: Vec<CatalogOption>,
    pub available_commands: Vec<CatalogCommand>,
    pub prompt_capabilities: Option<PromptCapabilitiesInfo>,
    pub session_capabilities: SessionCapabilitiesInfo,
}

pub type AgentCacheMap = HashMap<(crate::acp::ConnectionKey, String), AgentCache>;

/// Describes where to open a new maestro-server connection: local subprocess, remote SSH channel, or WSL distro.
pub enum TransportTarget<'a> {
    Local,
    Remote { ssh: &'a crate::connectivity::ssh::RemoteSshSession, server_path: &'a str },
    /// WSL distro: spawns `wsl.exe -d <distro> -- <server_path>`.
    /// Uses the same read/write types as Local (wsl.exe is a local subprocess).
    #[cfg(windows)]
    Wsl { distro: &'a str, server_path: &'a str },
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
    /// Current model ID for this session (updated by SpawnOk/SessionLoadOk/SetModelOk).
    /// Used internally for the SetMode re-send hack after SessionLoadOk.
    pub current_model_id: Arc<std::sync::Mutex<Option<String>>>,
    /// Current mode ID for this session (updated by SpawnOk/SessionLoadOk/SetModeOk/current_mode_update).
    /// Used by the SetMode re-send hack to force config_option_update emission after SessionLoadOk.
    pub current_mode_id: Arc<std::sync::Mutex<Option<String>>>,
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
    /// Identifies the connection server that owns this session.
    pub connection_key: crate::acp::ConnectionKey,
    pub started_at: String,
    pub task_id: Option<i32>,
    pub task_name: Option<String>,
    pub branch_name: Option<String>,
    /// Git HEAD SHA captured at session spawn time. Used for session-scoped diffs.
    pub session_start_sha: Option<String>,
    /// Agent's native ACP session ID (returned by NewSessionRequest). Used for alias persistence.
    pub acp_session_id: Arc<std::sync::Mutex<Option<String>>>,
    /// Replay buffer for session-load sessions. `Some(vec)` while waiting for the frontend
    /// listener to register; `None` after drain — events emit directly.
    /// Fresh spawn sessions use `None` (no buffering needed).
    pub replay_buffer: Arc<std::sync::Mutex<Option<Vec<serde_json::Value>>>>,
    /// Set to `true` when SpawnOk or SessionLoadOk is received. Used by drain to avoid
    /// emitting `replay-drained` before the session is ready (empty buffer race).
    pub initialized: Arc<std::sync::Mutex<bool>>,
}

pub struct TaskMetadata {
    pub task_id: Option<i32>,
    pub task_name: Option<String>,
    pub branch_name: Option<String>,
    pub session_start_sha: Option<String>,
}

impl Default for TaskMetadata {
    fn default() -> Self {
        Self { task_id: None, task_name: None, branch_name: None, session_start_sha: None }
    }
}

/// Parameters for constructing an `AcpProcess`. Separates the plain data fields
/// from the Arc-wrapped caches, which `AcpProcess::create` allocates uniformly.
pub struct AcpProcessParams {
    pub writer: AcpTransportWriter,
    pub child: Option<Child>,
    pub cancel_tx: Option<oneshot::Sender<()>>,
    pub cwd: String,
    pub session_name: Option<String>,
    pub agent_id: String,
    pub project_id: Option<i32>,
    /// Identifies the connection server that owns this session.
    pub connection_key: crate::acp::ConnectionKey,
    pub task: TaskMetadata,
    /// Pre-existing ACP session ID (for load sessions). `None` for fresh spawns.
    pub initial_acp_session_id: Option<String>,
    /// Whether to initialise the replay buffer (`Some(vec)`) for load sessions.
    pub enable_replay_buffer: bool,
}

/// Common parameters shared across spawn and load operations.
/// `TransportTarget<'_>` cannot be stored here due to its lifetime.
pub struct SessionRequest {
    pub connection_key: crate::acp::ConnectionKey,
    pub agent_id: String,
    pub cwd: String,
    pub log_id: i32,
    pub session_name: Option<String>,
    pub project_id: Option<i32>,
    pub task_id: Option<i32>,
    pub app_state: Arc<crate::core::AppState>,
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

/// Read source abstraction used for both local (subprocess stdout) and remote (SSH channel)
/// ACP sessions. Encapsulates the per-transport framing differences so the handshake and
/// reader task can share a single implementation.
pub(crate) enum AcpReadSource {
    Local { reader: BufReader<tokio::process::ChildStdout> },
    Remote { read_half: russh::ChannelReadHalf, msg_buf: Vec<u8> },
}

impl AcpReadSource {
    pub(crate) async fn next_message(&mut self) -> Option<MaestroRpcMessage> {
        match self {
            AcpReadSource::Local { reader } => loop {
                match read_message(reader).await {
                    Ok(msg) => {
                        return Some(msg);
                    }
                    Err(e) => {
                        // Only EOF is terminal. Parse errors are recoverable: read_message
                        // consumed the frame bytes via read_exact before failing to deserialize,
                        // so the stream is correctly positioned for the next frame.
                        let is_eof = e
                            .downcast_ref::<std::io::Error>()
                            .map(|io| io.kind() == std::io::ErrorKind::UnexpectedEof)
                            .unwrap_or(false);
                        if is_eof {
                            return None;
                        }
                        // Loop and try next frame
                    }
                }
            },
            AcpReadSource::Remote { read_half, msg_buf } => loop {
                if let Some(msg) = try_parse_acp_frame(msg_buf) {
                    return Some(msg);
                }
                match read_half.wait().await {
                    Some(ChannelMsg::Data { data }) => {
                        msg_buf.extend_from_slice(&data);
                        if let Some(msg) = try_parse_acp_frame(msg_buf) {
                            return Some(msg);
                        }
                    }
                    Some(ChannelMsg::ExtendedData { .. })
                    | Some(ChannelMsg::WindowAdjusted { .. }) => {}
                    Some(ChannelMsg::Eof)
                    | Some(ChannelMsg::Close)
                    | Some(ChannelMsg::ExitStatus { .. })
                    | None => return None,
                    _ => {}
                }
            },
        }
    }
}

/// Read one framed response and verify it is HandshakeOk. Times out after 10 seconds.
pub(crate) async fn perform_handshake(source: &mut AcpReadSource) -> Result<(), String> {
    let hs_resp = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        source.next_message(),
    )
    .await
    .map_err(|_| "maestro-server handshake timed out".to_string())?;

    match hs_resp {
        Some(MaestroRpcMessage::Response(ServerResponse::HandshakeOk(_))) => Ok(()),
        Some(MaestroRpcMessage::Response(ServerResponse::Error(error))) => {
            Err(format!("maestro-server handshake rejected: {}", error.message))
        }
        _ => Err("maestro-server did not respond with HandshakeOk".to_string()),
    }
}

/// Parse one complete framed message from `buf`, always consuming its bytes.
/// Returns None on parse failure (corrupt frame skipped) or incomplete frame.
pub(crate) fn try_parse_acp_frame(buf: &mut Vec<u8>) -> Option<MaestroRpcMessage> {
    if buf.len() < 4 {
        return None;
    }
    let len = u32::from_le_bytes([buf[0], buf[1], buf[2], buf[3]]) as usize;
    if buf.len() < 4 + len {
        return None;
    }
    // Drain first so a corrupt frame never loops — caller retries with the next frame.
    let frame_bytes = buf[4..4 + len].to_vec();
    buf.drain(..4 + len);
    match serde_json::from_slice::<MaestroRpcMessage>(&frame_bytes) {
        Ok(msg) => Some(msg),
        Err(_) => None,
    }
}

/// Shared post-spawn logic for subprocess transports (local and WSL).
/// Takes an already-spawned child with stdin/stdout piped, sends the handshake, and returns
/// (stdin_writer, read_source, child) ready for the caller to use.
async fn handshake_local_child(
    mut child: tokio::process::Child,
) -> Result<(BufWriter<ChildStdin>, AcpReadSource, tokio::process::Child), String> {
    let child_stdin = child
        .stdin
        .take()
        .ok_or_else(|| "child stdin was not piped".to_string())?;
    let child_stdout = child
        .stdout
        .take()
        .ok_or_else(|| "child stdout was not piped".to_string())?;
    let mut stdin_writer = BufWriter::new(child_stdin);

    let handshake = MaestroRpcMessage::Request(ServerRequest::Handshake(HandshakeRequest {
        protocol_version: PROTOCOL_VERSION,
    }));
    write_to_acp_session_raw(&mut stdin_writer, &handshake).await?;

    let mut source = AcpReadSource::Local { reader: BufReader::new(child_stdout) };
    perform_handshake(&mut source).await?;

    Ok((stdin_writer, source, child))
}

/// Spawn a local maestro-server subprocess and perform handshake.
/// Returns (stdin_writer, read_source, child) ready for the caller to use.
async fn open_local_transport(
    app_state: &Arc<crate::core::AppState>,
) -> Result<(BufWriter<ChildStdin>, AcpReadSource, tokio::process::Child), String> {
    use std::process::Stdio;
    let server_path = crate::acp::resolve::resolve_server_path(&app_state.app_handle)?;

    let stderr = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open("/tmp/maestro-debug.log")
        .map(Stdio::from)
        .unwrap_or_else(|_| Stdio::inherit());

    use crate::command_ext::NoConsoleWindow;
    let child = tokio::process::Command::new(server_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(stderr)
        .kill_on_drop(true)
        .no_console_window()
        .spawn()
        .map_err(|e| format!("Failed to spawn maestro-server: {}", e))?;

    handshake_local_child(child).await
}

/// Open an SSH exec channel to a remote maestro-server, perform handshake, and spawn
/// a writer task. Returns (mpsc_sender, read_source) ready for the caller to use.
async fn open_remote_transport(
    ssh_session: &crate::connectivity::ssh::RemoteSshSession,
    maestro_server_path: &str,
) -> Result<(tokio::sync::mpsc::Sender<Vec<u8>>, AcpReadSource), String> {
    let channel = ssh_session
        .open_exec_channel(maestro_server_path)
        .await
        .map_err(|e| format!("Failed to open remote maestro-server channel: {}", e))?;

    let (read_half, write_half) = channel.split();

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

    let mut source = AcpReadSource::Remote { read_half, msg_buf: Vec::new() };
    perform_handshake(&mut source).await?;

    let (write_tx, mut write_rx) = tokio::sync::mpsc::channel::<Vec<u8>>(32);
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

    Ok((write_tx, source))
}

/// Spawn a WSL subprocess and perform handshake.
/// Wraps server launch in `bash -lc` so login profile scripts run, giving
/// maestro-server (and its child processes) access to nvm/pyenv/etc. in PATH.
/// Returns (stdin_writer, read_source, child) — same types as `open_local_transport`.
#[cfg(windows)]
async fn open_wsl_transport(
    distro: &str,
    server_path: &str,
) -> Result<(BufWriter<ChildStdin>, AcpReadSource, tokio::process::Child), String> {
    use std::process::Stdio;
    use crate::command_ext::NoConsoleWindow;
    let child = tokio::process::Command::new("wsl.exe")
        .args(["-d", distro, "--", "bash", "-lc", server_path])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .no_console_window()
        .spawn()
        .map_err(|e| format!("Failed to spawn WSL maestro-server in {}: {}", distro, e))?;

    handshake_local_child(child).await
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
    emit_cached_capabilities(&acp_process, req.connection_key, &req.agent_id, req.log_id, &req.app_state).await;
    req.app_state.acp.sessions.lock().await.insert(req.log_id, acp_process);
    Ok(true)
}

/// Emit cached catalog as legacy session-models/session-modes/session-capabilities events
/// immediately after session creation, so the frontend gets available options before SpawnOk.
/// Seeds per-session current_model_id/current_mode_id with the catalog's first option value
/// as a best-guess; real current values arrive via SpawnOk/config_option_update.
pub async fn emit_cached_capabilities(
    acp_process: &AcpProcess,
    connection_key: crate::acp::ConnectionKey,
    agent_id: &str,
    log_id: i32,
    app_state: &Arc<crate::core::AppState>,
) {
    let cache = match app_state.acp.agent_cache.lock().await.get(&(connection_key, agent_id.to_string())).cloned() {
        Some(c) => c,
        None => return,
    };

    if let Some(model_opt) = cache.config_options.iter().find(|o| o.id == "model") {
        if let Some(first) = model_opt.options.first() {
            if let Ok(mut m) = acp_process.current_model_id.lock() { *m = Some(first.value.clone()); }
        }
        let legacy_models = serde_json::json!({
            "current_model_id": model_opt.options.first().map(|v| &v.value),
            "available_models": model_opt.options.iter().map(|v| serde_json::json!({
                "model_id": v.value, "name": v.name
            })).collect::<Vec<_>>(),
        });
        let _ = app_state.app_handle.emit(&format!("acp://session-models/{}", log_id), &legacy_models);
    }

    if let Some(mode_opt) = cache.config_options.iter().find(|o| o.id == "mode") {
        if let Some(first) = mode_opt.options.first() {
            if let Ok(mut m) = acp_process.current_mode_id.lock() { *m = Some(first.value.clone()); }
        }
        let legacy_modes = serde_json::json!({
            "current_mode_id": mode_opt.options.first().map(|v| &v.value),
            "available_modes": mode_opt.options.iter().map(|v| serde_json::json!({
                "mode_id": v.value, "name": v.name
            })).collect::<Vec<_>>(),
        });
        let _ = app_state.app_handle.emit(&format!("acp://session-modes/{}", log_id), &legacy_modes);
    }

    if let Some(caps) = &cache.prompt_capabilities {
        let _ = app_state.app_handle.emit(&format!("acp://session-capabilities/{}", log_id), caps);
    }
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
            (AcpTransportWriter::Local(stdin_writer), source, Some(child))
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
            (AcpTransportWriter::Local(stdin_writer), source, Some(child))
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

pub struct ReaderTaskContext {
    pub log_id: i32,
    pub app_handle: tauri::AppHandle,
    pub app_state: Arc<crate::core::AppState>,
    pub current_model_id: Arc<std::sync::Mutex<Option<String>>>,
    pub current_mode_id: Arc<std::sync::Mutex<Option<String>>>,
    pub pending_file_search: Arc<std::sync::Mutex<Option<oneshot::Sender<Result<Vec<String>, String>>>>>,
    pub pending_file_read: Arc<std::sync::Mutex<Option<oneshot::Sender<Result<String, String>>>>>,
    pub acp_session_id_cache: Arc<std::sync::Mutex<Option<String>>>,
    pub replay_buffer: Arc<std::sync::Mutex<Option<Vec<serde_json::Value>>>>,
    pub initialized: Arc<std::sync::Mutex<bool>>,
    pub session_name: Option<String>,
    pub agent_id: String,
    pub project_id: Option<i32>,
    pub task_id: Option<i32>,
    pub connection_key: crate::acp::ConnectionKey,
}

impl AcpProcess {
    pub fn create(
        params: AcpProcessParams,
        log_id: i32,
        app_handle: tauri::AppHandle,
        app_state: Arc<crate::core::AppState>,
    ) -> (Self, ReaderTaskContext) {
        let current_model_id = Arc::new(std::sync::Mutex::new(None));
        let current_mode_id = Arc::new(std::sync::Mutex::new(None));
        let pending_file_search = Arc::new(std::sync::Mutex::new(None));
        let pending_file_read = Arc::new(std::sync::Mutex::new(None));
        let acp_session_id = Arc::new(std::sync::Mutex::new(params.initial_acp_session_id));
        let replay_buffer = Arc::new(std::sync::Mutex::new(
            if params.enable_replay_buffer { Some(Vec::new()) } else { None },
        ));
        let initialized = Arc::new(std::sync::Mutex::new(false));
        let ctx = ReaderTaskContext {
            log_id,
            app_handle,
            app_state,
            current_model_id: Arc::clone(&current_model_id),
            current_mode_id: Arc::clone(&current_mode_id),
            pending_file_search: Arc::clone(&pending_file_search),
            pending_file_read: Arc::clone(&pending_file_read),
            acp_session_id_cache: Arc::clone(&acp_session_id),
            replay_buffer: Arc::clone(&replay_buffer),
            initialized: Arc::clone(&initialized),
            session_name: params.session_name.clone(),
            agent_id: params.agent_id.clone(),
            project_id: params.project_id,
            task_id: params.task.task_id,
            connection_key: params.connection_key,
        };
        let process = Self {
            writer: params.writer,
            child: params.child,
            reader_cancel_tx: params.cancel_tx,
            current_model_id,
            current_mode_id,
            cwd: params.cwd,
            pending_file_search,
            pending_file_read,
            session_name: params.session_name,
            agent_id_meta: params.agent_id,
            project_id: params.project_id,
            connection_key: params.connection_key,
            started_at: chrono::Utc::now().to_rfc3339(),
            task_id: params.task.task_id,
            task_name: params.task.task_name,
            branch_name: params.task.branch_name,
            session_start_sha: params.task.session_start_sha,
            acp_session_id,
            replay_buffer,
            initialized,
        };
        (process, ctx)
    }
}

pub(crate) fn spawn_reader_task(
    source: AcpReadSource,
    cancel_rx: oneshot::Receiver<()>,
    ctx: ReaderTaskContext,
) {
    let ReaderTaskContext {
        log_id, app_handle, app_state,
        current_model_id, current_mode_id,
        pending_file_search, pending_file_read,
        acp_session_id_cache, replay_buffer, initialized,
        session_name, agent_id, project_id, task_id, connection_key,
    } = ctx;
    tokio::spawn(async move {
        let mut source = source;
        let mut cancel_rx = cancel_rx;

        loop {
            let msg = tokio::select! {
                biased;
                _ = &mut cancel_rx => break,
                result = source.next_message() => match result {
                    Some(msg) => msg,
                    None => break,
                },
            };
            update_agent_cache_from_response(&msg, &app_state).await;
            update_agent_cache_from_session_update(&msg, connection_key, &agent_id, &app_state).await;

            if let MaestroRpcMessage::Response(ServerResponse::PermissionRequest(ref perm_req)) = msg {
                if let Some(tid) = task_id {
                    if try_auto_approve_permission(&app_state, tid, log_id, perm_req).await {
                        continue;
                    }
                }
            }

            if let MaestroRpcMessage::Response(ServerResponse::TurnEnded(ref turn_ended)) = msg {
                if turn_ended.stop_reason == "end_turn" {
                    if let Some(tid) = task_id {
                        if try_complete_task(&app_state, tid).await {
                            app_state.app_handle.emit("tasks-changed", ()).ok();
                        }
                    }
                }
            }

            let is_init_ok = matches!(&msg, MaestroRpcMessage::Response(
                ServerResponse::SessionLoadOk(_) | ServerResponse::SpawnOk(_)
            ));
            if let Some(native_id) = handle_server_message(msg, log_id, &app_handle, &current_model_id, &current_mode_id, &pending_file_search, &pending_file_read, &acp_session_id_cache, &replay_buffer, &initialized) {
                if let (Some(pid), Some(ref name)) = (project_id, &session_name) {
                    if let Ok(conn) = app_state.db.lock() {
                        let _ = upsert_session_alias(&conn, pid, &agent_id, &native_id, name);
                    }
                }
            }
            // After SpawnOk or SessionLoadOk, send SetMode with the current mode to trigger
            // config_option_update from ACP, which includes all config options (model, mode, effort).
            // SpawnOk/SessionLoadOk only provide models and modes; config options are missing until triggered.
            if is_init_ok {
                let mode_id = current_mode_id.lock().ok().and_then(|m| m.clone());
                if let Some(mode_id) = mode_id {
                    let session_id = format!("session-{}", log_id);
                    let set_mode_msg = MaestroRpcMessage::Request(ServerRequest::SetMode(SetModeRequest {
                        session_id,
                        mode_id,
                    }));
                    let _ = crate::acp::write_to_acp_session(&app_state, log_id, &set_mode_msg).await;
                }
            }
        }

        app_state.acp.sessions.lock().await.remove(&log_id);
        if let Some(tid) = task_id {
            if try_complete_task(&app_state, tid).await {
                app_state.app_handle.emit("tasks-changed", ()).ok();
            }
        }
        app_state.app_handle.emit("sessions-changed", ()).ok();
        let _ = app_handle.emit(&format!("acp://session-ended/{}", log_id), ());
    });
}

async fn try_complete_task(app_state: &crate::core::AppState, task_id: i32) -> bool {
    let is_git_repo = is_task_project_git_repo(app_state, task_id).await;
    let Ok(conn) = app_state.db.lock() else { return false };
    let now = chrono::Utc::now().to_rfc3339();
    let target_status = if is_git_repo { "Review" } else { "Done" };
    conn.execute(
        &format!("UPDATE tasks SET status = '{}', updated_at = ? WHERE id = ? AND status = 'InProgress'", target_status),
        rusqlite::params![&now, task_id],
    )
    .unwrap_or(0) > 0
}

async fn is_task_project_git_repo(app_state: &crate::core::AppState, task_id: i32) -> bool {
    let result: Option<(i32, String, Option<i32>, Option<i32>)> = app_state.db.lock().ok().and_then(|conn| {
        conn.query_row(
            "SELECT p.id, p.path, p.connection_id, p.wsl_connection_id \
             FROM tasks t JOIN projects p ON t.project_id = p.id \
             WHERE t.id = ?",
            [task_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        ).ok()
    });

    let Some((project_id, path, connection_id, wsl_connection_id)) = result else {
        return true;
    };

    if connection_id.is_none() && wsl_connection_id.is_none() {
        return std::path::Path::new(&path).join(".git").exists();
    }

    match crate::core::get_project_with_git_conn(app_state, project_id).await {
        Ok((_project, git_conn)) => {
            crate::git::run_git_in_dir(&git_conn, &path, &["rev-parse", "--is-inside-work-tree"])
                .await
                .map(|output| output.trim() == "true")
                .unwrap_or(false)
        }
        Err(_) => false,
    }
}

async fn try_auto_approve_permission(
    app_state: &Arc<crate::core::AppState>,
    task_id: i32,
    log_id: i32,
    perm_req: &crate::acp::transport::PermissionRequest,
) -> bool {
    let auto_approve = app_state.db.lock().ok()
        .and_then(|conn| conn.query_row(
            "SELECT auto_approve FROM tasks WHERE id = ?",
            [task_id],
            |row| row.get::<_, bool>(0),
        ).ok())
        .unwrap_or(false);

    if !auto_approve {
        return false;
    }

    let option_id = perm_req.payload.get("options")
        .and_then(|v| v.as_array())
        .and_then(|opts| {
            opts.iter().find_map(|opt| {
                let kind = opt.get("kind").and_then(|v| v.as_str())?;
                if kind == "allow_always" {
                    return opt.get("optionId").and_then(|v| v.as_str()).map(|s| s.to_string());
                }
                None
            })
            .or_else(|| opts.iter().find_map(|opt| {
                let kind = opt.get("kind").and_then(|v| v.as_str())?;
                if kind == "allow_once" {
                    return opt.get("optionId").and_then(|v| v.as_str()).map(|s| s.to_string());
                }
                None
            }))
            .or_else(|| opts.iter().find_map(|opt| {
                let kind = opt.get("kind").and_then(|v| v.as_str())?;
                if kind.contains("allow") {
                    return opt.get("optionId").and_then(|v| v.as_str()).map(|s| s.to_string());
                }
                None
            }))
        });

    let Some(oid) = option_id else { return false };

    let session_id = format!("session-{}", log_id);
    let response = MaestroRpcMessage::Request(
        ServerRequest::PermitResponse(PermissionResponse {
            session_id,
            request_id: perm_req.request_id.clone(),
            option_id: Some(oid),
        })
    );
    let _ = crate::acp::write_to_acp_session(app_state, log_id, &response).await;
    true
}

/// Push a synthetic `config_option_update` session-update into the replay buffer so that
/// model/mode config reaches the frontend via the safely-drained buffer path rather than a
/// directly-emitted event that may race with listener registration in `useAcpSessionLifecycle`.
/// `sessionUpdateRef.current` in that hook is set synchronously (not in a useEffect), so it is
/// always ready when drain fires — unlike the async `listen()` calls for `session-models`.
fn push_config_init_to_buffer(
    models: Option<&SessionModelState>,
    modes: Option<&SessionModeState>,
    replay_buffer: &Arc<std::sync::Mutex<Option<Vec<serde_json::Value>>>>,
) {
    let mut buf_guard = match replay_buffer.lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    let vec = match buf_guard.as_mut() {
        Some(v) => v,
        None => return,
    };
    // Push value-only updates — don't send options list from load response because
    // it's degraded compared to the catalog from SpawnOk.
    if let Some(m) = models {
        vec.push(serde_json::json!({
            "sessionUpdate": "current_model_update",
            "modelId": m.current_model_id,
        }));
    }
    if let Some(m) = modes {
        vec.push(serde_json::json!({
            "sessionUpdate": "current_mode_update",
            "modeId": m.current_mode_id,
        }));
    }
}

fn emit_session_init_events(
    models: Option<&SessionModelState>,
    modes: Option<&SessionModeState>,
    caps: Option<&PromptCapabilitiesInfo>,
    log_id: i32,
    app_handle: &tauri::AppHandle,
    current_model_id: &Arc<std::sync::Mutex<Option<String>>>,
    current_mode_id: &Arc<std::sync::Mutex<Option<String>>>,
) {
    if let Some(m) = models {
        if let Ok(mut cache) = current_model_id.lock() { *cache = Some(m.current_model_id.clone()); }
        let _ = app_handle.emit(&format!("acp://session-models/{}", log_id), m);
    }
    if let Some(m) = modes {
        if let Ok(mut cache) = current_mode_id.lock() { *cache = Some(m.current_mode_id.clone()); }
        let _ = app_handle.emit(&format!("acp://session-modes/{}", log_id), m);
    }
    if let Some(c) = caps {
        let _ = app_handle.emit(&format!("acp://session-capabilities/{}", log_id), c);
    }
}

/// Emit Tauri events for a parsed server response. Updates per-session current model/mode IDs.
/// Returns the native ACP session ID when a SpawnOk message is processed, None otherwise.
fn handle_server_message(
    msg: MaestroRpcMessage,
    log_id: i32,
    app_handle: &tauri::AppHandle,
    current_model_id: &Arc<std::sync::Mutex<Option<String>>>,
    current_mode_id: &Arc<std::sync::Mutex<Option<String>>>,
    pending_file_search: &Arc<std::sync::Mutex<Option<oneshot::Sender<Result<Vec<String>, String>>>>>,
    pending_file_read: &Arc<std::sync::Mutex<Option<oneshot::Sender<Result<String, String>>>>>,
    acp_session_id_cache: &Arc<std::sync::Mutex<Option<String>>>,
    replay_buffer: &Arc<std::sync::Mutex<Option<Vec<serde_json::Value>>>>,
    initialized: &Arc<std::sync::Mutex<bool>>,
) -> Option<String> {
    eprintln!("[maestro] handle_server_message: log_id={log_id} msg={msg:?}");
    match msg {
        MaestroRpcMessage::Response(ServerResponse::SessionUpdate(upd)) => {
            // Detect CurrentModeUpdate to keep the per-session current_mode_id current.
            if upd.payload.get("sessionUpdate").and_then(|v| v.as_str()) == Some("current_mode_update") {
                if let Some(mode_id) = upd.payload.get("currentModeId").and_then(|v| v.as_str()) {
                    if let Ok(mut m) = current_mode_id.lock() {
                        *m = Some(mode_id.to_string());
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
            emit_session_init_events(
                spawn_ok.models.as_ref(),
                spawn_ok.modes.as_ref(),
                spawn_ok.prompt_capabilities.as_ref(),
                log_id, app_handle, current_model_id, current_mode_id,
            );
            let new_native_id = if let Some(native_id) = spawn_ok.acp_session_id {
                if let Ok(mut cache) = acp_session_id_cache.lock() {
                    *cache = Some(native_id.clone());
                }
                Some(native_id)
            } else {
                None
            };
            if let Ok(mut init) = initialized.lock() { *init = true; }
            let _ = app_handle.emit("sessions-changed", ());
            let _ = app_handle.emit(&format!("acp://spawn-ok/{}", log_id), ());
            return new_native_id;
        }
        MaestroRpcMessage::Response(ServerResponse::SessionLoadOk(load_ok)) => {
            emit_session_init_events(
                load_ok.models.as_ref(),
                load_ok.modes.as_ref(),
                load_ok.prompt_capabilities.as_ref(),
                log_id, app_handle, current_model_id, current_mode_id,
            );
            push_config_init_to_buffer(load_ok.models.as_ref(), load_ok.modes.as_ref(), replay_buffer);
            if let Ok(mut init) = initialized.lock() { *init = true; }
            let _ = app_handle.emit(&format!("acp://spawn-ok/{}", log_id), ());
        }
        MaestroRpcMessage::Response(ServerResponse::SetModelOk(ok)) => {
            if let Ok(mut m) = current_model_id.lock() { *m = Some(ok.model_id.clone()); }
            let _ = app_handle.emit(&format!("acp://model-changed/{}", log_id), &ok.model_id);
        }
        MaestroRpcMessage::Response(ServerResponse::SetModeOk(ok)) => {
            if let Ok(mut m) = current_mode_id.lock() { *m = Some(ok.mode_id.clone()); }
            let _ = app_handle.emit(&format!("acp://mode-changed/{}", log_id), &ok.mode_id);
        }
        MaestroRpcMessage::Response(ServerResponse::SetConfigOptionOk(ok)) => {
            let _ = app_handle.emit(
                &format!("acp://config-changed/{}", log_id),
                &serde_json::json!({ "config_id": ok.config_id, "value": ok.value }),
            );
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
    app_state: &crate::core::AppState,
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

fn model_state_to_catalog_option(state: &SessionModelState) -> CatalogOption {
    CatalogOption {
        id: "model".to_string(),
        name: "Model".to_string(),
        description: None,
        category: "model".to_string(),
        options: state.available_models.iter().map(|m| CatalogOptionValue {
            name: m.name.clone(),
            value: m.model_id.clone(),
            description: m.description.clone(),
        }).collect(),
        default_value: Some(state.current_model_id.clone()),
    }
}

fn mode_state_to_catalog_option(state: &SessionModeState) -> CatalogOption {
    CatalogOption {
        id: "mode".to_string(),
        name: "Permission mode".to_string(),
        description: None,
        category: "mode".to_string(),
        options: state.available_modes.iter().map(|m| CatalogOptionValue {
            name: m.name.clone(),
            value: m.mode_id.clone(),
            description: m.description.clone(),
        }).collect(),
        default_value: Some(state.current_mode_id.clone()),
    }
}

fn upsert_catalog_option(options: &mut Vec<CatalogOption>, option: CatalogOption) {
    if let Some(existing) = options.iter_mut().find(|o| o.id == option.id) {
        *existing = option;
    } else {
        options.push(option);
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
        MaestroRpcMessage::Response(ServerResponse::SetConfigOptionOk(r)) => log_id_from_session_id(&r.session_id),
        MaestroRpcMessage::Response(ServerResponse::SessionLoadOk(r)) => log_id_from_session_id(&r.session_id),
        _ => None,
    }
}

/// Update the agent-level catalog cache from SpawnOk or SessionLoadOk.
/// Converts models/modes to CatalogOption entries; stores prompt_capabilities and
/// (SpawnOk only) session_capabilities in the agent cache.
async fn update_agent_cache_from_response(
    msg: &MaestroRpcMessage,
    app_state: &Arc<crate::core::AppState>,
) {
    let (models, modes, caps, spawn_caps) = match msg {
        MaestroRpcMessage::Response(ServerResponse::SpawnOk(r)) => {
            let spawn_caps = Some(SessionCapabilitiesInfo {
                supports_session_list: r.supports_session_list,
                supports_session_load: r.supports_session_load,
                supports_session_close: r.supports_session_close,
            });
            (r.models.as_ref(), r.modes.as_ref(), r.prompt_capabilities.as_ref(), spawn_caps)
        }
        MaestroRpcMessage::Response(ServerResponse::SessionLoadOk(r)) => {
            // Don't update cached model/mode options from load responses — they return a
            // degraded list that would overwrite the correct catalog from SpawnOk.
            (None, None, r.prompt_capabilities.as_ref(), None)
        }
        _ => return,
    };

    if models.is_none() && modes.is_none() && caps.is_none() && spawn_caps.is_none() {
        return;
    }

    let (agent_id, connection_key) = if let Some(log_id) = extract_session_log_id(msg) {
        let sessions = app_state.acp.sessions.lock().await;
        match sessions.get(&log_id) {
            Some(s) => (s.agent_id_meta.clone(), s.connection_key),
            None => return,
        }
    } else {
        return;
    };

    {
        let mut cache_map = app_state.acp.agent_cache.lock().await;
        let entry = cache_map
            .entry((connection_key, agent_id.clone()))
            .or_insert_with(AgentCache::default);
        if let Some(m) = models {
            upsert_catalog_option(&mut entry.config_options, model_state_to_catalog_option(m));
        }
        if let Some(m) = modes {
            upsert_catalog_option(&mut entry.config_options, mode_state_to_catalog_option(m));
        }
        if let Some(c) = caps {
            entry.prompt_capabilities = Some(c.clone());
        }
        if let Some(sc) = spawn_caps {
            entry.session_capabilities = sc;
        }
    }
    let mut payload = serde_json::to_value(&connection_key).unwrap_or_default();
    payload["agent_id"] = serde_json::json!(agent_id);
    app_state.app_handle.emit("agent-cache-updated", payload).ok();
}

/// Update the agent-level catalog cache from config_option_update or available_commands_update
/// SessionUpdate events. Called from the reader task loop alongside update_agent_cache_from_response.
async fn update_agent_cache_from_session_update(
    msg: &MaestroRpcMessage,
    connection_key: crate::acp::ConnectionKey,
    agent_id: &str,
    app_state: &Arc<crate::core::AppState>,
) {
    let payload = match msg {
        MaestroRpcMessage::Response(ServerResponse::SessionUpdate(upd)) => &upd.payload,
        _ => return,
    };

    let update_type = match payload.get("sessionUpdate").and_then(|v| v.as_str()) {
        Some(t) => t,
        None => return,
    };

    let mut updated = false;

    if update_type == "config_option_update" {
        if let Some(options_val) = payload.get("configOptions") {
            if let Ok(mut options) = serde_json::from_value::<Vec<CatalogOption>>(options_val.clone()) {
                // Extract currentValue from raw JSON per option (not in CatalogOption struct).
                let raw_options = options_val.as_array();
                let mut cache_map = app_state.acp.agent_cache.lock().await;
                let entry = cache_map.entry((connection_key, agent_id.to_string())).or_insert_with(AgentCache::default);
                for (idx, incoming) in options.iter_mut().enumerate() {
                    // Filter out "default" pseudo-option — it means "use agent default" which
                    // adds no information to the selector.
                    incoming.options.retain(|o| o.value != "default");

                    if let Some(existing) = entry.config_options.iter_mut().find(|o| o.id == incoming.id) {
                        for inc_opt in &incoming.options {
                            if let Some(cached_opt) = existing.options.iter_mut().find(|o| o.value == inc_opt.value) {
                                if cached_opt.description.is_none() && inc_opt.description.is_some() {
                                    cached_opt.description = inc_opt.description.clone();
                                }
                            }
                        }
                        updated = true;
                    } else {
                        // Extract currentValue from raw JSON to use as default_value.
                        if incoming.default_value.is_none() {
                            if let Some(raw) = raw_options.and_then(|arr| arr.get(idx)) {
                                if let Some(cv) = raw.get("currentValue").and_then(|v| v.as_str()) {
                                    incoming.default_value = Some(cv.to_string());
                                }
                            }
                        }
                        entry.config_options.push(incoming.clone());
                        updated = true;
                    }
                }
            }
        }
    } else if update_type == "available_commands_update" {
        if let Some(commands_val) = payload.get("availableCommands") {
            if let Ok(commands) = serde_json::from_value::<Vec<CatalogCommand>>(commands_val.clone()) {
                let mut cache_map = app_state.acp.agent_cache.lock().await;
                let entry = cache_map.entry((connection_key, agent_id.to_string())).or_insert_with(AgentCache::default);
                entry.available_commands = commands;
                updated = true;
            }
        }
    }

    if updated {
        let mut event_payload = serde_json::to_value(&connection_key).unwrap_or_default();
        event_payload["agent_id"] = serde_json::json!(agent_id);
        app_state.app_handle.emit("agent-cache-updated", event_payload).ok();
    }
}

/// Route a shared-reader message to the correct per-session handler or to
/// connection-level pending channels (PreInitialize, SessionList, SessionClose, etc.).
async fn handle_shared_server_message(
    msg: MaestroRpcMessage,
    connection_key: crate::acp::ConnectionKey,
    app_handle: &tauri::AppHandle,
    app_state: &Arc<crate::core::AppState>,
    pending: &PendingChannels,
) {
    eprintln!("[maestro] handle_shared_server_message: log_id={:?} msg={msg:?}", extract_session_log_id(&msg));
    // Session-bearing messages: extract log_id, borrow caches from AcpProcess,
    // then call the existing single-session handler.
    if let Some(log_id) = extract_session_log_id(&msg) {
        // Update agent-level cache on SpawnOk/SessionLoadOk and session updates before dispatching.
        update_agent_cache_from_response(&msg, app_state).await;
        let session_identity = {
            let sessions = app_state.acp.sessions.lock().await;
            sessions.get(&log_id).map(|s| (s.agent_id_meta.clone(), s.connection_key))
        };
        if let Some((ref agent_id, conn_key)) = session_identity {
            update_agent_cache_from_session_update(&msg, conn_key, agent_id, app_state).await;
        }

        let caches = {
            let sessions = app_state.acp.sessions.lock().await;
            sessions.get(&log_id).map(|s| (
                Arc::clone(&s.current_model_id),
                Arc::clone(&s.current_mode_id),
                Arc::clone(&s.pending_file_search),
                Arc::clone(&s.pending_file_read),
                Arc::clone(&s.acp_session_id),
                Arc::clone(&s.replay_buffer),
                Arc::clone(&s.initialized),
                s.session_name.clone(),
                s.agent_id_meta.clone(),
                s.project_id,
                s.task_id,
            ))
        };
        if let Some((current_model_id, current_mode_id, pfs, pfr, acp_sid, replay, initialized,
                      session_name, agent_id, pid, task_id)) = caches {
            if let MaestroRpcMessage::Response(ServerResponse::PermissionRequest(ref perm_req)) = msg {
                if let Some(tid) = task_id {
                    if try_auto_approve_permission(app_state, tid, log_id, perm_req).await {
                        return;
                    }
                }
            }

            if let MaestroRpcMessage::Response(ServerResponse::TurnEnded(ref turn_ended)) = msg {
                if turn_ended.stop_reason == "end_turn" {
                    if let Some(tid) = task_id {
                        if try_complete_task(app_state, tid).await {
                            app_state.app_handle.emit("tasks-changed", ()).ok();
                        }
                    }
                }
            }

            let is_init_ok = matches!(&msg, MaestroRpcMessage::Response(
                ServerResponse::SessionLoadOk(_) | ServerResponse::SpawnOk(_)
            ));
            let native_id = handle_server_message(
                msg, log_id, app_handle,
                &current_model_id, &current_mode_id, &pfs, &pfr, &acp_sid, &replay, &initialized,
            );
            if let Some(native_id) = native_id {
                if let (Some(project_id_val), Some(ref name)) = (pid, &session_name) {
                    if let Ok(conn) = app_state.db.lock() {
                        let _ = upsert_session_alias(&conn, project_id_val, &agent_id, &native_id, name);
                    }
                }
            }
            if is_init_ok {
                let mode_id = current_mode_id.lock().ok().and_then(|m| m.clone());
                if let Some(mode_id) = mode_id {
                    let session_id = format!("session-{}", log_id);
                    let set_mode_msg = MaestroRpcMessage::Request(ServerRequest::SetMode(SetModeRequest {
                        session_id,
                        mode_id,
                    }));
                    let _ = crate::acp::write_to_acp_session(app_state, log_id, &set_mode_msg).await;
                }
            }
        }
        return;
    }

    // Sessionless messages.
    match msg {
        MaestroRpcMessage::Response(ServerResponse::ListAgentsOk(resp)) => {
            let agents = resp.agents.into_iter().map(|a| crate::acp::registry::DiscoveredAgent {
                id: a.id,
                name: a.name,
                icon: a.icon,
                spawn_deps: a.spawn_deps,
            }).collect();
            if let Ok(mut guard) = pending.list_agents.lock() {
                if let Some(tx) = guard.take() {
                    let _ = tx.send(Ok(agents));
                }
            }
        }
        MaestroRpcMessage::Response(ServerResponse::SessionListOk(resp)) => {
            if let Ok(mut guard) = pending.session_list.lock() {
                if let Some(tx) = guard.take() {
                    let _ = tx.send(Ok(resp));
                }
            }
        }
        MaestroRpcMessage::Response(ServerResponse::SessionCloseOk) => {
            if let Ok(mut guard) = pending.session_close.lock() {
                if let Some(tx) = guard.take() {
                    let _ = tx.send(Ok(()));
                }
            }
        }
        MaestroRpcMessage::Response(ServerResponse::CheckToolsOk(resp)) => {
            if let Ok(mut guard) = pending.check_tools.lock() {
                if let Some(tx) = guard.take() {
                    let _ = tx.send(Ok(resp));
                }
            }
        }
        MaestroRpcMessage::Response(ServerResponse::DetectInstalledAgentsOk(resp)) => {
            if let Ok(mut guard) = pending.detect_installed.lock() {
                if let Some(tx) = guard.take() {
                    let _ = tx.send(Ok(resp));
                }
            }
        }
        MaestroRpcMessage::Response(ServerResponse::DetectProjectAgentsOk(resp)) => {
            if let Ok(mut guard) = pending.detect_project.lock() {
                if let Some(tx) = guard.take() {
                    let _ = tx.send(Ok(resp));
                }
            }
        }
        MaestroRpcMessage::Response(ServerResponse::PreInitializeOk(resp)) => {
            let tx = pending.pre_init
                .lock()
                .ok()
                .and_then(|mut map| map.remove(&resp.agent_id));
            if let Some(tx) = tx {
                let _ = tx.send(Ok(resp));
            }
        }
        MaestroRpcMessage::Response(ServerResponse::AgentConnectionLost(lost)) => {
            let mut task_ids: Vec<i32> = Vec::new();
            for session_id_str in &lost.affected_session_ids {
                if let Some(log_id) = log_id_from_session_id(session_id_str) {
                    let tid = {
                        let sessions = app_state.acp.sessions.lock().await;
                        sessions.get(&log_id).and_then(|s| s.task_id)
                    };
                    if let Some(tid) = tid {
                        task_ids.push(tid);
                    }
                    app_state.acp.sessions.lock().await.remove(&log_id);
                    let _ = app_handle.emit(&format!("acp://session-ended/{}", log_id), ());
                }
            }
            for tid in task_ids {
                try_complete_task(app_state, tid).await;
            }
            if !lost.affected_session_ids.is_empty() {
                app_state.app_handle.emit("tasks-changed", ()).ok();
            }
            app_state.app_handle.emit("sessions-changed", ()).ok();
        }
        MaestroRpcMessage::Response(ServerResponse::FileSearchOk(FileSearchResponse { files })) => {
            // Deliver to the first connection session that has a pending file search.
            let sessions = app_state.acp.sessions.lock().await;
            for (_, session) in sessions.iter().filter(|(_, s)| s.connection_key == connection_key) {
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
            for (_, session) in sessions.iter().filter(|(_, s)| s.connection_key == connection_key) {
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
            // Try pending session ops first, then file ops, then PreInitialize, then emit globally.
            let mut resolved = false;

            // Pending SessionList / SessionClose / CheckTools
            if !resolved {
                if let Ok(mut guard) = pending.session_list.lock() {
                    if guard.is_some() {
                        if let Some(tx) = guard.take() {
                            let _ = tx.send(Err(err.message.clone()));
                        }
                        resolved = true;
                    }
                }
            }
            if !resolved {
                if let Ok(mut guard) = pending.session_close.lock() {
                    if guard.is_some() {
                        if let Some(tx) = guard.take() {
                            let _ = tx.send(Err(err.message.clone()));
                        }
                        resolved = true;
                    }
                }
            }
            if !resolved {
                if let Ok(mut guard) = pending.check_tools.lock() {
                    if guard.is_some() {
                        if let Some(tx) = guard.take() {
                            let _ = tx.send(Err(err.message.clone()));
                        }
                        resolved = true;
                    }
                }
            }
            if !resolved {
                if let Ok(mut guard) = pending.detect_installed.lock() {
                    if guard.is_some() {
                        if let Some(tx) = guard.take() {
                            let _ = tx.send(Err(err.message.clone()));
                        }
                        resolved = true;
                    }
                }
            }
            if !resolved {
                if let Ok(mut guard) = pending.detect_project.lock() {
                    if guard.is_some() {
                        if let Some(tx) = guard.take() {
                            let _ = tx.send(Err(err.message.clone()));
                        }
                        resolved = true;
                    }
                }
            }

            if !resolved {
                let sessions = app_state.acp.sessions.lock().await;
                'outer: for (_, session) in
                    sessions.iter().filter(|(_, s)| s.connection_key == connection_key)
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
                // Try pending ListAgents.
                if let Ok(mut guard) = pending.list_agents.lock() {
                    if let Some(tx) = guard.take() {
                        let _ = tx.send(Err(err.message.clone()));
                        resolved = true;
                    }
                }
            }
            if !resolved {
                // Try pending PreInitialize.
                let pre_init_tx = pending.pre_init.lock().ok().and_then(|mut map| {
                    let key = map.keys().next().cloned()?;
                    map.remove(&key)
                });
                if let Some(tx) = pre_init_tx {
                    let _ = tx.send(Err(err.message));
                } else {
                    // Emit as session-error for all connection sessions.
                    let log_ids: Vec<i32> = {
                        let sessions = app_state.acp.sessions.lock().await;
                        sessions
                            .iter()
                            .filter(|(_, s)| s.connection_key == connection_key)
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
    source: AcpReadSource,
    connection_key: crate::acp::ConnectionKey,
    app_handle: tauri::AppHandle,
    app_state: Arc<crate::core::AppState>,
    pending: PendingChannels,
) {
    tokio::spawn(async move {
        let mut source = source;
        while let Some(msg) = source.next_message().await {
            handle_shared_server_message(
                msg,
                connection_key,
                &app_handle,
                &app_state,
                &pending,
            )
            .await;
        }

        // Server process died — clean up all shared sessions for this connection.
        app_state.acp.connection_servers.lock().await.remove(&connection_key);

        // Pool entries are pre-warmed sessions with no user work — exclude them from the
        // restorable list so they are not reloaded after reconnect. The pool is also cleared
        // for this connection so stale entries don't linger; it replenishes naturally after restore.
        let pool_log_ids: std::collections::HashSet<i32> = {
            let sessions = app_state.acp.sessions.lock().await;
            let connection_log_ids: std::collections::HashSet<i32> = sessions
                .iter()
                .filter(|(_, s)| s.connection_key == connection_key)
                .map(|(id, _)| *id)
                .collect();
            drop(sessions);
            let mut pool = app_state.acp.session_pool.lock().await;
            let ids: std::collections::HashSet<i32> = pool
                .values()
                .filter(|p| connection_log_ids.contains(&p.log_id))
                .map(|p| p.log_id)
                .collect();
            pool.retain(|_, p| !ids.contains(&p.log_id));
            ids
        };

        // Snapshot restorable metadata before removing sessions from the map.
        // Sessions without an acp_session_id haven't received SpawnOk yet and cannot
        // be restored — emit session-ended for those immediately.
        // Pool sessions (pre-warmed, no user work) are silently dropped.
        // Collect task_ids for sessions that will end now (not parked for SSH restore).
        let (to_restore, to_end_now, end_now_task_ids): (Vec<RestorableSession>, Vec<i32>, Vec<i32>) = {
            let sessions = app_state.acp.sessions.lock().await;
            let mut restorable: Vec<RestorableSession> = Vec::new();
            let mut unrestorable: Vec<i32> = Vec::new();
            let mut task_ids: Vec<i32> = Vec::new();
            let is_ssh = matches!(connection_key, crate::acp::ConnectionKey::Ssh { .. });
            for (log_id, s) in sessions.iter().filter(|(_, s)| s.connection_key == connection_key) {
                if pool_log_ids.contains(log_id) {
                    continue;
                }
                let acp_session_id = s.acp_session_id.lock().ok().and_then(|g| g.clone());
                if acp_session_id.is_some() && is_ssh {
                    restorable.push(RestorableSession {
                        log_id: *log_id,
                        agent_id: s.agent_id_meta.clone(),
                        acp_session_id,
                        cwd: s.cwd.clone(),
                        session_name: s.session_name.clone(),
                        project_id: s.project_id,
                        task_id: s.task_id,
                    });
                } else {
                    unrestorable.push(*log_id);
                    if let Some(tid) = s.task_id {
                        task_ids.push(tid);
                    }
                }
            }
            (restorable, unrestorable, task_ids)
        };

        // Remove all affected sessions from the map (including pool entries).
        {
            let mut sessions = app_state.acp.sessions.lock().await;
            for s in &to_restore {
                sessions.remove(&s.log_id);
            }
            for log_id in &to_end_now {
                sessions.remove(log_id);
            }
            for log_id in &pool_log_ids {
                sessions.remove(log_id);
            }
        }

        // Immediately end unrestorable sessions (no acp_session_id yet, or non-SSH).
        for log_id in &to_end_now {
            let _ = app_handle.emit(&format!("acp://session-ended/{}", log_id), ());
        }
        for tid in &end_now_task_ids {
            try_complete_task(&app_state, *tid).await;
        }

        // SSH connections only: park restorable sessions for the reconnect handler.
        // Local and WSL have no reconnect path — end immediately.
        match &connection_key {
            crate::acp::ConnectionKey::Ssh { id: conn_id } if !to_restore.is_empty() => {
                app_state.acp.restorable_sessions.lock().await.insert(*conn_id, to_restore);
            }
            _ => {
                for s in &to_restore {
                    let _ = app_handle.emit(&format!("acp://session-ended/{}", s.log_id), ());
                }
            }
        }
        if !end_now_task_ids.is_empty() {
            app_state.app_handle.emit("tasks-changed", ()).ok();
        }

        app_state.app_handle.emit("sessions-changed", ()).ok();
    });
}

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
    {
        let mut guard = pending.lock().map_err(|e| format!("Lock poisoned: {}", e))?;
        if guard.is_some() {
            return Err(already_in_progress_err.to_string());
        }
        *guard = Some(tx);
    }
    let bytes = serialize_message(&request)?;
    writer_tx.send(bytes).await.map_err(|_| "Connection server writer channel closed".to_string())?;
    tokio::time::timeout(std::time::Duration::from_secs(timeout_secs), rx)
        .await
        .map_err(|_| timeout_err.to_string())?
        .map_err(|_| "Response channel dropped".to_string())?
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

/// Wrap a subprocess's stdin in an mpsc channel so multiple senders can write to it.
/// Returns the sender end; the write task runs until the channel is dropped.
fn spawn_stdin_writer_task(mut stdin_writer: BufWriter<ChildStdin>) -> tokio::sync::mpsc::Sender<Vec<u8>> {
    let (write_tx, mut write_rx) = tokio::sync::mpsc::channel::<Vec<u8>>(32);
    tokio::spawn(async move {
        while let Some(bytes) = write_rx.recv().await {
            if stdin_writer.write_all(&bytes).await.is_err() {
                break;
            }
            let _ = stdin_writer.flush().await;
        }
    });
    write_tx
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

    let connection_server = ConnectionServer {
        child,
        writer_tx: write_tx,
        pending: pending.clone(),
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

    // Populate agent-level catalog cache from the warm session's models/modes/capabilities.
    // session_capabilities are not provided by PreInitialize (no SpawnOk), so they are
    // left at default until the first SpawnOk/SessionLoadOk updates the cache entry.
    if response.models.is_some() || response.modes.is_some() || response.prompt_capabilities.is_some() {
        let mut cache_entry = AgentCache::default();
        if let Some(m) = &response.models {
            upsert_catalog_option(&mut cache_entry.config_options, model_state_to_catalog_option(m));
        }
        if let Some(m) = &response.modes {
            upsert_catalog_option(&mut cache_entry.config_options, mode_state_to_catalog_option(m));
        }
        if let Some(c) = &response.prompt_capabilities {
            cache_entry.prompt_capabilities = Some(c.clone());
        }
        app_state
            .acp
            .agent_cache
            .lock()
            .await
            .insert((connection_key, agent_id.to_string()), cache_entry);
        let mut event_payload = serde_json::to_value(&connection_key).unwrap_or_default();
        event_payload["agent_id"] = serde_json::json!(agent_id);
        app_state.app_handle.emit("agent-cache-updated", event_payload).ok();
    }

    Ok(response)
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
    use crate::acp::transport::SessionLoadRequest;
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
    emit_cached_capabilities(&acp_process, req.connection_key, &req.agent_id, req.log_id, &req.app_state).await;
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
