---
phase: 09-remote-project-support
plan: 01
subsystem: Remote SSH Infrastructure
tags: [ssh, connection-management, remote-operations, authentication, database-schema]

completed: 2026-02-08
duration: "25 minutes"

dependencies:
  requires: [Phase 8 complete with error handling infrastructure]
  provides: [SSH connection infrastructure for remote project operations]
  affects: [09-02 Remote Git Operations, 09-03 Remote Process Execution, 09-04 Remote Terminal Streaming]

tech-stack:
  added:
    - ssh2 crate 0.9.5 (Rust SSH protocol implementation)
  patterns:
    - Persistent connection management (single connection per project)
    - State machine (Initial → Connecting → Connected → Reconnecting → Disconnected)
    - Exponential backoff retry for transient failures
    - Async/await with tokio for concurrent SSH operations

file-tracking:
  key-files:
    created:
      - src-tauri/src/ssh/mod.rs (module root export, 7 lines)
      - src-tauri/src/ssh/error.rs (SshError enum, 50 lines)
      - src-tauri/src/ssh/client.rs (SshClient wrapper, 42 lines)
      - src-tauri/src/ssh/session.rs (RemoteSshSession manager, 245 lines)
    modified:
      - src-tauri/Cargo.toml (added ssh2 dependency)
      - src-tauri/src/lib.rs (added ssh module export)
      - src-tauri/src/models/project.rs (added SshConfig, SshAuthMethod, extended Project, 65 lines)
      - src-tauri/src/models/mod.rs (added SSH type exports)
      - src-tauri/src/db/schema.rs (migration v5→v6, 41 lines)
      - src-tauri/src/db/connection.rs (AppState.ssh_sessions, host key helpers, 60 lines)
      - src-tauri/src/main.rs (SSH session initialization on app startup, 50 lines)
      - src/types/bindings.ts (added SshAuthMethod, SshConfig, updated Project)

---

# Phase 9 Plan 1: SSH Connection Infrastructure Summary

**One-liner:** Established persistent SSH session management with authentication, error handling, and host key verification for remote project support.

## What Was Built

### 1. SSH Module Architecture

Created modular SSH layer with clear separation of concerns:

- **ssh/error.rs:** SshError enum distinguishing transient (ConnectionError) vs permanent (AuthenticationError, PermissionError, HostKeyError) failures. Functions `is_transient_error()` and `is_permanent_error()` for retry logic classification.

- **ssh/client.rs:** Minimal SshClient wrapper managing Session lifecycle with basic state tracking.

- **ssh/session.rs:** RemoteSshSession persistent connection manager implementing full lifecycle:
  - Connection state machine: Initial → Connecting → Connected → Reconnecting → Disconnected
  - connect() authenticates via key file or SSH agent (no password per user decision)
  - execute_command() runs remote commands and returns output/errors
  - reconnect_if_needed() implements exponential backoff (100ms × 2^attempt, max 5 retries)
  - Handles connection timeouts (10 seconds) and graceful disconnection

### 2. Project Model Extensions

**SshAuthMethod enum:**
```rust
KeyFile { path: String }  // Path to private key file
Agent                     // SSH agent authentication
```

**SshConfig struct:**
```rust
host: String              // SSH host (e.g., "example.com")
port: u16                 // SSH port (typically 22)
username: String          // SSH username
auth_method: SshAuthMethod
remote_path: String       // Remote project path (e.g., "/home/user/project")
```

**Project struct extended:**
```rust
is_remote: bool           // Flag for local vs remote
ssh_config: Option<SshConfig>  // None for local, Some for remote
```

### 3. Database Schema Migration (v5 → v6)

**Projects table additions:**
- `is_remote BOOLEAN NOT NULL DEFAULT 0` - Marks remote projects
- `ssh_config TEXT` - JSON-serialized SshConfig (lazy storage, deserialized on use)

**New table - known_hosts:**
```sql
CREATE TABLE known_hosts (
    id INTEGER PRIMARY KEY,
    project_id INTEGER,
    host_fingerprint TEXT NOT NULL,
    fingerprint_type TEXT,
    first_seen_at TEXT,
    created_at TEXT
);
```

Stores accepted SSH host keys to prevent MITM attacks. Helper function `check_and_store_host_key()` persists fingerprints on first connection.

### 4. AppState Integration

**Extended AppState with:**
```rust
pub ssh_sessions: Arc<Mutex<HashMap<i64, RemoteSshSession>>>
```

**Helper methods:**
- `get_ssh_session(project_id) -> Option<RemoteSshSession>` - Retrieve stored session
- `set_ssh_session(project_id, session)` - Store session
- `remove_ssh_session(project_id)` - Clean up session

### 5. App Startup Initialization

On Tauri app launch, the setup() function now:
1. Queries database for all remote projects (`is_remote = 1`)
2. Deserializes ssh_config JSON for each remote project
3. Creates RemoteSshSession instances from config
4. Stores in AppState.ssh_sessions (HashMap by project_id)
5. **Does NOT connect** - lazy connection on first operation (per user decision)

This ensures SSH sessions are recreated from persisted database configuration on app restart, maintaining clean state separation.

### 6. Authentication Methods

**Key File Authentication:**
- Supports path to private key file (e.g., ~/.ssh/id_rsa)
- Passphrase delegated to SSH agent (app never handles passphrases)

**SSH Agent Authentication:**
- Connects to system SSH agent
- Agent manages key selection and passphrase prompts
- More flexible for multi-key setups

**No password authentication** per user security decision.

### 7. Error Handling

Clear distinction between error types enables appropriate recovery:
- **ConnectionError** (transient): Network timeout, connection reset → trigger exponential backoff retry
- **AuthenticationError** (permanent): Invalid credentials → user must fix config
- **PermissionError** (permanent): File access denied → user must verify permissions
- **CommandExecutionError** (command-specific): Non-zero exit code with stderr
- **HostKeyError** (permanent): Unknown host key → user must verify and accept

## Implementation Decisions

1. **Single persistent connection per project** (not connection pooling) - simpler state management, one connection lifecycle per project
2. **Lazy connection initialization** - SSH sessions created on app startup from DB, but connection deferred to first operation
3. **Exponential backoff retry** - 100ms × 2^attempt up to 5 retries handles transient network issues gracefully
4. **Host key verification on first connect** - database stores accepted keys to prevent MITM attacks
5. **No password authentication** - key file + agent only per user security requirements
6. **SSH multiplexing via OS config** - users can enable ControlMaster in ~/.ssh/config for connection overhead reduction

## Output Verification

All success criteria met:
- ✓ ssh2 crate 0.9+ added to Cargo.toml
- ✓ SSH module structure created with 4 files (mod, client, session, error)
- ✓ SshError enum distinguishes transient vs permanent errors
- ✓ Project model extended with is_remote and ssh_config fields
- ✓ SshConfig struct with host, port, username, auth_method, remote_path
- ✓ SshAuthMethod enum: KeyFile(path) | Agent (no password)
- ✓ RemoteSshSession manages persistent SSH connection with state machine
- ✓ connect() authenticates via key file or SSH agent
- ✓ execute_command() runs commands over SSH
- ✓ Exponential backoff retry for transient errors (100ms × 2^attempt, max 5)
- ✓ Host key verification on first connect with known_hosts table
- ✓ AppState stores per-project SSH sessions in HashMap
- ✓ App startup loads remote projects and initializes sessions (lazy connection)
- ✓ SSH sessions re-initialized from database config on app restart
- ✓ Database schema migrated to v6 with is_remote, ssh_config, known_hosts
- ✓ Cargo build succeeds with no errors
- ✓ TypeScript bindings generated for all new types

## Deviations from Plan

None - plan executed exactly as specified.

## Next Steps

**Plan 09-02: Remote Git Operations**
- Implement git operations (clone, fetch, push) routing through RemoteSshSession
- Remote worktree management using ssh2 channels
- Error handling integration for git-specific failures

**Plan 09-03: Remote Process Execution**
- Route spawn_agent_cli through SSH for remote command execution
- Terminal PTY streaming over SSH channels
- Process lifecycle management on remote host

**Plan 09-04: Remote Terminal Streaming**
- Direct PTY over SSH (spawn PTY on remote, stream through SSH connection)
- Real-time terminal I/O handling through RemoteSshSession
- Terminal resize and signal handling (Ctrl+C) over SSH

## Notes

- SSH multiplexing (ControlMaster) is handled transparently at the OS level through user's ~/.ssh/config - no direct crate support needed
- Host key fingerprints stored in database survive app restarts, enabling offline operation after initial acceptance
- Connection failures are categorized to provide clear user feedback: "Authentication failed" vs "Network timeout"
- All IPC handlers updated to include is_remote and ssh_config fields when querying projects from database

---

**Files Modified:** 8 files
**Lines Added:** ~550 lines (models, SSH module, database)
**Build Status:** ✓ Passes (0 errors, warnings only for unused code in other modules)
**Type Safety:** ✓ Full Rust + TypeScript alignment
**Testing Ready:** ✓ Foundation complete for integration testing in later phases
