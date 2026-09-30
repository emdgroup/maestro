//! Core ACP session and transport data types.

use crate::acp::transport::{PromptCapabilitiesInfo, ServerResponse};
use maestro_protocol::RequestId;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use tokio::io::BufWriter;
use tokio::process::{Child, ChildStdin};
use tokio::sync::oneshot;

/// Reply slot for a request that can only be in flight one at a time.
/// `None` means no request is outstanding.
pub type PendingReply<T> = Arc<std::sync::Mutex<Option<oneshot::Sender<Result<T, String>>>>>;

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

/// A session that was active when an SSH connection's server was lost, parked until the
/// connection comes back or gives up.
///
/// Only what it takes to tell the frontend how it ended: the daemon's own rows are what brings the
/// conversation back.
pub struct RestorableSession {
    pub session_id: String,
    /// None when the session hadn't received SpawnOk yet, so the daemon has no row for it.
    pub acp_session_id: Option<String>,
    pub project_id: Option<i32>,
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

/// A request waiting for the reply that carries its id.
struct Waiter {
    /// Set for a request made on a session's behalf, so an error scoped to that session can fail it.
    session_id: Option<String>,
    sender: oneshot::Sender<Result<ServerResponse, String>>,
}

/// The requests one `ConnectionServer` has sent and not yet heard back on, keyed by the id the
/// server echoes on its reply. Clones share the same state, so the reader task holds one.
#[derive(Clone, Default)]
pub struct PendingRequests {
    next_id: Arc<AtomicU64>,
    waiting: Arc<std::sync::Mutex<HashMap<RequestId, Waiter>>>,
    /// The one request answered by type rather than by id: `TakeoverResultOk` is written by a
    /// timer or by another client's answer, neither of which knows the id that asked.
    takeover: Arc<std::sync::Mutex<Option<RequestId>>>,
    /// Why nothing registered from now on can be answered, set once the reader has ended. A
    /// caller that cloned this just before would otherwise register after `fail_all` had swept,
    /// and wait out its whole timeout on a connection that is gone.
    closed: Arc<std::sync::Mutex<Option<String>>>,
}

/// A poisoned lock here still guards a usable map, and refusing it would strand every waiter.
fn lock<T>(mutex: &std::sync::Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

impl PendingRequests {
    pub fn register(
        &self,
        session_id: Option<&str>,
    ) -> (RequestId, oneshot::Receiver<Result<ServerResponse, String>>) {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let (sender, receiver) = oneshot::channel();
        // Held across the insert so `fail_all` cannot sweep between the check and it.
        let closed = lock(&self.closed);
        if let Some(reason) = closed.as_ref() {
            if sender.send(Err(reason.clone())).is_err() {
                log::debug!("[acp] request {id} was dropped before it could be refused");
            }
            return (id, receiver);
        }
        lock(&self.waiting).insert(
            id,
            Waiter {
                session_id: session_id.map(str::to_owned),
                sender,
            },
        );
        (id, receiver)
    }

    /// Stop waiting on `id`, so a reply that still arrives is dropped instead of kept for nobody.
    pub fn forget(&self, id: RequestId) {
        lock(&self.waiting).remove(&id);
    }

    /// Hand `response` to the request it answers, an `Error` as that request's failure. Returns
    /// whether anything was still waiting on `id`.
    pub fn deliver(&self, id: RequestId, response: ServerResponse) -> bool {
        let Some(waiter) = lock(&self.waiting).remove(&id) else {
            return false;
        };
        let outcome = match response {
            ServerResponse::Error(error) => Err(error.message),
            other => Ok(other),
        };
        if waiter.sender.send(outcome).is_err() {
            log::debug!("[acp] request {id} gave up as its reply arrived");
        }
        true
    }

    /// Make `id` the request the next id-less `TakeoverResultOk` answers. Refused while an
    /// earlier takeover is still waiting, since the two replies could not be told apart.
    pub fn claim_takeover(&self, id: RequestId) -> bool {
        let mut takeover = lock(&self.takeover);
        if takeover.is_some_and(|held| lock(&self.waiting).contains_key(&held)) {
            return false;
        }
        *takeover = Some(id);
        true
    }

    pub fn deliver_takeover(&self, response: ServerResponse) {
        let claimed = lock(&self.takeover).take();
        if let Some(id) = claimed {
            self.deliver(id, response);
        }
    }

    pub fn fail_session(&self, session_id: &str, message: &str) {
        self.fail_where(message, |waiter| {
            waiter.session_id.as_deref() == Some(session_id)
        });
    }

    /// Fail everything waiting, and everything that registers afterwards.
    pub fn fail_all(&self, message: &str) {
        let mut closed = lock(&self.closed);
        *closed = Some(message.to_string());
        self.fail_where(message, |_| true);
    }

    fn fail_where(&self, message: &str, matches: impl Fn(&Waiter) -> bool) {
        let mut waiting = lock(&self.waiting);
        let ids: Vec<RequestId> = waiting
            .iter()
            .filter(|(_, waiter)| matches(waiter))
            .map(|(id, _)| *id)
            .collect();
        for id in ids {
            if let Some(waiter) = waiting.remove(&id) {
                if waiter.sender.send(Err(message.to_string())).is_err() {
                    log::debug!("[acp] request {id} gave up before it could be failed");
                }
            }
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
    pub pending: PendingRequests,
    /// Unix timestamp (seconds) of the last `Ping` received from maestro-server.
    /// Zero until the first ping arrives. Checked by the heartbeat watchdog.
    pub last_ping_at: Arc<std::sync::atomic::AtomicU64>,
    /// Signalled once by the reader when the pipe closes. What a deliberate stop waits on.
    pub ended: Arc<tokio::sync::Notify>,
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
/// Stored in `AppState.acp.sessions` keyed by session id.
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
    /// The role this session was spawned for. See `TaskMetadata::role`.
    pub task_role: Option<crate::project::profiles::SessionRole>,
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
    /// Strips the completion marker from `agent_message_chunk` text and reports when the agent
    /// declares the task done.
    pub completion_filter: Arc<std::sync::Mutex<super::completion::CompletionMarkerFilter>>,
    /// Set when the agent emits the completion marker. Read and reset on each turn ending, so it
    /// only applies to the turn it appeared in.
    pub declared_complete: Arc<AtomicBool>,
    /// Set when the user pressed stop on this session, and read and reset by the next turn ending.
    ///
    /// The stop reason cannot carry this: agents disagree about what an interrupted turn reports —
    /// some answer `cancelled`, some `end_turn` — and an `end_turn` from a coder that had already
    /// touched files reads as a finished phase, which hands the task straight to the next role. So
    /// the interrupt is recorded where it is known first-hand rather than inferred from the reply.
    pub user_interrupted: Arc<AtomicBool>,
    /// The agent's last run of prose before the turn ends, drained into the task's outcome thread.
    pub closing_message: Arc<std::sync::Mutex<super::completion::ClosingMessage>>,
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
    /// The last of this session's permission requests still being decided, see
    /// `reader_task::spawn_task_permission_request`.
    pub permission_queue: PermissionQueue,
}

/// The handling of a session's latest permission request, which the next one waits for so the
/// prompts reach the UI in the order the agent raised them.
pub type PermissionQueue = Arc<std::sync::Mutex<Option<tokio::task::JoinHandle<()>>>>;

/// A session's task as the daemon keys it: task ids are per project, so the number alone does not
/// name one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct TaskKey {
    pub project_id: i32,
    pub task_id: i32,
}

impl TaskKey {
    pub fn of(project_id: Option<i32>, task_id: Option<i32>) -> Option<Self> {
        Some(Self {
            project_id: project_id?,
            task_id: task_id?,
        })
    }
}

#[derive(Debug, Default, Clone, PartialEq)]
pub struct TaskMetadata {
    pub task_id: Option<i32>,
    pub task_name: Option<String>,
    pub branch_name: Option<String>,
    pub session_start_sha: Option<String>,
    /// Which pipeline stage started this session, recorded at spawn.
    ///
    /// Deriving it from the task's current `phase` instead would be wrong: nothing closes a
    /// finished coder's session when the reviewer starts, so two sessions of one task coexist and
    /// the phase describes only the later one.
    pub role: Option<crate::project::profiles::SessionRole>,
}

impl TaskMetadata {
    /// What the daemon stores against the conversation. A `None` here keeps what its row already
    /// holds, so a reload that knows less than the spawn did loses nothing.
    pub fn to_session_meta(&self, session_name: Option<String>) -> maestro_protocol::SessionMeta {
        maestro_protocol::SessionMeta {
            session_name,
            task_id: self.task_id,
            task_name: self.task_name.clone(),
            branch_name: self.branch_name.clone(),
            session_start_sha: self.session_start_sha.clone(),
            // The protocol carries the role as text so a new stage never touches it.
            role: self
                .role
                .as_ref()
                .and_then(|role| serde_json::to_string(role).ok()),
        }
    }

    pub fn from_session_meta(meta: &maestro_protocol::SessionMeta) -> Self {
        TaskMetadata {
            task_id: meta.task_id,
            task_name: meta.task_name.clone(),
            branch_name: meta.branch_name.clone(),
            session_start_sha: meta.session_start_sha.clone(),
            role: meta
                .role
                .as_deref()
                .and_then(|role| serde_json::from_str(role).ok()),
        }
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
    pub session_id: String,
    pub session_name: Option<String>,
    pub project_id: Option<i32>,
    pub app_state: Arc<crate::core::AppState>,
}

pub struct ReaderTaskContext {
    pub session_id: String,
    pub app_handle: tauri::AppHandle,
    pub app_state: Arc<crate::core::AppState>,
    pub current_model_id: Arc<std::sync::Mutex<Option<String>>>,
    pub current_mode_id: Arc<std::sync::Mutex<Option<String>>>,
    pub pending_file_search: PendingReply<Vec<String>>,
    pub pending_file_read: PendingReply<String>,
    pub acp_session_id_cache: Arc<std::sync::Mutex<Option<String>>>,
    pub replay_buffer: ReplayBuffer,
    pub initialized: Arc<std::sync::Mutex<bool>>,
    pub completion_filter: Arc<std::sync::Mutex<super::completion::CompletionMarkerFilter>>,
    pub declared_complete: Arc<AtomicBool>,
    pub user_interrupted: Arc<AtomicBool>,
    pub closing_message: Arc<std::sync::Mutex<super::completion::ClosingMessage>>,
    pub permission_queue: PermissionQueue,
    pub task: Option<TaskKey>,
}

impl AcpProcess {
    pub fn task_key(&self) -> Option<TaskKey> {
        TaskKey::of(self.project_id, self.task_id)
    }

    pub fn create(
        params: AcpProcessParams,
        session_id: String,
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
        let completion_filter = Arc::new(std::sync::Mutex::new(
            super::completion::CompletionMarkerFilter::new(),
        ));
        let declared_complete = Arc::new(AtomicBool::new(false));
        let user_interrupted = Arc::new(AtomicBool::new(false));
        let closing_message = Arc::new(std::sync::Mutex::new(
            super::completion::ClosingMessage::default(),
        ));
        let permission_queue = PermissionQueue::default();
        let ctx = ReaderTaskContext {
            session_id,
            app_handle,
            app_state,
            current_model_id: Arc::clone(&current_model_id),
            current_mode_id: Arc::clone(&current_mode_id),
            pending_file_search: Arc::clone(&pending_file_search),
            pending_file_read: Arc::clone(&pending_file_read),
            acp_session_id_cache: Arc::clone(&acp_session_id),
            replay_buffer: Arc::clone(&replay_buffer),
            initialized: Arc::clone(&initialized),
            completion_filter: Arc::clone(&completion_filter),
            declared_complete: Arc::clone(&declared_complete),
            user_interrupted: Arc::clone(&user_interrupted),
            closing_message: Arc::clone(&closing_message),
            permission_queue: Arc::clone(&permission_queue),
            task: TaskKey::of(params.project_id, params.task.task_id),
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
            task_role: params.task.role,
            branch_name: params.task.branch_name,
            session_start_sha: params.task.session_start_sha,
            acp_session_id,
            replay_buffer,
            initialized,
            completion_filter,
            declared_complete,
            user_interrupted,
            closing_message,
            session_capabilities: SessionCapabilitiesInfo::default(),
            config_options: Vec::new(),
            prompt_capabilities: None,
            has_pending_permission: Arc::new(AtomicBool::new(false)),
            permission_queue,
        };
        (process, ctx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::transport::ErrorResponse;

    fn error(message: &str) -> ServerResponse {
        ServerResponse::Error(ErrorResponse {
            message: message.to_string(),
            session_id: None,
        })
    }

    /// What the typed slots could not do: the second request of a type used to wait for the
    /// slot the first held, and an answer went to whichever of them happened to be in it.
    #[test]
    fn two_requests_of_one_type_are_answered_by_id() {
        let pending = PendingRequests::default();
        let (first, mut first_reply) = pending.register(None);
        let (second, mut second_reply) = pending.register(None);

        assert!(pending.deliver(second, ServerResponse::SessionCloseOk));
        assert!(
            first_reply.try_recv().is_err(),
            "the first is still waiting"
        );
        assert_eq!(
            second_reply.try_recv(),
            Ok(Ok(ServerResponse::SessionCloseOk))
        );

        assert!(pending.deliver(first, ServerResponse::SessionDeleteOk));
        assert_eq!(
            first_reply.try_recv(),
            Ok(Ok(ServerResponse::SessionDeleteOk))
        );
    }

    #[test]
    fn an_error_fails_only_the_request_it_names() {
        let pending = PendingRequests::default();
        let (refused, mut refused_reply) = pending.register(None);
        let (_other, mut other_reply) = pending.register(None);

        assert!(pending.deliver(refused, error("a run still going cannot be deleted")));

        assert_eq!(
            refused_reply.try_recv(),
            Ok(Err("a run still going cannot be deleted".to_string()))
        );
        assert!(other_reply.try_recv().is_err(), "the other is untouched");
    }

    #[test]
    fn a_reply_after_its_request_timed_out_is_dropped() {
        let pending = PendingRequests::default();
        let (id, _reply) = pending.register(None);
        pending.forget(id);

        assert!(!pending.deliver(id, ServerResponse::SessionCloseOk));
    }

    #[test]
    fn the_reader_ending_fails_everything_waiting() {
        let pending = PendingRequests::default();
        let (_first, mut first_reply) = pending.register(None);
        let (_second, mut second_reply) = pending.register(Some("session-1"));

        pending.fail_all("gone");

        assert_eq!(first_reply.try_recv(), Ok(Err("gone".to_string())));
        assert_eq!(second_reply.try_recv(), Ok(Err("gone".to_string())));

        let (_late, mut late_reply) = pending.register(None);
        assert_eq!(late_reply.try_recv(), Ok(Err("gone".to_string())));
    }

    #[test]
    fn a_session_error_fails_that_session_and_no_other() {
        let pending = PendingRequests::default();
        let (_mine, mut mine) = pending.register(Some("session-1"));
        let (_theirs, mut theirs) = pending.register(Some("session-2"));
        let (_unscoped, mut unscoped) = pending.register(None);

        pending.fail_session("session-1", "agent died");

        assert_eq!(mine.try_recv(), Ok(Err("agent died".to_string())));
        assert!(theirs.try_recv().is_err());
        assert!(unscoped.try_recv().is_err());
    }

    #[test]
    fn a_takeover_is_answered_without_an_id_and_only_one_waits_at_a_time() {
        let pending = PendingRequests::default();
        let (first, mut first_reply) = pending.register(None);
        let (second, _second_reply) = pending.register(None);
        let granted =
            || ServerResponse::TakeoverResultOk(maestro_protocol::TakeoverResult { granted: true });

        assert!(pending.claim_takeover(first));
        assert!(
            !pending.claim_takeover(second),
            "the first is still waiting"
        );

        pending.deliver_takeover(granted());
        assert_eq!(first_reply.try_recv(), Ok(Ok(granted())));
        assert!(pending.claim_takeover(second), "and then the next may ask");
    }

    /// The role crosses the protocol as text, and has to come back as the type it left as.
    #[test]
    fn task_metadata_survives_the_daemon_s_row() {
        let task = TaskMetadata {
            task_id: Some(7),
            task_name: Some("Fix the crash".to_string()),
            branch_name: Some("maestro/task-7".to_string()),
            session_start_sha: Some("abc123".to_string()),
            role: Some(crate::project::profiles::SessionRole {
                role: crate::project::profiles::AgentRole::Reviewer,
                profile_id: Some("strict".to_string()),
            }),
        };
        let meta = task.to_session_meta(Some("Review".to_string()));
        assert_eq!(meta.session_name.as_deref(), Some("Review"));
        assert_eq!(TaskMetadata::from_session_meta(&meta), task);
    }
}
