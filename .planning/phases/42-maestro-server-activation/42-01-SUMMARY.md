---
phase: 42-maestro-server-activation
plan: 01
subsystem: maestro-server
tags: [rust, acp, protocol, client-trait, session-types]
dependency_graph:
  requires: [maestro-protocol]
  provides: [MaestroServerClient, sessions.rs, TermitResponse variant]
  affects: [maestro-server/src/main.rs]
tech_stack:
  added: []
  patterns: [async-trait(?Send), Rc/RefCell for !Send context, oneshot channel for permission blocking, spawn_local for terminal background reader]
key_files:
  created:
    - maestro-server/src/sessions.rs
    - maestro-server/src/client.rs
    - maestro-server/src/tests.rs
  modified:
    - maestro-protocol/src/lib.rs
    - maestro-server/src/main.rs
decisions:
  - "PermitResponse uses PermissionResponse struct already in protocol — no new type needed"
  - "Rc<tokio::sync::Mutex<Stdout>> for stdout — Rc because Client is ?Send, but Mutex needed for interior mutability across await points"
  - "stdout flushed in send_response helper after every write_all — Stdout is buffered"
  - "cwd validated before spawn (T-42-01): reject '..' components and non-existent paths"
  - "Command::new(program).args(args) not sh -c shell strings (T-42-02)"
  - "output_byte_limit enforced in background reader by truncating from front at char boundary (T-42-03)"
  - "Background reader uses tokio::select! biased toward kill_rx for responsive shutdown"
  - "kill_on_drop(true) on child process ensures cleanup when ActiveSession or TerminalHandle is dropped"
metrics:
  duration: 0.061h
  completed: "2026-04-17"
  tasks_completed: 3
  files_modified: 5
---

# Phase 42 Plan 01: Protocol Extension and MaestroServerClient Summary

**One-liner:** Added PermitResponse to maestro-protocol ServerRequest, implemented MaestroServerClient with all ACP Client trait methods including blocking permission requests via oneshot channels and subprocess terminal management.

## Tasks Completed

| Task | Description | Commit |
|------|-------------|--------|
| 1 | Add PermitResponse(PermissionResponse) variant to ServerRequest, 2 new roundtrip tests | d27b6dd |
| 2 | Create sessions.rs (ActiveSession, TerminalHandle, SessionMap) and client.rs (MaestroServerClient implementing acp::Client) | 1eb3289 |
| 3 | Create Wave 0 unit test stubs for SERVER-01 through SERVER-04 | 44f332a |

## Verification Results

- `cargo test -p maestro-protocol`: 14 passed (12 existing + 2 new)
- `cargo test -p maestro-server`: 4 passed (all SERVER-01 through SERVER-04 stubs)
- `cargo check --workspace`: clean, no regressions

## Key Decisions

- **PermitResponse uses existing PermissionResponse struct** — the struct was already defined as standalone; adding it as a ServerRequest variant required no new types.
- **Rc<tokio::sync::Mutex<Stdout>> for stdout** — Client trait is `?Send` so Arc is not needed, but Mutex is required to hold the lock guard across `.await` points in `send_response`.
- **send_response flushes after every write** — tokio::io::Stdout is buffered; omitting flush causes frames to be held in the kernel buffer until the process exits.
- **cwd validated before spawn (T-42-01)** — rejects paths with `..` components and non-existent directories to prevent elevation of privilege via malicious agent-supplied paths.
- **spawn_local for background terminal reader** — correct for LocalSet context; `tokio::spawn` would require Send bounds which Rc fields cannot satisfy.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Security] Applied T-42-01 cwd validation in create_terminal**
- **Found during:** Task 2 (threat model review)
- **Issue:** Plan's threat model marks T-42-01 (cwd path traversal) as `mitigate` disposition; plan action described the mitigation but the implementation spec needed to match.
- **Fix:** Added `..` component rejection and `tokio::fs::metadata` existence check before subprocess spawn.
- **Files modified:** maestro-server/src/client.rs
- **Commit:** 1eb3289

No other deviations — plan executed as specified.

## Known Stubs

None — the implementation is complete for this plan's scope. The `exit_status` in the background terminal reader is set to `Some(TerminalExitInfo { exit_code: None, signal: None })` as a stub (Plan 02 will wire the actual `child.wait()` call in the main loop context where the child handle is accessible).

## Threat Flags

No new threat surface beyond what is documented in the plan's threat model. The three mitigations from the threat register (T-42-01, T-42-02, T-42-03) are implemented in client.rs.

## Self-Check: PASSED
