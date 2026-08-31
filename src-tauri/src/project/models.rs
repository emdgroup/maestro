use chrono::Utc;
use serde::{Deserialize, Serialize};
use specta::Type;

use crate::task::models::WorkspaceMode;

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
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
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
    /// Which forge hosts this project's remote, detected from `git remote -v`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code_hosting: Option<ProjectCodeHostingConfig>,
    /// Same opt-out as `issue_tracking_auto_detect`, for `code_hosting`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code_hosting_auto_detect: Option<bool>,
    /// Which git remote this project's branches live on — the name, not a URL.
    ///
    /// `None` *means* auto, resolved by `git::remote::pick_remote` (origin, then upstream, then
    /// whatever comes first). It needs no `_auto_detect` twin like the two settings above,
    /// because nothing ever writes this one on the user's behalf.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote_name: Option<String>,
    /// Which branch a new worktree is cut from, when a task or a session creates one.
    ///
    /// `None` *means* auto: the branch the repository is currently on, which is what Maestro used
    /// before this key existed. Like `remote_name` it needs no `_auto_detect` twin, because nothing
    /// ever writes it on the user's behalf. May name a remote-qualified branch such as
    /// `origin/main`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_branch: Option<String>,
    /// How approved work leaves Review. Absent means `Merge`, which is what Maestro did
    /// before this field existed — a project is never switched to the PR path by detection.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub landing_mode: Option<LandingMode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub startup_tab: Option<String>,
    /// Accent hue in degrees, as a string, matching `AppSettings::accent_color`.
    /// `None` means the project follows the global default colour.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub accent_color: Option<String>,
    /// Set to `false` once the colour has been decided, so that the first-open assignment
    /// doesn't hand the project a random one on next open. Needed because "follow the global
    /// default" stores no hue and would otherwise look exactly like "never chosen".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub accent_color_auto_assign: Option<bool>,
    /// Where work in this project happens by default: new tasks are created with this mode, and
    /// the New Session dialog opens on it. Only meaningful for a git project; a non-git one never
    /// offers the choice.
    ///
    /// `None` means the file predates the setting, in which case the legacy `default_worktree`
    /// below answers for it. Read through `default_workspace_mode()`, never directly.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_workspace_mode: Option<WorkspaceMode>,
    /// The boolean this setting used to be. Read-only: kept so a project that turned worktrees off
    /// before the modes existed is not silently turned back on. Cleared the first time the setting
    /// is written, so it disappears from the file rather than lingering as a second answer.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_worktree: Option<bool>,
    /// Extra workspace roots handed to every agent alongside the session's own directory.
    ///
    /// Absolute paths on the machine the agent runs on, or `~`-relative; `~` is expanded there,
    /// not here, because for an SSH or WSL project that is a different machine. Kept out of
    /// `ProjectConfigResponse` deliberately — this is edited in the file, not the settings UI.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub additional_directories: Option<Vec<String>>,
}

/// Hand-written rather than derived so the container's `#[serde(default)]` has something to fill
/// missing keys from; this is also what a `settings.json` written before any of these keys existed
/// reads back as.
impl Default for ProjectConfig {
    fn default() -> Self {
        Self {
            default_agent: None,
            updated_at: String::new(),
            issue_tracking: None,
            issue_tracking_auto_detect: None,
            code_hosting: None,
            code_hosting_auto_detect: None,
            remote_name: None,
            base_branch: None,
            landing_mode: None,
            startup_tab: None,
            accent_color: None,
            accent_color_auto_assign: None,
            default_workspace_mode: None,
            default_worktree: None,
            additional_directories: None,
        }
    }
}

impl ProjectConfig {
    /// The project's default, answering for the two shapes the setting has had.
    ///
    /// A worktree of its own is what Maestro did before either key existed, so an absent setting
    /// and an explicit `default_worktree: true` both land there.
    pub fn default_workspace_mode(&self) -> WorkspaceMode {
        self.default_workspace_mode.unwrap_or(match self.default_worktree {
            Some(false) => WorkspaceMode::RepositoryDirectory,
            _ => WorkspaceMode::NewWorktree,
        })
    }

    /// Records a new default and retires the legacy key, so the file never carries both.
    pub fn set_default_workspace_mode(&mut self, mode: WorkspaceMode) {
        self.default_workspace_mode = Some(mode);
        self.default_worktree = None;
    }
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

/// Where this project's remote is hosted, and enough of the remote's path to address it
/// through the forge's API.
///
/// Everything here is the same for every member of the team, which is what makes it safe
/// to keep in a committed file. Whether *you* hold a credential for `provider` is resolved
/// at approve time and deliberately not stored — a connected teammate must not be able to
/// commit a file telling an unconnected one that a PR is available.
#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq)]
#[specta(export)]
pub struct ProjectCodeHostingConfig {
    pub provider: String,
    /// Host of the remote URL, so a self-hosted instance stays distinguishable.
    pub host: String,
    /// Set only for the two-segment `owner/repo` shape every forge but GitLab and
    /// Azure DevOps uses.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repo: Option<String>,
    /// The whole remote path, so a namespace that nests deeper than `owner/repo` survives.
    pub project_path: String,
}

/// How approved work leaves Review.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, Default)]
#[serde(rename_all = "PascalCase")]
#[specta(export)]
pub enum LandingMode {
    /// Merge into the target branch locally. The default, and what shipped before PRs existed.
    #[default]
    Merge,
    /// Push the branch and open a pull request.
    PullRequest,
    /// Push the branch and stop there — someone else lands it.
    PushOnly,
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

/// Which directory a session ran in, so reopening it from Session History lands there again.
///
/// Keyed by agent as well as session, because session ids are only unique within one agent.
/// The path is relative to the project root: this file travels with the project, so a user on
/// another machine — or on a remote host — resolves it against a different absolute root.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct SessionFolder {
    pub agent_id: String,
    pub acp_session_id: String,
    /// Relative to the project root; empty means the project root itself.
    pub relative_path: String,
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
    /// Never cleared on restore, unlike `restorable_sessions`: this is history, not a hand-off.
    pub session_folders: Vec<SessionFolder>,
}

impl ProjectState {
    /// Create an empty ProjectState with current timestamp
    pub fn empty() -> Self {
        ProjectState {
            tasks: vec![],
            worktrees: vec![],
            updated_at: Utc::now().to_rfc3339(),
            schema_version: 1,
            restorable_sessions: vec![],
            session_folders: vec![],
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
        // A worktree of its own is what Maestro did before the setting existed, so a file written
        // before the key must not read back as opted out.
        assert_eq!(config.default_workspace_mode(), WorkspaceMode::NewWorktree);
    }

    /// The setting used to be a boolean. A project that turned it off said something, and reading
    /// its file after the upgrade must not quietly hand its agents a worktree again.
    #[test]
    fn the_legacy_worktree_boolean_still_answers_for_the_mode() {
        let opted_out: ProjectConfig =
            serde_json::from_str(r#"{"updated_at": "", "default_worktree": false}"#)
                .expect("a v0.18 settings file should still load");
        assert_eq!(
            opted_out.default_workspace_mode(),
            WorkspaceMode::RepositoryDirectory
        );

        let opted_in: ProjectConfig =
            serde_json::from_str(r#"{"updated_at": "", "default_worktree": true}"#)
                .expect("a v0.18 settings file should still load");
        assert_eq!(opted_in.default_workspace_mode(), WorkspaceMode::NewWorktree);

        // Writing the setting retires the legacy key rather than leaving two answers in the file.
        let mut config = opted_out;
        config.set_default_workspace_mode(WorkspaceMode::NewWorktree);
        let written = serde_json::to_string(&config).expect("config should serialize");
        assert!(
            !written.contains("default_worktree\""),
            "the legacy key should be gone after a write: {written}"
        );
        let reloaded: ProjectConfig =
            serde_json::from_str(&written).expect("written config should parse");
        assert_eq!(reloaded.default_workspace_mode(), WorkspaceMode::NewWorktree);
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

    /// A save over existing content replaces it and leaves no temporary behind, and unparseable
    /// content reads back as the default rather than failing — every caller treats a project that
    /// has never written the file as one holding defaults.
    #[tokio::test]
    async fn settings_and_state_saves_replace_existing_json() {
        use crate::core::project_storage::{read_maestro_json, write_maestro_json};
        use crate::models::GitConnection;

        let dir = tempfile::tempdir().expect("temp directory");
        let maestro_dir = dir.path().join(".maestro");
        std::fs::create_dir(&maestro_dir).expect("create .maestro");
        std::fs::write(maestro_dir.join("settings.json"), "stale settings").expect("seed settings");
        std::fs::write(maestro_dir.join("state.json"), "stale state").expect("seed state");

        let conn = GitConnection::Local {
            path: dir.path().to_str().expect("UTF-8 path").to_string(),
        };

        write_maestro_json(&conn, "settings.json", &ProjectConfig::default())
            .await
            .expect("save settings");
        write_maestro_json(&conn, "state.json", &ProjectState::empty())
            .await
            .expect("save state");

        let _: ProjectConfig = read_maestro_json(&conn, "settings.json").await;
        let _: ProjectState = read_maestro_json(&conn, "state.json").await;
        assert_eq!(std::fs::read_dir(maestro_dir).expect("list .maestro").count(), 2);
    }
}
