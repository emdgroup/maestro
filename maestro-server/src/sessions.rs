use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{mpsc, oneshot, Mutex, Notify, RwLock};

use agent_client_protocol as acp;
use maestro_protocol::PromptCapabilitiesInfo;

pub enum SessionCommand {
    Prompt(String),
    PromptStructured(Vec<serde_json::Value>),
    SetModel(String),
    SetMode(String),
    SetConfigOption { config_id: String, value: String },
    CancelTurn,
    CloseSession,
}

pub struct TerminalHandle {
    pub output_buf: Arc<Mutex<String>>,
    pub output_byte_limit: Option<u64>,
    pub exit_status: Arc<Mutex<Option<TerminalExitInfo>>>,
    pub exit_notify: Arc<Notify>,
    pub kill_tx: Mutex<Option<oneshot::Sender<()>>>,
}

pub struct TerminalExitInfo {
    pub exit_code: Option<u32>,
    pub signal: Option<String>,
}

/// Per-session state accessed from shared connection handlers via the router.
pub struct SharedSessionState {
    pub pending_permissions: Arc<Mutex<HashMap<String, oneshot::Sender<Option<String>>>>>,
    pub pending_elicitations: Arc<Mutex<HashMap<String, oneshot::Sender<serde_json::Value>>>>,
}

/// Routes ACP session IDs → maestro session IDs → per-session state.
/// Used by shared connection handlers to dispatch to the right session.
#[derive(Default)]
pub struct SessionRouter {
    /// acp_session_id → maestro_session_id
    routes: RwLock<HashMap<String, String>>,
    /// maestro_session_id → per-session state
    state: RwLock<HashMap<String, Arc<SharedSessionState>>>,
}

impl SessionRouter {
    pub async fn register(
        &self,
        acp_session_id: String,
        maestro_session_id: String,
        session_state: Arc<SharedSessionState>,
    ) {
        self.routes
            .write()
            .await
            .insert(acp_session_id, maestro_session_id.clone());
        self.state
            .write()
            .await
            .insert(maestro_session_id, session_state);
    }

    pub async fn get_maestro_id(&self, acp_session_id: &str) -> Option<String> {
        self.routes.read().await.get(acp_session_id).cloned()
    }

    pub async fn unregister(&self, acp_session_id: &str) {
        if let Some(maestro_id) = self.routes.write().await.remove(acp_session_id) {
            self.state.write().await.remove(&maestro_id);
        }
    }

    /// Returns `(maestro_session_id, state)` for a given ACP session ID.
    pub async fn get_session(
        &self,
        acp_session_id: &str,
    ) -> Option<(String, Arc<SharedSessionState>)> {
        let routes = self.routes.read().await;
        let maestro_id = routes.get(acp_session_id)?.clone();
        drop(routes);
        let state = self.state.read().await.get(&maestro_id)?.clone();
        Some((maestro_id, state))
    }

    /// True if any session in this router has outstanding permission requests.
    pub async fn has_pending_permissions(&self) -> bool {
        let state = self.state.read().await;
        for s in state.values() {
            if !s.pending_permissions.lock().await.is_empty() {
                return true;
            }
        }
        false
    }

    /// True if no sessions are registered in this router.
    pub async fn is_empty(&self) -> bool {
        self.state.read().await.is_empty()
    }

    /// True if the given ACP session ID is registered. Safe to call while holding another lock
    /// since it uses try_read (non-blocking). Returns false if the routes lock is contended.
    pub fn contains_acp_session(&self, acp_session_id: &str) -> bool {
        self.routes.try_read()
            .ok()
            .map(|routes| routes.contains_key(acp_session_id))
            .unwrap_or(false)
    }

}

#[derive(Clone)]
pub struct AgentCapabilities {
    pub prompt_capabilities: Option<PromptCapabilitiesInfo>,
    pub supports_session_list: bool,
    pub supports_session_load: bool,
    pub supports_session_close: bool,
}

/// Cloneable subset of `AgentConnection` used by spawned tasks that need to call ACP methods
/// without holding the agent_connections lock for the duration of the async operation.
pub struct AgentConnectionHandle {
    pub connection: acp::ConnectionTo<acp::Agent>,
    pub router: Arc<SessionRouter>,
    pub capabilities: AgentCapabilities,
}

impl From<&AgentConnection> for AgentConnectionHandle {
    fn from(conn: &AgentConnection) -> Self {
        Self {
            connection: conn.connection.clone(),
            router: Arc::clone(&conn.router),
            capabilities: conn.capabilities.clone(),
        }
    }
}

/// A long-lived agent process shared across multiple sessions.
pub struct AgentConnection {
    pub connection: acp::ConnectionTo<acp::Agent>,
    pub router: Arc<SessionRouter>,
    pub capabilities: AgentCapabilities,
    /// Dropping this signals the background task to exit and kill the child process.
    _shutdown_tx: oneshot::Sender<()>,
    /// JoinHandle for the background ACP transport task. `is_finished()` = agent process died.
    pub connection_task: tokio::task::JoinHandle<()>,
}

impl AgentConnection {
    pub fn new(
        connection: acp::ConnectionTo<acp::Agent>,
        router: Arc<SessionRouter>,
        capabilities: AgentCapabilities,
        shutdown_tx: oneshot::Sender<()>,
        connection_task: tokio::task::JoinHandle<()>,
    ) -> Self {
        Self {
            connection,
            router,
            capabilities,
            _shutdown_tx: shutdown_tx,
            connection_task,
        }
    }
}

/// Cleanup metadata for fast-path (shared connection server) sessions.
/// Used by the Cancel handler to gracefully close the session on the agent side.
pub struct SessionCleanup {
    pub acp_session_id: String,
    pub router: Arc<SessionRouter>,
}

pub struct ActiveSession {
    pub cmd_tx: mpsc::Sender<SessionCommand>,
    pub pending_permissions: Arc<Mutex<HashMap<String, oneshot::Sender<Option<String>>>>>,
    pub pending_elicitations: Arc<Mutex<HashMap<String, oneshot::Sender<serde_json::Value>>>>,
    pub task: tokio::task::JoinHandle<()>,
    /// Populated for fast-path sessions (shared connection server).
    /// `None` for cold-path sessions (process killed by kill_on_drop on cancel).
    pub cleanup: Option<SessionCleanup>,
    /// Agent that owns this session — used to find sessions when restarting a dead agent.
    pub agent_id: String,
    /// Working directory this session was started in.
    pub cwd: String,
}

pub type SessionMap = HashMap<String, ActiveSession>;
pub type AgentConnectionMap = HashMap<String, Vec<AgentConnection>>;
pub type SharedAgentConnections = Arc<tokio::sync::Mutex<AgentConnectionMap>>;
