# ACP Remote Transport: Deep Research

**Date:** 2026-04-17
**Status:** Research complete, not yet planned for implementation
**Depends on:** acp-integration-study.md (base ACP research)

## 1. Current State of ACP Transport

### What's Stable: stdio Only

ACP has exactly **one stable transport**: stdio. Agent launched as subprocess, JSON-RPC messages over stdin/stdout, newline-delimited, UTF-8.

- Spec mandates: "Agents and clients SHOULD support stdio whenever possible"
- Messages MUST NOT contain embedded newlines
- Agent MUST NOT write non-ACP content to stdout
- Agent MAY log to stderr

All 46 agents in the ACP registry (as of April 2026) use stdio exclusively. No agent advertises HTTP, WebSocket, or any network transport.

### What's Draft: Streamable HTTP

The spec mentions "Streamable HTTP" as a draft proposal. Current status:
- **In discussion, not finalized**
- No specification text published
- No SDK implementation
- No agents support it
- No timeline for stabilization

### What's Missing

| Transport | Status | SDK Support | Agent Support |
|-----------|--------|-------------|---------------|
| stdio | Stable | Full (Rust, TS, Python, Java, Kotlin) | All 46 agents |
| Streamable HTTP | Draft | None | None |
| WebSocket | Not proposed | None | None |
| SSE | Not proposed | None | None |
| TCP/Unix socket | Not proposed | None | None |
| SSH | Not proposed | None | None |

### Custom Transport Escape Hatch

Spec says: "Agents and clients MAY implement additional custom transport mechanisms to suit their specific needs." Requirements:
1. Preserve JSON-RPC message format and lifecycle
2. Support bidirectional message exchange
3. Document connection patterns for interoperability

This is the door for SSH transport — explicitly permitted by spec.

### SDK Transport Architecture (Critical Finding)

The Rust SDK's transport layer is **already transport-agnostic** at the RPC level:

```rust
// ClientSideConnection::new() signature
pub fn new(
    handler: impl MessageHandler<Side> + 'static,
    outgoing_bytes: impl AsyncWrite,    // ← ANY async writer
    incoming_bytes: impl AsyncRead,     // ← ANY async reader
    spawn: impl Fn(LocalBoxFuture<'static, ()>)
) -> (Self, impl Future<Output = Result<()>>)
```

`RpcConnection` internally uses `BufReader` for line-based JSON-RPC parsing over generic `AsyncRead`/`AsyncWrite`. The `AcpAgent` struct in `agent-client-protocol-tokio` hardcodes subprocess stdio, but the core SDK accepts **any byte stream**.

This means: SSH channel → `AsyncRead`/`AsyncWrite` adapter → `ClientSideConnection::new()` = working ACP over SSH. The protocol layer doesn't care about transport origin.

### Conductor (Proxy Chains)

The `agent-client-protocol-conductor` binary manages proxy chains:
- Spawns proxy components and base agent
- Routes messages between them via `ConductorMessage` envelopes
- Supports MCP bridge mode (stdio ↔ TCP for MCP servers)
- Uses `ConnectTo<Host>` trait for transport abstraction
- Components form composable chains (client → proxy1 → proxy2 → agent)

The conductor operates at JSON-RPC message level, not transport level. Could theoretically sit on either side of an SSH boundary.

## 2. How Zed Solves Remote ACP (Precedent)

Zed is the primary ACP consumer and has working remote development with agents.

### Architecture
- **Local machine**: Zed UI, renders agent panel, handles model selection
- **Remote server**: Headless Zed server spawned over SSH, manages agents, language servers, terminals
- SSH ControlMaster multiplexing: one control connection, multiple channels

### Agent Spawning (from `crates/agent_servers/src/acp.rs`, ~2563 LOC)

```rust
// When remote client exists, transform spawn command
project.remote_client().and_then(|client| {
    let template = client.read(cx).build_command_with_options(
        Some(command.path.display().to_string()),
        &command.args,
        &command.env,
        root_dir,
        None,
        Interactive::No,
    )
})
```

Then:
```rust
let mut child = Child::spawn(child, Stdio::piped(), Stdio::piped(), Stdio::piped())?;
let stdout = child.stdout.take()?;
let stdin = child.stdin.take()?;
// Wired into ClientSideConnection
```

### Key Insight: Zed's Model

Zed runs a **full headless server on the remote machine**. This server:
1. Spawns ACP agents as local subprocesses (from the remote machine's perspective)
2. Handles `fs/` callbacks locally (reads/writes happen on remote filesystem natively)
3. Forwards structured session updates back to local UI over SSH multiplexed channels
4. Terminal callbacks handled on remote server

This **completely sidesteps the filesystem mismatch problem** because from the agent's perspective, everything is local.

### What Zed Does NOT Do
- Does NOT pipe raw ACP stdio over SSH
- Does NOT proxy `fs/` callbacks across network
- Does NOT use HTTP transport
- The "remote" part is the **UI protocol**, not the ACP protocol

### Zed Remote Server Deployment

From `crates/remote/src/transport/ssh.rs`:
1. Uses **OpenSSH CLI** (`ssh` binary), not a Rust SSH library
2. SSH ControlMaster for connection multiplexing
3. Binary naming: `zed-remote-server-{channel}-{version}`
4. Deployment: check if exists → try server-side curl/wget → fallback SCP/SFTP upload → gunzip + chmod
5. Launch: `env VAR1=val1 /path/to/binary proxy --identifier {id}`
6. Wire protocol: length-prefixed protobuf envelopes over stdin/stdout of SSH process

### Zed's `ClientDelegate` (ACP Client Trait Implementation)

From `crates/agent_servers/src/acp.rs`:
- `read_text_file` → delegates to `thread.read_text_file()` — reads local filesystem
- `write_text_file` → delegates to `thread.write_text_file()` — writes local filesystem
- `create_terminal` → spawns terminal entity, registers with renderer
- `terminal_output` → returns current output buffer
- `request_permission` → routes to `thread.request_tool_call_authorization()`
- `session_notification` → handles mode/config updates, processes terminal metadata

## 3. Zed Code Reusability for Maestro

### License: GPL-3.0

Zed is GPL-3.0. Direct code reuse requires Maestro to also be GPL-3.0 (or AGPL-3.0). If Maestro uses MIT/Apache-2.0, must reimplement from architecture study only.

**If Maestro goes GPL-3.0, these files are directly liftable:**

| Zed File | Size | What's Reusable | Adaptation Needed |
|----------|------|-----------------|-------------------|
| `crates/agent_servers/src/acp.rs` | ~2563 LOC | `ClientDelegate`, session management, terminal handling, permission forwarding | ~60-70% reusable. Strip Zed-specific UI (gpui), replace with Tauri IPC events |
| `crates/remote/src/transport/ssh.rs` | ~800 LOC | Binary deployment logic (SCP upload, version check, gunzip, chmod) | Replace OpenSSH CLI with `russh`. Deployment pattern directly applicable |
| `crates/remote/src/transport.rs` | ~300 LOC | Message framing (`handle_rpc_messages_over_child_process_stdio`), length-prefixed envelope serialization | Wire protocol pattern reusable, can simplify from protobuf to JSON |
| `crates/remote_server/src/server.rs` | ~500 LOC | Remote server message loop, channel setup | Strip to agent-only (remove LSP, git, project management) |

### What Maestro Does NOT Need from Zed

Zed's remote server is a **full headless editor**. Maestro only needs agent execution:
- NO language servers
- NO project/workspace management
- NO git integration (Maestro handles this locally)
- NO extension host
- NO debugging adapters

Maestro's remote agent server = ~10% of Zed's `remote_server` crate.

### Key Differences: Maestro vs Zed Remote

| Aspect | Zed | Maestro |
|--------|-----|---------|
| SSH library | OpenSSH CLI (shells out to `ssh`) | `russh` (native Rust, async) |
| Wire protocol | Protobuf envelopes, length-prefixed | Can use simpler JSON-RPC or MessagePack |
| Remote server scope | Full headless editor | Agent execution only |
| UI framework | gpui (custom) | Tauri + React |
| Remote binary size | Large (full Zed) | Small (~1500-2500 LOC) |

## 4. Options for Maestro ACP-over-SSH

### Option A: Zed Model — Remote ACP Server (Recommended)

**Concept**: Deploy thin Maestro agent server binary on remote. Spawns ACP agents locally, handles all callbacks, forwards structured updates to local Maestro UI over SSH channel.

**Architecture**:
```
Local Maestro UI ←──SSH channel──→ Remote Maestro Agent Server
                                        ↓
                                   ACP Agent (subprocess)
                                        ↓
                                   fs/ callbacks → local filesystem (remote machine)
                                   terminal/ → local PTY (remote machine)
```

**What needs building**:
1. **Remote agent server binary** (~1500-2500 LOC Rust)
   - Implements ACP `Client` trait for `fs/` and `terminal/` callbacks
   - Spawns ACP agents as local subprocesses
   - Communicates with local Maestro over SSH channel
   
2. **SSH deployment mechanism**
   - Upload binary via `russh` SFTP
   - Version check, launch over SSH exec channel
   - Cross-compile for linux-x86_64, linux-aarch64
   
3. **Maestro↔Remote wire protocol**
   - Session lifecycle (spawn, prompt, cancel)
   - Streaming ACP `session/update` forwarding
   - Permission request forwarding
   - Terminal output forwarding

**Effort**: 3-5 weeks. Can adapt ~60-70% of Zed's `acp.rs` if GPL-3.0.

### Option B: SSH stdio Tunnel

**Concept**: Pipe ACP stdio over SSH exec channel. Local Maestro is ACP client, SFTP for `fs/` callbacks.

**Problem**: 2 SSH round-trips per file operation. 50-200 file ops per task × 2 × 50ms = 5-20s overhead.

**Effort**: 1-2 weeks. Acceptable for low-latency connections.

### Option C: Hybrid (ACP Local, PTY Remote)

Ship ACP for local immediately. Keep PTY for remote. Migrate later.

### Option D: Wait for HTTP Transport

Not actionable. Nothing exists.

## 5. Recommendations

1. **License Maestro as GPL-3.0** to maximize Zed code reuse
2. **Start with Option C** (hybrid) — ship ACP locally first
3. **Then implement Option A** (remote server) — adapt Zed's `ClientDelegate` pattern
4. **Skip Option B** — if going open source with GPL, remote server (Option A) is cleaner and Zed provides the blueprint

## 6. Key Takeaways

1. **ACP SDK is transport-agnostic** — `ClientSideConnection::new()` accepts any `AsyncRead`/`AsyncWrite`
2. **Real problem is filesystem callbacks**, not transport
3. **Zed solved this with remote server** — agent + ACP client + filesystem all colocated on remote
4. **Zed's code is GPL-3.0** — directly reusable if Maestro goes GPL-3.0
5. **Maestro's remote server would be ~10% of Zed's** — only need agent execution
6. **46 agents, all stdio-only** — ecosystem fully committed to stdio
7. **Streamable HTTP doesn't exist** — don't plan around it

## References

- ACP Transport Spec: https://agentclientprotocol.com/protocol/transports
- ACP RFD - MCP-over-ACP: https://agentclientprotocol.com/rfds/mcp-over-acp.md
- Rust SDK: https://github.com/agentclientprotocol/rust-sdk
- Rust SDK API: https://docs.rs/agent-client-protocol/latest/agent_client_protocol/
- ACP Registry: https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json
- Zed Remote Dev: https://zed.dev/docs/remote-development
- Zed Agent Servers (`acp.rs`): https://github.com/zed-industries/zed/blob/main/crates/agent_servers/src/acp.rs
- Zed Remote Server: https://github.com/zed-industries/zed/tree/main/crates/remote_server
- Zed SSH Transport: https://github.com/zed-industries/zed/blob/main/crates/remote/src/transport/ssh.rs
- Zed Remote Crate: https://github.com/zed-industries/zed/tree/main/crates/remote
- ACP Main Repo: https://github.com/agentclientprotocol/agent-client-protocol
