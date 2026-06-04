use std::sync::Arc;
use tauri::{Emitter, State};
use crate::command_ext::NoConsoleWindow;
use chrono::Utc;

use crate::models::{Project, Task, TASK_SELECT, ReviewResult, MergeResult, TaskReviewWithComments, ReviewCommentEntry};
use crate::core::{AppState, get_git_connection, get_project_with_git_conn};
use crate::git;

/// Insert (or replace) a review record with optional per-file comments.
/// Uses INSERT OR REPLACE to handle the UNIQUE(task_id) constraint —
/// old review_comments are CASCADE-deleted when the review row is replaced.
/// Returns the review_id of the newly inserted record.
fn insert_review_with_comments(
    conn: &rusqlite::Connection,
    task_id: i32,
    decision: &str,
    general_feedback: Option<&str>,
    per_file_comments: Option<&[(String, String)]>,
    now: &str,
) -> Result<i32, String> {
    conn.execute(
        "INSERT OR REPLACE INTO task_reviews (task_id, decision, general_feedback, reviewed_at, created_at) VALUES (?, ?, ?, ?, ?)",
        rusqlite::params![task_id, decision, general_feedback, now, now],
    ).map_err(|e| format!("Insert review failed: {}", e))?;

    let review_id = conn.last_insert_rowid() as i32;

    if let Some(comments) = per_file_comments {
        for (file_path, comment) in comments {
            conn.execute(
                "INSERT INTO review_comments (review_id, file_path, comment, created_at) VALUES (?, ?, ?, ?)",
                rusqlite::params![review_id, file_path, comment, now],
            ).map_err(|e| format!("Insert comment failed: {}", e))?;
        }
    }

    Ok(review_id)
}

/// Get diff for review: generates unified diff between task branch and main
///
/// For local projects, uses git dispatcher directly.
/// For remote projects, uses git dispatcher over SSH.
///
/// Returns the unified diff as a string with 6 context lines.
#[tauri::command]
#[specta::specta]
pub async fn get_diff_for_review(
    app_state: State<'_, Arc<AppState>>,
    task_id: i32,
) -> Result<String, String> {
    // 1. Single JOIN query to get all needed data
    let (project, worktree_path, branch_name) = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        let (proj_id, proj_name, proj_path, proj_created, proj_updated, proj_last_opened, proj_conn_id, wt_path, branch): (i32, String, String, String, String, Option<String>, Option<i32>, String, String) = conn
            .query_row(
                "SELECT t.project_id, p.name, p.path, p.created_at, p.updated_at, p.last_opened, p.connection_id, w.path, w.branch_name
                 FROM tasks t
                 JOIN projects p ON p.id = t.project_id
                 JOIN worktrees w ON w.task_id = t.id
                 WHERE t.id = ?",
                rusqlite::params![task_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?, row.get(7)?, row.get(8)?)),
            )
            .map_err(|e| format!("Task/project/worktree not found: {}", e))?;

        let project = Project {
            id: proj_id,
            name: proj_name,
            path: proj_path,
            created_at: proj_created,
            updated_at: proj_updated,
            last_opened: proj_last_opened,
            connection_id: proj_conn_id,
            wsl_connection_id: None,
        };
        (project, wt_path, branch)
    };

    // 2. Handle diff generation based on project type
    if project.is_remote() {
        // Remote project: use git dispatcher which executes over SSH
        let git_conn = get_git_connection(&project, &app_state)
            .await
            .map_err(|e| format!("Failed to get git connection: {}", e))?;

        let diff = git::git_diff(&git_conn, &branch_name, "main")
            .await
            .map_err(|e| format!("Failed to get diff from remote: {}", e))?;

        Ok(diff)
    } else {
        // Local project: use git dispatcher directly
        let full_worktree_path = format!("{}/{}", project.path, worktree_path);
        let _ = full_worktree_path; // used above for context

        let git_conn = crate::models::GitConnection::Local { path: project.path.clone() };
        let diff = git::git_diff(&git_conn, &branch_name, "main")
            .await
            .map_err(|e| format!("Failed to get diff: {}", e))?;

        Ok(diff)
    }
}

/// Save task review with feedback and per-file comments
///
/// Creates a new review record with decision (Approve, RequestChanges, etc.)
/// and optional general feedback. Per-file comments are stored separately
/// linked to the review record.
///
/// Returns a typed ReviewResult with success flag and review_id.
#[tauri::command]
#[specta::specta]
pub async fn save_task_review(
    app_state: State<'_, Arc<AppState>>,
    task_id: i32,
    decision: String,
    general_feedback: Option<String>,
    per_file_comments: Option<Vec<(String, String)>>,
) -> Result<ReviewResult, String> {
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
    let now = Utc::now().to_rfc3339();
    let comments_ref = per_file_comments.as_deref();
    let review_id = insert_review_with_comments(
        &conn, task_id, &decision, general_feedback.as_deref(), comments_ref, &now,
    )?;

    Ok(ReviewResult { success: true, review_id, task_status: None })
}

/// Request changes on a task: saves feedback and moves task back to InProgress
///
/// Creates a RequestChanges review with general feedback and per-file comments,
/// then transitions the task status back to InProgress for the agent to rework.
///
/// Returns a typed ReviewResult with success flag, review_id, and updated task_status.
#[tauri::command]
#[specta::specta]
pub async fn request_changes(
    app_state: State<'_, Arc<AppState>>,
    task_id: i32,
    general_feedback: Option<String>,
    per_file_comments: Option<Vec<(String, String)>>,
) -> Result<ReviewResult, String> {
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
    let now = Utc::now().to_rfc3339();
    let comments_ref = per_file_comments.as_deref();
    let review_id = insert_review_with_comments(
        &conn, task_id, "RequestChanges", general_feedback.as_deref(), comments_ref, &now,
    )?;
    conn.execute(
        "UPDATE tasks SET status = 'InProgress', updated_at = ? WHERE id = ?",
        rusqlite::params![&now, task_id],
    ).map_err(|e| format!("Update task status failed: {}", e))?;

    app_state.app_handle.emit("tasks-changed", ()).ok();
    Ok(ReviewResult { success: true, review_id, task_status: Some("InProgress".to_string()) })
}

/// Get the current review (with comments) for a task
#[tauri::command]
#[specta::specta]
pub async fn get_task_review(
    app_state: State<'_, Arc<AppState>>,
    task_id: i32,
) -> Result<Option<TaskReviewWithComments>, String> {
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;

    let review = conn.query_row(
        "SELECT id, decision, general_feedback, created_at FROM task_reviews WHERE task_id = ?",
        [task_id],
        |row| Ok((row.get::<_, i32>(0)?, row.get::<_, String>(1)?, row.get::<_, Option<String>>(2)?, row.get::<_, String>(3)?)),
    ).ok();

    let Some((review_id, decision, general_feedback, created_at)) = review else {
        return Ok(None);
    };

    let mut stmt = conn.prepare(
        "SELECT file_path, comment FROM review_comments WHERE review_id = ?"
    ).map_err(|e| format!("Prepare failed: {}", e))?;

    let comments: Vec<ReviewCommentEntry> = stmt.query_map([review_id], |row| {
        Ok(ReviewCommentEntry { file_path: row.get(0)?, comment: row.get(1)? })
    }).map_err(|e| format!("Query failed: {}", e))?
      .filter_map(|r| r.ok())
      .collect();

    Ok(Some(TaskReviewWithComments { decision, general_feedback, comments, created_at }))
}

// ============================================================================
// Merge Automation and Conflict Handling
// ============================================================================

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
) -> Result<MergeResult, String> {
    let _ = merge_strategy;

    // 1. Single JOIN query to get task, worktree, and project data
    let (task_name, branch_name, worktree_path, worktree_id, project_id, repo_path) = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        conn.query_row(
            "SELECT t.title, w.branch_name, w.path, w.id, t.project_id, p.path
             FROM tasks t
             JOIN worktrees w ON w.id = (SELECT id FROM worktrees WHERE task_id = t.id LIMIT 1)
             JOIN projects p ON p.id = t.project_id
             WHERE t.id = ?",
            [task_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, i32>(3)?, row.get::<_, i32>(4)?, row.get::<_, String>(5)?)),
        )
        .map_err(|e| format!("Task, worktree, or project not found: {}", e))?
    };

    // 2. Resolve git connection for this project
    let (_project, git_conn) = get_project_with_git_conn(app_state.inner(), project_id).await
        .map_err(|e| format!("Failed to get git connection: {}", e))?;

    // 3. Build full worktree path
    let full_worktree_path = format!("{}/{}", repo_path, worktree_path);

    // 4. Perform squash merge via git dispatcher (local, SSH, or WSL)
    let merge_result = git::squash_merge_to_main(
        &git_conn,
        task_id,
        &branch_name,
        &task_name,
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
            match &git_conn {
                crate::models::GitConnection::Local { path } => {
                    let _ = tokio::process::Command::new("git")
                        .args(["branch", "-D", branch_name])
                        .current_dir(path)
                        .no_console_window()
                        .output()
                        .await;
                }
                crate::models::GitConnection::Remote { ssh, remote_path } => {
                    let cmd = format!(
                        "git -C {} branch -D {}",
                        crate::git::remote::shell_quote(remote_path),
                        crate::git::remote::shell_quote(branch_name)
                    );
                    let _ = ssh.execute_command(&cmd).await;
                }
                crate::models::GitConnection::Wsl { distro, path } => {
                    let _ = tokio::process::Command::new("wsl.exe")
                        .args(["-d", distro, "--", "git", "-C", path, "branch", "-D", branch_name])
                        .no_console_window()
                        .output()
                        .await;
                }
            }
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

/// Reject a task in review with one of three actions
///
/// Handles the three rejection paths from the review panel:
/// - "SendToBacklog": moves task back to Backlog, deletes worktree, resets agent commits
/// - "ResumeWithInstructions": moves task to InProgress and saves instruction for the agent
/// - "CancelTask": moves task to Cancelled, deletes worktree, resets agent commits
///
/// Returns the updated Task.
#[tauri::command]
#[specta::specta]
pub async fn reject_review(
    app_state: State<'_, Arc<AppState>>,
    task_id: i32,
    action: String,
    instruction: Option<String>,
) -> Result<Task, String> {
    let now = Utc::now().to_rfc3339();

    match action.as_str() {
        "SendToBacklog" | "CancelTask" => {
            let new_status = if action == "SendToBacklog" { "Backlog" } else { "Cancelled" };

            // Gather worktree and task info while holding the lock briefly
            let (worktree_info, execution_start_sha, project_id) = {
                let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;

                // Update task status
                conn.execute(
                    &format!("UPDATE tasks SET status = '{}', updated_at = ? WHERE id = ?", new_status),
                    rusqlite::params![&now, task_id],
                )
                .map_err(|e| format!("Failed to update task status: {}", e))?;

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
                // Delete the worktree (same logic as delete_worktree_for_task)
                let (_project, git_conn) = get_project_with_git_conn(&app_state, project_id).await?;

                // Remove worktree from disk (best effort)
                let _ = crate::git::delete_worktree(&git_conn, &worktree_path).await;

                // Delete branch (best effort)
                match &git_conn {
                    crate::models::GitConnection::Local { path } => {
                        let _ = tokio::process::Command::new("git")
                            .args(["branch", "-D", &branch_name])
                            .current_dir(path)
                            .no_console_window()
                            .output()
                            .await;
                    }
                    crate::models::GitConnection::Remote { ssh, remote_path } => {
                        let cmd = format!(
                            "git -C {} branch -D {}",
                            crate::git::remote::shell_quote(remote_path),
                            crate::git::remote::shell_quote(&branch_name)
                        );
                        let _ = ssh.execute_command(&cmd).await;
                    }
                    crate::models::GitConnection::Wsl { distro, path } => {
                        let _ = tokio::process::Command::new("wsl.exe")
                            .args(["-d", distro, "--", "git", "-C", path, "branch", "-D", &branch_name])
                            .no_console_window()
                            .output()
                            .await;
                    }
                }

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
            } else if let Some(start_sha) = execution_start_sha {
                // No worktree but have a start SHA — reset agent commits on the project path
                let (_project, git_conn) = get_project_with_git_conn(&app_state, project_id).await?;
                let project_path = match &git_conn {
                    crate::models::GitConnection::Local { path } => path.clone(),
                    crate::models::GitConnection::Remote { remote_path, .. } => remote_path.clone(),
                    crate::models::GitConnection::Wsl { path, .. } => path.clone(),
                };

                // Reset to the start SHA
                let _ = git::run_git_in_dir(&git_conn, &project_path, &["reset", "--hard", &start_sha]).await;
                // Clean uncommitted changes
                let _ = git::run_git_in_dir(&git_conn, &project_path, &["checkout", "--", "."]).await;
                let _ = git::run_git_in_dir(&git_conn, &project_path, &["clean", "-fd"]).await;
            }

            // Clear execution_start_sha now that cleanup is done
            {
                let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
                conn.execute(
                    "UPDATE tasks SET execution_start_sha = NULL WHERE id = ?",
                    rusqlite::params![task_id],
                ).ok();
            }
        }
        "ResumeWithInstructions" => {
            let instr = instruction.ok_or_else(|| {
                "instruction is required for ResumeWithInstructions action".to_string()
            })?;

            let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;

            // Move task back to InProgress
            conn.execute(
                "UPDATE tasks SET status = 'InProgress', updated_at = ? WHERE id = ?",
                rusqlite::params![&now, task_id],
            )
            .map_err(|e| format!("Failed to update task status: {}", e))?;

            // Save the instruction so the agent can pick it up
            conn.execute(
                "INSERT INTO task_instructions (task_id, content, source, created_at) VALUES (?, ?, 'review', ?)",
                rusqlite::params![task_id, &instr, &now],
            )
            .map_err(|e| format!("Failed to insert task instruction: {}", e))?;
        }
        _ => {
            return Err(format!(
                "Unknown reject action '{}'. Expected SendToBacklog, ResumeWithInstructions, or CancelTask",
                action
            ));
        }
    }

    // Read back the updated task
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
    let query = format!("{} WHERE id = ?", TASK_SELECT);
    let task = conn.query_row(&query, [task_id], Task::from_row)
        .map_err(|e| format!("Failed to read updated task: {}", e))?;
    app_state.app_handle.emit("tasks-changed", ()).ok();
    Ok(task)
}

/// Reject merge and move task back to InProgress with conflict feedback
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
