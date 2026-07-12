use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json;
use std::fs;
use std::path::Path;
use specta::Type;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct Project {
    pub id: i32,
    pub name: String,
    pub path: String,
    pub created_at: String,  // ISO 8601
    pub updated_at: String,  // ISO 8601
    pub last_opened: Option<String>, // ISO 8601
    pub connection_id: Option<i32>,  // Foreign key to ssh_connections; None = local project
    pub wsl_connection_id: Option<i32>, // Foreign key to wsl_connections; None = non-WSL project
    pub docker_connection_id: Option<i32>, // Foreign key to docker_connections; None = non-Docker project
}

impl Project {
    /// Check if this is a remote SSH project
    pub fn is_remote(&self) -> bool {
        self.connection_id.is_some()
    }

    /// Check if this is a WSL project
    pub fn is_wsl(&self) -> bool {
        self.wsl_connection_id.is_some()
    }

    /// Check if this is a Docker/Podman/nerdctl container project
    pub fn is_docker(&self) -> bool {
        self.docker_connection_id.is_some()
    }

    /// Parse a Project from a rusqlite Row.
    /// Expects columns: id, name, path, created_at, updated_at, last_opened, connection_id, wsl_connection_id, docker_connection_id
    pub fn from_row(row: &rusqlite::Row) -> rusqlite::Result<Self> {
        Ok(Project {
            id: row.get(0)?,
            name: row.get(1)?,
            path: row.get(2)?,
            created_at: row.get(3)?,
            updated_at: row.get(4)?,
            last_opened: row.get(5)?,
            connection_id: row.get(6)?,
            wsl_connection_id: row.get(7)?,
            docker_connection_id: row.get(8)?,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
#[serde(rename_all = "PascalCase")]
pub enum ProjectStatus {
    Active,
    Archived,
}

/// Project-specific configuration stored in .maestro/settings.json
#[derive(Debug, Clone, Serialize, Deserialize, Type, Default)]
#[serde(default)]
#[specta(export)]
pub struct ProjectConfig {
    pub default_agent: Option<String>,
    pub updated_at: String,
    pub issue_tracking: Option<ProjectIssueTrackingConfig>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reopen_sessions: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub startup_tab: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct ProjectIssueTrackingConfig {
    pub provider: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repo: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub team_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_name: Option<String>,
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

/// Convenience: build an updated_at timestamp
pub fn now_rfc3339() -> String {
    Utc::now().to_rfc3339()
}

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

/// Minimal session metadata persisted on app close for reopen-on-startup.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct SessionSnapshot {
    pub agent_id: String,
    pub acp_session_id: String,
    pub cwd: String,
    pub session_name: Option<String>,
    pub connection_key: crate::acp::ConnectionKey,
    pub branch_name: Option<String>,
    #[serde(default)]
    pub task_id: Option<i32>,
}

/// Project-level state stored in .maestro/state.json
/// Contains snapshots of all tasks and worktrees for this project
#[derive(Debug, Clone, Serialize, Deserialize, Type, Default)]
#[serde(default)]
#[specta(export)]
pub struct ProjectState {
    pub tasks: Vec<TaskSnapshot>,
    pub worktrees: Vec<WorktreeSnapshot>,
    pub updated_at: String,
    /// Schema version for future migrations; defaults to 1 for backward compatibility
    pub schema_version: u32,
    pub restorable_sessions: Vec<SessionSnapshot>,
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
            restorable_sessions: vec![],
        }
    }
}
