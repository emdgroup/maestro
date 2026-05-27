# Phase 63: Archive Modal - Research

**Researched:** 2026-05-27
**Domain:** React / TypeScript frontend component — modal dialog with tabbed filtering
**Confidence:** HIGH

## Summary

Phase 63 converts the existing `ArchiveView.tsx` sub-view into a modal dialog (`ArchiveModal.tsx`) accessible from the board action bar in `KanbanView.tsx`. The `ArchiveView.tsx` component is then deleted entirely. The modal lists tasks where `archived_at` is set or status is `Cancelled`, supports real-time search and tab filtering (All / Done / Cancelled), and clicking a row closes the modal and navigates to `TaskDetailScreen` in read-only mode.

All the data plumbing already exists. `useTasksQuery` returns every task including archived/cancelled — the filtering used in `ArchiveView.tsx` can be lifted directly into the modal. The navigation to task detail is `setActiveTaskId(taskId)` from `navigationStore`. Read-only mode in `TaskDetailScreen` is automatic: any non-Backlog task is read-only by the `isEditable = task.status === "Backlog"` guard, and archived tasks keep their status (`Done` or `Cancelled`), so the detail screen shows the locked-state UI with no edit actions.

The modal component pattern is established: `Dialog` / `DialogContent` from `src/components/ui/dialog.tsx` (base-ui under the hood). The `Tabs` / `TabsList` / `TabsTrigger` components in `src/components/ui/tabs.tsx` exist and are available but have not yet been used in any component — this phase will be the first consumer.

**Primary recommendation:** One new file `ArchiveModal.tsx`, added to `KanbanView.tsx`'s action bar with local `isArchiveModalOpen` state, then delete `ArchiveView.tsx`. No backend changes required.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Archive button trigger | Browser / Client | — | Local state toggle in KanbanView action bar |
| Modal dialog container | Browser / Client | — | `Dialog` from base-ui, rendered in KanbanView |
| Task list filtering | Browser / Client | — | Client-side filter over `useTasksQuery` data |
| Real-time search | Browser / Client | — | Controlled `Input` + `useMemo` filter; no server call |
| Tab filtering (All/Done/Cancelled) | Browser / Client | — | `Tabs` component driving a filter enum |
| Task data fetch | API / Backend | Browser (cached) | `useTasksQuery` already fetches all tasks including archived |
| Read-only detail navigation | Browser / Client | — | `setActiveTaskId(id)` + Dialog close — no new routes |

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@base-ui-components/react` | existing | `Dialog`, `Tabs` primitive | Project standard — all existing modals use this |
| React | 19 | Component + state | Project standard |
| TanStack Query | existing | `useTasksQuery` — task data | Project pattern; all IPC calls via hooks |
| Zustand | existing | `navigationStore.setActiveTaskId` | Project pattern for view routing |
| Tailwind CSS 4.1 | existing | Styling | Project standard |
| lucide-react | existing | Icon for Archive button | Project standard |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `framer-motion` | existing | Entry animation on TaskDetailScreen | Already used by `TaskDetailScreen` on mount — no change needed here |
| `class-variance-authority` | existing | `buttonVariants()` for popover triggers | Used in KanbanView action bar already |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `Dialog` from `@/ui/dialog` | Custom Popover | Dialog is semantically correct for blocking modal; consistent with all other modals in the project |
| `Tabs` from `@/ui/tabs` | Button group with manual state | Tabs is the correct primitive and exists in the design system — use it |

**Installation:** None required — all libraries already installed.

## Architecture Patterns

### System Architecture Diagram

```
KanbanView (action bar)
  │
  ├── [Archive button] ──► sets isArchiveModalOpen = true
  │
  └── <ArchiveModal
        isOpen={isArchiveModalOpen}
        onClose={() => setIsArchiveModalOpen(false)}
        projectId={projectId}
      />
            │
            ├── useTasksQuery(projectId)        ← existing cache, no new IPC
            │     └── filter: archived_at != null || status === "Cancelled"
            │
            ├── <Input> search ──► useMemo filter on title
            │
            ├── <Tabs> filter
            │     ├── All
            │     ├── Done
            │     └── Cancelled
            │
            └── task row click
                  ├── Dialog.onOpenChange(false) → closes modal
                  └── setActiveTaskId(task.id) → KanbanView renders TaskDetailScreen
```

### Recommended Project Structure
```
src/
├── components/
│   ├── kanban/
│   │   └── ArchiveModal.tsx      # new — modal component
│   └── views/
│       └── ArchiveView.tsx       # DELETE — replaced by ArchiveModal
└── views/
    └── KanbanView.tsx            # ADD Archive button + ArchiveModal mount
```

`ArchiveModal.tsx` goes in `src/components/kanban/` alongside `CreateTaskModal.tsx` — both are board-level modals opened from the kanban action bar.

### Pattern 1: Dialog with controlled open state (project standard)

**What:** `Dialog` accepts `open` + `onOpenChange` props. The parent manages `isOpen` state.
**When to use:** Every modal in this codebase uses this pattern.

```tsx
// Source: src/components/kanban/CreateTaskModal.tsx (verified)
<Dialog open={isOpen} onOpenChange={(open) => { if (!open) onClose(); }}>
  <DialogContent className="sm:max-w-[520px] overflow-y-auto custom-scrollbar">
    <DialogTitle>...</DialogTitle>
    {/* content */}
  </DialogContent>
</Dialog>
```

**Key fact:** `DialogContent` defaults to `sm:max-w-sm`. For a tall list modal, use a wider size via `className` override. The ReviewModal uses a full-width approach. For ArchiveModal, `sm:max-w-2xl` with a fixed height scroll area is appropriate.

### Pattern 2: Tabs component — base-ui (first use in project)

**What:** `Tabs` from `src/components/ui/tabs.tsx` wraps `@base-ui-components/react/tabs`. Active tab tracked by `value` prop.
**When to use:** Multi-filter views with mutually exclusive selection.

```tsx
// Source: src/components/ui/tabs.tsx (verified)
// Tab state controlled externally (matches project's controlled-state preference)
const [filter, setFilter] = useState<ArchiveFilter>("all");

<Tabs value={filter} onValueChange={(v) => setFilter(v as ArchiveFilter)}>
  <TabsList>
    <TabsTrigger value="all">All</TabsTrigger>
    <TabsTrigger value="Done">Done</TabsTrigger>
    <TabsTrigger value="Cancelled">Cancelled</TabsTrigger>
  </TabsList>
</Tabs>
```

**Critical:** `TabsPrimitive.Root.Props` uses `value` / `onValueChange`. Tab trigger values are strings; cast to `ArchiveFilter` in the handler.

### Pattern 3: Action bar button in KanbanView (established pattern)

**What:** Add Archive button to existing action bar (the `h-12 border-b` div in `KanbanView`).
**When to use:** Board-level actions that do not need prop drilling.

```tsx
// Source: src/views/KanbanView.tsx (verified)
// Pattern: import Archive icon, add state, render modal below CreateTaskModal

import { Archive } from "lucide-react";
// ...
const [isArchiveModalOpen, setIsArchiveModalOpen] = useState(false);
// ...
// In the action bar div:
<Button
  size="sm"
  variant="outline"
  onClick={() => setIsArchiveModalOpen(true)}
>
  <Archive className="size-4" />
  Archive
</Button>

// After CreateTaskModal:
<ArchiveModal
  isOpen={isArchiveModalOpen}
  onClose={() => setIsArchiveModalOpen(false)}
  projectId={projectId ?? 0}
/>
```

### Pattern 4: Filter logic — lifted from existing ArchiveView

The filter/search logic in `ArchiveView.tsx` is directly reusable inside `ArchiveModal.tsx`:

```tsx
// Source: src/components/views/ArchiveView.tsx (verified)
const archiveTasks: Task[] = (tasks ?? [])
  .filter((t) => t.archived_at != null || t.status === "Cancelled")
  .filter((t) => filter === "all" || t.status === filter)
  .filter((t) => !search || t.title.toLowerCase().includes(search.toLowerCase()))
  .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
```

Wrap in `useMemo` with `[tasks, filter, search]` dependencies inside the modal component.

### Pattern 5: Navigate to task detail + close modal

**What:** When a task row is clicked, close the modal AND navigate to task detail screen.
**Critical ordering:** Set `activeTaskId` first, then close modal. `KanbanView` renders `<TaskDetailScreen>` when `activeTaskId !== null` (full-screen takeover), so closing the modal before setting the ID would cause a render flash.

```tsx
// Source: src/store/navigationStore.ts (verified)
const { setActiveTaskId } = useNavigationActions();

function handleTaskClick(task: Task) {
  setActiveTaskId(task.id);
  onClose(); // closes modal — KanbanView will switch to TaskDetailScreen
}
```

### Pattern 6: Read-only guard in TaskDetailScreen (NO changes needed)

**What:** `TaskDetailScreen` is already read-only for all non-Backlog statuses.
**Verification:** `isEditable = task.status === "Backlog"`. Archived tasks have status `Done` or `Cancelled` — both are non-Backlog. Cancelled tasks also have `archived_at` set (from `cancel_task` IPC which sets `status='Cancelled', archived_at=NOW()`).

The existing locked-state rendering (`Read-only — task is {task.status}` banner, no edit actions visible) already satisfies ARCHIVE-03. No changes to `TaskDetailScreen` needed.

**One edge case:** The `TaskDetailScreen` action bar shows an Archive button when `task.status === "Done"`. For tasks opened from the archive modal, this button should still work (re-archiving a done task is a no-op since it's already archived). This is acceptable behavior — no special guard needed.

### Anti-Patterns to Avoid

- **Using `ArchiveView` as a sub-view:** The whole point of this phase is removing sub-view routing. Do not wrap `ArchiveView` in a dialog — delete it and inline the logic in `ArchiveModal`.
- **Separate state for modal search/filter:** Keep `search` and `filter` as local state inside `ArchiveModal` (not in Zustand). No other component needs these values.
- **Custom dialog backdrop:** Do not hand-roll a backdrop. `DialogContent` already renders `DialogOverlay` (backdrop) via `DialogPortal`.
- **Fetching archived tasks separately:** `useTasksQuery` already returns all tasks. Do not create a new IPC endpoint for archived task listing — just filter client-side.
- **`asChild` on `DialogTrigger`:** Not applicable here since the trigger is not placed inside `Dialog` — it's a standalone button in KanbanView's action bar that controls `isArchiveModalOpen` state.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Modal overlay + focus trap | Custom backdrop + portal | `Dialog` / `DialogContent` from `@/ui/dialog` | Focus management, escape-key close, aria-modal, animation — all handled |
| Tab switching logic | `useState` + `if` branches | `Tabs` / `TabsList` / `TabsTrigger` from `@/ui/tabs` | Keyboard navigation, aria-selected, consistent styling |
| Archived task query | New IPC command | `useTasksQuery` + client-side filter | All tasks already fetched; backend already returns archived tasks in the list |
| Date formatting | Custom formatter | Reuse `formatDate()` from `ArchiveView.tsx` | Already handles null/invalid dates |

**Key insight:** The existing `ArchiveView.tsx` is essentially a pre-built first draft of the modal's inner content. The migration is mostly a container swap (sub-view → dialog) with minor layout adjustments.

## Common Pitfalls

### Pitfall 1: onOpenChange signature mismatch
**What goes wrong:** Passing `(open: boolean, eventDetails) => void` but treating `open` as an event object.
**Why it happens:** `Dialog.onOpenChange` in base-ui passes `(open: boolean, eventDetails)` — first arg is the boolean, not an event.
**How to avoid:** `onOpenChange={(open) => { if (!open) onClose(); }}` — confirmed pattern from `CreateTaskModal.tsx` and `TaskDetailScreen.tsx`.
**Warning signs:** Modal closes immediately on open, or never closes.

### Pitfall 2: Tabs value type mismatch
**What goes wrong:** `onValueChange` receives a string; comparing it to a typed union without casting causes TypeScript error.
**Why it happens:** base-ui Tabs `onValueChange` signature is `(value: string) => void`.
**How to avoid:** Cast explicitly: `(v) => setFilter(v as ArchiveFilter)`. Define `type ArchiveFilter = "all" | "Done" | "Cancelled"` to match exactly.
**Warning signs:** TypeScript type error on `setFilter(v)` where `v: string` is not assignable to `ArchiveFilter`.

### Pitfall 3: DialogContent default max-width is too narrow
**What goes wrong:** Archive list is cramped.
**Why it happens:** `DialogContent` defaults to `sm:max-w-sm` (~384px). A task list needs more width.
**How to avoid:** Override with `className="sm:max-w-2xl"` or similar. The `CreateTaskModal` uses `sm:max-w-[520px]`.
**Warning signs:** Title truncation, layout overflow in the task row.

### Pitfall 4: Modal height not constrained — list overflows page
**What goes wrong:** Many archived tasks push the modal off-screen.
**Why it happens:** `DialogContent` does not constrain its own height.
**How to avoid:** Give the task list a max-height and overflow-y-auto: wrap the list in `<div className="max-h-96 overflow-y-auto">`. The full `DialogContent` should not scroll — only the inner list.
**Warning signs:** Modal taller than viewport; backdrop visible but modal extends beyond it.

### Pitfall 5: KanbanProvider not available inside ArchiveModal
**What goes wrong:** `useKanban()` throws "must be used within KanbanProvider" if `ArchiveModal` tries to call it.
**Why it happens:** `KanbanProvider` wraps `BoardView`, not the full `KanbanView`. The Archive button and `ArchiveModal` are siblings to the provider, not children.
**How to avoid:** Pass `projectId` as a prop to `ArchiveModal` directly (same pattern as `CreateTaskModal`). Use `useNavigationActions` directly from the store for navigation — not `onTaskClick` from context.
**Warning signs:** Runtime error "useKanban must be used within KanbanProvider".

### Pitfall 6: Setting activeTaskId does not close the modal automatically
**What goes wrong:** Both the archive modal and task detail screen render simultaneously.
**Why it happens:** `activeTaskId !== null` causes `KanbanView` to render `<TaskDetailScreen>` (full-screen), but if the modal is still `open={true}` it will layer on top.
**How to avoid:** Call `onClose()` (set `isArchiveModalOpen = false`) in the row click handler, either before or after `setActiveTaskId`. Since `KanbanView` shows `TaskDetailScreen` when `activeTaskId !== null`, both executing together in the same event is safe — React batches the state updates.

## Code Examples

### ArchiveModal skeleton
```tsx
// Based on CreateTaskModal.tsx pattern (verified)
import { useState, useMemo } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/ui/dialog";
import { Input } from "@/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/ui/tabs";
import { useTasksQuery } from "@/services/task.service";
import { useNavigationActions } from "@/store/navigationStore";
import type { Task, TaskStatus } from "@/types/bindings";
import { PRIORITY_BADGE_CLASSES } from "@/utils/constants/priority";

type ArchiveFilter = "all" | "Done" | "Cancelled";

const STATUS_BADGE_CLASSES: Partial<Record<TaskStatus, string>> = {
  Done: "bg-green-100 text-green-700 border border-green-300 dark:bg-green-950 dark:text-green-300 dark:border-green-800",
  Cancelled: "bg-destructive/15 text-destructive border border-destructive/30",
};

interface ArchiveModalProps {
  isOpen: boolean;
  onClose: () => void;
  projectId: number;
}

export function ArchiveModal({ isOpen, onClose, projectId }: ArchiveModalProps) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<ArchiveFilter>("all");
  const { setActiveTaskId } = useNavigationActions();
  const { data: tasks, isLoading } = useTasksQuery(projectId);

  const archiveTasks = useMemo(() => {
    return (tasks ?? [])
      .filter((t) => t.archived_at != null || t.status === "Cancelled")
      .filter((t) => filter === "all" || t.status === filter)
      .filter((t) => !search || t.title.toLowerCase().includes(search.toLowerCase()))
      .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
  }, [tasks, filter, search]);

  function handleTaskClick(task: Task) {
    setActiveTaskId(task.id);
    onClose();
  }

  return (
    <Dialog open={isOpen} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-2xl flex flex-col max-h-[80vh]">
        <DialogTitle>Archive</DialogTitle>
        <Input
          placeholder="Search archived tasks..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="h-8"
        />
        <Tabs value={filter} onValueChange={(v) => setFilter(v as ArchiveFilter)}>
          <TabsList>
            <TabsTrigger value="all">All</TabsTrigger>
            <TabsTrigger value="Done">Done</TabsTrigger>
            <TabsTrigger value="Cancelled">Cancelled</TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="flex-1 overflow-y-auto min-h-0">
          {isLoading && <p className="text-sm text-muted-foreground p-2">Loading...</p>}
          {!isLoading && archiveTasks.length === 0 && (
            <p className="text-sm text-muted-foreground p-4 text-center">No archived tasks</p>
          )}
          {archiveTasks.map((task) => (
            <button
              key={task.id}
              className="flex items-center gap-3 w-full px-4 py-3 rounded-lg hover:bg-accent/5 transition-colors text-left border-b border-border last:border-0"
              onClick={() => handleTaskClick(task)}
            >
              <span className="flex-1 text-sm font-medium truncate">{task.title}</span>
              {/* priority + status badges */}
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
```

### KanbanView action bar addition
```tsx
// Source: src/views/KanbanView.tsx (verified, adding to existing pattern)
import { Archive } from "lucide-react";
import { ArchiveModal } from "@/components/kanban/ArchiveModal";
// ...
const [isArchiveModalOpen, setIsArchiveModalOpen] = useState(false);
// In action bar div (before "New Task" button):
<Button
  size="sm"
  variant="outline"
  onClick={() => setIsArchiveModalOpen(true)}
>
  <Archive className="size-4" />
  Archive
</Button>

// After CreateTaskModal:
<ArchiveModal
  isOpen={isArchiveModalOpen}
  onClose={() => setIsArchiveModalOpen(false)}
  projectId={projectId ?? 0}
/>
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| ArchiveView as sub-view (3-icon toggle) | Archive as modal from action bar | Phase 59 decision (sub-view toggle removed) | Simpler navigation; board always visible |
| Tabs component unused | First use in Phase 63 | Now | Establishes Tabs pattern for future use |

**Deprecated/outdated:**
- `ArchiveView.tsx`: Deleted in this phase. The entire file (`src/components/views/ArchiveView.tsx`) is removed — logic migrated into `ArchiveModal.tsx`.
- Sub-view routing (`activeSubView`): Already removed in Phase 58. Phase 63 is the cleanup of the last sub-view component.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | The `Tabs` component's `onValueChange` prop type is `(value: string) => void` | Code Examples | TypeScript compile error — easily fixed by checking the actual prop types |
| A2 | No new IPC command is needed (all tasks already returned by `get_tasks`) | Architecture | If `get_tasks` is ever filtered to exclude archived tasks, a new endpoint would be needed — but current implementation confirmed by code inspection |

**All other claims in this document are VERIFIED by direct code inspection of the project codebase.**

## Open Questions (RESOLVED)

1. **Placement of Archive button relative to "New Task" button**
   - What we know: The action bar has Search → Priority filter → Label filter → [spacer] → New Task
   - What's unclear: Should Archive be left of New Task (inside spacer area) or right of it?
   - RESOLVED: Left of New Task, before the `ml-auto` div — keeps New Task as the rightmost primary action

2. **Reset search/filter when modal closes**
   - What we know: Search and filter are local state inside `ArchiveModal`
   - What's unclear: Should they reset to defaults when modal re-opens?
   - RESOLVED: `useEffect` on `!isOpen` to reset state, same as `CreateTaskModal` pattern

## Environment Availability

Step 2.6: SKIPPED (no external dependencies — this phase is frontend-only, all libraries already installed).

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest (configured in `vite.config.ts`) |
| Config file | `vite.config.ts` (test section) |
| Quick run command | `pnpm test ArchiveModal` |
| Full suite command | `pnpm test` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| ARCHIVE-01 | Archive button in action bar opens modal | unit | `pnpm test ArchiveModal` | ❌ Wave 0 |
| ARCHIVE-02 | Search input filters tasks; filter tabs update list | unit | `pnpm test ArchiveModal` | ❌ Wave 0 |
| ARCHIVE-03 | Clicking row closes modal + opens task detail (read-only implied by task status) | unit | `pnpm test ArchiveModal` | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** `pnpm test ArchiveModal`
- **Per wave merge:** `pnpm test`
- **Phase gate:** Full suite green before `/gsd-verify-work`

### Wave 0 Gaps
- [ ] `src/components/kanban/__tests__/ArchiveModal.test.tsx` — covers ARCHIVE-01, ARCHIVE-02, ARCHIVE-03

*(Existing test infrastructure — Vitest, happy-dom, `src/test/setup.ts` — covers all framework needs. Only the test file itself is missing.)*

## Security Domain

> This phase has no authentication, cryptography, access control, or external input that reaches the server. All filtering is client-side on data already fetched by `useTasksQuery`. No ASVS categories are applicable.

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no | — |
| V3 Session Management | no | — |
| V4 Access Control | no | — |
| V5 Input Validation | no — search is client-side filter only, never sent to server | — |
| V6 Cryptography | no | — |

## Sources

### Primary (HIGH confidence)
- Direct code inspection of `/home/m306213/workspace/maestro/src/components/views/ArchiveView.tsx` — full component read
- Direct code inspection of `/home/m306213/workspace/maestro/src/views/KanbanView.tsx` — action bar structure
- Direct code inspection of `/home/m306213/workspace/maestro/src/components/ui/dialog.tsx` — Dialog API
- Direct code inspection of `/home/m306213/workspace/maestro/src/components/ui/tabs.tsx` — Tabs API
- Direct code inspection of `/home/m306213/workspace/maestro/src/components/ui/alert-dialog.tsx` — AlertDialog patterns
- Direct code inspection of `/home/m306213/workspace/maestro/src/store/navigationStore.ts` — `setActiveTaskId`, `useNavigationActions`
- Direct code inspection of `/home/m306213/workspace/maestro/src/services/task.service.ts` — `useTasksQuery`, mutations
- Direct code inspection of `/home/m306213/workspace/maestro/src/components/kanban/CreateTaskModal.tsx` — Dialog usage pattern
- Direct code inspection of `/home/m306213/workspace/maestro/src/components/task/TaskDetailScreen.tsx` — read-only guard, navigation patterns
- Direct code inspection of `/home/m306213/workspace/maestro/src/contexts/KanbanContext.tsx` — KanbanProvider scope
- Direct code inspection of `/home/m306213/workspace/maestro/src-tauri/src/ipc/task_handlers.rs` — `get_tasks`, `archive_task`, `cancel_task` SQL
- Direct code inspection of `.planning/STATE.md` — locked decision D-63: ArchiveView.tsx deleted
- Direct code inspection of `.planning/REQUIREMENTS.md` — ARCHIVE-01, ARCHIVE-02, ARCHIVE-03 definitions

### Secondary (MEDIUM confidence)
- `.planning/phases/62-task-detail-screen/62-RESEARCH.md` — confirmed read-only model for non-Backlog tasks

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all libraries already in use, API verified by code inspection
- Architecture: HIGH — data flow is a simplification of existing ArchiveView; no novel patterns
- Pitfalls: HIGH — all pitfalls sourced from confirmed code patterns and project decisions

**Research date:** 2026-05-27
**Valid until:** 2026-06-27 (stable codebase; component interfaces change infrequently)

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| ARCHIVE-01 | User views archived/cancelled tasks via modal from board action bar | Archive button added to KanbanView action bar; `isArchiveModalOpen` state drives Dialog open/close; `useTasksQuery` + client filter supplies task list |
| ARCHIVE-02 | Archive modal supports search and filter by Done/Cancelled | `Input` for search, `Tabs`/`TabsTrigger` for All/Done/Cancelled filter; `useMemo` filter on `[tasks, filter, search]` updates list in real time |
| ARCHIVE-03 | Clicking archived task opens read-only task detail screen | `setActiveTaskId(task.id)` + `onClose()` in row click handler; `TaskDetailScreen` is already read-only for non-Backlog tasks — no changes to detail screen needed |
</phase_requirements>
