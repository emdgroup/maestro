use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

pub const MSG_LEN_SIZE: usize = 4;
pub const MAX_MESSAGE_SIZE: usize = 16 * 1024 * 1024; // 16 MB — reject oversized payloads (T-41-01)
pub const PROTOCOL_VERSION: u32 = 1;

// --- Top-level envelope ---

#[derive(Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "direction", rename_all = "snake_case")]
pub enum MaestroRpcMessage {
    Request(ServerRequest),
    Response(ServerResponse),
}

// --- Client -> Server ---

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct HandshakeRequest {
    pub protocol_version: u32,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct HandshakeResponse {
    pub protocol_version: u32,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerRequest {
    Handshake(HandshakeRequest),
    Spawn(SpawnRequest),
    Prompt(PromptRequest),
    Cancel(CancelRequest),
    InterruptTurn(InterruptTurnRequest),
    PermitResponse(PermissionResponse),
    ElicitationResponse(ElicitationResponse),
    ListAgents(ListAgentsRequest),
    SetModel(SetModelRequest),
    SetMode(SetModeRequest),
    SetConfigOption(SetConfigOptionRequest),
    FileSearch(FileSearchRequest),
    FileRead(FileReadRequest),
    SessionList(SessionListRequest),
    SessionLoad(SessionLoadRequest),
    SessionClose(SessionCloseRequest),
    SessionDelete(SessionDeleteRequest),
    PreInitialize(PreInitializeRequest),
    CheckTools(CheckToolsRequest),
    DetectInstalledAgents(DetectInstalledAgentsRequest),
    DetectProjectAgents(DetectProjectAgentsRequest),
    /// Heartbeat acknowledgment sent by Tauri in response to a `Ping`.
    Pong { seq: u64 },
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct SpawnRequest {
    pub agent_id: String,
    pub session_id: String,
    pub cwd: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct ListAgentsRequest {}

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
pub struct CheckToolsRequest {
    pub tools: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ToolCheckResult {
    pub tool: String,
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct CheckToolsResponse {
    pub results: Vec<ToolCheckResult>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct DetectInstalledAgentsRequest {}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct DetectProjectAgentsRequest {
    pub cwd: String,
}

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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProjectAgentMarker {
    pub agent_id: String,
    pub markers_found: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct DetectProjectAgentsResponse {
    pub agents: Vec<ProjectAgentMarker>,
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

// --- Server -> Client ---

#[derive(Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerResponse {
    HandshakeOk(HandshakeResponse),
    SpawnOk(SpawnResponse),
    Error(ErrorResponse),
    SessionUpdate(SessionUpdate),
    PermissionRequest(PermissionRequest),
    ElicitationRequest(ElicitationRequest),
    TerminalOutput(TerminalOutput),
    ListAgentsOk(ListAgentsResponse),
    SetModelOk(SetModelOkResponse),
    SetModeOk(SetModeOkResponse),
    SetConfigOptionOk(SetConfigOptionOkResponse),
    ConfigOptionUpdated(ConfigOptionUpdatedResponse),
    FileSearchOk(FileSearchResponse),
    FileReadOk(FileReadResponse),
    TurnEnded(TurnEnded),
    SessionListOk(SessionListOkResponse),
    SessionLoadOk(SessionLoadOkResponse),
    SessionCloseOk,
    SessionDeleteOk,
    PreInitializeOk(PreInitializeResponse),
    AgentConnectionLost(AgentConnectionLost),
    CheckToolsOk(CheckToolsResponse),
    DetectInstalledAgentsOk(DetectInstalledAgentsResponse),
    DetectProjectAgentsOk(DetectProjectAgentsResponse),
    /// Periodic heartbeat from maestro-server. Tauri responds with `Pong { seq }`.
    Ping { seq: u64 },
    /// Unsolicited diagnostic event from maestro-server for logging and observability.
    Diagnostic(DiagnosticPayload),
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct TurnEnded {
    pub session_id: String,
    pub stop_reason: String,
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

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct SetModelOkResponse {
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
pub struct SetConfigOptionOkResponse {
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
    /// Maestro routing key for this session (e.g. "session-{log_id}"). Used by
    /// maestro-server to key the session in its internal map so all subsequent
    /// Prompt/Permission/etc. requests (which use the same routing key) find it.
    pub session_id: String,
    /// The agent's real session ID to restore (e.g. a claude-code conversation ID).
    pub resume_session_id: String,
    pub cwd: String,
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
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct AgentConnectionLost {
    pub agent_id: String,
    pub reason: String,
    pub affected_session_ids: Vec<String>,
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

#[derive(Debug, Serialize, Deserialize, PartialEq)]
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

#[derive(Debug, Serialize, Deserialize, PartialEq)]
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

pub async fn write_message<W: AsyncWrite + Unpin>(
    stream: &mut W,
    msg: &MaestroRpcMessage,
) -> Result<(), Box<dyn std::error::Error>> {
    let bytes = serde_json::to_vec(msg)?;
    if bytes.len() > MAX_MESSAGE_SIZE {
        return Err(format!("Message too large to send: {} bytes (max {})", bytes.len(), MAX_MESSAGE_SIZE).into());
    }
    let len = bytes.len() as u32;
    stream.write_all(&len.to_le_bytes()).await?;
    stream.write_all(&bytes).await?;
    Ok(())
}

pub async fn read_message<R: AsyncRead + Unpin>(
    stream: &mut R,
) -> Result<MaestroRpcMessage, Box<dyn std::error::Error>> {
    let mut len_buf = [0u8; MSG_LEN_SIZE];
    stream.read_exact(&mut len_buf).await?;
    let len = u32::from_le_bytes(len_buf) as usize;
    if len > MAX_MESSAGE_SIZE {
        return Err(format!("Message too large: {} bytes (max {})", len, MAX_MESSAGE_SIZE).into());
    }
    let mut body = vec![0u8; len];
    stream.read_exact(&mut body).await?;
    Ok(serde_json::from_slice(&body)?)
}

/// Synchronous version of [`read_message`] for use in `spawn_blocking` reader threads.
///
/// On Windows, anonymous pipes don't support overlapped I/O (IOCP), so the async
/// version uses `spawn_blocking` internally. If the future is dropped while a read
/// is in flight (e.g. when a `tokio::select!` picks another arm), the blocking thread
/// continues and the 4-byte length prefix gets silently discarded — causing framing
/// desync. This function is meant to run in a dedicated blocking thread that is never
/// dropped, writing results to an mpsc channel instead.
pub fn read_message_sync<R: std::io::Read>(
    stream: &mut R,
) -> Result<MaestroRpcMessage, Box<dyn std::error::Error + Send + Sync>> {
    let mut len_buf = [0u8; MSG_LEN_SIZE];
    stream.read_exact(&mut len_buf)?;
    let len = u32::from_le_bytes(len_buf) as usize;
    if len > MAX_MESSAGE_SIZE {
        return Err(format!("Message too large: {} bytes (max {})", len, MAX_MESSAGE_SIZE).into());
    }
    let mut body = vec![0u8; len];
    stream.read_exact(&mut body)?;
    Ok(serde_json::from_slice(&body)?)
}

// --- CDN registry types — used by maestro-server for agent discovery ---

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AcpRegistry {
    pub version: String,
    pub agents: Vec<AgentRegistryEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AgentRegistryEntry {
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub description: Option<String>,
    pub distribution: AgentDistribution,
    #[serde(default)]
    pub repository: Option<String>,
    #[serde(default)]
    pub authors: Option<Vec<String>>,
    #[serde(default)]
    pub license: Option<String>,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub website: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct AgentDistribution {
    #[serde(default)]
    pub npx: Option<NpxDistribution>,
    #[serde(default)]
    pub binary: Option<HashMap<String, BinaryTarget>>,
    #[serde(default)]
    pub uvx: Option<UvxDistribution>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NpxDistribution {
    pub package: String,
    #[serde(default)]
    pub args: Option<Vec<String>>,
    #[serde(default)]
    pub env: Option<HashMap<String, String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BinaryTarget {
    pub archive: String,
    pub cmd: String,
    #[serde(default)]
    pub args: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct UvxDistribution {
    pub package: String,
    #[serde(default)]
    pub args: Option<Vec<String>>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_handshake() {
        let req = MaestroRpcMessage::Request(ServerRequest::Handshake(HandshakeRequest {
            protocol_version: PROTOCOL_VERSION,
        }));
        let json = serde_json::to_string(&req).unwrap();
        let back: MaestroRpcMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(req, back);

        let resp = MaestroRpcMessage::Response(ServerResponse::HandshakeOk(HandshakeResponse {
            protocol_version: PROTOCOL_VERSION,
        }));
        let json = serde_json::to_string(&resp).unwrap();
        let back: MaestroRpcMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(resp, back);
    }

    #[test]
    fn roundtrip_spawn_request() {
        let msg = MaestroRpcMessage::Request(ServerRequest::Spawn(SpawnRequest {
            agent_id: "claude-acp".to_string(),
            session_id: "sess-1".to_string(),
            cwd: "/home/user/project".to_string(),
        }));
        let json = serde_json::to_string(&msg).unwrap();
        let back: MaestroRpcMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(msg, back);
    }

    #[test]
    fn roundtrip_prompt_request() {
        let msg = MaestroRpcMessage::Request(ServerRequest::Prompt(PromptRequest {
            session_id: "sess-1".to_string(),
            content: serde_json::Value::String("fix the bug in auth.rs".to_string()),
        }));
        let json = serde_json::to_string(&msg).unwrap();
        let back: MaestroRpcMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(msg, back);
    }

    #[test]
    fn roundtrip_cancel_request() {
        let msg = MaestroRpcMessage::Request(ServerRequest::Cancel(CancelRequest {
            session_id: "sess-1".to_string(),
        }));
        let json = serde_json::to_string(&msg).unwrap();
        let back: MaestroRpcMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(msg, back);
    }

    #[test]
    fn roundtrip_interrupt_turn_request() {
        let msg = MaestroRpcMessage::Request(ServerRequest::InterruptTurn(InterruptTurnRequest {
            session_id: "sess-1".to_string(),
        }));
        let json = serde_json::to_string(&msg).unwrap();
        let back: MaestroRpcMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(msg, back);
    }

    #[test]
    fn roundtrip_spawn_ok_response() {
        let msg = MaestroRpcMessage::Response(ServerResponse::SpawnOk(SpawnResponse {
            session_id: "sess-1".to_string(),
            acp_session_id: None,
            models: None,
            modes: None,
            prompt_capabilities: None,
            supports_session_list: false,
            supports_session_load: false,
            supports_session_close: false,
            config_options: None,
        }));
        let json = serde_json::to_string(&msg).unwrap();
        let back: MaestroRpcMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(msg, back);
    }

    #[test]
    fn roundtrip_spawn_ok_with_models() {
        let msg = MaestroRpcMessage::Response(ServerResponse::SpawnOk(SpawnResponse {
            session_id: "sess-1".to_string(),
            acp_session_id: Some("native-uuid-123".to_string()),
            prompt_capabilities: Some(PromptCapabilitiesInfo {
                embedded_context: true,
                image: false,
                audio: false,
            }),
            modes: None,
            models: Some(SessionModelState {
                current_model_id: "claude-sonnet-4-6".to_string(),
                available_models: vec![
                    ModelInfo {
                        model_id: "claude-opus-4-7".to_string(),
                        name: "Opus 4.7".to_string(),
                        description: None,
                    },
                    ModelInfo {
                        model_id: "claude-sonnet-4-6".to_string(),
                        name: "Sonnet 4.6".to_string(),
                        description: Some("Fast and capable".to_string()),
                    },
                ],
            }),
            supports_session_list: false,
            supports_session_load: false,
            supports_session_close: false,
            config_options: None,
        }));
        let json = serde_json::to_string(&msg).unwrap();
        let back: MaestroRpcMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(msg, back);
    }

    #[test]
    fn roundtrip_set_model_request() {
        let msg = MaestroRpcMessage::Request(ServerRequest::SetModel(SetModelRequest {
            session_id: "sess-1".to_string(),
            model_id: "claude-opus-4-7".to_string(),
        }));
        let json = serde_json::to_string(&msg).unwrap();
        let back: MaestroRpcMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(msg, back);
    }

    #[test]
    fn roundtrip_set_model_ok_response() {
        let msg = MaestroRpcMessage::Response(ServerResponse::SetModelOk(SetModelOkResponse {
            session_id: "sess-1".to_string(),
            model_id: "claude-opus-4-7".to_string(),
        }));
        let json = serde_json::to_string(&msg).unwrap();
        let back: MaestroRpcMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(msg, back);
    }

    #[test]
    fn roundtrip_error_response() {
        let msg = MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
            message: "agent not found".to_string(),
            session_id: None,
        }));
        let json = serde_json::to_string(&msg).unwrap();
        let back: MaestroRpcMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(msg, back);
    }

    #[test]
    fn roundtrip_session_update() {
        let msg = MaestroRpcMessage::Response(ServerResponse::SessionUpdate(SessionUpdate {
            session_id: "sess-1".to_string(),
            payload: serde_json::json!({"type": "agent_message_chunk", "text": "hello"}),
        }));
        let json = serde_json::to_string(&msg).unwrap();
        let back: MaestroRpcMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(msg, back);
    }

    #[test]
    fn roundtrip_permission_request() {
        let msg = MaestroRpcMessage::Response(ServerResponse::PermissionRequest(PermissionRequest {
            session_id: "sess-1".to_string(),
            request_id: "perm-42".to_string(),
            payload: serde_json::json!({"tool": "write_file", "path": "/tmp/foo.txt"}),
        }));
        let json = serde_json::to_string(&msg).unwrap();
        let back: MaestroRpcMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(msg, back);
    }

    #[test]
    fn roundtrip_terminal_output() {
        let msg = MaestroRpcMessage::Response(ServerResponse::TerminalOutput(TerminalOutput {
            session_id: "sess-1".to_string(),
            terminal_id: "term-1".to_string(),
            bytes: vec![0x1b, 0x5b, 0x32, 0x4a], // ESC[2J
        }));
        let json = serde_json::to_string(&msg).unwrap();
        let back: MaestroRpcMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(msg, back);
    }

    #[test]
    fn roundtrip_permission_response() {
        let resp = PermissionResponse {
            session_id: "sess-1".to_string(),
            request_id: "perm-42".to_string(),
            option_id: Some("default".into()),
        };
        let json = serde_json::to_string(&resp).unwrap();
        let back: PermissionResponse = serde_json::from_str(&json).unwrap();
        assert_eq!(resp, back);
    }

    #[tokio::test]
    async fn framing_write_then_read_roundtrip() {
        let msg = MaestroRpcMessage::Request(ServerRequest::Spawn(SpawnRequest {
            agent_id: "gemini".to_string(),
            session_id: "sess-99".to_string(),
            cwd: "/tmp".to_string(),
        }));

        let mut buf: Vec<u8> = Vec::new();
        write_message(&mut buf, &msg).await.unwrap();

        let mut cursor = std::io::Cursor::new(buf);
        let back = read_message(&mut cursor).await.unwrap();
        assert_eq!(msg, back);
    }

    #[tokio::test]
    async fn read_message_rejects_oversized() {
        // Craft a length prefix claiming 32 MB
        let fake_len: u32 = 32 * 1024 * 1024;
        let mut buf = Vec::new();
        buf.extend_from_slice(&fake_len.to_le_bytes());
        buf.extend_from_slice(&[0u8; 64]); // some body bytes (doesn't matter)

        let mut cursor = std::io::Cursor::new(buf);
        let result = read_message(&mut cursor).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("Message too large"));
    }

    #[test]
    fn roundtrip_permit_response_request() {
        let msg = MaestroRpcMessage::Request(ServerRequest::PermitResponse(PermissionResponse {
            session_id: "sess-1".to_string(),
            request_id: "perm-42".to_string(),
            option_id: Some("default".into()),
        }));
        let json = serde_json::to_string(&msg).unwrap();
        let back: MaestroRpcMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(msg, back);
    }

    #[tokio::test]
    async fn framing_permit_response_roundtrip() {
        let msg = MaestroRpcMessage::Request(ServerRequest::PermitResponse(PermissionResponse {
            session_id: "sess-1".to_string(),
            request_id: "perm-42".to_string(),
            option_id: None,
        }));
        let mut buf: Vec<u8> = Vec::new();
        write_message(&mut buf, &msg).await.unwrap();
        let mut cursor = std::io::Cursor::new(buf);
        let back = read_message(&mut cursor).await.unwrap();
        assert_eq!(msg, back);
    }

    #[test]
    fn roundtrip_file_search_request() {
        let msg = MaestroRpcMessage::Request(ServerRequest::FileSearch(FileSearchRequest {
            cwd: "/home/user/project".to_string(),
            query: "main".to_string(),
            limit: Some(20),
        }));
        let json = serde_json::to_string(&msg).unwrap();
        let back: MaestroRpcMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(msg, back);
    }

    #[test]
    fn roundtrip_file_search_ok() {
        let msg = MaestroRpcMessage::Response(ServerResponse::FileSearchOk(FileSearchResponse {
            files: vec!["src/main.rs".to_string(), "src/lib.rs".to_string()],
        }));
        let json = serde_json::to_string(&msg).unwrap();
        let back: MaestroRpcMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(msg, back);
    }

    #[test]
    fn roundtrip_file_read_request() {
        let msg = MaestroRpcMessage::Request(ServerRequest::FileRead(FileReadRequest {
            cwd: "/home/user/project".to_string(),
            relative_path: "src/main.rs".to_string(),
        }));
        let json = serde_json::to_string(&msg).unwrap();
        let back: MaestroRpcMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(msg, back);
    }

    #[test]
    fn roundtrip_file_read_ok() {
        let msg = MaestroRpcMessage::Response(ServerResponse::FileReadOk(FileReadResponse {
            content: "fn main() {}".to_string(),
        }));
        let json = serde_json::to_string(&msg).unwrap();
        let back: MaestroRpcMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(msg, back);
    }

    #[test]
    fn roundtrip_turn_ended() {
        let msg = MaestroRpcMessage::Response(ServerResponse::TurnEnded(TurnEnded {
            session_id: "sess-1".to_string(),
            stop_reason: "end_turn".to_string(),
        }));
        let json = serde_json::to_string(&msg).unwrap();
        let back: MaestroRpcMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(msg, back);
    }

    #[test]
    fn roundtrip_set_mode_request() {
        let msg = MaestroRpcMessage::Request(ServerRequest::SetMode(SetModeRequest {
            session_id: "sess-1".to_string(),
            mode_id: "plan".to_string(),
        }));
        let json = serde_json::to_string(&msg).unwrap();
        let back: MaestroRpcMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(msg, back);
    }

    #[test]
    fn roundtrip_set_mode_ok_response() {
        let msg = MaestroRpcMessage::Response(ServerResponse::SetModeOk(SetModeOkResponse {
            session_id: "sess-1".to_string(),
            mode_id: "plan".to_string(),
        }));
        let json = serde_json::to_string(&msg).unwrap();
        let back: MaestroRpcMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(msg, back);
    }

    #[test]
    fn roundtrip_spawn_ok_with_modes() {
        let msg = MaestroRpcMessage::Response(ServerResponse::SpawnOk(SpawnResponse {
            session_id: "sess-1".to_string(),
            acp_session_id: None,
            models: None,
            modes: Some(SessionModeState {
                current_mode_id: "default".to_string(),
                available_modes: vec![
                    ModeInfo {
                        mode_id: "default".to_string(),
                        name: "Ask before edits".to_string(),
                        description: None,
                    },
                    ModeInfo {
                        mode_id: "acceptEdits".to_string(),
                        name: "Edit automatically".to_string(),
                        description: Some("File ops auto-approved".to_string()),
                    },
                ],
            }),
            prompt_capabilities: None,
            supports_session_list: false,
            supports_session_load: false,
            supports_session_close: false,
            config_options: None,
        }));
        let json = serde_json::to_string(&msg).unwrap();
        let back: MaestroRpcMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(msg, back);
    }

    #[test]
    fn request_and_response_are_distinguishable() {
        // Verify that a Spawn request and a SpawnOk response both containing session_id
        // are correctly distinguished by the "direction" tag
        let req = MaestroRpcMessage::Request(ServerRequest::Spawn(SpawnRequest {
            agent_id: "test".to_string(),
            session_id: "sess-1".to_string(),
            cwd: "/tmp".to_string(),
        }));
        let resp = MaestroRpcMessage::Response(ServerResponse::SpawnOk(SpawnResponse {
            session_id: "sess-1".to_string(),
            acp_session_id: None,
            models: None,
            modes: None,
            prompt_capabilities: None,
            supports_session_list: false,
            supports_session_load: false,
            supports_session_close: false,
            config_options: None,
        }));
        let req_json = serde_json::to_string(&req).unwrap();
        let resp_json = serde_json::to_string(&resp).unwrap();
        // Verify they produce different JSON
        assert_ne!(req_json, resp_json);
        // Verify each round-trips to the correct variant
        let req_back: MaestroRpcMessage = serde_json::from_str(&req_json).unwrap();
        let resp_back: MaestroRpcMessage = serde_json::from_str(&resp_json).unwrap();
        assert!(matches!(req_back, MaestroRpcMessage::Request(_)));
        assert!(matches!(resp_back, MaestroRpcMessage::Response(_)));
    }

    #[test]
    fn roundtrip_pre_initialize_request() {
        let msg = MaestroRpcMessage::Request(ServerRequest::PreInitialize(PreInitializeRequest {
            agent_id: "claude-acp".to_string(),
            cwd: "/home/user/project".to_string(),
        }));
        let json = serde_json::to_string(&msg).unwrap();
        let back: MaestroRpcMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(msg, back);
    }

    #[test]
    fn roundtrip_pre_initialize_ok() {
        let msg = MaestroRpcMessage::Response(ServerResponse::PreInitializeOk(PreInitializeResponse {
            agent_id: "claude-acp".to_string(),
            prompt_capabilities: Some(PromptCapabilitiesInfo {
                embedded_context: true,
                image: false,
                audio: false,
            }),
            supports_session_list: true,
            supports_session_load: true,
            supports_session_close: false,
        }));
        let json = serde_json::to_string(&msg).unwrap();
        let back: MaestroRpcMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(msg, back);
    }

    #[test]
    fn roundtrip_agent_connection_lost() {
        let msg = MaestroRpcMessage::Response(ServerResponse::AgentConnectionLost(AgentConnectionLost {
            agent_id: "claude-acp".to_string(),
            reason: "agent process exited unexpectedly".to_string(),
            affected_session_ids: vec!["session-1".to_string(), "session-2".to_string()],
        }));
        let json = serde_json::to_string(&msg).unwrap();
        let back: MaestroRpcMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(msg, back);
    }

    #[test]
    fn roundtrip_detect_installed_agents_request() {
        let msg = MaestroRpcMessage::Request(ServerRequest::DetectInstalledAgents(DetectInstalledAgentsRequest {}));
        let json = serde_json::to_string(&msg).unwrap();
        let back: MaestroRpcMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(msg, back);
    }

    #[test]
    fn roundtrip_detect_installed_agents_ok() {
        let msg = MaestroRpcMessage::Response(ServerResponse::DetectInstalledAgentsOk(DetectInstalledAgentsResponse {
            agents: vec![
                DetectedAgentInfo {
                    agent_id: "claude-acp".to_string(),
                    tool_name: "Claude Code".to_string(),
                    binary_found: true,
                    binary_path: Some("/usr/local/bin/claude".to_string()),
                    config_dir_found: true,
                },
                DetectedAgentInfo {
                    agent_id: "github-copilot-cli".to_string(),
                    tool_name: "GitHub Copilot".to_string(),
                    binary_found: false,
                    binary_path: None,
                    config_dir_found: true,
                },
            ],
            all_checked_ids: vec!["claude-acp".to_string(), "github-copilot-cli".to_string(), "codex-acp".to_string()],
        }));
        let json = serde_json::to_string(&msg).unwrap();
        let back: MaestroRpcMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(msg, back);
    }

    #[test]
    fn roundtrip_detect_project_agents_request() {
        let msg = MaestroRpcMessage::Request(ServerRequest::DetectProjectAgents(DetectProjectAgentsRequest {
            cwd: "/home/user/project".to_string(),
        }));
        let json = serde_json::to_string(&msg).unwrap();
        let back: MaestroRpcMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(msg, back);
    }

    #[test]
    fn roundtrip_ping_response() {
        let msg = MaestroRpcMessage::Response(ServerResponse::Ping { seq: 42 });
        let json = serde_json::to_string(&msg).unwrap();
        let back: MaestroRpcMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(msg, back);
    }

    #[test]
    fn roundtrip_pong_request() {
        let msg = MaestroRpcMessage::Request(ServerRequest::Pong { seq: 42 });
        let json = serde_json::to_string(&msg).unwrap();
        let back: MaestroRpcMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(msg, back);
    }

    #[test]
    fn roundtrip_diagnostic() {
        let msg = MaestroRpcMessage::Response(ServerResponse::Diagnostic(DiagnosticPayload {
            level: "error".to_string(),
            message: "[spawn] FAILED cmd=\"claude\": No such file".to_string(),
        }));
        let json = serde_json::to_string(&msg).unwrap();
        let back: MaestroRpcMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(msg, back);
    }

    #[test]
    fn roundtrip_detect_project_agents_ok() {
        let msg = MaestroRpcMessage::Response(ServerResponse::DetectProjectAgentsOk(DetectProjectAgentsResponse {
            agents: vec![
                ProjectAgentMarker {
                    agent_id: "claude-acp".to_string(),
                    markers_found: vec!["CLAUDE.md".to_string(), ".claude/".to_string()],
                },
            ],
        }));
        let json = serde_json::to_string(&msg).unwrap();
        let back: MaestroRpcMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(msg, back);
    }
}
