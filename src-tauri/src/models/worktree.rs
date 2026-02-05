use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Worktree status state machine
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "PascalCase")]
pub enum WorktreeStatus {
    /// Ready to lease for task execution
    Available,
    /// Leased to a task but not yet actively executing
    Leased,
    /// Actively executing agent
    InUse,
    /// Failed cleanup, needs recovery
    Dirty,
}

/// Worktree record from database
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Worktree {
    pub id: i32,
    pub project_id: i32,
    pub branch_name: String,
    pub path: String,
    pub status: WorktreeStatus,
    pub leased_at: Option<String>,  // ISO 8601 timestamp
    pub returned_at: Option<String>, // ISO 8601 timestamp
    pub created_at: String,          // ISO 8601 timestamp
}

/// Pool status for monitoring
#[derive(Debug, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct PoolStatus {
    pub total: i32,
    pub available: i32,
    pub leased: i32,
    pub in_use: i32,
    pub dirty: i32,
    pub utilization_percent: f64,
}
