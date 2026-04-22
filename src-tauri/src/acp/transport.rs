//! Re-exports wire protocol types from maestro-protocol for convenience.
//! Phase 42 adds connection abstractions (SSH channel wrappers) here.

pub use maestro_protocol::{
    MaestroRpcMessage, ServerRequest, ServerResponse,
    SpawnRequest, SpawnResponse,
    PromptRequest, CancelRequest,
    SessionUpdate, PermissionRequest, PermissionResponse,
    TerminalOutput, ErrorResponse,
    ListAgentsRequest, AgentCheckEntry, ListAgentsResponse,
    write_message, read_message,
    MSG_LEN_SIZE, MAX_MESSAGE_SIZE,
};
