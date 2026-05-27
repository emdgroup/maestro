# Phase 62: Task Detail Screen - Research

**Researched:** 2026-05-27
**Domain:** React / TypeScript frontend component — full-screen task detail view
**Confidence:** HIGH

## Summary

Phase 62 replaces a 342-line modal overlay (`TaskDetail.tsx`) with a dedicated full-screen component (`TaskDetailScreen.tsx`). The stub in `TaskDetailScreen.tsx` (7 lines) is the target. Routing is already wired: `KanbanView.tsx` renders `<TaskDetailScreen taskId={activeTaskId} />` when `activeTaskId !== null`, and `setActiveTaskId(null)` navigates back. All required IPC commands exist in `bindings.ts` — no Rust changes needed for the happy path except one gap: `update_task` does not accept `labels`, `auto_approve`, or `isolated_worktree`. If the sidebar must allow editing these fields in Backlog (per D-01), the Rust `update_task` handler must be extended and bindings regenerated. This is a backend gap that must be planned as a prerequisite task.

The component is self-contained: fetch task by ID from the cached `useTasksQuery` result, render two panels (main content + right sidebar), show an action bar at top, manage one piece of local state (interrupt modal open/closed). No new services, stores, or IPC commands are needed beyond the update_task extension.

**Primary recommendation:** Build TaskDetailScreen as one file with co-located InterruptModal. Extend `update_task` Rust handler for labels/auto_approve/isolated_worktree in Wave 1 before UI work.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**D-01:** All fields (title, description, priority, agent, base branch, labels, auto-approve, worktree type) are editable only when task status is `Backlog`. Any other status = fully read-only. No field-level exceptions.

**D-02:** Action bar layout:
```
[Task title truncated]  [✨ Improve]  [⏸ Interrupt]  [⚡ Execution]  [🗑 / 📦]  [✕]
```
- Improve — stub button, out of scope
- Interrupt — visible only when status = `InProgress`. On click: confirmation modal with three outcomes (see D-04)
- Execution — visible when status = `InProgress` or `Review`. Navigates to AgentsView filtered to this task's session
- Delete / Archive — calls `delete_task` when status ≠ `Done`; calls archive mutation when status = `Done`
- ✕ — calls `setActiveTaskId(null)` → returns to board

**D-03:** Main content area (left/center):
- Title: large seamless `contenteditable` element; border appears on hover/focus; saves on blur
- Description: seamless `contenteditable` textarea; saves on blur
- Attachments section: list with filename + size + remove button; dropzone + file picker below; dropzone/picker hidden when task is not in Backlog
- IPC: `add_task_attachment` / `remove_task_attachment`

**D-04 (interrupt flow):** Interrupt button → confirmation modal with prompt: "Interrupt the working agent?". Three choices:
- Resume — sends a "resume" prompt to the agent (un-interrupts, agent continues)
- Rework — calls `interrupt_task`, moves task back to `Backlog`
- Cancel — archives task with cancelled status

**D-05:** Right sidebar — always displayed but read-only except the status dropdown:
- Status, Priority, Agent, Base Branch, Labels, Auto-approve badge, Worktree type

**D-06:** User can only toggle between `Backlog` ↔ `Ready` via the status dropdown. All other status transitions are automatic. The dropdown shows all statuses for context but only `Backlog` and `Ready` are selectable.

**D-07:** `agent_id` must be set before `Backlog → Ready`. If no agent assigned, status dropdown blocks transition and shows inline error: "Assign an agent before marking as Ready."

### Claude's Discretion

- Exact save debounce/blur timing for contenteditable fields
- Interrupt modal styling (can reuse existing modal patterns)
- Sidebar field order beyond status (priority first is a reasonable default)
- Animation/transition when entering/exiting detail screen (framer-motion, consistent with existing tab transitions)

### Deferred Ideas (OUT OF SCOPE)

- "Improve" AI button — stub only in this phase; full implementation deferred
- Agent-required gate error UI design (exact error component/placement) — left to planner
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| DETAIL-01 | Task detail is a dedicated full screen (not overlay/modal) | `TaskDetailScreen.tsx` replaces overlay; KanbanView routing already in place |
| DETAIL-02 | Title and description editable only when status is Backlog | `isEditable = task.status === "Backlog"`; contenteditable with blur-save via `useUpdateTask` |
| DETAIL-03 | Locked banner + Interrupt button appear in action bar when status ≠ Backlog | Conditional render in action bar; locked state is `task.status !== "Backlog"` |
| DETAIL-04 | Interrupt stops active agent session and moves task to Backlog | `useInterruptTaskMutation()` → `api.interruptTask(taskId)` already wired |
| DETAIL-05 | User can upload and remove file attachments (only in Backlog) | `useAddTaskAttachmentMutation`, `useRemoveTaskAttachmentMutation`, `useTaskAttachmentsQuery`; `@tauri-apps/plugin-dialog` for file picker |
| DETAIL-06 | User changes task status via sidebar dropdown | `Select` component from `@base-ui/react/select`; `useUpdateTask` for status change; D-06/D-07 guards |
| DETAIL-07 | Execution button in action bar links to agent session (InProgress/Review only) | `navigate({ agentId: String(task.id) })` — AgentsView uses `pendingAgentId` to find session by `task_id` |
| DETAIL-08 | Delete action removes task; becomes Archive when status is Done | `useDeleteTaskMutation` (status ≠ Done); `useArchiveTaskMutation` (status = Done) |
</phase_requirements>

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Screen routing (board ↔ detail) | Frontend Client | — | Pure in-memory `activeTaskId` state in `navigationStore`; no URL routing |
| Task data fetch | Frontend Client | Rust IPC | Read from cached `useTasksQuery`; TanStack Query owns cache |
| Inline field editing (title, description) | Frontend Client | — | `contenteditable` + blur → `useUpdateTask` mutation |
| Sidebar field editing (labels, auto_approve, isolated_worktree) | Rust IPC | Frontend Client | Requires Rust `update_task` extension for these fields |
| Status change with guards | Frontend Client | — | Client-side guard (agent check), then `useUpdateTask(status)` |
| Interrupt flow | Frontend Client + Rust IPC | — | Modal in client; `interrupt_task` IPC stops session |
| Resume flow | Frontend Client + Rust IPC | — | Find active session by `task_id` from `useActiveSessionsQuery`; call `api.sendAcpPrompt(session_key, "resume")` |
| File attachments | Frontend Client + Rust IPC | — | `@tauri-apps/plugin-dialog` for picker; `add/remove_task_attachment` IPC for persistence |
| Enter/exit animation | Frontend Client | — | framer-motion; within KanbanView's mounted subtree |

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| React 19 | 19.x | Component rendering | Project standard [VERIFIED: package.json] |
| framer-motion | existing | Enter/exit animation for detail screen | Already used in App.tsx for view transitions [VERIFIED: codebase] |
| @base-ui-components/react | existing | Select (status dropdown), Dialog (interrupt modal), AlertDialog | Project UI standard; no `asChild` on Trigger [VERIFIED: codebase] |
| @tanstack/react-query | existing | All IPC via hooks | Project standard; no direct invoke() [VERIFIED: codebase] |
| zustand + immer | existing | navigationStore for routing | Project standard [VERIFIED: codebase] |
| @tauri-apps/plugin-dialog | existing | File picker (open dialog) for attachments | Already used in ComposeBar.tsx [VERIFIED: codebase] |
| lucide-react | existing | Icons (Trash2, Archive, Zap, Pause, X, etc.) | Project icon standard [VERIFIED: codebase] |
| sonner | existing | Toast notifications | Project standard via `createErrorToastHandler` [VERIFIED: codebase] |

### No New Dependencies
This phase requires zero new package installations. All required libraries are already in the project.

## Architecture Patterns

### System Architecture Diagram

```
User clicks task card
        |
        v
TaskCard.onClick → setActiveTaskId(task.id) [navigationStore]
        |
        v
KanbanView: activeTaskId !== null
        → renders <TaskDetailScreen taskId={activeTaskId} />
        |
        v
TaskDetailScreen
  ├── fetch: task from useTasksQuery cache (by id filter)
  ├── fetch: useTaskAttachmentsQuery(taskId)
  ├── ACTION BAR
  │     ├── title (truncated, read-only here)
  │     ├── [Improve stub]
  │     ├── [Interrupt] ← only when InProgress → InterruptModal
  │     ├── [Execution] ← only when InProgress/Review → navigate({agentId: String(taskId)})
  │     ├── [Delete/Archive] → useDeleteTaskMutation / useArchiveTaskMutation
  │     └── [✕] → setActiveTaskId(null)
  ├── MAIN CONTENT (left/center)
  │     ├── Title: contenteditable → onBlur → useUpdateTask(title)
  │     ├── Description: contenteditable → onBlur → useUpdateTask(description)
  │     └── Attachments (Backlog only)
  │           ├── list: TaskAttachment[] with remove buttons
  │           └── dropzone + file picker → openFilePicker → useAddTaskAttachmentMutation
  └── RIGHT SIDEBAR
        ├── Status: Select (Backlog/Ready selectable; others display-only) → useUpdateTask(status)
        ├── Priority: display / Select (Backlog only) → useUpdateTask(priority)
        ├── Agent: display / selector (Backlog only) → useUpdateTask(agentId)
        ├── Base Branch: display (read-only; branch set at creation)
        ├── Labels: display / editable (Backlog only) → update_task extension
        ├── Auto-approve: badge / toggle (Backlog only) → update_task extension
        └── Worktree type: badge / toggle (Backlog only) → update_task extension

InterruptModal (local state: isInterruptOpen)
  ├── [Resume] → find session by task_id in useActiveSessionsQuery → api.sendAcpPrompt(session_key, "resume")
  ├── [Rework] → useInterruptTaskMutation(taskId)
  └── [Cancel] → useArchiveTaskMutation(taskId)  [NOTE: archive = cancelled path per CONTEXT.md D-04]
```

### Recommended Project Structure

```
src/components/task/
├── TaskDetailScreen.tsx    # REPLACE stub — full implementation (main file)
├── TaskDetail.tsx          # DELETE in this phase
```

No new files beyond `TaskDetailScreen.tsx`. The interrupt modal is co-located in the same file as a local component (`InterruptModal`).

### Pattern 1: Task Data Access (from cache)

The task list is already fetched by `KanbanView` via `useTasksQuery`. `TaskDetailScreen` receives only a `taskId`. Access the task from the cached query:

```typescript
// Source: src/services/task.service.ts + src/store/projectStore.ts
const { projectId } = useSelectedProject() ?? { projectId: null };
const { data: tasks } = useTasksQuery(projectId);
const task = tasks?.find(t => t.id === taskId) ?? null;
```

This avoids a second IPC call for a single task. Task data is kept fresh by the `tasks-changed` event listener in `useTasksQuery`.

### Pattern 2: contenteditable Inline Editing

No prior contenteditable usage exists in the codebase — this is new to Phase 62. Standard pattern:

```typescript
// Save on blur, show border on hover/focus
function EditableTitle({ value, onSave, isEditable }: { value: string; onSave: (v: string) => void; isEditable: boolean }) {
  const ref = useRef<HTMLDivElement>(null);

  function handleBlur() {
    const text = ref.current?.innerText ?? "";
    if (text !== value) onSave(text);
  }

  return (
    <div
      ref={ref}
      contentEditable={isEditable}
      suppressContentEditableWarning
      onBlur={isEditable ? handleBlur : undefined}
      className={cn(
        "text-2xl font-semibold outline-none rounded px-1",
        isEditable && "hover:border hover:border-border focus:border focus:border-ring",
      )}
    >
      {value}
    </div>
  );
}
```

Key points [ASSUMED]:
- `suppressContentEditableWarning` required to silence React warning
- `innerText` (not `innerHTML`) to get plain text
- Initialize via `ref.current.innerText = value` in `useEffect` when task data loads, OR use `defaultValue`-style initialization via children

### Pattern 3: File Picker + Attachment Upload

```typescript
// Source: src/components/execution/activity/ComposeBar.tsx (established pattern)
import { open as openFilePicker } from "@tauri-apps/plugin-dialog";

const addAttachment = useAddTaskAttachmentMutation();

async function handlePickFile() {
  const selected = await openFilePicker({ multiple: true });
  if (!selected) return;
  const paths = Array.isArray(selected) ? selected : [selected];
  for (const filePath of paths) {
    const filename = filePath.slice(Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\")) + 1);
    // file_size: use Tauri fs API or pass 0 if size unavailable
    addAttachment.mutate({ taskId, filename, filePath, fileSize: 0 });
  }
}
```

**Gap:** `add_task_attachment` IPC takes `fileSize` as `number`. The frontend must read the file size via Tauri's `fs` plugin or `stat`. Alternatively, size can be stored as 0 and displayed as unknown. [ASSUMED] The simplest path: use `@tauri-apps/plugin-fs` `stat()` call to get file size before calling `addAttachment.mutate`.

### Pattern 4: Status Dropdown with Guards

```typescript
// Source: src/components/ui/select.tsx — base-ui Select component
// D-06: only Backlog and Ready are selectable
function StatusSelect({ task }: { task: Task }) {
  const updateTask = useUpdateTask();
  const ALL_STATUSES: TaskStatus[] = ["Backlog", "Ready", "InProgress", "Review", "Done"];
  const selectableStatuses = new Set<TaskStatus>(["Backlog", "Ready"]);

  function handleChange(newStatus: string) {
    if (newStatus === "Ready" && !task.agent_id) {
      // D-07 gate: show inline error
      setAgentError("Assign an agent before marking as Ready.");
      return;
    }
    updateTask.mutate({ taskId: task.id, updates: { status: newStatus as TaskStatus } });
  }

  return (
    <Select value={task.status} onValueChange={handleChange}>
      <SelectTrigger size="sm"><SelectValue /></SelectTrigger>
      <SelectContent>
        {ALL_STATUSES.map(s => (
          <SelectItem key={s} value={s} disabled={!selectableStatuses.has(s)}>
            {s}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
```

**base-ui Select note:** `SelectItem` supports `disabled` prop — items render but are not interactive.

### Pattern 5: Interrupt Modal (three-choice)

Use `Dialog` from `@base-ui/react/dialog` (already wrapped in `src/components/ui/dialog.tsx`). Three-button layout, not AlertDialog (which is for two-choice confirm/cancel):

```typescript
// Source: src/components/ui/dialog.tsx
function InterruptModal({ open, onClose, taskId, task }: InterruptModalProps) {
  const interruptTask = useInterruptTaskMutation();
  const archiveTask = useArchiveTaskMutation();
  const { data: sessions = [] } = useActiveSessionsQuery();

  function handleResume() {
    const session = sessions.find(s => s.task_id === taskId);
    if (session) {
      void api.sendAcpPrompt(session.session_key, "resume");
    }
    onClose();
  }

  function handleRework() {
    interruptTask.mutate(taskId, { onSuccess: onClose });
  }

  function handleCancel() {
    archiveTask.mutate(taskId, { onSuccess: onClose });
  }

  return (
    <Dialog open={open} onOpenChange={(_, open) => !open && onClose()}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Interrupt the working agent?</DialogTitle>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={handleResume}>Resume</Button>
          <Button variant="secondary" onClick={handleRework}>Rework</Button>
          <Button variant="destructive" onClick={handleCancel}>Cancel Task</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

### Pattern 6: Execution Button Navigation

```typescript
// Source: src/views/AgentsView.tsx — pendingAgentId mechanism
// AgentsView finds session by: sessions.find(s => String(s.task_id) === pendingAgentId)
const navigate = useNavigate();

function handleExecutionClick() {
  navigate({ agentId: String(task.id) });
}
```

**Important:** `pendingAgentId` is set as a string of the task's numeric ID, NOT the agent_id field. AgentsView matches it against `String(session.task_id)`.

### Pattern 7: Enter Animation within KanbanView

The detail screen slides in within the KanbanView container. Use framer-motion `motion.div` with a simple fade+slide:

```typescript
// Source: src/utils/constants/animations.ts — PAGE_TRANSITION_DURATION = 0.25, PAGE_TRANSITION_EASING = "easeInOut"
import { motion } from "framer-motion";
import { PAGE_TRANSITION_DURATION, PAGE_TRANSITION_EASING } from "@/utils/constants/animations";

// In TaskDetailScreen — wraps entire screen
<motion.div
  initial={{ opacity: 0, x: 20 }}
  animate={{ opacity: 1, x: 0 }}
  transition={{ duration: PAGE_TRANSITION_DURATION, ease: PAGE_TRANSITION_EASING }}
  className="absolute inset-0 bg-background flex flex-col"
>
  {/* content */}
</motion.div>
```

### Pattern 8: Dropzone (HTML5 drag-and-drop)

No existing drag-drop library in the project. Use native HTML5 drag events — no new dependency:

```typescript
function AttachmentsDropzone({ onDrop }: { onDrop: (files: FileList) => void }) {
  const [isDragOver, setIsDragOver] = useState(false);

  return (
    <div
      onDragOver={e => { e.preventDefault(); setIsDragOver(true); }}
      onDragLeave={() => setIsDragOver(false)}
      onDrop={e => { e.preventDefault(); setIsDragOver(false); onDrop(e.dataTransfer.files); }}
      className={cn("border-2 border-dashed rounded-lg p-4 text-center text-sm text-muted-foreground",
        isDragOver && "border-ring bg-muted/20")}
    >
      Drop files here or{" "}
      <button onClick={handlePickFile} className="underline">browse</button>
    </div>
  );
}
```

**Tauri note:** HTML5 drag-and-drop gives `File` objects with `name` and `size` but path access is restricted in browser context. In a Tauri WebView, `file.path` may not be available. The file picker (`openFilePicker`) returns absolute paths — prefer file picker over drag-drop for `filePath` capture. [ASSUMED — Tauri WebView may or may not expose `file.path` on drag-drop; safest path is to use the file picker for the actual path and show dropzone as a UX entry point that opens the picker]

### Anti-Patterns to Avoid

- **Calling invoke() directly:** All IPC through service hooks. No `invoke()` calls in components.
- **Reading task via a separate `get_task` IPC:** The task is already in the `useTasksQuery` cache — find it there. No IPC call needed.
- **Using Radix asChild on base-ui Trigger:** base-ui `Trigger` has no `asChild`. Use `buttonVariants()` on the element directly. Also: `SelectTrigger` in `select.tsx` does not need `asChild` — it renders as a button natively.
- **Three-state interrupt from AlertDialog:** AlertDialog is two-choice. Use `Dialog` for the three-button interrupt flow.
- **Mutating task status to InProgress/Review/Done/Cancelled from dropdown:** D-06 restricts dropdown to Backlog ↔ Ready only. All other transitions are system-driven.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Confirmation dialog | Custom modal HTML | `Dialog` from `@/ui/dialog` (base-ui) | Existing styled component with animations |
| Status dropdown | `<select>` element | `Select/SelectItem` from `@/ui/select` | base-ui Select handles keyboard nav, positioning, animations |
| File picker dialog | Custom file browser | `open` from `@tauri-apps/plugin-dialog` | Already in use; handles OS native picker |
| Error toasts | Custom toast | `createErrorToastHandler` from `@/lib/error-utils` | Standard pattern across all mutations |
| Slug/format utilities | Custom formatting | `cn` from `@/lib/ui-utils`, `format-utils.ts` | Project utilities already available |
| Animation constants | Custom timing values | `PAGE_TRANSITION_DURATION`, `PAGE_TRANSITION_EASING` | Defined in `src/utils/constants/animations.ts` |

**Key insight:** The hardest part of this phase is the backend gap (update_task missing labels/auto_approve/isolated_worktree) — not the UI patterns.

## Backend Gap: update_task Missing Fields

**[VERIFIED: codebase grep + task_handlers.rs inspection]**

`update_task` Rust handler at `src-tauri/src/ipc/task_handlers.rs:119` accepts:
- `status`, `description`, `title`, `priority`, `base_branch`, `skills`, `agent_id`

Does NOT accept: `labels`, `auto_approve`, `isolated_worktree`

These columns exist in the SQLite schema (verified `schema.rs:49-51`) and in the `Task` TypeScript type (verified `bindings.ts:1673`), but there is no update path.

The frontend `useUpdateTask` hook signature at `task.service.ts:95` matches the Rust handler — it also does not include these fields.

**Resolution options:**
1. Extend `update_task` Rust handler to also accept `labels: Option<Vec<String>>`, `auto_approve: Option<bool>`, `isolated_worktree: Option<bool>` → regenerate bindings → update `useUpdateTask` service hook
2. Add a separate `update_task_flags` IPC command
3. Treat labels/auto_approve/isolated_worktree as display-only in Phase 62 (deferring editability to a future phase)

**CONTEXT.md D-01 says all fields including labels/auto_approve/isolated_worktree are editable in Backlog.** Option 1 (extend `update_task`) is the correct path. Plan must include a Wave 1 backend task.

## Common Pitfalls

### Pitfall 1: contenteditable React hydration mismatch
**What goes wrong:** React controls the DOM via the virtual DOM, but `contenteditable` allows direct DOM mutations. On re-render, React may overwrite user-typed text in the element.
**Why it happens:** React re-renders when parent state changes (e.g., task list refreshes due to `tasks-changed` event), and the element's `children` differ from what React last set.
**How to avoid:** Use `suppressContentEditableWarning={true}`. Initialize element content with a `useEffect` that sets `ref.current.innerText = task.title` only when the task's server-side value changes — not on every render. Use a ref to track whether the user is currently editing to block overwrite during active edits.
**Warning signs:** User types in the field and text jumps or clears unexpectedly.

### Pitfall 2: Interrupt "Cancel" leaves task status as InProgress, not Cancelled [VERIFIED]
**What goes wrong:** D-04 says "Cancel" archives the task with cancelled status. `archiveTask` only sets `archived_at` -- it does NOT change the task status. The task's `status` remains `InProgress` after archiving.
**Why it happens:** Verified in `src-tauri/src/ipc/task_handlers.rs:237`: `archive_task` executes `UPDATE tasks SET archived_at = ?, updated_at = ? WHERE id = ?` -- no status update. The `Cancelled` status value exists in `TaskStatus` but is never set by `archive_task`.
**How to avoid:** The interrupt Cancel path must also set `status = "Cancelled"`. The cleanest approach is a new `cancel_task` IPC that sets both `status = "Cancelled"` and `archived_at` in one transaction. Plan must include this as a Wave 1 backend task.
**Warning signs:** Cancelled tasks have `archived_at` set so they are filtered off the Done column, but with `status = "InProgress"` they could appear in unexpected query results.

### Pitfall 3: Execution button navigates by task_id string, not agent_id
**What goes wrong:** Developer reads D-02 "navigate to AgentsView filtered to this task's session" and calls `navigate({ agentId: task.agent_id })`. AgentsView does not find the session.
**Why it happens:** `pendingAgentId` is matched against `String(session.task_id)` in AgentsView, NOT against `session.agent_id`.
**How to avoid:** Use `navigate({ agentId: String(task.id) })` — pass the task's numeric ID as a string.
**Warning signs:** Execution button navigates to AgentsView but no session is highlighted.

### Pitfall 4: File size unavailable from drag-drop in Tauri WebView
**What goes wrong:** HTML5 drag-drop gives `File` objects. `file.path` is available in Tauri WebView (Tauri registers a custom protocol that exposes the path), but `file.size` is accurate. The IPC `add_task_attachment` requires a numeric `fileSize`.
**How to avoid:** For drag-drop files, use `file.size` from the `File` object. For file picker, use `@tauri-apps/plugin-fs` `stat()` to get size. Do not pass 0 as file size — the UI displays it to the user.
**Warning signs:** File size shows as 0 bytes in attachments list.

### Pitfall 5: `useUpdateTask` `updates` parameter doesn't pass through labels/auto_approve
**What goes wrong:** Developer calls `useUpdateTask().mutate({ taskId, updates: { labels: [...] } })` expecting it to work after Rust update, but the service hook at `task.service.ts:96` explicitly maps only the supported fields.
**How to avoid:** When extending `update_task` in Rust, also update the `useUpdateTask` hook's `mutationFn` to pass `labels`, `auto_approve`, `isolated_worktree` through to the API call.
**Warning signs:** Labels/auto_approve/isolated_worktree changes silently ignored.

### Pitfall 6: base-ui Dialog onOpenChange signature
**What goes wrong:** Developer writes `onOpenChange={(open) => !open && onClose()}` expecting a boolean. base-ui Dialog's `onOpenChange` receives `(event, open)` not just `(open)`.
**Why it happens:** Radix UI uses `(open: boolean)`, base-ui uses `(event: Event, open: boolean)`.
**How to avoid:** Use `onOpenChange={(_, open) => !open && onClose()}`.
**Warning signs:** TypeScript error on the handler or modal won't close.

## Code Examples

### Task from cache (verified pattern)
```typescript
// Source: pattern consistent with src/views/KanbanView.tsx useTasksQuery usage
const { projectId } = useSelectedProject() ?? { projectId: null };
const { data: tasks } = useTasksQuery(projectId);
const task = (tasks ?? []).find(t => t.id === taskId) ?? null;
```

### File picker (verified — ComposeBar.tsx)
```typescript
// Source: src/components/execution/activity/ComposeBar.tsx:185
import { open as openFilePicker } from "@tauri-apps/plugin-dialog";
const selected = await openFilePicker({ multiple: true });
const paths = Array.isArray(selected) ? selected : (selected ? [selected] : []);
```

### useInterruptTaskMutation (verified — task.service.ts)
```typescript
// Source: src/services/task.service.ts:507
const interrupt = useInterruptTaskMutation();
interrupt.mutate(taskId, { onSuccess: () => { /* navigate to Backlog state */ } });
```

### useActiveSessionsQuery for resume path (verified — AgentsView.tsx)
```typescript
// Source: src/services/execution.service.ts (used in AgentsView.tsx)
const { data: sessions = [] } = useActiveSessionsQuery();
const activeSession = sessions.find(s => s.task_id === taskId);
// session.session_key is the log_id for sendAcpPrompt
if (activeSession) {
  void api.sendAcpPrompt(activeSession.session_key, "resume");
}
```

### Navigation to AgentsView (verified — AgentsView.tsx:101)
```typescript
// Source: src/views/AgentsView.tsx:101 — sessions.find(s => String(s.task_id) === pendingAgentId)
const navigate = useNavigate();
navigate({ agentId: String(task.id) }); // String(task.id), not task.agent_id
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| TaskDetail.tsx modal overlay | TaskDetailScreen.tsx full-screen | Phase 62 (this phase) | Delete TaskDetail.tsx; no modal backdrop |
| Tabs inside modal (Info / Execution / Terminal) | Action bar + two-panel layout | Phase 62 (this phase) | Execution tab removed; Execution button navigates to AgentsView |
| Description-only editing via Textarea | contenteditable title + description | Phase 62 (this phase) | Seamless inline editing |
| Sub-view routing (activeSubView) | activeTaskId in navigationStore | Phase 58 (already complete) | No sub-view state exists |

**Deprecated/outdated:**
- `TaskDetail.tsx`: DELETE this file entirely. It is a modal overlay that is replaced by the full-screen pattern.
- `activeSubView` / `SubView` type: Already removed in Phase 58. Do not reference.
- `InProgress` as editable status: Phase 62 locks all fields except status dropdown when not in Backlog.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | HTML5 drag-drop in Tauri WebView exposes `file.path` for the absolute path | Pattern 8 (Dropzone) | If `file.path` is undefined, drag-drop can't be used to get the path; must open picker instead |
| A2 | VERIFIED: archiveTask only sets archived_at, NOT status=Cancelled. Cancel path must set status=Cancelled separately or via a new cancel_task IPC. | Pitfall 2 | N/A -- resolved |
| A3 | VERIFIED: tauri-plugin-fs NOT in project. File size via HTML5 File.size (drag-drop only) or add plugin as dependency. | Pattern 3 | Resolved -- see Pitfall 4 |
| A4 | `contenteditable` children approach works for initialization without hydration issues | Pattern 2 | If React overwrites typed content on re-render, a ref-based initialization approach is needed |

## Open Questions

All open questions were resolved during research:

1. **RESOLVED: `archive_task` does NOT set status = "Cancelled"**
   - Verified in `src-tauri/src/ipc/task_handlers.rs:237`
   - Only sets `archived_at`. Status is unchanged.
   - Planner must include a `cancel_task` IPC (sets `status = "Cancelled"` AND `archived_at`) OR sequence two IPC calls in the Cancel path.

2. **RESOLVED: `@tauri-apps/plugin-fs` is NOT in the project**
   - Verified: not in `src-tauri/Cargo.toml` or `package.json`
   - File picker returns string paths with no size. HTML5 drag-drop File objects have `.size`.
   - Planner must choose: add `tauri-plugin-fs` for stat(), or use HTML5 File.size from drag-drop, or display unknown size.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| @tauri-apps/plugin-dialog | File picker for attachments | ✓ | in use (ComposeBar.tsx) | — |
| @tauri-apps/plugin-fs | File size for attachments | ✗ | -- | Use HTML5 File.size (drag-drop) or add plugin as dep |
| framer-motion | Enter animation | ✓ | in use (App.tsx) | CSS transition |
| @base-ui-components/react | Dialog, Select | ✓ | in use | — |
| sonner | Error toasts | ✓ | in use | — |

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest (happy-dom environment) |
| Config file | `vite.config.ts` (test section) |
| Quick run command | `pnpm test TaskDetailScreen` |
| Full suite command | `pnpm test` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| DETAIL-01 | Renders full screen (not modal), close button calls setActiveTaskId(null) | unit | `pnpm test TaskDetailScreen` | ❌ Wave 0 |
| DETAIL-02 | Title/description editable in Backlog, read-only otherwise | unit | `pnpm test TaskDetailScreen` | ❌ Wave 0 |
| DETAIL-03 | Locked banner visible when status ≠ Backlog, Interrupt button visible when InProgress | unit | `pnpm test TaskDetailScreen` | ❌ Wave 0 |
| DETAIL-04 | Interrupt → Rework calls interruptTask mutation | unit | `pnpm test TaskDetailScreen` | ❌ Wave 0 |
| DETAIL-05 | Attachments section hidden when non-Backlog; add/remove attachment mutations called | unit | `pnpm test TaskDetailScreen` | ❌ Wave 0 |
| DETAIL-06 | Status dropdown changes call updateTask; Backlog→Ready blocked without agent_id | unit | `pnpm test TaskDetailScreen` | ❌ Wave 0 |
| DETAIL-07 | Execution button navigates with agentId=String(task.id) | unit | `pnpm test TaskDetailScreen` | ❌ Wave 0 |
| DETAIL-08 | Delete calls deleteTask; archive button visible when status=Done | unit | `pnpm test TaskDetailScreen` | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** `pnpm test TaskDetailScreen`
- **Per wave merge:** `pnpm test`
- **Phase gate:** Full suite green before `/gsd-verify-work`

### Wave 0 Gaps
- [ ] `src/components/task/__tests__/TaskDetailScreen.test.tsx` — covers all DETAIL-* requirements
- [ ] Shared mock for `useTasksQuery`, `useUpdateTask`, `useInterruptTaskMutation`, `useArchiveTaskMutation`, `useDeleteTaskMutation`, `useActiveSessionsQuery`, `navigationStore`

## Security Domain

Security enforcement: default (enabled). This phase is purely a frontend rendering and mutation layer — no auth, no new backend endpoints, no cryptography, no session management. Applicable ASVS categories are minimal:

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no | — |
| V3 Session Management | no | — |
| V4 Access Control | no | — |
| V5 Input Validation | yes (limited) | Title/description saved via existing `update_task` IPC which has Rust-side validation (title 3-255 chars) |
| V6 Cryptography | no | — |

No new threat surface introduced. All mutations go through existing validated IPC handlers.

## Sources

### Primary (HIGH confidence)
- `src/components/task/TaskDetail.tsx` — existing 342-line modal; read in full
- `src/components/task/TaskDetailScreen.tsx` — 7-line stub to replace
- `src/views/KanbanView.tsx` — routing wiring verified
- `src/store/navigationStore.ts` — navigate(), setActiveTaskId(), pendingAgentId API verified
- `src/services/task.service.ts` — all mutation hooks verified
- `src/types/bindings.ts` — Task type, TaskAttachment, TaskStatus, all IPC signatures verified
- `src-tauri/src/ipc/task_handlers.rs` — update_task gap (missing labels/auto_approve/isolated_worktree) verified
- `src/components/ui/dialog.tsx` — base-ui Dialog wrapping verified
- `src/components/ui/select.tsx` — base-ui Select wrapping verified
- `src/components/ui/alert-dialog.tsx` — base-ui AlertDialog verified
- `src/views/AgentsView.tsx` — pendingAgentId→task_id matching verified
- `src/components/execution/activity/ComposeBar.tsx` — openFilePicker pattern verified
- `src/utils/constants/animations.ts` — PAGE_TRANSITION_DURATION/EASING verified
- `src/App.tsx` — framer-motion useAnimationControls pattern verified

### Secondary (MEDIUM confidence)
- `src-tauri/src/db/schema.rs` — labels/auto_approve/isolated_worktree columns confirmed

### Tertiary (LOW confidence)
- Tauri WebView drag-drop file.path availability — not directly verified; based on Tauri documentation knowledge [ASSUMED]
- `@tauri-apps/plugin-fs` stat() availability — plugin may be in Cargo.toml; not verified in this research session [ASSUMED]

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all libraries verified in codebase
- Architecture: HIGH — all patterns traced to actual source files
- Pitfalls: HIGH for IPC gaps (verified), MEDIUM for contenteditable hydration (standard React behavior), LOW for Tauri-specific file path behavior
- Backend gap: HIGH — verified by reading task_handlers.rs

**Research date:** 2026-05-27
**Valid until:** 2026-06-10 (stable codebase; changes only if Phase 61 final commits alter service layer)
