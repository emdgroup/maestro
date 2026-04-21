# ACP Integration Study for Maestro

**Date:** 2026-04-16
**Status:** Research complete, not yet planned for implementation

## Context

Maestro currently executes AI agents (Claude Code CLI) via raw PTY sessions — local `portable_pty` or remote SSH PTY. Terminal output streams as raw bytes to xterm.js. This works but is opaque: no structured visibility into agent plans, tool calls, file edits, or permissions. Multi-agent support is ad-hoc (each agent = separate PTY process, no standardized discovery).

**ACP (Agent Client Protocol)** is a JSON-RPC 2.0 protocol standardizing editor-to-agent communication. Governed by Zed Industries + JetBrains. Production Rust SDK (`agent-client-protocol` crate, v0.10.4, 1.27M downloads). 30+ agents in registry including Claude Code (`claude-acp`), Gemini CLI, GitHub Copilot, Cline, Goose, Amp.

ACP would give Maestro: structured tool call visibility, real-time plan updates, permission control, file operation interception, agent-agnostic multi-agent support, and session persistence — all via typed Rust SDK instead of terminal scraping.

## Current Architecture (What Changes)

Key files affected:
- `src-tauri/src/process/pty.rs` — local PTY spawning via `portable_pty`
- `src-tauri/src/process/remote.rs` — remote SSH execution
- `src-tauri/src/process/mod.rs` — dispatcher
- `src-tauri/src/ipc/execution_handlers.rs` — all execution IPC commands
- `src/components/execution/Terminal.tsx` — xterm.js live terminal
- `src/components/execution/DeadSessionTerminal.tsx` — replay terminal
- `src/components/execution/AgentMonitor.tsx` — monitor container

Current flow: spawn PTY → stream raw bytes → xterm.js renders → persist terminal_output to SQLite on exit.

## ACP Architecture Overview

### Transport
- **stdio (stable)**: Agent launched as subprocess, JSON-RPC over stdin/stdout
- HTTP/WebSocket: draft, not stable yet

### Key Message Types
- `initialize` — capability negotiation handshake
- `session/new`, `session/load`, `session/list` — session lifecycle
- `session/prompt` — send user prompt to agent
- `session/update` — agent streams back: `plan`, `agent_message_chunk`, `tool_call`, `tool_call_update`
- Agent callbacks into client: `fs/read_text_file`, `fs/write_text_file`, `terminal/create`, `terminal/output`, `session/request_permission`

### Rust SDK API
- `ClientSideConnection` — client endpoint
- `Client` trait — implement to handle agent callbacks (fs ops, terminal, permissions)
- `StreamReceiver` — observe streaming updates
- Types: `ToolCall`, `ToolCallStatus`, `ToolKind`, `ContentBlock`, `SessionId`, `TerminalId`

### Agent Discovery
- ACP Registry at `cdn.agentclientprotocol.com/registry/v1/latest/registry.json`
- Agents distributed via NPX packages, binaries, or UVX
- Claude Code: `npx @agentclientprotocol/claude-agent-acp@0.29.0`
- Gemini: `npx @google/gemini-cli@0.38.1 --acp`
- Copilot: `npx @github/copilot@1.0.31 --acp`

## What ACP Gives Maestro vs Current PTY Approach

| Aspect | PTY (now) | ACP |
|--------|-----------|-----|
| Agent output | Raw terminal bytes | Structured: plans, tool calls, message chunks |
| Tool visibility | Opaque | Typed `tool_call` with kind (read/edit/execute/search), status, content |
| File operations | Agent writes directly | Agent requests `fs/write_text_file` → client approves/rejects |
| Permissions | None | `session/request_permission` with allow/reject granularity |
| Plans | Not visible | Agent streams `plan` updates with task priorities/status |
| Diffs | Post-hoc via git | Real-time diff content in tool_call_update |
| Multi-agent | Manual per-agent PTY | Registry discovery, concurrent sessions, standardized protocol |
| Session resume | Not possible | `session/load` with session ID |
| MCP tools | Not exposed | Client forwards MCP configs to agent |

## Proposed Implementation Strategy

### Phase 1: ACP Client Core (Rust)

Add `agent-client-protocol` crate dependency. Create new module `src-tauri/src/acp/`:

```
src-tauri/src/acp/
  mod.rs          — public API
  client.rs       — Client trait implementation (MaestroAcpClient)
  session.rs      — ACP session management, lifecycle
  registry.rs     — Agent registry fetching + caching
  transport.rs    — stdio subprocess spawning for ACP agents
```

**`MaestroAcpClient`** implements the `Client` trait:
- `fs/read_text_file` → read from worktree path (with sandboxing to worktree dir)
- `fs/write_text_file` → write to worktree path (with permission check)
- `terminal/create` → allocate local PTY in worktree
- `terminal/output` → stream terminal bytes to frontend
- `session/request_permission` → forward to frontend for user decision

### Phase 2: IPC Layer + Frontend Integration

New IPC handlers alongside existing ones:
- `spawn_acp_session(agent_id, project_id, ...)` → launch ACP agent subprocess, initialize, create session
- `send_acp_prompt(session_id, content)` → send prompt to running session
- `cancel_acp_session(session_id)` → cancel running session
- `list_available_agents()` → fetch ACP registry

Frontend gets new structured view alongside terminal:
- **AgentActivityPanel** — shows plan updates, tool calls with status (pending/running/done/error), file diffs
- **PermissionDialog** — surfaces `request_permission` events for user approval
- **AgentSelector** — dropdown populated from ACP registry for choosing which agent to run

### Phase 3: Dual-Mode Execution

Keep PTY path for:
- Non-ACP agents (custom scripts, legacy CLI tools)
- Remote SSH execution (ACP stdio requires local subprocess — remote ACP would need SSH tunnel or HTTP transport when it stabilizes)
- Fallback when ACP agent is unavailable

Execution dispatcher routes based on agent type:
```rust
enum AgentExecution {
    Acp { agent_id: String, session: AcpSession },
    Pty { pty_session: PtySession },
    RemotePty { ssh_handle: SshPtyHandle },
}
```

### Phase 4: Multi-Agent Support

- Agent registry UI: browse, configure, select agents per task
- Concurrent sessions: multiple ACP agents running in separate worktrees
- Per-task agent assignment on Kanban board
- Agent capability comparison (show what each agent supports)

## Key Considerations

### Remote Execution Gap
ACP only has stable stdio transport (local subprocess). Remote SSH execution can't use ACP directly yet. Options:
1. **SSH tunnel**: Forward ACP stdio over SSH (spawn agent remotely, pipe stdin/stdout through SSH channel) — complex but feasible
2. **Wait for HTTP transport**: Draft spec exists, not stable
3. **Keep SSH PTY fallback**: For remote, continue using current approach

Recommend: option 1 (SSH tunnel) for Phase 3, with PTY fallback.

### Terminal Output
ACP agents still produce terminal output via `terminal/create` + `terminal/output` callbacks. xterm.js stays relevant for rendering terminal commands the agent runs. But now we also get structured data alongside it.

### Schema Changes
- New `acp_sessions` table: session_id, agent_id, execution_log_id, state, capabilities
- Extend `execution_logs`: add `agent_type` (pty|acp), `acp_session_id`
- New `agent_registry_cache` table: agent metadata cache

### Dependencies
- `agent-client-protocol` Rust crate (v0.10.4, Apache-2.0)
- No new frontend deps needed — JSON-RPC parsing happens in Rust, structured data sent via existing Tauri IPC

## Verification Plan

1. **Unit tests**: ACP client trait implementation, message serialization, session lifecycle
2. **Integration test**: Spawn `claude-acp` via ACP, send prompt, verify structured tool_call events received
3. **Frontend test**: Verify AgentActivityPanel renders plan updates and tool calls
4. **Dual-mode test**: Run same task via PTY and ACP, compare results
5. **Multi-agent test**: Run Claude and Gemini concurrently on different tasks

## Risk Assessment

- **Low risk**: Rust SDK is production-grade (powers Zed editor), well-typed
- **Medium risk**: HTTP transport not stable — remote execution needs workaround
- **Medium risk**: Not all agents fully implement ACP spec — capability negotiation needed
- **Low risk**: Backward compatible — PTY path preserved, ACP is additive

## References

- ACP website: https://agentclientprotocol.com
- Rust SDK: https://crates.io/crates/agent-client-protocol (v0.10.4)
- Rust SDK repo: https://github.com/agentclientprotocol/rust-sdk
- TypeScript SDK: https://www.npmjs.com/package/@agentclientprotocol/sdk
- ACP Registry: https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json
- Claude ACP wrapper: `@agentclientprotocol/claude-agent-acp` (v0.29.0)
