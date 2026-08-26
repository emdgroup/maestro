use std::sync::Arc;
use tauri::{Emitter, State};
use chrono::Utc;

use crate::models::{Task, TASK_SELECT, ReviewResult, TaskReviewWithComments, ReviewCommentEntry};
use crate::core::AppState;
use crate::git;
use crate::task::transition::{self, TaskTransition};

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
    transition::apply(&conn, task_id, TaskTransition::ReworkRequested)?;

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

/// Reject a task in review, discarding its work either way
///
/// Handles the two rejection paths from the review panel:
/// - "SendToBacklog": moves task back to Planning, deletes worktree, resets agent commits
/// - "CancelTask": moves task to Cancelled, deletes worktree, resets agent commits
///
/// Returns the updated Task.
#[tauri::command]
#[specta::specta]
pub async fn reject_review(
    app_state: State<'_, Arc<AppState>>,
    task_id: i32,
    action: String,
) -> Result<Task, String> {
    match action.as_str() {
        "SendToBacklog" | "CancelTask" => {
            // "SendToBacklog" is a legacy name: there is no Backlog column, and this used to
            // write the literal status 'Backlog', which v24 had already retired. Discarding
            // returns the task to Planning.
            let event = if action == "SendToBacklog" {
                TaskTransition::Discarded
            } else {
                TaskTransition::Cancelled
            };

            {
                let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
                transition::apply(&conn, task_id, event)?;
            }

            git::worktree_lifecycle::discard_task_workspace(&app_state, task_id).await?;
        }
        _ => {
            return Err(format!(
                "Unknown reject action '{}'. Expected SendToBacklog or CancelTask",
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
