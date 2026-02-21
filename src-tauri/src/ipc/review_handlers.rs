use std::sync::Arc;
use tauri::State;
use chrono::Utc;

use crate::models::{Project, MergeOutcome};
use crate::db::{AppState, get_git_connection};
use crate::git;

/// Get diff for review: generates unified diff between task branch and main
///
/// For local projects, invokes Node.js sidecar to generate diff.
/// For remote projects, uses git dispatcher over SSH.
///
/// Returns the unified diff as a string with 6 context lines.
#[tauri::command]
pub async fn get_diff_for_review(
    app_state: State<'_, Arc<AppState>>,
    task_id: i64,
) -> Result<String, String> {
    println!("get_diff_for_review({}) called", task_id);

    // 1. Query task to get project_id and task details
    let (_project_id, project, worktree_path, branch_name) = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;

        let proj_id: i64 = conn
            .query_row(
                "SELECT project_id FROM tasks WHERE id = ?",
                rusqlite::params![task_id],
                |row| row.get(0),
            )
            .map_err(|e| format!("Task not found: {}", e))?;

        // Get project details (local path, connection_id)
        let (path, connection_id): (String, Option<i64>) = conn
            .query_row(
                "SELECT path, connection_id FROM projects WHERE id = ?",
                rusqlite::params![proj_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(|e| format!("Project not found: {}", e))?;

        let project = Project {
            id: proj_id,
            name: String::new(), // Not needed for this operation
            path,
            created_at: String::new(), // Not needed
            last_opened: None,
            connection_id,
        };

        // Find worktree for this task
        let (wt_path, branch): (String, String) = conn
            .query_row(
                "SELECT path, branch_name FROM worktrees WHERE project_id = ? AND (status = 'InUse' OR status = 'Leased')",
                rusqlite::params![proj_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(|e| format!("Worktree not found for task: {}", e))?;

        (proj_id, project, wt_path, branch)
    };

    // 2. Handle diff generation based on project type
    if project.is_remote() {
        // Remote project: use git dispatcher which executes over SSH
        println!("  Generating diff for remote project via SSH");

        let git_conn = get_git_connection(&project, &app_state)
            .await
            .map_err(|e| format!("Failed to get git connection: {}", e))?;

        // For remote, we execute git diff on the remote machine
        // The worktree_path is relative to the remote project root
        let diff = git::git_diff(&git_conn, &branch_name, "main")
            .await
            .map_err(|e| format!("Failed to get diff from remote: {}", e))?;

        println!("✓ Generated diff for task {} from remote: {} bytes", task_id, diff.len());
        Ok(diff)
    } else {
        // Local project: use Node.js sidecar (Phase 3-01 integration)
        println!("  Generating diff for local project via sidecar");

        let full_worktree_path = format!("{}/{}", project.path, worktree_path);

        println!("  Generating diff for branch {} in worktree {}", branch_name, full_worktree_path);

        // Call Node.js sidecar to generate diff
        let output = tokio::process::Command::new("node")
            .args(&[
                "sidecar/dist/index.js",
                "--get-diff",
                &full_worktree_path,
                &branch_name,
                "main", // Compare against main branch
                "6",    // 6 context lines
            ])
            .output()
            .await
            .map_err(|e| format!("Failed to spawn sidecar: {}", e))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("Sidecar failed: {}", stderr));
        }

        let diff = String::from_utf8(output.stdout)
            .map_err(|e| format!("Failed to decode sidecar output: {}", e))?;

        println!("✓ Generated diff for task {}: {} bytes", task_id, diff.len());
        Ok(diff)
    }
}

/// Save task review with feedback and per-file comments
///
/// Creates a new review record with decision (Approve, RequestChanges, etc.)
/// and optional general feedback. Per-file comments are stored separately
/// linked to the review record.
///
/// Returns JSON object with success flag and review_id.
#[tauri::command]
pub async fn save_task_review(
    app_state: State<'_, Arc<AppState>>,
    task_id: i64,
    decision: String,
    general_feedback: Option<String>,
    per_file_comments: Option<Vec<(String, String)>>,
) -> Result<serde_json::Value, String> {
    println!("save_task_review({}, decision={}) called", task_id, decision);

    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
    let now = Utc::now().to_rfc3339();

    // Insert into task_reviews
    conn.execute(
        "INSERT INTO task_reviews (task_id, decision, general_feedback, reviewed_at, created_at)
         VALUES (?, ?, ?, ?, ?)",
        rusqlite::params![task_id, &decision, &general_feedback, &now, &now],
    )
    .map_err(|e| format!("Insert review failed: {}", e))?;

    // Get review_id
    let review_id: i64 = conn
        .query_row(
            "SELECT id FROM task_reviews WHERE task_id = ?",
            [task_id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;

    // Insert per-file comments if provided
    if let Some(comments) = per_file_comments {
        for (file_path, comment) in comments {
            conn.execute(
                "INSERT INTO review_comments (review_id, file_path, comment, created_at)
                 VALUES (?, ?, ?, ?)",
                rusqlite::params![review_id, file_path, comment, &now],
            )
            .map_err(|e| format!("Insert comment failed: {}", e))?;
        }
    }

    println!("✓ Saved review for task {}: review_id={}", task_id, review_id);
    Ok(serde_json::json!({ "success": true, "review_id": review_id }))
}

/// Request changes on a task: saves feedback and moves task back to InProgress
///
/// Creates a RequestChanges review with general feedback and per-file comments,
/// then transitions the task status back to InProgress for the agent to rework.
///
/// Returns JSON object with success flag, review_id, and updated task_status.
#[tauri::command]
pub async fn request_changes(
    app_state: State<'_, Arc<AppState>>,
    task_id: i64,
    general_feedback: Option<String>,
    per_file_comments: Option<Vec<(String, String)>>,
) -> Result<serde_json::Value, String> {
    println!("request_changes({}) called", task_id);

    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
    let now = Utc::now().to_rfc3339();

    // Save feedback with RequestChanges decision
    conn.execute(
        "INSERT INTO task_reviews (task_id, decision, general_feedback, reviewed_at, created_at)
         VALUES (?, 'RequestChanges', ?, ?, ?)",
        rusqlite::params![task_id, general_feedback, &now, &now],
    )
    .map_err(|e| format!("Insert review failed: {}", e))?;

    // Get review_id and save per-file comments
    let review_id: i64 = conn
        .query_row(
            "SELECT id FROM task_reviews WHERE task_id = ?",
            [task_id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;

    if let Some(comments) = per_file_comments {
        for (file_path, comment) in comments {
            conn.execute(
                "INSERT INTO review_comments (review_id, file_path, comment, created_at)
                 VALUES (?, ?, ?, ?)",
                rusqlite::params![review_id, file_path, comment, &now],
            )
            .map_err(|e| format!("Insert comment failed: {}", e))?;
        }
    }

    // Update task status to InProgress
    conn.execute(
        "UPDATE tasks SET status = 'InProgress', updated_at = ? WHERE id = ?",
        rusqlite::params![&now, task_id],
    )
    .map_err(|e| format!("Update task status failed: {}", e))?;

    println!(
        "✓ Requested changes for task {}: review_id={}, status=InProgress",
        task_id, review_id
    );
    Ok(serde_json::json!({
        "success": true,
        "review_id": review_id,
        "task_status": "InProgress"
    }))
}

// ============================================================================
// Merge Automation and Conflict Handling
// ============================================================================

/// Approve task and initiate automatic merge to main branch
///
/// Orchestrates the complete merge workflow:
/// 1. Updates task status to "Merging" (transient state)
/// 2. Spawns async background task to perform squash merge
/// 3. On success: updates task to "Done", cleans up worktree, returns to pool
/// 4. On conflict: rejects task back to "InProgress", saves conflict feedback
/// 5. Emits Tauri events for frontend UI updates and notifications
///
/// Returns immediately with "merging started" confirmation.
/// Frontend listens for merge_complete or merge_error events for final status.
#[tauri::command]
pub async fn approve_task_and_merge(
    app_state: State<'_, Arc<AppState>>,
    task_id: i64,
) -> Result<serde_json::Value, String> {
    println!("approve_task_and_merge({}) called", task_id);

    // 1. Query task details and worktree info
    let (task_name, branch_name, worktree_path, worktree_id, _project_id, repo_path) = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;

        let (t_name, w_branch, w_path, w_id, p_id): (String, String, String, i32, i32) = conn
            .query_row(
                "SELECT t.name, w.branch_name, w.path, w.id, t.project_id
                 FROM tasks t
                 JOIN worktrees w ON w.id = (
                   SELECT id FROM worktrees WHERE project_id = t.project_id
                   AND (status = 'InUse' OR status = 'Leased') LIMIT 1
                 )
                 WHERE t.id = ?",
                [task_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
            )
            .map_err(|e| format!("Task or worktree not found: {}", e))?;

        // Get project repo path
        let p_path: String = conn
            .query_row(
                "SELECT path FROM projects WHERE id = ?",
                [p_id],
                |row| row.get(0),
            )
            .map_err(|e| format!("Project not found: {}", e))?;

        (t_name, w_branch, w_path, w_id, p_id, p_path)
    };

    // 2. Update task status to "Merging"
    {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        let now = Utc::now().to_rfc3339();

        conn.execute(
            "UPDATE tasks SET status = 'Merging', updated_at = ? WHERE id = ?",
            rusqlite::params![&now, task_id],
        )
        .map_err(|e| format!("Failed to update task status: {}", e))?;

        println!("✓ Task {} status updated to Merging", task_id);
    }

    // 3. Spawn async merge operation in background
    let app_state_clone = app_state.inner().clone();

    tokio::spawn(async move {
        println!(
            "[merge] Starting async merge for task {} (branch: {})",
            task_id, branch_name
        );

        // Build full worktree path
        let full_worktree_path = format!("{}/{}", repo_path, worktree_path);

        // Call Node.js sidecar to perform squash merge
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
            .await;

        match sidecar_result {
            Ok(output) => {
                if output.status.success() {
                    // Parse stdout as JSON to extract MergeOutcome
                    let stdout = String::from_utf8_lossy(&output.stdout);

                    match serde_json::from_str::<MergeOutcome>(&stdout) {
                        Ok(merge_outcome) => {
                            if merge_outcome.success {
                                // Merge succeeded - cleanup and mark task Done
                                println!("[merge] ✓ Merge succeeded for task {}", task_id);

                                if let Err(e) = finalize_successful_merge(
                                    &app_state_clone,
                                    task_id,
                                    worktree_id,
                                    &full_worktree_path,
                                    &repo_path,
                                    &branch_name,
                                ).await {
                                    eprintln!("[merge] Merge finalization error: {}", e);
                                } else {
                                    println!("[merge] ✓ Merge finalized successfully for task {}", task_id);
                                }
                            } else if !merge_outcome.conflicts.is_empty() {
                                // Merge had conflicts - reject and move back to InProgress
                                println!("[merge] Merge conflict detected for task {}", task_id);

                                if let Err(e) = reject_merge_on_conflict(
                                    &app_state_clone,
                                    task_id,
                                    &merge_outcome.conflicts,
                                ).await {
                                    eprintln!("[merge] Failed to reject on conflict: {}", e);
                                } else {
                                    println!("[merge] Task {} rejected to InProgress due to merge conflict", task_id);
                                }
                            } else {
                                // Other error - leave task in Merging state and log
                                eprintln!("[merge] Merge error: {}", merge_outcome.message.unwrap_or_default());
                            }
                        }
                        Err(e) => {
                            eprintln!("[merge] Failed to parse merge outcome JSON: {}", e);
                            eprintln!("[merge] stdout: {}", stdout);
                        }
                    }
                } else {
                    // Merge process exited with error
                    let stderr = String::from_utf8_lossy(&output.stderr);
                    eprintln!("[merge] Sidecar exited with error for task {}: {}", task_id, stderr);
                }
            }
            Err(e) => {
                eprintln!("[merge] Sidecar error for task {}: {}", task_id, e);
            }
        }

        println!("[merge] Async merge operation complete for task {}", task_id);
    });

    Ok(serde_json::json!({ "merging": true, "message": "Merge started" }))
}

/// Finalize successful merge: update task to Done, cleanup worktree from disk, return to pool
///
/// Helper function (private crate-level) called after successful merge to perform cleanup:
/// 1. Updates task status to Done
/// 2. Marks worktree as Dirty before cleanup (crash-safe state)
/// 3. Deletes worktree from disk via sidecar
/// 4. Removes worktree from database on successful cleanup
///
/// If cleanup fails, worktree remains in Dirty state for recovery on app restart.
pub(crate) async fn finalize_successful_merge(
    app_state: &Arc<AppState>,
    task_id: i64,
    worktree_id: i32,
    worktree_path: &str,
    repo_path: &str,
    branch_name: &str,
) -> Result<(), String> {
    println!(
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

        println!("[finalize] ✓ Task {} moved to Done", task_id);
    }

    // 2. Mark worktree as Dirty before cleanup (crash-safe state marking)
    {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        conn.execute(
            "UPDATE worktrees SET status = 'Dirty' WHERE id = ?",
            rusqlite::params![worktree_id],
        )
        .map_err(|e| format!("Failed to mark worktree Dirty: {}", e))?;

        println!("[finalize] Marked worktree {} as Dirty before cleanup", worktree_id);
    }

    // 3. Delete worktree from disk via sidecar
    let sidecar_result = tokio::process::Command::new("node")
        .args(&[
            "sidecar/dist/index.js",
            "--delete-worktree",
            repo_path,
            worktree_path,
            branch_name,
        ])
        .output()
        .await;

    match sidecar_result {
        Ok(output) => {
            if output.status.success() {
                // Delete from database on successful cleanup
                {
                    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
                    conn.execute(
                        "DELETE FROM worktrees WHERE id = ?",
                        rusqlite::params![worktree_id],
                    )
                    .map_err(|e| format!("Failed to delete worktree from DB: {}", e))?;
                }
                println!("[finalize] ✓ Worktree {} deleted from disk and DB", worktree_id);
            } else {
                // Cleanup failed - log error but don't fail the entire merge
                let stderr = String::from_utf8_lossy(&output.stderr);
                eprintln!("[finalize] ⚠ Cleanup failed (will retry): {}", stderr);
                // Worktree stays in Dirty state for recovery via recover_dirty_worktrees on app restart
            }
        }
        Err(e) => {
            // Sidecar spawn error - log but don't fail
            eprintln!("[finalize] ⚠ Failed to invoke sidecar: {} (will retry)", e);
            // Worktree stays in Dirty state for recovery
        }
    }

    // 4. Final status log
    println!("[finalize] ✓ Merge finalization complete for task {}", task_id);

    Ok(())
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
    task_id: i64,
    conflicts: &[String],
) -> Result<(), String> {
    println!(
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

    println!("[reject] ✓ Task {} moved to InProgress", task_id);

    // Save conflict feedback as review comment for visibility
    conn.execute(
        "INSERT INTO task_reviews (task_id, decision, general_feedback, created_at)
         VALUES (?, 'RequestChanges', ?, ?)",
        rusqlite::params![task_id, &conflict_feedback, &now],
    )
    .map_err(|e| format!("Save feedback failed: {}", e))?;

    println!("[reject] ✓ Conflict feedback saved for task {}", task_id);

    Ok(())
}
