use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct ErrorEvent {
    pub error_type: String,
    pub message: String,
    pub suggestions: Vec<String>,
    pub detected_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct ExecutionLog {
    pub id: i32,
    pub task_id: i32,
    pub output: String,
    pub terminal_output: Option<String>,
    pub status: ExecutionStatus,
    pub started_at: String,
    pub completed_at: Option<String>,
    pub error_event: Option<ErrorEvent>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
#[serde(rename_all = "lowercase")]
pub enum ExecutionStatus {
    Running,
    Complete,
    Failed,
    Paused,
    Cancelled,
}
