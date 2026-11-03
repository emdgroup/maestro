//! The keys of a project's `.maestro/settings.json` the daemon reads. The app owns the file.

use maestro_protocol::WorkspaceMode;
use serde::Deserialize;

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct ProjectSettings {
    pub default_agent: Option<String>,
    /// The git remote the project's branches live on, when the user chose one.
    pub remote_name: Option<String>,
    pub base_branch: Option<String>,
    pub default_workspace_mode: Option<WorkspaceMode>,
    /// The key `default_workspace_mode` replaced: `false` meant the repository directory.
    pub default_worktree: Option<bool>,
}

/// A missing or unreadable file reads as the defaults, as the app treats it.
pub fn read(project_path: &str) -> ProjectSettings {
    std::fs::read_to_string(
        std::path::Path::new(project_path)
            .join(maestro_protocol::paths::MAESTRO_DIR)
            .join("settings.json"),
    )
    .ok()
    .and_then(|text| serde_json::from_str(&text).ok())
    .unwrap_or_default()
}
