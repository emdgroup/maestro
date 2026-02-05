use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Project {
    pub id: i32,
    pub name: String,
    pub path: String,
    pub created_at: String,  // ISO 8601
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "PascalCase")]
pub enum ProjectStatus {
    Active,
    Archived,
}
