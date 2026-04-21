# Phase 41: ACP Agent Selection & Discovery System — Research

**Researched:** 2026-04-17
**Domain:** Rust multi-crate workspace, ACP Rust SDK integration, JSON-RPC wire protocol
**Confidence:** HIGH

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Architecture: Zed Model (Remote ACP Server)**
Follow Zed's headless server approach: maestro-server runs on remote SSH host, spawns ACP agents as local subprocesses, handles all `fs/` and `terminal/` callbacks locally, forwards structured session updates to local Maestro over SSH channel.

**Wire Protocol: JSON-RPC over SSH Channel**
Length-prefixed JSON-RPC messages over SSH exec channel. Format: JSON-RPC 2.0. Framing: length-prefixed envelopes adapted from Zed's `remote/src/transport.rs`. Replace Zed's protobuf with JSON. Types defined in `maestro-protocol/` shared crate.

**Crate Structure**
- `maestro-protocol/` — new Cargo crate at repo root (wire protocol types)
- `src-tauri/src/acp/` — new module in desktop app (ACP client)
- `maestro-server/` — new binary crate at repo root

**Done Criteria**
1. All three crates compile cleanly with no warnings
2. `maestro-protocol` has unit tests covering JSON-RPC serialization/deserialization roundtrip for all message types
3. `src-tauri/src/acp/` module is importable from `lib.rs`
4. `maestro-server` binary builds (`cargo build -p maestro-server`)

**No SSH wiring, no agent spawning, no UI changes in Phase 41.**

**Zed Code Adaptation**
Maestro is GPL-3.0 — direct Zed code reuse permitted.

| Zed File | Maestro Target | Adaptation |
|----------|---------------|------------|
| `crates/agent_servers/src/acp.rs` (~2563 LOC) | `src-tauri/src/acp/client.rs` | Strip `gpui`. Replace with Tauri IPC event stubs. ~60-70% reusable. |
| `crates/remote/src/transport.rs` (~300 LOC) | `maestro-protocol/src/` | Replace protobuf with JSON-RPC. Keep length-prefixed framing. |
| `crates/remote_server/src/server.rs` (~500 LOC) | `maestro-server/src/main.rs` | Strip LSP/project/git/extensions. Keep server message loop. |

**Cross-Compilation Target**
Primary: `x86_64-unknown-linux-gnu`. Build: `cargo build -p maestro-server --target x86_64-unknown-linux-gnu`.

**Cargo Workspace**
Add to root `Cargo.toml` workspace members: `maestro-server`, `maestro-protocol`.
`src-tauri/Cargo.toml` gains: `agent-client-protocol = "0.10.4"`, `maestro-protocol = { path = "../maestro-protocol" }`.

### Claude's Discretion

- Exact message type field names and enum variants in `MaestroRpcMessage`
- Module visibility (`pub` vs `pub(crate)`)
- How much of Zed's `ClientDelegate` to stub vs implement in Phase 41

### Deferred Ideas (OUT OF SCOPE)

- SSH transport wiring — Phase 42
- Binary deployment to remote host — Phase 42
- AgentSelector UI component — Phase 42 or later
- `agent_id` field in tasks DB schema (migration) — Phase 42
- `acp_sessions` table in SQLite — Phase 42
- aarch64, musl cross-compilation targets — deployment phase
- IPC handlers (spawn_acp_session, list_available_agents) — Phase 42
</user_constraints>

---

## Summary

Phase 41 is a pure Rust infrastructure phase — no user-visible features. It establishes three new compilation units: a shared protocol crate (`maestro-protocol`), a standalone remote server binary (`maestro-server`), and a new `acp` module inside the existing Tauri app. The work is scaffolding and type definitions, with one meaningful test deliverable: JSON-RPC serialization roundtrips in `maestro-protocol`.

The ACP Rust SDK (`agent-client-protocol` v0.10.4, published 2026-03-31) is stable and well-suited to this purpose. The key technical challenge is the workspace root migration: there is currently no root-level `Cargo.toml` in the maestro repo. Phase 41 must create one, which causes `Cargo.lock` to migrate from `src-tauri/Cargo.lock` to the repo root. This is a one-time structural change with a clear execution path.

The `Client` trait from the ACP SDK is `#[async_trait::async_trait(?Send)]` — it is `!Send`. This means the `MaestroAcpClient` struct cannot be used with `tokio::spawn` (which requires `Send`). For Phase 41 (stubs only), this is not a runtime concern, but the planner must note it as a Phase 42 constraint. All ACP SDK I/O uses `futures::io` traits (not `tokio::io`), requiring `tokio-util` with the `compat` feature wherever `tokio::process::Command` stdio is wired in.

**Primary recommendation:** Create the workspace root first (Task 1), then add crates in dependency order: `maestro-protocol` (no external deps), `maestro-server` (depends on `maestro-protocol`), then `src-tauri/src/acp/` (depends on ACP SDK + `maestro-protocol`).

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Wire protocol type definitions | `maestro-protocol` crate | — | Shared by both sides of the SSH channel; must be in a standalone crate with no Tauri/UI deps |
| ACP `Client` trait implementation | `src-tauri/src/acp/client.rs` | — | The desktop app is the ACP client; responds to agent callbacks |
| Agent registry type structs | `src-tauri/src/acp/registry.rs` | — | Desktop fetches/caches registry; server doesn't need it |
| Remote agent execution context | `maestro-server/src/main.rs` | — | Server owns agent subprocess lifecycle + all `fs/terminal` callbacks |
| Session state tracking | `src-tauri/src/acp/session.rs` | — | Desktop-side session mirrors; Phase 42 adds AppState storage |
| Message framing (length-prefix) | `maestro-protocol/src/framing.rs` | — | Used by both desktop and server; belongs in shared crate |

---

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `agent-client-protocol` | 0.10.4 | ACP Rust SDK: `Client` trait, `ClientSideConnection`, all protocol types | Only official Rust SDK; 1.29M downloads; Apache-2.0 license; powers Zed editor [VERIFIED: crates.io 2026-03-31] |
| `serde` | 1 | JSON serialization for wire protocol types | Already in workspace; standard Rust serialization |
| `serde_json` | 1 | JSON encoding/decoding for `MaestroRpcMessage` | Already in workspace; standard JSON crate |
| `tokio` | 1 | Async runtime for `maestro-server` | Already in workspace (full features) |
| `async-trait` | 0.1 | Required to implement `Client` trait (which is `#[async_trait::async_trait(?Send)]`) | Already a transitive dep; needs to be explicit for implementors [VERIFIED: ACP SDK Cargo.toml] |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `tokio-util` | 0.7 (with `compat` feature) | Bridge `tokio::io::AsyncRead/Write` ↔ `futures::io::AsyncRead/Write` | Required when wiring `tokio::process::Command` stdio into `ClientSideConnection::new()` (Phase 42 for `maestro-server`; not strictly needed in Phase 41 stubs) |
| `futures` | 0.3 | `AsyncRead`/`AsyncWrite` traits used by ACP SDK | Pulled in transitively by `agent-client-protocol`; no explicit dep needed |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Length-prefix JSON framing | Newline-delimited JSON (NDJSON) | ACP itself uses NDJSON internally; Maestro's wire protocol uses length-prefix because it carries arbitrary JSON blobs (e.g., terminal output) that may contain embedded newlines |
| `async-trait` crate | Native async traits (Rust 1.75+) | ACP SDK uses `async-trait` with `?Send` bound; cannot drop without forking the SDK |
| Root workspace `Cargo.toml` | Add `[workspace]` to `src-tauri/Cargo.toml` | Root `Cargo.toml` is the Tauri-standard approach per official docs; `Cargo.lock` belongs at workspace root regardless of option chosen |

**Installation (new root-level `Cargo.toml`):**
```bash
# No npm/cargo install needed — workspace creation is a file edit
```

**Version verification:** [VERIFIED: crates.io 2026-04-17]
- `agent-client-protocol`: 0.10.4 (latest, published 2026-03-31)
- `tokio-util`: 0.7.18 (already in transitive lock)
- `async-broadcast`: 0.7.2 (already in transitive lock, pulled by ACP)
- `agent-client-protocol-schema`: 0.11.4 (pinned by ACP 0.10.4, exact version)

---

## Architecture Patterns

### System Architecture Diagram

```
maestro/                          ← repo root (new Cargo workspace)
├── Cargo.toml                    ← NEW: workspace root [workspace] members
├── Cargo.lock                    ← MOVED from src-tauri/Cargo.lock
│
├── maestro-protocol/             ← NEW crate (no external runtime deps)
│   └── src/
│       ├── lib.rs                ← MaestroRpcMessage enum, framing fns
│       └── (types)               ← ServerRequest, SessionUpdate, etc.
│
├── maestro-server/               ← NEW binary crate
│   └── src/
│       └── main.rs               ← tokio main, message loop stub
│
└── src-tauri/                    ← existing Tauri app (gains ACP module)
    └── src/
        ├── lib.rs                ← adds: mod acp;
        └── acp/                  ← NEW module (not a crate)
            ├── mod.rs
            ├── client.rs         ← MaestroAcpClient implements Client trait
            ├── session.rs        ← AcpSession, SessionState types
            ├── registry.rs       ← AgentInfo, RegistryEntry types
            └── transport.rs      ← re-exports, connection abstractions

Data flow (Phase 42 will activate):
  Tauri IPC handler
      ↓
  acp::MaestroAcpClient
      ↓ spawn subprocess
  ClientSideConnection::new(client, stdout.compat(), stdin.compat(), spawn_local)
      ↓ ACP JSON-RPC (newline-delimited)
  ACP Agent subprocess (e.g., npx @agentclientprotocol/claude-agent-acp)
      ↑ fs/read_text_file callback → read from worktree (Phase 42)
      ↑ terminal/create callback   → allocate PTY (Phase 42)
      ↑ session/update notification → Tauri event emit (Phase 42)

For REMOTE execution (Phase 42):
  Tauri IPC handler
      ↓ MaestroRpcMessage (length-prefixed JSON over SSH exec channel)
  maestro-server (on remote host)
      ↓
  ClientSideConnection::new(client, local_stdout.compat(), local_stdin.compat(), ...)
      ↓
  ACP Agent (local to remote host)
      ↑ fs/terminal callbacks handled natively on remote filesystem
      ↑ SessionUpdate forwarded back as MaestroRpcMessage to local Maestro
```

### Recommended Project Structure
```
maestro/
├── Cargo.toml                        # workspace root
├── Cargo.lock                        # (moved from src-tauri)
├── maestro-protocol/
│   ├── Cargo.toml
│   └── src/
│       └── lib.rs                    # all protocol types + framing
├── maestro-server/
│   ├── Cargo.toml
│   └── src/
│       └── main.rs
└── src-tauri/
    ├── Cargo.toml                    # gains ACP deps
    └── src/
        └── acp/
            ├── mod.rs
            ├── client.rs
            ├── session.rs
            ├── registry.rs
            └── transport.rs
```

### Pattern 1: Cargo Workspace Root with Tauri App as Member

**What:** Root-level `Cargo.toml` declares a workspace; `src-tauri`, `maestro-server`, `maestro-protocol` are all members.

**When to use:** When a Tauri project needs sibling Rust crates outside `src-tauri/`.

**Example:**
```toml
# maestro/Cargo.toml (NEW)
# Source: Tauri docs (https://github.com/tauri-apps/tauri-docs/blob/v2/src/content/docs/develop/Debug/rustrover.mdx)
[workspace]
members = [
    "src-tauri",
    "maestro-server",
    "maestro-protocol",
]
resolver = "2"
```

```toml
# maestro/maestro-protocol/Cargo.toml (NEW)
[package]
name = "maestro-protocol"
version = "0.1.0"
edition = "2021"

[dependencies]
serde = { version = "1", features = ["derive"] }
serde_json = "1"

[dev-dependencies]
# No additional dev deps needed for roundtrip tests
```

```toml
# maestro/maestro-server/Cargo.toml (NEW)
[package]
name = "maestro-server"
version = "0.1.0"
edition = "2021"

[[bin]]
name = "maestro-server"
path = "src/main.rs"

[dependencies]
maestro-protocol = { path = "../maestro-protocol" }
agent-client-protocol = "0.10.4"
tokio = { version = "1", features = ["full"] }
tokio-util = { version = "0.7", features = ["compat"] }
serde_json = "1"
async-trait = "0.1"
futures = "0.3"
```

### Pattern 2: ACP `Client` Trait Implementation (Stub for Phase 41)

**What:** `MaestroAcpClient` struct with skeleton implementations returning `Err(Error::method_not_found())`.

**When to use:** Phase 41 scaffolding — stubs compile cleanly; Phase 42 fills them in.

**Example:**
```rust
// Source: https://context7.com/agentclientprotocol/rust-sdk/llms.txt
// (adapted — method_not_found() is the SDK default for optional methods)

use agent_client_protocol::{self as acp, Client};

/// Maestro's ACP client implementation.
/// Handles agent callbacks: filesystem, terminal, permissions.
/// Phase 42 wires these to Tauri IPC events.
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
    // All other methods (read_text_file, write_text_file, create_terminal, etc.)
    // inherit default impl which returns Err(Error::method_not_found())
}
```

### Pattern 3: Length-Prefixed JSON Framing (maestro-protocol)

**What:** Wire framing for `MaestroRpcMessage` over SSH channel. 4-byte little-endian length prefix followed by `serde_json` bytes.

**When to use:** Every message sent between local Maestro and `maestro-server`.

**Example:**
```rust
// Source: Adapted from Zed's crates/remote/src/protocol.rs (GPL-3.0, direct reuse permitted)
// Zed uses protobuf Envelope; Maestro replaces with serde_json bytes

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use crate::MaestroRpcMessage;

pub const MSG_LEN_SIZE: usize = 4;

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

pub async fn read_message<R: AsyncRead + Unpin>(
    stream: &mut R,
) -> Result<MaestroRpcMessage, Box<dyn std::error::Error>> {
    let mut len_buf = [0u8; MSG_LEN_SIZE];
    stream.read_exact(&mut len_buf).await?;
    let len = u32::from_le_bytes(len_buf) as usize;
    let mut body = vec![0u8; len];
    stream.read_exact(&mut body).await?;
    Ok(serde_json::from_slice(&body)?)
}
```

### Pattern 4: MaestroRpcMessage Enum

**What:** Discriminated union of all messages exchanged between local Maestro and `maestro-server`.

**Example:**
```rust
// maestro-protocol/src/lib.rs
use serde::{Deserialize, Serialize};

/// Messages sent Local → Remote (Maestro → maestro-server)
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerRequest {
    Spawn(SpawnRequest),
    Prompt(PromptRequest),
    Cancel(CancelRequest),
}

/// Messages sent Remote → Local (maestro-server → Maestro)
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerResponse {
    SpawnOk(SpawnResponse),
    Error(ErrorResponse),
    SessionUpdate(SessionUpdate),
    PermissionRequest(PermissionRequest),
    TerminalOutput(TerminalOutput),
}

/// Top-level envelope: either a client→server request or server→client response
#[derive(Debug, Serialize, Deserialize)]
#[serde(untagged)]
pub enum MaestroRpcMessage {
    Request(ServerRequest),
    Response(ServerResponse),
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SpawnRequest {
    pub agent_id: String,
    pub session_id: String,
    pub cwd: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SpawnResponse {
    pub session_id: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PromptRequest {
    pub session_id: String,
    pub content: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CancelRequest {
    pub session_id: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SessionUpdate {
    pub session_id: String,
    pub payload: serde_json::Value,  // Raw ACP session/update event
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PermissionRequest {
    pub session_id: String,
    pub request_id: String,
    pub payload: serde_json::Value,  // Raw ACP permission request
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PermissionResponse {
    pub session_id: String,
    pub request_id: String,
    pub allowed: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TerminalOutput {
    pub session_id: String,
    pub terminal_id: String,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ErrorResponse {
    pub message: String,
}
```

### Pattern 5: ACP Registry Types (registry.rs)

**What:** Typed structs matching the ACP registry JSON schema for deserializing agent metadata.

**Example:**
```rust
// src-tauri/src/acp/registry.rs
// Source: VERIFIED against https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AcpRegistry {
    pub version: String,
    pub agents: Vec<AgentInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentInfo {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: Option<String>,
    pub repository: Option<String>,
    pub authors: Option<Vec<String>>,
    pub license: Option<String>,
    pub icon: Option<String>,
    pub website: Option<String>,
    pub distribution: AgentDistribution,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AgentDistribution {
    pub npx: Option<NpxDistribution>,
    pub binary: Option<HashMap<String, BinaryTarget>>,
    pub uvx: Option<UvxDistribution>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NpxDistribution {
    pub package: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BinaryTarget {
    pub archive: String,
    pub cmd: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UvxDistribution {
    pub package: String,
}
```

### Anti-Patterns to Avoid

- **Putting registry fetch logic in Phase 41:** The `registry.rs` file in Phase 41 is TYPES ONLY (`AgentInfo`, `AcpRegistry` structs). The actual HTTP fetch (`reqwest`) and caching goes in Phase 42's IPC handler. Don't add `reqwest` to the `acp` module in Phase 41.
- **Using `tokio::spawn` with `MaestroAcpClient`:** The `Client` trait is `?Send` (uses `Rc` internally). Any code path that calls into ACP client methods must use `tokio::task::spawn_local` inside a `LocalSet`. In Phase 41 this is just a type-level concern — no runtime wiring yet.
- **Implementing `MaestroAcpClient` with `todo!()` panics:** Use `Err(acp::Error::method_not_found())` (the SDK default) for unimplemented fs/terminal methods. The required methods (`request_permission`, `session_notification`) should stub gracefully, not panic.
- **Forgetting to delete `src-tauri/Cargo.lock`:** When creating a root workspace Cargo.toml, cargo will regenerate `Cargo.lock` at the workspace root. The old `src-tauri/Cargo.lock` must be removed to avoid confusion.
- **Creating a `[workspace]` section inside `src-tauri/Cargo.toml`:** This would make `src-tauri` the workspace root with relative paths like `../maestro-server`. CONTEXT.md prescribes a root Cargo.toml instead (cleaner, standard Tauri multi-crate pattern per official docs).

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| ACP JSON-RPC protocol framing | Custom JSON-RPC parser | `agent-client-protocol` SDK `ClientSideConnection` | SDK handles all request/response correlation, subscriptions, error codes |
| Agent subprocess stdio management | Manual `process::Command` + buffer management | SDK's `ClientSideConnection::new(outgoing, incoming)` | SDK uses `futures::io::BufReader` with correct `read_line` semantics |
| Permission request/response lifecycle | Custom permission state machine | Implement `Client::request_permission` → SDK routes automatically | SDK handles correlation between permission request and response |
| Session update subscriptions | Manual event bus | `ClientSideConnection::subscribe()` → `StreamReceiver` | SDK provides typed subscription with broadcast semantics |

**Key insight:** The ACP SDK owns the entire JSON-RPC transport layer. Maestro only needs to implement the `Client` trait callbacks and call `ClientSideConnection::new(...)`. Everything else — message correlation, request IDs, error propagation — is the SDK's responsibility.

---

## Common Pitfalls

### Pitfall 1: `Client` trait is `!Send` — cannot use `tokio::spawn`

**What goes wrong:** Calling `tokio::spawn(async { client.session_notification(...).await })` fails to compile with "future cannot be sent between threads safely" because `MaestroAcpClient` holds `Rc<...>` via the ACP SDK internals.

**Why it happens:** The ACP SDK uses `#[async_trait::async_trait(?Send)]` — the `?Send` bound explicitly opts out of `Send`. Tauri's async command system uses `tokio::spawn` which requires `Send + 'static`.

**How to avoid:** For Phase 41, this is only a type concern (no runtime execution yet). For Phase 42, ACP client sessions must run in `tokio::task::LocalSet` with `spawn_local`. The `maestro-server` binary uses `#[tokio::main(flavor = "current_thread")]` which is a LocalSet context by default.

**Warning signs:** Compiler error: "future cannot be sent between threads safely... required by `tokio::spawn`"

### Pitfall 2: `futures::io` vs `tokio::io` trait mismatch

**What goes wrong:** Passing `tokio::process::Child` stdin/stdout directly to `ClientSideConnection::new()` fails because ACP SDK expects `futures::io::AsyncRead/AsyncWrite` but tokio provides `tokio::io::AsyncRead/AsyncWrite`.

**Why it happens:** ACP SDK is built on the `futures` crate I/O traits, not tokio's. These are different traits despite similar names.

**How to avoid:** Use `tokio_util::compat::TokioAsyncReadCompatExt` / `TokioAsyncWriteCompatExt` adapters:
```rust
use tokio_util::compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt};
let incoming = child.stdout.take().unwrap().compat();
let outgoing = child.stdin.take().unwrap().compat_write();
```
For Phase 41: just knowing this is required is enough. The `tokio-util = { version = "0.7", features = ["compat"] }` dep must be explicit (not just transitive).

**Warning signs:** Compiler error: "the trait `futures::io::AsyncRead` is not implemented for `tokio::process::ChildStdout`"

### Pitfall 3: `Cargo.lock` location after workspace root creation

**What goes wrong:** After adding `maestro/Cargo.toml` as workspace root, `cargo build` generates a NEW `Cargo.lock` at `maestro/Cargo.lock` while the old `src-tauri/Cargo.lock` still exists. Cargo may use the wrong one or warn about stale state.

**Why it happens:** Cargo stores `Cargo.lock` at the workspace root. Moving the workspace root changes where the lock file lives.

**How to avoid:** As part of the task that creates `maestro/Cargo.toml`:
1. Create `maestro/Cargo.toml` with `[workspace]`
2. Delete `src-tauri/Cargo.lock` (`git rm src-tauri/Cargo.lock`)
3. Run `cargo build -p maestro` to regenerate at workspace root
4. Commit `Cargo.lock` at repo root

**Warning signs:** `cargo: warning: ignoring src-tauri/Cargo.lock`

### Pitfall 4: `serde` tag strategy for `MaestroRpcMessage` variants

**What goes wrong:** Using `#[serde(untagged)]` on the top-level `MaestroRpcMessage` causes ambiguous deserialization when `ServerRequest` and `ServerResponse` share field names. Roundtrip tests fail with unexpected variant.

**Why it happens:** Untagged enums require all variants to be distinguishable by their content alone. If `SpawnOk` and `Spawn` both have a `session_id` field, serde picks the first match.

**How to avoid:** Use `#[serde(tag = "type", rename_all = "snake_case")]` on inner enums (`ServerRequest`, `ServerResponse`) and add a `direction` discriminant or separate the two into distinct message types with a wrapping `direction` field. Verify roundtrip tests pass for every variant.

**Warning signs:** Roundtrip test passes for request but deserialization returns wrong variant for response.

### Pitfall 5: `edition = "2024"` in new crates requires resolver = "2" or "3"

**What goes wrong:** Creating `maestro-protocol/Cargo.toml` with `edition = "2024"` in a workspace that uses the default resolver causes feature unification warnings or build failures.

**Why it happens:** Edition 2024 packages require `resolver = "2"` (or `"3"`) in the workspace root.

**How to avoid:** Use `edition = "2021"` for Phase 41 crates (consistent with `src-tauri`). If edition 2024 is desired later, add `resolver = "2"` to the workspace root first.

**Warning signs:** `error: edition 2024 requires resolver = "2" or resolver = "3"`

---

## Code Examples

Verified patterns from official sources:

### Minimal ACP `ClientSideConnection` setup (from SDK docs)
```rust
// Source: https://context7.com/agentclientprotocol/rust-sdk/llms.txt
// Note: for Phase 42 activation; Phase 41 stubs only
use agent_client_protocol::{self as acp, Agent as _};
use tokio_util::compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt};

let mut child = tokio::process::Command::new("./maestro-server")
    .stdin(std::process::Stdio::piped())
    .stdout(std::process::Stdio::piped())
    .kill_on_drop(true)
    .spawn()?;

let outgoing = child.stdin.take().unwrap().compat_write();
let incoming = child.stdout.take().unwrap().compat();

let client = MaestroAcpClient::new(/* tauri handles for event emission */);

let (conn, handle_io) = acp::ClientSideConnection::new(
    client,
    outgoing,
    incoming,
    |fut| tokio::task::spawn_local(fut),  // MUST use spawn_local, not spawn
);
tokio::task::spawn_local(handle_io);

let _init = conn.initialize(acp::InitializeRequest {
    protocol_version: acp::V1,
    client_capabilities: acp::ClientCapabilities::default(),
    client_info: Some(acp::Implementation {
        name: "maestro".into(),
        title: Some("Maestro".into()),
        version: "0.1.0".into(),
    }),
    meta: None,
}).await?;
```

### `maestro-server` binary skeleton
```rust
// maestro-server/src/main.rs — Phase 41 skeleton
// Server receives MaestroRpcMessage from stdin, responds on stdout
// Phase 42 activates agent spawning + ACP wiring
use maestro_protocol::MaestroRpcMessage;

#[tokio::main(flavor = "current_thread")]  // Required: LocalSet context for !Send ACP futures
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let local = tokio::task::LocalSet::new();
    local.run_until(async {
        // Phase 42: read MaestroRpcMessage from stdin (length-prefixed)
        // Phase 42: dispatch to local ACP agent via ClientSideConnection
        // Phase 41: just verify the binary compiles and links
        Ok::<(), Box<dyn std::error::Error>>(())
    }).await
}
```

### Serialization roundtrip test pattern (maestro-protocol)
```rust
// maestro-protocol/src/lib.rs
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_spawn_request() {
        let msg = MaestroRpcMessage::Request(ServerRequest::Spawn(SpawnRequest {
            agent_id: "claude-acp".to_string(),
            session_id: "sess-1".to_string(),
            cwd: "/home/user/project".to_string(),
        }));
        let serialized = serde_json::to_string(&msg).unwrap();
        let deserialized: MaestroRpcMessage = serde_json::from_str(&serialized).unwrap();
        // Verify discriminant round-trips correctly
        assert!(matches!(deserialized, MaestroRpcMessage::Request(ServerRequest::Spawn(_))));
    }

    #[test]
    fn roundtrip_session_update() {
        let msg = MaestroRpcMessage::Response(ServerResponse::SessionUpdate(SessionUpdate {
            session_id: "sess-1".to_string(),
            payload: serde_json::json!({"type": "agent_message_chunk"}),
        }));
        let serialized = serde_json::to_string(&msg).unwrap();
        let deserialized: MaestroRpcMessage = serde_json::from_str(&serialized).unwrap();
        assert!(matches!(
            deserialized,
            MaestroRpcMessage::Response(ServerResponse::SessionUpdate(_))
        ));
    }
}
```

---

## Runtime State Inventory

> This section is omitted: Phase 41 is greenfield infrastructure (new crates). No renaming, rebrand, or migration of existing runtime state occurs.

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| PTY raw bytes only | ACP structured JSON-RPC + PTY fallback | ACP SDK stable since 2025 | Enables structured tool call visibility, plan updates, permission control |
| Newline-delimited JSON (ACP wire) | Length-prefixed JSON (Maestro wire) | This phase | Handles embedded newlines in terminal output safely |
| Standalone `src-tauri/Cargo.toml` | Root workspace `Cargo.toml` | This phase | Enables sibling crates (`maestro-server`, `maestro-protocol`) |
| Protobuf (Zed's wire format) | Plain JSON (Maestro's wire format) | Design decision | Simpler, directly debuggable, no schema compilation step |

**Deprecated/outdated (not applicable here):**
- Streamable HTTP transport for ACP: Still draft (no spec, no SDK, no agents as of April 2026) — do not plan around it [VERIFIED: ACP registry 2026-04-17, all 27 agents stdio-only]

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Moving `Cargo.lock` from `src-tauri/` to repo root will not break `pnpm tauri dev` or `pnpm tauri build` | Standard Stack / Pitfall 3 | Low — Tauri CLI reads `tauri.conf.json` from `src-tauri/`; workspace root location is transparent to it. Confirmed by Tauri docs snippet showing root workspace pattern |
| A2 | `tokio::main(flavor = "current_thread")` is sufficient for `maestro-server` Phase 41 (no active async I/O in skeleton) | Code Examples | Negligible — Phase 41 server doesn't run real async work; the pattern matters more for Phase 42 |
| A3 | `edition = "2021"` for new crates is consistent with project convention | Standard Stack | Low — existing `src-tauri` uses edition 2021; no compelling reason for 2024 in Phase 41 |

**If this table is empty:** Not applicable — three low-risk assumptions documented above.

---

## Open Questions

1. **`MaestroRpcMessage` serde tag strategy**
   - What we know: `#[serde(tag = "type")]` on inner enums requires all variants to have the `type` field added; `#[serde(untagged)]` requires all variants to be content-distinguishable
   - What's unclear: Whether to model as a single `MaestroRpcMessage` with `Request`/`Response` variants, or as two separate enums (`ClientMessage`, `ServerMessage`) used directly
   - Recommendation: Claude's Discretion — use separate `ClientMessage`/`ServerMessage` enums with `#[serde(tag = "type")]` to avoid untagged ambiguity; simplifies roundtrip test assertions

2. **Whether `async-trait` needs to be an explicit dependency in `src-tauri/Cargo.toml`**
   - What we know: `async-trait` is a transitive dependency (already in lock file v0.1.89); implementing the `Client` trait requires the `#[async_trait::async_trait(?Send)]` attribute macro
   - What's unclear: Whether cargo auto-resolves the macro crate for implementors or requires explicit dep
   - Recommendation: Add `async-trait = "0.1"` as explicit dep to `src-tauri/Cargo.toml` — transitive deps are not guaranteed to be visible in all Rust editions

---

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Rust / Cargo | All crates | Yes | 1.94.0 | — |
| `x86_64-unknown-linux-gnu` target | `maestro-server` build | Yes (native host) | — | — |
| Node.js / npm | `pnpm tauri:gen` test | Yes | v22.19.0 | — |
| pnpm | Frontend build | Yes | 10.33.0 | — |
| `agent-client-protocol` crate | ACP client | Yes (crates.io) | 0.10.4 | — |

**Missing dependencies with no fallback:** None — all required build tools are available.

**Cross-compilation note:** The dev/test machine is `x86_64-unknown-linux-gnu` (Linux). The CONTEXT.md's primary build target `x86_64-unknown-linux-gnu` is the native host — **no cross-compilation toolchain needed** for Phase 41 builds and tests. [VERIFIED: `uname -m` = x86_64, `uname -s` = Linux]

---

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | `cargo test` (Rust built-in) |
| Config file | None (no `.cargo/config.toml`; tests embedded in modules) |
| Quick run command | `cd src-tauri && cargo test -p maestro-protocol` |
| Full suite command | `cd src-tauri && cargo test` (once workspace root exists: `cargo test --workspace`) |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| DONE-2 | `maestro-protocol` serializes/deserializes all `MaestroRpcMessage` variants | unit | `cargo test -p maestro-protocol` | Wave 0 |
| DONE-1 | All three crates compile without warnings | build check | `cargo build --workspace` | Wave 0 |
| DONE-3 | `mod acp;` importable from `lib.rs` | build check | `cd src-tauri && cargo check` | Wave 0 |
| DONE-4 | `maestro-server` binary builds | build check | `cargo build -p maestro-server` | Wave 0 |

### Sampling Rate
- **Per task commit:** `cargo check --workspace`
- **Per wave merge:** `cargo test -p maestro-protocol && cargo build --workspace`
- **Phase gate:** All four DONE criteria pass before `/gsd-verify-work`

### Wave 0 Gaps
- [ ] `maestro-protocol/src/lib.rs` — define `MaestroRpcMessage` + roundtrip tests for all variants (DONE-2)
- [ ] `maestro-server/src/main.rs` — minimal skeleton that compiles (DONE-4)
- [ ] `src-tauri/src/acp/mod.rs` + sub-files — stubs that compile (DONE-3)
- [ ] Root `Cargo.toml` workspace — prerequisite for all of the above (DONE-1)

---

## Security Domain

> `security_enforcement` is not set in config — treated as enabled.

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | No (Phase 41 has no runtime auth) | — |
| V3 Session Management | No (no session lifecycle in Phase 41) | — |
| V4 Access Control | No (no filesystem access in Phase 41 stubs) | — |
| V5 Input Validation | Yes — registry JSON deserialization | `serde_json` with typed structs (no raw string interpolation) |
| V6 Cryptography | No (no crypto in Phase 41) | — |

### Known Threat Patterns for This Stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Malformed registry JSON crashes process | Denial of Service | Wrap `serde_json::from_str` in `Result`; never `unwrap()` on external JSON |
| Overly large `MaestroRpcMessage` payload exhausts memory | Denial of Service | Add maximum message length check in `read_message` (e.g., reject if > 16 MB) before allocating `body` buffer |
| Path traversal in `fs/` callbacks | Elevation of Privilege | Out of scope for Phase 41 (stubs return `Err`); Phase 42 MUST sandbox all `fs/read_text_file` paths to worktree root |

**Phase 41 security posture:** Low risk — all `Client` trait methods return stubs; no file I/O, no network calls, no subprocess spawning in Phase 41 itself. Security surface expands significantly in Phase 42.

---

## Sources

### Primary (HIGH confidence)
- `/agentclientprotocol/rust-sdk` (Context7) — `Client` trait definition, `ClientSideConnection::new()` signature, `AgentSideConnection` example
- `https://raw.githubusercontent.com/agentclientprotocol/rust-sdk/refs/heads/main/src/agent-client-protocol/src/lib.rs` — confirmed `ClientSideConnection` struct and `new()` signature
- `https://raw.githubusercontent.com/agentclientprotocol/rust-sdk/refs/heads/main/src/agent-client-protocol/src/client.rs` — confirmed `Client` trait methods, `?Send` bound, default `method_not_found()` implementations
- `https://raw.githubusercontent.com/agentclientprotocol/rust-sdk/refs/heads/main/src/agent-client-protocol/src/rpc.rs` — confirmed newline-delimited JSON framing used internally by ACP SDK
- `https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json` — verified registry schema (27 agents, `version`/`agents`/`extensions` top-level keys, distribution types: `npx`/`binary`/`uvx`)
- `https://crates.io/api/v1/crates/agent-client-protocol` — version 0.10.4, published 2026-03-31, not yanked
- `https://crates.io/api/v1/crates/agent-client-protocol/0.10.4/dependencies` — confirmed `async-trait`, `futures`, `serde`, `serde_json` as normal deps; `tokio-util` as dev-dep only
- `/tauri-apps/tauri-docs` (Context7) — confirmed root-level `Cargo.toml` workspace is standard Tauri pattern
- `https://raw.githubusercontent.com/zed-industries/zed/main/crates/remote/src/protocol.rs` — length-prefixed framing pattern (u32 LE prefix + prost payload; Maestro replaces prost with serde_json)
- `https://raw.githubusercontent.com/zed-industries/zed/main/crates/agent_servers/src/acp.rs` (lines 1-100) — `AcpConnection` struct showing `ClientSideConnection`, sessions, tasks
- `cargo tree` on `src-tauri` — confirmed `tokio-util 0.7.18`, `async-trait 0.1.89`, `futures 0.3.32`, `derive_more 0.99.20` as transitive deps

### Secondary (MEDIUM confidence)
- `.planning/research/acp-integration-study.md` — ACP protocol overview, phased implementation strategy (prior Maestro research, 2026-04-16)
- `.planning/research/acp-remote-transport-study.md` — Zed architecture precedent, transport analysis, Option A rationale (prior Maestro research, 2026-04-17)

### Tertiary (LOW confidence)
- None

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all versions verified against crates.io and live ACP SDK source
- Architecture: HIGH — based on CONTEXT.md locked decisions + verified SDK API signatures
- Pitfalls: HIGH — `!Send` constraint confirmed by live SDK source; framing approach confirmed by Zed protocol.rs

**Research date:** 2026-04-17
**Valid until:** 2026-05-17 (stable; ACP 0.10.x is current; Tauri 2.x workspace pattern is stable)
