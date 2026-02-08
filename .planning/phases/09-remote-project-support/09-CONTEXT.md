# Phase 9: Remote Project Support - Context

**Gathered:** 2026-02-08
**Status:** Ready for planning

<domain>
## Phase Boundary

Enable working with remote projects via SSH where all operations (git, agent execution, terminal streaming, file diffs) execute on a remote machine. Users can manage remote projects through the same Kanban interface as local projects, with the orchestrator handling SSH connection management and routing operations to the remote host.

</domain>

<decisions>
## Implementation Decisions

### Connection Management
- Single persistent SSH connection per remote project (not connection pooling)
- Support three authentication methods: password, SSH key file, and SSH agent forwarding
- Hybrid reconnection strategy: auto-retry for transient network failures, but stop and notify user for authentication or permission errors
- Per-project SSH configuration only (no global defaults)
- Optional connection validation: "Test Connection" button available but not required before saving
- Connection status communicated via status indicator only (no detailed logs or toast notifications)
- Enable SSH multiplexing (ControlMaster) to reduce connection overhead
- Short timeout values: 10s for connection, 30s for idle
- Host key verification: prompt user on first connect to accept/reject (similar to standard SSH client)
- Support custom SSH port configuration (but not full SSH config options)

### Remote Detection & UI
- Visual distinction: badge/icon on remote projects + connection status indicator (connected/disconnected)
- Project creation flow: prompt "local" or "remote" during project add (default: local), show SSH connection form if remote selected
- Test connection during project setup before saving configuration
- Hybrid error surfacing: toast notification for initial connection errors, persistent status indicator while disconnected, with click-to-retry action
- No offline support: require active SSH connection for all remote project operations

### Remote Operations Routing
- Architecture: local Node.js sidecar with remote execution via SSH
- Remote operations: all git operations, Claude Code CLI execution, file diff generation execute on remote machine
- Local operations: SQLite database stays local, stores remote project metadata and task state
- Path handling: store remote paths only (e.g., /home/user/project), no local/remote path translation
- Terminal streaming: direct PTY over SSH (spawn PTY on remote, stream through SSH connection)
- Code structure: remote-aware git module (pass connection info, module decides local vs SSH execution)
- Error handling: unified error type with metadata to distinguish connection failures from command execution errors
- Output handling: stream large outputs (terminal logs, diffs) over SSH in real-time
- Environment validation: lazy per-operation (check for required tools like git/node/claude when first needed, not upfront)

### Security & Credentials
- Password authentication: not supported (no password storage)
- SSH key authentication: supported, with path to private key file
- Key passphrases: delegate to SSH agent for passphrase management (app never handles passphrases)
- Key permissions: no validation of SSH key file permissions (trust user to manage)
- Agent forwarding: disabled entirely (users must set up git credentials on remote machine separately)

### Claude's Discretion
- Rust libssh2 implementation details for SSH connections
- Exact SSH multiplexing configuration
- Connection state machine and lifecycle management
- Error message formatting and user feedback wording
- Remote command execution retry logic for transient failures

</decisions>

<specifics>
## Specific Ideas

No specific requirements — open to standard SSH remote execution approaches.

</specifics>

<deferred>
## Deferred Ideas

- SSH tunneling for additional services (database ports, web servers) — noted for future phase
- Full SSH config support (proxy command, compression options, etc.) — Phase 9 only supports custom port

</deferred>

---

*Phase: 09-remote-project-support*
*Context gathered: 2026-02-08*
