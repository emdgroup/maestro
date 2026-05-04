use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json;
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use specta::Type;

/// Project-specific configuration stored in .maestro/settings.json
#[derive(Debug, Clone, Serialize, Deserialize, Type, Default)]
#[serde(default)]
#[specta(export)]
pub struct ProjectConfig {
    pub default_agent: Option<String>,
    pub default_model: Option<String>,
    pub updated_at: String,
}

impl ProjectConfig {
    pub fn load_from_project(project_path: &str) -> Result<Self, String> {
        let config_path = Path::new(project_path)
            .join(".maestro")
            .join("settings.json");

        let content = fs::read_to_string(&config_path).map_err(|e| {
            format!("Failed to read {}: {}", config_path.display(), e)
        })?;

        serde_json::from_str(&content).map_err(|e| {
            format!("Invalid JSON in settings.json: {}", e)
        })
    }

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
}

/// Per-agent model cache entry stored in .maestro/agent_models_cache.json
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentModelEntry {
    pub models: Vec<ProjectModelInfo>,
    pub fetched_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectModelInfo {
    pub model_id: String,
    pub name: String,
    pub description: Option<String>,
}

pub type AgentModelsMap = HashMap<String, AgentModelEntry>;

pub fn load_agent_models_cache(project_path: &str) -> Result<AgentModelsMap, String> {
    let cache_path = Path::new(project_path)
        .join(".maestro")
        .join("agent_models_cache.json");

    if !cache_path.exists() {
        return Ok(HashMap::new());
    }

    let content = fs::read_to_string(&cache_path).map_err(|e| {
        format!("Failed to read agent_models_cache.json: {}", e)
    })?;

    serde_json::from_str(&content).map_err(|e| {
        format!("Invalid JSON in agent_models_cache.json: {}", e)
    })
}

pub fn save_agent_models_cache(project_path: &str, cache: &AgentModelsMap) -> Result<(), String> {
    let maestro_dir = Path::new(project_path).join(".maestro");
    fs::create_dir_all(&maestro_dir).map_err(|e| {
        format!("Failed to create .maestro directory: {}", e)
    })?;

    let cache_path = maestro_dir.join("agent_models_cache.json");
    let json = serde_json::to_string_pretty(cache).map_err(|e| {
        format!("Serialization failed: {}", e)
    })?;

    fs::write(&cache_path, json).map_err(|e| {
        format!("Failed to write agent_models_cache.json: {}", e)
    })
}

/// Convenience: build an updated_at timestamp
pub fn now_rfc3339() -> String {
    Utc::now().to_rfc3339()
}
