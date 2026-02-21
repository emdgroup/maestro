use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Project {
    pub id: i64,
    pub name: String,
    pub path: String,
    pub created_at: String,  // ISO 8601
    pub last_opened: Option<String>, // ISO 8601
    pub connection_id: Option<i64>,  // Foreign key to ssh_connections; None = local project
}

impl Project {
    /// Get the connection type as a string
    pub fn connection_type(&self) -> String {
        if self.is_remote() {
            "remote".to_string()
        } else {
            "local".to_string()
        }
    }

    /// Check if this is a remote project
    pub fn is_remote(&self) -> bool {
        self.connection_id.is_some()
    }

    /// Parse a Project from a rusqlite Row
    /// Expects columns in order
    pub fn from_row(row: &rusqlite::Row) -> rusqlite::Result<Self> {
        Ok(Project {
            id: row.get(0)?,
            name: row.get(1)?,
            path: row.get(2)?,
            created_at: row.get(3)?,
            last_opened: row.get(4)?,
            connection_id: row.get(5)?,
        })
    }

}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "PascalCase")]
pub enum ProjectStatus {
    Active,
    Archived,
}
