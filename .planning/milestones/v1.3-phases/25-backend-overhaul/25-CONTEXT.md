# Phase 25: Backend Overhaul - Context

**Gathered:** 2026-03-29
**Status:** Ready for planning

<domain>
## Phase Boundary

The Rust backend is upgraded from pool-based to on-demand worktree management. Deliverables: schema v3, model overhaul, real git subprocess implementations, 5 new IPC commands, 5 pool commands removed, TypeScript bindings regenerated.

This phase is pure backend Rust — no frontend changes. It unblocks Phases 26 and 27 which cannot compile until the new IPC commands and model shapes exist.

</domain>

<decisions>
## Implementation Decisions

### Worktree list enrichment (list_worktrees_with_status)

- **Source of truth:** `git worktree list --porcelain` is the source of truth for what's on disk. DB rows are enriched with task/execution info.
- **On-disk worktree with no DB row:** Include in the list as an orphan with no task/execution info. Mark as a separate "orphan" state (not is_zombie — see below). User can see and clean it up from the Worktrees view.
- **DB row with no matching disk worktree:** Auto-delete the DB row silently. The worktree was removed outside of the IPC; keep the DB clean.
- **Main worktree exclusion:** Filter out the project root worktree from the list. Only task/agent worktrees are returned.

### git status per-worktree cost

- **Execution strategy:** Parallel via `tokio::spawn` — all `git status --porcelain` calls run concurrently across worktrees.
- **Field content:** Return the raw porcelain string as `git_status` in `WorktreeWithStatus`. Frontend phases decide how to display it.

### git2 vs tokio::process::Command split

- **git2 use:** Only for `get_worktree_diff` — structured diff output maps cleanly to `@git-diff-view/react` format. Wrap in `tokio::task::spawn_blocking` since git2 is synchronous.
- **Everything else:** `tokio::process::Command` for all other git operations (`worktree add/remove`, `worktree list --porcelain`, `status --porcelain`).
- **Diff target:** Diff the worktree's HEAD vs `origin/{branch_name}` (the upstream branch the worktree branched from).

### Zombie detection criteria

- **is_zombie definition:** `task_id IS NULL AND path LIKE '.maestro/worktrees/task-%'` — agent-created worktrees that lost their task link. Uses path convention to distinguish from manually-created worktrees (which have user-defined paths).
- **Manually-created worktrees:** No schema change needed. Inferred from path: if path does NOT match `.maestro/worktrees/task-{id}` convention, the worktree is manual, not a zombie even if task_id is NULL.
- **On-disk orphans (no DB row):** NOT marked as zombies — treated as unknown/orphan status separately. `is_zombie` only applies to tracked worktrees with a DB row.

### Claude's Discretion

- Error message formatting for git subprocess failures
- Exact SQL join structure for `list_executions_with_task_info`
- How to handle `git worktree list --porcelain` parse errors (fail the whole call vs return partial results)
- Whether `cleanup_zombie_worktrees` (Phase 28's REQ-34) scaffolding belongs here or strictly in Phase 28

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Requirements
- `.planning/REQUIREMENTS.md` §Backend Overhaul (Phase 25) — REQ-01 through REQ-15; complete specification for all deliverables

### Existing code to understand before touching
- `src-tauri/src/ipc/worktree_handlers.rs` — All 5 pool commands to remove; cleanup/recover variants; full rewrite target
- `src-tauri/src/ipc/execution_handlers.rs` — `spawn_agent_execution` and `resume_agent_execution` both call `lease_worktree` (lines ~120 and ~896); `status = 'Available'` writes at lines ~356 and ~994 must be audited and replaced with delete logic
- `src-tauri/src/models/worktree.rs` — Current `WorktreeStatus` enum and `PoolStatus` struct to remove; new `WorktreeWithStatus` and `ExecutionWithTask` view models to add
- `src-tauri/src/git/mod.rs` — Local stub implementations (TODO comments) to replace with real `tokio::process::Command` calls
- `src-tauri/src/db/schema.rs` — Schema v2 with current worktrees table; v3 migration is drop-and-recreate
- `src-tauri/src/lib.rs` — Lines 45-50: 5 pool commands registered; must be replaced with 5 new commands

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src-tauri/src/git/remote.rs` — Remote git operation pattern using `tokio::process::Command`; local implementations should match this pattern exactly
- `src-tauri/src/db/schema.rs` migration pattern — existing v1→v2 migration (drop-and-recreate worktrees) is the template for v2→v3

### Established Patterns
- All async IPC handlers use `State<'_, Arc<AppState>>` with `app_state.db.lock()` for DB access
- IPC command return type is `Result<T, String>` — errors are strings for Tauri serialization
- `tokio::process::Command` already used in remote.rs; same pattern for local git ops
- `tauri-specta` registration in `lib.rs` — all new commands must be added here

### Integration Points
- `lib.rs` command registrations (lines 45-50 replace pool commands with 5 new commands)
- `execution_handlers.rs` — `spawn_agent_execution` and `resume_agent_execution` are the two call sites that must switch from `lease_worktree` to `create_worktree_for_task`
- `pnpm tauri:gen` — must be run after all model changes to regenerate `bindings.ts`
- No frontend changes in this phase; bindings regeneration is the only frontend-touching step

### Critical Pitfall (from ROADMAP.md)
- Pool removal must be atomic: implement `create_worktree` as standalone command first, verify it works, then replace `lease_worktree` call sites in execution_handlers.rs in the same commit that removes pool commands

</code_context>

<specifics>
## Specific Ideas

- Worktree path convention is a named constant in Rust: `const WORKTREE_PATH_TEMPLATE: &str = ".maestro/worktrees/task-{}"` (filled with task_id)
- Zombie check uses this constant pattern for the SQL LIKE clause: `path LIKE '.maestro/worktrees/task-%'`
- Orphaned disk worktrees (no DB row) are included in the list result with a distinct "orphan" marker, separate from is_zombie

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>

---

*Phase: 25-backend-overhaul*
*Context gathered: 2026-03-29*
