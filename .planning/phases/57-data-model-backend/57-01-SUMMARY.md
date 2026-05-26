---
phase: 57-data-model-backend
plan: "01"
subsystem: rust-backend
tags: [schema-migration, data-model, sqlite, rust]
dependency_graph:
  requires: []
  provides: [schema-v18, task-auto-approve, task-isolated-worktree, task-attachments-table, task-attachment-model]
  affects: [src-tauri/src/db/schema.rs, src-tauri/src/models/task.rs, src-tauri/src/models/mod.rs]
tech_stack:
  added: []
  patterns: [rusqlite-bool-mapping, cascade-fk-table, specta-export-struct]
key_files:
  created: []
  modified:
    - src-tauri/src/db/schema.rs
    - src-tauri/src/models/task.rs
    - src-tauri/src/models/mod.rs
decisions:
  - "Placed auto_approve/isolated_worktree columns after labels and before created_at in tasks DDL to match TASK_SELECT column order (indices 20, 21)"
  - "task_attachments drop listed first in destructive migration block — FK dependency on tasks requires it precede tasks drop"
  - "Used rusqlite native bool mapping (row.get::<_, bool>(n)) for auto_approve/isolated_worktree; no custom conversion needed"
metrics:
  duration: "~5 minutes"
  completed_date: "2026-05-26"
  tasks_completed: 2
  tasks_total: 2
  files_changed: 3
---

# Phase 57 Plan 01: Schema V18 + Task Model Extension Summary

SQLite schema bumped to V18 with `auto_approve`/`isolated_worktree` task fields and new `task_attachments` table with CASCADE FK; Task struct and TaskAttachment model updated and exported.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Schema V18 — new columns and task_attachments table | 2b0a80b | src-tauri/src/db/schema.rs |
| 2 | Task struct extension + TaskAttachment model | f53f1ec | src-tauri/src/models/task.rs, src-tauri/src/models/mod.rs |

## What Was Built

**Task 1 — Schema V18:**
- `SCHEMA_VERSION` constant: 17 → 18
- SQL constant renamed: `SCHEMA_V17` → `SCHEMA_V18`
- `tasks` DDL: added `auto_approve INTEGER NOT NULL DEFAULT 0` and `isolated_worktree INTEGER NOT NULL DEFAULT 1` after `labels TEXT DEFAULT '[]'`
- New `task_attachments` table: `id, task_id, filename, file_path, file_size, created_at` with `FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE`
- Index `idx_task_attachments_task_id` on `task_attachments(task_id)`
- Destructive migration drop block: `task_attachments` added as first drop statement (before `session_aliases`)
- Schema tests: assert `task_attachments` in tables list, `auto_approve` and `isolated_worktree` in task columns, version == 18

**Task 2 — Task struct + TaskAttachment model:**
- `TASK_SELECT` constant: extended with `auto_approve, isolated_worktree FROM tasks` (indices 20, 21); column comment updated
- `Task` struct: added `pub auto_approve: bool` and `pub isolated_worktree: bool` after `updated_at`
- `Task::from_row`: added `auto_approve: row.get::<_, bool>(20).unwrap_or(false)` and `isolated_worktree: row.get::<_, bool>(21).unwrap_or(true)`
- New `TaskAttachment` struct with `#[derive(Debug, Clone, Serialize, Deserialize, Type)]` and `#[specta(export)]`
- `models/mod.rs`: `TaskAttachment` added to the `pub use task::{...}` re-export line

## Verification

- `cargo test test_schema_initialization`: passed (1/1)
- `cargo test` (full suite): 79 passed, 4 ignored, 0 failures
- `cargo check`: 0 errors, 1 warning (pre-existing profile warning unrelated to this plan)
- `grep "SCHEMA_VERSION.*18"`: confirmed
- `grep "TaskAttachment" models/mod.rs`: confirmed

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

None.

## Threat Flags

None — no new network endpoints, auth paths, or file access patterns introduced. The `task_attachments` table stores metadata only; actual file I/O is deferred to Phase 62 as documented in the threat model (T-57-01 accepted, T-57-02 accepted).

## Self-Check: PASSED

- [x] `src-tauri/src/db/schema.rs` — modified, committed in 2b0a80b
- [x] `src-tauri/src/models/task.rs` — modified, committed in f53f1ec
- [x] `src-tauri/src/models/mod.rs` — modified, committed in f53f1ec
- [x] Commit 2b0a80b exists in git log
- [x] Commit f53f1ec exists in git log
- [x] `SCHEMA_VERSION = 18` confirmed
- [x] `TaskAttachment` re-exported from models
- [x] All cargo tests pass
