use serde::{Deserialize, Serialize};
use specta::Type;

/// Path template for agent-created worktrees inside project root
pub const WORKTREE_DIR: &str = ".maestro/worktrees";
pub const WORKTREE_PATH_PREFIX: &str = ".maestro/worktrees/task-";

/// Build the relative worktree path for a given task ID
pub fn worktree_path_for_task(task_id: i32) -> String {
    format!("{}{}", WORKTREE_PATH_PREFIX, task_id)
}

/// Ahead/behind commit counts relative to the upstream tracking branch
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
    pub diff_stat: Option<String>,       // raw output of `git diff --shortstat`; None if clean
    pub base_branch: Option<String>,     // origin branch persisted at worktree creation time
    pub ahead_behind: Option<AheadBehind>, // ahead/behind counts vs upstream tracking branch
}

/// How a session is executed: via the Agent Control Protocol or a raw PTY.
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
    pub supports_session_list: bool,
    pub supports_session_load: bool,
    pub supports_session_close: bool,
    pub project_id: Option<i32>,
}

/// TS-exportable version of maestro_protocol::SessionListEntry (protocol crate doesn't derive Type)
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct SessionListEntryDto {
    pub session_id: String,
    pub title: Option<String>,
    pub updated_at: Option<String>,
}

/// Metadata stored alongside a PTY session for get_active_sessions
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
