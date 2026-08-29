use serde::{Deserialize, Serialize};
use specta::Type;

/// Path template for agent-created worktrees inside project root
pub const WORKTREE_DIR: &str = ".maestro/worktrees";
pub const WORKTREE_PATH_PREFIX: &str = ".maestro/worktrees/task-";
pub const WORKTREE_SESSION_PATH_PREFIX: &str = ".maestro/worktrees/session-";

/// Build the relative worktree path for a given task ID
pub fn worktree_path_for_task(task_id: i32) -> String {
    format!("{}{}", WORKTREE_PATH_PREFIX, task_id)
}

/// Build the relative worktree path for a session-owned worktree, keyed by its DB row id.
pub fn worktree_path_for_session(worktree_id: i32) -> String {
    format!("{}{}", WORKTREE_SESSION_PATH_PREFIX, worktree_id)
}

/// True when Maestro created this worktree itself rather than the user creating it by hand.
///
/// Rows written before the id-based session path existed use a branch-name-derived path and
/// therefore read as user-made. That is deliberate: automatic deletion is the destructive
/// direction, so an unrecognised path must fall on the "keep" side.
pub fn is_maestro_created_worktree(relative_path: &str) -> bool {
    relative_path.starts_with(WORKTREE_PATH_PREFIX)
        || relative_path.starts_with(WORKTREE_SESSION_PATH_PREFIX)
}

/// Ahead/behind commit counts relative to the upstream tracking branch.
///
/// Not against the base branch: a worktree's own commits are counted separately as
/// `WorktreeWithStatus::commit_count`, and these two answer different questions — how much work is
/// here, versus how much of it has reached the remote. `None` means there is no upstream at all,
/// which `DeleteWorktreeDialog` reads as "this branch exists only locally".
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct AheadBehind {
    pub ahead: u32,
    pub behind: u32,
}

/// Worktree record from database (schema v6)
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct Worktree {
    pub id: i32,
    pub project_id: i32,
    pub task_id: Option<i32>,       // nullable — None for manually created worktrees
    pub branch_name: String,
    pub base_branch: Option<String>, // origin branch this worktree was created from
    pub path: String,
    pub git_status: Option<String>, // raw git status --porcelain output
    pub created_at: String,
}

/// View model for the Worktrees view — enriched with task info and derived status fields
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct WorktreeWithStatus {
    pub id: Option<i32>,                 // None if orphan (on-disk but no DB row)
    pub project_id: Option<i32>,
    pub task_id: Option<i32>,
    pub branch_name: String,
    pub path: String,
    pub changed_files_count: u32,        // number of changed + untracked files; 0 if clean
    pub created_at: Option<String>,
    pub task_name: Option<String>,       // from tasks table join
    pub is_zombie: bool,                 // task_id IS NULL AND path matches agent convention
    pub is_orphan: bool,                 // on-disk but not in DB
    pub diff_stat: Option<String>,       // raw output of `git diff HEAD --shortstat`; None if clean
    pub base_branch: Option<String>,     // origin branch persisted at worktree creation time
    pub ahead_behind: Option<AheadBehind>, // ahead/behind counts vs upstream tracking branch
    /// Commits this worktree's branch has that its base branch does not — the work done here.
    /// `None` when there is no base branch to count against, or it no longer resolves.
    pub commit_count: Option<u32>,
    /// When anything last happened here, as RFC 3339: the newest modification time among the files
    /// git reports as changed, or the last commit's date when the working tree is clean.
    pub last_activity_at: Option<String>,
    /// The short sha HEAD points at when the worktree is not on a branch at all. `branch_name`
    /// still carries the name recorded at creation, because that is what branch operations need —
    /// but showing it would claim a branch that is not checked out.
    pub detached_at: Option<String>,
}

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
    pub session_key: i32,
    pub session_name: Option<String>,
    pub agent_id: Option<String>,
    pub execution_mode: ExecutionMode,
    pub started_at: String,
    pub task_id: Option<i32>,
    pub task_name: Option<String>,
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
    /// Directory the session ran in, relative to the project root, from `.maestro/state.json`.
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
