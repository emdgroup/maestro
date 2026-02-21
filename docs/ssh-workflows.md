# SSH Workflows Documentation

## Overview

The GSD Agent Orchestrator supports remote project execution via SSH with multiple authentication methods and intelligent session management. This document describes the different SSH scenarios and workflows implemented in the system.

---

## SSH Scenarios

### 1. SSH Agent Authentication

**Use Case**: Developer has SSH agent running with loaded keys (most secure, passwordless)

**Flow**:
1. User creates remote connection, selects "SSH Agent" auth method
2. System attempts connection via `connect_ssh_without_credentials`
3. SSH client delegates authentication to local SSH agent
4. On success, session stored in `AppState` for reuse
5. No credentials stored anywhere

**Configuration**:
```typescript
auth_method: "Agent"
```

**Database Storage**: Only connection metadata (host, username, port) persisted with `auth_method: "Agent"`

**Security**: Most secure - no credentials stored, relies on OS-level SSH agent

---

### 2. Private Key File Authentication

**Use Case**: Developer prefers specific key file (e.g., per-project keys)

**Flow**:
1. User creates remote connection, selects "Private Key File" auth method
2. User specifies path to private key (e.g., `~/.ssh/id_rsa_work`)
3. System attempts connection via `connect_ssh_without_credentials`
4. SSH client uses specified key file for authentication
5. On success, session stored in `AppState` for reuse
6. Only key file path persisted (not key contents)

**Configuration**:
```typescript
auth_method: {
  KeyFile: { path: "/home/user/.ssh/id_rsa" }
}
```

**Database Storage**: Connection metadata + key file path (not key contents)

**Security**: Secure - key file path stored, actual key managed by OS file permissions

---

### 3. Password Authentication with OS Keyring Persistence

**Use Case**: Developer on system without SSH agent, wants convenience

**Flow**:
1. User creates remote connection, selects "Password" auth method
2. System attempts `connect_ssh_without_credentials` (fails - no saved password yet)
3. Frontend displays `PasswordModal` with "Save password securely" checkbox
4. User enters password and checks "Save password"
5. Frontend calls `connect_ssh_with_password(password, save_password: true)`
6. Backend saves password to OS keyring via `PasswordManager::store_password`
7. Session established with `SshAuthMethod::Password { save_password: true }`
8. Database updated with `auth_method: "Password"`
9. On app restart, `connect_ssh_without_credentials` retrieves password from keyring automatically

**Configuration**:
```typescript
// In-memory during session
auth_method: {
  Password: { save_password: true }
}
```

**Database Storage**: Connection metadata + `auth_method: "Password"` (actual password in OS keyring)

**Security**: Password stored in OS-managed keyring (Keychain on macOS, Secret Service on Linux, Credential Manager on Windows)

**Keyring Service Name Format**: `gsd-demo.ssh.{host}`

---

### 4. Password Authentication with In-Memory Storage (No Persistence)

**Use Case**: Developer on shared/temporary machine, wants security over convenience

**Flow**:
1. User creates remote connection, selects "Password" auth method
2. System attempts `connect_ssh_without_credentials` (fails - no saved password)
3. Frontend displays `PasswordModal` with unchecked "Save password" checkbox
4. User enters password WITHOUT checking "Save password"
5. Frontend calls `connect_ssh_with_password(password, save_password: false)`
6. Backend creates session with `SshAuthMethod::PasswordInMemory { password: "..." }`
7. Password exists ONLY in memory for current app session
8. Database updated with `auth_method: "Agent"` (resets to Agent for next restart)
9. On app restart, system prompts for password again (password NOT persisted)

**Configuration**:
```typescript
// In-memory during session only
auth_method: {
  PasswordInMemory: { password: "actual_password" }
}

// Database persists as Agent for next restart
database.auth_method: "Agent"
```

**Database Storage**: Connection metadata with `auth_method: "Agent"` (password never touches disk)

**Security**: Maximum security - password never persisted, session lost on app restart

**Key Implementation Detail** (from `ssh_handlers.rs:244-257`):
```rust
// Password NOT saved - reset auth_method to Agent for next restart
let auth_method_json = serde_json::to_string(&SshAuthMethod::Agent)
    .map_err(|e| format!("Failed to serialize auth method: {}", e))?;

conn.execute(
    "UPDATE ssh_connections SET auth_method = ?, last_used_at = ?, updated_at = ? WHERE id = ?",
    rusqlite::params![&auth_method_json, &now, &now, connection_id],
)
```

---

### 5. SSH Session Reuse (All Auth Methods)

**Use Case**: Multiple operations on same remote connection within single app session

**Flow**:
1. User connects to remote project (any auth method)
2. Session stored in `AppState.ssh_sessions` HashMap (key: connection_id)
3. Subsequent operations check `AppState.get_ssh_session(connection_id)` first
4. If session exists and connected, reuse without re-authentication
5. If session disconnected, automatic reconnection with exponential backoff
6. Session persists until app restart or explicit disconnect

**Implementation** (from `ssh_handlers.rs:96-112`):
```rust
// Check if session already exists
if let Some(_existing_session) = app_state.get_ssh_session(connection_id).await {
    println!("Reusing existing session for connection_id={}", connection_id);
    return Ok(connection_id);
}
```

**Benefits**:
- No redundant password prompts during single app session
- Reduced connection overhead for repeated operations
- Transparent to user - "just works"

**State Management**: Session lives in `Arc<tokio::sync::Mutex<HashMap<i64, RemoteSshSession>>>`

---

## Authentication Method Lifecycle

### Initial Connection Creation

```
User fills form → Test connection → Create project/connection → Store in database
```

**Database fields**:
- `connection_string`: "user@host:port"
- `username`: SSH username
- `host`: SSH hostname
- `port`: SSH port (default 22)
- `auth_method`: JSON-serialized `SshAuthMethod` enum
- `display_name`: User-friendly name (optional)

### Connection Reuse on App Restart

**Agent/KeyFile**:
```
App starts → Load connection → connect_ssh_without_credentials → Success
```

**Password (saved to keyring)**:
```
App starts → Load connection → connect_ssh_without_credentials
         → Retrieve from keyring → Success
```

**Password (NOT saved)**:
```
App starts → Load connection → connect_ssh_without_credentials → Fail
         → Show PasswordModal → User enters password → Success
```

---

## Connection State Machine

The `RemoteSshSession` implements a state machine for connection lifecycle:

```
Initial → Connecting → Connected
   ↓                      ↓
Reconnecting ←──────── (error)
   ↓
Disconnected
```

**States**:
- `Initial`: Session created, not yet connected
- `Connecting`: TCP handshake and authentication in progress
- `Connected`: Authenticated and ready for commands
- `Reconnecting`: Connection lost, attempting automatic recovery (exponential backoff)
- `Disconnected`: Explicitly disconnected or max retries exceeded

**Reconnection Logic** (from `session.rs:216-262`):
- Max 5 reconnection attempts
- Exponential backoff: 100ms * 2^attempt
- Delays: 100ms, 200ms, 400ms, 800ms, 1600ms

---

## Security Considerations

### Password Storage Security

1. **OS Keyring Integration**:
   - Uses `keyring` crate for cross-platform secure storage
   - macOS: Keychain
   - Linux: Secret Service API (GNOME Keyring / KWallet)
   - Windows: Credential Manager

2. **Zeroizing Sensitive Data**:
   - Passwords wrapped in `Zeroizing<String>` to clear memory on drop
   - Prevents passwords from lingering in memory after use

3. **In-Memory vs Persistent**:
   - `PasswordInMemory` variant keeps password in `RemoteSshSession` only
   - Never written to database, files, or OS keyring
   - Lost on app restart by design

### Authentication Flow Security

- Password never logged (all logging uses `***` for sensitive data)
- SSH handshake uses standard `ssh2` library (libssh2)
- TCP timeouts prevent hanging connections (10 second timeout)
- Failed auth attempts do not retry automatically (requires user action)

---

## Error Handling

### SSH Error Types (from `ssh/error.rs`)

```rust
pub enum SshError {
    ConnectionError(String),        // Transient - can retry
    AuthenticationError(String),    // Permanent - needs user action
    PermissionError(String),        // Permanent
    CommandExecutionError { exit_code: i32, stderr: String },
    HostKeyError(String),           // Permanent
    UnknownError(String),
}
```

### Frontend Error Display

- `AuthenticationError` → Show PasswordModal (credential issue)
- `ConnectionError` → Toast notification (network issue)
- `PermissionError` → Toast notification (remote file access issue)

---

## Database Schema

### `ssh_connections` Table

```sql
CREATE TABLE ssh_connections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    connection_string TEXT NOT NULL UNIQUE,  -- "user@host:port"
    username TEXT NOT NULL,
    host TEXT NOT NULL,
    port INTEGER NOT NULL DEFAULT 22,
    auth_method TEXT NOT NULL,               -- JSON SshAuthMethod
    display_name TEXT,
    last_used_at TEXT NOT NULL,              -- ISO 8601
    created_at TEXT NOT NULL,                -- ISO 8601
    updated_at TEXT NOT NULL                 -- ISO 8601
);
```

**Example Records**:

```json
// SSH Agent
{
  "auth_method": "\"Agent\""
}

// Key File
{
  "auth_method": "{\"KeyFile\":{\"path\":\"/home/user/.ssh/id_rsa\"}}"
}

// Saved Password
{
  "auth_method": "{\"Password\":{\"save_password\":true}}"
}

// Unsaved Password (stored as Agent after auth)
{
  "auth_method": "\"Agent\""
}
```

---

## Component Interaction Map

### Frontend Components
- `RemoteConnectionForm` - Initial SSH connection configuration
- `PasswordModal` - Password prompt with save option
- `RemoteProjectsList` - Lists connections, triggers auth
- `ConnectionList` - Manages saved SSH connections

### Backend Modules
- `ssh/session.rs` - SSH connection lifecycle and state machine
- `ssh/password_manager.rs` - OS keyring integration
- `ssh/client.rs` - Low-level SSH wrapper (minimal, mostly session storage)
- `ssh/error.rs` - SSH-specific error types
- `ipc/ssh_handlers.rs` - Tauri IPC handlers for SSH operations
- `models/connection.rs` - GitConnection enum (Local vs Remote)
- `models/project.rs` - SshConfig and SshAuthMethod types

---

## Best Practices for Developers

### Adding New SSH Operations

1. Implement command execution in `RemoteSshSession::execute_command`
2. Handle connection errors gracefully (session may need reconnect)
3. Add IPC handler in `ssh_handlers.rs`
4. Expose via Tauri command to frontend

### Testing SSH Functionality

- Use `test_remote_connection` IPC command before creating projects
- Test all 4 auth methods (Agent, KeyFile, Password saved, Password unsaved)
- Verify session reuse (multiple operations without re-auth)
- Test reconnection after network disruption

### Security Checklist

- [ ] Never log passwords or sensitive credentials
- [ ] Always use `Zeroizing<String>` for in-memory passwords
- [ ] Verify auth_method correctly persisted based on save_password flag
- [ ] Test keyring deletion on connection removal
- [ ] Ensure in-memory passwords don't leak to database

---

## Common Issues and Solutions

### Issue: Password prompt on every operation
**Cause**: Session not being reused
**Solution**: Check `AppState.ssh_sessions` contains active session, verify connection_id mapping

### Issue: Password persists after selecting "Don't save"
**Cause**: auth_method not reset to Agent in database
**Solution**: Verify `connect_ssh_with_password` resets auth_method when `save_password: false`

### Issue: Connection hangs indefinitely
**Cause**: No TCP timeout configured
**Solution**: Verify `set_read_timeout(10s)` and `set_write_timeout(10s)` in session.rs

### Issue: Keyring access denied
**Cause**: OS keyring not available or locked
**Solution**: Fall back to in-memory auth, prompt user to unlock keyring

---

## Future Enhancements

1. **Multi-hop SSH** - SSH through bastion/jump hosts
2. **SSH key generation** - Generate and manage keys from UI
3. **Connection health monitoring** - Periodic keepalive pings
4. **Session encryption** - Encrypt in-memory sessions (defense in depth)
5. **Audit logging** - Log all SSH operations for security compliance

---

## References

- `src-tauri/src/ssh/session.rs` - Core SSH session management
- `src-tauri/src/ssh/password_manager.rs` - OS keyring integration
- `src-tauri/src/ipc/ssh_handlers.rs` - IPC command handlers
- `src-tauri/src/models/project.rs` - SSH configuration types
- `src/components/PasswordModal.tsx` - Password input UI
- `src/components/RemoteConnectionForm.tsx` - Connection configuration UI
