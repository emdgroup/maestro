---
phase: 32-backend-code-quality-fixes
plan: "05"
subsystem: backend
tags: [rust, code-quality, logging, sql, dry, error-handling]
dependency_graph:
  requires: [32-03]
  provides: [all-low-findings-resolved, m14-sync-dry]
  affects: [error.rs, lib.rs, main.rs, models/task.rs, db/settings.rs, db/connection.rs, ipc/*, websocket/streaming.rs]
tech_stack:
  added: [log = "0.4", env_logger = "0.11"]
  patterns: [structured-logging, explicit-sql-columns, shared-upsert-helper, tauri-path-api]
key_files:
  created: []
  modified:
    - src-tauri/src/error.rs
    - src-tauri/src/lib.rs
    - src-tauri/src/main.rs
    - src-tauri/src/models/task.rs
    - src-tauri/src/db/settings.rs
    - src-tauri/src/db/connection.rs
    - src-tauri/Cargo.toml
    - src-tauri/src/ipc/task_handlers.rs
    - src-tauri/src/ipc/project_handlers.rs
    - src-tauri/src/ipc/ssh_handlers.rs
    - src-tauri/src/ipc/worktree_handlers.rs
    - src-tauri/src/ipc/execution_handlers.rs
    - src-tauri/src/ipc/review_handlers.rs
    - src-tauri/src/ipc/settings_handlers.rs
    - src-tauri/src/websocket/streaming.rs
decisions:
  - "AppError removed: all IPC handlers return Result<T, String> directly; error.rs kept as empty module with comment"
  - "ProjectConfigRequest kept as separate struct (not aliased) because type aliases cannot carry #[derive(TS)] / #[specta(export)] — would break bindings.ts"
  - "TaskPriority/TaskStatus from_str: type Err = String and log::warn! on unknown value to preserve backward compat while surfacing bad DB data"
  - "pub use ipc::* glob removed from lib.rs; ssh_handlers.rs imports remove_projects_by_connection_id via super::project_handlers"
  - "upsert_imported_tasks extracted as private fn in settings_handlers.rs: both sync functions now share identical DB upsert logic"
metrics:
  duration: 0.025h
  completed: "2026-03-31T08:39:10Z"
  tasks_completed: 2
  files_modified: 15
---

# Phase 32 Plan 05: Backend Code Quality Fixes - Final Polish Summary

Final quality pass addressing all remaining LOW-severity findings (L2-L7, L9-L10) and medium finding M14 from the code review. All `cargo check` and `cargo test` pass cleanly.

## What Was Built

Removed dead `AppError` enum, replaced all `println!`/`eprintln!` with structured logging via the `log` crate, fixed `SELECT *` queries with explicit column lists, used Tauri's native path API, fixed a no-op `stop_remote_stream`, and extracted a shared upsert helper for GitHub/Jira sync.

## Tasks

### Task 1: Remove AppError, add logging, fix from_str, clean re-exports

**Commit:** d86df85

**Changes:**
- `error.rs`: Entire `AppError` enum removed; file now contains only a comment explaining the `Result<T, String>` pattern
- `db/settings.rs`: `load_settings` and `save_settings` now return `Result<_, String>`; removed `use crate::error::AppError`
- `db/connection.rs`: `init_db` now returns `Result<Connection, String>`; removed AppError import
- `lib.rs`: Removed `pub use error::AppError` and `pub use ipc::*` glob re-export
- `ipc/ssh_handlers.rs`: Imports `remove_projects_by_connection_id` via `super::project_handlers` (no longer needs crate-root glob)
- `models/task.rs`: Added TODO comment above `ProjectConfigRequest` explaining why type alias is not possible; `from_str` for both `TaskPriority` and `TaskStatus` changed `type Err = ()` to `type Err = String` and logs unknown values with `log::warn!`
- `Cargo.toml`: Added `log = "0.4"` and `env_logger = "0.11"`
- `main.rs`: Added `env_logger::init()` before Tauri builder
- All IPC handler files: Replaced every `println!` with `log::info!` and `eprintln!` with `log::warn!`

### Task 2: Tauri path API, explicit SQL columns, fix stop_remote_stream, DRY sync upsert

**Commit:** 3e1b369

**Changes:**
- `main.rs`: Removed `get_app_data_dir()` function; now uses `app.path().app_data_dir()` (Tauri native API)
- `ipc/project_handlers.rs`: All `SELECT *` replaced with explicit column list `id, name, path, created_at, updated_at, last_opened, connection_id`; `get_projects` now orders by `last_opened DESC NULLS LAST`
- `ipc/ssh_handlers.rs`: `SELECT *` in both SSH connection queries replaced with explicit `id, connection_string, username, host, port, auth_method, display_name, last_used_at, created_at`
- `websocket/streaming.rs`: `stop_remote_stream` was a no-op returning `Ok(())`; now calls `crate::process::remote::kill_remote_process(handle).await` which signals the poll loop to stop naturally
- `ipc/settings_handlers.rs`: Extracted private `upsert_imported_tasks(tx, project_id, import_source, items, now)` helper; both `sync_github_issues` and `sync_jira_issues` build a `Vec<(String, String, String)>` and call the shared helper, eliminating ~80 lines of duplicated upsert logic

## Deviations from Plan

None — plan executed exactly as written.

## Verification

- `cargo check`: PASS (finished in <1s)
- `cargo test`: PASS (5 tests: schema init, settings load/save, DB init, TypeScript bindings generation)
- All LOW severity findings resolved: L2, L3, L4, L5, L6, L7, L9, L10
- M14 sync upsert DRY: resolved

## Known Stubs

None.

## Self-Check: PASSED

- All key files: FOUND
- Commits d86df85 and 3e1b369: FOUND
- cargo check: PASS
- cargo test: 5/5 pass
