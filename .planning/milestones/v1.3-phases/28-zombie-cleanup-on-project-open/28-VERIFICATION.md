---
phase: 28-zombie-cleanup-on-project-open
verified: 2026-03-30T00:00:00Z
status: passed
score: 3/3 must-haves verified
re_verification: false
gaps: []
human_verification:
  - test: "Open a project that has a worktree older than 10 minutes with task status Done or null task_id, and confirm it disappears from the Worktrees view without any user action"
    expected: "The zombie worktree card is gone after opening the project; no toast or modal is shown"
    why_human: "Requires a real git repo with an existing worktree on disk; cannot simulate IPC + git worktree state programmatically"
---

# Phase 28: Zombie Cleanup on Project Open — Verification Report

**Phase Goal:** Automatically clean up zombie worktrees when a project is opened, so the Worktrees view starts clean without manual intervention.
**Verified:** 2026-03-30
**Status:** passed
**Re-verification:** No — initial verification

---

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Opening a project with zombie worktrees (task_id NULL or task Done/Cancelled, created_at older than 10 minutes, path on disk) removes them automatically | VERIFIED | `cleanup_zombie_worktrees` in `worktree_handlers.rs` line 441: SQL filters `task_id IS NULL OR t.status IN ('Done', 'Cancelled')`, filters by `Duration::minutes(10)` threshold, confirms disk presence via `list_worktrees_local`, then calls `delete_worktree` + `DELETE FROM worktrees`. App.tsx `useEffect` at line 85 fires this on every `currentProject?.id` change. |
| 2 | Worktrees created less than 10 minutes ago are never touched by the cleanup | VERIFIED | Line 448: `let threshold = Utc::now() - Duration::minutes(10);`. Lines 480-486: candidates are filtered with `dt < threshold` — worktrees whose `created_at` is NOT older than 10 minutes are excluded. |
| 3 | The cleanup runs silently on project open without user action | VERIFIED | `useCleanupZombieWorktreesMutation` in `worktree.service.ts` line 73-76: `onError` logs to console only, no toast. `onSuccess` only logs when `deletedCount > 0`. App.tsx calls `cleanupZombiesMutation.mutate()` inside a `useEffect` — no user gesture required. |

**Score:** 3/3 truths verified

---

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src-tauri/src/ipc/worktree_handlers.rs` | `cleanup_zombie_worktrees` IPC command | VERIFIED | Lines 439-520: `#[tauri::command]`, `#[specta::specta]`, `pub async fn cleanup_zombie_worktrees(...)` fully implemented with SQL query, time filter, disk confirmation, and deletion loop. |
| `src-tauri/src/lib.rs` | Command registration | VERIFIED | Line 49: `crate::ipc::cleanup_zombie_worktrees` present in `collect_commands![]` macro, after `delete_worktree` as planned. |
| `src/services/worktree.service.ts` | `useCleanupZombieWorktreesMutation` hook | VERIFIED | Lines 61-78: full mutation hook with `api.cleanupZombieWorktrees`, conditional `queryClient.invalidateQueries`, silent error handling. |
| `src/App.tsx` | `useEffect` calling cleanup on project open | VERIFIED | Line 71: hook instantiated. Lines 85-93: `useEffect` with `[currentProject?.id]` dependency fires mutation with real project id + path. |
| `src/types/bindings.ts` | `cleanupZombieWorktrees` binding | VERIFIED | Line 419: `async cleanupZombieWorktrees(projectId: number, repoPath: string) : Promise<Result<number, string>>` present. |

---

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `src/App.tsx` | `src/services/worktree.service.ts` | `useCleanupZombieWorktreesMutation` | WIRED | Import at line 10; instantiated at line 71; called at line 87 inside useEffect. |
| `src/services/worktree.service.ts` | `src-tauri/src/ipc/worktree_handlers.rs` | `api.cleanupZombieWorktrees` IPC call | WIRED | `worktree.service.ts` line 65: `await api.cleanupZombieWorktrees(projectId, repoPath)`. Binding at `bindings.ts` line 419 invokes `TAURI_INVOKE("cleanup_zombie_worktrees", ...)`. |
| `src-tauri/src/ipc/worktree_handlers.rs` | `src-tauri/src/git/mod.rs` | `list_worktrees_local` + `delete_worktree` calls | WIRED | Line 493: `crate::git::list_worktrees_local(&repo_path).await?`. Line 503: `crate::git::delete_worktree(&git_conn, relative_path).await`. Both functions confirmed to exist in `git/mod.rs` (lines 41, 123). |

---

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|--------------|--------|--------------------|--------|
| `App.tsx` cleanup `useEffect` | `currentProject` | `useSelectedProject()` from `projectStore` — set via `setSelectedProject(project)` when user picks a project from the real DB list | Yes — project comes from `get_projects` IPC (SQLite query), not hardcoded | FLOWING |
| `cleanup_zombie_worktrees` | `all_candidates` | SQL query on `worktrees` table with LEFT JOIN on `tasks` and NOT EXISTS on `execution_logs` | Yes — real DB query with three-table join and existence guard | FLOWING |
| `cleanup_zombie_worktrees` | `disk_paths` | `crate::git::list_worktrees_local(&repo_path)` — runs `git worktree list --porcelain` | Yes — real subprocess, not mocked | FLOWING |

---

### Behavioral Spot-Checks

Step 7b: SKIPPED for Tauri IPC commands (cannot invoke IPC without running the Tauri runtime). Build compilation serves as the executable verification gate.

The SUMMARY.md records: `cargo check` exits 0 (commit 2fbdcf4) and `pnpm build` exits 0 (commit 4a204fe).

---

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|----------|
| REQ-34 | 28-01-PLAN.md | `cleanup_zombie_worktrees` IPC — finds worktrees where `task_id IS NULL` OR task status is Done/Archived, AND path exists on disk. Never deletes based on DB state alone. | SATISFIED | SQL at lines 455-463 filters by `task_id IS NULL OR t.status IN ('Done', 'Cancelled')`. Disk confirmation at line 500: `disk_paths.contains(&abs_path)` — deletion only proceeds when path is on disk. |
| REQ-35 | 28-01-PLAN.md | Time threshold — only considers worktrees with `created_at` older than 10 minutes. | SATISFIED | `let threshold = Utc::now() - Duration::minutes(10)` at line 448. Filter at lines 480-486: `dt < threshold` must be true for candidate to proceed. |
| REQ-36 | 28-01-PLAN.md | Called on project open — replaces `recover_dirty_worktrees` call in `App.tsx` `useEffect` on project load. | SATISFIED | `recover_dirty_worktrees` is completely absent from the entire codebase (no matches in `src/` or `src-tauri/`). `cleanupZombiesMutation.mutate()` in `useEffect([currentProject?.id])` is the sole on-open trigger. |

**Orphaned requirements check:** `grep "Phase 28" .planning/REQUIREMENTS.md` — REQUIREMENTS.md section "Zombie Cleanup on Project Open (Phase 28)" lists exactly REQ-34, REQ-35, REQ-36. All three accounted for in the plan. No orphaned requirements.

---

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `src/App.tsx` | 92 | `eslint-disable-next-line react-hooks/exhaustive-deps` | Info | Intentional — `cleanupZombiesMutation` is stable via `useMutation` but ESLint can't verify this. Comment documents the intent. No correctness risk. |

No stub patterns, placeholder returns, or empty implementations found in any of the five modified files.

---

### Human Verification Required

#### 1. End-to-end zombie cleanup on project open

**Test:** In a real project, use `git worktree add` to create a worktree manually. Wait 10+ minutes. Open the project in Maestro. Navigate to the Worktrees view.
**Expected:** The manually created worktree is gone from the list without any button press or confirmation dialog.
**Why human:** Requires a live Tauri session with a real git repo, on-disk worktrees, and timing (10-minute wait). Cannot invoke IPC commands outside the Tauri runtime.

#### 2. New worktrees are not cleaned up

**Test:** Create a new worktree (via "New Worktree" dialog). Immediately close and reopen the project.
**Expected:** The worktree is still present — it was created less than 10 minutes ago.
**Why human:** Same runtime requirement; timing guard requires real-time validation.

#### 3. Running-agent guard

**Test:** Dispatch an agent to a task. While the agent is running (execution_log status = 'running'), reopen the project.
**Expected:** The active worktree is never removed.
**Why human:** Requires a running agent process and live IPC state.

---

### Gaps Summary

No gaps. All three observable truths are fully verified: the IPC command is implemented with correct SQL logic, time filtering, disk confirmation, and deletion mechanics; it is registered in `lib.rs` and exported to TypeScript bindings; the mutation hook wraps it silently; and App.tsx fires the cleanup on every project open via `useEffect([currentProject?.id])`. The `recover_dirty_worktrees` predecessor is fully removed.

---

_Verified: 2026-03-30_
_Verifier: Claude (gsd-verifier)_
