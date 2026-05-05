//! Re-exports wire protocol types from maestro-protocol for convenience.

pub use maestro_protocol::{
    MaestroRpcMessage, ServerRequest, ServerResponse,
    HandshakeRequest, HandshakeResponse, PROTOCOL_VERSION,
    SpawnRequest, SpawnResponse,
    PromptRequest, CancelRequest, InterruptTurnRequest,
    SessionUpdate, PermissionRequest, PermissionResponse,
    ElicitationRequest, ElicitationResponse,
    TerminalOutput, ErrorResponse,
    ListAgentsRequest, ListAgentsResponse, DiscoveredAgent,
    ModelInfo, SessionModelState,
    SetModelRequest, SetModelOkResponse,
    PromptCapabilitiesInfo,
    FileSearchRequest, FileSearchResponse, FileReadRequest, FileReadResponse,
    TurnEnded,
    SessionListRequest, SessionListOkResponse, SessionListEntry,
    SessionLoadRequest, SessionLoadOkResponse,
    SessionCloseRequest,
    write_message, read_message,
    MSG_LEN_SIZE, MAX_MESSAGE_SIZE,
};
