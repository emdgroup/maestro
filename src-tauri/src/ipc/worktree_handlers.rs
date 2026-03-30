use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use tauri::State;
use chrono::{Duration, Utc};

use crate::models::{Worktree, WorktreeWithStatus, WORKTREE_PATH_PREFIX, WORKTREE_DIR, GitConnection};
use crate::db::AppState;

// ============================================================================
// list_worktrees_with_status — REQ-06
// ============================================================================

#[tauri::command]
#[specta::specta]
pub async fn list_worktrees_with_status(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    repo_path: String,
) -> Result<Vec<WorktreeWithStatus>, String> {
    println!("list_worktrees_with_status(project={}) called", project_id);

    // Step 1: Get on-disk worktrees
    let disk_worktrees = crate::git::list_worktrees_local(&repo_path).await?;

    // Step 2: Filter out main worktree (the repo root itself)
    let disk_worktrees: Vec<_> = disk_worktrees
        .into_iter()
        .filter(|wt| wt.path != repo_path)
        .collect();

    // Step 3: Query DB for all worktrees for this project, enriched with task/execution info
    struct DbWorktreeRow {
        id: i32,
        project_id: i32,
        task_id: Option<i32>,
        branch_name: String,
        path: String,
        created_at: String,
        task_name: Option<String>,
        agent_status: Option<String>,
    }

    let db_rows: Vec<DbWorktreeRow> = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        let mut stmt = conn.prepare(
            "SELECT w.id, w.project_id, w.task_id, w.branch_name, w.path, w.created_at,
                    t.name AS task_name,
                    el.status AS agent_status
             FROM worktrees w
             LEFT JOIN tasks t ON t.id = w.task_id
             LEFT JOIN execution_logs el ON el.task_id = w.task_id
                 AND el.id = (SELECT id FROM execution_logs WHERE task_id = w.task_id ORDER BY started_at DESC LIMIT 1)
             WHERE w.project_id = ?"
        ).map_err(|e| format!("Failed to prepare query: {}", e))?;

        let rows: Vec<DbWorktreeRow> = stmt
            .query_map(rusqlite::params![project_id], |row| {
                Ok(DbWorktreeRow {
                    id: row.get(0)?,
                    project_id: row.get(1)?,
                    task_id: row.get(2)?,
                    branch_name: row.get(3)?,
                    path: row.get(4)?,
                    created_at: row.get(5)?,
                    task_name: row.get(6)?,
                    agent_status: row.get(7)?,
                })
            })
            .map_err(|e| format!("Failed to query worktrees: {}", e))?
            .filter_map(|r| r.ok())
            .collect();
        rows
    };

    // Step 4: Build a HashMap<abs_path, DB row> keyed by absolute path
    let db_map: HashMap<String, &DbWorktreeRow> = db_rows
        .iter()
        .map(|row| {
            let abs_path = format!("{}/{}", repo_path, row.path);
            (abs_path, row)
        })
        .collect();

    // Step 5: Run parallel git status + diff --shortstat per on-disk worktree
    let handles: Vec<_> = disk_worktrees
        .iter()
        .map(|wt| {
            let path = wt.path.clone();
            tokio::spawn(async move {
                let status = crate::git::get_worktree_status_local(&path)
                    .await
                    .unwrap_or_default();
                let diff_stat_output = tokio::process::Command::new("git")
                    .args(["diff", "--shortstat"])
                    .current_dir(&path)
                    .output()
                    .await;
                let diff_stat = match diff_stat_output {
                    Ok(out) => {
                        let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
                        if s.is_empty() { None } else { Some(s) }
                    }
                    Err(_) => None,
                };
                (path, status, diff_stat)
            })
        })
        .collect();

    let mut git_info: HashMap<String, (String, Option<String>)> = HashMap::new();
    for handle in handles {
        if let Ok((path, status, diff_stat)) = handle.await {
            git_info.insert(path, (status, diff_stat));
        }
    }

    // Step 6: Build WorktreeWithStatus vec
    // Track which DB paths were matched by an on-disk worktree
    let mut matched_db_ids: HashSet<i32> = HashSet::new();
    let mut result: Vec<WorktreeWithStatus> = Vec::new();

    for wt in &disk_worktrees {
        let (git_status, diff_stat) = git_info.get(&wt.path).cloned().unwrap_or_default();
        if let Some(db_row) = db_map.get(&wt.path) {
            matched_db_ids.insert(db_row.id);
            let is_zombie = db_row.task_id.is_none() && db_row.path.contains(WORKTREE_PATH_PREFIX);
            result.push(WorktreeWithStatus {
                id: Some(db_row.id),
                project_id: Some(db_row.project_id),
                task_id: db_row.task_id,
                branch_name: db_row.branch_name.clone(),
                path: db_row.path.clone(),
                git_status,
                created_at: Some(db_row.created_at.clone()),
                task_name: db_row.task_name.clone(),
                agent_status: db_row.agent_status.clone(),
                is_zombie,
                is_orphan: false,
                diff_stat,
            });
        } else {
            // On-disk but not in DB — orphan entry
            let branch_name = wt.branch.clone().unwrap_or_else(|| "unknown".to_string());
            result.push(WorktreeWithStatus {
                id: None,
                project_id: None,
                task_id: None,
                branch_name,
                path: wt.path.clone(),
                git_status,
                created_at: None,
                task_name: None,
                agent_status: None,
                is_zombie: false,
                is_orphan: true,
                diff_stat,
            });
        }
    }

    // Step 7: Auto-delete DB rows not matched by any on-disk worktree
    let unmatched_db_ids: Vec<i32> = db_rows
        .iter()
        .filter(|row| !matched_db_ids.contains(&row.id))
        .map(|row| row.id)
        .collect();

    if !unmatched_db_ids.is_empty() {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        for id in &unmatched_db_ids {
            let _ = conn.execute("DELETE FROM worktrees WHERE id = ?", [id]);
        }
        println!(
            "list_worktrees_with_status: auto-deleted {} stale DB rows",
            unmatched_db_ids.len()
        );
    }

    // Sort by created_at descending (None goes last)
    result.sort_by(|a, b| {
        match (&b.created_at, &a.created_at) {
            (Some(b_ts), Some(a_ts)) => b_ts.cmp(a_ts),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => a.path.cmp(&b.path),
        }
    });

    println!(
        "list_worktrees_with_status: returning {} worktrees",
        result.len()
    );
    Ok(result)
}

// ============================================================================
// get_worktree_diff — REQ-07
// ============================================================================

#[tauri::command]
#[specta::specta]
pub async fn get_worktree_diff(
    app_state: State<'_, Arc<AppState>>,
    worktree_id: i32,
) -> Result<String, String> {
    println!("get_worktree_diff(worktree={}) called", worktree_id);

    // Step 1: Query DB for worktree path and branch_name
    let (wt_path, branch_name, project_id): (String, String, i32) = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        conn.query_row(
            "SELECT path, branch_name, project_id FROM worktrees WHERE id = ?",
            rusqlite::params![worktree_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(|e| format!("Worktree {} not found: {}", worktree_id, e))?
    };

    // Step 2: Get project repo_path
    let repo_path: String = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        conn.query_row(
            "SELECT path FROM projects WHERE id = ?",
            rusqlite::params![project_id],
            |row| row.get(0),
        )
        .map_err(|e| format!("Project {} not found: {}", project_id, e))?
    };

    // Step 3: Construct absolute worktree path
    let worktree_abs = format!("{}/{}", repo_path, wt_path);

    // Step 4: Compute diff using git2 inside spawn_blocking
    let worktree_abs_clone = worktree_abs.clone();
    let branch_clone = branch_name.clone();

    let diff_result = tokio::task::spawn_blocking(move || {
        let repo = git2::Repository::open(&worktree_abs_clone)
            .map_err(|e| format!("Failed to open repo at {}: {}", worktree_abs_clone, e))?;

        // Get HEAD tree
        let head = repo
            .head()
            .map_err(|e| format!("Failed to get HEAD: {}", e))?;
        let head_tree = head
            .peel_to_tree()
            .map_err(|e| format!("Failed to peel HEAD to tree: {}", e))?;

        // Try origin/{branch} first
        let origin_ref = format!("refs/remotes/origin/{}", branch_clone);
        let diff = match repo.revparse_single(&origin_ref) {
            Ok(origin_obj) => {
                let origin_tree = origin_obj
                    .peel_to_tree()
                    .map_err(|e| format!("Failed to peel origin to tree: {}", e))?;
                // Diff origin_tree -> HEAD tree (shows what changed in the worktree vs upstream)
                repo.diff_tree_to_tree(Some(&origin_tree), Some(&head_tree), None)
                    .map_err(|e| format!("Failed to compute diff: {}", e))?
            }
            Err(_) => {
                // Fallback: diff working dir against HEAD (uncommitted changes)
                repo.diff_tree_to_workdir_with_index(Some(&head_tree), None)
                    .map_err(|e| format!("Failed to compute workdir diff: {}", e))?
            }
        };

        // Convert to unified diff string
        let mut diff_string = String::new();
        diff.print(git2::DiffFormat::Patch, |_delta, _hunk, line| {
            let origin = line.origin();
            if origin == '+' || origin == '-' || origin == ' ' {
                diff_string.push(origin);
            }
            diff_string.push_str(std::str::from_utf8(line.content()).unwrap_or(""));
            true
        })
        .map_err(|e| format!("Failed to format diff: {}", e))?;

        Ok::<String, String>(diff_string)
    })
    .await
    .map_err(|e| format!("spawn_blocking failed: {}", e))??;

    println!(
        "get_worktree_diff: returning {} bytes for worktree {}",
        diff_result.len(),
        worktree_id
    );
    Ok(diff_result)
}

// ============================================================================
// create_worktree — REQ-08
// ============================================================================

#[tauri::command]
#[specta::specta]
pub async fn create_worktree(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    task_id: Option<i32>,
    origin_branch: String,
    new_branch_name: Option<String>,
    repo_path: String,
) -> Result<Worktree, String> {
    println!(
        "create_worktree(project={}, task={:?}, origin={}, new={:?}) called",
        project_id, task_id, origin_branch, new_branch_name
    );

    // Step 1: Determine the stored branch name and relative worktree path
    let branch_name = new_branch_name.clone().unwrap_or_else(|| origin_branch.clone());
    let relative_path = if let Some(tid) = task_id {
        crate::models::worktree_path_for_task(tid)
    } else {
        format!("{}/{}", WORKTREE_DIR, branch_name)
    };

    // Step 2: Ensure parent directory exists
    tokio::fs::create_dir_all(format!("{}/{}", repo_path, WORKTREE_DIR))
        .await
        .map_err(|e| format!("Failed to create worktree directory: {}", e))?;

    // Step 3: Create git worktree (local only for now)
    // Pass new_branch_name so git can create a new branch from origin_branch, or None to checkout existing
    let git_conn = crate::models::GitConnection::Local { path: repo_path.clone() };
    crate::git::create_worktree(&git_conn, &origin_branch, &relative_path, new_branch_name.as_deref()).await?;

    // Step 4: Insert DB row (lock DB after async git work)
    let now = Utc::now().to_rfc3339();
    let worktree_id = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        conn.execute(
            "INSERT INTO worktrees (project_id, task_id, branch_name, path, created_at) VALUES (?, ?, ?, ?, ?)",
            rusqlite::params![project_id, task_id, &branch_name, &relative_path, &now],
        )
        .map_err(|e| format!("Failed to insert worktree: {}", e))?;
        conn.last_insert_rowid() as i32
    };

    println!("create_worktree: created worktree {} at {}", worktree_id, relative_path);
    Ok(Worktree {
        id: worktree_id,
        project_id,
        task_id,
        branch_name,
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
    // Canonicalize repo_path as a safety net — resolves symlinks, trailing slashes, relative paths
    let repo_path_canon = std::path::Path::new(repo_path)
        .canonicalize()
        .map_err(|e| format!("Invalid repository path '{}': {}. Ensure the project directory exists.", repo_path, e))?;
    let repo_path = repo_path_canon.to_string_lossy().to_string();
    let repo_path = repo_path.as_str();

    let relative_path = crate::models::worktree_path_for_task(task_id);
    let abs_path = format!("{}/{}", repo_path, relative_path);

    // Ensure parent dir exists
    tokio::fs::create_dir_all(format!("{}/{}", repo_path, WORKTREE_DIR))
        .await
        .map_err(|e| format!("Failed to create worktree directory: {}", e))?;

    // Create branch name for this task
    let branch_name = format!("task-{}", task_id);

    // Create git worktree (local only for now) — create new branch from HEAD
    // Use "HEAD" as origin so git creates task-N from the current HEAD commit
    let git_conn = crate::models::GitConnection::Local { path: repo_path.to_string() };
    crate::git::create_worktree(&git_conn, "HEAD", &relative_path, Some(&branch_name)).await?;

    // Insert DB row
    let worktree_id = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        let now = Utc::now().to_rfc3339();
        conn.execute(
            "INSERT INTO worktrees (project_id, task_id, branch_name, path, created_at) VALUES (?, ?, ?, ?, ?)",
            rusqlite::params![project_id, task_id, &branch_name, &relative_path, &now],
        )
        .map_err(|e| format!("Failed to insert worktree: {}", e))?;
        conn.last_insert_rowid() as i32
    };

    Ok((worktree_id, abs_path))
}

// ============================================================================
// delete_worktree — REQ-09
// ============================================================================

#[tauri::command]
#[specta::specta]
pub async fn delete_worktree(
    app_state: State<'_, Arc<AppState>>,
    worktree_id: i32,
    repo_path: String,
) -> Result<(), String> {
    println!("delete_worktree(worktree={}) called", worktree_id);

    // Step 1: Query DB for worktree path
    let wt_path: String = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        conn.query_row(
            "SELECT path FROM worktrees WHERE id = ?",
            rusqlite::params![worktree_id],
            |row| row.get(0),
        )
        .map_err(|e| format!("Worktree {} not found: {}", worktree_id, e))?
    };

    // Step 2: Call git worktree remove (best effort — don't fail if already gone)
    let git_conn = crate::models::GitConnection::Local { path: repo_path.clone() };
    let _ = crate::git::delete_worktree(&git_conn, &wt_path).await;

    // Step 3: Delete DB row
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
    conn.execute(
        "DELETE FROM worktrees WHERE id = ?",
        rusqlite::params![worktree_id],
    )
    .map_err(|e| format!("Failed to delete worktree: {}", e))?;

    println!("delete_worktree: deleted worktree {}", worktree_id);
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
    println!("cleanup_zombie_worktrees(project={}) called", project_id);

    let threshold = Utc::now() - Duration::minutes(10);

    // Query DB for zombie candidates — lock is released after this block
    let all_candidates: Vec<(i32, String, String)> = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        let result: Result<Vec<(i32, String, String)>, String> = (|| {
            let mut stmt = conn.prepare(
                "SELECT w.id, w.path, w.created_at
                 FROM worktrees w
                 LEFT JOIN tasks t ON t.id = w.task_id
                 WHERE w.project_id = ?1
                   AND (w.task_id IS NULL OR t.status IN ('Done', 'Cancelled'))
                   AND NOT EXISTS (
                       SELECT 1 FROM execution_logs el
                       WHERE el.task_id = w.task_id AND el.status = 'running'
                   )"
            ).map_err(|e| format!("Failed to prepare query: {}", e))?;

            let rows: Vec<(i32, String, String)> = stmt.query_map(rusqlite::params![project_id], |row| {
                Ok((row.get::<_, i32>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?))
            })
            .map_err(|e| format!("Failed to query zombie candidates: {}", e))?
            .filter_map(|r| r.ok())
            .collect();
            Ok(rows)
        })();
        result?
    }; // Mutex lock released here

    // Filter by time threshold (only worktrees older than 10 minutes)
    let candidates: Vec<(i32, String)> = all_candidates
        .into_iter()
        .filter(|(_, _, created_at)| {
            created_at.parse::<chrono::DateTime<chrono::Utc>>()
                .map(|dt| dt < threshold)
                .unwrap_or(false)
        })
        .map(|(id, path, _)| (id, path))
        .collect();

    if candidates.is_empty() {
        return Ok(0);
    }

    // Get on-disk worktree paths to confirm existence before deleting
    let disk_worktrees = crate::git::list_worktrees_local(&repo_path).await?;
    let disk_paths: HashSet<String> = disk_worktrees.iter().map(|wt| wt.path.clone()).collect();

    let mut deleted: i32 = 0;

    for (id, relative_path) in &candidates {
        let abs_path = format!("{}/{}", repo_path, relative_path);
        if disk_paths.contains(&abs_path) {
            // Remove the git worktree (best-effort — don't fail the whole cleanup)
            let git_conn = GitConnection::Local { path: repo_path.clone() };
            let _ = crate::git::delete_worktree(&git_conn, relative_path).await;

            // Delete the DB row
            {
                let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
                let _ = conn.execute("DELETE FROM worktrees WHERE id = ?", rusqlite::params![id]);
            }

            deleted += 1;
        }
    }

    println!(
        "cleanup_zombie_worktrees: deleted {} zombie worktrees for project {}",
        deleted, project_id
    );
    Ok(deleted)
}

/// Internal helper for worktree deletion during finalization.
/// Called from execution_handlers.rs — NOT an IPC command.
pub async fn delete_worktree_for_task(
    app_state: &Arc<AppState>,
    worktree_id: i32,
    worktree_path: &str,
    repo_path: &str,
) -> Result<(), String> {
    // Best effort git worktree remove
    let git_conn = crate::models::GitConnection::Local { path: repo_path.to_string() };
    let _ = crate::git::delete_worktree(&git_conn, worktree_path).await;

    // Delete DB row
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
    conn.execute(
        "DELETE FROM worktrees WHERE id = ?",
        rusqlite::params![worktree_id],
    )
    .map_err(|e| format!("Failed to delete worktree: {}", e))?;

    Ok(())
}
