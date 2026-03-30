---
phase: quick
plan: 260330-tb8
subsystem: execution-views
tags: [bug-fix, worktrees, agents, modal, pty, interactive-session]
completed: "2026-03-30T21:14:54Z"
duration: 0.25h
tasks_completed: 2
files_modified: 8
key-decisions:
  - "Controlled AlertDialog: replace uncontrolled AlertDialog with open/onOpenChange state; close optimistically before mutate call"
  - "Export taskQueryKeys from task.service.ts to allow external invalidation"
  - "list_executions_with_task_info JOIN fix: interactive sessions joined to worktrees by project_id instead of task_id=NULL match"
  - "Terminal retry: single 500ms retry on attach failure covers PTY-not-yet-ready race for interactive sessions"
---

# Quick Task 260330-tb8: Fix Worktrees and Agents View Bugs Summary

Fixed four bugs in Worktrees and Agents views: controlled AlertDialog close, stale branch list invalidation, delete/reconnect session controls, and interactive PTY terminal rendering retry.

## Tasks Completed

### Task 1: Fix WorktreeManager cleanup modal close + stale branches

**Commit:** ba780b0

**Changes:**
- `src/components/execution/WorktreeManager.tsx` — Converted AlertDialog from uncontrolled to controlled using `showDeleteDialog` state. Added `useQueryClient` import and branch invalidation on "New Worktree" click. Removed `AlertDialogTrigger` wrapper; "Clean up" is now a plain `<Button>` that sets `showDeleteDialog(true)`.
- `src/services/task.service.ts` — Added `export` to `taskQueryKeys` declaration so it can be imported by WorktreeManager.

**Bugs fixed:**
1. AlertDialog modal now closes immediately when user confirms deletion (state set to false before mutate call)
2. Branch list is invalidated every time "New Worktree" dialog opens, ensuring fresh data

### Task 2: Add delete/reconnect buttons to AgentMonitor + fix interactive session display

**Commit:** 91c459b

**Changes:**
- `src-tauri/src/ipc/execution_handlers.rs` — Added `delete_execution_log` async IPC command; removes PTY session from `pty_sessions` map then deletes DB row. Also fixed `list_executions_with_task_info` SQL JOIN so interactive sessions (`task_id IS NULL`) are joined to worktrees by `project_id` rather than relying on `NULL = NULL` match.
- `src-tauri/src/lib.rs` — Registered `crate::ipc::delete_execution_log` in `collect_commands!`.
- `src/types/bindings.ts` — Regenerated TypeScript bindings (adds `deleteExecutionLog` to `commands` object).
- `src/services/execution.service.ts` — Added `useDeleteExecutionMutation` hook with `invalidateQueries` + Sonner toast feedback.
- `src/components/execution/AgentMonitor.tsx` — Added `onDelete` and `onReconnect` props. Added session header bar above terminal pane showing session name/status and action buttons: Delete (all sessions), Reconnect (non-running sessions only).
- `src/views/AgentsView.tsx` — Imported `useDeleteExecutionMutation`, wired `onDelete` (mutates + clears selection) and `onReconnect` (pre-fills spawn dialog with branch) props to `AgentMonitor`.
- `src/components/execution/Terminal.tsx` — Added 500ms retry logic on `attachTerminal` failure to handle race where PTY session isn't yet ready when frontend attaches for interactive sessions.

## Deviations from Plan

None - plan executed exactly as written.

## Known Stubs

None.

## Self-Check: PASSED

Commits verified:
- ba780b0 exists: fix WorktreeManager cleanup modal close and stale branches
- 91c459b exists: feat delete/reconnect buttons + interactive session fixes

Files verified:
- src/components/execution/WorktreeManager.tsx - controlled AlertDialog implemented
- src/services/task.service.ts - taskQueryKeys exported
- src-tauri/src/ipc/execution_handlers.rs - delete_execution_log command added
- src-tauri/src/lib.rs - command registered
- src/services/execution.service.ts - useDeleteExecutionMutation added
- src/components/execution/AgentMonitor.tsx - header bar + buttons added
- src/views/AgentsView.tsx - onDelete/onReconnect wired
- src/components/execution/Terminal.tsx - retry logic added

Build: pnpm build PASSED (0 TypeScript errors)
Rust: cargo check PASSED (0 errors)
