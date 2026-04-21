# Phase 43: Local ACP Session Manager - Research

**Researched:** 2026-04-20
**Domain:** Rust subprocess management, Tauri event emission, AppState extension
**Confidence:** HIGH

## Summary

Phase 43 wires the Tauri backend to the `maestro-server` binary built in Phase 42. The desktop app
needs to spawn `maestro-server` as a managed child process per session (piped stdin/stdout), track
live ACP sessions in `AppState`, and emit typed Tauri events to the frontend from a background
reader task that parses `maestro-server` stdout.

The codebase already has all the primitives needed. `AppHandle` is stored in `AppState` (Phase 40
pattern). `tokio::process::Command` with piped stdio is used in `maestro-server/src/agent.rs`.
The `maestro_protocol` framing layer (`read_message` / `write_message`) is available to both sides.
The Tauri 2 `app_handle.emit("event-name", payload)` pattern is verified in
`src-tauri/src/ssh/session.rs`. This phase is purely additive: a new `acp_sessions` map in
`AppState`, a new `AcpProcess` struct, a background reader task, and 1-2 new IPC commands.

**Primary recommendation:** Add `acp_sessions: tokio::sync::Mutex<HashMap<i32, AcpProcess>>` to
`AppState` (keyed by `log_id`, same as `pty_sessions`), spawn `maestro-server` with
`tokio::process::Command`, read its stdout in a `tokio::spawn` background task using
`maestro_protocol::read_message`, and emit typed Tauri events using the verified
`app_handle.emit` pattern.

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| SESSION-01 | Tauri backend launches maestro-server as local subprocess per ACP session with piped stdin/stdout | tokio::process::Command + Stdio::piped() — same pattern as maestro-server/src/agent.rs |
| SESSION-02 | ACP sessions tracked in AppState (acp_sessions: tokio::sync::Mutex<HashMap<i32, AcpSession>>) keyed by log_id | AppState already uses this exact pattern for pty_sessions and ssh_pty_sessions |
| SESSION-03 | Tauri emits typed events per session from background reader task | app_handle.emit() verified in ssh/session.rs; maestro_protocol::read_message drives the reader loop |
</phase_requirements>

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Subprocess spawn (maestro-server) | API / Backend (Rust) | — | Process management belongs in Rust; Tauri IPC command initiates it |
| Session state tracking (acp_sessions map) | API / Backend (Rust) | — | AppState owns all runtime session maps; pattern established by pty_sessions |
| Stdout reader loop | API / Backend (Rust) | — | Background tokio task reads framed messages from child stdout |
| Typed event emission | API / Backend (Rust) | Browser / Client | Rust emits; frontend subscribes via `@tauri-apps/api/event` listen() |
| Session cleanup | API / Backend (Rust) | — | Drop child process handle; remove from acp_sessions map |

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| tokio::process | (tokio 1 — already in Cargo.toml) | Spawn async child process with piped stdio | Already used throughout codebase; async-safe |
| maestro-protocol | (path dep — already in Cargo.toml) | read_message / write_message framing | Established in Phase 41/42; both sides share this crate |
| tauri::Emitter | (tauri 2 — already in Cargo.toml) | Emit typed Tauri events to frontend | Verified pattern from Phase 40 (ssh/session.rs) |
| serde / serde_json | (already in Cargo.toml) | Serialize event payloads | Standard throughout codebase |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| tokio::io::BufReader | (tokio 1) | Buffered async reads from child stdout | Wrap child stdout before passing to read_message |
| tokio::sync::oneshot | (tokio 1) | Signal clean shutdown of reader task | Use for cancellation token when session ends |

No new dependencies needed. All required crates are already in `src-tauri/Cargo.toml`.

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Direct tokio::process | tauri_plugin_shell sidecar API | Shell plugin bundles binary inside Tauri app; maestro-server needs to be a standalone external binary (v2 remote target) — not suitable |
| app_handle.emit (global) | tauri::ipc::Channel | Channel requires frontend to have already called the IPC command; emit works from any background task at any time — better for unsolicited server pushes |

## Architecture Patterns

### System Architecture Diagram

```
IPC Command (spawn_acp_session)
         │
         ▼
  tokio::process::Command::new("maestro-server")
  .stdin(Stdio::piped())
  .stdout(Stdio::piped())
  .spawn()
         │
         ├─── child.stdin ──► AcpProcess.stdin_writer (tokio::io::BufWriter<ChildStdin>)
         │                    (used by send_acp_prompt, respond_acp_permission IPC commands)
         │
         └─── child.stdout ──► Background Reader Task (tokio::spawn)
                                    │
                                    │ read_message(&mut stdout_reader)
                                    │
                                    ├── ServerResponse::SpawnOk ──► (log initial success, no Tauri event needed)
                                    │
                                    ├── ServerResponse::SessionUpdate ──►
                                    │       app_handle.emit("acp://session-update/{log_id}", payload)
                                    │
                                    ├── ServerResponse::TerminalOutput ──►
                                    │       app_handle.emit("acp://terminal-output/{log_id}", payload)
                                    │
                                    ├── ServerResponse::PermissionRequest ──►
                                    │       app_handle.emit("acp://permission-request/{log_id}", payload)
                                    │
                                    └── EOF / Error ──► remove from acp_sessions, emit session-ended event

AppState.acp_sessions: tokio::sync::Mutex<HashMap<i32, AcpProcess>>
    keyed by log_id (i32), same as pty_sessions
```

### Recommended Project Structure

The phase touches these files only:

```
src-tauri/src/
├── db/
│   └── connection.rs      # Add acp_sessions field to AppState + AcpProcess struct
├── acp/
│   ├── mod.rs             # Re-export AcpProcess
│   └── manager.rs         # NEW: spawn_acp_process(), background reader task logic
└── ipc/
    └── execution_handlers.rs  # NEW: spawn_acp_session IPC command stub (Phase 44 adds full DB integration)
```

Alternatively, `AcpProcess` can live in `acp/session.rs` (already exists) and reader logic in
`acp/manager.rs`. The exact split is at planner discretion.

### Pattern 1: AcpProcess Struct (Tauri-side session handle)

The `AcpProcess` struct holds everything needed to write to and track the child process.

**What:** Desktop-side handle for a live maestro-server subprocess.
**When to use:** Created on spawn, stored in `AppState.acp_sessions`, dropped on cleanup.

```rust
// Source: [VERIFIED: codebase pattern from ssh/session.rs + agent.rs]
use tokio::process::{Child, ChildStdin};
use tokio::io::BufWriter;
use tokio::sync::oneshot;

pub struct AcpProcess {
    /// Child process handle (kill_on_drop keeps cleanup automatic)
    pub child: Child,
    /// Write half of piped stdin — used to send SpawnRequest, PromptRequest, PermitResponse
    pub stdin_writer: BufWriter<ChildStdin>,
    /// Cancel signal for the background reader task
    pub reader_cancel_tx: oneshot::Sender<()>,
}
```

**Note:** `Child` must hold the `ChildStdin` separately via `child.stdin.take()` before storing
the child handle, otherwise `ChildStdin` drops immediately when the child is stored. The canonical
pattern (verified in `maestro-server/src/main.rs` line 85):

```rust
// Source: [VERIFIED: maestro-server/src/main.rs:82-91]
let child_stdin = child.stdin.take().expect("child stdin must be piped");
let child_stdout = child.stdout.take().expect("child stdout must be piped");
```

### Pattern 2: Background Reader Task

**What:** `tokio::spawn` task that loops on `read_message` from child stdout and emits Tauri events.
**When to use:** Spawned immediately after the child process starts.

```rust
// Source: [VERIFIED: app_handle.emit pattern from src-tauri/src/ssh/session.rs:948]
// Source: [VERIFIED: read_message from maestro-protocol/src/lib.rs:105-117]
use tauri::Emitter;
use maestro_protocol::{read_message, MaestroRpcMessage, ServerResponse};

let (cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel::<()>();
let app_handle2 = app_handle.clone();
let log_id2 = log_id;

tokio::spawn(async move {
    let mut stdout_reader = tokio::io::BufReader::new(child_stdout);
    loop {
        tokio::select! {
            biased;
            _ = &mut cancel_rx => break,
            result = read_message(&mut stdout_reader) => {
                match result {
                    Ok(MaestroRpcMessage::Response(ServerResponse::SessionUpdate(upd))) => {
                        let _ = app_handle2.emit(
                            &format!("acp://session-update/{}", log_id2),
                            upd.payload,
                        );
                    }
                    Ok(MaestroRpcMessage::Response(ServerResponse::TerminalOutput(out))) => {
                        let _ = app_handle2.emit(
                            &format!("acp://terminal-output/{}", log_id2),
                            out.bytes,
                        );
                    }
                    Ok(MaestroRpcMessage::Response(ServerResponse::PermissionRequest(req))) => {
                        let _ = app_handle2.emit(
                            &format!("acp://permission-request/{}", log_id2),
                            req,
                        );
                    }
                    Ok(_) => {} // SpawnOk, Error variants: no Tauri event needed here
                    Err(_) => break, // EOF or parse error — server exited
                }
            }
        }
    }
    // Session ended: remove from acp_sessions map
    // Note: can't hold AppState Arc in the reader task unless threaded in explicitly
    // Use app_handle.emit("acp://session-ended/{log_id}", ()) to signal frontend
    let _ = app_handle2.emit(
        &format!("acp://session-ended/{}", log_id2),
        (),
    );
});
```

### Pattern 3: AppState Extension

**What:** Add `acp_sessions` field following the exact same pattern as `pty_sessions`.
**When to use:** Always — this is the required approach for SESSION-02.

```rust
// Source: [VERIFIED: src-tauri/src/db/connection.rs:52-60]
// Existing pattern to follow:
pub pty_sessions: tokio::sync::Mutex<HashMap<i32, Arc<tokio::sync::Mutex<PtySession>>>>,

// New field (no Arc<Mutex<…>> wrapping needed — AcpProcess is not shared between tasks):
pub acp_sessions: tokio::sync::Mutex<HashMap<i32, AcpProcess>>,
```

`AcpProcess` does not need an inner `Arc<Mutex<>>` because only the reader task accesses the
stdout, and only IPC commands write to stdin. The IPC commands lock the outer Mutex to access the
`stdin_writer`, so there is no concurrent write contention.

### Pattern 4: Writing to maestro-server stdin

**What:** Serialize a `MaestroRpcMessage` and write framed bytes to the child stdin.
**When to use:** From IPC commands (send_acp_prompt, respond_acp_permission in Phase 44).

```rust
// Source: [VERIFIED: maestro-protocol/src/lib.rs:94-103 write_message]
// Source: [VERIFIED: maestro-server/src/client.rs:57-67 send_response pattern]
use tokio::io::AsyncWriteExt;

async fn write_to_server(stdin_writer: &mut BufWriter<ChildStdin>, msg: &MaestroRpcMessage)
    -> Result<(), String>
{
    let mut buf: Vec<u8> = Vec::new();
    maestro_protocol::write_message(&mut buf, msg).await
        .map_err(|e| format!("serialize failed: {}", e))?;
    stdin_writer.write_all(&buf).await
        .map_err(|e| format!("stdin write failed: {}", e))?;
    stdin_writer.flush().await
        .map_err(|e| format!("stdin flush failed: {}", e))?;
    Ok(())
}
```

### Pattern 5: IPC Command Stub for spawn_acp_session

Phase 43 adds a minimal IPC command that only covers SESSION-01/02/03. Full DB integration
(execution_log creation, log_id, execution_mode='acp') belongs to Phase 44 (PERSIST-01/02).
This phase creates the mechanics; Phase 44 wires the DB row.

For Phase 43 the IPC command can accept a `log_id` from the caller (caller creates the DB row
for now, or Phase 43 creates it inline). The REQUIREMENTS.md says SESSION-01 is "Tauri backend
launches maestro-server as local subprocess per ACP session with piped stdin/stdout" — this can
be a standalone function called from a stub IPC, without needing PERSIST-01 schema changes first.

**Recommended approach for Phase 43:** spawn command accepts `(agent_id, cwd, log_id)` and
returns `log_id`. This keeps Phase 43 independent from Phase 44's schema migration. Phase 44
will create the DB row and call this spawn function.

### Anti-Patterns to Avoid

- **Storing `ChildStdout` in AcpProcess:** The reader task takes ownership of the stdout handle
  immediately on spawn. Do NOT store it in `AcpProcess` — the task consumes it. Store only the
  cancel sender.
- **Using `std::sync::Mutex` for acp_sessions:** Never hold `std::sync::Mutex` across `.await`
  points. Use `tokio::sync::Mutex` like all other session maps in AppState.
- **Blocking the Tauri event loop with read_message:** Always `tokio::spawn` the reader, never
  `block_in_place` or `spawn_blocking` for async reads. `read_message` is already `async`.
- **Forgetting flush after stdin write:** `BufWriter::write_all` buffers. Must `flush()` after
  each message or maestro-server will never receive it (verified issue in client.rs:65 which
  explicitly calls `out.flush().await`).
- **Using tauri_plugin_shell sidecar API:** maestro-server is not bundled inside the app bundle.
  It is an external binary (future: deployed to remote host). Use `tokio::process::Command`
  directly with the binary path, same as how the codebase spawns other tools.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Message framing for stdin/stdout | Custom length-prefix protocol | `maestro_protocol::write_message` / `read_message` | Already implemented, tested, and battle-hardened in Phase 41/42 |
| Process lifecycle cleanup | Custom SIGKILL management | `tokio::process::Command::kill_on_drop(true)` | Automatic cleanup on `Child` drop, tested pattern in agent.rs |
| Event delivery to frontend | Custom WebSocket or polling | `tauri::Emitter::emit` | Built-in Tauri mechanism, no extra infra, already used in Phase 40 |
| Cancel signaling for reader task | AtomicBool polling | `tokio::sync::oneshot::channel` | Cleaner for tasks that block on `read_message` (vs AtomicBool which requires polling) |

**Key insight:** The framing protocol, process spawning pattern, and event emission pattern are
all already implemented and used in this codebase. Phase 43 is purely about composition.

## Common Pitfalls

### Pitfall 1: Child stdin silently dropped
**What goes wrong:** `child.stdin` drops immediately if you don't `take()` it before storing the
`Child` in `AcpProcess`. This closes the child's stdin pipe, causing maestro-server to exit.
**Why it happens:** `Child` owns `Option<ChildStdin>`; storing `child` moves it, and if `stdin`
wasn't taken first it drops.
**How to avoid:** Always call `child.stdin.take().expect("child stdin must be piped")` before
any other use of `child`.
**Warning signs:** maestro-server exits immediately after spawn with "unexpected EOF on stdin".

### Pitfall 2: read_message blocking on a BufReader wrapping raw ChildStdout
**What goes wrong:** `tokio::io::BufReader::new(child_stdout)` works only if `child_stdout` is
moved in (not borrowed). Passing `&mut child.stdout` after the child is stored fails borrow check.
**Why it happens:** After `child.stdout.take()`, the `ChildStdout` is owned — must be taken before
storing `child`.
**How to avoid:** Take both stdin and stdout before storing the child handle (verified pattern from
maestro-server/src/main.rs:82-91).
**Warning signs:** Rust borrow checker error: "cannot move out of borrowed content".

### Pitfall 3: Event name string format must be consistent
**What goes wrong:** Frontend uses `listen("acp://session-update/42", ...)` but backend emits
`"acp://session-update/42 "` (trailing space) or a different format. Events silently never fire.
**Why it happens:** Event names are strings; there is no compile-time check.
**How to avoid:** Define event name constants (or format macros) in one place. Use the exact
format from REQUIREMENTS.md: `acp://session-update/{log_id}`, `acp://terminal-output/{log_id}`,
`acp://permission-request/{log_id}`.
**Warning signs:** Frontend listener callback never called despite backend claiming success.

### Pitfall 4: `read_message` uses `tokio::io::AsyncRead`, not `std::io::Read`
**What goes wrong:** Wrapping child stdout in a `std::io::BufReader` instead of
`tokio::io::BufReader` causes a type mismatch — `read_message` requires `AsyncRead + Unpin`.
**Why it happens:** Easy to confuse the sync and async versions of `BufReader`.
**How to avoid:** Use `tokio::io::BufReader` and `use tokio::io::AsyncReadExt`. The
`maestro_protocol::read_message` signature is `async fn read_message<R: AsyncRead + Unpin>`.
**Warning signs:** Compile error: "the trait AsyncRead is not implemented for BufReader<ChildStdout>".

### Pitfall 5: Forgetting to re-export AcpProcess from acp/mod.rs and lib.rs
**What goes wrong:** `AppState` in `db/connection.rs` can't see the `AcpProcess` type.
**Why it happens:** Rust module system requires explicit re-exports.
**How to avoid:** After defining `AcpProcess` in `acp/session.rs` or `acp/manager.rs`, add
`pub use acp::AcpProcess` in `acp/mod.rs`, then in `lib.rs` add to the existing `pub use acp::…`
line.
**Warning signs:** `use crate::acp::AcpProcess` gives "unresolved import".

### Pitfall 6: SESSION-03 event names in Tauri 2 — slashes are valid but test carefully
**What goes wrong:** Tauri 2 event names with slashes (`acp://…`) may behave differently from
simple names in some Tauri versions.
**Why it happens:** Tauri event name parsing. Phase 40 used simple names like `"ssh-connection-lost"`.
**How to avoid:** Test with a simple event name first during development. Slash-based namespacing
is declared in REQUIREMENTS.md and should work in Tauri 2, but validate in integration testing.
**Warning signs:** `listen("acp://session-update/42")` on frontend never fires.

## Code Examples

### Verified: AppHandle.emit from background task
```rust
// Source: [VERIFIED: src-tauri/src/ssh/session.rs:948]
use tauri::Emitter;
let _ = app_handle.emit("ssh-connection-lost", connection_id);
```

### Verified: AppHandle stored in AppState
```rust
// Source: [VERIFIED: src-tauri/src/db/connection.rs:49-51]
pub struct AppState {
    pub db: Mutex<Connection>,
    pub app_handle: AppHandle,
    // ...
}
```

### Verified: AppHandle cloned from setup hook
```rust
// Source: [VERIFIED: src-tauri/src/main.rs:19]
let app_state = Arc::new(AppState::new(conn, app.handle().clone()));
```

### Verified: tokio::sync::Mutex HashMap pattern for session maps
```rust
// Source: [VERIFIED: src-tauri/src/db/connection.rs:52-60]
pub pty_sessions: tokio::sync::Mutex<HashMap<i32, Arc<tokio::sync::Mutex<PtySession>>>>,
pub ssh_pty_sessions: tokio::sync::Mutex<HashMap<i32, SshPtyHandle>>,
```

### Verified: maestro-server stdin/stdout take pattern
```rust
// Source: [VERIFIED: maestro-server/src/main.rs:82-91]
let child_stdin = child.stdin.take().expect("child stdin must be piped");
let child_stdout = child.stdout.take().expect("child stdout must be piped");
```

### Verified: write_message framing
```rust
// Source: [VERIFIED: maestro-protocol/src/lib.rs:94-103]
pub async fn write_message<W: AsyncWrite + Unpin>(
    stream: &mut W,
    msg: &MaestroRpcMessage,
) -> Result<(), Box<dyn std::error::Error>> {
    let bytes = serde_json::to_vec(msg)?;
    let len = bytes.len() as u32;
    stream.write_all(&len.to_le_bytes()).await?;
    stream.write_all(&bytes).await?;
    Ok(())
}
```

### Verified: read_message framing (MAX_MESSAGE_SIZE guard)
```rust
// Source: [VERIFIED: maestro-protocol/src/lib.rs:105-117]
pub async fn read_message<R: AsyncRead + Unpin>(
    stream: &mut R,
) -> Result<MaestroRpcMessage, Box<dyn std::error::Error>> {
    let mut len_buf = [0u8; MSG_LEN_SIZE];
    stream.read_exact(&mut len_buf).await?;
    let len = u32::from_le_bytes(len_buf) as usize;
    if len > MAX_MESSAGE_SIZE {
        return Err(format!("Message too large: {} bytes (max {})", len, MAX_MESSAGE_SIZE).into());
    }
    let mut body = vec![0u8; len];
    stream.read_exact(&mut body).await?;
    Ok(serde_json::from_slice(&body)?)
}
```

### Verified: tokio::process::Command with piped stdio and kill_on_drop
```rust
// Source: [VERIFIED: maestro-server/src/agent.rs:27-35]
let child = tokio::process::Command::new(command)
    .args(args)
    .current_dir(cwd_path)
    .stdin(std::process::Stdio::piped())
    .stdout(std::process::Stdio::piped())
    .stderr(std::process::Stdio::inherit())
    .kill_on_drop(true)
    .spawn()
    .map_err(|e| format!("failed to spawn agent '{}': {}", command, e))?;
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| spawn_blocking for PTY reads | tokio::spawn for async reads | N/A (read_message is already async) | No blocking thread needed for ACP session reader |
| tauri_plugin_shell sidecar | Direct tokio::process::Command | N/A for this project | Shell plugin bundles binary; maestro-server is external |

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Tauri 2 event names with slashes (`acp://session-update/42`) are supported | Pitfall 6, Standard Stack | Frontend listen() would never fire; can fall back to underscore format like `acp-session-update-42` |
| A2 | Phase 43 IPC command can accept log_id from caller rather than creating it internally, keeping it independent from Phase 44 schema changes | Pattern 5 | If log_id must be created from DB (requires PERSIST-01 schema), Phase 43 would depend on Phase 44 — plan would need to reorder |

## Open Questions (RESOLVED)

1. **Tauri event name with URL-scheme format (`acp://…`)** — RESOLVED: Accepted as assumption A1; use `acp://…` format as specified in REQUIREMENTS.md. Fallback to `acp-session-update-{log_id}` flat format if integration testing reveals Tauri 2 rejects slashes/colons.

2. **Where to resolve maestro-server binary path** — RESOLVED: Use `which::which("maestro-server")` with a clear error message if not found (mirrors `resolve_command_path` pattern in `pty.rs`). Phase 43 is developer-only initially.

3. **Should AcpSession (in acp/session.rs) be extended or replaced by AcpProcess?** — RESOLVED: Keep separate. `AcpProcess` is the runtime OS-level handle stored in `AppState.acp_sessions`. `AcpSession` remains a metadata struct for Phase 44's DB representation. The two are not merged in Phase 43.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| maestro-server binary | SESSION-01 | Build-time | N/A (Rust workspace member) | — (must build first) |
| tokio (full) | All async patterns | ✓ (in Cargo.toml) | 1.x | — |
| maestro-protocol crate | read_message / write_message | ✓ (path dep in Cargo.toml) | local | — |
| tauri::Emitter trait | SESSION-03 | ✓ (tauri 2 in Cargo.toml) | 2.x | — |

**Missing dependencies:** None. All required crates are already declared.

**Build note:** `maestro-server` must be built (`cargo build -p maestro-server`) before manual
testing. The binary is at `target/debug/maestro-server` or installed on PATH.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | cargo test (Rust unit tests in `#[cfg(test)]` modules) |
| Config file | none — uses workspace defaults |
| Quick run command | `cd /home/m306213/workspace/maestro && cargo check --workspace` |
| Full suite command | `cd /home/m306213/workspace/maestro/src-tauri && cargo test` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| SESSION-01 | spawn_acp_session creates child process with piped stdio | unit (Rust) | `cargo test -p maestro test_spawn_acp_session` | ❌ Wave 0 |
| SESSION-02 | acp_sessions map insert/lookup/remove | unit (Rust) | `cargo test -p maestro test_acp_sessions_map` | ❌ Wave 0 |
| SESSION-03 | reader task emits correct event names for each ServerResponse variant | integration (manual) | build + manual Tauri dev test | ❌ manual-only (Tauri events require webview) |

**Note on SESSION-03:** Tauri event emission from background tasks cannot be unit tested without
a running Tauri app. The emit pattern is identical to Phase 40's SSH heartbeat events which were
validated via manual testing. SESSION-03 verification is integration/smoke test only.

### Sampling Rate
- **Per task commit:** `cargo check --workspace` (fast, catches type errors)
- **Per wave merge:** `cargo test -p maestro` (full Rust test suite)
- **Phase gate:** `cargo check --workspace` green + `cargo test -p maestro` green + manual smoke
  test confirming events fire in Tauri dev before `/gsd-verify-work`

### Wave 0 Gaps
- [ ] `src-tauri/src/acp/manager.rs` — covers SESSION-01/02 with unit tests for spawn and map operations
- [ ] Test for `AcpProcess` struct creation and stdin take pattern

*(SESSION-03 Tauri event testing: "None — Tauri webview events require running app; validated manually")*

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no | — |
| V3 Session Management | yes | Session map keyed by log_id; cleanup on drop ensures no orphaned processes |
| V4 Access Control | no | IPC already protected by Tauri's IPC boundary |
| V5 Input Validation | yes | cwd path validated before spawn (existing T-42-01 pattern in maestro-server/src/agent.rs) |
| V6 Cryptography | no | — |

### Known Threat Patterns

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Path traversal in cwd argument to spawn | Tampering | Reject `..` components (established T-42-01 in agent.rs — same guard on Tauri side) |
| Orphaned maestro-server processes on session crash | Elevation of privilege | `kill_on_drop(true)` on `Child`; drop from `acp_sessions` map triggers OS-level kill |
| stdin injection via session_id or agent_id | Tampering | Use `Command::new(binary).args([...])` — never shell strings (established T-42-02 pattern) |

## Sources

### Primary (HIGH confidence)
- `[VERIFIED: src-tauri/src/db/connection.rs]` — AppState struct, pty_sessions/ssh_pty_sessions map patterns, AppHandle storage
- `[VERIFIED: src-tauri/src/ssh/session.rs:948]` — app_handle.emit() pattern from background task
- `[VERIFIED: maestro-server/src/agent.rs]` — tokio::process::Command with kill_on_drop, piped stdio
- `[VERIFIED: maestro-server/src/main.rs:82-91]` — stdin/stdout take() pattern before storing Child
- `[VERIFIED: maestro-protocol/src/lib.rs]` — write_message / read_message API
- `[VERIFIED: src-tauri/Cargo.toml]` — all required deps already present
- `[CITED: context7 /tauri-apps/tauri-docs]` — Tauri 2 AppHandle.emit() API, use tauri::Emitter trait

### Secondary (MEDIUM confidence)
- `[VERIFIED: src-tauri/src/ipc/execution_handlers.rs]` — spawn_interactive_execution pattern (IPC command structure to replicate)
- `[VERIFIED: maestro-server/src/client.rs:57-67]` — send_response flush pattern (must flush BufWriter after each message)

### Tertiary (LOW confidence)
- `[ASSUMED]` — Tauri 2 event names with slashes (`acp://…`) are valid (not explicitly tested; flagged as A1)

## Metadata

**Confidence breakdown:**
- Standard Stack: HIGH — all deps verified in Cargo.toml; all patterns verified in codebase
- Architecture: HIGH — direct composition of verified existing patterns
- Pitfalls: HIGH — derived from actual code inspection (stdin drop, BufReader type mismatch)
- Tauri event name format: MEDIUM — slice syntax assumed valid; needs validation

**Research date:** 2026-04-20
**Valid until:** 2026-05-20 (stable Rust/Tauri stack, 30-day window appropriate)
