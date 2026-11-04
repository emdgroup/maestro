//! Skills and MCP servers in Collections, and the tools agents need on a machine.

use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct CheckToolsRequest {
    pub tools: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "snake_case")]
pub enum ToolPathSource {
    Override,
    Path,
    SystemEnvironment,
    KnownLocation,
    ShellEnvironment,
    #[default]
    NotFound,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ToolCheckResult {
    pub tool: String,
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub configured_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_path: Option<String>,
    #[serde(default)]
    pub source: ToolPathSource,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct CheckToolsResponse {
    pub results: Vec<ToolCheckResult>,
}

/// One file of a skill, carried by value so the skills version with the Maestro app rather than
/// with the maestro-server release deployed on the target.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SkillFile {
    /// Path relative to the skills root, e.g. `maestro-output/references/canvas.md`.
    pub path: String,
    pub contents: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct InstallSkillsRequest {
    pub skills: Vec<SkillFile>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct InstallSkillsResponse {
    /// `false` when the target already had these exact skills and nothing was run.
    pub installed: bool,
}

/// One environment variable or header of a managed MCP server.
///
/// A secret's `value` is always `""` in `SaveMcpServers` and `ListMcpServersOk`: the app keeps it
/// in the OS keychain and hands it over through `SetMcpSecrets`, so it is never on disk here.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct McpKeyValue {
    pub key: String,
    pub value: String,
    #[serde(default)]
    pub secret: bool,
}

/// Stands for every agent in a managed MCP server's or skill's agent list, those installed later
/// included, where the other entries name one agent each.
pub const ALL_AGENTS: &str = "*";

/// An MCP server the user added through Maestro, injected into the sessions of the agents it lists.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ManagedMcpServer {
    pub name: String,
    /// `stdio`, `http` or `sse`.
    pub transport: String,
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: Vec<McpKeyValue>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub headers: Vec<McpKeyValue>,
    /// Maestro agent ids, e.g. `claude-acp`, or [`ALL_AGENTS`].
    #[serde(default)]
    pub agents: Vec<String>,
    /// The registry entry it was installed from, if any.
    #[serde(default)]
    pub catalog_id: Option<String>,
    /// How the app signs in to a remote server with OAuth. Kept for the app, never read here: the
    /// token it gets reaches the server as an ordinary `Authorization` secret.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub oauth: Option<serde_json::Value>,
}

/// A listing that can also look inside one project.
#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct ProjectScopedRequest {
    #[serde(default)]
    pub project_path: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct McpServerList {
    pub servers: Vec<ManagedMcpServer>,
    /// The project's `.mcp.json`, read as it is: every agent gets these, and Maestro does not
    /// edit them.
    #[serde(default)]
    pub project: Vec<ManagedMcpServer>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct SaveMcpServersRequest {
    pub servers: Vec<ManagedMcpServer>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct McpSecret {
    pub server: String,
    pub key: String,
    pub value: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct SetMcpSecretsRequest {
    pub secrets: Vec<McpSecret>,
}

/// The server to try, with its secret values filled in.
#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct TestMcpServerRequest {
    pub server: ManagedMcpServer,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct McpTestResult {
    pub ok: bool,
    pub tools: Vec<String>,
    pub error: Option<String>,
}

/// A skill in this machine's library.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ManagedSkill {
    pub name: String,
    /// `owner/repo` for a skill installed from the catalog, `None` for one written in Maestro.
    #[serde(default)]
    pub source: Option<String>,
    /// The whole `SKILL.md`, frontmatter included. Parsed by the app, which is what writes it.
    pub skill_md: String,
    /// Maestro agent id to whether the skill is installed for it. An agent set to `false` keeps
    /// its place, so the card still shows a switch to turn it back on. [`ALL_AGENTS`] set to
    /// `true` installs it for every agent the skills CLI knows.
    pub agents: std::collections::BTreeMap<String, bool>,
}

/// A skill a project carries in one of its agent directories, such as `.claude/skills/<name>`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProjectSkill {
    pub name: String,
    /// Relative to the project root, e.g. `.claude/skills/review`.
    pub dir: String,
    pub skill_md: String,
    /// Maestro agent ids that read that directory.
    pub agents: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct SkillList {
    pub skills: Vec<ManagedSkill>,
    /// Maestro agent ids the skills CLI can install for. The rest are drawn disabled.
    pub supported_agents: Vec<String>,
    #[serde(default)]
    pub project: Vec<ProjectSkill>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct ApplySkillRequest {
    pub name: String,
    /// Paths relative to the skill's own directory, e.g. `SKILL.md`. `None` leaves the library
    /// copy as it is, which is all a switch on the card needs.
    #[serde(default)]
    pub files: Option<Vec<SkillFile>>,
    #[serde(default)]
    pub source: Option<String>,
    pub agents: std::collections::BTreeMap<String, bool>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct DeleteSkillRequest {
    pub name: String,
}
