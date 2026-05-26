---
phase: 60-task-card-redesign
reviewed: 2026-05-26T00:00:00Z
depth: standard
files_reviewed: 4
files_reviewed_list:
  - src/components/kanban/TaskCard.tsx
  - src/components/kanban/KanbanColumn.tsx
  - src/components/views/BoardView.tsx
  - src/views/KanbanView.tsx
findings:
  critical: 0
  warning: 4
  info: 2
  total: 6
status: issues_found
---

# Phase 60: Code Review Report

**Reviewed:** 2026-05-26T00:00:00Z
**Depth:** standard
**Files Reviewed:** 4
**Status:** issues_found

## Summary

Reviewed four files implementing the task card redesign: a redesigned `TaskCard`, updated `KanbanColumn`, `BoardView` with review/terminal support, and `KanbanView` with filter bar. The implementation is lean and mostly correct. No security vulnerabilities were found.

Four warnings were found: a shared `isExecuting` state that disables all Execute buttons when any one task starts executing, double-click guards missing on the Interrupt and Archive buttons, a non-null assertion on `COLUMN_TITLES` that will silently break if `BOARD_STATUSES` ever diverges, and `Cancelled` tasks leaking into the filter results sent to `BoardView` without being rendered. Two info items cover dead code in the `KanbanContext` and a missing label-filter clear button in the popover when only one label is selected.

## Warnings

### WR-01: `isExecuting` state is shared across all task cards — disables every Execute button when any one task starts

**File:** `src/components/kanban/TaskCard.tsx:25`

`useExecuteTask` is instantiated once per `TaskCard` render. Each card holds its own `isExecuting` boolean, so a card executing task A will disable task A's button — that part is correct. However, each `TaskCard` also calls `useCreateWorktreeMutation()` and `useSpawnInteractiveExecutionMutation()` internally (inside `useExecuteTask`). Both mutations are scoped to TanStack Query's global mutation state. If `spawnMutation.isPending` or `createWorktreeMutation.isPending` were ever read by multiple cards (they're not currently), there would be cross-card interference. The actual bug here is subtler: `isExecuting` is only reset in the `finally` block, but if the component unmounts mid-execution (e.g., the task status updates and the column re-renders, removing the card), `setIsExecuting(false)` runs on an unmounted component. React 18 suppresses this warning, but the state update is a no-op on the stale closure. If the user quickly navigates away and back, the new card instance shows `isExecuting: false` (correct), but any toast from the abandoned execution still fires.

More concretely: there is no guard preventing a second click on Execute if the user opens the task detail screen and comes back before the async `execute` completes (the card is recreated with a fresh `isExecuting: false`). The missing guard is at the mutation level, not the component level.

**Fix:** Add a check at the start of `execute` using the mutation `isPending` state, or use a ref instead of state so it survives re-renders:

```typescript
// In useExecuteTask.ts — use a ref as the executing guard to survive remounts
const isExecutingRef = useRef(false);
const [isExecuting, setIsExecuting] = useState(false);

const execute = async (task: Task) => {
  if (!projectId || isExecutingRef.current) return;
  isExecutingRef.current = true;
  setIsExecuting(true);
  try {
    // ...
  } finally {
    isExecutingRef.current = false;
    setIsExecuting(false);
  }
};
```

---

### WR-02: Interrupt and Archive buttons have no `disabled` guard — rapid clicks fire multiple mutations

**File:** `src/components/kanban/TaskCard.tsx:91-122`

The Execute button is protected by `disabled={isExecuting}`, but the Interrupt button (line 91) and Archive button (line 112) have no `disabled` prop. A user clicking Archive twice fires two separate `archiveTask.mutate(task.id)` calls before the first invalidation updates the UI. The Archive mutation is not idempotent in effect (it sets `archived_at` which the second call would overwrite with a new timestamp on the server). The Interrupt mutation is similarly unguarded.

**Fix:**

```tsx
// Interrupt button
<button
  onClick={(e) => {
    e.stopPropagation();
    interruptTask.mutate(task.id);
  }}
  disabled={interruptTask.isPending}
  className="text-xs px-2 py-1 rounded bg-muted text-muted-foreground hover:bg-muted/80 disabled:opacity-50"
>
  {interruptTask.isPending ? "..." : "⏹ Interrupt"}
</button>

// Archive button
<button
  onClick={(e) => {
    e.stopPropagation();
    archiveTask.mutate(task.id);
  }}
  disabled={archiveTask.isPending}
  className="text-xs px-2 py-1 rounded bg-muted text-muted-foreground hover:bg-muted/80 disabled:opacity-50"
>
  {archiveTask.isPending ? "..." : "Archive"}
</button>
```

---

### WR-03: Non-null assertion on `COLUMN_TITLES[status]` will silently produce `undefined` if `BOARD_STATUSES` diverges

**File:** `src/components/views/BoardView.tsx:43`

```tsx
columnTitle={COLUMN_TITLES[status]!}
```

`COLUMN_TITLES` is typed `Partial<Record<TaskStatus, string>>`. The `!` suppresses the `string | undefined` type, but if a status is ever added to `BOARD_STATUSES` without a corresponding entry in `COLUMN_TITLES`, the column header will render as nothing without any compile-time or runtime warning. The TypeScript non-null assertion bypasses the safety that `Partial<Record>` provides.

**Fix:** Either use a full `Record<TaskStatus, string>` so TypeScript enforces completeness, or provide a fallback:

```typescript
// Option A: enforce completeness at compile time
const COLUMN_TITLES: Record<(typeof BOARD_STATUSES)[number], string> = {
  Backlog: "Backlog",
  Ready: "Ready",
  InProgress: "In Progress",
  Review: "Review",
  Done: "Done",
};

// Then use without assertion:
columnTitle={COLUMN_TITLES[status]}

// Option B: safe fallback (keeps Partial, removes !)
columnTitle={COLUMN_TITLES[status] ?? status}
```

---

### WR-04: `Cancelled` tasks pass through `filteredTasks` and reach `BoardView` but are never rendered

**File:** `src/views/KanbanView.tsx:33-41` and `src/components/views/BoardView.tsx:8`

`BOARD_STATUSES` in `BoardView` does not include `"Cancelled"`. When `filteredTasks` is built in `KanbanView`, no filter excludes `Cancelled` tasks — they flow into `BoardView` and then silently match no column. This is benign today but represents a logic gap: a user filtering by the `Cancelled` label will not see those tasks anywhere on the board and will receive no indication of why.

Additionally, the `KanbanColumn` component defines both `getColumnBorderColor` and `getBadgeColor` entries for `Cancelled` (lines 20 and 32), indicating `Cancelled` was intended to be displayed but was removed from `BOARD_STATUSES` without cleaning up the unreachable entries in those maps.

**Fix:** Explicitly exclude `Cancelled` tasks from `filteredTasks` so the intent is clear and the dead map entries in `KanbanColumn` can be removed:

```typescript
// In KanbanView.tsx
const filteredTasks = taskList.filter(t => {
  if (t.status === "Cancelled") return false;   // not shown on board
  const matchesQuery = query === "" || t.title.toLowerCase().includes(query.toLowerCase());
  const matchesPriority = selectedPriorities.length === 0 || selectedPriorities.includes(t.priority);
  const matchesLabel = selectedLabels.length === 0 || selectedLabels.some(l => t.labels.includes(l));
  return matchesQuery && matchesPriority && matchesLabel;
});
```

And remove the `Cancelled` entries from `getColumnBorderColor` and `getBadgeColor` in `KanbanColumn.tsx`.

---

## Info

### IN-01: `onTaskClick` context value is unused in the reviewed code path

**File:** `src/contexts/KanbanContext.tsx:7` (referenced from `src/views/KanbanView.tsx`)

`KanbanView` never calls `useKanban().onTaskClick`. Card click navigation is handled directly via `setActiveTaskId` in `TaskCard`. The `onTaskClick` prop is passed as a no-op `() => {}` from `App.tsx`. This is dead interface surface that adds noise to `KanbanContext` and its call sites. It is used in `ArchiveView.tsx` (also a no-op call site), which suggests the abstraction was not cleaned up when navigation moved to `navigationStore`.

This is out of scope for the files under direct review but is worth tracking.

---

### IN-02: `availableLabels` recomputed on every render — memoization missing

**File:** `src/views/KanbanView.tsx:31`

```typescript
const availableLabels = [...new Set(taskList.flatMap(t => t.labels))].sort();
```

This expression runs on every render of `KanbanView`. While performance is out of v1 scope, the correctness implication is minor: each render during typing in the search box recomputes this. A `useMemo` with `[taskList]` as dependency would be idiomatic. Low priority since `taskList` only changes on server refetch, not on filter state changes.

---

_Reviewed: 2026-05-26T00:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
