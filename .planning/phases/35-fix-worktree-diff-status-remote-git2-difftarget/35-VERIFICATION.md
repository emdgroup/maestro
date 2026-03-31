---
phase: 35-fix-worktree-diff-status-remote-git2-difftarget
verified: 2026-03-31T00:00:00Z
status: passed
score: 7/7 must-haves verified
re_verification: false
---

# Phase 35: Fix Worktree Diff/Status, Remove git2, Add DiffTarget — Verification Report

**Phase Goal:** Fix worktree diff/status for remote SSH worktrees, remove git2 dependency, add DiffTarget model for uncommitted vs branch diffs
**Verified:** 2026-03-31
**Status:** passed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| #  | Truth                                                                               | Status     | Evidence                                                                                                    |
|----|-------------------------------------------------------------------------------------|------------|-------------------------------------------------------------------------------------------------------------|
| 1  | `get_worktree_diff` works for both local and remote SSH projects                    | VERIFIED   | Uses `run_git_in_dir` dispatcher which handles both `GitConnection::Local` and `GitConnection::Remote` paths |
| 2  | `get_worktree_diff` accepts a `DiffTarget` parameter to choose HEAD vs branch diff  | VERIFIED   | Signature: `get_worktree_diff(app_state, worktree_id: i32, diff_target: DiffTarget)` at line 215            |
| 3  | `list_worktrees_with_status` shows git status and diff_stat for remote worktrees    | VERIFIED   | Step 5 comment: "local AND remote"; `is_remote` gate removed from `list_worktrees_with_status`             |
| 4  | git2 crate is removed from Cargo.toml                                               | VERIFIED   | No `git2` in `Cargo.toml`; `grep -r "git2::" src-tauri/src/` returns 0 results                            |
| 5  | User can toggle between Uncommitted (HEAD) and Branch diff modes in the UI          | VERIFIED   | `diffMode` state in `WorktreeManager.tsx` with `ToggleGroupItem` for "uncommitted" and "branch"            |
| 6  | Branch diff mode shows a branch input pre-populated with worktree's branch_name     | VERIFIED   | `useEffect` at line 110 sets `diffBranch` from `selectedWorktree.branch_name` on selection change          |
| 7  | Changing diff target re-fetches the diff via the updated IPC call                   | VERIFIED   | `diffTarget` included in `worktreeQueryKeys.diff` key tuple — cache miss triggers re-fetch on mode change  |

**Score:** 7/7 truths verified

### Required Artifacts

| Artifact                                           | Expected                                         | Status   | Details                                                                                    |
|----------------------------------------------------|--------------------------------------------------|----------|--------------------------------------------------------------------------------------------|
| `src-tauri/src/models/diff.rs`                     | DiffTarget enum                                  | VERIFIED | `pub enum DiffTarget { Head, Branch(String) }` with `#[derive(Type)]` + `#[specta(export)]` |
| `src-tauri/src/models/mod.rs`                      | Module + re-export for diff                      | VERIFIED | `pub mod diff;` (line 11) and `pub use diff::DiffTarget;` (line 23)                       |
| `src-tauri/src/git/mod.rs`                         | run_git_in_dir dispatcher                        | VERIFIED | `pub async fn run_git_in_dir(conn, abs_path, args)` at line 151; handles Local+Remote      |
| `src-tauri/src/ipc/worktree_handlers.rs`           | Rewritten get_worktree_diff + remote list status | VERIFIED | `diff_target: DiffTarget` at line 218; `run_git_in_dir` called 4 times (2 per function)    |
| `src/types/bindings.ts`                            | Generated DiffTarget TypeScript type             | VERIFIED | `export type DiffTarget = { type: "Head" } | { type: "Branch"; branch: string }` (line 1017) |
| `src/services/worktree.service.ts`                 | useWorktreeDiffQuery accepting DiffTarget        | VERIFIED | `diffTarget: DiffTarget` parameter, passed to `api.getWorktreeDiff`                        |
| `src/components/execution/WorktreeManager.tsx`     | Diff target toggle UI and state                  | VERIFIED | `diffMode` + `diffBranch` state, `diffTarget: DiffTarget` computed, `ToggleGroupItem` x2   |

### Key Link Verification

| From                                            | To                                              | Via                            | Status   | Details                                                                            |
|-------------------------------------------------|-------------------------------------------------|--------------------------------|----------|------------------------------------------------------------------------------------|
| `src-tauri/src/ipc/worktree_handlers.rs`        | `src-tauri/src/git/mod.rs`                      | `crate::git::run_git_in_dir`   | WIRED    | Called at lines 111, 114 (list_worktrees) and lines 245, 249 (get_worktree_diff)   |
| `src-tauri/src/ipc/worktree_handlers.rs`        | `src-tauri/src/models/diff.rs`                  | `DiffTarget` parameter         | WIRED    | Imported via `use crate::models::{..., DiffTarget}` at line 6; used in fn signature |
| `src/components/execution/WorktreeManager.tsx`  | `src/services/worktree.service.ts`              | `useWorktreeDiffQuery`         | WIRED    | Called at line 123 with `diffTarget` argument                                      |
| `src/services/worktree.service.ts`              | `src/types/bindings.ts`                         | `api.getWorktreeDiff(id, diffTarget)` | WIRED | Import at line 4; `diffTarget` passed directly at line 34                         |
| `src-tauri/src/lib.rs`                          | `src-tauri/src/ipc/worktree_handlers.rs`        | Tauri command registration     | WIRED    | `list_worktrees_with_status` (line 44) and `get_worktree_diff` (line 45) registered |

### Data-Flow Trace (Level 4)

| Artifact                                    | Data Variable  | Source                                            | Produces Real Data | Status   |
|---------------------------------------------|----------------|---------------------------------------------------|--------------------|----------|
| `WorktreeManager.tsx` (diff display)        | `diffString`   | `useWorktreeDiffQuery` → `api.getWorktreeDiff` → Rust IPC → `run_git_in_dir` subprocess | Yes — git process stdout | FLOWING |
| `WorktreeManager.tsx` (git_status/diff_stat) | `worktrees`   | `list_worktrees_with_status` → `run_git_in_dir` per worktree | Yes — parallel git subprocess per worktree | FLOWING |

### Behavioral Spot-Checks

| Behavior                          | Command                                                     | Result                                          | Status |
|-----------------------------------|-------------------------------------------------------------|-------------------------------------------------|--------|
| `cargo check` passes              | `cd src-tauri && cargo check`                               | `Finished dev profile — 0 errors`               | PASS   |
| No git2 in source                 | `grep -r "git2::" src-tauri/src/`                           | 0 results                                       | PASS   |
| DiffTarget in bindings.ts         | `grep "DiffTarget" src/types/bindings.ts`                   | 2 matches (type def + getWorktreeDiff param)    | PASS   |
| run_git_in_dir in both IPC fns    | `grep -n "run_git_in_dir" src-tauri/src/ipc/worktree_handlers.rs` | 4 occurrences across 2 functions           | PASS   |
| TypeScript compilation            | `npx tsc --noEmit`                                          | 0 errors                                        | PASS   |

### Requirements Coverage

Requirements listed in plans: WT-DIFF-01, WT-DIFF-02, WT-DIFF-03 (Plan 01), WT-DIFF-04 (Plan 02).

| Requirement | Source Plan | Description (inferred from plan context)                                     | Status    | Evidence                                                            |
|-------------|-------------|------------------------------------------------------------------------------|-----------|---------------------------------------------------------------------|
| WT-DIFF-01  | 35-01       | `get_worktree_diff` works for both local and remote SSH projects              | SATISFIED | `run_git_in_dir` dispatcher handles both GitConnection variants     |
| WT-DIFF-02  | 35-01       | `list_worktrees_with_status` populates git status + diff_stat for remote SSH  | SATISFIED | Step 5 unified block runs for local AND remote; is_remote gate removed |
| WT-DIFF-03  | 35-01       | git2 dependency removed; DiffTarget model added with TypeScript binding       | SATISFIED | git2 absent from Cargo.toml and all source files; DiffTarget exported |
| WT-DIFF-04  | 35-02       | UI toggle for diff mode (Uncommitted vs Branch) in WorktreeManager           | SATISFIED | ToggleGroupItem x2, diffMode state, diffBranch input, pre-populated |

### Anti-Patterns Found

No blockers or warnings found.

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| — | — | — | — | — |

Stub scan summary:
- `get_worktree_diff` returns live git subprocess output, not hardcoded empty string
- `list_worktrees_with_status` git_info populated from real subprocess results per worktree
- `useWorktreeDiffQuery` `queryFn` calls real API — not a placeholder
- No `TODO`, `FIXME`, or placeholder comments in any phase-35 modified files

### Human Verification Required

### 1. Remote SSH diff end-to-end behavior

**Test:** Open a project connected via SSH. Navigate to the Worktrees tab. Select a worktree with committed changes on its branch. Switch to "Branch diff" mode, verify the diff panel populates with branch changes. Switch to "Uncommitted" mode, verify it shows only working-tree changes (or "No uncommitted changes" if clean).
**Expected:** Both modes return correct diff output; "No uncommitted changes" only appears in Uncommitted mode with a clean working tree.
**Why human:** Requires a live SSH session and a real git repository with known content.

### 2. Diff target toggle re-fetch behavior

**Test:** Open a worktree diff. Observe the diff in "Uncommitted" mode. Switch to "Branch diff" mode. Confirm the loading state triggers and new content renders.
**Expected:** React Query detects a new query key and re-fetches with the correct DiffTarget value; no stale cache serves the old diff.
**Why human:** TanStack Query cache behavior requires runtime observation; key construction looks correct in code but actual deduplication behavior needs visual confirmation.

### 3. Branch input pre-population

**Test:** Click on different worktrees in the list. Observe the branch name input in "Branch diff" mode.
**Expected:** Each worktree selection resets the branch input to that worktree's `branch_name` via the `useEffect`.
**Why human:** React state update timing with `useEffect` needs UI-level observation to confirm no stale value persists.

### Gaps Summary

No gaps. All must-haves from Plan 01 and Plan 02 are present, substantive, wired, and data-flowing.

**Additional bonus fixes verified (deviations from plan, all correct):**
- `src-tauri/src/git/remote.rs`: SSH branch listing uses `--format='%(refname:short)'` for clean output; `get_remote_current_branch` uses `git symbolic-ref --short HEAD` for unborn-branch safety
- `src-tauri/src/ipc/project_handlers.rs`: All 4 `git init` call sites use `-b main`
- `src/components/execution/DiffViewer.tsx`: 25+ languages passed to `getDiffViewHighlighter`

---

_Verified: 2026-03-31_
_Verifier: Claude (gsd-verifier)_
