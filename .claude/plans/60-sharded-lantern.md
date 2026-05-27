# Phase 60: Task Card Redesign — Plan

## Context

Phase 60 replaces the current TaskCard with a redesigned layout that communicates full context at a glance and provides the one inline action a user needs per status. Decisions are locked in `60-CONTEXT.md` via discuss-phase.

**Dependencies verified:**
- Phase 58 (Navigation Store): PASSED — `setActiveTaskId`, `useActiveTaskId`, `TaskDetailScreen` stub all shipped
- Phase 59 (Board View): COMPLETE — 5-column board, search+filter action bar, `KanbanView` conditional render on `activeTaskId`

**What ships in this phase:**
- New card layout: title (2-line clamp) → metadata row (priority dot + labels + auto-approve) → footer row (worktree badge | action button)
- Card click → `setActiveTaskId(task.id)` (replaces `onTaskClick`)
- Context menu (⋮ + `TaskContextMenu`) removed
- `useWorktreesQuery` hoisted to `KanbanView`, `worktreeTaskIds: Set<number>` threaded down
- Inline Interrupt + Archive mutations in TaskCard (no more prop callbacks for those)
- `onSettingsClick` / `TaskSettingsModal` removed from BoardView (Phase 62 owns that via detail screen)

**No backend changes.** All 4 modified files are frontend TypeScript.

---

## Files Modified

| File | Change |
|------|--------|
| `src/components/kanban/TaskCard.tsx` | Complete rewrite |
| `src/components/kanban/KanbanColumn.tsx` | Prop interface update |
| `src/components/views/BoardView.tsx` | Remove settings modal + prop threading |
| `src/views/KanbanView.tsx` | Add `useWorktreesQuery` + derive worktreeTaskIds |

---

## Plan 1 — `60-01-PLAN.md`: TaskCard Rewrite

```yaml
wave: 1
depends_on: []
files_modified:
  - src/components/kanban/TaskCard.tsx
requirements: [CARD-01, CARD-02, CARD-03, CARD-04, CARD-05, CARD-06]
autonomous: true
```

### Task 1.1 — Remove context menu machinery

**read_first:**
- `src/components/kanban/TaskCard.tsx` — current file
- `src/components/task/TaskContextMenu.tsx` — component being removed from card

**action:**
Remove from `TaskCard.tsx`:
- `import { TaskContextMenu } from "@/components/task/TaskContextMenu"`
- `const [menuOpen, setMenuOpen] = useState(false)`
- `onContextMenu` handler and `onMouseLeave` handler from the card div
- The `⋮` `<button>` element and the `<TaskContextMenu>` render
- `onSettingsClick` from `TaskCardProps` interface and destructuring
- `updateTask` import and `useUpdateTask` hook usage
- `handleBackToBacklog` function
- `getStatusLabel` function (status label pill removed from new layout)
- `getStatusDotColor` function (replaced by priority dot)

**acceptance_criteria:**
- `TaskCard.tsx` contains no import of `TaskContextMenu`
- `TaskCard.tsx` contains no `menuOpen` state
- `TaskCard.tsx` contains no `onContextMenu` or `onMouseLeave` on the root div
- `TaskCard.tsx` contains no `⋮` button
- `TaskCardProps` interface has no `onSettingsClick` field
- `pnpm build` exits 0

### Task 1.2 — Wire card click to setActiveTaskId

**read_first:**
- `src/store/navigationStore.ts` — `useNavigationActions` export, `setActiveTaskId` signature
- `src/contexts/KanbanContext.tsx` — confirm `projectId`, `projectPath` still needed (for `useExecuteTask`)

**action:**
In `TaskCard.tsx`:
- Add `import { useNavigationActions } from "@/store/navigationStore"`
- Inside component: `const { setActiveTaskId } = useNavigationActions()`
- Remove `onTaskClick` from `useKanban()` destructuring (keep `projectId`, `projectPath`)
- The root card `div` onClick: `onClick={() => setActiveTaskId(task.id)}`
- Remove `onReviewClick` prop from `TaskCardProps` — Review button will call `onReviewClick` prop; keep it. Actually keep `onReviewClick` as a prop since ReviewModal lives in BoardView.

**acceptance_criteria:**
- `TaskCard.tsx` imports `useNavigationActions` from `@/store/navigationStore`
- Root card div has `onClick={() => setActiveTaskId(task.id)}`
- Clicking the card (outside action button) calls `setActiveTaskId` — verified by reading that the action button has `e.stopPropagation()`
- `onTaskClick` is NOT referenced anywhere in `TaskCard.tsx`

### Task 1.3 — Add priority dot

**read_first:**
- `src/components/kanban/TaskCard.tsx` — current file (after Task 1.1 edits)
- `src/types/bindings.ts` — `TaskPriority` type

**action:**
Add to `TaskCard.tsx` before the component:
```
const PRIORITY_COLORS: Record<TaskPriority, string> = {
  Urgent: "#f87171",
  High: "#fb923c",
  Medium: "#facc15",
  Low: "#4ade80",
  None: "#4b5563",
};
```
In the metadata row (below title), render:
```
<span style={{ backgroundColor: PRIORITY_COLORS[task.priority] }}
      className="h-[7px] w-[7px] rounded-full shrink-0 inline-block" />
```
Omit the dot entirely when `task.priority === "None"` (conditional render).

**acceptance_criteria:**
- `TaskCard.tsx` contains `PRIORITY_COLORS` object with Urgent/High/Medium/Low/None keys
- Priority dot rendered in metadata row, not before title
- `task.priority === "None"` renders no dot element
- `pnpm build` exits 0

### Task 1.4 — Restructure layout: title + metadata + footer rows

**read_first:**
- `src/components/kanban/TaskCard.tsx` — current file
- `.planning/phases/60-task-card-redesign/60-CONTEXT.md` — D-01 layout spec, D-08 footer row spec
- `.claude/plans/60-card-layout-preview.html` — reference HTML mockup (if exists)

**action:**
Replace the entire JSX return with the new 3-row structure:

**Row 1 — Title:** `<p className="text-sm font-medium text-foreground line-clamp-2 cursor-pointer">{task.title}</p>` — the entire card div has the onClick, so title just needs the text.

**Row 2 — Metadata:** flex row, gap-1.5, items-center:
- Priority dot (from Task 1.3, conditional)
- Label chips (up to 3 from `task.labels.slice(0, 3)`, same `bg-muted text-muted-foreground text-xs px-2 py-0.5 rounded` style)
- Overflow count if `task.labels.length > 3`: `+N` text
- Auto-approve ShieldAlert icon (from Task 1.5, conditional, right-aligned with `ml-auto`)

**Row 3 — Footer:** flex row, justify-between, items-center:
- Left: worktree badge when present (green dot + "worktree" label in text-xs muted)
- Right: action button (compact, not full-width) per status

Card root div: `className="rounded-lg border border-border bg-card shadow-sm p-3 mb-3 transition-all duration-200 cursor-pointer hover:shadow-md hover:border-ring"` — add `cursor-pointer` (was `cursor-default`).

**acceptance_criteria:**
- `TaskCard.tsx` uses `line-clamp-2` on the title element
- Metadata row contains priority dot + labels + overflow count + auto-approve in one flex container
- Footer row has justify-between layout
- No full-width button (`w-full`) anywhere in `TaskCard.tsx`
- `pnpm build` exits 0

### Task 1.5 — Auto-approve ShieldAlert indicator

**read_first:**
- `src/components/execution/activity/PermissionPrompt.tsx` — ShieldAlert import + amber color treatment

**action:**
In `TaskCard.tsx`:
- Add `import { ShieldAlert } from "lucide-react"`
- In metadata row, right-aligned: `{task.auto_approve && <ShieldAlert className="h-3.5 w-3.5 text-amber-500 ml-auto shrink-0" />}`

**acceptance_criteria:**
- `TaskCard.tsx` imports `ShieldAlert` from `lucide-react`
- `ShieldAlert` renders only when `task.auto_approve === true`
- Icon uses `text-amber-500` class
- `pnpm build` exits 0

### Task 1.6 — Worktree badge

**read_first:**
- `src/components/kanban/TaskCard.tsx` — current file
- `.planning/phases/60-task-card-redesign/60-CONTEXT.md` — D-10 worktree badge spec

**action:**
Add `worktreeTaskIds: Set<number>` to `TaskCardProps`. In footer row left side:
```
{worktreeTaskIds.has(task.id) && (
  <span className="flex items-center gap-1 text-xs text-muted-foreground">
    <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
    worktree
  </span>
)}
```
When no worktree badge: left side renders nothing (empty).

**acceptance_criteria:**
- `TaskCardProps` includes `worktreeTaskIds: Set<number>`
- Footer left shows green dot + "worktree" text when `worktreeTaskIds.has(task.id)` is true
- Footer left renders nothing when task has no worktree (no placeholder element)
- `pnpm build` exits 0

### Task 1.7 — Inline action buttons (footer row, right side)

**read_first:**
- `src/services/task.service.ts` — `useInterruptTaskMutation` + `useArchiveTaskMutation`
- `src/utils/hooks/useExecuteTask.ts` — `useExecuteTask` signature
- `src/components/kanban/TaskCard.tsx` — current props after Task 1.6

**action:**
Add imports:
- `import { useInterruptTaskMutation, useArchiveTaskMutation } from "@/services/task.service"`

Inside component:
- `const interruptTask = useInterruptTaskMutation()`
- `const archiveTask = useArchiveTaskMutation()`
- Keep existing `const { execute: handleExecute, isExecuting } = useExecuteTask(projectId, projectPath)`

Footer row right side — single conditional block:
```
{task.status === "Ready" && (
  <button onClick={(e) => { e.stopPropagation(); void handleExecute(task); }}
          disabled={isExecuting}
          className="text-xs px-2 py-1 rounded bg-accent text-accent-foreground hover:bg-accent/90 shrink-0">
    {isExecuting ? "..." : "▶ Execute"}
  </button>
)}
{task.status === "InProgress" && (
  <button onClick={(e) => { e.stopPropagation(); interruptTask.mutate(task.id); }}
          className="text-xs px-2 py-1 rounded bg-muted text-muted-foreground hover:bg-muted/80 shrink-0">
    ⏹ Interrupt
  </button>
)}
{task.status === "Review" && (
  <button onClick={(e) => { e.stopPropagation(); onReviewClick?.(task.id, task.title); }}
          className="text-xs px-2 py-1 rounded bg-secondary text-secondary-foreground hover:bg-secondary/80 shrink-0">
    Review
  </button>
)}
{task.status === "Done" && !task.archived_at && (
  <button onClick={(e) => { e.stopPropagation(); archiveTask.mutate(task.id); }}
          className="text-xs px-2 py-1 rounded bg-muted text-muted-foreground hover:bg-muted/80 shrink-0">
    Archive
  </button>
)}
```

Remove `onArchiveClick` from `TaskCardProps` entirely.

**acceptance_criteria:**
- `TaskCardProps` has no `onArchiveClick` field
- All action buttons call `e.stopPropagation()` before their action
- Interrupt button calls `interruptTask.mutate(task.id)`
- Archive button calls `archiveTask.mutate(task.id)` directly (no prop callback)
- No `w-full` class on any button
- `pnpm build` exits 0

---

## Plan 2 — `60-02-PLAN.md`: Data Threading + Cleanup

```yaml
wave: 2
depends_on: [60-01]
files_modified:
  - src/components/kanban/KanbanColumn.tsx
  - src/components/views/BoardView.tsx
  - src/views/KanbanView.tsx
requirements: [CARD-01, CARD-02, CARD-03, CARD-04, CARD-05, CARD-06]
autonomous: true
```

### Task 2.1 — KanbanColumn prop update

**read_first:**
- `src/components/kanban/KanbanColumn.tsx` — current file
- `src/components/kanban/TaskCard.tsx` — updated TaskCardProps (from Plan 1)

**action:**
In `KanbanColumn.tsx`:
- Remove `onSettingsClick?: (task: Task) => void` from `KanbanColumnProps`
- Remove `onArchiveClick?: (taskId: number) => void` from `KanbanColumnProps`
- Add `worktreeTaskIds: Set<number>` to `KanbanColumnProps`
- Remove `onSettingsClick` and `onArchiveClick` from destructuring and `<TaskCard>` props
- Add `worktreeTaskIds={worktreeTaskIds}` to `<TaskCard>` props
- Keep `onReviewClick` prop pass-through

**acceptance_criteria:**
- `KanbanColumnProps` contains `worktreeTaskIds: Set<number>` and `onReviewClick` but NOT `onSettingsClick` or `onArchiveClick`
- `<TaskCard>` in `KanbanColumn` receives `worktreeTaskIds` and `onReviewClick` but NOT `onSettingsClick` or `onArchiveClick`
- `pnpm build` exits 0

### Task 2.2 — BoardView cleanup + prop threading

**read_first:**
- `src/components/views/BoardView.tsx` — current file
- `src/components/kanban/KanbanColumn.tsx` — updated KanbanColumnProps (from Task 2.1)

**action:**
In `BoardView.tsx`:
- Add `worktreeTaskIds: Set<number>` to `BoardViewProps`
- Remove `import { TaskSettingsModal } from "@/components/task/TaskSettingsModal"`
- Remove `onSettingsClick` from `<KanbanColumn>` props
- Remove `onArchiveClick` from `<KanbanColumn>` props (and the `archiveTask` mutation, `useArchiveTaskMutation` import)
- Remove `selectedTaskForSettings` state and the `<TaskSettingsModal>` render block
- Pass `worktreeTaskIds={worktreeTaskIds}` to each `<KanbanColumn>`
- Keep `onReviewClick` flow (ReviewModal, selectedTaskId/Name state) unchanged

**acceptance_criteria:**
- `BoardViewProps` contains `worktreeTaskIds: Set<number>` but NOT `onSettingsClick` or `onArchiveClick`
- `BoardView.tsx` contains no `TaskSettingsModal` import or render
- `BoardView.tsx` contains no `selectedTaskForSettings` state
- `BoardView.tsx` contains no `useArchiveTaskMutation` import
- Each `<KanbanColumn>` receives `worktreeTaskIds`
- `ReviewModal` flow unchanged (still present)
- `pnpm build` exits 0

### Task 2.3 — KanbanView: hoist useWorktreesQuery + pass worktreeTaskIds

**read_first:**
- `src/views/KanbanView.tsx` — current file
- `src/services/worktree.service.ts` — `useWorktreesQuery` signature
- `src/store/projectStore.ts` — `useSelectedProject` (for projectPath)

**action:**
In `KanbanView.tsx`:
- Add `import { useWorktreesQuery } from "@/services/worktree.service"`
- Extract `projectPath` from `useSelectedProject()`: `const projectPath = selectedProject?.path ?? ""`
- Add: `const { data: worktrees } = useWorktreesQuery(projectId ?? undefined, projectPath || undefined)`
- Derive: `const worktreeTaskIds = new Set((worktrees ?? []).filter(w => w.task_id != null).map(w => w.task_id!))`
- Pass `worktreeTaskIds={worktreeTaskIds}` to `<BoardView>`

**acceptance_criteria:**
- `KanbanView.tsx` imports `useWorktreesQuery`
- `KanbanView.tsx` derives `worktreeTaskIds` as `Set<number>` from filtered worktrees
- `<BoardView>` receives `worktreeTaskIds={worktreeTaskIds}`
- `pnpm build` exits 0
- `pnpm test` exits 0

---

## Verification

### Build + Type Check
```bash
pnpm build
```
Expected: 0 TypeScript errors, 0 build errors.

### Unit Tests
```bash
pnpm test
```
Expected: all existing tests pass (151+). No new tests required for pure visual changes.

### Dev Server Visual Check
```bash
pnpm dev
```
Open the Kanban board:
1. Cards show title at top (2 lines max), metadata row below, footer row at bottom
2. Cards with priority ≠ None show colored dot in metadata row
3. Cards with `auto_approve: true` show amber ShieldAlert icon in metadata row
4. Cards with an active worktree show green dot + "worktree" in footer left
5. Ready card footer shows "▶ Execute" button right-aligned
6. InProgress card footer shows "⏹ Interrupt" button right-aligned
7. Review card footer shows "Review" button right-aligned
8. Done (unarchived) card footer shows "Archive" button right-aligned
9. Clicking card body navigates to TaskDetailScreen (activeTaskId set)
10. Clicking action button does NOT navigate (stopPropagation works)
11. No ⋮ button visible on any card
12. Right-clicking card does nothing (no context menu)

### Acceptance Criteria from ROADMAP
- [x] CARD-01: Priority dot, labels (max 3 + overflow), title (2-line clamp), worktree badge, auto-approve icon
- [x] CARD-02: Card click → task detail screen navigation
- [x] CARD-03: Ready → Execute button, triggers execution
- [x] CARD-04: InProgress → Interrupt button, calls interrupt_task
- [x] CARD-05: Review → Review button, navigates to diff view
- [x] CARD-06: Done → Archive button, archives task

---

## Execution Order

1. Write `60-01-PLAN.md` to `.planning/phases/60-task-card-redesign/`
2. Write `60-02-PLAN.md` to `.planning/phases/60-task-card-redesign/`
3. Execute Plan 1 (TaskCard rewrite) — all tasks in sequence
4. Execute Plan 2 (data threading) — all tasks in sequence
5. Run verification sequence
