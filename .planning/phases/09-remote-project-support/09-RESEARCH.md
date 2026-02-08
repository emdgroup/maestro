# Phase 09: Remote Project Support - Research

**Researched:** 2026-02-08
**Domain:** SSH-based remote project execution with real-time terminal streaming and git operations
**Confidence:** HIGH

## Summary

Phase 09 enables users to configure remote SSH connections for projects, routing all operations (git, agent execution, terminal streaming, file diffs) over SSH to a remote machine. The architecture maintains local SQLite state while executing everything remote. Key decisions are locked: single persistent SSH connection per project (not pooling), three auth methods (key file, SSH agent, password—though password excluded), host key verification on first connect, and short timeout values (10s connection, 30s idle).

The standard approach uses **ssh2 (Node.js)** for SSH client operations combined with the existing **portable-pty** (Rust) for local PTY handling. Remote commands execute via ssh2.exec() or ssh2.shell() depending on interactivity needs. Output streams through WebSocket to frontend, which renders in existing xterm.js terminal.

**Primary recommendation:** Use ssh2 v1.17.0 for Rust backend SSH operations, with single persistent connection per project lifecycle. Delegate passphrase management to SSH agent. Implement lazy environment validation (check for git/node/claude when first needed, not upfront).

## Standard Stack

### Core SSH Libraries

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| **ssh2** (Rust crate) | 0.9+ | SSH client protocol (libssh2 wrapper) | Mature, well-tested binding to libssh2. Supports all auth methods, PTY, SFTP. Rust backend can maintain persistent connections directly. Alternative: russh (pure Rust, async/await) but libssh2 binding more battle-tested. |
| **ssh2** (Node.js) | 1.17.0 | SSH client from Node.js sidecar | Alternative to Rust binding if operations routed through Node sidecar. Pure JS implementation, event-driven. Current version (Feb 2025) is 1.17.0 with minimal dependencies (asn1, bcrypt-pbkdf). |
| **portable-pty** | 0.8+ | Local PTY allocation (Rust) | Already in Cargo.toml. Cross-platform (Unix, Windows ConPTY). Used for local terminal sessions. Remote PTY allocated via ssh2 on remote machine. |
| **node-pty** | 0.11+ | PTY allocation in Node.js | Only if sidecar spawns local PTY processes. For remote operations, use ssh2.shell() instead. NOT needed for phase 9 if all execution remote. |

### Authentication & Credentials

| Component | Version | Purpose | When to Use |
|-----------|---------|---------|------------|
| **SSH Agent** | System-native | Passphrase management (OpenSSH, Pageant, Cygwin) | Recommended for key file auth (CONTEXT.md decision). App never handles passphrases—delegates to agent. |
| **Private Key File** | N/A | File-based auth with key path | Supported per CONTEXT.md. User provides path, no in-memory passphrase storage. |
| **Password Auth** | N/A | Direct password authentication | **NOT SUPPORTED** per CONTEXT.md (no password storage). |

### Connection Management

| Pattern | Implementation | Trade-off |
|---------|----------------|-----------|
| **Single persistent connection per project** | One TCP connection, reused for all commands/shells | **Standard choice** per CONTEXT.md. Lower overhead, simpler lifecycle. One connection failure = all operations blocked (acceptable: user retries). |
| **Connection pooling** | Multiple connections in queue | Rejected per CONTEXT.md. More complex, higher resource usage. |
| **SSH Multiplexing (ControlMaster)** | OS-level connection sharing via control sockets | Optional optimization. If implemented: use libssh2's connection reuse or rely on OS ssh multiplexing. |

### Error Handling Layer

| Error Type | Detection | Handling |
|-----------|-----------|----------|
| **Connection failures** (auth, network, host key) | Connect attempt failure, 'close' event | Hybrid retry: auto-retry transient (network timeout), stop+notify for auth/permissions |
| **Command execution errors** | Non-zero exit codes, remote tool not found | Unified error type with metadata distinguishing connection vs execution failures |
| **Stream errors** (connection closed mid-stream) | 'error' event on channel | Reconnect with exponential backoff; notify user if retries exhausted |

### Deprecated/Outdated

- **node-ssh**: Pure wrapper around ssh2, higher-level API but same underlying libssh2. Not needed if using ssh2 directly.
- **russh** (for this use case): Pure Rust SSH implementation. Modern (async/await) but less battle-tested than libssh2 binding. Could be future option but ssh2 crate more stable.

## Architecture Patterns

### Recommended Project Structure

```
src-tauri/src/
├── db/
│   ├── connection.rs      # AppState with SSH connections
│   └── schema.rs          # Projects table extended for remote config
├── models/
│   ├── project.rs         # Project extended: is_remote, host, port, auth_method, remote_path
│   ├── ssh_config.rs      # SshConfig struct: host, port, username, auth details
│   └── connection.rs      # RemoteConnection enum: Local | Remote(persistent SSH connection)
├── ssh/                   # NEW module
│   ├── mod.rs
│   ├── client.rs          # SSH client wrapper around ssh2 crate
│   ├── auth.rs            # Authentication methods
│   ├── session.rs         # Persistent session lifecycle
│   └── error.rs           # SSH-specific errors
├── git/
│   ├── mod.rs
│   ├── local.rs           # Local git operations (existing)
│   └── remote.rs          # Git over SSH (NEW)
├── process/
│   ├── mod.rs
│   ├── local.rs           # Local process execution (existing)
│   └── remote.rs          # Remote execution via SSH (NEW)
└── ipc/
    ├── handlers.rs        # Tauri commands
    └── remote.rs          # Remote operation handlers (NEW)
```

### Pattern 1: Remote-Aware Git Module

**What:** Git operations dispatch to local OR remote based on project type.

**When to use:** All git operations (create worktree, branch, status, diff).

**Code structure:**
```rust
// models/connection.rs
pub enum GitConnection {
    Local { path: String },
    Remote {
        ssh: Arc<RemoteSshClient>,
        remote_path: String,
    },
}

// git/mod.rs (dispatcher)
pub async fn create_worktree(
    conn: &GitConnection,
    branch: &str,
    worktree_name: &str
) -> Result<(), AppError> {
    match conn {
        GitConnection::Local { path } => {
            // Existing: spawn local `git worktree add` via portable-pty
        },
        GitConnection::Remote { ssh, remote_path } => {
            // NEW: ssh.exec(&format!("git -C {} worktree add {} {}", remote_path, worktree_name, branch))
        },
    }
}
```

**Why:** Single call site, no UI logic changes needed. Operations route transparently.

### Pattern 2: Persistent SSH Connection Lifecycle

**What:** One SSH connection per project, maintained for project lifetime, reconnect on failure.

**When to use:** Project startup, operation execution, project close.

**State machine:**
```
Initial
  → Connecting (10s timeout)
    → Connected (authenticated)
      → [Execute operations] ←→ [Handle connection loss]
        → Reconnecting (auto-retry transient errors)
          → Connected (resume operations)
      → Disconnected (user closed project or max retries)
```

**Implementation:**
```rust
// ssh/session.rs
pub struct RemoteSshSession {
    client: Arc<Mutex<Option<ssh2::Session>>>,
    config: SshConfig,
    reconnect_attempts: Arc<AtomicUsize>,
    state: Arc<Mutex<SshConnectionState>>,
}

impl RemoteSshSession {
    pub async fn connect(&self) -> Result<(), AppError> {
        // Establish connection, handle auth, verify host key
        // Store in self.client
    }

    pub async fn execute_command(&self, cmd: &str) -> Result<String, AppError> {
        // Get or reconnect if needed
        // Execute command, handle errors
        // Return output
    }
}
```

### Pattern 3: Remote PTY + Terminal Streaming

**What:** Spawn PTY on remote machine, stream through SSH channel to WebSocket, render in xterm.js.

**When to use:** Agent execution (REM-04), terminal attachment scenarios.

**Flow:**
```
1. User starts agent task
2. Rust backend creates remote PTY:
   ssh.shell(pty_request) → channel
3. Node sidecar (or Rust if direct) spawns Claude Code CLI on remote
4. Remote CLI output → SSH channel stream
5. SSH channel data → WebSocket frame
6. Frontend receives WebSocket data → xterm.js render
```

**Code pattern:**
```rust
// process/remote.rs
pub async fn spawn_remote_agent(
    ssh: &RemoteSshSession,
    task: &Task,
) -> Result<RemoteProcessOutput, AppError> {
    // 1. Allocate PTY on remote
    let (channel, _) = ssh.shell(pty_request)?;

    // 2. Send claude code CLI command
    channel.write_all(b"cd /path && claude-code ...\n")?;

    // 3. Stream output back via WebSocket
    let output_stream = channel.read_to_end()?;
    // Output stream sent to frontend via WebSocket
}
```

### Pattern 4: Lazy Environment Validation

**What:** Check for required tools (git, node, claude) on first use, not upfront.

**When to use:** Avoid connection verification step; fail fast on actual tool absence.

**Implementation:**
```rust
pub async fn validate_remote_env(ssh: &RemoteSshSession) -> Result<RemoteEnv, AppError> {
    let mut env = RemoteEnv::default();

    // Check git only when first git operation attempted
    if env.has_git.is_none() {
        env.has_git = ssh.execute_command("git --version").is_ok();
    }

    // Similar for node, claude
    env
}
```

**Why:** Reduces connection latency. Tests connection implicitly when operations run.

## Don't Hand-Roll

Problems that look simple but have existing solutions:

| Problem | Don't Build | Use Instead | Why |
|---------|------------|-------------|-----|
| **SSH protocol handling** | Custom SSH protocol parser | ssh2 crate (Rust) or ssh2 package (Node.js) | SSH protocol is complex (RFC 4251-4254). Cryptography, key exchange, authentication. Misimplementation = security holes. libssh2 (underlying ssh2 crate) tested for 15+ years. |
| **Host key verification** | Store fingerprints in app config | Prompt user first time (standard SSH behavior) | Users expect SSH client semantics. Storing keys requires key storage/migration logic. Standard approach: `Are you sure?` prompt, store in `known_hosts`-like structure. Lower friction than pre-configuration. |
| **Connection pooling** | Build connection queue with retries | Single persistent connection (per CONTEXT.md) | Connection pooling requires tracking idle/active connections, timeout management, health checks. For single-project use case: one persistent connection simpler, lower overhead. |
| **PTY allocation over SSH** | Spawn process locally, tunnel stdout | Use ssh2.shell() with pty request | ssh2 handles PTY allocation semantics (terminal modes, resize events, signal handling). Local spawning + tunneling adds latency and complexity. |
| **Real-time output streaming** | Buffer entire output in memory, send periodically | Event-driven streaming via 'data' events on SSH channels | Large outputs (agent execution logs can be MB+) cause memory exhaustion if buffered. Stream events push data immediately, handle backpressure natively. |
| **File diff generation on remote** | SCP files locally, diff locally | Execute `git diff` on remote, stream output | Reduces network transfer. Git diff command on remote more efficient. No local temp file management needed. |
| **Error type for remote operations** | Generic Result<T, String> | Unified error enum with metadata (Connection vs Execution) | Distinguishing connection errors from command errors crucial for retry logic. Generic string loses critical context. Build error type capturing source. |

**Key insight:** SSH and terminal handling are deceptively complex. The ecosystem has solved these problems extensively. Leverage existing, battle-tested solutions (ssh2 crate, standard SSH conventions, event-driven streaming).

## Common Pitfalls

### Pitfall 1: SSH Connection Lifetime Confusion

**What goes wrong:** Creating new SSH connection for each command, or holding connection indefinitely without heartbeat checks.

**Why it happens:** Underestimating SSH setup overhead (handshake, auth, key exchange ~200-500ms per connection). Or overestimating connection robustness (networks reset connections after idle period).

**How to avoid:**
- Establish single persistent connection at project startup
- Implement heartbeat/keepalive (ssh2 supports `TCPKeepAlive` option)
- On connection loss, implement exponential backoff reconnect (not immediate retry spam)

**Warning signs:**
- Each operation taking 300ms+ (suggests new connection per command)
- Random "connection reset" failures mid-execution (idle timeout)
- Memory growth over long sessions (connection leak)

### Pitfall 2: Buffering Large Terminal Output

**What goes wrong:** Reading all output into memory buffer before sending to frontend. Agent logs 100MB+ → crashes or freezes.

**Why it happens:** Simplicity trap—buffering feels easier than event handling. SSH2 channel streams are event-based, requires listening to 'data' events.

**How to avoid:**
- Use event-driven streaming: `channel.on('data', (chunk) => websocket.send(chunk))`
- Handle backpressure: check `channel.writable` before writing
- Set buffer limits: if backpressure detected, implement flow control

**Warning signs:**
- UI freezes during long-running agents
- Memory spike during agent execution
- Missed output in terminal (buffer overflow)

### Pitfall 3: Host Key Verification Skipped (Security Risk)

**What goes wrong:** Disabling host key checking to "simplify" first-time connection. User connects to attacker's server thinking it's their remote host.

**Why it happens:** Man-in-the-middle vulnerabilities seem theoretical. Ease of setup tempting.

**How to avoid:**
- Implement standard SSH host key prompt first time
- Store accepted keys in known_hosts-like structure
- Subsequent connections verify against stored key
- Provide UI to view/manage trusted hosts

**Warning signs:**
- No user confirmation on first SSH connection
- Host key verification disabled in config
- No feedback when connecting to new host

### Pitfall 4: Authentication Method Priority Wrong

**What goes wrong:** Trying password auth before key auth, or not falling back correctly.

**Why it happens:** CONTEXT.md decision eliminated password auth, but confusion on fallback order.

**How to avoid:**
- Implement priority: SSH key file (if provided) → SSH agent (if available) → error
- Don't fallback to password (not supported)
- Clear error if auth methods exhausted

**Warning signs:**
- Users prompted for password (not supported)
- SSH key configured but agent used instead
- Unexpected auth failures

### Pitfall 5: Not Handling Transient Network Errors

**What goes wrong:** First network hiccup terminates operation. User sees error, retries manually.

**Why it happens:** Underestimating network volatility (cell networks, WiFi, VPNs). CONTEXT.md specifies "auto-retry for transient failures."

**How to avoid:**
- Distinguish transient (timeout, connection reset) vs permanent (auth failure, host unreachable)
- Implement exponential backoff retry (transient only)
- Log retry attempts, stop after N attempts (not infinite retry)
- For permanent errors: alert user, stop retrying

**Warning signs:**
- Operation fails on first network blip
- Retry loop running forever (infinite backoff)
- No distinction between "network hiccup" and "invalid credentials"

### Pitfall 6: Terminal Resize Not Forwarded

**What goes wrong:** User resizes terminal in xterm.js, remote PTY doesn't resize. Remote output wraps incorrectly.

**Why it happens:** SSH PTY resize requires explicit `setenv` message on channel. Easy to miss in streaming setup.

**How to avoid:**
- Listen to xterm.js resize event
- Send SSH2 channel `setenv` COLUMNS/LINES on each resize
- Handle resize before and after connection established

**Warning signs:**
- Remote output line wrapping at wrong character count
- Text overlapping in terminal after resize
- Output stopping after terminal resize

## Code Examples

Verified patterns from official sources:

### Remote Git Operation (Create Worktree)

```rust
// Source: ssh2 crate docs (https://docs.rs/ssh2/latest/ssh2/)
use ssh2::Session;

pub async fn create_remote_worktree(
    session: &mut Session,
    remote_project_path: &str,
    branch: &str,
    worktree_name: &str,
) -> Result<String, Box<dyn std::error::Error>> {
    // Create channel and execute remote git command
    let mut channel = session.channel_session()?;

    let cmd = format!(
        "cd {} && git worktree add {} {}",
        remote_project_path, worktree_name, branch
    );

    channel.exec(&cmd)?;

    // Read output
    let mut s = String::new();
    channel.read_to_string(&mut s)?;

    channel.wait_close()?;
    Ok(s)
}
```

### SSH Authentication with Private Key

```rust
// Source: ssh2 crate docs
use ssh2::Session;
use std::net::TcpStream;
use std::path::Path;

pub async fn connect_with_key(
    host: &str,
    port: u16,
    username: &str,
    key_path: &Path,
) -> Result<Session, Box<dyn std::error::Error>> {
    let tcp = TcpStream::connect(format!("{}:{}", host, port))?;
    let mut session = Session::new()?;

    session.set_tcp_stream(tcp);
    session.handshake()?;

    // Authenticate with private key
    session.userauth_pubkey_file(
        username,
        None,  // public key - libssh2 can derive from private
        key_path,
        None,  // passphrase (None if key unencrypted or SSH agent will prompt)
    )?;

    Ok(session)
}
```

### Remote PTY Shell (Terminal Streaming)

```rust
// Source: ssh2 crate docs + portable-pty integration
pub async fn spawn_remote_shell_with_pty(
    session: &mut Session,
    term_type: &str,
    cols: u32,
    rows: u32,
) -> Result<(ssh2::Channel, (u32, u32)), Box<dyn std::error::Error>> {
    let mut channel = session.channel_session()?;

    // Request pseudo-terminal
    channel.request_pty(
        term_type,
        None,  // modes (default)
        Some((cols, rows, 0, 0)),  // terminal size
    )?;

    // Start shell
    channel.shell()?;

    Ok((channel, (cols, rows)))
}
```

### Error Handling with Reconnect Logic

```rust
// Source: error handling patterns from reqwest/tokio ecosystem
pub enum RemoteError {
    ConnectionError(String),
    AuthenticationError(String),
    CommandExecutionError {
        exit_code: i32,
        stderr: String
    },
}

pub async fn execute_with_retry(
    session: &mut Session,
    cmd: &str,
    max_retries: u32,
) -> Result<String, RemoteError> {
    for attempt in 0..max_retries {
        match execute_command(session, cmd) {
            Ok(output) => return Ok(output),
            Err(e) if is_transient_error(&e) => {
                if attempt < max_retries - 1 {
                    tokio::time::sleep(
                        tokio::time::Duration::from_millis(100 * 2_u64.pow(attempt))
                    ).await;
                    continue;
                }
            }
            Err(e) => return Err(e),  // Permanent error, don't retry
        }
    }
    Err(RemoteError::ConnectionError("Max retries exceeded".into()))
}

fn is_transient_error(e: &RemoteError) -> bool {
    matches!(e, RemoteError::ConnectionError(_))
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| **Custom SSH protocol implementation** | Use libssh2 via ssh2 crate (Rust) or ssh2 package (Node.js) | 2010s onward | Eliminated security vulnerabilities, standardized protocol. No modern projects roll their own SSH. |
| **Per-command SSH connections** | Single persistent connection per session | libssh2 efficiency improvements, cloud era | 200-500ms saved per command. Reduces server load. Standard for long-running operations. |
| **Password storage in app config** | SSH key files + SSH agent passphrases | Security awareness shift post-2015 | Eliminates credential storage risk. Delegates to OS-level security (agent). |
| **Blocking I/O for terminal streaming** | Event-driven streaming (Node.js on('data')) | Node.js v0.10+ events standard | Handles concurrent streams, large outputs without memory overhead. |
| **Known hosts manual management** | Automatic verification + `known_hosts` file | OpenSSH ecosystem maturity | Reduces manual steps. Improves security posture. Familiar to users. |

**Deprecated/outdated:**
- **Paramiko (Python SSH):** Still used in Python ecosystem, but for Rust/Node.js: native bindings preferred.
- **Custom terminal escape code parsing:** xterm.js (15+ years, battle-tested) handles all edge cases.
- **SSH tunneling for port forwarding:** Now standard in libssh2. No need for separate socat/ssh tunnel processes.

## Open Questions

Things that couldn't be fully resolved:

1. **SSH multiplexing (ControlMaster) implementation details**
   - What we know: SSH2 supports connection reuse, can reduce handshake overhead
   - What's unclear: Whether to implement OS-level ControlMaster socket sharing or rely on ssh2 crate connection reuse
   - Recommendation: Start with single persistent connection (simpler). Measure latency. If needed, profile ssh2 connection reuse before implementing ControlMaster.

2. **Host key storage format and location**
   - What we know: Need to store accepted host keys to verify on reconnect
   - What's unclear: Use standard `known_hosts` file or custom SQLite table?
   - Recommendation: Custom SQLite table (consistent with app state). Store host:port+fingerprint pairs. UI to view/manage.

3. **Passphrase prompt UI/UX**
   - What we know: SSH agent handles passphrases, app doesn't store them
   - What's unclear: If SSH agent unavailable and key has passphrase, how to prompt user?
   - Recommendation: Require SSH agent for passphrase-protected keys. If not available, provide clear error message. Document user setup guide.

4. **Timeout value tuning**
   - What we know: CONTEXT.md specifies 10s connection, 30s idle
   - What's unclear: Are these appropriate for all network conditions? VPNs, cell networks may need adjustment.
   - Recommendation: Make configurable in project settings. Start with specified defaults, allow users to tune.

## Sources

### Primary (HIGH confidence)

- **ssh2 crate (Rust)** - https://docs.rs/ssh2/latest/ssh2/ — Comprehensive API docs, PTY allocation, channel management, authentication methods
- **ssh2 package (Node.js)** - https://github.com/mscdex/ssh2 — README, issue tracker, authentication patterns
- **portable-pty** (Rust) - https://docs.rs/portable-pty/latest/portable_pty/ — PTY allocation cross-platform
- **Node.js child_process docs** - https://nodejs.org/api/child_process.html — Confirmed no native PTY in child_process (third-party libraries required)

### Secondary (MEDIUM confidence)

- **Verified findings:** ssh2 v1.17.0 current as of Feb 2025 with minimal dependencies (asn1, bcrypt-pbkdf)
- **SSH protocols:** RFC 4251-4254 (OpenSSH standard)
- **Connection management patterns:** Used in projects like VS Code Remote SSH, OpenSSH client

### Tertiary (LOW confidence)

- **SSH multiplexing details:** Assumed based on OpenSSH ControlMaster, not independently verified for ssh2 crate behavior
- **Timeout value tuning:** Recommended values from CONTEXT.md, not validated across network conditions

## Metadata

**Confidence breakdown:**
- Standard stack: **HIGH** — ssh2 crate well-documented, widely used, proven in production systems (VS Code, Hyper)
- Architecture patterns: **HIGH** — Patterns follow established SSH client patterns from OpenSSH ecosystem
- Pitfalls: **HIGH** — Derived from common SSH/terminal issues across industry (documented in OpenSSH, xterm.js communities)
- Open questions: **MEDIUM** — Gaps in implementation details for this specific project (multiplexing strategy, host key storage format)

**Research date:** 2026-02-08
**Valid until:** 2026-02-22 (14 days — SSH standards stable, but verify ssh2 package updates if major new version released)

**Phase dependencies confirmed:**
- Requires Phase 3 (git operations base) ✓
- Requires Phase 4 (worktree management) ✓
- Requires Phase 8 (error handling) ✓
- Integrates with existing Tauri architecture ✓
