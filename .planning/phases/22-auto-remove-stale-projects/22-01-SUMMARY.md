---
plan: 22-01
phase: 22
status: complete
subsystem: backend-ipc
tags: [rust, ipc, project-management, ssh, sqlite]
dependency_graph:
  requires: [phase-21]
  provides: [stale-project-cleanup]
  affects: [project_handlers, AppState]
tech_stack:
  added: []
  patterns: [async-ipc-command, db-lock-release-before-async]
key_files:
  created: []
  modified:
    - src-tauri/src/ipc/project_handlers.rs
    - .planning/ROADMAP.md
decisions:
  - Split db fetch into scoped block so conn drops before async SSH I/O
  - Use match arms with explicit params to work around Rust lifetime constraints on &[&dyn ToSql] across block boundaries
  - SSH validation is best-effort: command errors keep the project (fail-safe)
metrics:
  duration: 0.099h
  completed_date: "2026-03-16"
  tasks_completed: 5
  files_modified: 2
---

# Phase 22 Plan 01: Validate Project Paths in get_connection_projects (Local + SSH) Summary

## What Was Built

Async `get_connection_projects` IPC handler with automatic stale project cleanup. Local project paths are validated with `std::fs::Path::exists()`; SSH project paths are validated by running `test -d "<path>"` via the active SSH session. Stale projects are silently deleted from the database and excluded from the returned list. The database mutex is released between the fetch step and async SSH I/O to prevent holding the lock across network calls. A private `collect_stale_project_ids` helper encapsulates the dual-path validation logic. No frontend changes were required.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Make get_connection_projects async, drop db lock before validation | defcb63 | src-tauri/src/ipc/project_handlers.rs |
| 2 | Add collect_stale_project_ids helper (local + SSH) | defcb63 | src-tauri/src/ipc/project_handlers.rs |
| 3 | Update ROADMAP.md Phase 22 success criteria #4 | defcb63 | .planning/ROADMAP.md |
| 4 | Build verification — cargo check + cargo build | defcb63 | — |
| 5 | Commit | defcb63 | — |

## Deviations

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed Rust lifetime errors in async block**
- **Found during:** Task 4 (cargo check)
- **Issue:** The original plan's code used `&[&dyn ToSql]` with a `params![]` macro inside a scoped block. Rust rejected this because the temporary `id` binding from the `match` arm did not live long enough, and the `MappedRows` destructor held a borrow that outlived `conn` and `stmt`. Three E0597 lifetime errors were emitted.
- **Fix:** Replaced the single match-on-query-string pattern with two explicit match arms, each constructing its own `stmt` and collecting rows independently. This keeps all borrows within each arm's scope, satisfying the borrow checker.
- **Files modified:** src-tauri/src/ipc/project_handlers.rs
- **Commit:** defcb63

**2. [Rule 1 - Bug] Removed unused `ToSql` import**
- **Found during:** Task 4 (cargo check warning)
- **Issue:** After switching from the `&[&dyn ToSql]` pattern, the `ToSql` import became unused, generating a compiler warning.
- **Fix:** Removed `ToSql` from the `use rusqlite::{params, ToSql};` import line.
- **Files modified:** src-tauri/src/ipc/project_handlers.rs
- **Commit:** defcb63

## Self-Check

Checking created/modified files exist:

- FOUND: src-tauri/src/ipc/project_handlers.rs
- FOUND: .planning/phases/22-auto-remove-stale-projects/22-01-SUMMARY.md
- FOUND: commit defcb63

## Self-Check: PASSED
