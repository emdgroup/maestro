use serde::{Deserialize, Serialize};
use specta::Type;

fn default_auto_mode() -> bool {
    false
}

fn default_max_concurrent_agents() -> i32 {
    3
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct AppSettings {
    pub theme_preference: Option<String>,   // Theme preference: 'light', 'dark', or 'system'
    #[serde(default = "default_auto_mode")]
    pub auto_mode: bool,                    // Whether auto mode is enabled (auto-execute Ready tasks)
    #[serde(default = "default_max_concurrent_agents")]
    pub max_concurrent_agents: i32,         // Maximum number of concurrent agent executions
    pub updated_at: String,                 // ISO 8601 timestamp
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            theme_preference: Some("system".to_string()),
            auto_mode: false,
            max_concurrent_agents: 3,
            updated_at: chrono::Utc::now().to_rfc3339(),
        }
    }
}
