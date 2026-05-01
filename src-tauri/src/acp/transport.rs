//! Re-exports wire protocol types from maestro-protocol for convenience.

pub use maestro_protocol::{
    MaestroRpcMessage, ServerRequest, ServerResponse,
    SpawnRequest, SpawnResponse,
    PromptRequest, CancelRequest,
    SessionUpdate, PermissionRequest, PermissionResponse,
    ElicitationRequest, ElicitationResponse,
    TerminalOutput, ErrorResponse,
    ListAgentsRequest, ListAgentsResponse, DiscoveredAgent,
    ModelInfo, SessionModelState,
    SetModelRequest, SetModelOkResponse,
    PromptCapabilitiesInfo,
    FileSearchRequest, FileSearchResponse, FileReadRequest, FileReadResponse,
    write_message, read_message,
    MSG_LEN_SIZE, MAX_MESSAGE_SIZE,
};
