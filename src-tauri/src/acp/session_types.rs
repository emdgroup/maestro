//! Core ACP session and transport data types.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use tokio::io::BufWriter;
use tokio::process::{Child, ChildStdin};
use tokio::sync::oneshot;
use crate::acp::transport::{PreInitializeResponse, SessionListOkResponse, CheckToolsResponse};
use crate::acp::canvas::{PreambleFilterState, CanvasFenceExtractor};
use maestro_protocol::{DetectInstalledAgentsResponse, DetectProjectAgentsResponse};

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
    Local(Arc<tokio::sync::Mutex<BufWriter<ChildStdin>>>),
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
    /// Unix timestamp (seconds) of the last `Ping` received from maestro-server.
    /// Zero until the first ping arrives. Checked by the heartbeat watchdog.
    pub last_ping_at: Arc<std::sync::atomic::AtomicU64>,
}

/// Session capability flags reported by the agent on SpawnOk.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct SessionCapabilitiesInfo {
    pub supports_session_list: bool,
    pub supports_session_load: bool,
    pub supports_session_close: bool,
}

/// Describes where to open a new maestro-server connection: local subprocess, remote SSH channel, or WSL distro.
pub enum TransportTarget<'a> {
    Local,
    Remote { ssh: &'a crate::connectivity::ssh::RemoteSshSession, server_path: &'a str },
    /// WSL distro: spawns `wsl.exe -d <distro> -- <server_path>`.
    /// Uses the same read/write types as Local (wsl.exe is a local subprocess).
    #[cfg(windows)]
    Wsl { distro: &'a str, server_path: &'a str },
    /// Container: spawns `<cli> exec -i <container_name> bash -lc <server_path>`.
    /// Cross-platform (no #[cfg] needed). Same subprocess transport types as Local.
    Docker {
        cli: &'a crate::connectivity::docker::ContainerCli,
        container_name: &'a str,
        server_path: &'a str,
    },
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
    pub current_model_id: Arc<std::sync::Mutex<Option<String>>>,
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
    /// Set to `true` once the rendering preamble has been confirmed present in this
    /// session's history — either detected in an incoming `user_message` / `user_message_chunk`
    /// or still `false` meaning the preamble should be injected on the next outgoing prompt.
    pub preamble_injected: Arc<AtomicBool>,
    /// State machine used to strip the preamble from streamed `user_message_chunk` events
    /// during session replay. Only active while `preamble_injected` is `false`.
    pub preamble_filter: Arc<std::sync::Mutex<PreambleFilterState>>,
    /// Extracts `maestro-canvas` code fences from `agent_message_chunk` text and emits
    /// them as synthetic canvas session updates.
    pub canvas_extractor: Arc<std::sync::Mutex<CanvasFenceExtractor>>,
    /// Session capability flags from SpawnOk. Used by get_active_sessions.
    pub session_capabilities: SessionCapabilitiesInfo,
    /// Raw config_options catalog from SpawnOk/SessionLoadOk/config updates.
    /// Used by emit_init_events_from_session to re-emit model/mode events during replay drain.
    pub config_options: Vec<serde_json::Value>,
    /// Set while a `RequestPermission` is outstanding on this session's shared Claude Code
    /// connection. Prevents new sessions from joining the same connection until resolved.
    pub has_pending_permission: Arc<AtomicBool>,
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
    pub preamble_injected: Arc<AtomicBool>,
    pub preamble_filter: Arc<std::sync::Mutex<PreambleFilterState>>,
    pub canvas_extractor: Arc<std::sync::Mutex<CanvasFenceExtractor>>,
    pub session_name: Option<String>,
    pub agent_id: String,
    pub project_id: Option<i32>,
    pub task_id: Option<i32>,
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
        let preamble_injected = Arc::new(AtomicBool::new(false));
        let preamble_filter = Arc::new(std::sync::Mutex::new(PreambleFilterState::Watching));
        let canvas_extractor = Arc::new(std::sync::Mutex::new(CanvasFenceExtractor::new()));
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
            preamble_injected: Arc::clone(&preamble_injected),
            preamble_filter: Arc::clone(&preamble_filter),
            canvas_extractor: Arc::clone(&canvas_extractor),
            session_name: params.session_name.clone(),
            agent_id: params.agent_id.clone(),
            project_id: params.project_id,
            task_id: params.task.task_id,
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
            preamble_injected,
            preamble_filter,
            canvas_extractor,
            session_capabilities: SessionCapabilitiesInfo::default(),
            config_options: Vec::new(),
            has_pending_permission: Arc::new(AtomicBool::new(false)),
        };
        (process, ctx)
    }
}
