use std::sync::Arc;
use tauri::State;

use crate::acp::connection_server::{query_project_store, reply};
use crate::acp::transport::{ServerRequest, ServerResponse};
use crate::core::AppState;
use crate::git;
use crate::models::{ReviewCommentEntry, ReviewResult, Task, TaskReviewWithComments};
use maestro_protocol::{
    ReviewCommentInput, SaveTaskReviewRequest, TaskRef, TaskTransition, TransitionGuard,
};

/// Replace a task's review, and every per-file comment it had, with this one.
async fn replace_review(
    app_state: &Arc<AppState>,
    project_id: i32,
    task_id: i32,
    decision: String,
    general_feedback: Option<String>,
    per_file_comments: Option<Vec<(String, String)>>,
) -> Result<i32, String> {
    let comments = per_file_comments
        .unwrap_or_default()
        .into_iter()
        .map(|(file_path, comment)| ReviewCommentInput { file_path, comment })
        .collect();
    query_project_store(
        app_state,
        project_id,
        |project_path| {
            ServerRequest::SaveTaskReview(SaveTaskReviewRequest {
                project_path,
                task_id,
                decision,
                general_feedback,
                comments: Some(comments),
            })
        },
        reply!(ServerResponse::SaveTaskReviewOk(saved) => saved.review_id),
    )
    .await
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
    project_id: i32,
    task_id: i32,
    decision: String,
    general_feedback: Option<String>,
    per_file_comments: Option<Vec<(String, String)>>,
) -> Result<ReviewResult, String> {
    let review_id = replace_review(
        &app_state,
        project_id,
        task_id,
        decision,
        general_feedback,
        per_file_comments,
    )
    .await?;

    Ok(ReviewResult {
        success: true,
        review_id,
        task_status: None,
    })
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
    project_id: i32,
    task_id: i32,
    general_feedback: Option<String>,
    per_file_comments: Option<Vec<(String, String)>>,
) -> Result<ReviewResult, String> {
    // The transition first: saving replaces every per-file comment the previous review held, so a
    // save followed by a failed transition would lose them with the task still in review. Both
    // steps are safe to repeat, so a save that fails afterwards is healed by the user's retry, and
    // the command's error keeps the rework from being started without its feedback.
    crate::task::ops::apply_transition_on_server(
        &app_state,
        project_id,
        task_id,
        TaskTransition::ReworkRequested,
        TransitionGuard::Always,
    )
    .await?;
    let review_id = replace_review(
        &app_state,
        project_id,
        task_id,
        "RequestChanges".to_string(),
        general_feedback,
        per_file_comments,
    )
    .await?;

    Ok(ReviewResult {
        success: true,
        review_id,
        task_status: Some("InProgress".to_string()),
    })
}

/// Get the current review (with comments) for a task
#[tauri::command]
#[specta::specta]
pub async fn get_task_review(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    task_id: i32,
) -> Result<Option<TaskReviewWithComments>, String> {
    let found = query_project_store(
        &app_state,
        project_id,
        |project_path| {
            ServerRequest::GetTaskReview(TaskRef {
                project_path,
                task_id,
            })
        },
        reply!(ServerResponse::GetTaskReviewOk(found) => found.review),
    )
    .await?;

    Ok(found.map(|review| TaskReviewWithComments {
        decision: review.decision,
        general_feedback: review.general_feedback,
        comments: review
            .comments
            .into_iter()
            .map(|comment| ReviewCommentEntry {
                file_path: comment.file_path,
                comment: comment.comment,
            })
            .collect(),
        created_at: review.created_at,
    }))
}

/// Clear the review and its comments for a task after feedback has been injected into the agent.
/// Prevents stale comments from appearing in subsequent review cycles or being re-injected on cold starts.
#[tauri::command]
#[specta::specta]
pub async fn clear_task_review(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    task_id: i32,
) -> Result<(), String> {
    query_project_store(
        &app_state,
        project_id,
        |project_path| {
            ServerRequest::ClearTaskReview(TaskRef {
                project_path,
                task_id,
            })
        },
        reply!(ServerResponse::ClearTaskReviewOk => ()),
    )
    .await
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
    project_id: i32,
    task_id: i32,
    action: String,
) -> Result<Task, String> {
    // "SendToBacklog" is a legacy name: there is no Backlog column, and this used to write the
    // literal status 'Backlog', which v24 had already retired. Discarding returns the task to
    // Planning.
    let event = match action.as_str() {
        "SendToBacklog" => TaskTransition::Discarded,
        "CancelTask" => TaskTransition::Cancelled,
        _ => {
            return Err(format!(
                "Unknown reject action '{}'. Expected SendToBacklog or CancelTask",
                action
            ));
        }
    };

    crate::task::ops::apply_transition_on_server(
        &app_state,
        project_id,
        task_id,
        event,
        TransitionGuard::Always,
    )
    .await?;

    git::worktree_lifecycle::discard_task_workspace(&app_state, project_id, task_id).await?;

    crate::task::crud::get_task_on_server(&app_state, project_id, task_id)
        .await?
        .ok_or_else(|| format!("Failed to read updated task: task {task_id} not found"))
}
