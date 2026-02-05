# Phase 2: Core Orchestration - Context

**Gathered:** 2026-02-04
**Status:** Ready for planning

<domain>
## Phase Boundary

Enable users to manage tasks via Kanban board with full column workflow support. This phase covers manual task creation, GitHub/Jira import, Kanban visualization, and drag-drop between columns (Backlog → Ready → In Progress → Review → Done). Worktree execution and agent lifecycle management belong in Phase 4.

</domain>

<decisions>
## Implementation Decisions

### Task Creation Flow
- Modal dialog pattern (click "New Task" → modal pops up → fill form → save)
- Required fields: title + description + acceptance criteria (no task without full context)
- After saving: modal closes, task appears in Backlog column
- Editing: Only tasks in Backlog column can be edited (lock once moved to Ready or beyond)

### Board Layout & Density
- All columns visible without scroll (fit to viewport, columns squeeze to fit screen)
- Task cards show: title + status indicators (no description preview)
- Empty columns: just empty, no decoration or hints
- Column headers: show task count (e.g., "Backlog (12)")

### Import Behavior
- Manual sync button (user clicks Sync to refresh from GitHub/Jira)
- Conflict handling: update existing task with new data from remote (check by issue ID)
- Field mapping: title + body only (no labels, assignee, or other metadata)
- Import destination: always Backlog (regardless of remote issue status)
- Configuration: settings UI to configure GitHub repo or Jira project
- Provider support: both GitHub AND Jira (user picks which to use in settings)
- Error handling: show error toast, do nothing (don't block UI)
- Imported tasks: read-only after import (protect sync source, no local edits)

### Column Transitions
- Movement rules: free movement between Backlog and Ready (user controls), other columns managed by tool when agents work on tasks
- Drop behavior: update status + trigger validation (check if task is ready for column)
- Validation failure: show error, card bounces back to original column
- Drag feedback: dim invalid drop zones during drag

### Claude's Discretion
- Exact modal styling and animations
- Task card visual design (borders, shadows, spacing)
- Sync button placement and icon
- Error toast styling and duration
- Drag-drop animation details

</decisions>

<specifics>
## Specific Ideas

No specific requirements — open to standard approaches for Kanban board implementation

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 02-core-orchestration*
*Context gathered: 2026-02-04*
