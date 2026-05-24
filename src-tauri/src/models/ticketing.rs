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
/// Serialized as an externally-tagged enum: `{"github": {...}}` (serde default for enums).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
#[specta(export)]
pub enum ProviderConfig {
    Github(GitHubConfig),
    Gitlab(GitLabConfig),
    Forgejo(ForgejoConfig),
    Linear(LinearConfig),
    Jiracloud(JiraCloudConfig),
    Jiraserver(JiraServerConfig),
    Azuredevops(AzureDevOpsConfig),
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
    pub instance_url: String,
    pub project_path: String,
    // i64 stored in Rust for precision; exported as number via i32 approximation in TypeScript
    // (GitLab project IDs in practice fit well within i32 range)
    #[specta(type = i32)]
    pub project_id: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Default)]
#[serde(default)]
pub struct ForgejoConfig {
    pub instance_url: String,
    pub owner: String,
    pub repo: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Default)]
#[serde(default)]
pub struct LinearConfig {
    pub team_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Default)]
#[serde(default)]
pub struct JiraCloudConfig {
    pub site_url: String,
    pub email: String,
    pub project_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Default)]
#[serde(default)]
pub struct JiraServerConfig {
    pub base_url: String,
    pub project_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Default)]
#[serde(default)]
pub struct AzureDevOpsConfig {
    pub org_url: String,
    pub project: String,
}

/// A remote issue fetched from a ticketing provider, ready for import as a Task.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct RemoteIssue {
    pub external_id: String,
    pub title: String,
    pub body: Option<String>,
    pub url: String,
    pub labels: Vec<String>,
    pub updated_at: Option<String>,
    pub priority: Option<String>,   // normalized: "Urgent"|"High"|"Medium"|"Low"|null
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
