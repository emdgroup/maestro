use std::sync::Arc;
use tauri::State;

use crate::core::AppState;

// ============================================================================
// stash_worktree — Review State Phase 1
// ============================================================================

#[tauri::command]
#[specta::specta]
pub async fn stash_worktree(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    worktree_path: String,
) -> Result<(), String> {
    let (_project, git_conn) = crate::core::get_project_with_git_conn(&app_state, project_id).await?;

    crate::git::run_git_in_dir(
        &git_conn,
        &worktree_path,
        &["stash", "push", "-m", "maestro-auto-stash"],
    ).await?;

    Ok(())
}

// ============================================================================
// discard_all_worktree_changes — Review State Phase 1
// ============================================================================

#[tauri::command]
#[specta::specta]
pub async fn discard_all_worktree_changes(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    worktree_path: String,
) -> Result<(), String> {
    let (_project, git_conn) = crate::core::get_project_with_git_conn(&app_state, project_id).await?;

    crate::git::run_git_in_dir(&git_conn, &worktree_path, &["checkout", "--", "."]).await?;
    crate::git::run_git_in_dir(&git_conn, &worktree_path, &["clean", "-fd"]).await?;

    Ok(())
}
