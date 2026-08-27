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

    // Only for a path on this machine: everywhere else `git worktree add` creates the parents
    // itself, and doing it here would build the tree on the host under a foreign path.
    if git_conn.is_on_this_machine() {
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
        crate::git::prune_remote_refs(&git_conn).await;
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
pub fn path_is_within(cwd: &str, worktree_path: &str) -> bool {
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

/// Directories that are in use: running ACP sessions, running PTY shells, and sessions that
/// `prime_project_server` may still be restoring from `.maestro/state.json`.
pub async fn live_session_cwds(
    app_state: &Arc<AppState>,
    project: &crate::models::Project,
) -> Vec<String> {
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
        crate::project::session_state::read_session_snapshots(app_state, &project.path, connection_key)
            .await
            .into_iter()
            .map(|snapshot| snapshot.cwd),
    );
    live_cwds
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

    let live_cwds = live_session_cwds(&app_state, &project).await;

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

    // Once for the batch, not once per worktree — it goes to the network.
    if !to_delete.is_empty() {
        crate::git::prune_remote_refs(&git_conn).await;
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

/// Throw away everything a task's run produced: its worktree, its branch, and the commits it
/// left on the project path when it ran without one.
///
/// Every git step is best-effort on purpose. The caller has already decided the work is being
/// discarded, so a worktree that is gone from disk, a branch that was never created, or a repo
/// that has moved on must not leave the task wedged in a half-cleaned state — the DB row removal
/// and the read of the task row are the only steps that must succeed.
///
/// The branch is deleted with `-D`, not `-d`: the whole point is to discard unmerged work, so a
/// safe delete would refuse in exactly the case this is called for.
pub async fn discard_task_workspace(
    app_state: &Arc<AppState>,
    task_id: i32,
) -> Result<(), String> {
    // Gather worktree and task info while holding the lock briefly
    let (worktree_info, execution_start_sha, project_id) = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;

        // Query associated worktree
        let wt: Option<(i32, String, String)> = conn.query_row(
            "SELECT id, path, branch_name FROM worktrees WHERE task_id = ?",
            rusqlite::params![task_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).ok();

        // Get execution_start_sha and project_id from task
        let (sha, pid): (Option<String>, i32) = conn.query_row(
            "SELECT execution_start_sha, project_id FROM tasks WHERE id = ?",
            rusqlite::params![task_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        ).map_err(|e| format!("Failed to read task: {}", e))?;

        (wt, sha, pid)
    };

    // Perform async git cleanup outside the DB lock
    if let Some((worktree_id, worktree_path, branch_name)) = worktree_info {
        let (_project, git_conn) = crate::core::get_project_with_git_conn(app_state, project_id).await?;

        // Remove worktree from disk (best effort)
        let _ = crate::git::delete_worktree(&git_conn, &worktree_path).await;

        // Delete branch (best effort)
        let _ = crate::git::run_git_in_dir_lossy(
            &git_conn,
            git_conn.path(),
            &["branch", "-D", &branch_name],
        )
        .await;

        // Delete worktree DB row
        {
            let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
            conn.execute(
                "DELETE FROM worktrees WHERE id = ?",
                rusqlite::params![worktree_id],
            )
            .map_err(|e| format!("Failed to delete worktree: {}", e))?;
        }

        app_state.app_handle.emit("worktrees-changed", ()).ok();
    } else if execution_start_sha.is_some() {
        // A task with no worktree row used to be rolled back in place here: `reset --hard` to its
        // start sha, then `checkout -- .` and `clean -fd` on the *project* path.
        //
        // That is not survivable now. Worktrees are enforced wherever git is available, so the
        // only tasks that reach this arm are legacy or corrupt rows — and this function is now
        // reached from Stop, a single click on a card, where it previously only ran behind the
        // Discard confirmation. Wiping every uncommitted change in the user's actual checkout,
        // including work belonging to no task at all, is a far worse outcome than leaving a
        // stale branch behind.
        log::warn!(
            "[git] task {} has no worktree to discard; leaving the project tree untouched",
            task_id
        );
    }

    // Clear execution_start_sha now that cleanup is done
    {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        conn.execute(
            "UPDATE tasks SET execution_start_sha = NULL WHERE id = ?",
            rusqlite::params![task_id],
        ).ok();
    }

    Ok(())
}

// ============================================================================
// Stale branch pruning
// ============================================================================

/// Namespace every branch Maestro creates for itself lives under — sessions from
/// `SpawnSessionDialog` and tasks from `useExecuteTask`, both through `MAESTRO_BRANCH_PREFIX`
/// in `generateSessionName.ts`.
///
/// This prefix is the entire basis on which a branch may be deleted here. A branch outside it
/// is indistinguishable from one the user made by hand, so it is never a candidate; anything a
/// future feature creates inside it becomes prunable the moment it does.
const MAESTRO_BRANCH_PREFIX: &str = "maestro/";
const LOCAL_MAESTRO_REF_PREFIX: &str = "refs/heads/maestro/";
const REMOTE_MAESTRO_REF_PREFIX: &str = "refs/remotes/origin/maestro/";

/// A Maestro branch with no worktree and nothing on origin holding it — the only kind this
/// offers to delete.
///
/// `commits` and `diff_stat` are filled for unmerged branches only. For a merged branch they
/// would describe an empty range, and it is on the unmerged ones that the user needs to see
/// what deleting would throw away.
#[derive(Debug, Clone, serde::Serialize, specta::Type)]
pub struct PrunableBranch {
    pub name: String,
    /// False when `git branch -d` would refuse it, i.e. its commits live on no other ref.
    pub merged: bool,
    pub last_commit_at: String,
    pub commits: u32,
    pub diff_stat: Option<String>,
}

/// Maestro branches safe to offer for deletion, from raw git output.
///
/// `all_refs` is `for-each-ref --format=%(refname)%09%(committerdate:iso-strict)` over both the
/// local and the origin namespaces; `merged_refs` the same restricted to `--merged HEAD`;
/// `checked_out` the branch names git reports against a worktree.
///
/// Full refnames rather than `%(refname:short)` because a local `maestro/x` and a remote
/// `origin/maestro/x` shorten into two names that no longer say which namespace they came from.
fn prunable_maestro_branches(
    all_refs: &str,
    merged_refs: &str,
    checked_out: &HashSet<String>,
) -> Vec<PrunableBranch> {
    let merged: HashSet<&str> = merged_refs
        .lines()
        .filter_map(|line| line.trim().strip_prefix(LOCAL_MAESTRO_REF_PREFIX))
        .filter(|name| !name.is_empty())
        .collect();

    let mut remotes: HashSet<&str> = HashSet::new();
    let mut locals: Vec<(&str, &str)> = Vec::new();
    for line in all_refs.lines() {
        let (refname, committed_at) = match line.trim_end().split_once('\t') {
            Some(pair) => pair,
            None => (line.trim_end(), ""),
        };
        // The trailing slash is load-bearing: `for-each-ref refs/heads/maestro` also matches a
        // branch named exactly `maestro`, which is somebody's own branch and not one of ours.
        if let Some(name) = refname.strip_prefix(LOCAL_MAESTRO_REF_PREFIX) {
            if !name.is_empty() {
                locals.push((name, committed_at));
            }
        } else if let Some(name) = refname.strip_prefix(REMOTE_MAESTRO_REF_PREFIX) {
            if !name.is_empty() {
                remotes.insert(name);
            }
        }
    }

    let mut candidates: Vec<PrunableBranch> = locals
        .into_iter()
        .filter(|(name, _)| !remotes.contains(name))
        .filter_map(|(name, committed_at)| {
            let full_name = format!("{}{}", MAESTRO_BRANCH_PREFIX, name);
            if checked_out.contains(&full_name) {
                return None;
            }
            Some(PrunableBranch {
                name: full_name,
                merged: merged.contains(name),
                last_commit_at: committed_at.to_string(),
                commits: 0,
                diff_stat: None,
            })
        })
        .collect();
    candidates.sort_by(|a, b| a.name.cmp(&b.name));
    candidates
}

/// Fill `commits` and `diff_stat` on the unmerged candidates.
///
/// One batch for the whole set rather than two calls per branch: on WSL, SSH and Docker every
/// git invocation costs a full interop spawn, and this runs whenever the Worktrees tab opens.
/// Best-effort throughout — a branch whose stats cannot be read still lists, just without them.
async fn fill_unmerged_branch_stats(
    git_conn: &crate::models::GitConnection,
    candidates: &mut [PrunableBranch],
) {
    let unmerged: Vec<usize> = candidates
        .iter()
        .enumerate()
        .filter(|(_, candidate)| !candidate.merged)
        .map(|(index, _)| index)
        .collect();
    if unmerged.is_empty() {
        return;
    }

    // Three dots for the diff so it reads from the merge base — what the branch adds, not what
    // HEAD has moved on to since.
    let ranges: Vec<(String, String)> = unmerged
        .iter()
        .map(|&index| {
            let name = &candidates[index].name;
            (format!("HEAD..{}", name), format!("HEAD...{}", name))
        })
        .collect();
    let commands: Vec<Vec<&str>> = ranges
        .iter()
        .flat_map(|(commit_range, diff_range)| {
            [
                vec!["rev-list", "--count", commit_range.as_str()],
                vec!["diff", "--shortstat", diff_range.as_str()],
            ]
        })
        .collect();
    let command_refs: Vec<&[&str]> = commands.iter().map(|args| args.as_slice()).collect();

    let outputs = crate::git::run_git_commands_lossy(git_conn, git_conn.path(), &command_refs).await;

    for (position, &index) in unmerged.iter().enumerate() {
        candidates[index].commits = outputs
            .get(position * 2)
            .and_then(|raw| raw.trim().parse::<u32>().ok())
            .unwrap_or(0);
        candidates[index].diff_stat = outputs
            .get(position * 2 + 1)
            .map(|raw| raw.trim())
            .filter(|raw| !raw.is_empty())
            .map(str::to_string);
    }
}

/// Session branches this project could prune right now.
///
/// Deliberately does no network call. `git remote prune origin` would be an `ls-remote` round
/// trip on a query that refetches every time the Worktrees tab is opened, and a remote-tracking
/// ref left stale only ever causes a branch to be *kept* — the safe direction. The
/// `prune_remote_refs` calls that already follow every worktree deletion clear those refs at the
/// point a Maestro branch actually becomes orphaned.
#[tauri::command]
#[specta::specta]
pub async fn list_prunable_branches(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
) -> Result<Vec<PrunableBranch>, String> {
    let (_project, git_conn) = crate::core::get_project_with_git_conn(&app_state, project_id).await?;

    let mut outputs = crate::git::run_git_commands_lossy(
        &git_conn,
        git_conn.path(),
        &[
            &[
                "for-each-ref",
                "--format=%(refname)%09%(committerdate:iso-strict)",
                "refs/heads/maestro",
                "refs/remotes/origin/maestro",
            ],
            // The predicate `git branch -d` itself applies: with no upstream on any of these
            // branches, it falls back to asking whether HEAD contains them.
            &["for-each-ref", "--format=%(refname)", "--merged", "HEAD", "refs/heads/maestro"],
            &["worktree", "list", "--porcelain"],
        ],
    )
    .await
    .into_iter();

    let all_refs = outputs.next().unwrap_or_default();
    let merged_refs = outputs.next().unwrap_or_default();
    let worktree_list = outputs.next().unwrap_or_default();

    let checked_out: HashSet<String> = crate::git::parse_worktree_list(&worktree_list)
        .into_iter()
        .filter_map(|worktree| worktree.branch)
        .collect();

    let mut candidates = prunable_maestro_branches(&all_refs, &merged_refs, &checked_out);
    fill_unmerged_branch_stats(&git_conn, &mut candidates).await;
    Ok(candidates)
}

/// Delete the Maestro branches the user selected, with `-D` when they opted into losing
/// unmerged work and `-d` otherwise.
///
/// Every name is re-checked here rather than trusted: the caller sends a selection, not an
/// authorisation, and `-D` on an arbitrary branch name would be unrecoverable.
#[tauri::command]
#[specta::specta]
pub async fn prune_branches(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    branches: Vec<String>,
    force: bool,
) -> Result<Vec<String>, String> {
    let (_project, git_conn) = crate::core::get_project_with_git_conn(&app_state, project_id).await?;

    let checked_out: HashSet<String> = crate::git::list_worktrees(&git_conn)
        .await?
        .into_iter()
        .filter_map(|worktree| worktree.branch)
        .collect();

    let delete_flag = if force { "-D" } else { "-d" };
    let mut deleted: Vec<String> = Vec::new();
    for branch in &branches {
        match branch.strip_prefix(MAESTRO_BRANCH_PREFIX) {
            Some(rest) if !rest.is_empty() => {}
            _ => {
                log::warn!("[git] refusing to prune '{branch}': not a Maestro branch");
                continue;
            }
        }
        // A session may have been spawned onto this branch since the dialog was opened.
        if checked_out.contains(branch) {
            log::debug!("[git] keeping {branch}: checked out in a worktree");
            continue;
        }
        match crate::git::run_git_in_dir(&git_conn, git_conn.path(), &["branch", delete_flag, branch]).await {
            Ok(_) => deleted.push(branch.clone()),
            Err(e) => log::warn!("[git] could not delete {branch}: {e}"),
        }
    }

    Ok(deleted)
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use super::{branch_has_no_own_commits, canonicalize_repo_path, path_is_within, prunable_maestro_branches};
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

    /// Every reason a Maestro branch must not be offered for deletion, against the real shape of
    /// `for-each-ref` output.
    ///
    /// Task branches (`maestro/<id>-<slug>`) and session branches (`maestro/<slug>-<id>`) are
    /// treated alike on purpose: the namespace is the whole contract, and nothing here knows or
    /// needs to know which kind it is looking at.
    #[test]
    fn only_orphaned_maestro_branches_are_prunable() {
        let all_refs = concat!(
            // Matched by the `refs/heads/maestro` refspec, but somebody's own branch.
            "refs/heads/maestro\t2026-08-01T10:00:00+02:00\n",
            "refs/heads/maestro/kind-heath-19\t2026-08-20T09:30:00+02:00\n",
            // A session is sitting in its worktree.
            "refs/heads/maestro/true-sky-22\t2026-08-26T11:00:00+02:00\n",
            // Pushed — origin still holds it.
            "refs/heads/maestro/rapid-hollow-17\t2026-08-10T08:00:00+02:00\n",
            "refs/remotes/origin/maestro/rapid-hollow-17\t2026-08-10T08:00:00+02:00\n",
            // A task branch whose worktree is gone, and one still checked out.
            "refs/heads/maestro/41-prune-stale-branches\t2026-08-27T07:15:00+02:00\n",
            "refs/heads/maestro/42-fix-the-thing\t2026-08-27T09:00:00+02:00\n",
            // Outside the namespace: a task branch from before the prefix existed.
            "refs/heads/12-legacy-task\t2026-07-01T09:00:00+02:00\n",
        );
        let merged_refs = "refs/heads/maestro/kind-heath-19\nrefs/heads/maestro/true-sky-22\n";
        let checked_out = HashSet::from([
            "main".to_string(),
            "maestro/true-sky-22".to_string(),
            "maestro/42-fix-the-thing".to_string(),
        ]);

        let names: Vec<String> = prunable_maestro_branches(all_refs, merged_refs, &checked_out)
            .into_iter()
            .map(|branch| branch.name)
            .collect();
        assert_eq!(
            names,
            vec!["maestro/41-prune-stale-branches", "maestro/kind-heath-19"]
        );
    }

    #[test]
    fn merge_state_and_commit_date_come_from_git() {
        let all_refs = concat!(
            "refs/heads/maestro/kind-heath-19\t2026-08-20T09:30:00+02:00\n",
            "refs/heads/maestro/scratch-test\t2026-08-27T07:15:00+02:00\n",
        );
        let merged_refs = "refs/heads/maestro/kind-heath-19\n";

        let candidates = prunable_maestro_branches(all_refs, merged_refs, &HashSet::new());
        assert_eq!(candidates.len(), 2);
        assert!(candidates[0].merged);
        assert_eq!(candidates[0].last_commit_at, "2026-08-20T09:30:00+02:00");
        // Stats stay empty until `fill_unmerged_branch_stats` fills them from a second batch.
        assert!(!candidates[1].merged);
        assert_eq!(candidates[1].commits, 0);
        assert_eq!(candidates[1].diff_stat, None);
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
