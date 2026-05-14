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

}

pub struct AgentCapabilities {
    pub prompt_capabilities: Option<PromptCapabilitiesInfo>,
    pub supports_session_list: bool,
    pub supports_session_load: bool,
    pub supports_session_close: bool,
}

/// A long-lived agent process shared across multiple sessions.
pub struct AgentConnection {
    pub connection: acp::ConnectionTo<acp::Agent>,
    pub router: Arc<SessionRouter>,
    pub capabilities: AgentCapabilities,
    /// Dropping this signals the background task to exit and kill the child process.
    _shutdown_tx: oneshot::Sender<()>,
}

impl AgentConnection {
    pub fn new(
        connection: acp::ConnectionTo<acp::Agent>,
        router: Arc<SessionRouter>,
        capabilities: AgentCapabilities,
        shutdown_tx: oneshot::Sender<()>,
    ) -> Self {
        Self {
            connection,
            router,
            capabilities,
            _shutdown_tx: shutdown_tx,
        }
    }
}

pub struct ActiveSession {
    pub cmd_tx: mpsc::Sender<SessionCommand>,
    pub pending_permissions: Arc<Mutex<HashMap<String, oneshot::Sender<Option<String>>>>>,
    pub pending_elicitations: Arc<Mutex<HashMap<String, oneshot::Sender<serde_json::Value>>>>,
    pub task: tokio::task::JoinHandle<()>,
}

pub type SessionMap = HashMap<String, ActiveSession>;
pub type AgentConnectionMap = HashMap<String, AgentConnection>;
