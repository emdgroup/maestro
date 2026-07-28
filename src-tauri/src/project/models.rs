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
    /// Set to `false` when the user explicitly clears `issue_tracking`, so that
    /// `detect_project_issue_tracking` doesn't put it straight back on next open.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub issue_tracking_auto_detect: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reopen_sessions: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub startup_tab: Option<String>,
    /// Extra workspace roots handed to every agent alongside the session's own directory.
    ///
    /// Absolute paths on the machine the agent runs on, or `~`-relative; `~` is expanded there,
    /// not here, because for an SSH or WSL project that is a different machine. Kept out of
    /// `ProjectConfigResponse` deliberately — this is edited in the file, not the settings UI.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub additional_directories: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct ProjectIssueTrackingConfig {
    pub provider: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub integration_id: Option<String>,
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

        crate::core::project_storage::atomic_write(&config_path, json.as_bytes()).map_err(|e| {
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

        crate::core::project_storage::atomic_write(&state_path, json.as_bytes()).map_err(|e| {
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

#[cfg(test)]
mod tests {
    use super::*;

    /// `update_project_settings` writes the whole struct back after setting the three fields the
    /// settings UI owns. Additional directories are edited only in the file, so a round-trip that
    /// dropped them would silently erase a user's configuration the next time they touched any
    /// unrelated setting.
    #[test]
    fn additional_directories_survive_a_settings_ui_save() {
        let on_disk = r#"{
            "default_agent": "claude-acp",
            "updated_at": "2026-01-01T00:00:00Z",
            "additional_directories": ["/srv/shared", "~/notes"]
        }"#;

        let mut config: ProjectConfig =
            serde_json::from_str(on_disk).expect("settings.json should parse");
        assert_eq!(
            config.additional_directories.as_deref(),
            Some(["/srv/shared".to_string(), "~/notes".to_string()].as_slice())
        );

        config.default_agent = Some("other-acp".to_string());
        let written = serde_json::to_string(&config).expect("config should serialize");
        let reloaded: ProjectConfig =
            serde_json::from_str(&written).expect("written config should parse");

        assert_eq!(reloaded.additional_directories, config.additional_directories);
    }

    #[test]
    fn a_settings_file_without_the_key_still_parses() {
        let config: ProjectConfig = serde_json::from_str(r#"{"updated_at": ""}"#)
            .expect("a config predating additional_directories should still load");
        assert!(config.additional_directories.is_none());
    }

    #[test]
    fn absent_directories_are_not_written_back() {
        let config = ProjectConfig::default();
        let written = serde_json::to_string(&config).expect("config should serialize");
        assert!(
            !written.contains("additional_directories"),
            "an unset key should stay absent rather than appear as null: {written}"
        );
    }

    #[test]
    fn settings_and_state_saves_replace_existing_json() {
        let dir = tempfile::tempdir().expect("temp directory");
        let maestro_dir = dir.path().join(".maestro");
        std::fs::create_dir(&maestro_dir).expect("create .maestro");
        std::fs::write(maestro_dir.join("settings.json"), "stale settings").expect("seed settings");
        std::fs::write(maestro_dir.join("state.json"), "stale state").expect("seed state");
        let project_path = dir.path().to_str().expect("UTF-8 path");

        ProjectConfig::default().save_to_project(project_path).expect("save settings");
        ProjectState::empty().save_to_project(project_path).expect("save state");

        ProjectConfig::load_from_project(project_path).expect("load settings");
        ProjectState::load_from_project(project_path).expect("load state");
        assert_eq!(std::fs::read_dir(maestro_dir).expect("list .maestro").count(), 2);
    }
}
