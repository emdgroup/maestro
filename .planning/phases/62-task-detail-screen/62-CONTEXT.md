# Phase 62: Task Detail Screen - Context

**Gathered:** 2026-05-27
**Status:** Ready for planning

<domain>
## Phase Boundary

Replace the `TaskDetailScreen` stub with a full-screen task detail view. Covers the action bar, editable main content (title, description, attachments), right sidebar with status/metadata, edit-lock model (Backlog only), interrupt flow, and agent-required gate for Ready transition. `TaskDetail.tsx` modal overlay is deleted.

</domain>

<decisions>
## Implementation Decisions

### Edit Lock Model
- **D-01:** All fields (title, description, priority, agent, base branch, labels, auto-approve, worktree type) are editable only when task status is `Backlog`. Any other status = fully read-only. No field-level exceptions.

### Screen Layout
- **D-02:** Action bar across the top:
  ```
  [Task title truncated]  [✨ Improve]  [⏸ Interrupt]  [⚡ Execution]  [🗑 / 📦]  [✕]
  ```
  - **Improve** — stub button, out of scope for this phase
  - **Interrupt** — visible only when status = `InProgress`. On click: confirmation modal with three outcomes (see D-04)
  - **Execution** — visible when status = `InProgress` or `Review`. Navigates to AgentsView filtered to this task's session
  - **Delete / Archive** — calls `delete_task` mutation when status ≠ `Done`; calls archive mutation when status = `Done` (icon changes to 📦)
  - **✕** — calls `setActiveTaskId(null)` → returns to board

- **D-03:** Main content area (left / center):
  - **Title**: large seamless `contenteditable` element; border appears on hover/focus; saves on blur
  - **Description**: seamless `contenteditable` textarea; saves on blur
  - **Attachments section**: list of attached files (filename + size + remove button); dropzone + file picker below; dropzone/picker hidden when task is not in Backlog
  - IPC: `add_task_attachment` / `remove_task_attachment`

- **D-04 (interrupt flow):** Interrupt button → confirmation modal with prompt: "Interrupt the working agent?". Three choices:
  - **Resume** — sends a "resume" prompt to the agent (un-interrupts, agent continues)
  - **Rework** — calls `interrupt_task`, moves task back to `Backlog`
  - **Cancel** — archives task with cancelled status

- **D-05:** Right sidebar — always displayed but read-only except the status dropdown:
  - Status: clickable badge → dropdown
  - Priority, Agent, Base Branch, Labels, Auto-approve badge, Worktree type

### Status Change Restrictions
- **D-06:** User can only toggle between `Backlog` ↔ `Ready` via the status dropdown. All other status transitions are automatic (system/agent events). The dropdown shows all statuses for context but only `Backlog` and `Ready` are selectable.

### Agent Required Gate
- **D-07:** `agent_id` (and by implication a model) must be set before a task can transition `Backlog → Ready`. If no agent assigned, the status dropdown should block the transition and show an inline error: "Assign an agent before marking as Ready."

### Claude's Discretion
- Exact save debounce/blur timing for contenteditable fields
- Interrupt modal styling (can reuse existing modal patterns)
- Sidebar field order beyond status (priority first is a reasonable default)
- Animation/transition when entering/exiting detail screen (framer-motion, consistent with existing tab transitions)

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Requirements
- `.planning/REQUIREMENTS.md` §DETAIL-01..08 — all Phase 62 requirements

### Navigation & Routing
- `src/store/navigationStore.ts` — `activeTaskId`, `setActiveTaskId()`, `navigate()` API
- `src/views/KanbanView.tsx` — routing logic: renders `<TaskDetailScreen>` when `activeTaskId !== null`

### Prior Phase Context (deferred decisions carried forward)
- `.planning/phases/61-create-task-modal/61-CONTEXT.md` §D-04 — agent_id required gate deferred to Phase 62 (now D-07 above)

### Existing Component Being Replaced
- `src/components/task/TaskDetail.tsx` — 342-line modal overlay; DELETE in this phase

### Service Layer (mutations available)
- `src/services/task.service.ts` — `useUpdateTask`, `useInterruptTaskMutation`, `useArchiveTaskMutation`, `useDeleteTaskMutation`, `useAddTaskAttachmentMutation`, `useRemoveTaskAttachmentMutation`, `useTaskAttachmentsQuery`

### UI Patterns
- `src/components/ui/` — base-ui Tabs/Popover (no `asChild` on Trigger — use `buttonVariants()` directly)
- `CLAUDE.md` §base-ui Component Pitfall — mandatory reading before using Tabs/Popover

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `useUpdateTask` mutation — covers title, description, priority, agent_id, labels, auto_approve, isolated_worktree, base_branch edits
- `useInterruptTaskMutation` — called by Interrupt → Rework path
- `useArchiveTaskMutation` — called by Interrupt → Cancel path and Delete when status=Done
- `useDeleteTaskMutation` — called by Delete action when status ≠ Done
- `useAddTaskAttachmentMutation` / `useRemoveTaskAttachmentMutation` / `useTaskAttachmentsQuery` — attachments section
- framer-motion `useAnimationControls` — existing pattern in `KanbanView` for view transitions; reuse for enter/exit

### Established Patterns
- All IPC via TanStack Query hooks — no direct `invoke()` in components
- Zustand + Immer for client state; `navigationStore` is the routing source of truth
- `useSelectedProject()` for `projectId` / `projectPath`
- Seamless contenteditable with hover/focus borders is consistent with `TaskCard` title editing (Phase 60)

### Integration Points
- `KanbanView.tsx:if (activeTaskId !== null)` — already renders `<TaskDetailScreen taskId={activeTaskId} />`
- `navigationStore.setActiveTaskId(null)` — back-to-board action for ✕ button
- AgentsView navigation: `navigate({ view: 'agents', pendingAgentId: ... })` — Execution button target

</code_context>

<specifics>
## Specific Ideas

- Title in action bar should be truncated (not the editable title in main content — that's a separate element)
- Interrupt modal has exactly three labeled buttons: Resume / Rework / Cancel (not a generic yes/no)
- Attachments dropzone hidden (not disabled) when task is not Backlog
- Status dropdown: all statuses visible for context, but only Backlog/Ready are clickable

</specifics>

<deferred>
## Deferred Ideas

- **"Improve" AI button** — stub only in this phase; full implementation deferred
- Agent-required gate error UI design (exact error component/placement) — left to planner

</deferred>

---

*Phase: 62-task-detail-screen*
*Context gathered: 2026-05-27*
