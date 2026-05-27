# Execute Phase 59: Board View

## Context

Phase 59 replaces the fragmented sub-view approach with a unified 5-column board. Phase 58 (navigation store refactor) is complete — KanbanView already renders conditionally on `activeTaskId`. This phase adds the Backlog column, converts BoardView to accept a `tasks` prop, adds filter UX, and deletes BacklogView.tsx.

## Execution Summary

- **Plans:** 2 (both autonomous)
- **Waves:** 2 (sequential — `parallelization: false`)
- **Branch:** none (stay on main)
- **commit_docs:** false

## Wave 1 — Plan 59-01: BoardView 5-column refactor

**What it builds:** Refactors BoardView.tsx to accept a required `tasks: Task[]` prop (removing internal data fetch), expands from 4 to 5 columns by adding Backlog as the first status. Updates KanbanView to pass tasks down.

**Files modified:**
- `src/components/views/BoardView.tsx` — 5-column grid, tasks prop, no useTasksQuery
- `src/views/KanbanView.tsx` — minimal wire-up: fetch tasks, pass to BoardView

**Verification:** `pnpm build` exits 0

## Wave 2 — Plan 59-02: KanbanView action bar + BacklogView deletion

**Depends on:** Wave 1 (BoardView must accept tasks prop first)

**What it builds:** Populates the empty action bar in KanbanView with search input + Priority popover + Label popover. Adds filter state (useState), computes filteredTasks with AND logic, passes to BoardView. Deletes BacklogView.tsx and its test.

**Files modified:**
- `src/views/KanbanView.tsx` — filter state, action bar UI, filteredTasks
- `src/components/views/BacklogView.tsx` — DELETED
- `src/components/views/__tests__/BacklogView.test.tsx` — DELETED

**Verification:** `pnpm build` exits 0, BacklogView files absent

## Post-Execution

1. **Build gate:** `pnpm build` must pass after each wave
2. **Code review:** Auto-invoke on phase changes (advisory)
3. **Verification:** Spawn verifier agent — checks must_haves against codebase
4. **State update:** Mark phase 59 complete in ROADMAP.md + STATE.md

## Verification Criteria

- BoardView renders 5 columns: Backlog, Ready, InProgress, Review, Done
- BoardView accepts `tasks: Task[]` prop, no internal data fetch
- KanbanView has search + Priority popover + Label popover in action bar
- Filters compose with AND logic
- BacklogView.tsx deleted, no references remain
- `pnpm build` passes cleanly
