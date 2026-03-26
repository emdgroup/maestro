# Kanban/Tasks Refactoring Plan

## Context

The brainstorm at `.planning/brainstorm-tasks-tab.md` locked a comprehensive redesign of the Tasks/Kanban area. The current implementation has drag-and-drop between all columns, 8 status variants (including `Merging` and `Failed`), no task editing after creation, no delete, no priority/relationships/instructions log, and a single monolithic board view. The target is a 3-view architecture (Backlog/Board/Archive) with action-driven transitions, 6 status variants, agent sub-states on InProgress cards, and a rich review panel.

---

## Phase 0: Backend Preparatory Cleanup (S)

Extract task handlers from `project_handlers.rs` into their own module. Add helper methods.

- Create `src-tauri/src/ipc/task_handlers.rs` — move `get_tasks`, `create_task`, `update_task`, `update_task_settings` out of `project_handlers.rs`
- Add `Task::from_row()` helper (currently duplicated 3x in project_handlers)
- Add `impl FromStr for TaskStatus` (currently matched inline in multiple places)
- Register new module in `src-tauri/src/ipc/mod.rs` and update imports in `src-tauri/src/lib.rs`
- Run `cargo check` — no binding regen needed (no model changes)

## Phase 1: Database Schema Migration + New Task Fields (M)

Add priority, origin_branch, relationships, instructions log. Add delete_task IPC.

**Backend:**
- `src-tauri/src/db/schema.rs`: Rewrite the schema from scratch (no ALTER TABLE migrations). Bump `SCHEMA_VERSION` to 2. The new `tasks` table includes `priority TEXT NOT NULL DEFAULT 'Medium'`, `origin_branch TEXT`, `archived_at TEXT` columns directly. Add new tables: `task_relationships (id, from_task_id, to_task_id, relationship_type, created_at)` with FK CASCADE, `task_instructions (id, task_id, content, source, created_at)` with FK CASCADE. On version mismatch, drop and recreate all tables (acceptable — no production data to preserve).
- `src-tauri/src/models/task.rs`: Add `TaskPriority` enum (Urgent/High/Medium/Low), add `priority`, `origin_branch`, `archived_at` to Task struct, add `TaskRelationship` and `TaskInstruction` models
- `src-tauri/src/ipc/task_handlers.rs`: Add `delete_task`, expand `update_task` to accept all editable fields (name, description, acceptance_criteria, priority, origin_branch). Add relationship and instruction CRUD commands.
- `src-tauri/src/lib.rs`: Register new commands
- Run `pnpm tauri:gen`

**Frontend:**
- `src/services/task.service.ts`: Add `useDeleteTaskMutation`, `useTaskRelationshipsQuery`, `useTaskInstructionsQuery`, relationship/instruction mutation hooks
- `src/components/task/TaskForm.tsx`: Add priority selector (default Medium), origin_branch input

## Phase 2: Remove Merging + Failed Statuses (M)

**Backend:**
- `src-tauri/src/models/task.rs`: Remove `Merging` and `Failed` variants from `TaskStatus`. Final enum: `Backlog, Ready, InProgress, Review, Done, Cancelled`
- `src-tauri/src/ipc/review_handlers.rs`: Rewrite `approve_task_and_merge` — perform merge synchronously (awaited), return final status (Done or InProgress on conflict) directly to frontend
- No legacy data handling needed (fresh schema from Phase 1)
- Run `pnpm tauri:gen`

**Frontend (after binding regen):**
- `src/components/kanban/KanbanBoard.tsx`: Remove Merging from COLUMN_TITLES, remove merge detection in useEffect, remove getTasksForColumn Merging folding
- `src/components/kanban/TaskCard.tsx`: Remove Merging/Failed from getStatusDotColor, getStatusLabel. Redesign InProgress section to show agent sub-states based on `executionLog.status` (running→[Stop], paused→[Cancel][Resolve], failed→[Cancel][Resolve]). Remove the Failed-specific error box and Retry/Abort/Terminal button group.
- `src/components/kanban/KanbanColumn.tsx`: Remove Merging/Failed from color maps
- `src/components/common/ApprovalForm.tsx`: Update to handle synchronous merge result (toast on success/conflict)
- `src/store/boardStore.ts`: Remove `retryingTaskIds`/`abortingTaskIds` sets. Abort action sets "Cancelled" not "Done".

## Phase 3: Remove Drag-and-Drop (M)

- `src/components/kanban/KanbanBoard.tsx`: Remove DndContext, DragOverlay, useSensors, handleDragStart, handleDragEnd, isValidTransition, activeTask state. Board becomes a static grid.
- `src/components/kanban/KanbanColumn.tsx`: Remove useDroppable, isOver styling
- `src/components/kanban/TaskCard.tsx`: Remove useDraggable, CSS.Translate, transform/style/cursor:grab. Add explicit action buttons: "Back to Backlog" on Ready cards
- Optionally remove `@dnd-kit/core` and `@dnd-kit/utilities` from `package.json`

## Phase 4: Three-View Architecture (L)

Split the single board into Backlog / Board / Archive sub-views.

- `src/views/KanbanView.tsx`: Becomes sub-view coordinator holding `activeSubView` state ("backlog"|"board"|"archive"), renders the correct component
- `src/contexts/KanbanContext.tsx`: Add `activeSubView` and `setActiveSubView` to context
- `src/utils/helpers/page-actions.ts`: Add sub-view switcher buttons (Backlog/Board/Archive) to kanban page actions

**New components:**
- `src/components/views/BacklogView.tsx`: Flat list of Backlog tasks. Shows name, priority badge, blocked indicator. Actions: Promote (disabled if blocked), Delete. Sorted by priority then creation date.
- `src/components/views/BoardView.tsx`: 4 columns — Ready | InProgress | Review | Done. Refactored from KanbanBoard (remove Backlog/Cancelled columns, keep 4-column grid). Ready shows priority-ordered queue with Start + Back to Backlog. Done shows branch info + Archive.
- `src/components/views/ArchiveView.tsx`: Flat list of Done/Cancelled tasks (where `archived_at IS NOT NULL` or `status = 'Cancelled'`). Filterable by status, searchable by name.

## Phase 5: Task Detail Panel + Editable Fields (M)

- `src/components/task/TaskDetail.tsx`: Major rework — make fields editable when task is Backlog/Ready (name, description, acceptance_criteria, priority, relationships). Origin branch editable in Backlog only. Add Relationships section (add type → search task → add row). Add Instructions Log section (read-only chronological thread).
- `src/services/task.service.ts`: Wire up relationship/instruction query hooks (already added in Phase 1)

## Phase 6: Review Panel Redesign (M)

**Backend:**
- `src-tauri/src/ipc/review_handlers.rs`: Add merge strategy parameter to approve flow (CommitAndMerge, CommitAndPush, CommitOnly). Add `reject_review` command with three actions: SendToBacklog (status→Backlog, worktree deleted), ResumeWithInstructions (status→InProgress, instruction added), CancelTask (status→Cancelled, worktree deleted).

**Frontend:**
- `src/components/common/ReviewModal.tsx` + `ApprovalForm.tsx`: Replace binary Approve/RequestChanges with:
  - Accept: radio group (Commit+Merge / Commit+Push / Commit only) + branch selector + submit
  - Reject: three buttons (Send to Backlog with optional comment, Resume with instructions with required textarea, Cancel task)
- Add "Open Diff" button that opens external diff tool

## Phase 7: Auto/Manual Mode + Ready Queue (M)

**Backend:**
- Add `auto_mode` and `max_concurrent_agents` to settings
- Add `drain_ready_queue` IPC: checks auto mode, counts running agents, starts tasks from Ready in priority order up to max

**Frontend:**
- `src/components/common/AppHeader.tsx`: Add Auto/Manual toggle in right section (replaces or sits beside agent count badge). Pulsing indicator when Auto is active.
- `src/views/KanbanView.tsx`: When auto mode + task enters Ready or agent finishes, trigger queue drain

## Phase 8: Archiving Mechanism (S)

- `src/components/views/BoardView.tsx`: Add Archive button on Done cards → calls `archive_task` IPC (sets archived_at, triggers worktree cleanup)
- `src/components/views/ArchiveView.tsx`: Shows tasks with `archived_at` set + Cancelled tasks
- Add auto-archive settings to project Settings view (count threshold, time threshold)

---

## Phase Dependencies

```
0 → 1 → 2 → 3 → 4 → 5 → 6
                         → 7
                         → 8
```
Phases 6, 7, 8 can run in parallel after Phase 5.

## Verification

After each phase:
1. `cargo check` in src-tauri (Rust compilation)
2. `pnpm tauri:gen` after any Rust model changes
3. `pnpm lint` (frontend linting)
4. `pnpm build` (frontend build — catches TS errors from removed/changed types)
5. `pnpm tauri:dev` — manual smoke test of the UI
6. Verify no references to removed statuses (`grep -r "Merging\|Failed" src/` after Phase 2)
