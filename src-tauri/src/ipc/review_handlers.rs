use std::sync::Arc;
use tauri::State;
use chrono::Utc;

use crate::models::{Project, MergeOutcome, Task, TASK_SELECT, ReviewResult, MergeResult};
use crate::db::{AppState, get_git_connection, get_project_with_git_conn};
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
    log::info!("get_diff_for_review({}) called", task_id);

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
        };
        (project, wt_path, branch)
    };

    // 2. Handle diff generation based on project type
    if project.is_remote() {
        // Remote project: use git dispatcher which executes over SSH
        log::info!("  Generating diff for remote project via SSH");

        let git_conn = get_git_connection(&project, &app_state)
            .await
            .map_err(|e| format!("Failed to get git connection: {}", e))?;

        let diff = git::git_diff(&git_conn, &branch_name, "main")
            .await
            .map_err(|e| format!("Failed to get diff from remote: {}", e))?;

        log::info!("get_diff_for_review: task {} from remote: {} bytes", task_id, diff.len());
        Ok(diff)
    } else {
        // Local project: use git dispatcher directly
        log::info!("  Generating diff for local project via git dispatcher");

        let full_worktree_path = format!("{}/{}", project.path, worktree_path);

        log::info!("  Generating diff for branch {} in worktree {}", branch_name, full_worktree_path);

        let git_conn = crate::models::GitConnection::Local { path: project.path.clone() };
        let diff = git::git_diff(&git_conn, &branch_name, "main")
            .await
            .map_err(|e| format!("Failed to get diff: {}", e))?;

        log::info!("get_diff_for_review: task {}: {} bytes", task_id, diff.len());
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
    log::info!("save_task_review({}, decision={}) called", task_id, decision);

    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
    let now = Utc::now().to_rfc3339();
    let comments_ref = per_file_comments.as_ref().map(|v| v.as_slice());
    let review_id = insert_review_with_comments(
        &conn, task_id, &decision, general_feedback.as_deref(), comments_ref, &now,
    )?;
    log::info!("Saved review for task {}: review_id={}", task_id, review_id);

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
    log::info!("request_changes({}) called", task_id);

    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
    let now = Utc::now().to_rfc3339();
    let comments_ref = per_file_comments.as_ref().map(|v| v.as_slice());
    let review_id = insert_review_with_comments(
        &conn, task_id, "RequestChanges", general_feedback.as_deref(), comments_ref, &now,
    )?;
    conn.execute(
        "UPDATE tasks SET status = 'InProgress', updated_at = ? WHERE id = ?",
        rusqlite::params![&now, task_id],
    ).map_err(|e| format!("Update task status failed: {}", e))?;
    log::info!("Requested changes for task {}: review_id={}, status=InProgress", task_id, review_id);

    Ok(ReviewResult { success: true, review_id, task_status: Some("InProgress".to_string()) })
}

// ============================================================================
// Merge Automation and Conflict Handling
// ============================================================================

/// Approve task and perform synchronous merge to main branch
///
/// Orchestrates the complete merge workflow synchronously:
/// 1. Queries task details and worktree info
/// 2. Calls Node.js sidecar to perform squash merge (awaits completion)
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
    log::info!("approve_task_and_merge({}, strategy={}) called", task_id, merge_strategy);

    // 1. Single JOIN query to get task, worktree, and project data
    let (task_name, branch_name, worktree_path, worktree_id, _project_id, repo_path) = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        conn.query_row(
            "SELECT t.name, w.branch_name, w.path, w.id, t.project_id, p.path
             FROM tasks t
             JOIN worktrees w ON w.id = (SELECT id FROM worktrees WHERE task_id = t.id LIMIT 1)
             JOIN projects p ON p.id = t.project_id
             WHERE t.id = ?",
            [task_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, i32>(3)?, row.get::<_, i32>(4)?, row.get::<_, String>(5)?)),
        )
        .map_err(|e| format!("Task, worktree, or project not found: {}", e))?
    };

    // 2. Build full worktree path
    let full_worktree_path = format!("{}/{}", repo_path, worktree_path);

    log::info!(
        "[merge] Starting synchronous merge for task {} (branch: {})",
        task_id, branch_name
    );

    // 3. Call Node.js sidecar to perform squash merge (await synchronously)
    let sidecar_result = tokio::process::Command::new("node")
        .args(&[
            "sidecar/dist/index.js",
            "--merge",
            &full_worktree_path,
            &task_id.to_string(),
            &branch_name,
            &task_name,
        ])
        .output()
        .await
        .map_err(|e| format!("Failed to spawn merge sidecar: {}", e))?;

    if !sidecar_result.status.success() {
        let stderr = String::from_utf8_lossy(&sidecar_result.stderr);
        return Err(format!("Merge sidecar failed: {}", stderr));
    }

    let stdout = String::from_utf8_lossy(&sidecar_result.stdout);
    let merge_outcome = serde_json::from_str::<MergeOutcome>(&stdout)
        .map_err(|e| format!("Failed to parse merge outcome: {} (stdout: {})", e, stdout))?;

    if merge_outcome.success {
        // 4a. Merge succeeded - finalize (mark Done, cleanup worktree)
        log::info!("[merge] Merge succeeded for task {}", task_id);
        finalize_successful_merge(
            app_state.inner(),
            task_id,
            worktree_id,
            &full_worktree_path,
            &branch_name,
        )
        .await?;
        log::info!("[merge] Merge finalized for task {}", task_id);
        Ok(MergeResult { success: true, task_status: "Done".to_string(), conflicts: vec![] })
    } else if !merge_outcome.conflicts.is_empty() {
        // 4b. Merge had conflicts - reject back to InProgress
        log::info!("[merge] Merge conflict for task {}", task_id);
        reject_merge_on_conflict(app_state.inner(), task_id, &merge_outcome.conflicts).await?;
        Ok(MergeResult { success: false, task_status: "InProgress".to_string(), conflicts: merge_outcome.conflicts })
    } else {
        // 4c. Merge reported failure without conflicts - return error
        Err(merge_outcome.message.unwrap_or_else(|| "Merge failed with unknown error".to_string()))
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
    log::info!(
        "[finalize] Finalizing merge for task {}: updating task to Done",
        task_id
    );

    // 1. Update task status to Done
    {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        let now = Utc::now().to_rfc3339();

        conn.execute(
            "UPDATE tasks SET status = 'Done', updated_at = ? WHERE id = ?",
            rusqlite::params![&now, task_id],
        )
        .map_err(|e| format!("Update task failed: {}", e))?;

        log::info!("[finalize] Task {} moved to Done", task_id);
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
            // Delete branch — no delete_branch in git dispatcher, use inline Command (non-fatal)
            let repo_dir = match &git_conn {
                crate::models::GitConnection::Local { path } => path.clone(),
                crate::models::GitConnection::Remote { remote_path, .. } => remote_path.clone(),
            };
            let branch_result = tokio::process::Command::new("git")
                .args(["branch", "-D", branch_name])
                .current_dir(&repo_dir)
                .output()
                .await;
            match branch_result {
                Ok(output) if !output.status.success() => {
                    let stderr = String::from_utf8_lossy(&output.stderr);
                    log::warn!("[finalize] Failed to delete branch {} (non-fatal): {}", branch_name, stderr);
                }
                Err(e) => {
                    log::warn!("[finalize] Failed to run git branch -D {} (non-fatal): {}", branch_name, e);
                }
                _ => {
                    log::info!("[finalize] Branch {} deleted", branch_name);
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
            log::info!("[finalize] Worktree {} deleted from disk and DB", worktree_id);
        }
        Err(e) => {
            log::warn!("[finalize] Cleanup failed (will retry): {}", e);
        }
    }

    // 3. Final status log
    log::info!("[finalize] Merge finalization complete for task {}", task_id);

    Ok(())
}

/// Reject a task in review with one of three actions
///
/// Handles the three rejection paths from the review panel:
/// - "SendToBacklog": moves task back to Backlog status (worktree cleanup is a TODO)
/// - "ResumeWithInstructions": moves task to InProgress and saves instruction for the agent
/// - "CancelTask": moves task to Cancelled status (worktree cleanup is a TODO)
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
    log::info!("reject_review({}, action={}) called", task_id, action);

    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
    let now = Utc::now().to_rfc3339();

    match action.as_str() {
        "SendToBacklog" => {
            // Move task back to Backlog; worktree cleanup is a TODO for full implementation
            conn.execute(
                "UPDATE tasks SET status = 'Backlog', updated_at = ? WHERE id = ?",
                rusqlite::params![&now, task_id],
            )
            .map_err(|e| format!("Failed to update task status: {}", e))?;

            log::info!("[reject_review] Task {} moved to Backlog", task_id);
            // TODO: delete worktree for this task
        }
        "ResumeWithInstructions" => {
            let instr = instruction.ok_or_else(|| {
                "instruction is required for ResumeWithInstructions action".to_string()
            })?;

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

            log::info!("[reject_review] Task {} resumed with instructions", task_id);
        }
        "CancelTask" => {
            // Move task to Cancelled; worktree cleanup is a TODO for full implementation
            conn.execute(
                "UPDATE tasks SET status = 'Cancelled', updated_at = ? WHERE id = ?",
                rusqlite::params![&now, task_id],
            )
            .map_err(|e| format!("Failed to update task status: {}", e))?;

            log::info!("[reject_review] Task {} cancelled", task_id);
            // TODO: delete worktree for this task
        }
        _ => {
            return Err(format!(
                "Unknown reject action '{}'. Expected SendToBacklog, ResumeWithInstructions, or CancelTask",
                action
            ));
        }
    }

    // Read back the updated task
    let query = format!("{} WHERE id = ?", TASK_SELECT);
    conn.query_row(&query, [task_id], Task::from_row)
        .map_err(|e| format!("Failed to read updated task: {}", e))
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
    log::info!(
        "[reject] Rejecting merge for task {} due to conflicts",
        task_id
    );

    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
    let now = Utc::now().to_rfc3339();
    let conflict_feedback = format!("Merge conflict detected:\n{}", conflicts.join("\n"));

    // Auto-reject to InProgress per CONTEXT.md decision
    conn.execute(
        "UPDATE tasks SET status = 'InProgress', updated_at = ? WHERE id = ?",
        rusqlite::params![&now, task_id],
    )
    .map_err(|e| format!("Update task failed: {}", e))?;

    log::info!("[reject] Task {} moved to InProgress", task_id);

    // Save conflict feedback as review comment for visibility
    conn.execute(
        "INSERT INTO task_reviews (task_id, decision, general_feedback, created_at)
         VALUES (?, 'RequestChanges', ?, ?)",
        rusqlite::params![task_id, &conflict_feedback, &now],
    )
    .map_err(|e| format!("Save feedback failed: {}", e))?;

    log::info!("[reject] Conflict feedback saved for task {}", task_id);

    Ok(())
}
