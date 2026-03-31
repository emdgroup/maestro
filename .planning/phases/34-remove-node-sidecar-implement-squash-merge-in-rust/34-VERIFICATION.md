---
phase: 34-remove-node-sidecar-implement-squash-merge-in-rust
verified: 2026-03-31T14:30:00Z
status: passed
score: 9/9 must-haves verified
re_verification: false
gaps: []
---

# Phase 34: Remove Node.js Sidecar / Squash Merge in Rust — Verification Report

**Phase Goal:** Remove the Node.js sidecar entirely and implement squash merge natively in Rust.
**Verified:** 2026-03-31T14:30:00Z
**Status:** passed
**Re-verification:** No — initial verification

---

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Squash merge to main works via native Rust subprocess calls (no Node.js) | VERIFIED | `squash_merge_to_main` in `git/mod.rs:360` runs `git checkout`, `git merge --squash --no-commit`, `git status --porcelain`, `git commit` via `TokioCommand` |
| 2 | `approve_task_and_merge` IPC calls `git::squash_merge_to_main` instead of Node.js sidecar | VERIFIED | `review_handlers.rs:220` — `git::squash_merge_to_main(...)` call; no `Command::new("node")` present |
| 3 | Merge conflicts are detected and reported with conflict file list | VERIFIED | `parse_conflict_files` at `git/mod.rs:443` parses XY codes (`U`, `AA`, `DD`); conflict path returns to caller via `MergeResult.conflicts` |
| 4 | Successful merge produces a commit with correct message format | VERIFIED | `git/mod.rs:416-419` — `format!("Merge task #{}: {}\n\nAll agent commits squashed into single commit.", task_id, task_name)` |
| 5 | No dead sidecar code remains in the Rust backend | VERIFIED | `run_agent_background_task` gone, `spawn_agent_cli` gone, `spawn_agent_execution` IPC gone from execution_handlers.rs and collect_commands; `MergeOutcome` model deleted |
| 6 | `sidecar/` directory is completely removed from the repository | VERIFIED | `test ! -d sidecar` confirms directory absent |
| 7 | No sidecar references remain in Rust comments or doc strings | VERIFIED | `grep -rn "sidecar" src-tauri/src/` returns zero matches |
| 8 | `cargo check` passes after all deletions | VERIFIED | `cargo check` exits 0 — `Finished dev profile` in 0.95s |
| 9 | `spawn_agent_execution` IPC command is removed from Tauri command registration | VERIFIED | Not present in `collect_commands![]` in `lib.rs`; not in `execution_handlers.rs`; `process/mod.rs` retains only the internal dispatcher function (intentionally preserved per plan interfaces) |

**Score:** 9/9 truths verified

---

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src-tauri/src/git/mod.rs` | `squash_merge_to_main` function and `parse_conflict_files` helper | VERIFIED | `pub async fn squash_merge_to_main` at line 360; `fn parse_conflict_files` at line 443; `use crate::models::MergeResult` at line 5 |
| `src-tauri/src/ipc/review_handlers.rs` | Updated `approve_task_and_merge` calling `git::squash_merge_to_main` | VERIFIED | `git::squash_merge_to_main` call at line 220; no `MergeOutcome`, no `serde_json::from_str`, no Node.js invocation; doc comment updated at line 182 |
| `src-tauri/src/lib.rs` | Updated command registration without `spawn_agent_execution` | VERIFIED | `collect_commands![]` contains `approve_task_and_merge` but not `spawn_agent_execution`; `spawn_agent_cli` absent from `pub use process::` line |
| `src-tauri/src/process/spawner.rs` | `ProcessOutput` struct only (spawn_agent_cli deleted) | VERIFIED | File is 9 lines; contains only `ProcessOutput` struct definition |
| `src-tauri/src/models/merge_outcome.rs` | Deleted | VERIFIED | File does not exist |

---

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `src-tauri/src/ipc/review_handlers.rs` | `src-tauri/src/git/mod.rs` | `git::squash_merge_to_main` call | WIRED | Call at line 220; `MergeResult` returned and used in success/conflict branches (lines 227-248) |
| `src-tauri/src/git/mod.rs` | `src-tauri/src/models/review.rs` | `MergeResult` return type | WIRED | `use crate::models::MergeResult` at line 5; used as return type and in `Ok(MergeResult { ... })` at lines 403, 432 |
| `src-tauri/src/lib.rs` | `src-tauri/src/process/mod.rs` | `pub use process::` — `spawn_agent_cli` removed | VERIFIED | `lib.rs:11` — `pub use process::{ProcessOutput, spawn_agent_cli_pty, PtySession};` — `spawn_agent_cli` absent |

---

### Data-Flow Trace (Level 4)

`squash_merge_to_main` is a pure subprocess orchestrator — it does not render data but produces a `MergeResult` that flows to the frontend via the IPC return. The data flow is:

| Step | What Happens | Verified |
|------|-------------|---------|
| `approve_task_and_merge` invoked | DB JOIN query fetches `task_name`, `branch_name`, `repo_path` | Yes — lines 197-208 of review_handlers.rs |
| `git::squash_merge_to_main` called | Real git subprocess sequence runs against local repo path | Yes — TokioCommand calls confirmed in git/mod.rs |
| `MergeResult` returned | `success`, `task_status`, `conflicts` populated from actual git output | Yes — conflict parsing uses real `git status --porcelain` stdout |
| Result returned to frontend | IPC returns `Ok(MergeResult)` | Yes — lines 239, 244 of review_handlers.rs |

**Status: FLOWING** — real git subprocess output drives all result fields.

---

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Rust compiles with all changes | `cargo check` in `src-tauri/` | `Finished dev profile in 0.95s` | PASS |
| No sidecar dir | `test ! -d sidecar` | Exit 0 | PASS |
| Zero sidecar refs in Rust src | `grep -rn "sidecar" src-tauri/src/` | No output | PASS |
| `spawn_agent_execution` absent from collect_commands | Manual scan of `lib.rs` | Not present | PASS |
| `MergeOutcome` fully removed | `grep -rn "MergeOutcome" src-tauri/src/` | No output | PASS |
| TS bindings clean | `grep "spawn_agent_execution\|MergeOutcome" src/types/bindings.ts` | No output | PASS |

---

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|---------|
| SM-01 | 34-01 | Squash merge implemented in native Rust | SATISFIED | `squash_merge_to_main` in git/mod.rs with full subprocess sequence |
| SM-02 | 34-01 | Node.js sidecar no longer invoked at runtime | SATISFIED | `review_handlers.rs` — no `Command::new("node")` |
| SM-03 | 34-02 | Dead sidecar code removed from Rust backend | SATISFIED | `run_agent_background_task`, `spawn_agent_cli`, `spawn_agent_execution` IPC, `MergeOutcome` all deleted |
| SM-04 | 34-02 | `sidecar/` directory deleted | SATISFIED | Directory absent from filesystem |
| SM-05 | 34-02 | TypeScript bindings regenerated without deleted items | SATISFIED | `bindings.ts` contains neither `spawn_agent_execution` nor `MergeOutcome` |

---

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `src-tauri/src/process/mod.rs` | 34 | `todo!("Local agent spawning via process/mod is not yet implemented...")` | Info | Pre-existing stub in the internal dispatcher function — not in the IPC path. The todo references an alternative code path (`ipc::execution_handlers::spawn_agent_execution`) that has now been removed, making the comment slightly stale. Does not block phase goal. |
| `src/services/execution.service.ts` | 49 | Throws instead of implementing | Info | Intentional — documented deviation from plan. `useSpawnExecutionMutation` throws an informative error. Dead code path, no active caller. |
| `src/store/boardStore.ts` | 61 | Throws instead of implementing | Info | Same as above — `executeTask` throws informative error. Dead code path. |

No blockers. The `todo!` in `process/mod.rs:34` is a pre-existing limitation, not introduced by this phase, and does not affect the squash merge workflow.

---

### Human Verification Required

None required. All observable truths are fully verifiable programmatically.

---

### Gaps Summary

No gaps. All 9 must-have truths are verified against the actual codebase:

- `squash_merge_to_main` is fully implemented and substantive (checkout → squash merge → status → conflict check → commit).
- `approve_task_and_merge` is wired to it with correct `MergeResult` handling.
- All dead sidecar code is deleted: `run_agent_background_task`, `spawn_agent_cli`, `spawn_agent_execution` IPC, `MergeOutcome` model and file.
- `sidecar/` directory is gone.
- Zero sidecar references remain in Rust source.
- `cargo check` passes.
- TypeScript bindings are clean.

Phase 34 goal is **achieved**.

---

_Verified: 2026-03-31T14:30:00Z_
_Verifier: Claude (gsd-verifier)_
