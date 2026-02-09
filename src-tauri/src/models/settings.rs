use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AppSettings {
    pub project_path: Option<String>,      // Path to current project
    pub recent_projects: Vec<String>,       // Recently opened project paths
    pub model_default: String,              // Default AI model (for Phase 7)
    pub mcp_allowlist: Vec<String>,         // MCP allowlist (default empty vec [])
    pub skills_default: Vec<String>,        // Skills default (default empty vec [])
    pub theme_preference: Option<String>,   // Theme preference: 'light', 'dark', or 'system'
    pub updated_at: String,                 // ISO 8601 timestamp
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            project_path: None,
            recent_projects: Vec::new(),
            model_default: "claude-opus-4-5".to_string(),
            mcp_allowlist: Vec::new(),
            skills_default: Vec::new(),
            theme_preference: Some("system".to_string()),
            updated_at: chrono::Utc::now().to_rfc3339(),
        }
    }
}
