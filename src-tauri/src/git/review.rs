use std::sync::Arc;
use tauri::{Emitter, State};
use crate::command_ext::NoConsoleWindow;
use chrono::Utc;

use crate::models::{Task, TASK_SELECT, ReviewResult, TaskReviewWithComments, ReviewCommentEntry};
use crate::core::{AppState, get_project_with_git_conn};
use crate::git;
use crate::git::remote::shell_quote;

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

/// Get diff for review: generates unified diff between task branch and its base branch.
///
/// Dispatches through GitConnection so it works for local, SSH, and WSL projects.
///
/// Returns the unified diff as a string with 6 context lines.
#[tauri::command]
#[specta::specta]
pub async fn get_diff_for_review(
    app_state: State<'_, Arc<AppState>>,
    task_id: i32,
) -> Result<String, String> {
    let (project_id, branch_name, base_branch) = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        conn.query_row(
            "SELECT t.project_id, w.branch_name, t.base_branch
             FROM tasks t
             JOIN worktrees w ON w.task_id = t.id
             WHERE t.id = ?",
            rusqlite::params![task_id],
            |row| Ok((row.get::<_, i32>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?)),
        )
        .map_err(|e| format!("Task/worktree not found: {}", e))?
    };

    let (_project, git_conn) = get_project_with_git_conn(app_state.inner(), project_id).await
        .map_err(|e| format!("Failed to get git connection: {}", e))?;

    git::git_diff(&git_conn, &branch_name, &base_branch)
        .await
        .map_err(|e| format!("Failed to get diff: {}", e))
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

/// Clear the review and its comments for a task after feedback has been injected into the agent.
/// Prevents stale comments from appearing in subsequent review cycles or being re-injected on cold starts.
#[tauri::command]
#[specta::specta]
pub async fn clear_task_review(
    app_state: State<'_, Arc<AppState>>,
    task_id: i32,
) -> Result<(), String> {
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
    conn.execute(
        "DELETE FROM task_reviews WHERE task_id = ?",
        rusqlite::params![task_id],
    ).map_err(|e| format!("Delete review failed: {}", e))?;
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
                            shell_quote(remote_path),
                            shell_quote(&branch_name)
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
                    crate::models::GitConnection::Docker { container_name, path } => {
                        let cli = crate::connectivity::docker::ContainerCli::detect()
                            .unwrap_or(crate::connectivity::docker::ContainerCli::Docker);
                        let _ = tokio::process::Command::new(cli.binary())
                            .args(["exec", container_name, "git", "-C", path, "branch", "-D", &branch_name])
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
                    crate::models::GitConnection::Docker { path, .. } => path.clone(),
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
