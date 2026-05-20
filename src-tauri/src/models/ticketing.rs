use serde::{Deserialize, Serialize};
use serde_json;
use std::fs;
use std::path::Path;
use specta::Type;

/// Ticketing integration configuration stored in .maestro/ticketing.json
#[derive(Debug, Clone, Serialize, Deserialize, Type, Default)]
#[serde(default)]
#[specta(export)]
pub struct TicketingConfig {
    pub provider: Option<ProviderConfig>,
    pub updated_at: String,
}

/// Active ticketing provider — only one provider can be configured at a time.
/// Serialized as an externally-tagged enum: `{"jira": {...}}` (serde default for enums).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
#[specta(export)]
pub enum ProviderConfig {
    Jira(JiraConfig),
    GitHub(GitHubConfig),
    GitLab(GitLabConfig),
    Linear(LinearConfig),
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Default)]
#[serde(default)]
pub struct JiraConfig {
    pub host: String,
    pub email: String,
    pub project_key: String,
    pub jql_filter: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Default)]
#[serde(default)]
pub struct GitHubConfig {
    pub owner: String,
    pub repo: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Default)]
#[serde(default)]
pub struct GitLabConfig {
    pub host: String,
    pub project_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Default)]
#[serde(default)]
pub struct LinearConfig {
    pub team_id: String,
}

impl TicketingConfig {
    pub fn load_from_project(project_path: &str) -> Result<Self, String> {
        let config_path = Path::new(project_path)
            .join(".maestro")
            .join("ticketing.json");

        let content = fs::read_to_string(&config_path).map_err(|e| {
            format!("Failed to read {}: {}", config_path.display(), e)
        })?;

        serde_json::from_str(&content).map_err(|e| {
            format!("Invalid JSON in ticketing.json: {}", e)
        })
    }

    pub fn save_to_project(&self, project_path: &str) -> Result<(), String> {
        let maestro_dir = Path::new(project_path).join(".maestro");
        fs::create_dir_all(&maestro_dir).map_err(|e| {
            format!("Failed to create .maestro directory: {}", e)
        })?;

        let config_path = maestro_dir.join("ticketing.json");
        let json = serde_json::to_string_pretty(&self).map_err(|e| {
            format!("Serialization failed: {}", e)
        })?;

        fs::write(&config_path, json).map_err(|e| {
            format!("Failed to write ticketing.json: {}", e)
        })
    }
}
