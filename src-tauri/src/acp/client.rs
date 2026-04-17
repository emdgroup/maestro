use agent_client_protocol::{self as acp, Client};

/// Maestro's ACP client implementation.
/// Handles agent callbacks: filesystem, terminal, permissions.
/// Phase 42 wires these to Tauri IPC events and AppState.
pub struct MaestroAcpClient;

#[async_trait::async_trait(?Send)]
impl Client for MaestroAcpClient {
    async fn request_permission(
        &self,
        _args: acp::RequestPermissionRequest,
    ) -> acp::Result<acp::RequestPermissionResponse> {
        // Phase 42: forward to frontend permission dialog via Tauri event
        Err(acp::Error::method_not_found())
    }

    async fn session_notification(
        &self,
        _args: acp::SessionNotification,
    ) -> acp::Result<()> {
        // Phase 42: emit Tauri event with structured session update
        Ok(())
    }

    // All other Client methods (read_text_file, write_text_file, create_terminal,
    // list_directory, etc.) inherit the default impl which returns
    // Err(Error::method_not_found()). Phase 42 overrides as needed.
}
