---
gsd_state_version: 1.0
milestone: v1.7
milestone_name: Tasks UX Rework
status: executing
stopped_at: Phase 57 Plan 02 complete — attachment CRUD handlers, interrupt_task, TypeScript bindings, service hooks
last_updated: "2026-05-26T13:29:00.000Z"
last_activity: 2026-05-26 -- Phase 57 Plan 02 complete (IPC handlers, bindings, TanStack Query hooks)
progress:
  total_phases: 14
  completed_phases: 1
  total_plans: 2
  completed_plans: 2
  percent: 7
---

# Project State: v1.7 — Tasks UX Rework

## Project Reference

See: .planning/PROJECT.md (updated 2026-05-20)

**Core value:** Orchestrate multiple AI coding agents in parallel with isolation, visibility, and control
**Current focus:** v1.7 Tasks UX Rework — Phase 57 (Data Model & Backend)

## Current Position

Phase: 57 — Data Model & Backend
Plan: 02 complete — Phase 57 done
Status: Executing
Last activity: 2026-05-26 -- Phase 57 Plan 02 complete (IPC handlers, bindings, TanStack Query hooks)

Progress bar: █░░░░░░░░░ 14% (1/7 phases complete, 2/2 Phase 57 plans)

## Performance Metrics

**Velocity:** (reference v1.6 baselines)

- Average plan duration: ~0.06h per plan
- Reference: Phase 56 (2 plans, complete), Phase 55 (3 plans, complete)

**By Phase:** (to be filled as plans complete)

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 57 | 2/2 | ~12 min | ~6 min |
| 58 | TBD | — | — |
| 59 | TBD | — | — |
| 60 | TBD | — | — |
| 61 | TBD | — | — |
| 62 | TBD | — | — |
| 63 | TBD | — | — |

*Updated after each plan completion*

## Accumulated Context

### Decisions

Key v1.7 decisions locked in at roadmap creation:

- [Phase 57]: Schema bump is V18 (V17 was used by Phase 56 title rename commit); migration is destructive per project convention — no data preservation strategy
- [Phase 57]: `interrupt_task` must stop the active ACP/PTY session before moving task status to Backlog; calling it with no active session should surface an error to UI, not silently succeed
- [Phase 57]: `auto_approve` defaults false, `isolated_worktree` defaults true — matches existing agent behavior expectations
- [Phase 57 Plan 02]: `file_size` changed from i64 to i32 in TaskAttachment — specta BigIntForbidden constraint; i32 sufficient for desktop attachments
- [Phase 58]: `activeSubView` / `SubView` removed entirely; `activeTaskId: number | null` replaces sub-view routing for the Tasks view; `pendingTaskId` consolidated into `activeTaskId`
- [Phase 59]: The 3-icon sub-view toggle (Backlog / Board / Archive) is deleted; KanbanView renders board unconditionally; Archive moves to a modal (Phase 63)
- [Phase 61]: `CreateTaskModal` replaces `TaskModal`, `BacklogTaskSheet`, and `ImportTicketsModal` — those three files are deleted
- [Phase 62]: `TaskDetailScreen` replaces `TaskDetail.tsx` — that file is deleted; full screen means no overlay, no modal backdrop
- [Phase 62]: Task fields editable only in Backlog status; Interrupt is the only path to unlock a non-Backlog task
- [Phase 63]: `ArchiveView.tsx` deleted; `ArchiveModal.tsx` is the replacement; archive is read-only (no actions on archived tasks)

### Pending Todos

_(none)_

### Blockers/Concerns

_(none)_

## Session Continuity

Last session: 2026-05-26T13:29:00Z
Stopped at: Phase 57 Plan 02 complete — attachment CRUD handlers, interrupt_task, TypeScript bindings, service hooks
Resume file: None — continue with Phase 58 (store refactor)
