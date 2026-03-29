use std::sync::Arc;
use tauri::State;

use crate::models::Worktree;
use crate::db::AppState;

// NOTE: This file will be fully rewritten in Plan 03 (worktree IPC overhaul).
// All function bodies are stubbed with todo!() to keep cargo check green
// while models/worktree.rs is being migrated from pool-based to task-based design.

// ============================================================================
// Worktree Leasing (STUB — Plan 03 will rewrite)
// ============================================================================

#[tauri::command]
#[specta::specta]
pub async fn lease_worktree(
    _app_state: State<'_, Arc<AppState>>,
    _project_id: i32,
    _task_id: i32,
    _repo_path: String,
) -> Result<Worktree, String> {
    todo!("Plan 03 will rewrite lease_worktree with task-based worktree creation")
}

// ============================================================================
// Worktree Return (STUB — Plan 03 will rewrite)
// ============================================================================

#[tauri::command]
#[specta::specta]
pub fn return_worktree(
    _app_state: State<Arc<AppState>>,
    _worktree_id: i32,
) -> Result<(), String> {
    todo!("Plan 03 will rewrite return_worktree")
}

// ============================================================================
// Pool Status Monitoring (STUB — Plan 03 will rewrite)
// ============================================================================

// PoolStatus removed — replaced by WorktreeWithStatus view model

#[tauri::command]
#[specta::specta]
pub fn get_pool_status(
    _app_state: State<Arc<AppState>>,
    _project_id: i32,
) -> Result<Vec<crate::models::WorktreeWithStatus>, String> {
    todo!("Plan 03 will rewrite get_pool_status as get_worktrees_with_status")
}

// ============================================================================
// Worktree Cleanup (STUB — Plan 03 will rewrite)
// ============================================================================

#[tauri::command]
#[specta::specta]
pub async fn cleanup_worktree(
    _app_state: State<'_, Arc<AppState>>,
    _project_id: i32,
    _worktree_id: i32,
    _repo_path: String,
) -> Result<(), String> {
    todo!("Plan 03 will rewrite cleanup_worktree with git2-based deletion")
}

#[tauri::command]
#[specta::specta]
pub async fn recover_dirty_worktrees(
    _app_state: State<'_, Arc<AppState>>,
    _project_id: i32,
    _repo_path: String,
) -> Result<Vec<i32>, String> {
    todo!("Plan 03 will rewrite recover_dirty_worktrees as zombie cleanup")
}

// ============================================================================
// Worktree Pool Pre-creation (STUB — Plan 03 will rewrite)
// ============================================================================

#[tauri::command]
#[specta::specta]
pub fn initialize_worktree_pool(
    _app_state: State<Arc<AppState>>,
    _project_id: i32,
    _repo_path: String,
    _pool_size: Option<i32>,
) -> Result<Vec<crate::models::WorktreeWithStatus>, String> {
    todo!("Plan 03 will rewrite initialize_worktree_pool as list_worktrees")
}
