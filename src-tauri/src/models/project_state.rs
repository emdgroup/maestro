use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json;
use std::fs;
use std::path::Path;
use specta::Type;

/// Snapshot of a task at a specific point in time for project state storage
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct TaskSnapshot {
    pub id: i32,
    pub title: String,
    pub description: String,
    /// Task status as string (e.g., "Backlog", "Ready", "InProgress", "Review", "Failed", "Done")
    pub status: String,
    pub skills: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_override: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mcp_allowlist: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skills_override: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub external_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_imported: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub import_source: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// Snapshot of a worktree at a specific point in time for project state storage
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct WorktreeSnapshot {
    pub id: i32,
    pub branch_name: String,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_id: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub git_status: Option<String>,
    pub created_at: String,
}

/// Project-level state stored in .maestro/state.json
/// Contains snapshots of all tasks and worktrees for this project
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct ProjectState {
    pub tasks: Vec<TaskSnapshot>,
    pub worktrees: Vec<WorktreeSnapshot>,
    pub updated_at: String,
    /// Schema version for future migrations; defaults to 1 for backward compatibility
    #[serde(default)]
    pub schema_version: u32,
}

impl ProjectState {
    /// Load project state from .maestro/state.json
    pub fn load_from_project(project_path: &str) -> Result<Self, String> {
        let state_path = Path::new(project_path)
            .join(".maestro")
            .join("state.json");

        let content = fs::read_to_string(&state_path).map_err(|e| {
            format!(
                "Failed to read {}: {}",
                state_path.display(),
                e
            )
        })?;

        serde_json::from_str(&content).map_err(|e| {
            format!("Invalid JSON in state.json: {}", e)
        })
    }

    /// Save project state to .maestro/state.json
    pub fn save_to_project(&self, project_path: &str) -> Result<(), String> {
        let maestro_dir = Path::new(project_path).join(".maestro");
        fs::create_dir_all(&maestro_dir).map_err(|e| {
            format!("Failed to create .maestro directory: {}", e)
        })?;

        let state_path = maestro_dir.join("state.json");
        let json = serde_json::to_string_pretty(&self).map_err(|e| {
            format!("Serialization failed: {}", e)
        })?;

        fs::write(&state_path, json).map_err(|e| {
            format!("Failed to write state.json: {}", e)
        })
    }

    /// Create an empty ProjectState with current timestamp
    pub fn empty() -> Self {
        ProjectState {
            tasks: vec![],
            worktrees: vec![],
            updated_at: Utc::now().to_rfc3339(),
            schema_version: 1,
        }
    }
}
