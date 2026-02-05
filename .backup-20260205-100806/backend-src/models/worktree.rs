use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Worktree {
    pub id: i32,
    pub project_id: i32,
    pub branch_name: String,
    pub path: String,
    pub status: WorktreeStatus,
    pub leased_at: Option<String>,
    pub returned_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "PascalCase")]
pub enum WorktreeStatus {
    Available,
    Leased,
    Dirty,
}
