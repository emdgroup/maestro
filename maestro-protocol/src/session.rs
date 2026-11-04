//! Agent sessions: spawning, prompting, loading and the updates they stream.

use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct HandshakeRequest {
    pub protocol_version: u32,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct HandshakeResponse {
    pub protocol_version: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AuthMethodInfo {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub method_type: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub args: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_cmd: Option<String>,
}

/// A tool an agent invoked on Maestro's own MCP server, on its way to the host.
///
/// The same struct travels all three hops — MCP shim to the running server over the loopback
/// gateway, server to Tauri over the framed stdio channel — so a tool that the server can answer
/// itself and one only the host can answer differ by where they stop, not by their shape.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct HostToolCall {
    pub session_id: String,
    pub request_id: String,
    pub name: String,
    pub arguments: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct HostToolResult {
    pub session_id: String,
    pub request_id: String,
    pub result: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct SpawnRequest {
    pub agent_id: String,
    pub session_id: String,
    pub cwd: String,
    /// Extra workspace roots from the project's `.maestro/settings.json`, verbatim.
    ///
    /// `~` is deliberately left unexpanded: these are resolved on the machine the agent runs
    /// on, which for an SSH or WSL project is not the one Tauri runs on.
    ///
    /// `default` so a Tauri and a `maestro-server` of different vintages still talk — the
    /// deployed binary is per project and can lag the app.
    #[serde(default)]
    pub additional_directories: Vec<String>,
    /// The project this session belongs to, which is what files it in the server's store.
    /// `None` is a session that belongs to no project, which gets no row.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_path: Option<String>,
    /// See [`SessionMeta`].
    #[serde(default)]
    pub meta: SessionMeta,
}

/// What a session is, beyond where it runs. Every field optional.
///
/// Typed rather than an opaque blob because the server stores each field in its own column: a
/// second machine opening the project has to read them, and a reload that sends fewer of them
/// must not lose the ones the row already holds.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct SessionMeta {
    /// The user's name for the session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_start_sha: Option<String>,
    /// The pipeline stage that started the session, as the host serializes its own enum. Opaque
    /// here, so a new stage never touches the protocol.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct ListAgentsRequest {}

/// Ask the server for every conversation one project holds.
///
/// Distinct from [`SessionListRequest`], which asks an *agent* what it has on disk for a folder.
/// This asks the *server* what the project has opened, which is the one answer a client needs to
/// adopt the running sessions and reload the dormant ones.
#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct ListProjectSessionsRequest {
    /// Canonicalized by the server, which runs on the machine the path exists on.
    pub project_path: String,
    /// Closed sessions are only wanted by Session History, which needs their name and folder.
    #[serde(default)]
    pub include_closed: bool,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct ListProjectSessionsResponse {
    pub sessions: Vec<ProjectSession>,
}

/// One conversation a project holds, running or not.
///
/// Keyed by `agent_id` and `acp_session_id`, not by the routing id: that one is minted again on
/// every reload, so it cannot name a conversation across them.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProjectSession {
    pub agent_id: String,
    pub acp_session_id: String,
    /// What `session/load` needs, and what Session History reopens in.
    pub cwd: String,
    #[serde(default)]
    pub meta: SessionMeta,
    /// Recorded at spawn, because whether an agent answers `session/load` cannot be asked once
    /// its session is gone.
    #[serde(default)]
    pub can_reload: bool,
    /// The project no longer has it open. Kept so Session History can still name it.
    #[serde(default)]
    pub closed: bool,
    /// Present while the server is running it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub live: Option<LiveSessionState>,
}

/// The part of a [`ProjectSession`] that only exists while the server is running it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LiveSessionState {
    /// The routing id, under which every later request finds this session.
    pub session_id: String,
    /// Whether the agent is mid-turn on this session right now.
    ///
    /// Decides what a client that has just attached may do to it: a session between turns can be
    /// closed and reloaded to recover its transcript, one mid-turn cannot without discarding the
    /// turn in progress.
    #[serde(default)]
    pub turn_active: bool,
    /// Requests this session is still waiting on an answer to.
    ///
    /// A permission or elicitation prompt outlives the client that was shown it: the agent is
    /// blocked on it, so the session is mid-turn and is adopted as it stands rather than reloaded.
    /// Replaying these to whoever adopts the session is the only way the prompt becomes answerable
    /// again, because the message that carried it went to a client that is gone.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub pending_requests: Vec<PendingSessionRequest>,
}

/// Rename a conversation in the server's store, where every client opening the project reads it.
///
/// Names the conversation by its key rather than by a routing id, deliberately: a dormant session
/// has none, and the request must not be routed as though it belonged to a live one.
#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct RenameSessionRequest {
    pub project_path: String,
    pub agent_id: String,
    pub acp_session_id: String,
    pub cwd: String,
    pub name: String,
}

/// Close a conversation in the server's store by its key.
///
/// `Cancel` names a session by its routing id, and a dormant conversation has none. Without this
/// one whose load can never succeed would stay open, and be tried again every time the project
/// is opened.
#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct CloseProjectSessionRequest {
    pub agent_id: String,
    pub acp_session_id: String,
}

/// A request the server sent a client and is still waiting on, replayed to the next client.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PendingSessionRequest {
    Permission(PermissionRequest),
    Elicitation(ElicitationRequest),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DiscoveredAgent {
    pub id: String,
    pub name: String,
    pub icon: String,
    /// Tools required to spawn this agent (e.g. ["npx"], ["uvx"]). Empty for binary agents.
    #[serde(default)]
    pub spawn_deps: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct DetectInstalledAgentsRequest {}

/// Info about an ACP agent whose underlying tool was detected on the host.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DetectedAgentInfo {
    /// ACP registry agent ID (e.g. "claude-acp").
    pub agent_id: String,
    /// User-facing tool name to display instead of ACP wrapper name (e.g. "Claude Code").
    pub tool_name: String,
    pub binary_found: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub binary_path: Option<String>,
    pub config_dir_found: bool,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct DetectInstalledAgentsResponse {
    /// Agents whose underlying tool was found (binary on PATH or config dir present).
    pub agents: Vec<DetectedAgentInfo>,
    /// All agent IDs that the detection table has an entry for (found OR not found).
    /// Tauri uses this to distinguish "not installed" from "not in detection table".
    pub all_checked_ids: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct ListAgentsResponse {
    pub agents: Vec<DiscoveredAgent>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct PromptRequest {
    pub session_id: String,
    /// String (legacy, wrapped in text block by receiver) or Array of ContentBlock JSON objects
    pub content: serde_json::Value,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct CancelRequest {
    pub session_id: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct InterruptTurnRequest {
    pub session_id: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct PreInitializeRequest {
    pub agent_id: String,
    pub cwd: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct AuthenticateRequest {
    pub agent_id: String,
    pub method_id: String,
    #[serde(default)]
    pub force_no_browser: bool,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct SpawnAuthTerminalRequest {
    pub agent_id: String,
    pub method_id: String,
    pub terminal_id: String,
    pub session_id: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct KillAuthTerminalRequest {
    pub terminal_id: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct AuthTerminalInputRequest {
    pub terminal_id: String,
    pub data: Vec<u8>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct LogoutRequest {
    pub agent_id: String,
}

/// A prompt went to the agent. Every prompt sends one, whoever sent it, so a session is mid-turn
/// from this until the [`TurnEnded`] that answers the last prompt outstanding. Output the agent
/// sends with no prompt outstanding is not a turn.
#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct TurnStarted {
    pub session_id: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct TurnEnded {
    pub session_id: String,
    pub stop_reason: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<TurnUsage>,
    /// The agent's `_meta.quota.model_usage`, kept raw: its field names differ by agent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_usage: Option<serde_json::Value>,
}

/// Token counts an agent reported on `PromptResponse.usage`, forwarded exactly as received.
///
/// Per turn in practice, whatever the draft spec says, and `input_tokens` does not mean the same
/// thing across agents (some count cache tokens in it, some do not).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TurnUsage {
    pub total_tokens: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thought_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cached_read_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cached_write_tokens: Option<u64>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct ModelInfo {
    pub model_id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct SessionModelState {
    pub current_model_id: String,
    pub available_models: Vec<ModelInfo>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct SetModelRequest {
    pub session_id: String,
    pub model_id: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct ModeInfo {
    pub mode_id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct SessionModeState {
    pub current_mode_id: String,
    pub available_modes: Vec<ModeInfo>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct SetModeRequest {
    pub session_id: String,
    pub mode_id: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct SetModeOkResponse {
    pub session_id: String,
    pub mode_id: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct SetConfigOptionRequest {
    pub session_id: String,
    pub config_id: String,
    pub value: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct ConfigOptionUpdatedResponse {
    pub session_id: String,
    pub config_id: String,
    pub value: String,
    pub config_options: Vec<serde_json::Value>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct PromptCapabilitiesInfo {
    pub embedded_context: bool,
    pub image: bool,
    pub audio: bool,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct FileSearchRequest {
    pub cwd: String,
    pub query: String,
    pub limit: Option<u32>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct FileReadRequest {
    pub cwd: String,
    pub relative_path: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct FileSearchResponse {
    pub files: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct FileReadResponse {
    pub content: String,
}

// --- Session management types ---

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct SessionListRequest {
    pub agent_id: String,
    pub cwd: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct SessionLoadRequest {
    pub agent_id: String,
    /// Maestro routing key for this session: the id the host minted for it. Used by
    /// maestro-server to key the session in its internal map so all subsequent
    /// Prompt/Permission/etc. requests (which use the same routing key) find it.
    pub session_id: String,
    /// The agent's real session ID to restore (e.g. a claude-code conversation ID).
    pub resume_session_id: String,
    pub cwd: String,
    /// See [`SpawnRequest::additional_directories`].
    #[serde(default)]
    pub additional_directories: Vec<String>,
    /// The project this session belongs to, which is what files it in the server's store.
    /// `None` is a session that belongs to no project, which gets no row.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_path: Option<String>,
    /// See [`SessionMeta`].
    #[serde(default)]
    pub meta: SessionMeta,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct SessionCloseRequest {
    pub agent_id: String,
    pub session_id: String,
    pub cwd: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct SessionDeleteRequest {
    pub agent_id: String,
    pub session_id: String,
    pub cwd: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SessionListEntry {
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct SessionListOkResponse {
    pub sessions: Vec<SessionListEntry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
    /// Filled in by maestro-server from the live connection's capabilities.
    /// Tauri uses this to tell the frontend whether the delete button should appear.
    #[serde(default)]
    pub supports_session_delete: bool,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct SessionLoadOkResponse {
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub models: Option<SessionModelState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modes: Option<SessionModeState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt_capabilities: Option<PromptCapabilitiesInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config_options: Option<Vec<serde_json::Value>>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct SpawnResponse {
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub acp_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub models: Option<SessionModelState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modes: Option<SessionModeState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt_capabilities: Option<PromptCapabilitiesInfo>,
    #[serde(default)]
    pub supports_session_list: bool,
    #[serde(default)]
    pub supports_session_load: bool,
    #[serde(default)]
    pub supports_session_close: bool,
    #[serde(default)]
    pub supports_session_delete: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config_options: Option<Vec<serde_json::Value>>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct PreInitializeResponse {
    pub agent_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt_capabilities: Option<PromptCapabilitiesInfo>,
    #[serde(default)]
    pub supports_session_list: bool,
    #[serde(default)]
    pub supports_session_load: bool,
    #[serde(default)]
    pub supports_session_close: bool,
    #[serde(default)]
    pub supports_session_delete: bool,
    #[serde(default)]
    pub auth_methods: Vec<AuthMethodInfo>,
    #[serde(default)]
    pub supports_auth_logout: bool,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct AuthTerminalExitResponse {
    pub terminal_id: String,
    pub agent_id: String,
    pub exit_code: Option<i32>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct DiagnosticPayload {
    /// "info" | "warn" | "error"
    pub level: String,
    pub message: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct ErrorResponse {
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct SessionUpdate {
    pub session_id: String,
    pub payload: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PermissionRequest {
    pub session_id: String,
    pub request_id: String,
    pub payload: serde_json::Value,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct PermissionResponse {
    pub session_id: String,
    pub request_id: String,
    pub option_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ElicitationRequest {
    pub session_id: String,
    pub request_id: String,
    pub message: String,
    pub payload: serde_json::Value,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct ElicitationResponse {
    pub session_id: String,
    pub request_id: String,
    pub response: serde_json::Value,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct TerminalOutput {
    pub session_id: String,
    pub terminal_id: String,
    pub bytes: Vec<u8>,
}

#[cfg(test)]
mod tests {
    use crate::*;

    #[test]
    fn turn_ended_without_usage_still_decodes() {
        // What a daemon from before token usage sends.
        let ended: TurnEnded =
            serde_json::from_str(r#"{"session_id":"sess-1","stop_reason":"end_turn"}"#).unwrap();
        assert_eq!(ended.usage, None);
        assert_eq!(ended.model_usage, None);
    }
}
