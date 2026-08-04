//! Core ACP session and transport data types.

use crate::acp::canvas::CanvasFenceExtractor;
use crate::acp::transport::{
    CheckToolsResponse, PreInitializeResponse, PromptCapabilitiesInfo, SessionListOkResponse, ToolCheckResult,
};
use maestro_protocol::{
    DetectInstalledAgentsResponse, DetectProjectAgentsResponse, InstallSkillsResponse,
};
use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use tokio::io::BufWriter;
use tokio::process::{Child, ChildStdin};
use tokio::sync::oneshot;

/// Reply slot for a request that can only be in flight one at a time.
/// `None` means no request is outstanding.
pub type PendingReply<T> = Arc<std::sync::Mutex<Option<oneshot::Sender<Result<T, String>>>>>;

/// Reply slots for requests that can be in flight concurrently, keyed by request id.
pub type PendingReplyMap<T> =
    Arc<std::sync::Mutex<HashMap<String, oneshot::Sender<Result<T, String>>>>>;

/// Session-update payloads held until the frontend listener registers and drains them.
///
/// Stored pre-serialized rather than as `serde_json::Value`: nothing reads a payload while it
/// is buffered — `drain_acp_replay` only re-emits it — and a parsed `Value` tree costs several
/// times the raw JSON it was built from. A replayed session buffers its entire transcript, so
/// that multiplier is the difference between a few MB and tens of MB per unopened session.
pub type ReplayBuffer = Arc<std::sync::Mutex<Option<Vec<Box<serde_json::value::RawValue>>>>>;

/// Single authentication method exposed to the frontend.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AuthMethodDto {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub method_type: String,
    #[serde(default)]
    pub args: Vec<String>,
}

/// Authentication state for a pre-initialized agent connection.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentAuthInfo {
    pub auth_methods: Vec<AuthMethodDto>,
    pub supports_logout: bool,
    pub authenticated: bool,
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
    pub pre_init: PendingReplyMap<PreInitializeResponse>,
    pub list_agents: PendingReply<Vec<crate::acp::registry::DiscoveredAgent>>,
    pub session_list: PendingReply<SessionListOkResponse>,
    pub session_close: PendingReply<()>,
    pub session_delete: PendingReply<()>,
    pub check_tools: PendingReply<CheckToolsResponse>,
    pub set_tool_path: PendingReply<ToolCheckResult>,
    pub test_tool_path: PendingReply<ToolCheckResult>,
    pub install_skills: PendingReply<InstallSkillsResponse>,
    pub detect_installed: PendingReply<DetectInstalledAgentsResponse>,
    pub detect_project: PendingReply<DetectProjectAgentsResponse>,
    pub authenticate: PendingReply<()>,
    pub logout: PendingReply<()>,
}

impl Default for PendingChannels {
    fn default() -> Self {
        Self::new()
    }
}

impl PendingChannels {
    pub fn new() -> Self {
        Self {
            pre_init: Arc::new(std::sync::Mutex::new(HashMap::new())),
            list_agents: Arc::new(std::sync::Mutex::new(None)),
            session_list: Arc::new(std::sync::Mutex::new(None)),
            session_close: Arc::new(std::sync::Mutex::new(None)),
            session_delete: Arc::new(std::sync::Mutex::new(None)),
            check_tools: Arc::new(std::sync::Mutex::new(None)),
            set_tool_path: Arc::new(std::sync::Mutex::new(None)),
            test_tool_path: Arc::new(std::sync::Mutex::new(None)),
            install_skills: Arc::new(std::sync::Mutex::new(None)),
            detect_installed: Arc::new(std::sync::Mutex::new(None)),
            detect_project: Arc::new(std::sync::Mutex::new(None)),
            authenticate: Arc::new(std::sync::Mutex::new(None)),
            logout: Arc::new(std::sync::Mutex::new(None)),
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
    pub supports_session_delete: bool,
}

/// Describes where to open a new maestro-server connection: local subprocess, remote SSH channel, or WSL distro.
pub enum TransportTarget<'a> {
    Local,
    Remote {
        ssh: &'a crate::connectivity::ssh::RemoteSshSession,
        server_path: &'a str,
    },
    /// WSL distro: spawns `wsl.exe -d <distro> -- <server_path>`.
    /// Uses the same read/write types as Local (wsl.exe is a local subprocess).
    #[cfg(windows)]
    Wsl {
        distro: &'a str,
        server_path: &'a str,
    },
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
    pub pending_file_search: PendingReply<Vec<String>>,
    /// Pending file read response channel. One request at a time.
    pub pending_file_read: PendingReply<String>,
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
    pub replay_buffer: ReplayBuffer,
    /// Set to `true` when SpawnOk or SessionLoadOk is received. Used by drain to avoid
    /// emitting `replay-drained` before the session is ready (empty buffer race).
    pub initialized: Arc<std::sync::Mutex<bool>>,
    /// Extracts `maestro-canvas` code fences from `agent_message_chunk` text and emits
    /// them as synthetic canvas session updates.
    pub canvas_extractor: Arc<std::sync::Mutex<CanvasFenceExtractor>>,
    /// Strips the completion marker from `agent_message_chunk` text and reports when the agent
    /// declares the task done.
    pub completion_filter: Arc<std::sync::Mutex<super::completion::CompletionMarkerFilter>>,
    /// Set when the agent emits the completion marker. Read and reset on each turn ending, so it
    /// only applies to the turn it appeared in.
    pub declared_complete: Arc<AtomicBool>,
    /// Session capability flags from SpawnOk. Used by get_active_sessions.
    pub session_capabilities: SessionCapabilitiesInfo,
    /// Raw config_options catalog from SpawnOk/SessionLoadOk/config updates.
    /// Used by emit_init_events_from_session to re-emit model/mode events during replay drain.
    pub config_options: Vec<serde_json::Value>,
    /// Prompt content supported by the agent. Re-emitted when the frontend mounts after SpawnOk.
    pub prompt_capabilities: Option<PromptCapabilitiesInfo>,
    /// Set while a `RequestPermission` is outstanding on this session's shared Claude Code
    /// connection. Prevents new sessions from joining the same connection until resolved.
    pub has_pending_permission: Arc<AtomicBool>,
}

#[derive(Default)]
pub struct TaskMetadata {
    pub task_id: Option<i32>,
    pub task_name: Option<String>,
    pub branch_name: Option<String>,
    pub session_start_sha: Option<String>,
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
    pub pending_file_search: PendingReply<Vec<String>>,
    pub pending_file_read: PendingReply<String>,
    pub acp_session_id_cache: Arc<std::sync::Mutex<Option<String>>>,
    pub replay_buffer: ReplayBuffer,
    pub initialized: Arc<std::sync::Mutex<bool>>,
    pub canvas_extractor: Arc<std::sync::Mutex<CanvasFenceExtractor>>,
    pub completion_filter: Arc<std::sync::Mutex<super::completion::CompletionMarkerFilter>>,
    pub declared_complete: Arc<AtomicBool>,
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
        let replay_buffer = Arc::new(std::sync::Mutex::new(if params.enable_replay_buffer {
            Some(Vec::new())
        } else {
            None
        }));
        let initialized = Arc::new(std::sync::Mutex::new(false));
        let canvas_extractor = Arc::new(std::sync::Mutex::new(CanvasFenceExtractor::new()));
        let completion_filter = Arc::new(std::sync::Mutex::new(
            super::completion::CompletionMarkerFilter::new(),
        ));
        let declared_complete = Arc::new(AtomicBool::new(false));
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
            canvas_extractor: Arc::clone(&canvas_extractor),
            completion_filter: Arc::clone(&completion_filter),
            declared_complete: Arc::clone(&declared_complete),
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
            canvas_extractor,
            completion_filter,
            declared_complete,
            session_capabilities: SessionCapabilitiesInfo::default(),
            config_options: Vec::new(),
            prompt_capabilities: None,
            has_pending_permission: Arc::new(AtomicBool::new(false)),
        };
        (process, ctx)
    }
}
