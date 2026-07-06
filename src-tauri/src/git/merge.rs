use std::sync::Arc;
use tauri::{Emitter, State};
use crate::command_ext::NoConsoleWindow;
use chrono::Utc;
use crate::models::{GitConnection, MergeResult};
use crate::core::{AppState, get_project_with_git_conn};
use crate::acp::ConnectionKey;
use crate::git::remote::shell_quote;
use super::exec::{run_git_in_dir, run_git_in_dir_lossy};

/// Squash merge a task branch into main using native Rust subprocess calls.
///
/// This function operates on the local repo path (worktrees are always local even
/// for remote projects). It is NOT dispatched through GitConnection because squash
/// merge targets the local main branch, not a remote path.
///
/// Steps:
/// 1. Checkout main
/// 2. git merge <branch> --squash --no-commit
/// 3. git status --porcelain to detect conflicts
///    4a. If conflicts: abort merge, return conflict list
///    4b. If nothing staged: return error (branches identical)
/// 5. Commit with standardised message
pub async fn squash_merge_to_base(
    conn: &GitConnection,
    branch_name: &str,
    target_branch: &str,
    commit_message: &str,
) -> Result<MergeResult, String> {
    let repo_path = match conn {
        GitConnection::Local { path } => path.as_str(),
        GitConnection::Remote { remote_path, .. } => remote_path.as_str(),
        GitConnection::Wsl { path, .. } => path.as_str(),
    };

    // Step 1: checkout target branch
    run_git_in_dir(conn, repo_path, &["checkout", target_branch])
        .await
        .map_err(|e| format!("git checkout {} failed: {}", target_branch, e))?;

    // Step 2: squash merge (non-zero exit expected on conflicts)
    let _ = run_git_in_dir_lossy(conn, repo_path, &["merge", branch_name, "--squash", "--no-commit"]).await;

    // Step 3: check for conflicts via git status --porcelain
    let status_stdout = run_git_in_dir(conn, repo_path, &["status", "--porcelain"])
        .await
        .map_err(|e| format!("git status failed: {}", e))?;
    let conflicts = parse_conflict_files(&status_stdout);

    // Step 4a: conflicts detected — clean up staged conflict markers and return.
    // Squash merges don't create MERGE_HEAD so `merge --abort` is a no-op here;
    // `reset --hard HEAD` is the correct way to restore the index and working tree.
    if !conflicts.is_empty() {
        let _ = run_git_in_dir_lossy(conn, repo_path, &["reset", "--hard", "HEAD"]).await;
        return Ok(MergeResult {
            success: false,
            task_status: "InProgress".to_string(),
            conflicts,
        });
    }

    // Step 4b: nothing staged — branches may already be identical.
    // Use diff --cached to check staged content specifically (git status --porcelain
    // includes pre-existing unstaged modifications which would give a false positive).
    let staged_output = run_git_in_dir(conn, repo_path, &["diff", "--cached", "--name-only"])
        .await
        .map_err(|e| format!("git diff --cached failed: {}", e))?;

    if staged_output.trim().is_empty() {
        return Err(format!(
            "Nothing to merge: no changes between {} and {}",
            branch_name, target_branch
        ));
    }

    // Step 5: commit with caller-provided message
    run_git_in_dir(conn, repo_path, &["commit", "--no-verify", "-m", commit_message])
        .await
        .map_err(|e| format!("git commit failed: {}", e))?;

    // Step 6: return success
    Ok(MergeResult {
        success: true,
        task_status: "Done".to_string(),
        conflicts: vec![],
    })
}

/// Parse `git status --porcelain` output for merge conflict markers.
///
/// Conflict XY codes: any line where X or Y is 'U' (unmerged), plus 'AA' (both added)
/// and 'DD' (both deleted). Returns a list of conflicting file paths.
fn parse_conflict_files(porcelain_status: &str) -> Vec<String> {
    porcelain_status
        .lines()
        .filter_map(|line| {
            if line.len() < 4 {
                return None;
            }
            let xy = &line[..2];
            // Conflict XY codes: any line where X or Y is 'U', plus AA and DD
            let is_conflict = xy.contains('U') || xy == "AA" || xy == "DD";
            if is_conflict {
                Some(line[3..].to_string())
            } else {
                None
            }
        })
        .collect()
}

// ============================================================================
// Merge automation and conflict handling (from review_handlers)
// ============================================================================

const DEFAULT_COMMIT_TEMPLATE: &str = "\
Merge task #{task_id}: {task_name}

Squash merge {branch} into {target_branch}.";

fn resolve_template(
    template: &str,
    task_id: i32,
    task_name: &str,
    branch: &str,
    target_branch: &str,
    external_id: &str,
    description: &str,
) -> String {
    template
        .replace("{task_id}", &task_id.to_string())
        .replace("{task_name}", task_name)
        .replace("{branch}", branch)
        .replace("{target_branch}", target_branch)
        .replace("{external_id}", external_id)
        .replace("{description}", description)
}

/// Resolve the commit message template for a task.
/// Reads .maestro/commit-template.txt from the project path; falls back to the default template.
/// Returns the resolved string with all variables substituted.
#[tauri::command]
#[specta::specta]
pub async fn resolve_commit_message(
    app_state: State<'_, Arc<AppState>>,
    task_id: i32,
) -> Result<String, String> {
    let (task_name, branch_name, base_branch, external_id, description, project_path, connection_id, wsl_connection_id) = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        conn.query_row(
            "SELECT t.title, w.branch_name, t.base_branch, t.external_id, t.description, p.path, p.connection_id, p.wsl_connection_id
             FROM tasks t
             JOIN worktrees w ON w.id = (SELECT id FROM worktrees WHERE task_id = t.id LIMIT 1)
             JOIN projects p ON p.id = t.project_id
             WHERE t.id = ?",
            [task_id],
            |row| Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, Option<i32>>(6)?,
                row.get::<_, Option<i32>>(7)?,
            )),
        )
        .map_err(|e| format!("Task/worktree/project not found: {}", e))?
    };

    let template_path = format!("{}/.maestro/commit-template.txt", project_path);
    let connection_key = ConnectionKey::from_ids(connection_id, wsl_connection_id);
    let template = match connection_key {
        ConnectionKey::Local => {
            std::fs::read_to_string(&template_path)
                .unwrap_or_else(|_| DEFAULT_COMMIT_TEMPLATE.to_string())
        }
        ConnectionKey::Ssh { id: conn_id } => {
            match app_state.ssh.get_session(conn_id).await {
                Some(session) => {
                    session.execute_command(&format!("cat {}", shell_quote(&template_path)))
                        .await
                        .unwrap_or_else(|_| DEFAULT_COMMIT_TEMPLATE.to_string())
                }
                None => DEFAULT_COMMIT_TEMPLATE.to_string(),
            }
        }
        ConnectionKey::Wsl { id: wsl_id } => {
            let distro_result: Result<String, String> = {
                let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
                conn.query_row(
                    "SELECT distro_name FROM wsl_connections WHERE id = ?",
                    rusqlite::params![wsl_id],
                    |row| row.get(0),
                ).map_err(|e| format!("WSL connection not found: {}", e))
            };
            match distro_result {
                Ok(distro) => {
                    let output = tokio::process::Command::new("wsl.exe")
                        .args(["-d", &distro, "--", "cat", &template_path])
                        .stdout(std::process::Stdio::piped())
                        .stderr(std::process::Stdio::piped())
                        .no_console_window()
                        .output()
                        .await
                        .ok();
                    match output {
                        Some(out) if out.status.success() => {
                            String::from_utf8_lossy(&out.stdout).into_owned()
                        }
                        _ => DEFAULT_COMMIT_TEMPLATE.to_string(),
                    }
                }
                Err(_) => DEFAULT_COMMIT_TEMPLATE.to_string(),
            }
        }
    };

    let external_id_str = external_id.unwrap_or_default();
    let description_str = description
        .unwrap_or_default()
        .lines()
        .next()
        .unwrap_or("")
        .to_string();

    Ok(resolve_template(
        &template,
        task_id,
        &task_name,
        &branch_name,
        &base_branch,
        &external_id_str,
        &description_str,
    ))
}

/// Approve task and perform synchronous merge to main branch
///
/// Orchestrates the complete merge workflow synchronously:
/// 1. Queries task details and worktree info
/// 2. Calls native Rust squash merge via git subprocess (awaits completion)
/// 3. On success: updates task to "Done", cleans up worktree, returns to pool
/// 4. On conflict: rejects task back to "InProgress", saves conflict feedback
///
/// Returns a typed MergeResult with success flag, task_status, and conflicts.
#[tauri::command]
#[specta::specta]
pub async fn approve_task_and_merge(
    app_state: State<'_, Arc<AppState>>,
    task_id: i32,
    merge_strategy: String,
    include_untracked: bool,
    commit_message: String,
) -> Result<MergeResult, String> {

    // 1. Single JOIN query to get task, worktree, and project data
    let (branch_name, worktree_path, worktree_id, project_id, repo_path, base_branch) = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        conn.query_row(
            "SELECT w.branch_name, w.path, w.id, t.project_id, p.path, t.base_branch
             FROM tasks t
             JOIN worktrees w ON w.id = (SELECT id FROM worktrees WHERE task_id = t.id LIMIT 1)
             JOIN projects p ON p.id = t.project_id
             WHERE t.id = ?",
            [task_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, i32>(2)?, row.get::<_, i32>(3)?, row.get::<_, String>(4)?, row.get::<_, String>(5)?)),
        )
        .map_err(|e| format!("Task, worktree, or project not found: {}", e))?
    };

    // 2. Resolve git connection for this project
    let (_project, git_conn) = get_project_with_git_conn(app_state.inner(), project_id).await
        .map_err(|e| format!("Failed to get git connection: {}", e))?;

    // 3. Build full worktree path
    let full_worktree_path = format!("{}/{}", repo_path, worktree_path);

    // 3a. Stage and commit modified tracked files (agents may modify without committing)
    run_git_in_dir(&git_conn, &full_worktree_path, &["add", "-u"]).await
        .map_err(|e| format!("Failed to stage modified files: {}", e))?;

    // 3b. Also stage untracked files if user opted in
    if include_untracked {
        let untracked_output = run_git_in_dir(
            &git_conn, &full_worktree_path,
            &["ls-files", "--others", "--exclude-standard"],
        ).await.unwrap_or_default();

        let untracked_files: Vec<&str> = untracked_output
            .lines()
            .filter(|line| !line.is_empty())
            .collect();

        if !untracked_files.is_empty() {
            let mut add_args = vec!["add", "--"];
            add_args.extend(untracked_files.iter().copied());
            run_git_in_dir(&git_conn, &full_worktree_path, &add_args).await
                .map_err(|e| format!("Failed to stage untracked files: {}", e))?;
        }
    }

    // 3c. Commit everything staged (modified + untracked if included)
    let staged_output = run_git_in_dir(
        &git_conn, &full_worktree_path,
        &["diff", "--cached", "--name-only"],
    ).await.unwrap_or_default();

    if !staged_output.trim().is_empty() {
        run_git_in_dir(
            &git_conn, &full_worktree_path,
            &["commit", "--no-verify", "-m", &commit_message],
        ).await.map_err(|e| format!("Failed to commit changes: {}", e))?;
    }

    if merge_strategy == "CommitOnly" {
        app_state.app_handle.emit("tasks-changed", ()).ok();
        return Ok(MergeResult {
            success: true,
            task_status: "Review".to_string(),
            conflicts: vec![],
        });
    }

    // 4. Perform squash merge via git dispatcher (local, SSH, or WSL)
    let merge_result = squash_merge_to_base(
        &git_conn,
        &branch_name,
        &base_branch,
        &commit_message,
    ).await?;

    if merge_result.success {
        // 4a. Merge succeeded - finalize (mark Done, cleanup worktree)
        finalize_successful_merge(
            app_state.inner(),
            task_id,
            worktree_id,
            &full_worktree_path,
            &branch_name,
        )
        .await?;
        app_state.app_handle.emit("tasks-changed", ()).ok();
        app_state.app_handle.emit("worktrees-changed", ()).ok();
        Ok(MergeResult { success: true, task_status: "Done".to_string(), conflicts: vec![] })
    } else if !merge_result.conflicts.is_empty() {
        // 4b. Merge had conflicts - reject back to InProgress
        reject_merge_on_conflict(app_state.inner(), task_id, &merge_result.conflicts).await?;
        Ok(merge_result)
    } else {
        // 4c. Merge reported failure without conflicts - return error
        Err("Merge failed with unknown error".to_string())
    }
}

/// Finalize successful merge: update task to Done, cleanup worktree from disk, delete from DB
///
/// Helper function (private crate-level) called after successful merge to perform cleanup:
/// 1. Updates task status to Done
/// 2. Deletes worktree from disk via Rust git dispatcher
/// 3. Removes worktree from database on successful cleanup
pub(crate) async fn finalize_successful_merge(
    app_state: &Arc<AppState>,
    task_id: i32,
    worktree_id: i32,
    worktree_path: &str,
    branch_name: &str,
) -> Result<(), String> {
    // Note: DB writes are intentionally split across lock acquisitions because async
    // git cleanup happens between task update and worktree deletion. If the process
    // crashes between these steps, cleanup_zombie_worktrees handles recovery.

    // 1. Update task status to Done
    {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        let now = Utc::now().to_rfc3339();

        conn.execute(
            "UPDATE tasks SET status = 'Done', updated_at = ? WHERE id = ?",
            rusqlite::params![&now, task_id],
        )
        .map_err(|e| format!("Update task failed: {}", e))?;
    }

    // 2. Delete worktree from disk via git dispatcher (and DB on success)
    // Resolve git connection for this project
    let project_id = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        conn.query_row(
            "SELECT project_id FROM worktrees WHERE id = ?",
            rusqlite::params![worktree_id],
            |row| row.get::<_, i32>(0),
        ).map_err(|e| format!("Worktree {} not found: {}", worktree_id, e))?
    };
    let (_project, git_conn) = get_project_with_git_conn(app_state, project_id).await
        .map_err(|e| format!("Failed to get git connection: {}", e))?;

    match crate::git::delete_worktree(&git_conn, worktree_path).await {
        Ok(()) => {
            // Delete branch — non-fatal, best effort
            let _ = run_git_in_dir(&git_conn, git_conn.path(), &["branch", "-D", branch_name]).await;
            // Delete from database on successful cleanup
            {
                let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
                conn.execute(
                    "DELETE FROM worktrees WHERE id = ?",
                    rusqlite::params![worktree_id],
                )
                .map_err(|e| format!("Failed to delete worktree from DB: {}", e))?;
            }
        }
        Err(_e) => {
            // Cleanup failed — zombie cleanup will retry
        }
    }

    Ok(())
}

/// Reject a merge and move task back to InProgress with conflict feedback
///
/// Helper function (private crate-level) called when merge conflicts are detected:
/// 1. Updates task status back to InProgress for the agent to rework
/// 2. Creates a RequestChanges review with formatted conflict feedback
///
/// Provides visibility to reviewers about which files had conflicts.
pub(crate) async fn reject_merge_on_conflict(
    app_state: &Arc<AppState>,
    task_id: i32,
    conflicts: &[String],
) -> Result<(), String> {
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
    let now = Utc::now().to_rfc3339();
    let conflict_feedback = format!("Merge conflict detected:\n{}", conflicts.join("\n"));

    // Auto-reject to InProgress per CONTEXT.md decision
    conn.execute(
        "UPDATE tasks SET status = 'InProgress', updated_at = ? WHERE id = ?",
        rusqlite::params![&now, task_id],
    )
    .map_err(|e| format!("Update task failed: {}", e))?;

    // Save conflict feedback as review comment for visibility
    conn.execute(
        "INSERT INTO task_reviews (task_id, decision, general_feedback, created_at)
         VALUES (?, 'RequestChanges', ?, ?)",
        rusqlite::params![task_id, &conflict_feedback, &now],
    )
    .map_err(|e| format!("Save feedback failed: {}", e))?;

    app_state.app_handle.emit("tasks-changed", ()).ok();
    Ok(())
}
