---
phase: 44-db-schema-acp-ipc-handlers
plan: "02"
subsystem: acp
tags:
  - acp
  - persistence
  - typescript-bindings
  - structured-output
dependency_graph:
  requires:
    - 44-01
  provides:
    - structured_output flush in ACP reader task
    - regenerated TypeScript bindings for Phase 44
  affects:
    - src-tauri/src/acp/manager.rs
    - src/types/bindings.ts
tech_stack:
  added: []
  patterns:
    - tokio::time::interval for periodic background flush
    - overwrite semantics for accumulated structured_updates
    - std::sync::MutexGuard scoped drop (never hold across .await)
key_files:
  created: []
  modified:
    - src-tauri/src/acp/manager.rs
    - src/types/bindings.ts
decisions:
  - structured_updates never cleared between flushes — overwrite semantics mean column always stores full accumulated list for dead-session replay
  - Final flush placed before acp_sessions.lock().await.remove() — ensures data written before session entry removed from map
  - flush_interval arm placed between cancel_rx and read_message in biased select! — cancel takes priority; flush doesn't starve reads
metrics:
  duration: "0.033h"
  completed_date: "2026-04-21"
  tasks_completed: 2
  files_modified: 2
---

# Phase 44 Plan 02: Structured Output Flush + Bindings Regeneration Summary

ACP reader task now persists SessionUpdate payloads to execution_logs.structured_output every 10 seconds and on session exit, enabling dead-session replay after app restart. TypeScript bindings regenerated with all four canonical ACP IPC commands and extended ExecutionWithTask type.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Add periodic structured_output flush to reader task | a798d25 | src-tauri/src/acp/manager.rs |
| 2 | Regenerate TypeScript bindings | 36d7431 | src/types/bindings.ts |

## What Was Built

### Task 1: Periodic Structured Output Flush

Modified `spawn_reader_task` in `src-tauri/src/acp/manager.rs` to:

1. Added `use tokio::time::{interval, Duration};` import
2. Initialized `flush_interval = interval(Duration::from_secs(10))` and `structured_updates: Vec<serde_json::Value>` before the loop
3. Added `flush_interval.tick()` arm in `select!` between cancel_rx and read_message (biased ordering preserved)
4. Added `structured_updates.push(upd.payload.clone())` in the SessionUpdate match arm before the Tauri event emit
5. Added final flush block after the loop exit, before `acp_sessions.lock().await.remove(&log_id)`

Key design decisions:
- No `structured_updates.clear()` between flushes — overwrite semantics, DB column always stores full accumulated list
- DB lock acquired and dropped in scoped `if let Ok(conn) = ...` block — never held across `.await`
- `biased;` qualifier kept with cancel_rx first, flush_interval second, read_message last

### Task 2: TypeScript Bindings Regeneration

Ran `pnpm tauri:gen` which executed `cargo test generate_typescript_bindings`. Updated `src/types/bindings.ts` to reflect Phase 44 changes:
- Four canonical ACP commands: `spawnAcpSession`, `sendAcpPrompt`, `respondAcpPermission`, `cancelAcpSession`
- Extended `ExecutionWithTask` type with `execution_mode: string | null` and `agent_id: string | null`
- Removed stale `startAcpSession` / `sendToAcpSession` bindings (from pre-Phase 44 naming)

## Verification

- `cargo check` — exits 0
- `cargo test` — 13/13 tests pass
- `pnpm tauri:gen` — exits 0
- `pnpm build` — exits 0 (chunk size warnings are pre-existing, unrelated to this plan)

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

None — all changes are fully wired. The flush SQL writes to the real DB column added in Plan 01.

## Threat Flags

None — no new network endpoints, auth paths, or schema changes introduced. T-44-06 mitigation (parameterized query with `rusqlite::params!`) was applied as specified in the threat model.

## Self-Check: PASSED

- [x] `src-tauri/src/acp/manager.rs` exists and contains all flush logic
- [x] `src/types/bindings.ts` exists and contains `spawnAcpSession`
- [x] Commit a798d25 exists (Task 1)
- [x] Commit 36d7431 exists (Task 2)
