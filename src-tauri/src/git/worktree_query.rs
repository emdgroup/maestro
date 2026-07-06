use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use tauri::State;

use crate::models::{WorktreeWithStatus, AheadBehind, WORKTREE_PATH_PREFIX, DiffTarget, WorktreeDiffResult, DirtyStatus, CommitInfo};
use crate::core::AppState;

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
    // Resolve project and git connection (local vs remote SSH)
    let project = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        conn.query_row(
            "SELECT id, name, path, created_at, updated_at, last_opened, connection_id, wsl_connection_id FROM projects WHERE id = ?",
            [project_id],
            crate::models::Project::from_row,
        ).map_err(|e| format!("Project {} not found: {}", project_id, e))?
    };
    let git_conn = crate::core::get_git_connection(&project, &app_state).await
        .unwrap_or_else(|_| crate::models::GitConnection::Local { path: repo_path.clone() });

    // Step 1: Get on-disk worktrees
    let disk_worktrees = crate::git::list_worktrees(&git_conn).await?;

    // Step 2: No filter — include main worktree (repo root) so it appears in the spawn dialog.

    // Step 3: Query DB for all worktrees for this project, enriched with task/execution info
    struct DbWorktreeRow {
        id: i32,
        project_id: i32,
        task_id: Option<i32>,
        branch_name: String,
        path: String,
        created_at: String,
        base_branch: Option<String>,
        task_name: Option<String>,
    }

    let db_rows: Vec<DbWorktreeRow> = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        let mut stmt = conn.prepare(
            "SELECT w.id, w.project_id, w.task_id, w.branch_name, w.path, w.created_at, w.base_branch,
                    t.title AS task_name
             FROM worktrees w
             LEFT JOIN tasks t ON t.id = w.task_id
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
                    base_branch: row.get(6)?,
                    task_name: row.get(7)?,
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

    // Step 5: Run parallel git status + diff --shortstat + rev-list per on-disk worktree (local AND remote)
    let mut git_info: HashMap<String, (String, Option<String>, Option<AheadBehind>)> = HashMap::new();
    {
        let handles: Vec<_> = disk_worktrees
            .iter()
            .map(|wt| {
                let wt_path = wt.path.clone();
                let conn = git_conn.clone();
                tokio::spawn(async move {
                    let status = crate::git::run_git_in_dir(&conn, &wt_path, &["status", "--porcelain"])
                        .await
                        .unwrap_or_default();
                    let diff_stat_raw = crate::git::run_git_in_dir(&conn, &wt_path, &["diff", "--shortstat"])
                        .await
                        .unwrap_or_default();
                    let diff_stat = if diff_stat_raw.trim().is_empty() { None } else { Some(diff_stat_raw.trim().to_string()) };
                    let ahead_behind_raw = crate::git::run_git_in_dir(
                        &conn, &wt_path, &["rev-list", "--left-right", "--count", "HEAD...@{u}"],
                    ).await.unwrap_or_default();
                    let ahead_behind: Option<AheadBehind> = ahead_behind_raw
                        .trim()
                        .split_once('\t')
                        .and_then(|(a, b)| {
                            a.parse::<u32>().ok().zip(b.parse::<u32>().ok())
                        })
                        .map(|(ahead, behind)| AheadBehind { ahead, behind });
                    (wt_path, status, diff_stat, ahead_behind)
                })
            })
            .collect();

        for handle in handles {
            if let Ok((path, status, diff_stat, ahead_behind)) = handle.await {
                git_info.insert(path, (status, diff_stat, ahead_behind));
            }
        }
    }

    // Step 6: Build WorktreeWithStatus vec
    // Track which DB paths were matched by an on-disk worktree
    let mut matched_db_ids: HashSet<i32> = HashSet::new();
    let mut result: Vec<WorktreeWithStatus> = Vec::new();

    for wt in &disk_worktrees {
        let (git_status, diff_stat, ahead_behind) = git_info.get(&wt.path).cloned().unwrap_or_default();
        if let Some(db_row) = db_map.get(&wt.path) {
            matched_db_ids.insert(db_row.id);
            let is_zombie = db_row.task_id.is_none() && db_row.path.contains(WORKTREE_PATH_PREFIX);
            result.push(WorktreeWithStatus {
                id: Some(db_row.id),
                project_id: Some(db_row.project_id),
                task_id: db_row.task_id,
                branch_name: db_row.branch_name.clone(),
                path: format!("{}/{}", repo_path, db_row.path),
                git_status,
                created_at: Some(db_row.created_at.clone()),
                task_name: db_row.task_name.clone(),
                is_zombie,
                is_orphan: false,
                diff_stat,
                base_branch: db_row.base_branch.clone(),
                ahead_behind,
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
                is_zombie: false,
                is_orphan: true,
                diff_stat,
                base_branch: None,
                ahead_behind,
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

    Ok(result)
}

// ============================================================================
// get_worktree_diff — REQ-07
// ============================================================================

#[tauri::command]
#[specta::specta]
pub async fn get_worktree_diff(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    worktree_path: String,
    diff_target: DiffTarget,
) -> Result<WorktreeDiffResult, String> {
    let (_project, git_conn) = crate::core::get_project_with_git_conn(&app_state, project_id).await?;

    let diff_output = match &diff_target {
        DiffTarget::Head => {
            crate::git::run_git_in_dir(&git_conn, &worktree_path, &["diff", "HEAD"]).await?
        }
        DiffTarget::Branch { branch } => {
            let range = format!("origin/{}..HEAD", branch);
            crate::git::run_git_in_dir(&git_conn, &worktree_path, &["diff", "--unified=6", &range]).await?
        }
        DiffTarget::Commit { sha } => {
            crate::git::run_git_in_dir(&git_conn, &worktree_path, &["diff", "--unified=6", sha]).await?
        }
        DiffTarget::BranchAll { branch } => {
            let target = format!("origin/{}", branch);
            crate::git::run_git_in_dir(&git_conn, &worktree_path, &["diff", "--unified=6", &target]).await?
        }
        DiffTarget::CommitRange { from, to } => {
            let range = format!("{}..{}", from, to);
            crate::git::run_git_in_dir(&git_conn, &worktree_path, &["diff", "--unified=6", &range]).await?
        }
    };

    let untracked_output = crate::git::run_git_in_dir(
        &git_conn,
        &worktree_path,
        &["ls-files", "--others", "--exclude-standard"],
    ).await.unwrap_or_default();
    let untracked_files = untracked_output.lines()
        .filter(|l| !l.is_empty())
        .map(String::from)
        .collect();

    Ok(WorktreeDiffResult { diff: diff_output, untracked_files })
}

// ============================================================================
// check_worktree_dirty — Review State Phase 1
// ============================================================================

#[tauri::command]
#[specta::specta]
pub async fn check_worktree_dirty(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    worktree_path: String,
) -> Result<DirtyStatus, String> {
    let (_project, git_conn) = crate::core::get_project_with_git_conn(&app_state, project_id).await?;

    let output = crate::git::run_git_in_dir(&git_conn, &worktree_path, &["status", "--porcelain"]).await?;

    let mut modified_count: u32 = 0;
    let mut untracked_count: u32 = 0;
    for line in output.lines() {
        if line.starts_with("??") {
            untracked_count += 1;
        } else if line.len() >= 2 {
            modified_count += 1;
        }
    }

    Ok(DirtyStatus { modified_count, untracked_count })
}

// ============================================================================
// get_worktree_commits — Review State Phase 1
// ============================================================================

#[tauri::command]
#[specta::specta]
pub async fn get_worktree_commits(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    worktree_path: String,
    base_branch: String,
) -> Result<Vec<CommitInfo>, String> {
    let (_project, git_conn) = crate::core::get_project_with_git_conn(&app_state, project_id).await?;

    let merge_base = crate::git::run_git_in_dir(
        &git_conn, &worktree_path, &["merge-base", &base_branch, "HEAD"],
    ).await.unwrap_or_default();

    let range = if merge_base.trim().is_empty() {
        format!("{}..HEAD", base_branch)
    } else {
        format!("{}..HEAD", merge_base.trim())
    };

    let log_output = crate::git::run_git_in_dir(
        &git_conn,
        &worktree_path,
        &["log", "--oneline", "--format=%H %s", &range],
    ).await.unwrap_or_default();

    let mut commits: Vec<CommitInfo> = Vec::new();
    for line in log_output.lines() {
        if line.is_empty() {
            continue;
        }
        let (sha, message) = match line.split_once(' ') {
            Some((s, m)) => (s.to_string(), m.to_string()),
            None => (line.to_string(), String::new()),
        };

        let file_count_output = crate::git::run_git_in_dir(
            &git_conn,
            &worktree_path,
            &["diff-tree", "--no-commit-id", "--name-only", "-r", &sha],
        ).await.unwrap_or_default();
        let file_count = file_count_output.lines().filter(|l| !l.is_empty()).count() as u32;

        commits.push(CommitInfo { sha, message, file_count });
    }

    Ok(commits)
}

// ============================================================================
// get_untracked_file_content — returns file content as a unified diff string
// ============================================================================

#[tauri::command]
#[specta::specta]
pub async fn get_untracked_file_content(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    worktree_path: String,
    file_path: String,
) -> Result<String, String> {
    let (_project, git_conn) = crate::core::get_project_with_git_conn(&app_state, project_id).await?;
    crate::git::run_git_in_dir_lossy(
        &git_conn,
        &worktree_path,
        &["diff", "--no-index", "/dev/null", &file_path],
    )
    .await
}
