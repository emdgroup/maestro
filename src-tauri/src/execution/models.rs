use serde::{Deserialize, Serialize};
use specta::Type;

/// Session kind: an ACP-managed AI agent or a user-controlled PTY shell.
///
/// The serialized `pty` name is retained for IPC compatibility.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[specta(export)]
#[serde(rename_all = "lowercase")]
pub enum ExecutionMode {
    Acp,
    Pty,
}

/// Active session info — in-memory only, returned by get_active_sessions
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct ActiveSessionInfo {
    pub session_id: String,
    pub session_name: Option<String>,
    pub agent_id: Option<String>,
    pub execution_mode: ExecutionMode,
    pub started_at: String,
    pub task_id: Option<i32>,
    pub task_name: Option<String>,
    /// Which pipeline role this session runs, for a session started from a task. `None` for an
    /// ad-hoc session, and for every PTY shell.
    pub task_role: Option<crate::project::profiles::SessionRole>,
    pub branch_name: Option<String>,
    pub acp_session_id: Option<String>,
    /// The directory the session runs in. Carried so a view can tell which worktree a session is
    /// working in — `branch_name` cannot, since several worktrees may share a branch name's shape
    /// and a detached one has none.
    pub cwd: String,
    pub supports_session_list: bool,
    pub supports_session_load: bool,
    pub supports_session_close: bool,
    pub supports_session_delete: bool,
    pub project_id: Option<i32>,
}

/// Return type for `list_acp_sessions` — includes capability flags from the live agent connection.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct SessionListResult {
    pub sessions: Vec<SessionListEntryDto>,
    pub supports_session_delete: bool,
}

/// TS-exportable version of maestro_protocol::SessionListEntry (protocol crate doesn't derive Type)
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct SessionListEntryDto {
    pub session_id: String,
    pub title: Option<String>,
    pub updated_at: Option<String>,
    /// Directory the session ran in, relative to the project root, from the daemon's row for it.
    /// `Some("")` is the project root itself; `None` means no folder was ever recorded.
    pub folder: Option<String>,
}

/// Metadata stored alongside a user-controlled PTY shell for get_active_sessions.
#[derive(Debug, Clone)]
pub struct PtySessionMeta {
    pub session_name: Option<String>,
    pub started_at: String,
    pub task_id: Option<i32>,
    pub task_name: Option<String>,
    pub branch_name: Option<String>,
    pub cwd: String,
    pub project_id: Option<i32>,
}
