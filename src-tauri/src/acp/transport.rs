//! Re-exports wire protocol types from maestro-protocol for convenience.

pub use maestro_protocol::{
    read_message, write_message, CancelRequest, CheckToolsRequest, CheckToolsResponse,
    ConfigOptionUpdatedResponse, DiscoveredAgent, ElicitationRequest, ElicitationResponse,
    ErrorResponse, FileReadRequest, FileReadResponse, FileSearchRequest, FileSearchResponse,
    HandshakeRequest, HandshakeResponse, HostToolCall, HostToolResult, InterruptTurnRequest,
    ListAgentsRequest, ListAgentsResponse, ModeInfo, ModelInfo, PermissionRequest,
    PermissionResponse, PreInitializeRequest, PreInitializeResponse, PromptCapabilitiesInfo,
    PromptRequest, ServerRequest, ServerResponse, SessionCloseRequest, SessionDeleteRequest,
    SessionListEntry, SessionListOkResponse, SessionListRequest, SessionLoadOkResponse,
    SessionLoadRequest, SessionModeState, SessionModelState, SessionUpdate, SetConfigOptionRequest,
    SetModeOkResponse, SetModeRequest, SetModelRequest, SpawnRequest, SpawnResponse,
    TerminalOutput, ToolCheckResult, TurnEnded, MAX_MESSAGE_SIZE, MSG_LEN_SIZE, PROTOCOL_VERSION,
};
