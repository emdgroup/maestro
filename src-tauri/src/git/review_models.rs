use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct ReviewFeedback {
    pub id: i32,
    pub task_id: i32,
    pub decision: ReviewDecision,
    pub general_feedback: Option<String>,
    pub reviewed_at: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct ReviewComment {
    pub id: i32,
    pub review_id: i32,
    pub file_path: String,
    pub comment: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
#[serde(rename_all = "PascalCase")]
pub enum ReviewDecision {
    Approve,
    RequestChanges,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SaveReviewRequest {
    pub task_id: i32,
    pub decision: ReviewDecision,
    pub general_feedback: Option<String>,
    pub per_file_comments: Option<Vec<(String, String)>>, // (file_path, comment)
}

/// Typed response for save_task_review and request_changes IPC commands
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct ReviewResult {
    pub success: bool,
    pub review_id: i32,
    pub task_status: Option<String>,
}

/// Typed response for approve_task_and_merge IPC command
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct MergeResult {
    pub success: bool,
    pub task_status: String,
    pub conflicts: Vec<String>,
}
