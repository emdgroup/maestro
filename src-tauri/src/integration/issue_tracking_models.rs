use serde::{Deserialize, Serialize};
use specta::Type;

/// What `detect_project_issue_tracking` worked out from the project's git remote.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct DetectedIssueTracking {
    /// Provider the remote host belongs to.
    pub provider: String,
    /// Whether credentials for that provider are already available.
    pub connected: bool,
    /// Whether this call wrote the config into .maestro/settings.json. False when the
    /// project already had one, when the user opted out, when nothing is connected, or
    /// when a required field could not be resolved.
    pub applied: bool,
    /// Fields recovered from the remote URL — used to prefill the settings form when
    /// the config was not applied.
    pub config: crate::models::project::ProjectIssueTrackingConfig,
}

/// Ticketing integration configuration stored in .maestro/issue_tracking.json
#[derive(Debug, Clone, Serialize, Deserialize, Type, Default)]
#[serde(default)]
#[specta(export)]
pub struct IssueTrackingConfig {
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
    Gitea(GiteaConfig),
    Linear(LinearConfig),
    Jiracloud(JiraCloudConfig),
    Jiraserver(JiraServerConfig),
    Azuredevops(AzureDevOpsConfig),
    Bitbucket(BitbucketConfig),
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

#[derive(Debug, Clone, Serialize, Deserialize, Type, Default)]
#[serde(default)]
pub struct GiteaConfig {
    pub instance_url: String,
    pub owner: String,
    pub repo: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Default)]
#[serde(default)]
pub struct BitbucketConfig {
    pub instance_url: Option<String>,
    pub workspace: String,
    pub repo_slug: String,
}

/// A repository option returned by provider lookup commands for combobox display.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct RepoOption {
    pub name: String,
    pub description: Option<String>,
    pub clone_url: Option<String>,
}

/// A Jira Cloud project option for combobox display.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct JiraProjectOption {
    pub key: String,
    pub name: String,
    pub avatar_url: Option<String>,
    pub is_favourite: bool,
}

/// A GitLab project option for combobox display.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct GitLabProjectOption {
    #[specta(type = i32)]
    pub id: i64,
    pub path_with_namespace: String,
    pub name: String,
    pub clone_url: Option<String>,
}

/// An Azure DevOps project option for combobox display.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct AzureDevOpsProjectOption {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
}

/// An Azure DevOps git repository option for clone combobox display.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct AzureDevOpsRepoOption {
    pub id: String,
    pub name: String,
    pub project_name: String,
    pub clone_url: Option<String>,
}

/// A Bitbucket repository option for clone combobox display.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct BitbucketRepoOption {
    pub slug: String,
    pub name: String,
    pub description: Option<String>,
    pub clone_url: Option<String>,
}

/// A Bitbucket Server/DC project option for project key dropdown.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct BitbucketProjectOption {
    pub key: String,
    pub name: String,
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
    pub priority: Option<String>,    // normalized: "Urgent"|"High"|"Medium"|"Low"|null
    pub issue_type: Option<String>,  // e.g. "Bug", "Story", "Task", "Epic"
}

