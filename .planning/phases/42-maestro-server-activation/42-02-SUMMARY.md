---
phase: 42-maestro-server-activation
plan: "02"
subsystem: maestro-server
tags: [rust, acp, server, ipc, subprocess]
dependency_graph:
  requires: [42-01]
  provides: [maestro-server-binary-functional]
  affects: []
tech_stack:
  added: []
  patterns: [tokio-current_thread, LocalSet, spawn_local, tokio-compat-bridge]
key_files:
  created:
    - maestro-server/src/agent.rs
  modified:
    - maestro-server/src/main.rs
decisions:
  - "Import Agent trait explicitly into main.rs scope — Rust requires trait in scope for method calls on ClientSideConnection"
  - "Use .client_capabilities() not .capabilities() on InitializeRequest — correct method name from ACP SDK v0.10.4"
  - "PermitResponse dispatch: perm_resp.allowed ? Selected(allow_once) : Cancelled — maps bool to ACP RequestPermissionOutcome"
metrics:
  duration: "0.030h"
  completed: "2026-04-17"
  tasks_completed: 1
  files_modified: 2
---

# Phase 42 Plan 02: Maestro-Server Stdin/stdout Loop and Agent Spawner Summary

Real stdin/stdout message loop wired in maestro-server binary with full ACP session lifecycle: subprocess spawn via `spawn_agent_subprocess`, `ClientSideConnection` wiring, prompt forwarding, cancel/drop handling, and permission response dispatch.

## Tasks Completed

| Task | Description | Commit | Files |
|------|-------------|--------|-------|
| 1 | Create agent.rs and rewrite main.rs with real read loop | 219d33f | maestro-server/src/agent.rs, maestro-server/src/main.rs |

## What Was Built

**`maestro-server/src/agent.rs`** — new file:
- `pub async fn spawn_agent_subprocess(command, args, cwd)` that spawns the ACP agent as a child subprocess with piped stdin/stdout
- Path traversal rejection: rejects `cwd` containing `..` before any filesystem access (T-42-01)
- CWD existence validation via `tokio::fs::metadata` (T-42-01)
- `kill_on_drop(true)` so dropping the `Child` handle kills the subprocess (T-42-07)
- Agent `stderr` inherited to maestro-server's stderr for debugging

**`maestro-server/src/main.rs`** — complete rewrite from placeholder:
- `#[tokio::main(flavor = "current_thread")]` + `LocalSet` runtime
- `tokio::io::stdin()/stdout()` created inside `run_until` closure (Pitfall 2)
- `read_message(&mut stdin)` loop with clean `break` on UnexpectedEof (T-42-07)
- `ServerRequest::Spawn` arm: calls `spawn_agent_subprocess`, bridges via `compat_write()`/`compat()`, creates `MaestroServerClient`, calls `ClientSideConnection::new`, spawns I/O task via `spawn_local`, calls `conn.initialize` (with `client_capabilities`), calls `conn.new_session`, stores session, writes `SpawnOk`
- `ServerRequest::Prompt` arm: looks up session, builds `acp::PromptRequest`, calls `conn.prompt` inline
- `ServerRequest::Cancel` arm: removes from both `client_refs` and `sessions` maps (subprocess killed via drop)
- `ServerRequest::PermitResponse` arm: dispatches `acp::RequestPermissionResponse` to correct oneshot channel in `pending_permissions`
- Error responses written to stdout on all failure paths (T-42-06)

## Verification Results

```
cargo test -p maestro-server   → 4/4 tests pass
cargo test -p maestro-protocol → 14/14 tests pass
cargo check --workspace        → 0 errors, 1 expected dead_code warning
```

The `dead_code` warning for `ActiveSession.terminals` and `ActiveSession.child` is expected — these fields are held for their `Drop` side effects (terminal cleanup and kill_on_drop) and will be actively used in Phase 43.

## Deviations from Plan

**1. [Rule 1 - Bug] `Agent` trait not in scope for `ClientSideConnection` methods**
- **Found during:** Task 1 compilation
- **Issue:** `conn.initialize`, `conn.new_session`, `conn.prompt` require `use agent_client_protocol::Agent` to be in scope
- **Fix:** Changed import from `use agent_client_protocol as acp` to `use agent_client_protocol::{self as acp, Agent}`
- **Files modified:** `maestro-server/src/main.rs`
- **Commit:** 219d33f

**2. [Rule 1 - Bug] Wrong method name `.capabilities()` on `InitializeRequest`**
- **Found during:** Task 1 compilation
- **Issue:** Plan pseudocode used `.capabilities()` but ACP SDK v0.10.4 exposes `.client_capabilities()`
- **Fix:** Changed `.capabilities(...)` to `.client_capabilities(...)` in the initialize call
- **Files modified:** `maestro-server/src/main.rs`
- **Commit:** 219d33f

## Known Stubs

None — the implementation is complete for Phase 42 scope. The `args: &[]` in the Spawn handler is documented intentional behavior: Phase 45 (Registry) will extend `SpawnRequest` to carry explicit `args` alongside `agent_id`.

## Threat Surface Scan

No new threat surface introduced beyond what the plan's threat model covers. All T-42-01 (cwd validation), T-42-02 (no shell injection via `Command::new`), T-42-06 (unknown session ErrorResponse), and T-42-07 (stdin EOF clean break) mitigations are implemented.

## Self-Check: PASSED
