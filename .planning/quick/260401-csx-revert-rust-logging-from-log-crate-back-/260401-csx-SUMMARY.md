---
phase: quick
plan: 260401-csx
subsystem: backend
tags: [logging, rust, cleanup, eprintln]
key-files:
  modified:
    - src-tauri/src/main.rs
    - src-tauri/src/models/task.rs
    - src-tauri/src/ipc/execution_handlers.rs
    - src-tauri/src/ipc/filesystem_handlers.rs
    - src-tauri/src/ipc/project_handlers.rs
    - src-tauri/src/ipc/review_handlers.rs
    - src-tauri/src/ipc/settings_handlers.rs
    - src-tauri/src/ipc/ssh_handlers.rs
    - src-tauri/src/ipc/task_handlers.rs
    - src-tauri/src/ipc/worktree_handlers.rs
    - src-tauri/src/process/remote.rs
    - src-tauri/src/websocket/streaming.rs
    - src-tauri/Cargo.toml
decisions:
  - "eprintln! replaces log:: macros — direct stderr output always visible, no backend needed"
  - "log and env_logger crates removed — no dead dependencies remain"
metrics:
  duration: 0.05h
  completed: "2026-04-01T09:19:53Z"
  tasks: 2
  files: 13
---

# Quick Task 260401-csx: Revert Rust Logging from log Crate Back to eprintln!

**One-liner:** Replaced 148 log:: macro calls with eprintln! across 12 Rust source files and removed the log + env_logger crate dependencies from Cargo.toml.

## What Was Done

All `log::info!`, `log::warn!`, `log::debug!`, and `log::error!` calls across `src-tauri/src/` were replaced with direct `eprintln!` calls. The `env_logger::init()` call in `main.rs` was also removed since no logger backend is needed. Both `log = "0.4"` and `env_logger = "0.11"` were removed from `Cargo.toml`.

**Rationale:** Log output from the `log` crate routes through `env_logger` and is invisible when running the compiled Tauri executable unless `RUST_LOG` is explicitly set. `eprintln!` writes directly to stderr and is always visible in the terminal used to launch the app via `pnpm tauri:dev`.

## Tasks Completed

| Task | Description | Commit |
|------|-------------|--------|
| 1 | Replace all log:: macro calls with eprintln! (12 files, 148 calls) | 3551a82 |
| 2 | Remove log and env_logger from Cargo.toml; cargo check clean | 670705a |

## Verification

- Zero `log::` macro calls remain in `src-tauri/src/` (excluding unrelated `execution_log` strings)
- `env_logger::init()` removed from `main.rs`
- `log = "0.4"` and `env_logger = "0.11"` absent from `Cargo.toml`
- `cargo check` exits 0 with no errors

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

None.

## Self-Check: PASSED

- Commits 3551a82 and 670705a confirmed in git log
- Cargo.toml verified: no log/env_logger lines
- cargo check: Finished dev profile with no errors
