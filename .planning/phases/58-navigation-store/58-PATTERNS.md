# Phase 58: Navigation Store - Pattern Map

**Mapped:** 2026-05-26
**Files analyzed:** 5
**Analogs found:** 5 / 5

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `src/store/navigationStore.ts` | store | event-driven | `src/store/navigationStore.ts` (self) | exact (in-place refactor) |
| `src/store/navigationStore.test.ts` | test | event-driven | `src/store/boardStore.test.ts` + `src/store/configStore.test.ts` | exact |
| `src/views/KanbanView.tsx` | view | request-response | `src/views/KanbanView.tsx` (self) | exact (in-place refactor) |
| `src/App.tsx` | view | request-response | `src/App.tsx` (self) | exact (in-place refactor) |
| `src/components/task/TaskDetailScreen.tsx` | component | request-response | `src/components/task/TaskDetail.tsx` | role-match |

---

## Pattern Assignments

### `src/store/navigationStore.ts` (store, event-driven)

**Analog:** `src/store/navigationStore.ts` (current file being refactored)

**Imports pattern** (lines 1–3):
```typescript
import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { useShallow } from "zustand/react/shallow";
```

**Store creation pattern** (lines 42–43):
```typescript
export const useNavigationStore = create<NavigationState>()(
  immer((set) => ({
```

**Immer set pattern** (lines 51–57) — all action functions use this shape:
```typescript
navigate: (target: NavigationTarget) =>
  set((state) => {
    if ("taskId" in target) {
      state.activeTab = "kanban";
      // ... direct mutation via Immer proxy
    }
  }),
```

**Selector hook pattern** (lines 110–126):
```typescript
export const useActiveTab = () => useNavigationStore((s) => s.activeTab);
export const useNavigate = () => useNavigationStore((s) => s.navigate);
export const useNavigationActions = () =>
  useNavigationStore(
    useShallow((s) => ({
      setActiveTab: s.setActiveTab,
      clearPendingAgent: s.clearPendingAgent,
      clearPendingWorktree: s.clearPendingWorktree,
    })),
  );
```

**Changes for Phase 58:**
- Remove `SubView` type, `activeSubView` state, `setActiveSubView` action, `useActiveSubView` selector
- Remove `pendingTaskId` state, `clearPendingTask` action, `usePendingTaskId` selector
- Remove `setActiveSubView` and `clearPendingTask` from `useNavigationActions` return
- Add `activeTaskId: number | null` state (initial: null)
- Add `setActiveTaskId(id: number | null): void` action (Immer set pattern)
- Add `useActiveTaskId()` selector hook (same one-liner pattern as `useActiveTab`)
- Add `setActiveTaskId` to `useNavigationActions` return
- Change `NavigationTarget` union: replace `{ taskId: string }` with `{ taskId: number }`, replace `'backlog' | 'board' | 'archive'` view literals with `'tasks'`
- Update `targetViewToTab`: map `'tasks'` → `'kanban'`; remove backlog/board/archive branches
- In `navigate` handler `taskId` branch: set `state.activeTaskId = target.taskId` (number); remove `state.activeSubView = "board"` line
- In `navigate` handler `view` branch: remove `activeSubView` assignment; add `if (target.view === "tasks") { state.activeTaskId = null; }`

---

### `src/store/navigationStore.test.ts` (test, event-driven)

**Analog:** `src/store/boardStore.test.ts` (lines 1–32) and `src/store/configStore.test.ts` (lines 1–93)

**Test file structure pattern** (from `boardStore.test.ts` lines 1–32):
```typescript
import { beforeEach, describe, expect, it } from "vitest";
import { useBoardStore } from "./boardStore";

function resetStore() {
  useBoardStore.setState({
    activeTerminalTaskId: null,
    isTerminalOpen: false,
  });
}

describe("boardStore – terminal state", () => {
  beforeEach(resetStore);

  it("openTerminal sets activeTerminalTaskId and isTerminalOpen", () => {
    useBoardStore.getState().openTerminal(5);
    const s = useBoardStore.getState();
    expect(s.activeTerminalTaskId).toBe(5);
    expect(s.isTerminalOpen).toBe(true);
  });
});
```

**Pattern: call action then read state** (from `configStore.test.ts` lines 25–37):
```typescript
it("sets default_agent", () => {
  useConfigStore.getState().setDefaultAgent("claude-code");
  expect(useConfigStore.getState().default_agent).toBe("claude-code");
});

it("clears default_agent with null", () => {
  useConfigStore.getState().setDefaultAgent("claude-code");
  useConfigStore.getState().setDefaultAgent(null);
  expect(useConfigStore.getState().default_agent).toBeNull();
});
```

**Pattern: setState for setup then verify** (from `navigationStore.test.ts` lines 118–129):
```typescript
useNavigationStore.setState({ activeTab: "settings" });
const { setActiveTab } = useNavigationStore.getState();
setActiveTab("kanban");
expect(useNavigationStore.getState().slideDirection).toBe(-1);
```

**Changes for Phase 58 — rewrite `resetStore` and tests:**
```typescript
function resetStore() {
  useNavigationStore.setState({
    activeTab: "kanban",
    slideDirection: 1,
    activeTaskId: null,
    pendingAgentId: null,
    pendingWorktreeId: null,
  });
}
```
- Delete all `activeSubView`, `pendingTaskId`, `setActiveSubView`, `clearPendingTask` tests
- Add tests per D-04:
  - `navigate({ taskId: 42 })` → `state.activeTaskId === 42`
  - `navigate({ view: 'tasks' })` → `state.activeTaskId === null`
  - `setActiveTaskId(7)` → `state.activeTaskId === 7`
  - `setActiveTaskId(null)` → `state.activeTaskId === null`
- Keep all `slideDirection`, `clearPendingAgent`, `clearPendingWorktree`, `setActiveTab`, `navigate({agentId})`, `navigate({worktreeId})`, `navigate({view:'agents'})`, etc. tests unchanged

---

### `src/views/KanbanView.tsx` (view, request-response)

**Analog:** `src/views/KanbanView.tsx` (current file being simplified)

**Imports pattern** (lines 1–13 — the kept parts):
```typescript
import { BoardView } from "@/components/views/BoardView";
import { useActiveTaskId } from "@/store/navigationStore";
import { TaskDetailScreen } from "@/components/task/TaskDetailScreen";
```
Remove: `useState`, `LayoutList`, `Archive`, `BacklogView`, `ArchiveView`, `ToggleGroup`, `ToggleGroupItem`, `Tooltip*`, `Input`, `InputGroup*`, `SubView`, `useActiveSubView`, `useNavigationActions`

**New top-level render pattern** (per D-06):
```tsx
export const KanbanView: React.FC = () => {
  const activeTaskId = useActiveTaskId();
  if (activeTaskId !== null) {
    return <TaskDetailScreen taskId={activeTaskId} />;
  }
  return (
    <div className="flex flex-col h-full">
      {/* Action bar skeleton — populated in Phase 59 */}
      <div className="h-12 border-b border-border bg-muted/30 flex items-center justify-between px-4 gap-2 shrink-0">
      </div>
      <div className="flex-1 min-h-0">
        <BoardView />
      </div>
    </div>
  );
};
```

The outer `div` structure (`flex flex-col h-full`) and inner action bar div structure are preserved from the current file (lines 44–46).

---

### `src/App.tsx` (view, request-response)

**Analog:** `src/App.tsx` (current file — targeted deletion)

**Pattern: lazy import to remove** (lines 50–52):
```typescript
const TaskDetail = lazy(() =>
  import("@/components/task/TaskDetail").then((m) => ({ default: m.TaskDetail })),
);
```
Delete this block entirely.

**Pattern: store imports to trim** (lines 14–20):
```typescript
import {
  useActiveTab,
  useSlideDirection,
  usePendingTaskId,     // DELETE
  useNavigationActions,
  type ViewType,
} from "@/store/navigationStore";
```
Remove `usePendingTaskId` from this named import.

**Pattern: hook calls and state to remove** (lines 55–56, 71, 104–113):
```typescript
// DELETE these lines:
const [selectedTask, setSelectedTask] = useState<Task | null>(null);
// ...
const { setActiveTab, clearPendingTask } = useNavigationActions();  // remove clearPendingTask
// ...
const pendingTaskId = usePendingTaskId();
const { data: tasks } = useTasksQuery(currentProject?.id ?? null);  // keep if used elsewhere; check other consumers
useEffect(() => {
  if (pendingTaskId && tasks) {
    const task = tasks.find((t) => String(t.id) === pendingTaskId) ?? null;
    setSelectedTask(task);
    clearPendingTask();
  }
}, [pendingTaskId, tasks, clearPendingTask]);
```

**Pattern: JSX render to remove** (lines 296–300):
```tsx
// DELETE:
<TaskDetail
  task={selectedTask}
  projectPath={currentProject.path}
  onClose={() => setSelectedTask(null)}
/>
```
The `<TaskModal>` render at lines 291–295 stays. The `<Suspense fallback={null}>` wrapper stays if TaskModal still needs it.

**Check `useTasksQuery` usage**: line 105 `const { data: tasks } = useTasksQuery(...)` — verify no other consumer of `tasks` in App.tsx before deleting. In the current file, `tasks` is only referenced in the `useEffect` that resolves `pendingTaskId` (line 109), so the entire `useTasksQuery` call can be deleted alongside the effect.

---

### `src/components/task/TaskDetailScreen.tsx` (component, request-response) — NEW FILE

**Analog:** `src/components/task/TaskDetail.tsx` (lines 1–21) for interface/prop pattern

**Props interface pattern** (from `TaskDetail.tsx` lines 17–21):
```typescript
interface TaskDetailProps {
  task: Task | null;
  projectPath: string;
  onClose: () => void;
}
```

**New file stub pattern** (per D-01):
```tsx
interface TaskDetailScreenProps {
  taskId: number;
}

export const TaskDetailScreen: React.FC<TaskDetailScreenProps> = ({ taskId }) => {
  return <div>Task #{taskId}</div>;
};
```

No imports beyond `React` (which is implicit in this codebase's tsconfig). No `useState`, no service hooks — this is a placeholder only. Phase 62 replaces the body; the import path `@/components/task/TaskDetailScreen` must not change.

---

## Shared Patterns

### Zustand Immer store mutation style
**Source:** `src/store/navigationStore.ts` lines 51–105
**Apply to:** `navigationStore.ts` refactor
```typescript
actionName: (param: Type) =>
  set((state) => {
    state.fieldName = param;  // direct mutation, Immer proxies to immutable update
  }),
```

### Zustand selector hook style
**Source:** `src/store/navigationStore.ts` lines 110–116
**Apply to:** `navigationStore.ts` — new `useActiveTaskId` hook
```typescript
export const useActiveTaskId = () => useNavigationStore((s) => s.activeTaskId);
```

### Store test: resetStore + beforeEach pattern
**Source:** `src/store/boardStore.test.ts` lines 10–15
**Apply to:** `navigationStore.test.ts`
```typescript
function resetStore() {
  useNavigationStore.setState({ /* all state fields at initial values */ });
}
// Every describe block calls: beforeEach(resetStore);
```

### PascalCase named export for React components
**Source:** `src/views/KanbanView.tsx` line 35, `src/components/task/TaskDetail.tsx` (implicit)
**Apply to:** `TaskDetailScreen.tsx`
```typescript
export const TaskDetailScreen: React.FC<TaskDetailScreenProps> = ({ taskId }) => { ... };
```

---

## No Analog Found

None — all five files have direct analogs (three are in-place refactors of existing files).

---

## Metadata

**Analog search scope:** `src/store/`, `src/views/`, `src/components/task/`, `src/App.tsx`
**Files scanned:** 8 (navigationStore.ts, navigationStore.test.ts, boardStore.test.ts, configStore.test.ts, KanbanView.tsx, App.tsx, TaskDetail.tsx, AgentsView.tsx)
**Pattern extraction date:** 2026-05-26
