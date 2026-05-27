# Plan: Execute /gsd-plan-phase 59 (Board View)

## Context

Phase 58 complete — KanbanView simplified, activeTaskId routing in place. Phase 59 adds a 5-column board (Backlog column + search/priority/label filters). CONTEXT.md and UI-SPEC.md already exist; no RESEARCH.md yet.

## Workflow Execution

### 1. Skip Research

Phase 59 is fully specified — CONTEXT.md has 6 concrete decisions with exact code snippets, UI-SPEC has component specs. Research adds no value here. Will select "Skip research" when prompted (or use `--skip-research` semantics).

### 2. Spawn gsd-planner

Planner will produce PLAN.md files covering:

**Wave 1 (single plan likely sufficient):**
- Add `"Backlog"` to `BOARD_STATUSES` in `BoardView.tsx`, change `grid-cols-4` → `grid-cols-5`
- Add `COLUMN_TITLES["Backlog"] = "Backlog"` entry
- Build action bar in `KanbanView.tsx`: search input, Priority popover, Label popover
- Add filter state (`query`, `selectedPriorities`, `selectedLabels`) as `useState` in KanbanView
- Pass filtered tasks to BoardView via props (BoardView currently self-fetches — refactor to accept filtered tasks OR move filtering into BoardView)
- Delete `BacklogView.tsx`

**Requirements to cover:** BOARD-01, BOARD-02, BOARD-03, BOARD-04

**Key files:**
- `src/views/KanbanView.tsx` (20 lines → ~80 lines with filter logic)
- `src/components/views/BoardView.tsx` (102 lines → ~110 lines)
- `src/components/views/BacklogView.tsx` (198 lines → DELETE)

### 3. Spawn gsd-plan-checker

Verify plans cover all 4 BOARD requirements, decisions D-01 through D-06, and have valid frontmatter.

### 4. Gates

- Requirements Coverage: BOARD-01..04 all covered
- Decision Coverage: D-01..D-06 all referenced in plans
- No schema push needed (no ORM files)
- UI-SPEC exists ✓

## Verification

After plan-phase completes:
- `ls .planning/phases/59-board-view/*-PLAN.md` shows plan file(s)
- Each plan has valid YAML frontmatter with `requirements` field listing BOARD-XX IDs
- Plans reference all files from CONTEXT.md "Files Changed" table
- `STATE.md` updated to reflect Phase 59 planned

## Decision Point

Research step — recommend skipping (context is complete). User will be prompted.
