//! Maestro Remote Server
//!
//! Headless binary that runs on remote SSH hosts. Receives MaestroRpcMessage
//! commands from the local Maestro desktop app over stdin/stdout (piped through
//! SSH exec channel), spawns ACP agents as local subprocesses, and forwards
//! structured session updates back.
//!
//! Architecture: Adapted from Zed's remote_server (GPL-3.0).
//! Phase 42 activates agent spawning and ACP wiring.

use maestro_protocol::MaestroRpcMessage;

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let local = tokio::task::LocalSet::new();
    local.run_until(async {
        // Phase 42 will:
        // 1. Read MaestroRpcMessage from stdin (length-prefixed via maestro_protocol::read_message)
        // 2. Dispatch ServerRequest::Spawn to create ACP agent via ClientSideConnection
        // 3. Forward ServerRequest::Prompt to active session
        // 4. Handle ServerRequest::Cancel by dropping the session
        // 5. Forward ServerResponse (SessionUpdate, PermissionRequest, TerminalOutput)
        //    back to stdout for the local Maestro to receive

        // Verify the type is importable (compile-time check)
        let _: Option<MaestroRpcMessage> = None;

        Ok::<(), Box<dyn std::error::Error>>(())
    }).await
}
