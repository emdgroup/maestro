---
phase: 32-backend-code-quality-fixes
plan: "01"
subsystem: backend
tags: [bug-fix, sql, panic-safety, rust]
dependency_graph:
  requires: []
  provides: [V5-compatible-review-queries, panic-free-project-insertion, correct-execution-log-ordering, correct-ssh-log-messages]
  affects: [review_handlers, project_handlers, execution_logs, ssh_handlers]
tech_stack:
  added: []
  patterns: [map_err-over-expect, task_id-join-pattern]
key_files:
  created: []
  modified:
    - src-tauri/src/ipc/review_handlers.rs
    - src-tauri/src/ipc/project_handlers.rs
    - src-tauri/src/db/execution_logs.rs
    - src-tauri/src/ipc/ssh_handlers.rs
decisions:
  - "Use task_id FK join for worktree lookup in review handlers (V5 schema, no status column)"
  - "Replace .expect() with map_err+? in all three project insertion sites"
  - "ORDER BY started_at (not created_at) in get_current_execution_log"
metrics:
  duration_hours: 0.03
  completed_date: "2026-03-31T08:09:13Z"
  tasks_completed: 2
  files_modified: 4
---

# Phase 32 Plan 01: Critical Backend Bug Fixes Summary

Fixed four categories of broken-at-runtime bugs: SQL queries referencing removed V5 schema columns, .expect() panics in project insertion, wrong ORDER BY column in execution log query, and copy-pasted log messages.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Fix broken review queries and project handler panics | fcf7d8e | review_handlers.rs, project_handlers.rs |
| 2 | Fix execution_logs ORDER BY and ssh_handlers log messages | 3a9f3e7 | execution_logs.rs, ssh_handlers.rs |

## Changes Made

### H1 — Broken V5 Schema Queries in review_handlers.rs

Three queries referenced `worktrees.status` which does not exist in V5 schema:

1. `get_diff_for_review`: replaced `WHERE project_id = ? AND (status = 'InUse' OR status = 'Leased')` with `WHERE w.task_id = ?` (passes `task_id` instead of `proj_id`)
2. `approve_task_and_merge`: replaced subquery `WHERE project_id = t.project_id AND (status = 'InUse' OR status = 'Leased')` with `WHERE task_id = t.id`
3. `finalize_successful_merge`: removed entire `UPDATE worktrees SET status = 'Dirty' WHERE id = ?` block (no status column in V5)

### H2 — .expect() Panics in project_handlers.rs

Three `unwrap_or_else` closures with `.expect()` inside replaced with `match` expressions using `map_err(|e| format!(...))?`:

- `clone_project` line ~319
- `create_new_project` line ~406
- `create_project` line ~446

All three now propagate DB errors as `Result<_, String>` instead of panicking the Tauri process.

### L1 — Wrong ORDER BY Column in execution_logs.rs

`get_current_execution_log` was ordering by `created_at` which does not exist in `execution_logs`. Changed to `started_at DESC LIMIT 1` which matches the actual schema columns (`started_at`, `completed_at`).

### L8 — Copy-pasted Log Messages in ssh_handlers.rs

`forget_saved_password` was logging:
- `"delete_ssh_connection(connection_id={}) called via IPC"` → fixed to `"forget_saved_password(connection_id={}) called via IPC"`
- `"Deleted SSH connection: {}"` → fixed to `"Forgot saved password for connection: {}"`

## Deviations from Plan

None — plan executed exactly as written.

## Self-Check: PASSED

- fcf7d8e present: `git log --oneline | grep fcf7d8e` ✓
- 3a9f3e7 present: `git log --oneline | grep 3a9f3e7` ✓
- review_handlers.rs modified: ✓
- project_handlers.rs modified: ✓
- execution_logs.rs modified: ✓
- ssh_handlers.rs modified: ✓
- `cargo check` passes: Finished dev profile ✓
