//! The keys of a project's `.maestro/settings.json` the daemon reads. The app owns the file.

use maestro_protocol::WorkspaceMode;
use serde::{Deserialize, Deserializer};

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct ProjectSettings {
    pub default_agent: Option<String>,
    /// The git remote the project's branches live on, when the user chose one.
    pub remote_name: Option<String>,
    pub base_branch: Option<String>,
    /// A value this build does not know reads as unset, rather than failing the whole file and
    /// taking every other key with it.
    #[serde(deserialize_with = "lenient")]
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

fn lenient<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<WorkspaceMode>, D::Error> {
    Ok(WorkspaceMode::deserialize(serde_json::Value::deserialize(deserializer)?).ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_unknown_workspace_mode_leaves_the_other_keys_readable() {
        let settings: ProjectSettings = serde_json::from_str(
            r#"{"default_agent":"claude","remote_name":"upstream","default_workspace_mode":"Teleport"}"#,
        )
        .unwrap();
        assert_eq!(settings.default_agent.as_deref(), Some("claude"));
        assert_eq!(settings.remote_name.as_deref(), Some("upstream"));
        assert_eq!(settings.default_workspace_mode, None);

        let settings: ProjectSettings =
            serde_json::from_str(r#"{"default_workspace_mode":"RepositoryDirectory"}"#).unwrap();
        assert_eq!(
            settings.default_workspace_mode,
            Some(WorkspaceMode::RepositoryDirectory)
        );
    }
}
