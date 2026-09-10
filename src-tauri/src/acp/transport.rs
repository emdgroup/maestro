//! Re-exports wire protocol types from maestro-protocol for convenience.

pub use maestro_protocol::{
    read_message, write_message, AgentConnectionLost, CancelRequest, CheckToolsRequest,
    CheckToolsResponse, ConfigOptionUpdatedResponse, DiscoveredAgent, ElicitationRequest,
    ElicitationResponse, ErrorResponse, FileReadRequest, FileReadResponse, FileSearchRequest,
    FileSearchResponse, HandshakeRequest, HandshakeResponse, InterruptTurnRequest,
    ListAgentsRequest, ListAgentsResponse, MaestroRpcMessage, ModeInfo, ModelInfo,
    PermissionRequest, PermissionResponse, PreInitializeRequest, PreInitializeResponse,
    PromptCapabilitiesInfo, PromptRequest, ServerRequest, ServerResponse, SessionCloseRequest,
    SessionDeleteRequest, SessionListEntry, SessionListOkResponse, SessionListRequest,
    SessionLoadOkResponse, SessionLoadRequest, SessionModeState, SessionModelState, SessionUpdate,
    SetConfigOptionOkResponse, SetConfigOptionRequest, SetModeOkResponse, SetModeRequest,
    SetModelOkResponse, SetModelRequest, SpawnRequest, SpawnResponse, TerminalOutput,
    ToolCheckResult, TurnEnded, MAX_MESSAGE_SIZE, MSG_LEN_SIZE, PROTOCOL_VERSION,
};
