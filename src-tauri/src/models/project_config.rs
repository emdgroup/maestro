use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json;
use std::fs;
use std::path::Path;
use specta::Type;

/// Project-specific configuration stored in .maestro/settings.json
/// This replaces project-level settings currently stored in the database.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct ProjectConfig {
    /// Default model for this project's tasks (e.g., "claude-opus-4-5")
    pub model_default: String,

    /// MCP (Model Context Protocol) servers allowed for this project
    pub mcp_allowlist: Vec<String>,

    /// Default skills/tags for this project's tasks
    pub skills_default: Vec<String>,

    /// ISO 8601 timestamp of last update
    pub updated_at: String,
}

impl ProjectConfig {
    /// Load project configuration from .maestro/settings.json
    pub fn load_from_project(project_path: &str) -> Result<Self, String> {
        let config_path = Path::new(project_path)
            .join(".maestro")
            .join("settings.json");

        let content = fs::read_to_string(&config_path).map_err(|e| {
            format!(
                "Failed to read {}: {}",
                config_path.display(),
                e
            )
        })?;

        serde_json::from_str(&content).map_err(|e| {
            format!("Invalid JSON in settings.json: {}", e)
        })
    }

    /// Save project configuration to .maestro/settings.json
    pub fn save_to_project(&self, project_path: &str) -> Result<(), String> {
        let maestro_dir = Path::new(project_path).join(".maestro");
        fs::create_dir_all(&maestro_dir).map_err(|e| {
            format!("Failed to create .maestro directory: {}", e)
        })?;

        let config_path = maestro_dir.join("settings.json");
        let json = serde_json::to_string_pretty(&self).map_err(|e| {
            format!("Serialization failed: {}", e)
        })?;

        fs::write(&config_path, json).map_err(|e| {
            format!("Failed to write settings.json: {}", e)
        })
    }

    /// Create a default ProjectConfig with sensible defaults
    pub fn new_default() -> Self {
        ProjectConfig {
            model_default: "claude-sonnet-4-6".to_string(),
            mcp_allowlist: vec![],
            skills_default: vec![],
            updated_at: Utc::now().to_rfc3339(),
        }
    }
}
