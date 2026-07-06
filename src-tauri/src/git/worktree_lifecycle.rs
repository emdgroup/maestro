use std::collections::HashSet;
use std::sync::Arc;
use tauri::{Emitter, State};
use chrono::{Duration, Utc};

use crate::models::{Worktree, WORKTREE_DIR};
use crate::core::AppState;

// ============================================================================
// create_worktree — REQ-08
// ============================================================================

#[tauri::command]
#[specta::specta]
pub async fn create_worktree(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    task_id: Option<i32>,
    base_branch: String,
    new_branch_name: Option<String>,
    repo_path: String,
) -> Result<Worktree, String> {
    // Step 1: Determine the stored branch name and relative worktree path
    let branch_name = new_branch_name.clone().unwrap_or_else(|| base_branch.clone());
    let relative_path = if let Some(tid) = task_id {
        crate::models::worktree_path_for_task(tid)
    } else {
        format!("{}/{}", WORKTREE_DIR, branch_name)
    };

    // Resolve project and git connection (local vs remote SSH)
    let (project, git_conn) = crate::core::get_project_with_git_conn(&app_state, project_id).await?;
    let is_remote = project.is_remote();

    // Step 2: Ensure parent directory exists (local only — SSH creates dirs automatically via git worktree add)
    if !is_remote {
        tokio::fs::create_dir_all(format!("{}/{}", repo_path, WORKTREE_DIR))
            .await
            .map_err(|e| format!("Failed to create worktree directory: {}", e))?;
    }

    // Step 3: Create git worktree via dispatcher (local or SSH)
    // Pass new_branch_name so git can create a new branch from base_branch, or None to checkout existing
    crate::git::create_worktree(&git_conn, &base_branch, &relative_path, new_branch_name.as_deref()).await?;

    // Step 4: Insert DB row (lock DB after async git work)
    let now = Utc::now().to_rfc3339();
    let worktree_id = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        conn.execute(
            "INSERT INTO worktrees (project_id, task_id, branch_name, base_branch, path, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            rusqlite::params![project_id, task_id, &branch_name, &base_branch, &relative_path, &now],
        )
        .map_err(|e| format!("Failed to insert worktree: {}", e))?;
        conn.last_insert_rowid() as i32
    };

    app_state.app_handle.emit("worktrees-changed", ()).ok();
    Ok(Worktree {
        id: worktree_id,
        project_id,
        task_id,
        branch_name,
        base_branch: Some(base_branch),
        path: relative_path,
        git_status: None,
        created_at: now,
    })
}

/// Internal helper for on-demand worktree creation during agent execution.
/// Called from execution_handlers.rs — NOT an IPC command.
pub async fn create_worktree_for_task(
    app_state: &Arc<AppState>,
    project_id: i32,
    task_id: i32,
    repo_path: &str,
) -> Result<(i32, String), String> {
    // Resolve project and git connection (local vs remote SSH)
    let (project, git_conn) = crate::core::get_project_with_git_conn(app_state, project_id).await?;
    let is_remote = project.is_remote();

    // For local projects only, canonicalize to resolve symlinks/relative paths
    let repo_path = if is_remote {
        repo_path.to_string()
    } else {
        std::path::Path::new(repo_path)
            .canonicalize()
            .map_err(|e| format!("Invalid repository path '{}': {}. Ensure the project directory exists.", repo_path, e))?
            .to_string_lossy()
            .to_string()
    };
    let repo_path = repo_path.as_str();

    let relative_path = crate::models::worktree_path_for_task(task_id);
    let abs_path = format!("{}/{}", repo_path, relative_path);

    // Ensure parent dir exists (local only — SSH creates dirs automatically via git worktree add)
    if !is_remote {
        tokio::fs::create_dir_all(format!("{}/{}", repo_path, WORKTREE_DIR))
            .await
            .map_err(|e| format!("Failed to create worktree directory: {}", e))?;
    }

    // Create branch name for this task
    let branch_name = format!("task-{}", task_id);

    // Create git worktree via SSH-aware dispatcher — create new branch from HEAD
    crate::git::create_worktree(&git_conn, "HEAD", &relative_path, Some(&branch_name)).await?;

    // Insert DB row
    let worktree_id = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        let now = Utc::now().to_rfc3339();
        conn.execute(
            "INSERT INTO worktrees (project_id, task_id, branch_name, base_branch, path, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            rusqlite::params![project_id, task_id, &branch_name, rusqlite::types::Null, &relative_path, &now],
        )
        .map_err(|e| format!("Failed to insert worktree: {}", e))?;
        conn.last_insert_rowid() as i32
    };

    app_state.app_handle.emit("worktrees-changed", ()).ok();
    Ok((worktree_id, abs_path))
}

// ============================================================================
// delete_worktree — REQ-09
// ============================================================================

#[tauri::command]
#[specta::specta]
pub async fn delete_worktree(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    worktree_path: String,
    branch_name: String,
    worktree_id: Option<i32>,
    delete_branch: bool,
) -> Result<(), String> {
    // Resolve project and git connection (local vs remote SSH)
    let (_project, git_conn) = crate::core::get_project_with_git_conn(&app_state, project_id).await?;

    // Call git worktree remove via dispatcher (best effort — don't fail if already gone)
    let _ = crate::git::delete_worktree(&git_conn, &worktree_path).await;

    // Optionally delete the branch (best-effort, non-fatal)
    if delete_branch {
        let _ = crate::git::run_git_in_dir(&git_conn, git_conn.path(), &["branch", "-d", &branch_name]).await;
    }

    // Delete DB row if id provided (orphans have no DB row)
    if let Some(id) = worktree_id {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        let _ = conn.execute("DELETE FROM worktrees WHERE id = ?", rusqlite::params![id]);
    }

    app_state.app_handle.emit("worktrees-changed", ()).ok();
    Ok(())
}

// ============================================================================
// cleanup_zombie_worktrees — REQ-34, REQ-35, REQ-36
// ============================================================================

#[tauri::command]
#[specta::specta]
pub async fn cleanup_zombie_worktrees(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    repo_path: String,
) -> Result<i32, String> {
    let threshold = Utc::now() - Duration::minutes(10);

    // Query DB for zombie candidates — lock is released after this block
    let all_candidates: Vec<(i32, String, String, String)> = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        let result: Result<Vec<(i32, String, String, String)>, String> = (|| {
            let mut stmt = conn.prepare(
                "SELECT w.id, w.path, w.created_at, w.branch_name
                 FROM worktrees w
                 LEFT JOIN tasks t ON t.id = w.task_id
                 WHERE w.project_id = ?1
                   AND (w.task_id IS NULL OR t.status IN ('Done', 'Cancelled'))"
            ).map_err(|e| format!("Failed to prepare query: {}", e))?;

            let rows: Vec<(i32, String, String, String)> = stmt.query_map(rusqlite::params![project_id], |row| {
                Ok((row.get::<_, i32>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?))
            })
            .map_err(|e| format!("Failed to query zombie candidates: {}", e))?
            .filter_map(|r| r.ok())
            .collect();
            Ok(rows)
        })();
        result?
    }; // Mutex lock released here

    // Filter by time threshold (only worktrees older than 10 minutes)
    let candidates: Vec<(i32, String, String)> = all_candidates
        .into_iter()
        .filter(|(_, _, created_at, _)| {
            created_at.parse::<chrono::DateTime<chrono::Utc>>()
                .map(|dt| dt < threshold)
                .unwrap_or(false)
        })
        .map(|(id, path, _, branch_name)| (id, path, branch_name))
        .collect();

    if candidates.is_empty() {
        return Ok(0);
    }

    // Resolve project and git connection (local vs remote SSH)
    let (_project, git_conn) = crate::core::get_project_with_git_conn(&app_state, project_id).await?;

    // Get on-disk worktree paths to confirm existence before deleting
    let disk_worktrees = crate::git::list_worktrees(&git_conn).await?;
    let disk_paths: HashSet<String> = disk_worktrees.iter().map(|wt| wt.path.clone()).collect();

    let mut to_delete: Vec<(i32, &str, &str)> = Vec::new();
    for (id, relative_path, branch_name) in &candidates {
        let abs_path = format!("{}/{}", repo_path, relative_path);
        if !disk_paths.contains(&abs_path) {
            continue;
        }

        // Never delete a worktree with uncommitted changes — it may be manually created
        // with live work in progress. `git status --porcelain` returns non-empty output
        // when there are untracked, modified, or staged files.
        let status = crate::git::run_git_in_dir(&git_conn, &abs_path, &["status", "--porcelain"])
            .await
            .unwrap_or_default();
        if !status.trim().is_empty() {
            continue;
        }

        to_delete.push((*id, relative_path.as_str(), branch_name.as_str()));
    }

    // Remove git worktrees and branches (best-effort — don't fail the whole cleanup).
    // Uses `git branch -d` (safe delete): git refuses to delete branches with unmerged
    // commits, so branches with actual work are preserved automatically.
    for (_, relative_path, branch_name) in &to_delete {
        let _ = crate::git::delete_worktree(&git_conn, relative_path).await;

        let _ = crate::git::run_git_in_dir(&git_conn, git_conn.path(), &["branch", "-d", branch_name]).await;
    }

    // Batch-delete DB rows under a single lock
    let deleted = if !to_delete.is_empty() {
        let ids: Vec<i32> = to_delete.iter().map(|(id, _, _)| *id).collect();
        let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(", ");
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        let sql = format!("DELETE FROM worktrees WHERE id IN ({})", placeholders);
        let params = rusqlite::params_from_iter(ids.iter());
        conn.execute(&sql, params).unwrap_or(0) as i32
    } else {
        0
    };

    if deleted > 0 {
        app_state.app_handle.emit("worktrees-changed", ()).ok();
    }
    Ok(deleted)
}

/// Internal helper for worktree deletion during finalization.
/// Called from execution_handlers.rs — NOT an IPC command.
pub async fn delete_worktree_for_task(
    app_state: &Arc<AppState>,
    worktree_id: i32,
    worktree_path: &str,
) -> Result<(), String> {
    // Fetch the owning project in one query via JOIN; if either row is gone, skip git cleanup.
    let project: Option<crate::models::Project> = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        conn.query_row(
            "SELECT p.id, p.name, p.path, p.created_at, p.updated_at, p.last_opened, p.connection_id, p.wsl_connection_id \
             FROM projects p JOIN worktrees w ON p.id = w.project_id WHERE w.id = ?",
            rusqlite::params![worktree_id],
            crate::models::Project::from_row,
        ).ok()
    };

    if let Some(project) = project {
        // Best-effort: if SSH session is gone, fall back to local path for cleanup
        let git_conn = crate::core::get_git_connection(&project, app_state).await
            .unwrap_or_else(|_| crate::models::GitConnection::Local { path: project.path.clone() });
        let _ = crate::git::delete_worktree(&git_conn, worktree_path).await;
    }
    // If project/worktree rows are already gone, skip git cleanup — nothing to remove.

    // Delete DB row
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
    conn.execute(
        "DELETE FROM worktrees WHERE id = ?",
        rusqlite::params![worktree_id],
    )
    .map_err(|e| format!("Failed to delete worktree: {}", e))?;

    app_state.app_handle.emit("worktrees-changed", ()).ok();
    Ok(())
}
