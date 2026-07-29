use std::collections::HashSet;
use std::sync::Arc;
use tauri::{Emitter, State};
use chrono::Utc;

use crate::models::{Worktree, WORKTREE_DIR};
use crate::core::AppState;

/// Canonicalize a local repository path, resolving symlinks and relative segments.
///
/// `std::fs::canonicalize` returns an extended-length `\\?\` path on Windows, which the object
/// manager consumes verbatim: a forward slash anywhere after the prefix is rejected as
/// `ERROR_INVALID_NAME` (os error 123), and such a path is silently ignored when handed to
/// `CreateProcess` as a working directory. Worktree paths are assembled as `{repo}/{relative}`
/// strings, so the prefix has to come back off.
///
/// ponytail: stripping the prefix also gives up long-path support past 260 chars; add the
/// length guard the `dunce` crate uses if that ever bites.
pub fn canonicalize_repo_path(path: &str) -> Result<String, String> {
    let canonical = std::path::Path::new(path)
        .canonicalize()
        .map_err(|e| {
            format!("Invalid repository path '{}': {}. Ensure the project directory exists.", path, e)
        })?
        .to_string_lossy()
        .to_string();

    #[cfg(windows)]
    if let Some(stripped) = canonical.strip_prefix(r"\\?\UNC\") {
        return Ok(format!(r"\\{}", stripped));
    }
    #[cfg(windows)]
    if let Some(stripped) = canonical.strip_prefix(r"\\?\") {
        return Ok(stripped.to_string());
    }

    Ok(canonical)
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
    base_branch: String,
    new_branch_name: Option<String>,
    repo_path: String,
) -> Result<Worktree, String> {
    // Resolve project and git connection (local vs remote SSH)
    let (project, git_conn) = crate::core::get_project_with_git_conn(&app_state, project_id).await?;
    let is_remote = project.is_remote();

    // A task created in a non-git project still submits `isolated_worktree = true`, so this is
    // reachable from normal use and has to fail with something a user can act on.
    if !crate::project::git_ops::is_git_repo(
        &app_state,
        repo_path.clone(),
        project.connection_id,
        project.wsl_connection_id,
        project.docker_connection_id,
    )
    .await?
    {
        return Err("This project is not a git repository — worktrees are unavailable.".to_string());
    }

    // Ensure parent directory exists (local only — SSH creates dirs automatically via git worktree add)
    if !is_remote {
        tokio::fs::create_dir_all(format!("{}/{}", repo_path, WORKTREE_DIR))
            .await
            .map_err(|e| format!("Failed to create worktree directory: {}", e))?;
    }

    let now = Utc::now().to_rfc3339();

    let (worktree_id, branch_name, relative_path) = match task_id {
        Some(tid) => {
            let branch_name = new_branch_name.clone().unwrap_or_else(|| base_branch.clone());
            let relative_path = crate::models::worktree_path_for_task(tid);
            crate::git::create_worktree(&git_conn, &base_branch, &relative_path, new_branch_name.as_deref()).await?;

            let worktree_id = {
                let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
                conn.execute(
                    "INSERT INTO worktrees (project_id, task_id, branch_name, base_branch, path, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                    rusqlite::params![project_id, task_id, &branch_name, &base_branch, &relative_path, &now],
                )
                .map_err(|e| format!("Failed to insert worktree: {}", e))?;
                conn.last_insert_rowid() as i32
            };
            (worktree_id, branch_name, relative_path)
        }
        // Sessions have no stable id of their own, so the row id is the name: session names are
        // random adjective-noun pairs with no collision check, and a rename would otherwise
        // strand the folder. Insert first purely to reserve that id.
        //
        // The reservation carries an empty path until the UPDATE below, which is what marks it
        // as in-flight: `list_worktrees_with_status` prunes rows no on-disk worktree matches, and
        // skips empty-path rows for exactly this reason.
        //
        // ponytail: a crash between the INSERT and the UPDATE leaks a path-less row that nothing
        // reaps. Reap empty-path rows older than a few minutes on project open if that shows up.
        None => {
            let worktree_id = {
                let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
                conn.execute(
                    "INSERT INTO worktrees (project_id, task_id, branch_name, base_branch, path, created_at) VALUES (?, NULL, ?, ?, '', ?)",
                    rusqlite::params![project_id, &base_branch, &base_branch, &now],
                )
                .map_err(|e| format!("Failed to insert worktree: {}", e))?;
                conn.last_insert_rowid() as i32
            };

            let relative_path = crate::models::worktree_path_for_session(worktree_id);
            // Suffix unconditionally rather than probing for an existing branch: a check-then-create
            // pair races with a second spawn, an id cannot collide.
            let branch_name = match &new_branch_name {
                Some(name) => format!("{}-{}", name, worktree_id),
                None => base_branch.clone(),
            };

            // `None` means "check out base_branch where it is", so there is no new name to suffix.
            let branch_to_create = new_branch_name.as_ref().map(|_| branch_name.as_str());
            let created =
                crate::git::create_worktree(&git_conn, &base_branch, &relative_path, branch_to_create).await;

            if let Err(e) = created {
                let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
                conn.execute("DELETE FROM worktrees WHERE id = ?", rusqlite::params![worktree_id])
                    .map_err(|e| format!("Failed to roll back worktree row: {}", e))?;
                return Err(e);
            }

            {
                let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
                conn.execute(
                    "UPDATE worktrees SET branch_name = ?, path = ? WHERE id = ?",
                    rusqlite::params![&branch_name, &relative_path, worktree_id],
                )
                .map_err(|e| format!("Failed to update worktree: {}", e))?;
            }
            (worktree_id, branch_name, relative_path)
        }
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
        canonicalize_repo_path(repo_path)?
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

/// True when another ref already contains the worktree's tip, i.e. the branch holds no commits
/// of its own. `containing` is `git branch --all --contains HEAD --format=%(refname:short)`;
/// `--all` matters because the base branch may have been a remote-tracking ref with no local
/// branch at that commit.
fn branch_has_no_own_commits(containing: &str, branch_name: &str) -> bool {
    containing
        .lines()
        .map(str::trim)
        .any(|other| !other.is_empty() && other != branch_name)
}

/// True when `cwd` is the worktree root or a directory inside it. A session's working directory
/// is usually the worktree itself, but an agent may have been pointed at a subdirectory.
fn path_is_within(cwd: &str, worktree_path: &str) -> bool {
    let cwd = cwd.trim_end_matches(['/', '\\']);
    let root = worktree_path.trim_end_matches(['/', '\\']);
    match cwd.strip_prefix(root) {
        Some("") => true,
        Some(rest) => rest.starts_with('/') || rest.starts_with('\\'),
        None => false,
    }
}

/// `Some(reason)` when removing this worktree would lose work, `None` when nothing would be lost:
/// no uncommitted changes and no commits that live solely on its branch.
///
/// The commit check has to happen up front: `git branch -d` refuses an unmerged branch, but it
/// runs after `git worktree remove --force` has already thrown the working tree away.
async fn reason_to_keep(
    git_conn: &crate::models::GitConnection,
    worktree_path: &str,
    branch_name: &str,
) -> Result<Option<String>, String> {
    let status = crate::git::run_git_in_dir(git_conn, worktree_path, &["status", "--porcelain"]).await?;
    if !status.trim().is_empty() {
        log::debug!("keeping worktree {}: working tree not clean\n{}", worktree_path, status);
        return Ok(Some("it has uncommitted changes".to_string()));
    }

    let containing = crate::git::run_git_in_dir(
        git_conn,
        worktree_path,
        &["branch", "--all", "--contains", "HEAD", "--format=%(refname:short)"],
    )
    .await?;
    if !branch_has_no_own_commits(&containing, branch_name) {
        log::debug!("keeping worktree {}: only {} contains its tip", worktree_path, branch_name);
        return Ok(Some("its branch has commits of its own".to_string()));
    }

    Ok(None)
}

/// Remove a worktree and its branch only when nothing would be lost. Returns `None` when removed,
/// or the reason it was kept.
#[tauri::command]
#[specta::specta]
pub async fn cleanup_worktree_if_clean(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    worktree_path: String,
    branch_name: String,
    worktree_id: Option<i32>,
) -> Result<Option<String>, String> {
    let (_project, git_conn) = crate::core::get_project_with_git_conn(&app_state, project_id).await?;

    if let Some(reason) = reason_to_keep(&git_conn, &worktree_path, &branch_name).await? {
        return Ok(Some(reason));
    }

    crate::git::delete_worktree(&git_conn, &worktree_path).await?;
    crate::git::run_git_in_dir(&git_conn, git_conn.path(), &["branch", "-d", &branch_name]).await?;

    if let Some(id) = worktree_id {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        conn.execute("DELETE FROM worktrees WHERE id = ?", rusqlite::params![id])
            .map_err(|e| format!("Failed to delete worktree row: {}", e))?;
    }

    app_state.app_handle.emit("worktrees-changed", ()).ok();
    Ok(None)
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
    // Query DB for zombie candidates — lock is released after this block
    let candidates: Vec<(i32, String, String)> = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        let mut stmt = conn.prepare(
            "SELECT w.id, w.path, w.branch_name
             FROM worktrees w
             LEFT JOIN tasks t ON t.id = w.task_id
             WHERE w.project_id = ?1
               AND (w.task_id IS NULL OR t.status IN ('Done', 'Cancelled'))"
        ).map_err(|e| format!("Failed to prepare query: {}", e))?;

        let rows: Vec<(i32, String, String)> = stmt.query_map(rusqlite::params![project_id], |row| {
            Ok((row.get::<_, i32>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?))
        })
        .map_err(|e| format!("Failed to query zombie candidates: {}", e))?
        .filter_map(|r| r.ok())
        .collect();
        rows
    }; // Mutex lock released here

    // A session worktree carries `task_id IS NULL`, so every one of them is a candidate here.
    // What separates a zombie from a live session is whether anything is using the directory,
    // which is checked below — not the row's age.
    if candidates.is_empty() {
        return Ok(0);
    }

    // Resolve project and git connection (local vs remote SSH)
    let (project, git_conn) = crate::core::get_project_with_git_conn(&app_state, project_id).await?;

    // Directories that are in use: running ACP sessions, running PTY shells, and sessions that
    // `prime_project_server` is concurrently restoring from `.maestro/state.json` — this command
    // is triggered on project open, so that restore is still in flight.
    let mut live_cwds: Vec<String> = Vec::new();
    {
        let acp_sessions = app_state.acp.sessions.lock().await;
        live_cwds.extend(acp_sessions.values().map(|process| process.cwd.clone()));
    }
    {
        let pty_meta = app_state.pty.session_meta.lock().await;
        live_cwds.extend(pty_meta.values().map(|meta| meta.cwd.clone()));
    }
    let connection_key = crate::acp::ConnectionKey::from_all_ids(
        project.connection_id,
        project.wsl_connection_id,
        project.docker_connection_id,
    );
    live_cwds.extend(
        crate::project::session_state::read_session_snapshots(&app_state, &project.path, connection_key)
            .await
            .into_iter()
            .map(|snapshot| snapshot.cwd),
    );

    // Get on-disk worktree paths to confirm existence before deleting
    let disk_worktrees = crate::git::list_worktrees(&git_conn).await?;
    let disk_paths: HashSet<String> = disk_worktrees.iter().map(|wt| wt.path.clone()).collect();

    let mut to_delete: Vec<(i32, &str, &str)> = Vec::new();
    for (id, relative_path, branch_name) in &candidates {
        if !crate::models::is_maestro_created_worktree(relative_path) {
            continue;
        }

        let abs_path = format!("{}/{}", repo_path, relative_path);
        if !disk_paths.contains(&abs_path) {
            continue;
        }

        if live_cwds.iter().any(|cwd| path_is_within(cwd, &abs_path)) {
            log::debug!("keeping worktree {}: a session is running in it", abs_path);
            continue;
        }

        match reason_to_keep(&git_conn, &abs_path, branch_name).await {
            Ok(None) => to_delete.push((*id, relative_path.as_str(), branch_name.as_str())),
            Ok(Some(_)) => continue,
            // A git failure says nothing about whether the tree is clean, so keep it.
            Err(e) => {
                log::warn!("keeping worktree {}: safety check failed: {}", abs_path, e);
                continue;
            }
        }
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
            "SELECT p.id, p.name, p.path, p.created_at, p.updated_at, p.last_opened, p.connection_id, p.wsl_connection_id, p.docker_connection_id \
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

#[cfg(test)]
mod tests {
    use super::{branch_has_no_own_commits, canonicalize_repo_path, path_is_within};
    use crate::models::{is_maestro_created_worktree, worktree_path_for_session, worktree_path_for_task};

    #[test]
    fn only_maestro_conventions_count_as_auto_created() {
        assert!(is_maestro_created_worktree(&worktree_path_for_task(7)));
        assert!(is_maestro_created_worktree(&worktree_path_for_session(7)));
        // A hand-made worktree, and the pre-id name-based session path — both must read as
        // user-made so cleanup leaves them alone.
        assert!(!is_maestro_created_worktree("../scratch"));
        assert!(!is_maestro_created_worktree(".maestro/worktrees/maestro/hardy-anchor"));
    }

    #[test]
    fn live_session_cwd_matches_its_worktree() {
        let worktree = "/repo/.maestro/worktrees/session-3";
        assert!(path_is_within(worktree, worktree));
        assert!(path_is_within("/repo/.maestro/worktrees/session-3/", worktree));
        assert!(path_is_within("/repo/.maestro/worktrees/session-3/src", worktree));
        // A prefix that is not a path boundary is a different worktree, not a child.
        assert!(!path_is_within("/repo/.maestro/worktrees/session-30", worktree));
        assert!(!path_is_within("/repo", worktree));
    }

    #[test]
    fn own_commits_detected_from_containing_branches() {
        // Branch tip still shared with main — nothing was committed on it.
        assert!(branch_has_no_own_commits("maestro/foo\nmain\n", "maestro/foo"));
        // Only the branch itself contains the tip — it holds work.
        assert!(!branch_has_no_own_commits("maestro/foo\n", "maestro/foo"));
        assert!(!branch_has_no_own_commits("", "maestro/foo"));
    }

    /// Worktree paths are built as `{repo}/{relative}` strings; an extended-length `\?\` repo
    /// path makes that combination illegal on Windows (os error 123).
    #[test]
    fn canonicalized_repo_path_accepts_forward_slash_children() {
        let repo = std::env::temp_dir().join("maestro_canonicalize_test");
        std::fs::create_dir_all(&repo).expect("create temp repo");

        let canonical = canonicalize_repo_path(&repo.to_string_lossy()).expect("canonicalize");
        assert!(
            !canonical.starts_with(r"\\?\"),
            "extended-length prefix leaked: {canonical}"
        );

        let child = format!("{}/{}", canonical, ".maestro/worktrees");
        let created = std::fs::create_dir_all(&child);
        std::fs::remove_dir_all(&repo).ok();
        created.unwrap_or_else(|e| panic!("create_dir_all({child}) failed: {e}"));
    }
}
