# Phase 42: maestro-server Activation — Research

**Researched:** 2026-04-17
**Domain:** Rust async, ACP Rust SDK v0.10.4, tokio process management, piped stdio message loop
**Confidence:** HIGH

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| SERVER-01 | maestro-server receives SpawnRequest on stdin, spawns ACP agent subprocess via ClientSideConnection, returns SpawnOk on stdout | ACP SDK `ClientSideConnection::new()` + tokio process spawn pattern; `maestro-protocol::read_message` / `write_message` already implement framing |
| SERVER-02 | maestro-server forwards structured session updates (messages, tool calls, diffs, plans) to stdout as `ServerResponse::SessionUpdate` | ACP `Client::session_notification` receives `SessionNotification { session_id, update: SessionUpdate }` — all structured updates arrive here; serialize to `MaestroRpcMessage::Response(SessionUpdate(...))` and write to stdout |
| SERVER-03 | maestro-server forwards raw terminal output from ACP agent terminal callbacks to stdout as `ServerResponse::TerminalOutput` | ACP `Client::create_terminal` / `terminal_output` callbacks manage PTY; raw bytes captured in `create_terminal`, forwarded immediately as `ServerResponse::TerminalOutput` frames; agent polls via `terminal/output` |
| SERVER-04 | maestro-server forwards permission requests to Maestro as `ServerResponse::PermissionRequest`; receiving `PermissionResponse` on stdin unblocks the agent | ACP `Client::request_permission` is a `Future` that blocks until response arrives — implement with `tokio::sync::oneshot`; incoming `ServerRequest::PermitResponse` from stdin resolves the oneshot |
</phase_requirements>

---

## Summary

Phase 42 activates the `maestro-server` binary that was scaffolded in Phase 41. The skeleton binary (`fn main() { LocalSet::run_until(async {}) }`) must be replaced with a real message loop that:

1. Reads `ServerRequest` messages from stdin (length-prefixed JSON via `maestro_protocol::read_message`)
2. On `Spawn`: creates a `ClientSideConnection` to the named ACP agent subprocess, stores the connection in a session map
3. On `Prompt`: calls `conn.new_session(...)` + `conn.prompt(...)` on the live connection
4. On `Cancel`: drops the connection
5. Forwards all `ServerResponse` variants back to stdout via `maestro_protocol::write_message`

The critical implementation challenge is the bidirectional nature of the ACP `Client` trait. When the agent calls back into the client (permission requests, session updates, terminal management), the `MaestroAcpClient` implementation must serialize those callbacks into `ServerResponse` JSON frames and write them to stdout. Permission requests additionally require async blocking: `request_permission` must return a `Future` that suspends until a `PermissionResponse` arrives on stdin and is dispatched to the correct awaiting future via `tokio::sync::oneshot`.

The entire runtime must stay in a `current_thread` / `LocalSet` context because `MaestroAcpClient` is `!Send` (the ACP `Client` trait uses `#[async_trait::async_trait(?Send)]`). This was established in Phase 41.

**Primary recommendation:** Implement a `MaestroServerClient` struct that holds a `tokio::io::AsyncWrite` handle for stdout + a `tokio::sync::Mutex<HashMap<String, oneshot::Sender<PermissionResponse>>>` for pending permission requests. Wire `session_notification` and `create_terminal` callbacks to `write_message` on stdout; wire `request_permission` to a `oneshot` channel stored in the map, resolved when `ServerRequest::PermitResponse` arrives on stdin.

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| stdin reader loop | `maestro-server/src/main.rs` | — | Binary owns top-level I/O; reads `MaestroRpcMessage::Request` frames |
| stdout writer (ServerResponse) | `MaestroServerClient` struct | — | Callback impl holds stdout writer; all write paths go through it |
| ACP agent subprocess management | `maestro-server/src/main.rs` | `ClientSideConnection` (SDK) | Spawns agent subprocess, creates connection, stores in session map |
| Session update forwarding (SERVER-02) | `MaestroServerClient::session_notification` | — | ACP callback converts `SessionNotification` to `ServerResponse::SessionUpdate` |
| Terminal management (SERVER-03) | `MaestroServerClient::create_terminal` + `terminal_output` | tokio process | `create_terminal` spawns subprocess + captures output buffer; `terminal_output` returns accumulated bytes |
| Permission pausing (SERVER-04) | `MaestroServerClient::request_permission` | `oneshot` channel | Async-blocks on `oneshot::Receiver`; stdin loop dispatches to `oneshot::Sender` |
| Session map (connection tracking) | `maestro-server/src/sessions.rs` | — | Maps `session_id` → `(ClientSideConnection, pending_permissions_map)` |

---

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `agent-client-protocol` | 0.10.4 | ACP Rust SDK: `Client` trait, `ClientSideConnection`, all ACP types | Already in `maestro-server/Cargo.toml` — Phase 41 wired it |
| `tokio` | 1 (full) | Async runtime (`current_thread`), `oneshot`, `Mutex`, process spawn | Already in workspace |
| `tokio-util` | 0.7 (compat) | Bridge `tokio::io::AsyncRead/Write` ↔ `futures::io::AsyncRead/Write` for `ClientSideConnection::new()` | Already in `maestro-server/Cargo.toml` — Phase 41 added it explicitly |
| `futures` | 0.3 | `AsyncRead`/`AsyncWrite` traits used by ACP SDK | Already in `maestro-server/Cargo.toml` |
| `maestro-protocol` | 0.1.0 | Wire framing (`read_message`/`write_message`), all `ServerRequest`/`ServerResponse` types | Already in `maestro-server/Cargo.toml` |
| `serde_json` | 1 | JSON for `SessionNotification` payload serialization | Already in `maestro-server/Cargo.toml` |
| `async-trait` | 0.1 | Implementing `Client` trait with `#[async_trait::async_trait(?Send)]` | Already in `maestro-server/Cargo.toml` |

**No new dependencies needed.** All required crates are already declared in `maestro-server/Cargo.toml`.

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `tokio::sync::oneshot` | (in tokio) | Single-use channel for permission request/response correlation | One channel per pending `request_permission` call |
| `tokio::sync::Mutex` | (in tokio) | Non-blocking async mutex for shared session/permission maps | Prefer over `std::sync::Mutex` since guards cross `.await` points inside callbacks |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `oneshot` for permission pausing | `tokio::sync::watch` | `watch` requires `Send`; `oneshot::Receiver` is `!Send` OK here since we're in `LocalSet`. `oneshot` is simpler semantics for single-response |
| `tokio::sync::Mutex` for sessions | `std::sync::Mutex` | Session map is accessed inside async functions; `std::sync::MutexGuard` cannot be held across `.await` — use `tokio::sync::Mutex` |
| Serialize `SessionNotification` raw | Convert to typed `SessionUpdate` struct | Phase 42 uses `serde_json::to_value(&notification)` to serialize the full ACP `SessionNotification` as the `payload` field of `maestro_protocol::SessionUpdate`. This preserves all ACP schema fields transparently without needing to translate each `SessionUpdate` variant |

---

## Architecture Patterns

### System Architecture Diagram

```
stdin (piped from Tauri subprocess)
    |
    v
[read_loop: tokio::io::stdin()]
    |
    +-- ServerRequest::Spawn(SpawnRequest) ──────────────────────────+
    |       agent_id, session_id, cwd                                |
    |                                                                 v
    |                                               spawn_agent_subprocess(agent_id)
    |                                                   tokio::process::Command
    |                                               compat() stdin/stdout
    |                                               ClientSideConnection::new(
    |                                                   MaestroServerClient { stdout_tx, perms },
    |                                                   outgoing,
    |                                                   incoming,
    |                                                   |fut| spawn_local(fut)
    |                                               )
    |                                               conn.initialize(...)
    |                                               conn.new_session(NewSessionRequest { cwd })
    |                                               sessions.insert(session_id, conn)
    |                                               write_message(stdout, SpawnOk)
    |
    +-- ServerRequest::Prompt(PromptRequest) ────────────────────────+
    |       session_id, content                                       |
    |                                                                 v
    |                                               sessions[session_id].conn
    |                                               conn.prompt(PromptRequest::new(
    |                                                   acp_session_id, vec![content]
    |                                               ))
    |                                               // response comes via session_notification
    |
    +-- ServerRequest::Cancel(CancelRequest) ────────────────────────+
    |       session_id                                                |
    |                                                                 v
    |                                               sessions.remove(session_id) // drops conn
    |
    +-- ServerRequest::PermitResponse(PermissionResponse) ──────────+
            session_id, request_id, allowed                          |
                                                                     v
                                            perms[request_id].send(outcome)
                                            // unblocks awaiting request_permission future

MaestroServerClient callbacks → write to stdout:
    session_notification(args: SessionNotification)
        -> write_message(stdout, Response(SessionUpdate {
               session_id, payload: serde_json::to_value(args)?
           }))

    create_terminal(args: CreateTerminalRequest)
        -> spawn PTY subprocess (tokio::process::Command)
        -> store TerminalHandle in session terminal_map[terminal_id]
        -> spawn_local: read loop → write_message(stdout, TerminalOutput { bytes })
        -> return CreateTerminalResponse { terminal_id }

    terminal_output(args: TerminalOutputRequest)
        -> session.terminal_map[terminal_id].accumulated_output.clone()
        -> return TerminalOutputResponse { output, truncated }

    request_permission(args: RequestPermissionRequest)
        -> let (tx, rx) = oneshot::channel()
        -> perms.insert(request_id, tx)
        -> write_message(stdout, Response(PermissionRequest { session_id, request_id, payload }))
        -> outcome = rx.await  // BLOCKS until PermitResponse arrives on stdin
        -> return RequestPermissionResponse { outcome }
```

### Recommended Project Structure

```
maestro-server/
└── src/
    ├── main.rs          # tokio current_thread entry; read_loop; stdin dispatch
    ├── client.rs        # MaestroServerClient struct: Client trait impl
    ├── sessions.rs      # ActiveSession, SessionMap, TerminalHandle types
    └── agent.rs         # spawn_agent_subprocess helper
```

### Pattern 1: `MaestroServerClient` — Passing Stdout and Permissions to Client Callbacks

**What:** The `Client` trait implementation needs access to stdout (to write `ServerResponse` frames) and the permission channel map (to register and resolve permission futures). Both must be shareable by reference inside `!Send` callbacks.

**When to use:** Every `MaestroServerClient` instance — one per spawned ACP session.

**The `!Send` constraint applies:** Because `Client` is `?Send`, `MaestroServerClient` does NOT need to be `Send`. It can use `Rc<RefCell<...>>` for internal mutable state. However, the stdout writer must be shared with the outer read loop — use `tokio::sync::Mutex<tokio::io::Stdout>` wrapped in `Rc<...>` since we're single-threaded.

```rust
// maestro-server/src/client.rs
// Source: adapted from ACP SDK examples/client.rs [VERIFIED: local registry cache]
use std::rc::Rc;
use std::cell::RefCell;
use std::collections::HashMap;
use tokio::sync::{oneshot, Mutex};
use tokio::io::AsyncWriteExt;
use maestro_protocol::{ServerResponse, SessionUpdate, PermissionRequest, TerminalOutput, write_message};
use agent_client_protocol as acp;

pub type PermissionSender = oneshot::Sender<acp::RequestPermissionResponse>;

pub struct MaestroServerClient {
    /// Shared stdout writer — wrapped in Rc (not Arc) because Client is !Send
    pub stdout: Rc<Mutex<tokio::io::Stdout>>,
    /// Map from request_id → oneshot sender; resolved when PermitResponse arrives on stdin
    pub pending_permissions: Rc<RefCell<HashMap<String, PermissionSender>>>,
}

#[async_trait::async_trait(?Send)]
impl acp::Client for MaestroServerClient {
    async fn session_notification(
        &self,
        args: acp::SessionNotification,
    ) -> acp::Result<()> {
        let session_id = args.session_id.to_string();
        let payload = serde_json::to_value(&args)
            .map_err(|e| acp::Error::internal_error().with_message(e.to_string()))?;
        let msg = maestro_protocol::MaestroRpcMessage::Response(
            ServerResponse::SessionUpdate(SessionUpdate { session_id, payload })
        );
        let mut stdout = self.stdout.lock().await;
        let mut buf: Vec<u8> = Vec::new();
        write_message(&mut buf, &msg).await
            .map_err(|e| acp::Error::internal_error().with_message(e.to_string()))?;
        stdout.write_all(&buf).await
            .map_err(|e| acp::Error::internal_error().with_message(e.to_string()))?;
        stdout.flush().await
            .map_err(|e| acp::Error::internal_error().with_message(e.to_string()))?;
        Ok(())
    }

    async fn request_permission(
        &self,
        args: acp::RequestPermissionRequest,
    ) -> acp::Result<acp::RequestPermissionResponse> {
        let session_id = args.session_id.to_string();
        // Use request's tool_call_id as the permission request_id for correlation
        let request_id = args.tool_call.tool_call_id.to_string();
        let payload = serde_json::to_value(&args)
            .map_err(|e| acp::Error::internal_error().with_message(e.to_string()))?;

        let (tx, rx) = oneshot::channel();
        self.pending_permissions.borrow_mut().insert(request_id.clone(), tx);

        // Write PermissionRequest frame to stdout
        let msg = maestro_protocol::MaestroRpcMessage::Response(
            ServerResponse::PermissionRequest(PermissionRequest {
                session_id,
                request_id,
                payload,
            })
        );
        let mut stdout = self.stdout.lock().await;
        let mut buf: Vec<u8> = Vec::new();
        write_message(&mut buf, &msg).await
            .map_err(|e| acp::Error::internal_error().with_message(e.to_string()))?;
        stdout.write_all(&buf).await
            .map_err(|e| acp::Error::internal_error().with_message(e.to_string()))?;
        stdout.flush().await
            .map_err(|e| acp::Error::internal_error().with_message(e.to_string()))?;
        drop(stdout); // CRITICAL: release lock before awaiting

        // Block until PermitResponse arrives on stdin and resolves this oneshot
        rx.await.map_err(|_| acp::Error::internal_error().with_message("permission channel closed"))
    }

    async fn create_terminal(
        &self,
        args: acp::CreateTerminalRequest,
    ) -> acp::Result<acp::CreateTerminalResponse> {
        // Phase 42 implementation: spawn subprocess via tokio::process::Command
        // Store output accumulator in session terminal_map
        // Start background reader task that writes TerminalOutput frames to stdout
        // Return CreateTerminalResponse { terminal_id: generated_uuid }
        Err(acp::Error::method_not_found())  // replace in implementation
    }

    // terminal_output, release_terminal, kill_terminal, wait_for_terminal_exit:
    // all delegate to session's terminal_map entries
    // See Pattern 3 below
}
```

### Pattern 2: Main Loop — Stdin Read + Session Dispatch

**What:** The `main` function owns the stdin reader and a map of active sessions. Messages are read one by one and dispatched.

**When to use:** `maestro-server/src/main.rs` — the binary's entry point.

```rust
// maestro-server/src/main.rs
// Source: adapted from ACP SDK examples/client.rs [VERIFIED: local registry cache]
use std::rc::Rc;
use std::cell::RefCell;
use std::collections::HashMap;
use tokio_util::compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt};
use maestro_protocol::{read_message, write_message, ServerRequest, ServerResponse, SpawnResponse, MaestroRpcMessage};
use agent_client_protocol as acp;

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let local = tokio::task::LocalSet::new();
    local.run_until(async {
        let stdout = Rc::new(tokio::sync::Mutex::new(tokio::io::stdout()));
        let mut stdin = tokio::io::stdin();
        // session_id → (ClientSideConnection, MaestroServerClient Rc references)
        let mut sessions: HashMap<String, acp::ClientSideConnection> = HashMap::new();

        loop {
            let msg = read_message(&mut stdin).await?;
            match msg {
                MaestroRpcMessage::Request(ServerRequest::Spawn(req)) => {
                    // spawn_agent subprocess + build ClientSideConnection
                    // store in sessions map
                    // write SpawnOk to stdout
                }
                MaestroRpcMessage::Request(ServerRequest::Prompt(req)) => {
                    if let Some(conn) = sessions.get(&req.session_id) {
                        // conn.prompt(...).await — note: response arrives via session_notification
                    }
                }
                MaestroRpcMessage::Request(ServerRequest::Cancel(req)) => {
                    sessions.remove(&req.session_id);
                }
                MaestroRpcMessage::Request(ServerRequest::PermitResponse(perm_resp)) => {
                    // look up pending_permissions by session_id + request_id
                    // send on the oneshot channel to unblock request_permission future
                }
                _ => {
                    // Unexpected direction — ignore
                }
            }
        }
    }).await
}
```

**Critical note:** `maestro-protocol::ServerRequest` currently has only `Spawn`, `Prompt`, `Cancel`. A new `PermitResponse(PermissionResponse)` variant must be added to handle `ServerRequest` from the Tauri host unblocking permission requests. This is required for SERVER-04.

### Pattern 3: Terminal Management (SERVER-03)

**What:** The ACP terminal model is **pull-based**: the agent calls `create_terminal` to start a command, accumulates output in the client, then calls `terminal/output` to poll it. Maestro also **pushes** raw bytes to stdout as `ServerResponse::TerminalOutput` frames so the Tauri host can stream them to the xterm.js terminal.

**Key insight:** There are two parallel streams for terminals:
1. **Pull path (ACP protocol):** `create_terminal` → agent polls `terminal/output` → `release_terminal`
2. **Push path (maestro-server → Tauri):** `create_terminal` spawns a background read task that streams raw bytes as `ServerResponse::TerminalOutput` to stdout immediately

```rust
// session.rs — TerminalHandle for a single managed terminal
pub struct TerminalHandle {
    /// Accumulated output for ACP terminal/output polling
    pub output_buf: Rc<RefCell<String>>,
    /// Kill switch for the PTY subprocess
    pub kill_tx: tokio::sync::oneshot::Sender<()>,
}
```

```rust
// client.rs — create_terminal impl
async fn create_terminal(&self, args: acp::CreateTerminalRequest) -> acp::Result<acp::CreateTerminalResponse> {
    let terminal_id = format!("term-{}", uuid_v4_like());
    let output_buf: Rc<RefCell<String>> = Rc::new(RefCell::new(String::new()));
    let (kill_tx, mut kill_rx) = tokio::sync::oneshot::channel::<()>();

    let mut child = tokio::process::Command::new(&args.command)
        .args(&args.args)
        .current_dir(args.cwd.as_deref().unwrap_or(Path::new(".")))
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| acp::Error::internal_error().with_message(e.to_string()))?;

    let stdout_pipe = child.stdout.take().unwrap();
    let stdout_clone = Rc::clone(&self.stdout);
    let buf_clone = Rc::clone(&output_buf);
    let session_id = // captured from session context
    let terminal_id_clone = terminal_id.clone();

    // Background task: read PTY output, accumulate, push to maestro-server stdout
    tokio::task::spawn_local(async move {
        use tokio::io::AsyncBufReadExt;
        let mut reader = tokio::io::BufReader::new(stdout_pipe);
        let mut line = String::new();
        loop {
            tokio::select! {
                result = reader.read_line(&mut line) => {
                    if result.unwrap_or(0) == 0 { break; }
                    // Accumulate for ACP terminal/output poll
                    buf_clone.borrow_mut().push_str(&line);
                    // Push raw bytes frame to Tauri host
                    let frame = MaestroRpcMessage::Response(ServerResponse::TerminalOutput(
                        maestro_protocol::TerminalOutput {
                            session_id: session_id.clone(),
                            terminal_id: terminal_id_clone.clone(),
                            bytes: line.as_bytes().to_vec(),
                        }
                    ));
                    let mut buf: Vec<u8> = Vec::new();
                    let _ = write_message(&mut buf, &frame).await;
                    let mut out = stdout_clone.lock().await;
                    let _ = out.write_all(&buf).await;
                    let _ = out.flush().await;
                    line.clear();
                }
                _ = &mut kill_rx => break,
            }
        }
    });

    // Store TerminalHandle
    self.terminal_map.borrow_mut().insert(terminal_id.clone(), TerminalHandle { output_buf, kill_tx });

    Ok(acp::CreateTerminalResponse::new(terminal_id))
}
```

### Pattern 4: `ServerRequest::PermitResponse` — New Protocol Message Variant

**What:** The current `maestro-protocol` `ServerRequest` enum does not include a variant for permission responses from Tauri → maestro-server. Phase 42 must add it.

**Required change in `maestro-protocol/src/lib.rs`:**

```rust
// BEFORE (Phase 41):
pub enum ServerRequest {
    Spawn(SpawnRequest),
    Prompt(PromptRequest),
    Cancel(CancelRequest),
}

// AFTER (Phase 42):
pub enum ServerRequest {
    Spawn(SpawnRequest),
    Prompt(PromptRequest),
    Cancel(CancelRequest),
    PermitResponse(PermissionResponse),  // NEW: unblocks pending request_permission
}
```

`PermissionResponse` is already defined in `maestro-protocol`. This addition extends the existing enum and maintains backward compatibility with Phase 41 tests (existing variants unchanged).

### Anti-Patterns to Avoid

- **Holding `tokio::sync::MutexGuard` across `.await` points:** The stdout mutex must be locked, the write performed, and the guard dropped before any async call that could re-enter the client. Pattern 1 shows `drop(stdout)` before `rx.await`.
- **Using `Arc<Mutex<...>>` when `Rc<...>` suffices:** Since all ACP client futures run in `LocalSet` on a single thread, `Rc<RefCell<...>>` is correct and cheaper. `Arc` adds unnecessary atomic overhead and misleadingly implies multi-thread access.
- **Buffering all terminal output before flushing:** Each line/chunk must be written and flushed immediately. The Tauri host blocks until the frame arrives; buffering adds latency to the terminal display.
- **Spawning `tokio::spawn` for ACP futures:** All futures involving `MaestroServerClient` must use `tokio::task::spawn_local`. `tokio::spawn` requires `Send + 'static`.
- **Missing `stdout.flush()` after `write_all`:** `tokio::io::Stdout` is buffered. Missing `flush()` means the Tauri host never receives the frame. Every `write_message` call to stdout must be followed by `flush()`.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| ACP JSON-RPC message framing | Custom framing | `maestro_protocol::read_message` / `write_message` | Already implemented and tested with 12 passing tests in Phase 41 |
| ACP session lifecycle (initialize/new_session/prompt) | Manual JSON construction | `acp::ClientSideConnection` methods | SDK handles request/response correlation, error propagation, all ACP method names |
| futures/tokio I/O bridging | Manual wrapper types | `TokioAsyncReadCompatExt` / `TokioAsyncWriteCompatExt` | Already in Cargo.toml — one method call |
| Request ID generation | UUID library | Simple counter or session-scoped string | No external dep needed; `format!("perm-{}", counter)` is sufficient for correlation |
| Agent subprocess management | pid tracking, signal handling | `tokio::process::Command` with `kill_on_drop(true)` | `kill_on_drop(true)` ensures cleanup when `Child` is dropped on session cancel |

**Key insight:** The ACP SDK handles the entire JSON-RPC layer. Maestro's job is to implement the `Client` trait callbacks and bridge them to the maestro-protocol wire format.

---

## Common Pitfalls

### Pitfall 1: Stdout Lock Held Across `.await` in `request_permission`

**What goes wrong:** `request_permission` locks stdout, writes the `PermissionRequest` frame, then awaits `rx.await`. If the lock is held during `rx.await`, no other callback can write to stdout — the session update loop and terminal output tasks deadlock waiting for the stdout lock.

**Why it happens:** `tokio::sync::MutexGuard` is `!Send` but is held across an async yield point.

**How to avoid:** Explicitly `drop(stdout_guard)` before calling `rx.await`. See Pattern 1 — `drop(stdout)` is called before `rx.await`.

**Warning signs:** Program hangs after a permission request arrives; no further output frames are written.

### Pitfall 2: `tokio::io::stdin()` and `tokio::io::stdout()` Must Be Created Inside the Runtime

**What goes wrong:** `tokio::io::stdin()` / `tokio::io::stdout()` panics if called outside a Tokio runtime context.

**Why it happens:** They internally register with the Tokio reactor.

**How to avoid:** Create them inside the `local.run_until(async { ... })` closure, not in `main()` before the runtime starts.

**Warning signs:** Panic: "there is no reactor running, must be called from the context of a Tokio runtime"

### Pitfall 3: `MaestroRpcMessage::Request(ServerRequest::PermitResponse(...))` Requires Protocol Extension

**What goes wrong:** The stdin read loop receives a `PermitResponse` from Tauri, but `maestro-protocol::ServerRequest` has no `PermitResponse` variant in Phase 41. `serde_json::from_slice` returns `Err("unknown variant PermitResponse")`.

**Why it happens:** `maestro-protocol` was designed in Phase 41 with only `Spawn`, `Prompt`, `Cancel` variants. The permission response path was deferred.

**How to avoid:** Add `PermitResponse(PermissionResponse)` to `ServerRequest` in `maestro-protocol/src/lib.rs` as the first task of Phase 42. Update the serde roundtrip tests to cover the new variant.

**Warning signs:** `serde_json` deserialization error on stdin; permission requests never unblock.

### Pitfall 4: Agent Subprocess `cwd` Must Exist on Disk

**What goes wrong:** `tokio::process::Command::new(...).current_dir(cwd).spawn()` returns `Err(No such file or directory)` if the `cwd` from `SpawnRequest` does not exist on the server machine.

**Why it happens:** `SpawnRequest.cwd` is resolved client-side (Tauri host) and sent as an absolute path. If the worktree hasn't been created on the server host, the path is invalid.

**How to avoid:** Check `tokio::fs::metadata(cwd).await.is_ok()` before spawning; return `ServerResponse::Error` with a descriptive message if the path doesn't exist.

**Warning signs:** `spawn()` fails; `SpawnOk` never arrives at Tauri host.

### Pitfall 5: ACP `ClientSideConnection` Is NOT `Clone`

**What goes wrong:** Storing `ClientSideConnection` in a `HashMap<String, ClientSideConnection>` and then trying to call methods on it while also holding a mutable reference to the map (e.g., to add another session) causes borrow checker errors.

**Why it happens:** `ClientSideConnection` doesn't implement `Clone`. The session map must be accessed immutably for method calls.

**How to avoid:** Use entry API carefully; prefer `Rc<RefCell<HashMap<...>>>` for the session map so the connection can be accessed inside `spawn_local` closures without conflicting borrows. Or use an index-based approach (session_id → position in a `Vec`).

**Warning signs:** Compiler error: "cannot borrow `sessions` as mutable because it is also borrowed as immutable"

### Pitfall 6: ACP `initialize()` and `new_session()` Are Separate Calls

**What goes wrong:** Calling `conn.prompt(...)` before `conn.initialize(...)` and `conn.new_session(...)` returns an ACP error `"not initialized"`.

**Why it happens:** ACP protocol requires capability negotiation (`initialize`) before session creation (`new_session`), and session creation before prompting.

**How to avoid:** On `ServerRequest::Spawn`, the sequence is:
1. Spawn agent subprocess
2. `ClientSideConnection::new(client, outgoing, incoming, spawn_local_fn)`
3. `spawn_local(handle_io)` — start the I/O loop
4. `conn.initialize(InitializeRequest::new(ProtocolVersion::V1).client_info(...)).await?`
5. `conn.new_session(NewSessionRequest::new(cwd)).await?` — returns `NewSessionResponse { session_id }`
6. Store `session_id` (ACP's session ID) alongside connection
7. `write_message(stdout, SpawnOk { session_id: maestro_session_id })`

Note: `SpawnRequest.session_id` (maestro-protocol's session ID) is separate from the ACP `NewSessionResponse.session_id`. The server maps between them.

**Warning signs:** ACP error returned from `prompt()`; agent subprocess responds with method-not-found or protocol error.

---

## Code Examples

Verified patterns from official sources:

### Minimal `ClientSideConnection` Setup (from SDK example)

```rust
// Source: agent-client-protocol-0.10.4/examples/client.rs [VERIFIED: local registry]
use tokio_util::compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt};
use agent_client_protocol as acp;

let mut child = tokio::process::Command::new(&agent_program)
    .args(&agent_args)
    .current_dir(&cwd)
    .stdin(std::process::Stdio::piped())
    .stdout(std::process::Stdio::piped())
    .kill_on_drop(true)  // ensures cleanup on Drop
    .spawn()?;

let outgoing = child.stdin.take().unwrap().compat_write();
let incoming = child.stdout.take().unwrap().compat();

let (conn, handle_io) = acp::ClientSideConnection::new(
    client,         // impl acp::Client
    outgoing,
    incoming,
    |fut| { tokio::task::spawn_local(fut); },  // MUST be spawn_local
);

// Start I/O task BEFORE calling initialize
tokio::task::spawn_local(handle_io);

// Capability negotiation
conn.initialize(
    acp::InitializeRequest::new(acp::ProtocolVersion::V1)
        .client_info(acp::Implementation::new("maestro-server", "0.1.0"))
).await?;

// Session creation
let new_session = conn.new_session(
    acp::NewSessionRequest::new(std::path::PathBuf::from(&cwd))
).await?;
let acp_session_id = new_session.session_id;
```

### Permission Response Dispatch (stdin loop side)

```rust
// When stdin loop receives ServerRequest::PermitResponse:
// Source: custom Maestro pattern
MaestroRpcMessage::Request(ServerRequest::PermitResponse(perm_resp)) => {
    // Look up the sender for this permission request
    if let Some(tx) = client.pending_permissions.borrow_mut().remove(&perm_resp.request_id) {
        let outcome = if perm_resp.allowed {
            acp::RequestPermissionOutcome::Selected(acp::SelectedPermissionOutcome {
                option_id: "allow_once".into(),
                meta: None,
            })
        } else {
            acp::RequestPermissionOutcome::Cancelled
        };
        let response = acp::RequestPermissionResponse::new(outcome);
        let _ = tx.send(response);
        // tx.send resolves the rx.await in request_permission()
    }
}
```

### Write Response Frame to Stdout (with flush)

```rust
// Pattern: write + flush; never omit flush
// Source: custom Maestro pattern based on Zed's remote transport
async fn send_response(
    stdout: &Rc<tokio::sync::Mutex<tokio::io::Stdout>>,
    msg: &MaestroRpcMessage,
) -> Result<(), Box<dyn std::error::Error>> {
    use tokio::io::AsyncWriteExt;
    let mut buf: Vec<u8> = Vec::new();
    maestro_protocol::write_message(&mut buf, msg).await?;
    let mut out = stdout.lock().await;
    out.write_all(&buf).await?;
    out.flush().await?;
    Ok(())
}
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Placeholder `main()` (Phase 41) | Real ACP message loop | This phase | Enables actual agent spawning |
| `ServerRequest` has 3 variants | `ServerRequest` gains `PermitResponse` | This phase | Required for SERVER-04 permission flow |
| `MaestroAcpClient` stubs return `Err(method_not_found)` (in `src-tauri`) | `MaestroServerClient` in `maestro-server` implements real callbacks | This phase | `MaestroAcpClient` in the Tauri app remains stub until Phase 43 |

**Important architectural note:** Phase 42 implements `MaestroAcpClient` specifically for the **server binary** (`maestro-server`). The `MaestroAcpClient` in `src-tauri/src/acp/client.rs` remains as a stub — it will be activated in Phase 43 for the local (non-SSH) ACP path. Phase 42 should add a new `MaestroServerClient` struct in `maestro-server/src/client.rs` rather than modifying the Tauri app's `MaestroAcpClient`.

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `PermissionResponse.request_id` correctly correlates with the `request_id` sent in `PermissionRequest` — the Tauri host echoes it back unmodified | Pitfall 3, Pattern 1 | Medium — if Tauri host uses a different ID scheme, the oneshot lookup fails and permission requests never unblock. Verify in Phase 43 when Tauri host is implemented |
| A2 | ACP agent subprocess launch command format: `npx @agentclientprotocol/claude-agent-acp` is the correct CLI invocation for claude-acp agent | Pattern 2 (spawn_agent_subprocess) | Low — registry `distribution.npx.package` is the canonical field. Phase 42 uses the command from `SpawnRequest.agent_id` which the Tauri host resolves from registry (Phase 45). Phase 42 just executes whatever command string it receives |
| A3 | `tokio::io::stdin()` in `current_thread` runtime reads from the actual process stdin without blocking the LocalSet event loop | Pattern 2 | Low — verified by ACP SDK `examples/client.rs` which uses identical pattern |
| A4 | Flushing `tokio::io::Stdout` after each frame is sufficient for the Tauri subprocess reader to receive it (no OS-level buffering) | Pattern 1, Anti-Patterns | Medium — subprocess pipe buffering is OS-dependent. Using line-buffered or unbuffered stdout mode may be needed. Tauri uses `BufReader::read_exact` on the length prefix so it waits for exactly 4 bytes — should be fine as long as flush() is called |

---

## Open Questions (RESOLVED)

1. **ACP `session_id` vs `maestro-session_id` mapping** (RESOLVED)
   - What we know: `SpawnRequest.session_id` is Maestro's ID; ACP `NewSessionResponse.session_id` is the ACP SDK's internal ID. `prompt()` takes the ACP session ID, not Maestro's.
   - Resolution: Store `HashMap<maestro_session_id, ActiveSession>` where `ActiveSession` holds the ACP `acp_session_id` returned by `new_session()`. `prompt()` uses the ACP ID; all `ServerResponse` frames use `maestro_session_id` for Tauri correlation. Implemented in `sessions.rs` as `ActiveSession.acp_session_id`.

2. **`PermitResponse` variant — extend `ServerRequest` or add new top-level type?** (RESOLVED)
   - What we know: Adding `PermitResponse(PermissionResponse)` to `ServerRequest` is the simplest path and keeps the framing uniform.
   - Resolution: Add `PermitResponse(PermissionResponse)` as a fourth variant on `ServerRequest`. The name is directionally consistent (it's a response to a server-originated permission request, but it's a request in the Tauri-to-server direction). The existing `PermissionResponse` struct is reused. Backward compatible with Phase 41 tests.

3. **Should `stdout` be locked per-frame or per-session?** (RESOLVED)
   - What we know: Multiple concurrent callbacks (session_notification, terminal reader tasks) will attempt to write to stdout simultaneously within `LocalSet`.
   - Resolution: Lock per `write_message` call (per-frame, not per-session). Since `LocalSet` is single-threaded, awaiting the `tokio::sync::Mutex` lock is cooperative, not contended. Short lock duration (serialize + write + flush per frame). Implemented as `send_response()` helper in `client.rs` that acquires and releases the lock per call.

---

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Rust / Cargo | `maestro-server` build | Yes | 1.94.0 | — |
| `agent-client-protocol` | ACP client impl | Yes (already in Cargo.lock) | 0.10.4 | — |
| `tokio-util` (compat) | stdio bridging | Yes (already in Cargo.lock) | 0.7.18 | — |
| `tokio` (full) | async runtime | Yes (already in Cargo.lock) | 1.x | — |
| ACP agent subprocess (e.g., `npx @agentclientprotocol/claude-agent-acp`) | Integration test | Not verified | — | Use mock agent for unit tests |

**Missing dependencies with no fallback:** None — all Rust build deps are available.

**Integration test note:** Testing `SpawnRequest` end-to-end requires an actual ACP agent available via `npx`. This is an environment concern for integration tests, not unit tests. Unit tests can use the mock/echo agent from the ACP SDK examples.

---

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | `cargo test` (Rust built-in) |
| Config file | None |
| Quick run command | `cargo test -p maestro-protocol && cargo build -p maestro-server` |
| Full suite command | `cargo test --workspace` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| SERVER-01 | `SpawnRequest` → agent subprocess spawned → `SpawnOk` returned | unit (mock agent) | `cargo test -p maestro-server` | Wave 0 |
| SERVER-02 | `session_notification` callback → `ServerResponse::SessionUpdate` written to stdout | unit | `cargo test -p maestro-server` | Wave 0 |
| SERVER-03 | `create_terminal` callback → `ServerResponse::TerminalOutput` frames emitted | unit | `cargo test -p maestro-server` | Wave 0 |
| SERVER-04 | `request_permission` blocks → `PermitResponse` on stdin → `request_permission` returns | unit | `cargo test -p maestro-server` | Wave 0 |
| PROTOCOL | `PermitResponse` variant added to `ServerRequest` roundtrips correctly | unit | `cargo test -p maestro-protocol` | Extend existing |

### Sampling Rate

- **Per task commit:** `cargo check --workspace`
- **Per wave merge:** `cargo test -p maestro-protocol && cargo build -p maestro-server`
- **Phase gate:** All success criteria pass; `cargo test --workspace` green

### Wave 0 Gaps

- [ ] `maestro-server/src/client.rs` — `MaestroServerClient` with real `Client` trait impl
- [ ] `maestro-server/src/sessions.rs` — `ActiveSession`, `SessionMap`, `TerminalHandle` types
- [ ] `maestro-server/src/agent.rs` — `spawn_agent_subprocess` helper
- [ ] `maestro-server/src/main.rs` — replace placeholder with real read loop
- [ ] `maestro-protocol/src/lib.rs` — add `PermitResponse(PermissionResponse)` to `ServerRequest` + roundtrip test
- [ ] `maestro-server/src/tests/` — unit tests for each SERVER-0x requirement

*(Existing `maestro-protocol` 12 tests continue to pass; no regressions)*

---

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | No (no auth in Phase 42; agent subprocess inherits server env) | — |
| V3 Session Management | Yes — session map keyed by `session_id` from untrusted stdin | Validate `session_id` exists in map before dispatching; return `ServerResponse::Error` for unknown IDs |
| V4 Access Control | Yes — `create_terminal` and `read/write_text_file` execute on server's filesystem | Phase 42 MUST sandbox `cwd` to the path from `SpawnRequest.cwd`; reject paths with `..` traversal |
| V5 Input Validation | Yes — all incoming JSON from stdin is untrusted | `read_message` already has 16 MB size guard; `serde_json` typed deserialization rejects invalid structure |
| V6 Cryptography | No (no crypto in Phase 42) | — |

### Known Threat Patterns for This Stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Malformed `SpawnRequest.cwd` with path traversal (`../../etc`) | Elevation of Privilege | Canonicalize path; verify it's under the expected project root before spawning agent |
| `agent_id` with shell injection characters in agent launch command | Tampering | Use `tokio::process::Command::new(program).args(args)` not shell strings; never pass `agent_id` to a shell |
| Session ID collision causing hijack of another session | Spoofing | Validate `session_id` uniqueness on insert; UUID format is sufficient |
| Unbounded terminal output accumulation exhausting memory | Denial of Service | Respect `CreateTerminalRequest.output_byte_limit`; trim from beginning when limit exceeded (per ACP spec) |
| Malicious agent subprocess writing oversized frames to maestro-server's stdin | Denial of Service | `maestro_protocol::read_message` already enforces 16 MB MAX_MESSAGE_SIZE guard [VERIFIED: maestro-protocol/src/lib.rs:5] |

---

## Sources

### Primary (HIGH confidence)

- `agent-client-protocol-0.10.4/src/client.rs` — `Client` trait definition with all method signatures [VERIFIED: local Cargo registry `/home/m306213/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/agent-client-protocol-0.10.4/src/client.rs`]
- `agent-client-protocol-0.10.4/src/lib.rs` — `ClientSideConnection::new()` signature, `AgentSideConnection`, `ClientSide`/`AgentSide` markers [VERIFIED: local Cargo registry]
- `agent-client-protocol-0.10.4/examples/client.rs` — Reference client implementation using `LocalSet`, `compat_write()`, `initialize()`, `new_session()`, `prompt()` [VERIFIED: local Cargo registry]
- `agent-client-protocol-schema-0.11.4/src/client.rs` — `SessionNotification`, `SessionUpdate` enum variants (AgentMessageChunk, ToolCall, ToolCallUpdate, Plan, etc.), `RequestPermissionRequest`, `RequestPermissionResponse`, `RequestPermissionOutcome`, `CreateTerminalRequest`, `TerminalOutputResponse` [VERIFIED: local Cargo registry]
- `maestro-protocol/src/lib.rs` — Current wire protocol types: `MaestroRpcMessage`, `ServerRequest` (Spawn/Prompt/Cancel), `ServerResponse` (SpawnOk/Error/SessionUpdate/PermissionRequest/TerminalOutput), `read_message`/`write_message`, 12 passing tests [VERIFIED: read file]
- `maestro-server/src/main.rs` — Phase 41 skeleton: `current_thread` + `LocalSet`, uses `MaestroRpcMessage` type [VERIFIED: read file]
- `maestro-server/Cargo.toml` — All required deps already present: `agent-client-protocol`, `tokio-util` with compat, `futures`, `async-trait` [VERIFIED: read file]
- `cargo test -p maestro-protocol` — 12 tests pass [VERIFIED: ran in session]
- `cargo check --workspace` — Clean compile [VERIFIED: ran in session]

### Secondary (MEDIUM confidence)

- `.planning/phases/41-acp-agent-selection-discovery-system/41-RESEARCH.md` — Phase 41 research: `!Send` constraint, `tokio-util` compat requirement, framing rationale (prior Maestro research, 2026-04-17)
- `.planning/phases/41-acp-agent-selection-discovery-system/41-CONTEXT.md` — Architecture locked decisions: Zed model, JSON-RPC framing, crate structure
- `.planning/research/acp-integration-study.md` — ACP protocol phased implementation strategy (2026-04-16)

### Tertiary (LOW confidence)

- None

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all crates already in Cargo.toml; no new deps needed; verified from local registry
- Architecture: HIGH — based on verified ACP SDK source + Phase 41 locked decisions + verified maestro-protocol types
- Pitfalls: HIGH — `!Send` + stdout flush + lock-before-await confirmed by SDK source code

**Research date:** 2026-04-17
**Valid until:** 2026-05-17 (ACP SDK 0.10.x; tokio 1.x; both stable)
