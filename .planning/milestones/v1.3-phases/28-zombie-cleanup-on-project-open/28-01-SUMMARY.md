---
phase: 28-zombie-cleanup-on-project-open
plan: "01"
subsystem: worktree-lifecycle
tags: [rust, ipc, tanstack-query, cleanup, automation]
dependency_graph:
  requires: []
  provides: [cleanup_zombie_worktrees-ipc, useCleanupZombieWorktreesMutation-hook]
  affects: [worktree.service.ts, App.tsx, bindings.ts]
tech_stack:
  added: []
  patterns: [mutex-scoped-block, best-effort-cleanup, silent-mutation]
key_files:
  created: []
  modified:
    - src-tauri/src/ipc/worktree_handlers.rs
    - src-tauri/src/lib.rs
    - src/services/worktree.service.ts
    - src/App.tsx
    - src/types/bindings.ts
decisions:
  - "Scoped closure pattern for Rust SQLite query to satisfy borrow checker (conn + stmt lifetime)"
  - "Candidate filtering done in Rust after lock release — avoids holding Mutex across async git calls"
  - "silent mutation: onError logs to console but no toast — zombie cleanup is background housekeeping"
  - "useEffect dependency [currentProject?.id] fires on project switch, not on every render"
metrics:
  duration: "0.05h"
  completed: "2026-03-30"
  tasks: 2
  files: 5
---

# Phase 28 Plan 01: Zombie Worktree Cleanup on Project Open Summary

Automatic zombie worktree cleanup triggered on project open: new `cleanup_zombie_worktrees` IPC Rust command with 10-minute threshold, Done/Cancelled status filter, running-execution guard, disk confirmation, and a silent TanStack Query mutation hook wired via `useEffect` in App.tsx.

## Tasks Completed

| # | Task | Commit | Files |
|---|------|--------|-------|
| 1 | Add cleanup_zombie_worktrees IPC command + register in lib.rs | 2fbdcf4 | worktree_handlers.rs, lib.rs, bindings.ts |
| 2 | Add useCleanupZombieWorktreesMutation hook + wire App.tsx useEffect | 4a204fe | worktree.service.ts, App.tsx |

## Acceptance Criteria Verification

- worktree_handlers.rs contains `pub async fn cleanup_zombie_worktrees(` — PASS
- worktree_handlers.rs contains `#[tauri::command]` and `#[specta::specta]` — PASS
- worktree_handlers.rs contains `Duration::minutes(10)` for time threshold — PASS
- worktree_handlers.rs contains `t.status IN ('Done', 'Cancelled')` — PASS
- worktree_handlers.rs contains `AND NOT EXISTS` running-execution guard — PASS
- worktree_handlers.rs contains `crate::git::list_worktrees_local` — PASS
- worktree_handlers.rs contains `crate::git::delete_worktree` — PASS
- worktree_handlers.rs contains `DELETE FROM worktrees WHERE id = ?` — PASS
- worktree_handlers.rs returns `Result<i32, String>` — PASS
- lib.rs contains `crate::ipc::cleanup_zombie_worktrees` — PASS
- `cargo check` exits 0 — PASS
- bindings.ts contains `cleanupZombieWorktrees` — PASS
- worktree.service.ts contains `export function useCleanupZombieWorktreesMutation()` — PASS
- worktree.service.ts contains `api.cleanupZombieWorktrees(projectId, repoPath)` — PASS
- worktree.service.ts contains `queryClient.invalidateQueries({ queryKey: worktreeQueryKeys.all })` — PASS
- worktree.service.ts contains `console.error("[DEBUG] cleanup_zombie_worktrees failed:"` — PASS
- App.tsx contains `import { useCleanupZombieWorktreesMutation }` — PASS
- App.tsx contains `const cleanupZombiesMutation = useCleanupZombieWorktreesMutation()` — PASS
- App.tsx contains `cleanupZombiesMutation.mutate({` inside a useEffect — PASS
- App.tsx contains `[currentProject?.id]` as the dependency array — PASS
- `pnpm build` exits 0 — PASS

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Rust borrow checker lifetime error for scoped stmt**
- **Found during:** Task 1 (first cargo check)
- **Issue:** `stmt` borrows `conn`; using `?` to propagate the `query_map` error caused the borrow checker to complain that `stmt` might outlive `conn` within the block
- **Fix:** Wrapped the prepare+query_map chain in an immediately-invoked closure `(|| { ... })()` that produces `Result<Vec<...>, String>`, so all borrows are resolved before the closure returns. `result?` then propagates the error outside the block.
- **Files modified:** src-tauri/src/ipc/worktree_handlers.rs
- **Commit:** 2fbdcf4

## Known Stubs

None — all data flows are wired. The mutation calls the real IPC command, and cache invalidation targets `worktreeQueryKeys.all`.

## Self-Check: PASSED
