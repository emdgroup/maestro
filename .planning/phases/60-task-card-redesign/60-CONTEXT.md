---
phase: 60
name: Task Card Redesign
status: context-complete
date: 2026-05-26
---

# Phase 60: Task Card Redesign — Context

**Gathered:** 2026-05-26
**Status:** Ready for planning

<domain>
## Phase Boundary

Redesign `TaskCard.tsx` so each card communicates its full context at a glance and provides the one inline action the user most needs for that task's current status. The context menu is removed; card click navigates to the task detail screen.

</domain>

<decisions>
## Implementation Decisions

### Card Layout

- **D-01: Layout pattern = Title first (Option B).** Title is the primary scan target at top (2-line clamp). Metadata row below title (priority dot + labels). Agent/worktree footer below that. Inline action in the same footer row.
- **D-02: No context menu.** The `⋮` button and `TaskContextMenu` component are removed from the card. Settings and other task actions live in the task detail screen (Phase 62).
- **D-03: Card click = navigate to detail.** Clicking anywhere on the card (outside the inline action button) calls `setActiveTaskId(task.id)`. This is already wired in Phase 58 via `useNavigationActions`.
- **D-04: "Back to Backlog" button removed.** Ready cards show only Execute. No secondary Back button.

### Priority Visualization

- **D-05: Colored dot.** Small colored circle (7×7px) before the title row metadata. Colors:
  - Urgent → `#f87171` (red)
  - High → `#fb923c` (orange)
  - Medium → `#facc15` (yellow)
  - Low → `#4ade80` (green)
  - None → `#4b5563` (muted gray, or omit entirely)

### Label Display

- **D-06: Max 3 label chips + overflow count.** Existing pattern from current `TaskCard.tsx` — keep as-is. Labels shown after priority dot in the metadata row.

### Auto-Approve Indicator

- **D-07: `ShieldAlert` icon from lucide-react.** Reuses the same icon already used in `PermissionPrompt.tsx` to mean "all tools, full session". Shown only when `task.auto_approve === true`. Amber/warning color to signal elevated permissions. Positioned in the metadata row (right-aligned or alongside labels).

### Inline Actions

- **D-08: Action in footer row (not full-width button).** The action button sits in a row with the agent/worktree metadata — left side shows metadata, right side shows the action button. Compact, not full-width.
- **D-09: One action per status:**
  - Backlog → no action button
  - Ready → `▶ Execute` (calls `useExecuteTask`)
  - InProgress → `⏹ Interrupt` (calls `useInterruptTaskMutation`)
  - Review → `Review` (navigates to diff view via existing `onReviewClick` pattern or direct navigation)
  - Done → `Archive` (calls archive mutation)
  - Cancelled → no action button

### Worktree Badge

- **D-10: Green dot when task has an active worktree.** `KanbanView` calls `useWorktreesQuery` and derives `worktreeTaskIds = new Set(worktrees.filter(w => w.task_id != null).map(w => w.task_id!))`. This set is passed down to `BoardView` → `KanbanColumn` → `TaskCard` as a prop. Card shows a small green dot + "worktree" label when `worktreeTaskIds.has(task.id)`.

### Agent Name

- **D-11: Omitted from Phase 60.** No agent name on the card. Phase 61 establishes the agent field on Task; Phase 62 shows it on the detail screen. Cards in Phase 60 show only the metadata listed above.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Requirements
- `.planning/REQUIREMENTS.md` §CARD-01 through CARD-06 — 6 card requirements for this phase

### Phase Context
- `.planning/phases/58-navigation-store/58-CONTEXT.md` — `setActiveTaskId`, `useActiveTaskId`, `TaskDetailScreen` stub (card click target)
- `.planning/phases/59-board-view/59-CONTEXT.md` — 5-column board layout, `KanbanView` action bar, `useWorktreesQuery` already used in `WorktreesView`

### Existing Source Files
- `src/components/kanban/TaskCard.tsx` — file being replaced; contains `useExecuteTask`, label overflow logic, status-based action buttons
- `src/components/kanban/KanbanColumn.tsx` — passes props to TaskCard; prop interface changes here
- `src/views/KanbanView.tsx` — needs `useWorktreesQuery` call added; passes worktreeTaskIds down
- `src/components/execution/activity/PermissionPrompt.tsx` — reference for `ShieldAlert` icon usage and color treatment
- `src/services/worktree.service.ts` — `useWorktreesQuery` hook
- `src/services/task.service.ts` — `useInterruptTaskMutation` hook (already exists)
- `src/utils/hooks/useExecuteTask.ts` — `useExecuteTask` hook (already exists)

No external specs — requirements fully captured in decisions above.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `useExecuteTask(projectId, projectPath)` in `src/utils/hooks/useExecuteTask.ts` — Ready card Execute action
- `useInterruptTaskMutation()` in `src/services/task.service.ts` — InProgress card Interrupt action
- `useWorktreesQuery(projectId, repoPath)` in `src/services/worktree.service.ts` — worktree badge data
- `ShieldAlert` from lucide-react (already imported in `PermissionPrompt.tsx`) — auto-approve indicator
- Label overflow pattern in current `TaskCard.tsx` lines 117–128 — keep unchanged
- `Badge` component from `@/ui/badge` — available for pills
- `setActiveTaskId` from `useNavigationActions()` in `src/store/navigationStore.ts` — card click navigation

### Established Patterns
- Cards use `bg-card border-border rounded-lg shadow-sm p-3` base styling
- Font scale: `text-xs` for metadata, `text-sm` / `font-medium` for title
- Muted metadata: `text-muted-foreground` for secondary info
- Compact design system: `h-7`, `p-3`, `text-xs` patterns throughout app
- `KanbanContext` provides `projectId`, `projectPath` — TaskCard reads these via `useKanban()`

### Integration Points
- `KanbanColumn` → `TaskCard`: prop interface changes (add `worktreeTaskIds: Set<number>`)
- `BoardView` → `KanbanColumn`: same prop threads through
- `KanbanView` → `BoardView`: `useWorktreesQuery` called here, set derived and passed down
- `onReviewClick` prop pattern: Review action navigates to diff view — keep existing callback pattern for now (Phase 62 may unify navigation)

</code_context>

<specifics>
## Specific Ideas

- Preview reference: `.claude/plans/60-card-layout-preview.html` — HTML mockup showing Option B layout, footer-row action style, priority dots, and `ShieldAlert` icon context
- Auto-approve (`ShieldAlert`) should match the amber/warning treatment used in `PermissionPrompt.tsx` option `auto` — same icon, same color semantics

</specifics>

<deferred>
## Deferred Ideas

- **Agent name on card** — deferred to Phase 61+ (field doesn't exist on Task type yet; Phase 61 adds agent selector to Create Task modal)
- **"Back to Backlog" on Ready cards** — removed, not deferred; detail screen is the path for status changes

</deferred>

---

*Phase: 60-Task Card Redesign*
*Context gathered: 2026-05-26*
