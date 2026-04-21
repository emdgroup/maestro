# Phase 41: ACP Agent Selection & Discovery System — Context

**Gathered:** 2026-04-17
**Status:** Ready for planning

<domain>
## Phase Boundary

Foundation only — no user-visible features. Add ACP (Agent Client Protocol) integration infrastructure to the Maestro codebase and scaffold the remote headless server binary. Sets up Phase 42 to wire sessions, SSH transport, and UI.

**Three new crates:**
1. `src-tauri/src/acp/` — ACP client module in the desktop app (module, not crate)
2. `maestro-server/` — standalone binary at repo root (the remote headless server)
3. `maestro-protocol/` — shared crate at repo root (wire protocol types shared by both)

Out of scope: SSH wiring, agent spawning, UI changes, agent selection UI, registry browsing.

</domain>

<decisions>
## Implementation Decisions

### Architecture: Zed Model (Remote ACP Server)

Follow the architecture studied in `acp-remote-transport-study.md` — the Zed headless server approach:

```
Local Maestro UI ←──SSH channel──→ maestro-server (remote binary)
                                         ↓
                                    ACP Agent (subprocess)
                                         ↓
                                    fs/ callbacks → remote filesystem
                                    terminal/ → remote PTY
```

- maestro-server runs on remote SSH host
- Spawns ACP agents as local subprocesses (from remote machine's perspective)
- Handles all `fs/` and `terminal/` callbacks locally — no filesystem roundtrips over SSH
- Forwards structured session updates to local Maestro over SSH channel

This sidesteps the filesystem mismatch problem (same pattern Zed uses).

### Wire Protocol: JSON-RPC over SSH Channel

Length-prefixed JSON-RPC messages over SSH exec channel.

- Format: JSON-RPC 2.0 (consistent with ACP's own protocol)
- Framing: length-prefixed envelopes (adapted from Zed's `remote/src/transport.rs` pattern)
- Replace Zed's protobuf with JSON — simpler, directly debuggable
- Types defined in `maestro-protocol/` shared crate

### Crate Structure

**`maestro-protocol/` (new Cargo crate at repo root):**
- `MaestroRpcMessage` enum — client↔server message variants
- `ServerRequest` / `ServerResponse` types — session lifecycle (spawn, prompt, cancel)
- `SessionUpdate` — streaming update forwarding (ACP `session/update` events)
- `PermissionRequest` / `PermissionResponse` — permission forwarding
- `TerminalOutput` — terminal byte chunk forwarding
- Wire protocol unit tests: serialize → deserialize roundtrip

**`src-tauri/src/acp/` (new module in desktop app):**
- `mod.rs` — public API
- `client.rs` — `MaestroAcpClient` struct implementing ACP `Client` trait (fs/, terminal/, permission callbacks)
- `session.rs` — `AcpSession`, `SessionState` types
- `registry.rs` — `AgentInfo`, `RegistryEntry` types + ACP registry fetch/cache
- `transport.rs` — wire protocol type re-exports, connection abstractions

**`maestro-server/` (new binary crate at repo root):**
- `src/main.rs` — entry point, message loop
- Implements ACP `Client` trait for remote execution context
- Receives `MaestroRpcMessage` from local Maestro, spawns ACP agents locally

### Done Criteria

Phase 41 is done when:
1. All three crates compile cleanly with no warnings
2. `maestro-protocol` has unit tests covering JSON-RPC serialization/deserialization roundtrip for all message types
3. `src-tauri/src/acp/` module is importable from `lib.rs` (wired into compilation graph, even if no IPC handlers yet)
4. `maestro-server` binary builds (`cargo build -p maestro-server`)

No SSH wiring, no agent spawning, no UI changes required for Phase 41.

### Zed Code Adaptation

Maestro is GPL-3.0 — direct Zed code reuse permitted.

**Fetch and adapt verbatim from Zed's GitHub:**

| Zed File | → Maestro Target | Adaptation |
|----------|-----------------|-----------|
| `crates/agent_servers/src/acp.rs` (~2563 LOC) | `src-tauri/src/acp/client.rs` | Strip `gpui` UI framework references. Replace with Tauri IPC event stubs (Phase 42 wires these). Keep `ClientDelegate` structure as `MaestroAcpClient`. ~60-70% reusable. |
| `crates/remote/src/transport.rs` (~300 LOC) | `maestro-protocol/src/` | Replace protobuf with JSON-RPC. Keep message framing pattern (length-prefixed). Keep `handle_rpc_messages_over_child_process_stdio` structure. |
| `crates/remote_server/src/server.rs` (~500 LOC) | `maestro-server/src/main.rs` | Strip LSP, git, project management, extension host. Keep server message loop and channel setup. Scope to agent-only execution. |

**What Maestro does NOT need from Zed:**
- Language servers / LSP
- Project/workspace management
- Git integration (Maestro handles locally)
- Extension host
- Debugging adapters

Maestro's remote agent server ≈ 10% of Zed's `remote_server` crate scope.

### Cross-Compilation Target

Primary: `x86_64-unknown-linux-gnu`

Build command: `cargo build -p maestro-server --target x86_64-unknown-linux-gnu`

Other targets (aarch64, musl) deferred to later phase when deployment mechanism is wired.

### Cargo Workspace Changes

Add to root `Cargo.toml` workspace members:
- `maestro-server`
- `maestro-protocol`

`src-tauri/Cargo.toml` gains:
- `agent-client-protocol = "0.10.4"` (Apache-2.0)
- `maestro-protocol = { path = "../maestro-protocol" }`

`maestro-server/Cargo.toml` gains:
- `agent-client-protocol`
- `maestro-protocol = { path = "../maestro-protocol" }`
- `tokio` (already in workspace)

### Claude's Discretion

- Exact message type field names and enum variants in `MaestroRpcMessage`
- Module visibility (`pub` vs `pub(crate)`)
- How much of Zed's `ClientDelegate` to stub vs implement in Phase 41

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### ACP Integration Strategy
- `.planning/research/acp-integration-study.md` — ACP protocol overview, phased implementation strategy, IPC handler design, schema changes, what Maestro gains vs PTY approach
- `.planning/research/acp-remote-transport-study.md` — Remote transport deep research: Zed architecture precedent, Zed code reusability analysis, Option A (Zed model) rationale, wire protocol options

### ACP Protocol & SDK
- `https://crates.io/crates/agent-client-protocol` — Rust SDK (v0.10.4). Fetch latest docs before implementing.
- `https://github.com/agentclientprotocol/rust-sdk` — SDK source for `ClientSideConnection::new()` signature and `Client` trait definition
- `https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json` — Live ACP registry (46+ agents, including claude-acp, gemini, copilot)

### Zed Source Files to Adapt (fetch directly)
- `https://github.com/zed-industries/zed/blob/main/crates/agent_servers/src/acp.rs` — `ClientDelegate` impl → `MaestroAcpClient`
- `https://github.com/zed-industries/zed/blob/main/crates/remote/src/transport.rs` — message framing → `maestro-protocol`
- `https://github.com/zed-industries/zed/blob/main/crates/remote_server/src/server.rs` — server loop → `maestro-server/src/main.rs`

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src-tauri/src/ssh/session.rs` (RemoteSshSession) — existing SSH session management; Phase 42 will extend this to send `MaestroRpcMessage` to maestro-server over SSH exec channel
- `src-tauri/src/process/pty.rs` + `remote.rs` — existing PTY execution; preserved as fallback path (ACP is additive, not replacement)
- `src-tauri/src/models/task.rs` — `model_override: Option<String>` field; will eventually be joined by `agent_id` field in a later phase (schema migration deferred)

### Established Patterns
- Result<T, String> for all IPC commands — `MaestroAcpClient` callbacks should return `Result<T, String>`
- No Rust logging (`println!`, `eprintln!`, `tracing::`) — ACP client impl follows this
- Tauri `Arc<AppState>` pattern — `AcpSession` state will eventually live in `AppState` (Phase 42)
- Direct imports (no barrel `index.ts`) — applies to frontend; Rust modules use direct `mod` declarations

### Integration Points
- `src-tauri/src/lib.rs` — add `mod acp;` to wire in the ACP module
- Root `Cargo.toml` — add `maestro-server` and `maestro-protocol` to `[workspace] members`
- `src-tauri/src/db/schema.rs` — schema changes deferred (acp_sessions, agent_registry_cache tables come in Phase 42)

</code_context>

<specifics>
## Specific Ideas

- Wire protocol framing: follow Zed's `handle_rpc_messages_over_child_process_stdio` pattern from `transport.rs` — length-prefixed JSON-RPC envelopes, not raw newline-delimited. Handles large messages with embedded newlines safely.
- ACP registry fetch: `cdn.agentclientprotocol.com/registry/v1/latest/registry.json` — deserialize into `Vec<AgentInfo>`, cache in memory. Phase 41 just defines the types; Phase 42 adds the IPC command.
- maestro-server message loop: adapted from Zed's `remote_server/src/server.rs` — receive from stdin (or SSH channel in Phase 42), dispatch to local agent runners.

</specifics>

<deferred>
## Deferred Ideas

- SSH transport wiring (connect maestro-server over SSH exec channel) — Phase 42
- Binary deployment to remote host (SFTP upload, version check, chmod) — Phase 42
- AgentSelector UI component (dropdown from ACP registry) — Phase 42 or later
- `agent_id` field in tasks DB schema (migration) — Phase 42
- acp_sessions table in SQLite — Phase 42
- aarch64, musl cross-compilation targets — deployment phase
- IPC handlers (spawn_acp_session, list_available_agents) — Phase 42

</deferred>

---

*Phase: 41-acp-agent-selection-discovery-system*
*Context gathered: 2026-04-17*
