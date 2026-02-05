use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Task {
    pub id: i32,
    pub project_id: i32,
    pub name: String,
    pub description: String,
    #[ts(optional)]
    pub acceptance_criteria: Option<String>,
    pub status: TaskStatus,
    #[ts(optional)]
    pub external_id: Option<String>,
    #[ts(optional)]
    pub is_imported: Option<bool>,
    #[ts(optional)]
    pub import_source: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "PascalCase")]
pub enum TaskStatus {
    Backlog,
    Ready,
    InProgress,
    Review,
    Done,
}
