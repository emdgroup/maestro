use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ExecutionLog {
    pub id: i32,
    pub task_id: i32,
    pub output: String,
    pub status: ExecutionStatus,
    pub started_at: String,
    pub completed_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "lowercase")]
pub enum ExecutionStatus {
    Running,
    Complete,
    Failed,
    Paused,
    Cancelled,
}
