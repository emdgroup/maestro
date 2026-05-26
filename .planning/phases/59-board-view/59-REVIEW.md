---
phase: 59-board-view
reviewed: 2026-05-26T00:00:00Z
depth: standard
files_reviewed: 2
files_reviewed_list:
  - src/components/views/BoardView.tsx
  - src/views/KanbanView.tsx
findings:
  critical: 1
  warning: 3
  info: 2
  total: 6
status: issues_found
---

# Phase 59: Code Review Report

**Reviewed:** 2026-05-26
**Depth:** standard
**Files Reviewed:** 2
**Status:** issues_found

## Summary

Two files implement the Kanban board UI: `KanbanView.tsx` is the top-level view (filter toolbar + routing to `TaskDetailScreen`), and `BoardView.tsx` renders the columns, modals, and terminal overlay. One critical bug causes `Cancelled` tasks to silently appear as archived tasks on the board. Three warnings cover an archive-filter asymmetry, a redundant boolean expression, and a missing `React` import. Two info items cover minor code style.

---

## Critical Issues

### CR-01: Cancelled tasks are never shown on the board, but are also not consistently excluded

**File:** `src/components/views/BoardView.tsx:42-47`

`BOARD_STATUSES` omits `"Cancelled"`, so tasks with `status === "Cancelled"` are silently dropped from the board. The `TaskStatus` type in `bindings.ts` includes `"Cancelled"` as a valid value, and `review_handlers.rs` actively transitions tasks into that state via `CancelTask`. The `ArchiveView` treats `Cancelled` tasks as archived items (`t.archived_at != null || t.status === "Cancelled"`), so users navigate to the archive to find them — but the archive and the board filter logic are inconsistent.

The real bug is in the `Done`-column archive filter. Line 44-46 applies `!t.archived_at` only to `Done` tasks:

```tsx
const columnTasks =
  status === "Done"
    ? tasks.filter((t) => t.status === status && !t.archived_at)
    : tasks.filter((t) => t.status === status);
```

This means a task in any status other than `Done` that somehow has `archived_at` set will still appear on the board. The intent of filtering archived tasks from the board is present but only partially implemented — other statuses are unguarded.

**Fix:** Apply the `archived_at` guard to all statuses, not just `Done`:

```tsx
const columnTasks = tasks.filter(
  (t) => t.status === status && !t.archived_at
);
```

This is safe because `BOARD_STATUSES` already excludes `Cancelled`, and `ArchiveView` owns the `Cancelled` display path.

---

## Warnings

### WR-01: Archive filter only guards the `Done` column — archived non-Done tasks leak onto the board

**File:** `src/components/views/BoardView.tsx:43-46`

As noted in CR-01, the `archived_at` check is applied only when `status === "Done"`. If the backend ever sets `archived_at` on a task in `Backlog`, `Ready`, `InProgress`, or `Review` (e.g., via a bulk archive or a future migration), those tasks will still appear on the board. The `useArchiveTaskMutation` in `task.service.ts` does not constrain which statuses can be archived. The guard should be applied uniformly.

**Fix:** Same as CR-01 — apply `!t.archived_at` unconditionally in the filter.

### WR-02: `isOpen={!!selectedTaskForSettings}` is always `true` when the modal renders — the prop is redundant and misleading

**File:** `src/components/views/BoardView.tsx:80`

The `TaskSettingsModal` is rendered inside `{selectedTaskForSettings && ...}`, so `selectedTaskForSettings` is guaranteed truthy when the JSX is reached. Passing `isOpen={!!selectedTaskForSettings}` evaluates to `isOpen={true}` always. If `TaskSettingsModal` ever uses `isOpen` to animate closed before unmounting, the prop would need to be driven by separate state — but currently it just creates a false impression that the value varies.

**Fix:** Either remove the outer guard and use `isOpen` as the sole mount control, or keep the outer guard and pass `isOpen={true}` explicitly:

```tsx
{selectedTaskForSettings && (
  <TaskSettingsModal
    isOpen={true}
    onClose={() => setSelectedTaskForSettings(null)}
    task={selectedTaskForSettings}
    projectId={projectId}
  />
)}
```

### WR-03: `React` is not imported but `React.FC` is used as the component type annotation

**File:** `src/views/KanbanView.tsx:14`

```tsx
export const KanbanView: React.FC = () => {
```

`React` is never imported in this file. In a project using React 19 with the JSX transform (which does not require a `React` import for JSX), the `React.FC` annotation still requires `React` to be in scope as a value/namespace. This will cause a TypeScript compile error (`Cannot find name 'React'`) unless the project's `tsconfig.json` enables `"jsx": "react-jsx"` **and** TypeScript is configured to resolve `React` as a global — which it is not by default in strict mode.

Check: `tsconfig.json` for this project uses strict mode. The other files in `src/views/` should be checked for consistency; if all other views import `React`, this file is inconsistent and broken.

**Fix:** Add the import:

```tsx
import React from "react";
```

Or change the annotation to avoid `React.FC`:

```tsx
export function KanbanView() {
```

---

## Info

### IN-01: `COLUMN_TITLES` lookup uses non-null assertion on a `Partial<Record<...>>`

**File:** `src/components/views/BoardView.tsx:50`

```tsx
columnTitle={COLUMN_TITLES[status]!}
```

`COLUMN_TITLES` is typed `Partial<Record<TaskStatus, string>>`. The non-null assertion `!` suppresses the TypeScript warning but masks the fact that if `BOARD_STATUSES` ever gains a status not present in `COLUMN_TITLES` (e.g., `"Cancelled"`), the value passed to `KanbanColumn` would be `undefined`, which would silently render as nothing.

**Fix:** Use a full `Record<TaskStatus, string>` (removing `Partial`) and include all statuses, or add a fallback:

```tsx
columnTitle={COLUMN_TITLES[status] ?? status}
```

### IN-02: `availableLabels` is recomputed on every render

**File:** `src/views/KanbanView.tsx:25`

```tsx
const availableLabels = [...new Set(taskList.flatMap(t => t.labels))].sort();
```

This allocates a new `Set`, spreads it into an array, and sorts it on every render — including renders triggered by `query`, `selectedPriorities`, and `selectedLabels` state updates. For boards with large task lists this is wasteful. A `useMemo` keyed on `taskList` would prevent the recomputation.

**Fix:**

```tsx
const availableLabels = useMemo(
  () => [...new Set(taskList.flatMap(t => t.labels))].sort(),
  [taskList],
);
```

Note: This is a code quality suggestion. It is not a performance finding for v1 scope purposes; it is flagged because recomputing derived data without memoization can cause stale-data bugs if the derivation were to be more complex in the future.

---

_Reviewed: 2026-05-26_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
