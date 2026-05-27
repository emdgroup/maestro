# Phase 63: Archive Modal - Pattern Map

**Mapped:** 2026-05-27
**Files analyzed:** 5 (1 new, 1 delete, 2 modify, 1 new test)
**Analogs found:** 5 / 5

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `src/components/kanban/ArchiveModal.tsx` | component (modal) | request-response | `src/components/kanban/CreateTaskModal.tsx` | exact |
| `src/components/views/ArchiveView.tsx` | component (DELETE) | request-response | — | n/a — deleted |
| `src/views/KanbanView.tsx` | view (modify) | request-response | `src/views/KanbanView.tsx` | self |
| `src/store/navigationStore.ts` | store (no change needed) | — | `src/store/navigationStore.ts` | self |
| `src/components/kanban/__tests__/ArchiveModal.test.tsx` | test | — | `src/components/kanban/__tests__/CreateTaskModal.test.tsx` | exact |

## Pattern Assignments

### `src/components/kanban/ArchiveModal.tsx` (component, request-response)

**Analog:** `src/components/kanban/CreateTaskModal.tsx`

**Imports pattern** (`CreateTaskModal.tsx` lines 1-33 + `ArchiveView.tsx` lines 1-9):
```tsx
import { useState, useMemo, useEffect } from "react";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/ui/dialog";
import { Input } from "@/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/ui/tabs";
import { useTasksQuery } from "@/services/task.service";
import { useNavigationActions } from "@/store/navigationStore";
import type { Task, TaskStatus } from "@/types/bindings";
import { PRIORITY_BADGE_CLASSES } from "@/utils/constants/priority";
```

Notes on imports:
- `@/ui/*` is the project alias for `src/components/ui/*`
- No barrel exports — all imports are direct named imports from the component file
- `@/types/bindings` is fully generated; never edit it
- `useNavigationActions` (not `useKanban`) is correct here — `KanbanProvider` does not wrap `ArchiveModal` (see Pitfall 5 in RESEARCH.md)

**Props interface pattern** (`CreateTaskModal.tsx` lines 44-48):
```tsx
interface ArchiveModalProps {
  isOpen: boolean;
  onClose: () => void;
  projectId: number;
}

export function ArchiveModal({ isOpen, onClose, projectId }: ArchiveModalProps) {
```

**State reset on close pattern** (`CreateTaskModal.tsx` lines 121-130):
```tsx
// Reset local state when modal closes — prevents stale search/filter on re-open
useEffect(() => {
  if (!isOpen) {
    setSearch("");
    setFilter("all");
  }
}, [isOpen]);
```

**Dialog container pattern** (`CreateTaskModal.tsx` lines 183-184):
```tsx
// onOpenChange receives (open: boolean, eventDetails) — first arg is the boolean
<Dialog open={isOpen} onOpenChange={(open) => { if (!open) onClose(); }}>
  <DialogContent className="sm:max-w-[520px] overflow-y-auto custom-scrollbar">
```
For `ArchiveModal`, override with `sm:max-w-2xl flex flex-col max-h-[80vh]` — wider for the task list, flex-col so the inner list can scroll independently.

**Tabs controlled-state pattern** (`src/components/ui/tabs.tsx` lines 8-16):
```tsx
// TabsPrimitive.Root.Props uses value + onValueChange (base-ui, not Radix)
// onValueChange receives a plain string — cast to ArchiveFilter in handler
type ArchiveFilter = "all" | "Done" | "Cancelled";
const [filter, setFilter] = useState<ArchiveFilter>("all");

<Tabs value={filter} onValueChange={(v) => setFilter(v as ArchiveFilter)}>
  <TabsList>
    <TabsTrigger value="all">All</TabsTrigger>
    <TabsTrigger value="Done">Done</TabsTrigger>
    <TabsTrigger value="Cancelled">Cancelled</TabsTrigger>
  </TabsList>
</Tabs>
```

**Filter logic pattern — lift from ArchiveView.tsx lines 44-48**:
```tsx
// Wrap in useMemo to avoid recomputing on every render
const archiveTasks = useMemo(() => {
  return (tasks ?? [])
    .filter((t) => t.archived_at != null || t.status === "Cancelled")
    .filter((t) => filter === "all" || t.status === filter)
    .filter((t) => !search || t.title.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
}, [tasks, filter, search]);
```

**Task row pattern — from ArchiveView.tsx lines 60-87**:
```tsx
// Task row: full-width button, badges for priority + status
// Replace onTaskClick (from KanbanContext) with local handleTaskClick
<button
  key={task.id}
  className="flex items-center gap-3 rounded-lg border bg-card px-4 py-3 hover:bg-accent/5 transition-colors text-left w-full"
  onClick={() => handleTaskClick(task)}
>
  <div className="flex-1 min-w-0">
    <span className="text-sm font-medium text-foreground truncate block">{task.title}</span>
  </div>
  <div className="flex items-center gap-2 shrink-0">
    <span className="text-xs text-muted-foreground">{formatDate(task.updated_at)}</span>
    <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${PRIORITY_BADGE_CLASSES[task.priority]}`}>
      {task.priority}
    </span>
    <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${STATUS_BADGE_CLASSES[task.status] ?? ""}`}>
      {task.status}
    </span>
  </div>
</button>
```

**formatDate utility — from ArchiveView.tsx lines 11-22**:
```tsx
// Copy this helper directly into ArchiveModal.tsx (file will be deleted)
function formatDate(dateStr: string | null | undefined): string {
  if (!dateStr) return "—";
  try {
    return new Date(dateStr).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return "—";
  }
}
```

**STATUS_BADGE_CLASSES constant — from ArchiveView.tsx lines 6-9**:
```tsx
// Copy directly into ArchiveModal.tsx
const STATUS_BADGE_CLASSES: Partial<Record<TaskStatus, string>> = {
  Done: "bg-green-100 text-green-700 border border-green-300 dark:bg-green-950 dark:text-green-300 dark:border-green-800",
  Cancelled: "bg-destructive/15 text-destructive border border-destructive/30",
};
```

**Navigate + close pattern** (`src/store/navigationStore.ts` lines 106-114):
```tsx
// Set activeTaskId first, then close — React batches the two state updates
// DO NOT use useKanban() here; KanbanProvider does not wrap ArchiveModal
const { setActiveTaskId } = useNavigationActions();

function handleTaskClick(task: Task) {
  setActiveTaskId(task.id);
  onClose(); // closes modal; KanbanView will switch to TaskDetailScreen
}
```

**Inner list scroll container pattern** (avoids modal overflow, see RESEARCH Pitfall 4):
```tsx
// Only the inner list scrolls; DialogContent itself uses max-h-[80vh] flex flex-col
<div className="flex-1 overflow-y-auto min-h-0 custom-scrollbar">
  {/* task rows here */}
</div>
```

---

### `src/views/KanbanView.tsx` (view, modify)

**Analog:** `src/views/KanbanView.tsx` (self — add to existing pattern)

**Existing action bar structure** (`KanbanView.tsx` lines 57-147):
```tsx
// Action bar: h-12 border-b bg-muted/30 flex items-center px-4 gap-2 shrink-0
// Current order: Search → Priority filter → Label filter → [ml-auto div] → New Task button
// Archive button goes LEFT of the ml-auto div (before New Task)
<div className="h-12 border-b border-border bg-muted/30 flex items-center px-4 gap-2 shrink-0">
  <Input ... />               {/* search */}
  <Popover> ... </Popover>    {/* priority */}
  <Popover> ... </Popover>    {/* label */}

  {/* ADD: Archive button before the ml-auto div */}
  <Button
    size="sm"
    variant="outline"
    onClick={() => setIsArchiveModalOpen(true)}
  >
    <Archive className="size-4" />
    Archive
  </Button>

  <div className="ml-auto">
    <Button size="sm" onClick={() => setIsCreateModalOpen(true)}>
      <Plus className="size-4" />
      New Task
    </Button>
  </div>
</div>
```

**Modal mount pattern** (`KanbanView.tsx` lines 148-152):
```tsx
// CreateTaskModal is mounted outside the action bar div but inside the view root div
// ArchiveModal follows the same placement — after CreateTaskModal
<CreateTaskModal
  isOpen={isCreateModalOpen}
  onClose={() => setIsCreateModalOpen(false)}
  projectId={projectId ?? 0}
/>
<ArchiveModal
  isOpen={isArchiveModalOpen}
  onClose={() => setIsArchiveModalOpen(false)}
  projectId={projectId ?? 0}
/>
```

**New state + import additions** (`KanbanView.tsx` lines 1-34 context):
```tsx
// Add to existing imports:
import { Archive } from "lucide-react";
import { ArchiveModal } from "@/components/kanban/ArchiveModal";

// Add to existing useState declarations (line 34 area):
const [isArchiveModalOpen, setIsArchiveModalOpen] = useState(false);
```

---

### `src/store/navigationStore.ts` (store, no change needed)

**No modifications required.** `setActiveTaskId` and `useNavigationActions` already exist and are sufficient for Phase 63.

**Relevant existing API** (`navigationStore.ts` lines 82-85, 106-114):
```ts
// setActiveTaskId — accepts number | null
setActiveTaskId: (id: number | null) =>
  set((state) => {
    state.activeTaskId = id;
  }),

// useNavigationActions — stable shallow selector (safe for component use)
export const useNavigationActions = () =>
  useNavigationStore(
    useShallow((s) => ({
      setActiveTab: s.setActiveTab,
      setActiveTaskId: s.setActiveTaskId,
      clearPendingAgent: s.clearPendingAgent,
      clearPendingWorktree: s.clearPendingWorktree,
    })),
  );
```

---

### `src/components/kanban/__tests__/ArchiveModal.test.tsx` (test)

**Analog:** `src/components/kanban/__tests__/CreateTaskModal.test.tsx`

**Test file structure pattern** (`CreateTaskModal.test.tsx` lines 1-69):
```tsx
import { describe, it, vi } from "vitest";

// Mock all hooks the component will use
vi.mock("@/services/task.service", () => ({
  useTasksQuery: vi.fn(() => ({
    data: [
      {
        id: 1,
        title: "Finished task",
        status: "Done",
        priority: "Medium",
        labels: [],
        archived_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-15T00:00:00Z",
      },
      {
        id: 2,
        title: "Dropped task",
        status: "Cancelled",
        priority: "Low",
        labels: [],
        archived_at: "2026-01-05T00:00:00Z",
        updated_at: "2026-01-10T00:00:00Z",
      },
    ],
    isLoading: false,
  })),
}));

vi.mock("@/store/navigationStore", () => ({
  useNavigationActions: vi.fn(() => ({ setActiveTaskId: vi.fn() })),
}));

describe("ArchiveModal", () => {
  // ARCHIVE-01: Archive button in action bar opens modal
  it.todo("renders task list when isOpen=true");

  // ARCHIVE-02: Search input filters tasks
  it.todo("filters tasks by search input value");

  // ARCHIVE-02: Filter tabs update list
  it.todo("shows only Done tasks when Done tab selected");
  it.todo("shows only Cancelled tasks when Cancelled tab selected");

  // ARCHIVE-03: Clicking row closes modal + sets activeTaskId
  it.todo("calls setActiveTaskId and onClose when a task row is clicked");
});
```

Note: All tests are `it.todo` stubs at this stage (matches the CreateTaskModal analog pattern exactly). Actual rendering tests require `@testing-library/react` setup already present in `src/test/setup.ts`.

---

## Shared Patterns

### Dialog open/close (base-ui)
**Source:** `src/components/kanban/CreateTaskModal.tsx` line 183, `src/components/ui/dialog.tsx` lines 10-70
**Apply to:** `ArchiveModal.tsx`
```tsx
// onOpenChange first arg is boolean — not an event object
<Dialog open={isOpen} onOpenChange={(open) => { if (!open) onClose(); }}>
  <DialogContent className="...">
    <DialogTitle>...</DialogTitle>
    <DialogDescription className="sr-only">...</DialogDescription>
    {/* content */}
  </DialogContent>
</Dialog>
```
`DialogDescription` with `className="sr-only"` is required for accessibility (seen in CreateTaskModal line 188).

### Local state reset on modal close
**Source:** `src/components/kanban/CreateTaskModal.tsx` lines 121-130
**Apply to:** `ArchiveModal.tsx`
```tsx
useEffect(() => {
  if (!isOpen) {
    // reset all local modal state here
  }
}, [isOpen]);
```

### useMemo for filtered/derived lists
**Source:** `src/views/KanbanView.tsx` lines 26-29, 36-49
**Apply to:** `ArchiveModal.tsx` — wrap filter chain in `useMemo([tasks, filter, search])`

### Path alias conventions
**Source:** All files in `src/`
**Apply to:** All new/modified files
```
@/ui/*       → src/components/ui/*
@/services/* → src/services/*
@/store/*    → src/store/*
@/lib/*      → src/utils/helpers/*
@/types/*    → src/types/*
@/utils/*    → src/utils/*
```
No barrel index files — always import directly from the specific file.

### base-ui Trigger — no asChild
**Source:** `CLAUDE.md` key pitfall section
**Apply to:** `KanbanView.tsx` action bar button (not a trigger, plain Button — no issue)
```tsx
// base-ui Trigger has no asChild prop.
// KanbanView action bar uses plain <Button> with onClick — this is correct.
// No PopoverTrigger/DialogTrigger wrapping needed for the Archive button.
```

## No Analog Found

All files have direct analogs. No entries in this section.

## File Deletion

| File | Action | Reason |
|------|--------|--------|
| `src/components/views/ArchiveView.tsx` | DELETE entirely | Logic migrated into `ArchiveModal.tsx`; sub-view routing removed in Phase 58; this is the cleanup |

The planner should schedule deletion of `ArchiveView.tsx` as a discrete step, after `ArchiveModal.tsx` is created and `KanbanView.tsx` no longer imports it.

Check for any remaining import of `ArchiveView` before deletion:
```bash
ast-grep --pattern 'import { $$$} from "$PATH"' --lang tsx src/
# or simply: grep -r "ArchiveView" src/
```

## Metadata

**Analog search scope:** `src/components/kanban/`, `src/components/views/`, `src/views/`, `src/store/`, `src/components/ui/`
**Files read:** 7 (CreateTaskModal.tsx, ArchiveView.tsx, KanbanView.tsx, navigationStore.ts, dialog.tsx, tabs.tsx, CreateTaskModal.test.tsx)
**Pattern extraction date:** 2026-05-27
