# Phase 34: Remove Node.js sidecar — implement squash merge in Rust - Context

**Gathered:** 2026-03-31
**Status:** Ready for planning

<domain>
## Phase Boundary

Replace the Node.js sidecar with native Rust. The only real gap is squash merge — all other sidecar operations are already implemented in Rust or are dead code. Phase delivers:
1. `squash_merge_to_main` implemented in Rust
2. `approve_task_and_merge` callsite updated to use Rust directly (no more `node sidecar/dist/index.js --merge`)
3. Dead code deleted: `run_agent_background_task`, `spawn_agent_cli`, `spawn_agent_execution`
4. `MergeOutcome` struct deleted (was only a sidecar deserialization target)
5. `sidecar/` directory removed entirely
6. All stale sidecar references in Rust comments/strings cleaned up

New capabilities (CLI tool for worktree management, agent scheduling) are separate phases.

</domain>

<decisions>
## Implementation Decisions

### Squash merge implementation
- Use subprocess style (`tokio::process::Command`) — consistent with all existing functions in `git/mod.rs`
- Do NOT use the `git2` crate for this (already vendored but diverges from codebase style)
- Function signature: `squash_merge_to_main(repo_path, task_id, branch_name, task_name) -> Result<MergeResult, String>`
- Lives in `src-tauri/src/git/mod.rs` alongside `create_worktree_local`, `delete_worktree_local`, etc.
- Commit message format: keep sidecar format exactly — `"Merge task #N: <task_name>\n\nAll agent commits squashed into single commit."`
- Returns `MergeResult` directly (not `MergeOutcome`)
- Do NOT add `--function-context` flag to `git_diff_local` — leave diff output as-is

### Dead code cleanup
- Delete `run_agent_background_task` (broken — calls sidecar `--task-id` which exits 1)
- Delete `spawn_agent_cli` in `src-tauri/src/process/spawner.rs` (only purpose was calling the sidecar)
- Delete `spawn_agent_execution` IPC command (only spawned `run_agent_background_task`; verify frontend doesn't call it before deleting)
- The working execution path is `spawn_interactive_execution` → `spawn_agent_cli_pty` — do not touch that

### MergeOutcome model
- Delete `MergeOutcome` struct entirely from `src-tauri/src/models/merge_outcome.rs`
- Delete `merge_outcome.rs` file and its `pub use` in `models/mod.rs`
- `squash_merge_to_main` returns `MergeResult` directly — no intermediate deserialization struct needed
- Frontend uses `MergeResult` (not `MergeOutcome`) — no frontend changes needed

### Sidecar removal
- Delete `sidecar/` directory entirely (including `SIDECAR-RESEARCH.md` inside it)
- No pnpm workspace cleanup needed (no workspace reference exists)
- No `tauri.conf.json` cleanup needed (no sidecar references found)
- No `.gitignore` cleanup needed
- Clean up all stale sidecar references in Rust comments and strings (doc comments in `review_handlers.rs`, `spawner.rs`, `process/mod.rs`, `execution_handlers.rs`)

### Claude's Discretion
- Exact conflict detection logic (which `git status --porcelain` prefixes count as conflicts)
- Whether to add the git SHA retrieval via `git log -1 --format=%H` after squash commit
- How to structure the subprocess error handling (match the existing `git/mod.rs` style)

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Research and existing analysis
- `sidecar/SIDECAR-RESEARCH.md` — Complete feasibility analysis: what the sidecar does, all live callsites, what's already in Rust, gap analysis, migration path, risks. Read this first.

### Live callsite to replace
- `src-tauri/src/ipc/review_handlers.rs` — `approve_task_and_merge` at line ~219 is the only live sidecar callsite. Replace the `tokio::process::Command::new("node")` block with a call to the new `git::squash_merge_to_main`.

### Code to delete
- `src-tauri/src/ipc/execution_handlers.rs` — `run_agent_background_task` (lines 8-58) and the `tokio::spawn` that calls it inside `spawn_agent_execution` (~line 101). Also `spawn_agent_execution` itself is a candidate for deletion.
- `src-tauri/src/process/spawner.rs` — `spawn_agent_cli` function
- `src-tauri/src/models/merge_outcome.rs` — entire file

### Implementation pattern to follow
- `src-tauri/src/git/mod.rs` — All existing git subprocess functions. `squash_merge_to_main` must follow this exact pattern.

### Model used by frontend (do not break)
- `src-tauri/src/models/review.rs` — `MergeResult` struct (the one the frontend receives via IPC — do not remove or modify)

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `git/mod.rs`: `create_worktree_local`, `delete_worktree_local`, `git_diff_local`, `git_status_local` — template pattern for subprocess git operations. Use verbatim style for squash merge.
- `MergeResult` struct in `models/review.rs` — already the right return type for the frontend.
- `tokio::process::Command` pattern throughout `git/mod.rs` — all use `current_dir(repo_path)`, `.output().await`, map stderr to `Err(String)`.

### Established Patterns
- Git operations: subprocess via `tokio::process::Command`, `current_dir` set to repo path, error = stderr string
- IPC handlers call `git::` module functions, do not contain git subprocess logic inline
- `AppState` mutex locked per operation (already present in `approve_task_and_merge`)

### Integration Points
- `approve_task_and_merge` in `review_handlers.rs:189` is the callsite. After the sidecar `Command::new("node")` block is replaced with `git::squash_merge_to_main(...)`, the `merge_outcome.success` / `merge_outcome.conflicts` pattern becomes direct from `MergeResult`.
- `models/mod.rs` — remove `pub use merge_outcome::MergeOutcome` line
- `lib.rs` — remove `pub use process::{spawn_agent_cli, ProcessOutput}` export if deleting spawner

</code_context>

<specifics>
## Specific Ideas

- The research doc (`SIDECAR-RESEARCH.md`) already has the exact sequence of git commands for squash merge: `git checkout main`, `git merge <branch> --squash --no-commit`, `git status --porcelain`, `git commit -m "..."` / `git merge --abort`. Use it as a recipe.
- Conflict detection: parse `git status --porcelain` output for lines where both-side conflict markers appear (`UU`, `AA`, `DD`, `AU`, `UA`, `DU`, `UD`).

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>

---

*Phase: 34-remove-node-sidecar-implement-squash-merge-in-rust*
*Context gathered: 2026-03-31*
