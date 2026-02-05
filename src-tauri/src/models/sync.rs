use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct SyncResult {
    pub imported_count: i32,
    pub updated_count: i32,
    #[ts(optional)]
    pub error_message: Option<String>,
}

/// GitHub issue response from API
#[derive(Debug, Deserialize)]
pub struct GitHubIssue {
    pub number: i32,
    pub title: String,
    pub body: Option<String>,
}

/// Jira issue response from API
#[derive(Debug, Deserialize)]
pub struct JiraIssue {
    pub key: String,
    pub fields: JiraFields,
}

#[derive(Debug, Deserialize)]
pub struct JiraFields {
    pub summary: String,
    pub description: Option<String>,
}

/// Wrapper for Jira API response
#[derive(Debug, Deserialize)]
pub struct JiraSearchResponse {
    pub issues: Vec<JiraIssue>,
}
