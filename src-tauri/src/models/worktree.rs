use serde::{Deserialize, Serialize};
use specta::Type;

/// Path template for agent-created worktrees inside project root
pub const WORKTREE_DIR: &str = ".maestro/worktrees";
pub const WORKTREE_PATH_PREFIX: &str = ".maestro/worktrees/task-";

/// Build the relative worktree path for a given task ID
pub fn worktree_path_for_task(task_id: i32) -> String {
    format!("{}{}", WORKTREE_PATH_PREFIX, task_id)
}

/// Worktree record from database (schema v3)
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct Worktree {
    pub id: i32,
    pub project_id: i32,
    pub task_id: Option<i32>,       // nullable — None for manually created worktrees
    pub branch_name: String,
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
    pub git_status: String,              // raw porcelain string; empty string if clean
    pub created_at: Option<String>,
    pub task_name: Option<String>,       // from tasks table join
    pub agent_status: Option<String>,    // from execution_logs.status join
    pub is_zombie: bool,                 // task_id IS NULL AND path matches agent convention
    pub is_orphan: bool,                 // on-disk but not in DB
}

/// View model for the Agents view — execution log enriched with task and worktree info
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct ExecutionWithTask {
    pub id: i32,
    pub task_id: i32,
    pub task_name: String,
    pub branch_name: Option<String>,     // from worktrees table join
    pub status: String,                  // execution status as string
    pub started_at: String,
    pub completed_at: Option<String>,
    pub terminal_output: Option<String>,
}
