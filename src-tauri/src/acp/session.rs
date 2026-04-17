use serde::{Deserialize, Serialize};

/// Represents the current state of an ACP agent session.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum SessionState {
    /// Session spawned, waiting for agent initialization
    Initializing,
    /// Agent is running and processing
    Running,
    /// Agent is waiting for user input (permission, prompt)
    WaitingForInput,
    /// Session completed successfully
    Completed,
    /// Session failed with an error
    Failed(String),
    /// Session was cancelled by user
    Cancelled,
}

/// Desktop-side mirror of a remote ACP session.
/// Phase 42 stores these in AppState for UI consumption.
#[derive(Debug, Clone)]
pub struct AcpSession {
    /// Unique session identifier
    pub session_id: String,
    /// ACP agent identifier (e.g., "claude-acp", "gemini")
    pub agent_id: String,
    /// Working directory on the remote host
    pub cwd: String,
    /// Current session state
    pub state: SessionState,
}

impl AcpSession {
    pub fn new(session_id: String, agent_id: String, cwd: String) -> Self {
        Self {
            session_id,
            agent_id,
            cwd,
            state: SessionState::Initializing,
        }
    }
}
