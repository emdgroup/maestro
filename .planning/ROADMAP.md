# Roadmap: Maestro

## Milestones

- ✅ **v1.0 MVP** — Phases 1-12 (shipped 2026-02-09)
- ✅ **v1.1 UI/UX Polish** — Phases 13-22 (shipped 2026-03-16)
- ✅ **v1.2 Deep Linking & Project Picker** — Phases 23-24 (shipped 2026-03-29)
- 🚧 **v1.3 Agents & Worktrees** — Phases 25-28 (in progress)

## Phases

<details>
<summary>✅ v1.0 MVP (Phases 1-12) — SHIPPED 2026-02-09</summary>

- [x] Phase 1: Foundation — completed 2026-02-04
- [x] Phase 2: Core Orchestration — completed 2026-02-05
- [x] Phase 3: Git Worktree Infrastructure — completed 2026-02-05
- [x] Phase 4: Agent Execution — completed 2026-02-06
- [x] Phase 5: Real-time Monitoring — completed 2026-02-06
- [x] Phase 6: Review & Merge Workflow — completed 2026-02-07
- [x] Phase 7: Configuration Management — completed 2026-02-07
- [x] Phase 8: Error Handling & Polish — completed 2026-02-08
- [x] Phase 9: Remote Project Support (SSH) — completed 2026-02-08
- [x] Phase 10: Documentation Completeness — completed 2026-02-08
- [x] Phase 11: Agent Execution UX Polish — completed 2026-02-09
- [x] Phase 12: Worktree Disk Cleanup — completed 2026-02-09

See `.planning/milestones/v1.0-ROADMAP.md` for full details.

</details>

<details>
<summary>✅ v1.1 UI/UX Polish (Phases 13-22) — SHIPPED 2026-03-16</summary>

- [x] Phase 13: Bug Fixes — completed 2026-02-09
- [x] Phase 14: UI Foundation — completed 2026-02-10
- [x] Phase 15: Component & Design System — completed 2026-02-10
- [x] Phase 16: Page Redesigns — completed 2026-02-10
- [x] Phase 17: Polish & Testing — completed 2026-02-10
- [x] Phase 17.1: Critical UI Fixes (INSERTED) — completed 2026-02-11
- [x] Phase 18: Maestro Folder Architecture & Rebranding — completed 2026-02-23
- [x] Phase 19: Frontend Architecture Refactoring — completed 2026-02-26
- [x] Phase 20: Refactor Frontend to use TanStack Query — completed 2026-02-27
- [x] Phase 21: Refactor Components Using Commands Object — completed 2026-02-28
- [x] Phase 22: Auto-remove Stale Projects — completed 2026-03-16

See `.planning/milestones/v1.1-ROADMAP.md` for full details.

</details>

<details>
<summary>✅ v1.2 Deep Linking & Project Picker (Phases 23-24) — SHIPPED 2026-03-29</summary>

- [x] Phase 23: Add in-app routing for deep linking to specific screens (2/2 plans) — completed 2026-03-28
- [x] Phase 24: Improve project picker screen (2/2 plans) — completed 2026-03-28

See `.planning/milestones/v1.2-ROADMAP.md` for full details.

</details>

### 🚧 v1.3 Agents & Worktrees (In Progress)

**Milestone Goal:** Replace both placeholder views (`AgentMonitor`, `WorktreeManager`) with fully functional, real-data-backed screens backed by a backend overhaul from pool-based to on-demand worktree creation.

#### Phase Dependency Diagram

```
Phase 25: Backend Overhaul
         |
    +----|----+
    |         |
Phase 26    Phase 27
Agents View  Worktrees View
    |         |
    +----|----+
         |
     Phase 28 (optional)
  Zombie Cleanup on Open
```

Phase 25 must complete before any frontend work begins — it is a compile-time hard dependency (three IPC commands the views depend on do not exist until Phase 25 ships). Phases 26 and 27 are independent of each other and can run in parallel or sequential. Phase 28 depends on both 25 and 27.

#### Research Flags

All 4 phases: **No research needed.** All integration points verified by direct codebase inspection. IPC signatures, component boundaries, and data flows are confirmed in source.

---

- [ ] **Phase 25: Backend Overhaul** — Schema v3, model overhaul, pool removal, on-demand worktree create, 5 new IPC commands, bindings regen
- [ ] **Phase 26: Agents View** — Real execution list, live xterm.js terminal, dead session handling, status filter/search
- [ ] **Phase 27: Worktrees View** — Real worktree cards, right-panel diff, zombie badge, manual create/delete
- [ ] **Phase 28: Zombie Cleanup on Project Open** — Startup cleanup pass, replaces `recover_dirty_worktrees` *(lower priority — can be deferred if time-constrained)*

## Phase Details

### Phase 25: Backend Overhaul
**Goal**: The Rust backend is upgraded from pool-based to on-demand worktree management, with a new schema, overhauled models, real git subprocess implementations, and 5 new IPC commands — unblocking both frontend view phases.
**Depends on**: Phase 24 (last v1.2 phase)
**Complexity**: L
**Requirements**: REQ-01, REQ-02, REQ-03, REQ-04, REQ-05, REQ-06, REQ-07, REQ-08, REQ-09, REQ-10, REQ-11, REQ-12, REQ-13, REQ-14, REQ-15
**Research flag**: None — all patterns confirmed by direct source inspection
**Success Criteria** (what must be TRUE):
  1. `pnpm tauri:gen` completes without errors and `bindings.ts` reflects `WorktreeWithStatus` and `ExecutionWithTask` — the old pool enum types are gone
  2. Calling `create_worktree` IPC for a task produces a real directory at `.maestro/worktrees/task-{id}` inside the project root, confirmed by `ls` on disk
  3. Agent spawn via `spawn_agent_execution` creates a worktree on-demand and deletes it on completion — `lease_worktree` and `return_worktree` calls are gone
  4. `list_worktrees_with_status` and `list_executions_with_task_info` return real data (non-empty for a project with active worktrees/executions)
  5. All 5 pool IPC commands (`initialize_worktree_pool`, `lease_worktree`, `return_worktree`, `get_pool_status`, `recover_dirty_worktrees`) are removed from `lib.rs` registration and cause a compile error if referenced
**Plans**: 4 plans
Plans:
- [ ] 25-01-PLAN.md — Schema v3 + model overhaul + Cargo.toml deps
- [ ] 25-02-PLAN.md — Git local implementations (tokio::process::Command)
- [ ] 25-03-PLAN.md — New worktree IPC commands (list, diff, create, delete)
- [ ] 25-04-PLAN.md — Pool removal + execution handler migration + bindings regen
**UI hint**: no

**Key deliverables:**
- Schema v3 migration: drop worktrees table, recreate with `id`, `project_id`, `task_id` (FK nullable), `branch_name`, `path`, `git_status`, `created_at`
- `models/worktree.rs` overhaul: remove `WorktreeStatus` pool enum and `PoolStatus` struct; add `WorktreeWithStatus` and `ExecutionWithTask` view models
- `git/mod.rs` local stubs implemented: real `git worktree add/remove` via `tokio::process::Command`
- `worktree_handlers.rs` rewritten: 5 pool commands removed, 5 new commands added (`list_worktrees_with_status`, `get_worktree_diff`, `create_worktree`, `delete_worktree`, `cleanup_zombie_worktrees`)
- `execution_handlers.rs` modified: spawn/resume use on-demand create; finalization blocks delete not return; `list_executions_with_task_info` added
- `lib.rs` command registration updated
- New crates added: `git2 = { version = "0.20.4", features = ["vendored-libgit2"] }`, `notify = "8.2.0"`
- `pnpm tauri:gen` run to regenerate `bindings.ts`

**Critical pitfalls:**
- Pool removal must be atomic: implement and verify `create_worktree` as a standalone command first; only then replace `lease_worktree` at execution spawn time
- Audit every `status = 'Available'` write in `execution_handlers.rs` — all must be replaced with delete logic in the same commit that removes the pool
- All git subprocess calls in async IPC handlers must use `tokio::process::Command`; `git2` synchronous calls wrapped in `tokio::task::spawn_blocking`

---

### Phase 26: Agents View
**Goal**: The Agents view shows a real, live-updating execution list with a functional xterm.js terminal that correctly attaches to running sessions and renders DB history for completed ones.
**Depends on**: Phase 25
**Complexity**: M
**Requirements**: REQ-16, REQ-17, REQ-18, REQ-19, REQ-20, REQ-21, REQ-22, REQ-23, REQ-24
**Research flag**: None — `TerminalComponent` and `ExecutionTerminal` are fully functional; this phase is wiring, not new component work
**Success Criteria** (what must be TRUE):
  1. The Agents view sidebar shows all executions (active + history) sorted by most recent first, with no placeholder/static data
  2. Clicking a running execution row attaches xterm.js to the live PTY stream — terminal output appears and scrolls in real time
  3. Clicking a completed/failed execution row shows the DB-stored terminal output with a "Session ended" notice — no blank terminal
  4. Navigating away from Agents view and back does not leak terminal instances (xterm.js disposed, FitAddon cleaned up, ResizeObserver disconnected)
  5. Status filter chips (All / Running / Done / Failed) and task name search correctly narrow the sidebar list client-side
**Plans**: 4 plans
Plans:
- [ ] 25-01-PLAN.md — Schema v3 + model overhaul + Cargo.toml deps
- [ ] 25-02-PLAN.md — Git local implementations (tokio::process::Command)
- [ ] 25-03-PLAN.md — New worktree IPC commands (list, diff, create, delete)
- [ ] 25-04-PLAN.md — Pool removal + execution handler migration + bindings regen
**UI hint**: yes

**Key deliverables:**
- `useExecutionsWithTaskInfoQuery(projectId)` hook in `execution.service.ts` with 2-second refetch interval
- `AgentMonitor.tsx` rewritten: real sidebar from `ExecutionWithTask[]`, each row showing status dot, task name, status label + elapsed time, worktree branch
- Mixed list (active + history) — no separate tabs
- Status filter toolbar: All / Running / Done / Failed chips + task name search input, both applied client-side
- Live xterm.js terminal: clicking row mounts `ExecutionTerminal` keyed by `task_id`; previous channel detached on selection change
- Dead session handling: non-Running executions skip `attach_terminal`; fetch `terminal_output` from DB and write via `terminal.write(history)`
- `useEffect` cleanup: always calls `terminal.dispose()`, `fitAddon` cleanup, `ResizeObserver.disconnect()`, and `detach_terminal` IPC
- Deep link auto-select: `pendingAgentId` from `navigationStore` used for initial selection; fallback to most-recent running execution
- `AgentsView.tsx` wired: passes data as props; no direct IPC inside `AgentMonitor`

---

### Phase 27: Worktrees View
**Goal**: The Worktrees view shows real git worktree cards with branch, task, and status info, a right-panel diff viewer, and per-card management actions including zombie detection and delete.
**Depends on**: Phase 25
**Complexity**: M
**Requirements**: REQ-25, REQ-26, REQ-27, REQ-28, REQ-29, REQ-30, REQ-31, REQ-32, REQ-33
**Research flag**: None — `DiffViewer` and `@git-diff-view/react` are already proven in the review flow; this phase reuses them unchanged
**Success Criteria** (what must be TRUE):
  1. The Worktrees view card grid shows real worktrees from `git worktree list`, with no placeholder/static data; each card displays branch name, linked task name (or "No task"), agent status badge, and last activity timestamp
  2. Clicking a worktree card opens a right panel showing worktree metadata and a live diff of uncommitted changes vs origin branch via `@git-diff-view/react`
  3. A worktree with `is_zombie: true` displays a "Zombie" badge on its card; the badge is informational only and never triggers auto-deletion
  4. Clicking the "Clean up" button on any card, confirming the dialog, calls `delete_worktree` and removes the card from the list immediately via query invalidation
  5. Clicking a task name on a worktree card navigates to Kanban view and highlights that task
**Plans**: 4 plans
Plans:
- [ ] 25-01-PLAN.md — Schema v3 + model overhaul + Cargo.toml deps
- [ ] 25-02-PLAN.md — Git local implementations (tokio::process::Command)
- [ ] 25-03-PLAN.md — New worktree IPC commands (list, diff, create, delete)
- [ ] 25-04-PLAN.md — Pool removal + execution handler migration + bindings regen
**UI hint**: yes

**Key deliverables:**
- `worktree.service.ts` created: `useWorktreesQuery(projectId)`, `useWorktreeDiffQuery(worktreeId)`, `useDeleteWorktreeMutation`, `useCreateWorktreeMutation`
- `WorktreeManager.tsx` rewritten: card grid from `WorktreeWithStatus[]`, no static placeholder data
- Card content: branch name, linked task name (or "No task"), agent status badge (active/idle), last activity timestamp
- Zombie/prunable badge: `is_zombie: true` surfaces a "Zombie" badge; informational only, never auto-delete
- Right panel detail: same pattern as BacklogView + BacklogTaskSheet; shows worktree metadata + git diff via `@git-diff-view/react`
- "Clean up" action: per-card button + confirmation dialog before calling `delete_worktree`
- Task deep link: clicking task name calls `navigationStore.navigate({ taskId })`
- "New Worktree" button in header: dialog with branch name + path inputs, calls `create_worktree` IPC, new card appears via query invalidation
- `WorktreesView.tsx` wired: passes data as props; no direct IPC inside `WorktreeManager`

---

### Phase 28: Zombie Cleanup on Project Open
**Goal**: On project open, stale zombie worktrees are automatically identified and removed, so the Worktrees view starts from a consistent state without manual intervention.

> **Priority note:** This phase is lower priority and can be deferred if time-constrained. Phase 27 already surfaces zombie badges + manual delete, which provides adequate coverage for the milestone. Phase 28 is a quality-of-life automation on top of that foundation.

**Depends on**: Phase 25, Phase 27
**Complexity**: S
**Requirements**: REQ-34, REQ-35, REQ-36
**Research flag**: None — simple IPC + idempotent `git worktree remove` calls; no new patterns
**Success Criteria** (what must be TRUE):
  1. Opening a project with zombie worktrees (task_id IS NULL or task status Done/Archived, path confirmed by `git worktree list`, created_at older than 10 minutes) automatically removes them — they are absent from the Worktrees view on first load
  2. Worktrees created less than 10 minutes ago are never touched by the cleanup pass, even if they have no task link yet
  3. The `recover_dirty_worktrees` call in `App.tsx` is replaced by `cleanup_zombie_worktrees` with no other behavioral change to project open flow
**Plans**: 4 plans
Plans:
- [ ] 25-01-PLAN.md — Schema v3 + model overhaul + Cargo.toml deps
- [ ] 25-02-PLAN.md — Git local implementations (tokio::process::Command)
- [ ] 25-03-PLAN.md — New worktree IPC commands (list, diff, create, delete)
- [ ] 25-04-PLAN.md — Pool removal + execution handler migration + bindings regen
**UI hint**: no

**Key deliverables:**
- `cleanup_zombie_worktrees(project_id)` IPC command: finds worktrees where `task_id IS NULL` OR task status is Done/Archived, AND `git worktree list` confirms path exists on disk
- Time threshold: only considers worktrees with `created_at` older than 10 minutes (avoids false positives on actively starting agents)
- Called from `App.tsx` `useEffect` on project open, replacing `recover_dirty_worktrees`
- Never deletes based on DB state alone — `git worktree list` is authoritative for existence

---

## Progress

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 1-12 | v1.0 | 45/45 | Complete | 2026-02-09 |
| 13-22 | v1.1 | 36/36 | Complete | 2026-03-16 |
| 23 - In-app routing | v1.2 | 2/2 | Complete | 2026-03-28 |
| 24 - Project picker improvements | v1.2 | 2/2 | Complete | 2026-03-28 |
| 25 - Backend Overhaul | v1.3 | 0/4 | Planned | - |
| 26 - Agents View | v1.3 | 0/? | Not started | - |
| 27 - Worktrees View | v1.3 | 0/? | Not started | - |
| 28 - Zombie Cleanup on Project Open | v1.3 | 0/? | Not started (optional) | - |

---

## Requirement Coverage: v1.3

| Requirement | Phase | Status |
|-------------|-------|--------|
| REQ-01 Schema v3 migration | Phase 25 | Pending |
| REQ-02 Worktree model overhaul | Phase 25 | Pending |
| REQ-03 Real git worktree add/remove | Phase 25 | Pending |
| REQ-04 On-demand worktree path convention | Phase 25 | Pending |
| REQ-05 Remove 5 pool IPC commands | Phase 25 | Pending |
| REQ-06 Add list_worktrees_with_status IPC | Phase 25 | Pending |
| REQ-07 Add get_worktree_diff IPC | Phase 25 | Pending |
| REQ-08 Add create_worktree IPC | Phase 25 | Pending |
| REQ-09 Add delete_worktree IPC | Phase 25 | Pending |
| REQ-10 Add list_executions_with_task_info IPC | Phase 25 | Pending |
| REQ-11 spawn_agent_execution uses on-demand create | Phase 25 | Pending |
| REQ-12 Finalization blocks delete not return | Phase 25 | Pending |
| REQ-13 No blocking git subprocess in async IPC | Phase 25 | Pending |
| REQ-14 New Rust crates | Phase 25 | Pending |
| REQ-15 TypeScript bindings regenerated | Phase 25 | Pending |
| REQ-16 useExecutionsWithTaskInfoQuery hook | Phase 26 | Pending |
| REQ-17 AgentMonitor.tsx rewritten | Phase 26 | Pending |
| REQ-18 Mixed list (active + history) | Phase 26 | Pending |
| REQ-19 Status filter toolbar | Phase 26 | Pending |
| REQ-20 Live xterm.js terminal | Phase 26 | Pending |
| REQ-21 Dead session handling | Phase 26 | Pending |
| REQ-22 xterm.js lifecycle | Phase 26 | Pending |
| REQ-23 Deep link auto-select | Phase 26 | Pending |
| REQ-24 AgentsView.tsx wired | Phase 26 | Pending |
| REQ-25 worktree.service.ts created | Phase 27 | Pending |
| REQ-26 WorktreeManager.tsx rewritten | Phase 27 | Pending |
| REQ-27 Worktree card content | Phase 27 | Pending |
| REQ-28 Zombie/prunable badge | Phase 27 | Pending |
| REQ-29 Right panel detail | Phase 27 | Pending |
| REQ-30 Manual "Clean up" action | Phase 27 | Pending |
| REQ-31 Task deep link | Phase 27 | Pending |
| REQ-32 Manual worktree creation | Phase 27 | Pending |
| REQ-33 WorktreesView.tsx wired | Phase 27 | Pending |
| REQ-34 cleanup_zombie_worktrees IPC | Phase 28 | Pending |
| REQ-35 Time threshold | Phase 28 | Pending |
| REQ-36 Called on project open | Phase 28 | Pending |

**Coverage: 36/36 v1.3 requirements mapped. No orphans.**

---

*Roadmap created: 2026-02-09*
*v1.0 shipped: 2026-02-09*
*v1.1 shipped: 2026-03-16*
*v1.2 shipped: 2026-03-29*
*v1.3 roadmap added: 2026-03-29*

---

**Next step:** Run `/gsd:plan-phase 25` to decompose Phase 25 (Backend Overhaul) into executable plans.
