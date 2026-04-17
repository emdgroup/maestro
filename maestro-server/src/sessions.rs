use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use agent_client_protocol::ClientSideConnection;
use tokio::sync::oneshot;

/// Handle for a single managed terminal subprocess
pub struct TerminalHandle {
    /// Accumulated output for ACP terminal/output polling
    pub output_buf: Rc<RefCell<String>>,
    /// Output byte limit from CreateTerminalRequest (None = unlimited)
    pub output_byte_limit: Option<u64>,
    /// Exit status set when subprocess exits
    pub exit_status: Rc<RefCell<Option<TerminalExitInfo>>>,
    /// Kill signal — dropping sender kills the background reader task
    pub kill_tx: Option<oneshot::Sender<()>>,
}

/// Exit information for a completed terminal
pub struct TerminalExitInfo {
    pub exit_code: Option<u32>,
    pub signal: Option<String>,
}

/// A live ACP session: maps maestro session_id to ACP internals
pub struct ActiveSession {
    /// The ACP SDK connection to the agent subprocess
    pub conn: ClientSideConnection,
    /// ACP-assigned session ID (from NewSessionResponse)
    pub acp_session_id: agent_client_protocol::SessionId,
    /// Managed terminals for this session
    pub terminals: Rc<RefCell<HashMap<String, TerminalHandle>>>,
    /// Agent child process handle (held to keep kill_on_drop active)
    pub child: tokio::process::Child,
}

/// Map from maestro session_id (String) to ActiveSession
pub type SessionMap = HashMap<String, ActiveSession>;
