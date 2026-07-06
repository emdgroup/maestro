use std::sync::Arc;
use tauri::{Emitter, State};

use crate::core::AppState;

// ============================================================================
// stage_worktree_files — REQ: GC-06
// ============================================================================

#[tauri::command]
#[specta::specta]
pub async fn stage_worktree_files(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    worktree_path: String,
    file_paths: Vec<String>,
    patch: Option<String>,
) -> Result<(), String> {
    let (_project, git_conn) = crate::core::get_project_with_git_conn(&app_state, project_id).await?;
    let worktree_abs = worktree_path;

    if !file_paths.is_empty() {
        let mut args = vec!["add", "--"];
        let refs: Vec<&str> = file_paths.iter().map(|s| s.as_str()).collect();
        args.extend(refs);
        crate::git::run_git_in_dir(&git_conn, &worktree_abs, &args).await?;
    }

    if let Some(patch_content) = patch {
        crate::git::run_git_in_dir_with_stdin(
            &git_conn,
            &worktree_abs,
            &["apply", "--cached"],
            patch_content.as_bytes(),
        )
        .await?;
    }
    Ok(())
}

// ============================================================================
// commit_worktree — REQ: GC-08
// ============================================================================

#[tauri::command]
#[specta::specta]
pub async fn commit_worktree(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    worktree_path: String,
    message: String,
) -> Result<(), String> {
    let (_project, git_conn) = crate::core::get_project_with_git_conn(&app_state, project_id).await?;
    crate::git::run_git_in_dir(&git_conn, &worktree_path, &["commit", "-m", &message]).await?;
    app_state.app_handle.emit("worktrees-changed", ()).ok();
    Ok(())
}

// ============================================================================
// discard_worktree_changes — REQ: GC-06
// ============================================================================

#[tauri::command]
#[specta::specta]
pub async fn discard_worktree_changes(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    worktree_path: String,
    file_paths: Vec<String>,
    patch: Option<String>,
) -> Result<(), String> {
    let (_project, git_conn) = crate::core::get_project_with_git_conn(&app_state, project_id).await?;
    let worktree_abs = worktree_path;

    if !file_paths.is_empty() {
        let mut reset_args = vec!["reset", "HEAD", "--"];
        let refs: Vec<&str> = file_paths.iter().map(|s| s.as_str()).collect();
        reset_args.extend(refs.clone());
        crate::git::run_git_in_dir(&git_conn, &worktree_abs, &reset_args).await?;

        let mut checkout_args = vec!["checkout", "--"];
        checkout_args.extend(refs);
        crate::git::run_git_in_dir(&git_conn, &worktree_abs, &checkout_args).await?;
    }

    if let Some(patch_content) = patch {
        crate::git::run_git_in_dir_with_stdin(
            &git_conn,
            &worktree_abs,
            &["apply", "--reverse"],
            patch_content.as_bytes(),
        )
        .await?;
    }
    app_state.app_handle.emit("worktrees-changed", ()).ok();
    Ok(())
}

// ============================================================================
// shelve_worktree_changes — REQ: GC-06
// ============================================================================

#[tauri::command]
#[specta::specta]
pub async fn shelve_worktree_changes(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    worktree_path: String,
    stash_name: String,
    file_paths: Vec<String>,
) -> Result<(), String> {
    let (_project, git_conn) = crate::core::get_project_with_git_conn(&app_state, project_id).await?;
    let worktree_abs = worktree_path;

    let mut args = vec!["stash", "push", "-m", &stash_name];
    if !file_paths.is_empty() {
        args.push("--");
        let refs: Vec<&str> = file_paths.iter().map(|s| s.as_str()).collect();
        args.extend(refs);
    }
    crate::git::run_git_in_dir(&git_conn, &worktree_abs, &args).await?;
    app_state.app_handle.emit("worktrees-changed", ()).ok();
    Ok(())
}

// ============================================================================
// delete_untracked_files — removes untracked files via `git clean -f`
// ============================================================================

#[tauri::command]
#[specta::specta]
pub async fn delete_untracked_files(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    worktree_path: String,
    file_paths: Vec<String>,
) -> Result<(), String> {
    let (_project, git_conn) = crate::core::get_project_with_git_conn(&app_state, project_id).await?;
    let mut args = vec!["clean", "-f", "--"];
    let refs: Vec<&str> = file_paths.iter().map(|s| s.as_str()).collect();
    args.extend(refs);
    crate::git::run_git_in_dir(&git_conn, &worktree_path, &args).await?;
    Ok(())
}

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
