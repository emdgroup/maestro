# Project Retrospective

*A living document updated after each milestone. Lessons feed forward into future planning.*

## Milestone: v1.2 — Deep Linking & Project Picker

**Shipped:** 2026-03-29
**Phases:** 2 | **Plans:** 4 | **Duration:** 1 day (2026-03-28)

### What Was Built
- Zustand `navigationStore` with discriminated union dispatch (`navigate({ taskId/agentId/worktreeId/view })`), slideDirection animation, and 8 selector hooks — TDD with 17 tests
- All navigation consumers rewired from local state to store; `usePageRouting` hook deleted entirely
- Three async Rust IPC commands (`git_init_project`, `clone_project`, `create_new_project`) with `connection_id` for SSH remote support
- 3-button project picker footer with CloneProjectDialog and CreateProjectDialog, both with FilePicker integration and auto-git-init on select

### What Worked
- TDD approach for navigationStore was clean — writing 17 failing tests first made the store implementation mechanical and confident
- Discriminated union dispatch pattern is ergonomic and TypeScript-safe; `'key' in target` narrowing avoided complex switch statements
- Inline DB logic in async Rust commands (instead of calling shared `create_project()`) resolved `State<'_>` lifetime issues cleanly — anticipated in RESEARCH.md
- Human-verify checkpoint caught the missing SSH connection threading before it became a production bug

### What Was Inefficient
- The v1.2 milestone started without a formal `/gsd:new-milestone` (phases were added ad-hoc to the v1.2 section), so there was no requirements doc or milestone audit
- Skills removal (quick task) happened during v1.2 closure — this was untracked work not reflected in the milestone plan

### Patterns Established
- **Pending entity ID pattern**: store holds `pendingTaskId`, component reads it, computes `effectiveId`, consumes in `useEffect`, clears after use
- **Dual-dialog visibility**: `open={open && !showDirPicker}` hides parent dialog without unmounting (preserves form state) when sub-dialog opens
- **Inline vs toast error split**: user-correctable errors (dir already exists) → inline `text-destructive`; server-side failures (git clone) → toast

### Key Lessons
1. Rust async IPC commands with `State<'_>` must not call other functions that re-lock the mutex after `.await` — inline the DB logic instead
2. Human-verify checkpoints reliably catch cross-cutting concerns (like SSH connection threading) that unit tests miss
3. Starting a milestone without `/gsd:new-milestone` means no requirements traceability — worth the 5 minutes even for small milestones

### Cost Observations
- Model: claude-sonnet-4-6 (balanced profile)
- Sessions: 1 focused session
- Notable: 4 plans executed in ~1 day, extremely efficient for the scope delivered

---

## Milestone: v1.3 — Agents & Worktrees

**Shipped:** 2026-03-30
**Phases:** 4 | **Plans:** 10 | **Duration:** 2 days (2026-03-29 → 2026-03-30)

### What Was Built
- SQLite schema v3: pool-based worktree model completely removed; `task_id`/`git_status` on-demand model with `WorktreeWithStatus` and `ExecutionWithTask` view models
- All git stubs replaced with real `tokio::process::Command` async implementations; `git2` crate for diff via `spawn_blocking`
- 5 pool IPC commands removed; 5 new commands: `list_worktrees_with_status`, `get_worktree_diff`, `create_worktree`, `delete_worktree`, `cleanup_zombie_worktrees`
- Agents view rewritten: 2s polling hook, three-line sidebar rows, filter chips, live xterm.js terminal, `DeadSessionTerminal` for history rendering
- Worktrees view rewritten: `w-72` sidebar with status dots/badges, diff shortstat, right detail panel with `DiffViewer`, AlertDialog-gated delete, New Worktree creation dialog
- Zombie cleanup on project open: silent background mutation, 10-min threshold, never deletes on DB state alone

### What Worked
- The phase dependency structure (25 → 26/27 → 28) was clean — backend first meant both frontend phases could run without blockers
- View-owns-data pattern (established in v1.2) made AgentsView and WorktreesView straightforward to build — no ambiguity about where IPC calls live
- Parallel `tokio::spawn` for `status_map` + `diff_stat_map` in `list_worktrees_with_status` was the right call — single pass per worktree, low overhead
- `DeadSessionTerminal` as a separate component (not a conditional in `ExecutionTerminal`) kept the live terminal clean and removed all the PTY attach/detach guard logic

### What Was Inefficient
- `notify = "8.2.0"` crate was added in Plan 25-01 but never used — the filesystem watching approach was replaced by polling before Plan 02 was written
- Phase 25 RESEARCH.md and CONTEXT.md existed but weren't strictly needed — all integration points were confirmed by direct source inspection anyway

### Patterns Established
- **On-demand worktree lifecycle**: create at `spawn_agent_execution`, delete in finalization closure — no pool, no lease/return ceremony
- **`tokio::task::spawn_blocking` for git2 sync ops**: git subprocess via `tokio::process::Command`; git2 library via `spawn_blocking` — no runtime blocking
- **Scoped closure for SQLite borrow checker**: `{ let mut stmt = conn.prepare(...)? ... }` scope resolves `stmt`/`conn` lifetime conflicts
- **Silent background mutation**: `onError: console.error` only, no toast — for housekeeping mutations that should never interrupt UX

### Key Lessons
1. **Separate dead/live terminal components** rather than a single conditional component — simpler lifecycle, no attach-guard logic needed
2. **`notify` crate removed before use** — adding crates speculatively in Plan 01 to "keep options open" added noise; add crates only when the plan that uses them is being written
3. **Backend first, hard dependency respected** — Phase 25 being a compile-time hard dependency meant no frontend work could start early; the phasing was correct and saved wasted rework

### Cost Observations
- Model: claude-sonnet-4-6 (balanced profile)
- Sessions: 2 sessions across 2 days
- Notable: 10 plans in 2 days — largest v1.x milestone by plan count, completed without regressions

---

## Cross-Milestone Trends

### Process Evolution

| Milestone | Phases | Plans | Key Process Change |
|-----------|--------|-------|--------------------|
| v1.0 | 12 | 45 | Established GSD workflow, phase/plan structure |
| v1.1 | 11 | 36 | Adopted TanStack Query pattern, service layer, large refactors |
| v1.2 | 2 | 4 | TDD for store, discriminated union patterns, fast single-session execution |
| v1.3 | 4 | 10 | Hard phase dependency enforced (backend first), on-demand lifecycle pattern |

### Cumulative Quality

| Milestone | Tests | Build |
|-----------|-------|-------|
| v1.0 | 27 Rust tests | ✓ |
| v1.1 | 110 Jest tests | ✓ |
| v1.2 | 110 Jest + 17 navigationStore | ✓ |
| v1.3 | No new tests (backend IPC + UI wiring) | ✓ |

### Top Lessons (Verified Across Milestones)

1. **Human-verify checkpoints catch cross-cutting bugs** that unit tests miss (SSH threading, DB mutex issues)
2. **Service layer investment pays off** — TanStack Query hooks in v1.1 made v1.2 IPC additions trivial to wire
3. **TDD for store-layer code** is consistently efficient — 17 tests written in one RED commit, implementation in GREEN commit, no debugging cycles
