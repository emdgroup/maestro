# Roadmap: Maestro

## Milestones

- ✅ **v1.0 MVP** — Phases 1-12 (shipped 2026-02-09)
- ✅ **v1.1 UI/UX Polish** — Phases 13-22 (shipped 2026-03-16)
- ✅ **v1.2 Deep Linking & Project Picker** — Phases 23-24 (shipped 2026-03-29)
- ✅ **v1.3 Agents & Worktrees** — Phases 25-28 (shipped 2026-03-30)
- 📋 **v1.4** — (planned)

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

<details>
<summary>✅ v1.3 Agents & Worktrees (Phases 25-28) — SHIPPED 2026-03-30</summary>

- [x] Phase 25: Backend Overhaul (4/4 plans) — completed 2026-03-29
- [x] Phase 26: Agents View (2/2 plans) — completed 2026-03-29
- [x] Phase 27: Worktrees View (3/3 plans) — completed 2026-03-30
- [x] Phase 28: Zombie Cleanup on Project Open (1/1 plan) — completed 2026-03-30

See `.planning/milestones/v1.3-ROADMAP.md` for full details.

</details>

### 📋 v1.4 (Planned)

*Next milestone — run `/gsd:new-milestone` to define scope.*

## Progress

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 1-12 | v1.0 | 45/45 | Complete | 2026-02-09 |
| 13-22 | v1.1 | 36/36 | Complete | 2026-03-16 |
| 23 - In-app routing | v1.2 | 2/2 | Complete | 2026-03-28 |
| 24 - Project picker improvements | v1.2 | 2/2 | Complete | 2026-03-28 |
| 25 - Backend Overhaul | v1.3 | 4/4 | Complete | 2026-03-29 |
| 26 - Agents View | v1.3 | 2/2 | Complete | 2026-03-29 |
| 27 - Worktrees View | v1.3 | 3/3 | Complete | 2026-03-30 |
| 28 - Zombie Cleanup on Project Open | v1.3 | 1/1 | Complete | 2026-03-30 |
| 29 - v1.3 Polish & Bug Fixes | v1.3 | Complete    | 2026-03-30 | 2026-03-30 |

### Phase 29: v1.3 Agents & Worktrees view polish and bug fixes

**Goal:** Fix DiffViewer dark mode and styling defects, safe SQL for terminal output, commit completed quick-task work, clean up stale todos
**Requirements**: TBD
**Depends on:** Phase 28
**Plans:** 2/2 plans complete

Plans:
- [x] 29-01-PLAN.md — Fix DiffViewer theme/Tailwind states, SQL subquery, WorktreeManager loading
- [x] 29-02-PLAN.md — Commit uncommitted quick-task changes, resolve stale pending todo

### Phase 30: v1.3 post-testing UI and worktree bug fixes

**Goal:** Fix four post-v1.3 testing issues: action bars for AgentsView/WorktreesView, Spawn Agent button for interactive sessions, "not a git repository" execution bug, and WorktreeManager create dialog improvements
**Requirements**: TBD
**Depends on:** Phase 29
**Plans:** 3/3 plans complete

Plans:
- [x] 30-01-PLAN.md — Fix execution path bug + add action bars to AgentsView and WorktreesView
- [x] 30-02-PLAN.md — Rust backend: update create_worktree IPC, add spawn_interactive_execution, update ExecutionWithTask model
- [x] 30-03-PLAN.md — Frontend: redesign worktree create dialog, add Spawn Agent button + dialog

### Phase 31: Fix remote SSH worktree bugs: git ops, origin branch detection, and worktree path filtering

**Goal:** Fix five SSH-related bugs: wrong session key in get_git_connection, missing new_branch in remote worktree creation, hardcoded current branch for remote, unnormalized remote branch listing, and local-only worktree IPC handlers
**Requirements**: [BUG-1, BUG-2, BUG-3, BUG-4, BUG-5]
**Depends on:** Phase 30
**Plans:** 2/2 plans complete

Plans:
- [x] 31-01-PLAN.md — Fix core SSH git ops: session key lookup, remote worktree create, current branch, branch list normalization
- [x] 31-02-PLAN.md — Make worktree IPC handlers SSH-aware: list, create, delete, cleanup

### Phase 32: Backend code quality: fix all findings from code review

**Goal:** Fix all code quality findings from backend code review — broken queries, panics, dead code, DRY violations, security hardening, and cleanup
**Requirements**: [H1, H2, H3, H4, M1, M2, M3, M4, M5, M6, M7, M8, M9, M10, M11, M12, M13, M14, L1, L2, L3, L4, L5, L6, L7, L8, L9, L10]
**Depends on:** Phase 31
**Plans:** 5/5 plans complete

Plans:
- [x] 32-01-PLAN.md — Fix broken review queries (V5 schema), project handler panics, ORDER BY column, log messages
- [x] 32-02-PLAN.md — Remove dead spawner, deduplicate remote polling, fix WorktreeSnapshot, delegate resume to spawn
- [x] 32-03-PLAN.md — Extract DRY helpers, centralize TASK_SELECT, atomize update_task, add error logging
- [x] 32-04-PLAN.md — Shell injection fix, host key verification, password zeroing, reconnection race, PTY resources
- [x] 32-05-PLAN.md — Remove AppError, add log crate, Tauri path API, explicit SQL columns, sync upsert DRY

---

*Roadmap created: 2026-02-09*
*v1.0 shipped: 2026-02-09*
*v1.1 shipped: 2026-03-16*
*v1.2 shipped: 2026-03-29*
*v1.3 shipped: 2026-03-30*
