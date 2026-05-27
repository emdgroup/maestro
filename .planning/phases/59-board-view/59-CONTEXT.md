---
phase: 59
name: Board View
status: context-complete
date: 2026-05-26
---

# Phase 59 — CONTEXT.md

## Phase Goal

Replace the fragmented sub-view approach with a unified 5-column Kanban board (Backlog, Ready, InProgress, Review, Done). Add a persistent action bar with real-time search, multi-select priority filter, and multi-select label filter. All filtering is client-side — no new IPC calls.

---

## Locked Decisions

### D-01: 5-column board — Backlog added as first column

`BoardView.tsx` currently renders 4 columns (Ready, InProgress, Review, Done) with `grid-cols-4`.

Add `"Backlog"` as the first element of `BOARD_STATUSES`. Change layout to `grid-cols-5`.

Backlog column has **no special treatment** — same filtering, same component, same done-column archival logic (only Done filters `!t.archived_at`).

### D-02: Delete BacklogView.tsx (and ArchiveView is not touched)

`src/components/views/BacklogView.tsx` is deleted. It had its own search/filter state inside `KanbanView.tsx`'s old sub-view branch (already removed in Phase 58). It is not referenced anywhere in the current codebase.

`src/components/views/ArchiveView.tsx` is **not** touched — Phase 63 scope.

### D-03: Action bar — multi-select popover (Proposal B)

The `h-12` div in `KanbanView.tsx` becomes the action bar. Layout is **all left-aligned**: search input → Priority popover → Label popover.

**Controls:**

- **Search input**: plain `<input>` or shadcn `Input`. Filters by `task.title.toLowerCase().includes(query)` in real-time. No debounce required (client-side, fast).
- **Priority popover**: shadcn `Popover` + `PopoverTrigger` + `PopoverContent`. Checkboxes for all `TaskPriority` values: `Urgent`, `High`, `Medium`, `Low`, `None`. Badge on trigger shows active selection count. "Clear" link resets. Zero selections = show all.
- **Label popover**: same pattern. Labels collected from all loaded tasks (deduplicated, sorted). Zero selections = show all.

Filter state lives in `KanbanView.tsx` as local `useState` — no store.

### D-04: Filter logic — AND composition, client-side

Filters compose with AND:

```
visibleTasks = tasks
  .filter(t => query === "" || t.title.toLowerCase().includes(query.toLowerCase()))
  .filter(t => selectedPriorities.length === 0 || selectedPriorities.includes(t.priority))
  .filter(t => selectedLabels.length === 0 || t.labels.some(l => selectedLabels.includes(l)))
```

Applied in `KanbanView.tsx` before passing to `BoardView`. `BoardView` receives already-filtered tasks (or filtering moves inside `BoardView` — planner decides, but the logic is the same).

### D-05: Label source — derive from loaded tasks

Labels shown in the Label popover are derived from the currently loaded task list:

```ts
const availableLabels = [...new Set(tasks.flatMap(t => t.labels))].sort();
```

No static list, no IPC call, no empty-state handling.

### D-06: Filter state shape

```ts
const [query, setQuery] = useState("");
const [selectedPriorities, setSelectedPriorities] = useState<TaskPriority[]>([]);
const [selectedLabels, setSelectedLabels] = useState<string[]>([]);
```

Toggle helper: if value is in array → remove; else → add. Used for both popover types.

---

## Files Changed in Phase 59

| File | Change |
|------|--------|
| `src/components/views/BoardView.tsx` | Add Backlog column, change `grid-cols-4` → `grid-cols-5`, accept filtered tasks |
| `src/views/KanbanView.tsx` | Populate action bar, add filter state, pass filtered tasks to BoardView |
| `src/components/views/BacklogView.tsx` | **Delete** |

---

## Out of Scope for Phase 59

- Card redesign (priority pills, label chips, inline actions) — Phase 60
- `ArchiveView.tsx` — Phase 63
- Task creation modal — Phase 61
- Task detail screen implementation — Phase 62
- Persisted filter state across sessions
- URL-based filter params
- Filter animation / transitions
- Keyboard navigation within popover (accessibility baseline only)
