---
phase: 33-tauri-backend-code-review-and-refactoring-for-maintainability-dry-solid-kiss
plan: "01"
subsystem: backend
tags: [refactor, dry, solid, kiss, review-handlers, rust, typescript]
dependency_graph:
  requires: []
  provides: [typed-review-ipc-returns, dry-review-insert-helper, rust-git-worktree-deletion]
  affects: [src-tauri/src/ipc/review_handlers.rs, src-tauri/src/models/review.rs, src/types/bindings.ts]
tech_stack:
  added: []
  patterns: [INSERT OR REPLACE for UNIQUE constraint, last_insert_rowid, JOIN queries, git dispatcher]
key_files:
  created: []
  modified:
    - src-tauri/src/ipc/review_handlers.rs
    - src-tauri/src/models/review.rs
    - src-tauri/src/models/mod.rs
    - src/types/bindings.ts
decisions:
  - "INSERT OR REPLACE handles UNIQUE(task_id) constraint on task_reviews — CASCADE-deletes old review_comments automatically"
  - "finalize_successful_merge resolves git_conn internally (no repo_path param) — cleaner separation of concerns"
  - "Branch deletion stays as inline tokio::process::Command (non-fatal) since git dispatcher has no delete_branch"
  - "get_diff_for_review local path: uses GitConnection::Local constructor directly (no get_git_connection call needed)"
metrics:
  duration: "0.07h"
  completed: "2026-03-31"
  tasks_completed: 2
  files_modified: 4
---

# Phase 33 Plan 01: Review Handlers DRY/SOLID Refactoring Summary

Refactored review_handlers.rs eliminating 6 DRY/SOLID violations: extracted shared insert helper, replaced serde_json::Value returns with typed structs, fixed partial Project construction, consolidated queries with JOINs, and replaced Node.js sidecar worktree deletion with Rust git dispatcher.

## Tasks Completed

| # | Task | Commit | Files |
|---|------|--------|-------|
| 1 | Extract insert_review_with_comments, fix queries, replace sidecar | 0e35d85 | review_handlers.rs |
| 2 | Add ReviewResult/MergeResult structs, replace Value returns, regenerate bindings | 8b70004 | review.rs, mod.rs, bindings.ts |

## What Was Built

### Task 1: DRY Helper + Query Consolidation + Sidecar Replacement

**insert_review_with_comments helper (R1 + R2):**
- Private fn shared by `save_task_review` and `request_changes`
- Uses `INSERT OR REPLACE INTO task_reviews` to handle `UNIQUE(task_id)` constraint
- `ON DELETE CASCADE` on `review_comments` cleans up old comments automatically
- `conn.last_insert_rowid()` replaces post-insert `SELECT id FROM task_reviews WHERE task_id`

**get_diff_for_review query consolidation (R4):**
- Single `JOIN tasks t JOIN projects p JOIN worktrees w WHERE t.id = ?` replaces 3 separate queries
- Full `Project` struct constructed from query results — no more `name: String::new()` placeholders

**approve_task_and_merge query consolidation (R6):**
- Single JOIN query gets task, worktree, and project in one DB lock
- `JOIN projects p ON p.id = t.project_id` eliminates second `SELECT path FROM projects WHERE id = ?`

**finalize_successful_merge sidecar replacement (R5):**
- Removed `tokio::process::Command::new("node") --delete-worktree` sidecar call
- Replaced with `crate::git::delete_worktree(&git_conn, worktree_path)` Rust dispatcher
- `git_conn` resolved via `get_project_with_git_conn(app_state, project_id)` internally
- `repo_path` parameter removed from `finalize_successful_merge` signature
- Branch deletion uses inline `tokio::process::Command git branch -D` (non-fatal, no `crate::git::delete_branch`)

### Task 2: Typed IPC Returns + TypeScript Bindings

**ReviewResult and MergeResult structs:**
- `ReviewResult { success: bool, review_id: i32, task_status: Option<String> }` — for `save_task_review` and `request_changes`
- `MergeResult { success: bool, task_status: String, conflicts: Vec<String> }` — for `approve_task_and_merge`
- Both exported via `#[specta(export)]` and re-exported from `models/mod.rs`

**IPC command return type changes:**
- `save_task_review`: `Result<serde_json::Value, String>` → `Result<ReviewResult, String>`
- `request_changes`: `Result<serde_json::Value, String>` → `Result<ReviewResult, String>`
- `approve_task_and_merge`: `Result<serde_json::Value, String>` → `Result<MergeResult, String>`

**TypeScript bindings regenerated:**
- `src/types/bindings.ts` now includes `ReviewResult` and `MergeResult` types
- All three IPC commands return typed `Result<ReviewResult, string>` / `Result<MergeResult, string>`

## Verification Results

- `cargo check`: 0 errors, 0 warnings
- `pnpm tauri:gen`: 1 test passed (generate_typescript_bindings)
- `pnpm build`: built in 3.40s, 0 TypeScript errors
- `grep INSERT OR REPLACE INTO task_reviews`: 1 match
- `grep insert_review_with_comments`: 3 matches (definition + 2 call sites)
- `grep serde_json::Value`: 0 matches in review_handlers.rs
- `grep serde_json::json!`: 0 matches in review_handlers.rs
- `grep --delete-worktree`: 0 matches in review_handlers.rs
- `grep String::new()`: 0 matches in review_handlers.rs
- `grep ReviewResult` in bindings.ts: 5 matches
- `grep MergeResult` in bindings.ts: 3 matches

## Deviations from Plan

None - plan executed exactly as written.

One note: the `--merge` sidecar call in `approve_task_and_merge` is intentionally kept. The plan only specifies replacing `--delete-worktree` (which was done). The `--get-diff` local path was also updated to use the git dispatcher directly instead of `sidecar/dist/index.js --get-diff`.

## Known Stubs

None. All changes are functional implementations.

## Self-Check: PASSED

Files exist:
- src-tauri/src/ipc/review_handlers.rs: FOUND
- src-tauri/src/models/review.rs: FOUND
- src-tauri/src/models/mod.rs: FOUND
- src/types/bindings.ts: FOUND

Commits exist:
- 0e35d85: FOUND (refactor(33-01))
- 8b70004: FOUND (feat(33-01))
