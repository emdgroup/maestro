---
phase: 44-db-schema-acp-ipc-handlers
plan: "01"
subsystem: backend
tags: [rust, sqlite, schema-migration, ipc, acp, tdd]
dependency_graph:
  requires: []
  provides: [schema-v11, spawn_acp_session, send_acp_prompt, respond_acp_permission, ExecutionWithTask-v11]
  affects: [src-tauri/src/db/schema.rs, src-tauri/src/ipc/acp_handlers.rs, src-tauri/src/models/worktree.rs, src-tauri/src/ipc/execution_handlers.rs, src-tauri/src/lib.rs]
tech_stack:
  added: []
  patterns: [in-memory-sqlite-testing, tdd-red-green, wave-0-test-first]
key_files:
  created: []
  modified:
    - src-tauri/src/db/schema.rs
    - src-tauri/src/ipc/acp_handlers.rs
    - src-tauri/src/models/worktree.rs
    - src-tauri/src/ipc/execution_handlers.rs
    - src-tauri/src/lib.rs
decisions:
  - "spawn_acp_session INSERT uses execution_mode='acp' and agent_id columns directly (v11 schema)"
  - "send_acp_prompt and respond_acp_permission are dedicated commands with typed params (no message_type dispatch)"
  - "ExecutionWithTask.execution_mode and agent_id are Option<String> for LEFT JOIN backward compat"
metrics:
  duration: "0.072 hours"
  completed_date: "2026-04-21"
  tasks_completed: 3
  files_modified: 5
---

# Phase 44 Plan 01: DB Schema v11 + ACP IPC Commands Summary

Schema v11 with three new execution_logs columns (execution_mode, agent_id, structured_output), four dedicated ACP IPC commands replacing the generic dispatcher, and ExecutionWithTask extended for frontend session type distinction.

## Tasks Completed

| Task | Name | Commit | Key Changes |
|------|------|--------|-------------|
| 0 | Wave 0 behavioral tests for PERSIST-02/PERSIST-05 | 8ce366b | Added `#[cfg(test)]` module to acp_handlers.rs with two failing tests |
| 1 | Schema v11 + ExecutionWithTask extension | 081ca57 | schema.rs v11, three new columns, worktree.rs two new fields, execution_handlers.rs query update |
| 2 | Dedicated ACP IPC commands | 85b75e7 | spawn_acp_session, send_acp_prompt, respond_acp_permission in acp_handlers.rs + lib.rs registration |

## Verification Results

All acceptance criteria met:

- `cargo test` passes: 13/13 tests (including schema, PERSIST-02, PERSIST-05)
- `pnpm build` passes: frontend compiles with updated TypeScript bindings
- `cargo check` passes: 0 errors, 0 warnings

## Key Changes

### schema.rs
- `SCHEMA_VERSION` bumped from 10 to 11
- `SCHEMA_V10` renamed to `SCHEMA_V11`
- Three new columns added to `execution_logs`:
  - `execution_mode TEXT NOT NULL DEFAULT 'pty'` — distinguishes PTY vs ACP sessions
  - `agent_id TEXT` — ACP agent package name (e.g. "claude-code")
  - `structured_output TEXT` — reserved for future agent structured output
- Schema test updated to assert `version == 11` and verify all three new columns

### models/worktree.rs
- `ExecutionWithTask` has two new fields:
  - `pub execution_mode: Option<String>` — "pty" or "acp"; Option for LEFT JOIN compat
  - `pub agent_id: Option<String>` — ACP agent identifier; None for PTY sessions

### ipc/acp_handlers.rs
- `start_acp_session` → `spawn_acp_session` with updated v11 INSERT
- `send_to_acp_session` (generic dispatcher) removed
- `send_acp_prompt` added: typed command for PromptRequest
- `respond_acp_permission` added: typed command for PermissionResponse
- `cancel_acp_session` unchanged
- Module doc updated to list four canonical commands
- Test module preserved with PERSIST-02 and PERSIST-05 behavioral tests

### ipc/execution_handlers.rs
- `list_executions_with_task_info` SELECT extended with `el.execution_mode, el.agent_id`
- `query_map` closure extended: `execution_mode: row.get(9)?, agent_id: row.get(10)?`

### lib.rs
- `collect_commands!` updated: replaced `start_acp_session, send_to_acp_session` with `spawn_acp_session, send_acp_prompt, respond_acp_permission`
- Comment updated from "Phase 43" to "Phase 44"

## TDD Wave Pattern

Wave 0 (Task 0) tests were written first and ran RED against v10 schema:
- `test_spawn_acp_session_creates_log` — failed: "table execution_logs has no column named execution_mode"
- `test_cancel_acp_session_updates_status` — failed: same error

Wave 1 (Task 1) bumped schema to v11 — both tests turned GREEN.

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

None — all new columns are wired into the INSERT and SELECT queries. No placeholder text or empty data flows.

## Threat Flags

No new network endpoints or trust boundary changes beyond the renamed/replaced IPC commands already present in Phase 43. The T-44-01 mitigation (write_to_acp_session validates log_id in acp_sessions map) is inherited unchanged.

## Self-Check: PASSED

All 5 source files verified present. All 3 task commits verified in git log (8ce366b, 081ca57, 85b75e7).
