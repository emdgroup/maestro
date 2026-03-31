---
phase: 33-tauri-backend-code-review-and-refactoring-for-maintainability-dry-solid-kiss
plan: "02"
subsystem: backend-ipc
tags: [refactor, dry, rust, ipc, project-handlers, ssh-handlers]
dependency_graph:
  requires: []
  provides: [register_project_in_db, finalize_ssh_connection]
  affects: [src-tauri/src/ipc/project_handlers.rs, src-tauri/src/ipc/ssh_handlers.rs, src-tauri/src/ipc/task_handlers.rs]
tech_stack:
  added: []
  patterns: [private-helper-extraction, nullable-IS-comparison]
key_files:
  created: []
  modified:
    - src-tauri/src/ipc/project_handlers.rs
    - src-tauri/src/ipc/ssh_handlers.rs
    - src-tauri/src/ipc/task_handlers.rs
decisions:
  - "register_project_in_db uses IS ? for nullable column comparison to fix SQLite NULL semantics bug"
  - "create_project kept with inline logic and NOTE comment since it calls get_project() which updates last_opened"
  - "finalize_ssh_connection early-return path (reuse existing session) keeps inline DB update - only fresh-auth path uses the helper"
  - "list_project_branches keeps get_git_connection directly (not get_project_with_git_conn) to allow graceful SSH fallback"
metrics:
  duration: "0.05h"
  completed_date: "2026-03-31"
  tasks_completed: 2
  files_modified: 3
---

# Phase 33 Plan 02: DRY Helpers for project_handlers and ssh_handlers Summary

DRY extraction of project DB registration and SSH session finalization into shared private helpers, with nullable column bug fix and API documentation.

## Tasks Completed

| Task | Description | Commit | Files |
|------|-------------|--------|-------|
| 1 | Extract register_project_in_db helper, fix IS ? bug, document _project_id | 6f1487d | project_handlers.rs |
| 2 | Extract finalize_ssh_connection helper, document list_project_branches | f036d16 | ssh_handlers.rs, task_handlers.rs |

## What Was Built

**Task 1 — project_handlers.rs:**
- Added `register_project_in_db()` private helper that encapsulates the check-or-insert DB pattern and .maestro folder initialization
- Refactored `clone_project` and `create_new_project` to call the helper (removed ~35 lines of duplicated logic each)
- Fixed `create_project` nullable column bug: `connection_id = ?` changed to `connection_id IS ?` (SQLite returns FALSE for NULL = NULL, only IS NULL/IS ? handles nulls correctly)
- Added NOTE to `create_project` explaining why it's kept separate (calls `get_project()` which updates `last_opened`)
- Added doc comments to `get_project_settings` and `update_project_settings` documenting that `_project_id` is ignored for API compatibility

**Task 2 — ssh_handlers.rs and task_handlers.rs:**
- Added `finalize_ssh_connection()` async helper that stores session in AppState and updates DB timestamps/auth_method
- Refactored all 4 connect handlers: `connect_ssh_without_credentials`, `connect_ssh_with_password`, `connect_ssh_with_agent`, `connect_ssh_with_key`
- `connect_ssh_without_credentials` early-return path (reusing existing session) keeps inline DB update — only the fresh-auth path uses the helper
- Added clarifying comment in `list_project_branches` explaining why `get_git_connection` is used directly instead of `get_project_with_git_conn` (graceful SSH fallback)

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

None.

## Self-Check: PASSED

Files verified:
- FOUND: src-tauri/src/ipc/project_handlers.rs (contains register_project_in_db)
- FOUND: src-tauri/src/ipc/ssh_handlers.rs (contains finalize_ssh_connection)
- FOUND: src-tauri/src/ipc/task_handlers.rs (contains branch listing comment)

Commits verified:
- FOUND: 6f1487d (project_handlers refactor)
- FOUND: f036d16 (ssh_handlers refactor)

cargo check: PASSED
cargo test: PASSED (0 tests, 0 failures)
