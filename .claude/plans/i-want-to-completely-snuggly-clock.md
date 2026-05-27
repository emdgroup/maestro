# Tasks View Rework

## Context

Current Tasks view has 3 hidden sub-views (Backlog/Board/Archive) behind icon-only toggles. Navigation is unintuitive — users don't discover the flow. Task creation has 3 inconsistent patterns (dialog, side panel, import modal). Task detail is a fullscreen overlay. Everything gets reworked into a single unified board with a dedicated task detail screen.

## Decisions Summary

1. **Layout**: 5-column board (Backlog → Ready → InProgress → Review → Done). No sub-view switching. Archive via modal.
2. **Task creation**: Tabbed modal (From Branch / From Issue). Seamless title+desc, branch popover, pill row (Priority · Agent · Isolated Worktree · Auto-approve), Create-another toggle.
3. **Task detail**: Dedicated full screen. Action bar: title · Improve · Interrupt · Execution · 🗑 · ✕. Right sidebar properties. Editable only in Backlog. Attachments section.
4. **Task cards**: Priority + labels + title + agent + badges. Click → task detail. Inline actions per column: Ready=[Execute], InProgress=[Interrupt], Review=[Review], Done=[Archive].
5. **Board action bar**: [+ New Task] · Search · Priority filter · Label filter · [Archive]. No separate import button.
6. **Execute**: Immediate (no confirm). Review: navigates to diff view screen (same as worktree card). Agent auto-moves task to Review on completion.
7. **Archive modal**: Search + Done/Cancelled filter. Click row → read-only task detail. No actions.

---

## Phase 1: Data Model & Backend

### 1a. Task model — new fields

Add to `Task` struct (`src-tauri/src/models/task.rs` or wherever Task is defined):
- `auto_approve: bool` (default `false`)
- `isolated_worktree: bool` (default `true`)

Add `task_attachments` table:
```sql
CREATE TABLE task_attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    file_path TEXT NOT NULL,
    file_size INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

Bump schema version: V15 → V16.

### 1b. New IPC commands

In `src-tauri/src/ipc/` (add to existing task handlers file):
- `get_task_attachments(task_id) -> Vec<TaskAttachment>`
- `add_task_attachment(task_id, filename, file_path, file_size) -> TaskAttachment`
- `remove_task_attachment(attachment_id)`
- `interrupt_task(task_id)` — stops active agent session for task, moves status back to Backlog

### 1c. Regenerate bindings

Run `pnpm tauri:gen` after model changes. New types appear in `src/types/bindings.ts`.

---

## Phase 2: Navigation Store

**File**: `src/store/navigationStore.ts`

Remove:
- `activeSubView: SubView` state
- `setActiveSubView` action
- `useActiveSubView` hook
- `SubView` type

Add:
- `activeTaskId: number | null` — when set, renders task detail screen instead of board
- `setActiveTaskId(id: number | null)` action
- `useActiveTaskId()` hook

Update `navigate()` to handle `{ taskId }` by setting `activeTaskId` (already partially exists as `pendingTaskId` — consolidate into `activeTaskId`).

Update `navigationStore.test.ts` accordingly.

---

## Phase 3: Board View (5 columns)

### 3a. KanbanView.tsx rework

**File**: `src/views/KanbanView.tsx`

Remove:
- Sub-view state (`activeSubView`)
- 3-icon toggle group
- Conditional rendering of BacklogView / BoardView / ArchiveView
- Sub-view-specific action bar slots (search/filter per sub-view)

New action bar (single, persistent):
```
[+ New Task]  [Search input]  [Priority filter]  [Label filter]  [Archive]
```

Render:
- If `activeTaskId` is set → `<TaskDetailScreen taskId={activeTaskId} />`
- Otherwise → `<BoardView />`

### 3b. BoardView.tsx — add Backlog column

**File**: `src/components/views/BoardView.tsx`

Add `Backlog` as first column. Columns order: `["Backlog", "Ready", "InProgress", "Review", "Done"]`.

Pass search + filter props down to filter cards shown in each column.

### 3c. Delete obsolete views

Delete:
- `src/components/views/BacklogView.tsx`
- `src/components/views/ArchiveView.tsx`

---

## Phase 4: Task Card Redesign

**File**: `src/components/kanban/TaskCard.tsx`

New card layout:
```
┌──────────────────────────────┐
│ ⚡ Medium  🏷 bug  🏷 auth   │
│                              │
│ Fix authentication redirect  │
│ loop                         │
│                              │
│ ✨ Sonnet 4.6  ◉ Isolated 🛡│
└──────────────────────────────┘
```

- Top row: priority pill + label pills (max 3, overflow count)
- Middle: title (2 lines max, text-overflow ellipsis)
- Bottom row: agent name + worktree badge + auto-approve shield icon (if enabled)
- Click anywhere → `setActiveTaskId(task.id)`

Per-column inline action buttons (bottom of card, always visible):

| Column | Button |
|--------|--------|
| Backlog | — |
| Ready | [Execute] |
| InProgress | [Interrupt] |
| Review | [Review] |
| Done | [Archive] |

Execute → calls existing execute mutation, moves to InProgress  
Interrupt → calls `interrupt_task` IPC command  
Review → navigates to worktrees diff view for this task's worktree  
Archive → calls existing archive mutation

---

## Phase 5: Create Task Modal

**File**: `src/components/task/CreateTaskModal.tsx` (new, replaces TaskModal + BacklogTaskSheet + ImportTicketsModal)

Tabs: **From Branch** | **From Issue** (From Issue hidden if no provider configured)

**From Branch tab fields:**
- Title (seamless large input, no label)
- Description (seamless textarea, no label)
- Branch selector (trigger → popover with Local/Remote sub-tabs, search, refresh, branch list)
- Pill row: Priority · Agent/Model · [Isolated Worktree toggle-pill] · [Auto-approve toggle-pill]
- Footer: Create-another toggle (mini on/off) + [Create ⌘↵]

**From Issue tab:**
- Search input + provider indicator
- Issue list (priority dot + id + title + labels, single-select)
- Selecting issue pre-fills Title + Description
- Same branch selector + pills + footer below

**Branch popover component**: `src/components/task/BranchSelectorPopover.tsx`
- Local/Remote tabs with counts
- Search input
- Refresh button (re-fetches via `useProjectBranchesQuery`)
- Branch list with checkmark on selected

**Mutations used:**
- `useCreateTaskMutation` (From Branch) — extend to accept `auto_approve`, `isolated_worktree`
- `useImportTasksMutation` (From Issue, single issue)

### Delete

- `src/components/kanban/TaskModal.tsx`
- `src/components/kanban/BacklogTaskSheet.tsx`
- `src/components/kanban/ImportTicketsModal.tsx`
- `src/components/task/TaskForm.tsx` (logic absorbed into CreateTaskModal)

---

## Phase 6: Task Detail Screen

**File**: `src/components/task/TaskDetailScreen.tsx` (new, replaces TaskDetail.tsx)

### Action bar
```
[Task title truncated]  [✨ Improve]  [⏸ Interrupt*]  [⚡ Execution*]  [🗑]  [✕]
```
- Improve: stub button (out of scope)
- Interrupt: visible when status ≠ Backlog → calls `interrupt_task`, returns to Backlog
- Execution: visible when InProgress or Review → navigates to Agents view for this task's session
- 🗑 Delete: calls delete mutation (becomes 📦 Archive when status=Done)
- ✕: sets `activeTaskId(null)` → back to board

### Main content (editable only in Backlog)
- Title: large seamless contenteditable (border appears on hover/focus)
- Description: seamless contenteditable textarea
- Locked banner when status ≠ Backlog: "Task is locked. Click Interrupt to unlock."
- Attachments section:
  - List of attached files (filename + size + remove button)
  - Drop zone / file picker (hidden when locked)
  - Uses `add_task_attachment` / `remove_task_attachment` IPC

### Right sidebar (always read-only display, status dropdown exception)
- Status: clickable badge → dropdown to change status
- Priority, Agent, Base Branch, Labels, Auto-approve badge, Worktree type

### Delete

- `src/components/task/TaskDetail.tsx`

---

## Phase 7: Archive Modal

**File**: `src/components/kanban/ArchiveModal.tsx` (new)

- Modal dialog triggered from board action bar [Archive] button
- Lists tasks where `archived_at != null` OR `status = "Cancelled"`
- Search by title
- Filter tabs: All · Done · Cancelled
- Row: title + status badge
- Click row → closes modal, sets `activeTaskId` to open task detail (read-only)
- No actions on archived tasks

---

## Files Changed Summary

| Action | File |
|--------|------|
| Modify | `src/views/KanbanView.tsx` |
| Modify | `src/components/views/BoardView.tsx` |
| Modify | `src/components/kanban/TaskCard.tsx` |
| Modify | `src/store/navigationStore.ts` |
| Modify | `src/store/navigationStore.test.ts` |
| Modify | `src/App.tsx` (wire new modal, remove old) |
| Modify | `src-tauri/src/models/` (Task + TaskAttachment) |
| Modify | `src-tauri/src/ipc/` (new commands) |
| Modify | `src/services/task.service.ts` (new hooks) |
| Modify | `src/types/bindings.ts` (regenerated) |
| Create | `src/components/task/CreateTaskModal.tsx` |
| Create | `src/components/task/BranchSelectorPopover.tsx` |
| Create | `src/components/task/TaskDetailScreen.tsx` |
| Create | `src/components/kanban/ArchiveModal.tsx` |
| Delete | `src/components/views/BacklogView.tsx` |
| Delete | `src/components/views/ArchiveView.tsx` |
| Delete | `src/components/kanban/TaskModal.tsx` |
| Delete | `src/components/kanban/BacklogTaskSheet.tsx` |
| Delete | `src/components/kanban/ImportTicketsModal.tsx` |
| Delete | `src/components/task/TaskDetail.tsx` |
| Delete | `src/components/task/TaskForm.tsx` |

---

## Verification

1. `pnpm tauri:dev` — app launches, board shows 5 columns
2. Click [+ New Task] → modal opens with From Branch tab; From Issue tab visible only if provider configured
3. Create task → appears in Backlog column
4. Click card → task detail screen renders; back via ✕
5. In Backlog detail: title/description editable, attachments uploadable
6. Change status to Ready via sidebar dropdown → fields lock, Interrupt button appears
7. Click Interrupt → task back to Backlog, fields editable again
8. Execute on Ready card → task moves to InProgress, Execution button appears in detail
9. Archive button on Done card → task disappears from board
10. [Archive] in action bar → modal shows archived/cancelled tasks
11. `pnpm test` — navigation store tests pass
12. `cargo test` — Rust tests pass
