# Roadmap: Maestro

## Milestones

- ✅ **v1.0 MVP** — Phases 1-12 (shipped 2026-02-09)
- ✅ **v1.1 UI/UX Polish** — Phases 13-22 (shipped 2026-03-16)
- 📋 **v1.2** — Phases 23+ (planned)

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

### 📋 v1.2 (Planned)

*(Run `/gsd:new-milestone` to define v1.2 goals, requirements, and phases)*

## Progress

| Phase | Milestone | Plans | Status | Completed |
|-------|-----------|-------|--------|-----------|
| 1-12 | v1.0 | 45/45 | Complete | 2026-02-09 |
| 13 - Bug Fixes | v1.1 | 2/2 | Complete | 2026-02-09 |
| 14 - UI Foundation | v1.1 | 4/4 | Complete | 2026-02-10 |
| 15 - Component & Design System | v1.1 | 3/3 | Complete | 2026-02-10 |
| 16 - Page Redesigns | v1.1 | 2/2 | Complete | 2026-02-10 |
| 17 - Polish & Testing | v1.1 | 2/2 | Complete | 2026-02-10 |
| 17.1 - Critical UI Fixes (INSERTED) | v1.1 | 4/4 | Complete | 2026-02-11 |
| 18 - Maestro Folder Architecture | v1.1 | 4/4 | Complete | 2026-02-23 |
| 19 - Frontend Architecture Refactoring | v1.1 | 6/6 | Complete | 2026-02-26 |
| 20 - Refactor Frontend to TanStack Query | v1.1 | 7/7 | Complete | 2026-02-27 |
| 21 - Refactor Components to Service Hooks | v1.1 | 1/1 | Complete | 2026-02-28 |
| 22 - Auto-remove Stale Projects | v1.1 | 1/1 | Complete | 2026-03-16 |

### Phase 23: Add in-app routing for deep linking to specific screens

**Goal:** Replace usePageRouting local state with a Zustand navigationStore that enables programmatic navigation from any component via a discriminated union API (navigate({ taskId }), navigate({ view }), etc.)
**Requirements**: NAV-STORE, NAV-WIRE
**Depends on:** Phase 22
**Plans:** 2/2 plans complete

Plans:
- [x] 23-01-PLAN.md — Create navigationStore with TDD (store + tests)
- [x] 23-02-PLAN.md — Rewire all consumers to use navigationStore, delete usePageRouting

---

*Roadmap created: 2026-02-09*
*v1.0 shipped: 2026-02-09*
*v1.1 shipped: 2026-03-16*
