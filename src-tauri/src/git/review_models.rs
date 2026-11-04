use serde::{Deserialize, Serialize};
use specta::Type;

/// Typed response for save_task_review and request_changes IPC commands
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct ReviewResult {
    pub success: bool,
    pub review_id: i32,
    pub task_status: Option<String>,
}

/// Typed response for approve_task_and_merge IPC command
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct MergeResult {
    pub success: bool,
    pub task_status: String,
    pub conflicts: Vec<String>,
    /// Set only on the pull-request path, so the UI can link straight to what it just opened.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub pull_request_url: Option<String>,
}
