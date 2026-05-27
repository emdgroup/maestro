---
phase: 58
name: Navigation Store
status: context-complete
date: 2026-05-26
---

# Phase 58 — CONTEXT.md

## Phase Goal

Refactor `navigationStore.ts` to route task detail via `activeTaskId: number | null` instead of the old
`activeSubView` / `pendingTaskId` mechanism. KanbanView renders `<TaskDetailScreen>` or the board based
on `activeTaskId`.

---

## Locked Decisions

### D-01: TaskDetailScreen stub

Create `src/components/task/TaskDetailScreen.tsx` with a `taskId: number` prop.
Body renders a minimal placeholder — e.g. `<div>Task #{taskId}</div>`.
Phase 62 replaces the body; the import path must stay identical so KanbanView needs no changes in Phase 62.

### D-02: App.tsx cleanup — full removal

Remove the entire `pendingTaskId → selectedTask → <TaskDetail>` flow from `App.tsx` in Phase 58:
- Remove `usePendingTaskId` import from `@/store/navigationStore`
- Remove `clearPendingTask` from `useNavigationActions()` destructure
- Delete `selectedTask` useState + the `useEffect` that resolves it
- Delete `<TaskDetail>` lazy import and its render in JSX
- Delete `TaskModal` lazy import and `showNewTaskModal` state — **scope: no, keep TaskModal**
  (TaskModal removal is Phase 61 scope; only the TaskDetail/pendingTask pattern is Phase 58 scope)

### D-03: NavigationTarget type — remove sub-view routes

Remove `'backlog' | 'board' | 'archive'` from the view union in `NavigationTarget`.
Add `'tasks'` as a valid view target (clears `activeTaskId`).
Update `targetViewToTab`: `'tasks'` maps to `'kanban'`.
Remove the `activeSubView` branch from the `navigate` handler body.

### D-04: Test strategy — rewrite

Delete all tests that assert `activeSubView`, reference `pendingTaskId`, or pass `taskId` as a string.
Add:
- `navigate({ taskId: 42 })` → `activeTaskId === 42`
- `navigate({ view: 'tasks' })` → `activeTaskId === null`
- `setActiveTaskId(7)` → `activeTaskId === 7`
- `setActiveTaskId(null)` → `activeTaskId === null`

The `resetStore()` helper must be updated to set `activeTaskId: null` and omit `activeSubView`/`pendingTaskId`.

### D-05: Store API surface

**Add:**
- `activeTaskId: number | null` (initial: null)
- `setActiveTaskId(id: number | null): void`
- `useActiveTaskId()` — standalone selector hook
- `setActiveTaskId` added to `useNavigationActions` return object

**Remove:**
- `activeSubView: SubView` state field
- `pendingTaskId: string | null` state field
- `SubView` type export
- `setActiveSubView(sub: SubView): void` action
- `clearPendingTask(): void` action
- `useActiveSubView()` selector hook
- `usePendingTaskId()` selector hook
- `setActiveSubView` and `clearPendingTask` from `useNavigationActions`

**Keep unchanged:**
- `pendingAgentId`, `pendingWorktreeId`, `clearPendingAgent`, `clearPendingWorktree`
- `activeTab`, `slideDirection`, `setActiveTab`, `navigate`, `useNavigate`
- `useNavigationActions` shape (minus the two removals above)

### D-06: KanbanView simplification

Remove all sub-view conditional rendering:
- Delete `SUB_VIEWS` array and the 3-icon toggle group
- Delete `activeSubView` / `setActiveSubView` usage
- Delete Backlog branch (BacklogView render + search + priority filter state)
- Delete Archive branch (ArchiveView render + archive search + archive filter state)
- Delete imports: `BacklogView`, `ArchiveView`, `LayoutList`, `Archive`, `SubView`

New render logic (top-level `KanbanView` body):
```tsx
const activeTaskId = useActiveTaskId();
if (activeTaskId !== null) {
  return <TaskDetailScreen taskId={activeTaskId} />;
}
// existing board layout with action bar + BoardView
```

Keep the action bar skeleton (it will be populated in Phase 59).

### D-07: NavigationTarget — taskId type change

`NavigationTarget` must change `{ taskId: string }` → `{ taskId: number }`.
The `navigate` handler sets `state.activeTaskId = target.taskId` (number).
Remove the `state.activeSubView = "board"` line that was in the old taskId branch.

---

## Files Changed in Phase 58

| File | Change |
|------|--------|
| `src/store/navigationStore.ts` | Major refactor per D-03, D-05, D-07 |
| `src/store/navigationStore.test.ts` | Rewrite per D-04 |
| `src/views/KanbanView.tsx` | Simplify per D-06 |
| `src/App.tsx` | Remove pendingTask/TaskDetail pattern per D-02 |
| `src/components/task/TaskDetailScreen.tsx` | Create stub per D-01 |

---

## Out of Scope for Phase 58

- Board layout / search / filter bar — Phase 59
- `BacklogView` component itself — stays, just not rendered from KanbanView in Phase 58
- `ArchiveView` — Phase 63 replaces with modal
- `TaskModal` / `showNewTaskModal` in App.tsx — Phase 61
- Real `TaskDetailScreen` implementation — Phase 62
- KanbanContext `onTaskClick` prop — stays wired but unused after Phase 58 (TaskModal still uses it from App.tsx); cleaned in Phase 61
