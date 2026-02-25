use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AppSettings {
    pub theme_preference: Option<String>,   // Theme preference: 'light', 'dark', or 'system'
    pub updated_at: String,                 // ISO 8601 timestamp
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            theme_preference: Some("system".to_string()),
            updated_at: chrono::Utc::now().to_rfc3339(),
        }
    }
}
