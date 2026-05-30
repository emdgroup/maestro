# Plan: Drag-and-Drop Task Cards Between Backlog ↔ Ready

## Context

Kanban board is display-only — no drag between columns. User wants DnD **only between Backlog and Ready** (both directions). Other columns (InProgress, Review, Done) not droppable.

## Approach

Install `@dnd-kit/react` + `@dnd-kit/helpers`. Use `useSortable` with `type`/`group` for cross-container DnD between two columns. On successful drop, call `useUpdateTask().mutate({ taskId, updates: { status } })`.

**Visual feedback:** See `.claude/plans/dnd-visual-feedback-preview.html` for proposals. Using **Combined** style: accent-colored ring + ghost placeholder + disabled column dim.

## Scope restriction

- Only Backlog and Ready columns participate in DnD
- InProgress, Review, Done columns: not droppable, not draggable
- Cards in those columns have no drag affordance

## Files to modify

| File | Change |
|------|--------|
| `package.json` | Add `@dnd-kit/react`, `@dnd-kit/helpers` |
| `src/components/views/BoardView.tsx` | Wrap grid in `DragDropProvider`, `onDragOver` with `move()`, `onDragEnd` calls `useUpdateTask` |
| `src/components/kanban/KanbanColumn.tsx` | `useSortable` with `type: 'column'`, `accept: ['item']` — only for Backlog/Ready. Apply drop-target highlight class. |
| `src/components/kanban/TaskCard.tsx` | `useSortable` with `type: 'item'`, `group: status` — only for cards in Backlog/Ready. Apply `isDragging` opacity. Guard click handler. |

## Implementation details

### BoardView.tsx

```tsx
import { DragDropProvider } from '@dnd-kit/react';
import { move } from '@dnd-kit/helpers';

// Local state: { Backlog: [taskId, ...], Ready: [taskId, ...] }
// Synced from tasks prop (only Backlog/Ready cards)
// onDragOver: setItems(items => move(items, event))
// onDragEnd: if column changed → updateTask.mutate({ taskId, updates: { status: newColumn } })
```

### KanbanColumn.tsx — conditional DnD

```tsx
// Only Backlog and Ready columns get useSortable:
const isDndColumn = status === 'Backlog' || status === 'Ready';

// If isDndColumn: useSortable({ id: status, type: 'column', accept: ['item'], ... })
// ref applied to card container div
// isDropTarget → "ring-2 ring-primary/30 bg-accent/5" classes
```

### TaskCard.tsx — conditional drag

```tsx
// Only cards in Backlog/Ready are draggable:
const isDraggable = task.status === 'Backlog' || task.status === 'Ready';

// If isDraggable: useSortable({ id: task.id, type: 'item', group: task.status, index })
// isDragging → "opacity-35 border-dashed border-muted-foreground/30"
// Click guard: useRef tracks if drag occurred, suppresses onClick after drag
```

### Click vs Drag

`@dnd-kit` activation distance (~5px) prevents accidental drags. Additional guard: ref tracks `isDragging` state, clears after pointerup, suppresses `onClick`.

### Visual feedback (Combined: column-color ring + accent ghost + disabled dim)

- **Source card:** `opacity-30` + `border-dashed`
- **Target column highlight:** inset ring using column's own color — `ring-2 ring-blue-500/30 bg-blue-500/5` for Ready, `ring-2 ring-slate-400/30 bg-slate-400/5` for Backlog
- **Ghost placeholder:** dashed card outline using accent color — `border-dashed border-accent/40 bg-accent/5`
- **Drag overlay:** slight rotation (-1.5deg), scale(1.03), shadow, accent-tinted border
- **Disabled columns (InProgress, Review, Done):** `opacity-35 saturate-[0.3]` during active drag
- **Cursor:** grab → grabbing

## Verification

1. `pnpm dev` — open board with tasks in Backlog and Ready
2. Drag card Backlog → Ready: card moves, DB updated
3. Drag card Ready → Backlog: same
4. Cannot drag InProgress/Review/Done cards
5. Cannot drop onto InProgress/Review/Done columns
6. Click card without dragging: detail view opens
7. Action buttons (Execute, Review) still work
8. `pnpm build` — no type errors
9. `pnpm test` — tests pass
