---
phase: quick-260408-se1
plan: "01"
subsystem: execution
tags: [ipc, worktree, spawn, optimization]
dependency_graph:
  requires: []
  provides: [worktree-id-direct-spawn]
  affects: [AgentsView, execution_handlers, execution.service, TaskCard]
tech_stack:
  added: []
  patterns: [optional-param-fallthrough, db-lookup-over-subprocess]
key_files:
  created: []
  modified:
    - src-tauri/src/ipc/execution_handlers.rs
    - src/types/bindings.ts
    - src/services/execution.service.ts
    - src/views/AgentsView.tsx
    - src/components/kanban/TaskCard.tsx
decisions:
  - "Add worktree_id as last optional param to preserve backward compatibility with None fallthrough"
  - "AgentsView tracks WorktreeWithStatus object (not just branch name) to carry DB id"
  - "TaskCard and onReconnect pass null for worktreeId — branch-name lookup preserved for those paths"
metrics:
  duration: ~0.05h
  completed_date: "2026-04-08T20:37:47Z"
  tasks_completed: 2
  files_modified: 5
---

# Phase quick-260408-se1 Plan 01: Use Selected Worktree Directly in Manual Spawn Summary

**One-liner:** Pass selected worktree DB id from AgentsView spawn dialog to Rust backend, resolving path from SQLite instead of running `git worktree list`.

## Tasks Completed

| # | Task | Commit | Files |
|---|------|--------|-------|
| 1 | Add worktree_id param to Rust IPC, resolve path from DB | 32c910b | execution_handlers.rs |
| 2 | Regenerate bindings, update service + AgentsView + TaskCard | 38935df | bindings.ts, execution.service.ts, AgentsView.tsx, TaskCard.tsx |

## What Was Built

### Rust IPC (`spawn_interactive_execution`)

Added `worktree_id: Option<i32>` parameter after `label`. When `Some(id)` is provided:
- Queries `SELECT path FROM worktrees WHERE id = ?` from SQLite
- Computes absolute path as `{repo_path}/{relative_path}`
- Skips `crate::git::list_worktrees` subprocess entirely

When `None`: existing branch-name lookup + create-if-missing behavior is unchanged.

### Frontend Changes

- `bindings.ts`: regenerated — `spawnInteractiveExecution` now accepts `worktreeId: number | null` as 5th arg
- `execution.service.ts`: `useSpawnInteractiveExecutionMutation` args type extended with optional `worktreeId?: number | null`, forwarded to IPC
- `AgentsView.tsx`: `selectedBranchName: string` state replaced with `selectedWorktree: WorktreeWithStatus | null`; spawn mutate call passes `worktreeId: selectedWorktree.id`; reconnect passes `worktreeId: null`
- `TaskCard.tsx`: direct `api.spawnInteractiveExecution` call gets `null` as 5th arg (branch-name fallback preserved)

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

None.

## Threat Flags

None — no new network endpoints or auth paths introduced.

## Self-Check: PASSED

- `32c910b` exists: `git log --oneline | grep 32c910b` — FOUND
- `38935df` exists: `git log --oneline | grep 38935df` — FOUND
- `execution_handlers.rs` modified: FOUND
- `bindings.ts` updated with worktreeId: FOUND
- `AgentsView.tsx` uses `selectedWorktree`: FOUND
- `TaskCard.tsx` passes null: FOUND
- `cargo check` passed: YES
- `pnpm build` passed: YES
