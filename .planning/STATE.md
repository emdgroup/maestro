---
gsd_state_version: 1.0
milestone: v1.7
milestone_name: Tasks UX Rework
status: ready_to_plan
stopped_at: Phase 60 complete (2/2) — ready to discuss Phase 61
last_updated: 2026-05-26T22:22:48.742Z
last_activity: 2026-05-26
progress:
  total_phases: 14
  completed_phases: 4
  total_plans: 8
  completed_plans: 22
  percent: 29
---

# Project State: v1.7 — Tasks UX Rework

## Project Reference

See: .planning/PROJECT.md (updated 2026-05-20)

**Core value:** Orchestrate multiple AI coding agents in parallel with isolation, visibility, and control
**Current focus:** Phase 61 — create task modal

## Current Position

Phase: 61
Plan: Not started
Status: Ready to plan
Last activity: 2026-05-26

Progress bar: ███░░░░░░░ 30% (3/7 phases complete, 6/6 plans through Phase 59)

## Performance Metrics

**Velocity:** (reference v1.6 baselines)

- Average plan duration: ~0.06h per plan
- Reference: Phase 56 (2 plans, complete), Phase 55 (3 plans, complete)

**By Phase:** (to be filled as plans complete)

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 57 | 2/2 | ~12 min | ~6 min |
| 58 | 2/2 | ~8 min | ~4 min |
| 59 | 2 | - | - |
| 60 | 2 | - | - |
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
- [Phase 59 Plan 02]: Used buttonVariants() on PopoverTrigger — base-ui/react popover Trigger has no asChild prop (unlike Radix UI)
- [Phase 59 Plan 02]: availableLabels derived from full taskList so label popover shows all known labels regardless of active filters

### Pending Todos

_(none)_

### Blockers/Concerns

_(none)_

## Session Continuity

Last session: 2026-05-26T22:12:08.729Z
Stopped at: Phase 60 context gathered
Resume file: None
