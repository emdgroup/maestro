# Phase 62: Task Detail Screen - Pattern Map

**Mapped:** 2026-05-27
**Files analyzed:** 4 (1 replaced, 1 deleted, 1 extended frontend service, 1 extended Rust handler)
**Analogs found:** 4 / 4

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `src/components/task/TaskDetailScreen.tsx` | component (full-screen view) | request-response + CRUD | `src/components/task/TaskDetail.tsx` | exact (same domain, same mutations) |
| `src/components/task/TaskDetail.tsx` | — | — | DELETE — no analog needed | n/a |
| `src/services/task.service.ts` (extend `useUpdateTask`) | service | CRUD | `src/services/task.service.ts` itself | self-extension |
| `src-tauri/src/ipc/task_handlers.rs` (extend `update_task`) | IPC handler | CRUD | `src-tauri/src/ipc/task_handlers.rs` itself | self-extension |

---

## Pattern Assignments

### `src/components/task/TaskDetailScreen.tsx` (component, request-response + CRUD)

**Analog:** `src/components/task/TaskDetail.tsx` (delete this file after migration)

**Imports pattern** (`TaskDetail.tsx` lines 1-15 — copy and extend):
```typescript
import { useState, useRef, useEffect } from "react";
import { motion } from "framer-motion";
import { Trash2, Archive, Zap, Pause, X, Sparkles } from "lucide-react";
import type { Task, TaskStatus, TaskAttachment } from "@/types/bindings";
import { cn } from "@/lib/ui-utils";
import { Button } from "@/ui/button";
import { Badge } from "@/ui/badge";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/ui/select";
import { open as openFilePicker } from "@tauri-apps/plugin-dialog";
import {
  useUpdateTask,
  useInterruptTaskMutation,
  useArchiveTaskMutation,
  useDeleteTaskMutation,
  useAddTaskAttachmentMutation,
  useRemoveTaskAttachmentMutation,
  useTaskAttachmentsQuery,
} from "@/services/task.service";
import { useActiveSessionsQuery } from "@/services/execution.service";
import { api } from "@/lib/tauri-utils";
import { useTasksQuery } from "@/services/task.service";
import { useSelectedProject } from "@/store/projectStore";
import { useNavigationActions, useNavigate } from "@/store/navigationStore";
import { PAGE_TRANSITION_DURATION, PAGE_TRANSITION_EASING } from "@/utils/constants/animations";
```

**Task data access from cache** (RESEARCH.md Pattern 1 — verified against `KanbanView.tsx` lines 23-24 + `useTasksQuery`):
```typescript
// TaskDetailScreen receives only taskId; task data lives in useTasksQuery cache
const { projectId } = useSelectedProject() ?? { projectId: null };
const { data: tasks } = useTasksQuery(projectId);
const task = (tasks ?? []).find(t => t.id === taskId) ?? null;
```
Do NOT call a separate `get_task` IPC — the task is already cached.

**Edit-lock guard** (`TaskDetail.tsx` line 190 — verified isEditable pattern):
```typescript
// D-01: all fields editable only when Backlog
const isEditable = task.status === "Backlog";
```

**Enter animation pattern** (`src/App.tsx` lines 184-200 + `animations.ts`):
```typescript
// Wrap the entire screen in motion.div for fade+slide enter
<motion.div
  initial={{ opacity: 0, x: 20 }}
  animate={{ opacity: 1, x: 0 }}
  transition={{ duration: PAGE_TRANSITION_DURATION, ease: PAGE_TRANSITION_EASING }}
  className="absolute inset-0 bg-background flex flex-col"
>
  {/* action bar + two-panel content */}
</motion.div>
```

**Action bar close button** (`TaskDetail.tsx` lines 218-220):
```typescript
// ✕ button returns to board
const { setActiveTaskId } = useNavigationActions();
<Button variant="ghost" size="icon-sm" onClick={() => setActiveTaskId(null)}>
  <X />
</Button>
```

**Execution button navigation** (`AgentsView.tsx` lines 100-108 — verified pendingAgentId matching):
```typescript
// D-07 / DETAIL-07: navigate with agentId = String(task.id), NOT task.agent_id
const navigate = useNavigate();
function handleExecutionClick() {
  navigate({ agentId: String(task.id) });
}
// AgentsView matches: sessions.find(s => String(s.task_id) === pendingAgentId)
```

**Delete / Archive action** (`task.service.ts` lines 244-252, 228-237):
```typescript
const deleteTask = useDeleteTaskMutation();
const archiveTask = useArchiveTaskMutation();

// D-02 / DETAIL-08
function handleDeleteOrArchive() {
  if (task.status === "Done") {
    archiveTask.mutate(task.id, { onSuccess: () => setActiveTaskId(null) });
  } else {
    deleteTask.mutate(task.id, { onSuccess: () => setActiveTaskId(null) });
  }
}
```

**Interrupt button visibility** (`TaskDetail.tsx` line 191 for status checks):
```typescript
// D-02: Interrupt visible only when InProgress; Execution visible InProgress or Review
const showInterrupt = task.status === "InProgress";
const showExecution = task.status === "InProgress" || task.status === "Review";
```

**Contenteditable inline editing** (RESEARCH.md Pattern 2 — no prior codebase analog; use this):
```typescript
// Save on blur, initialize via ref, suppress React warning
// PITFALL: initialize with useEffect, not children, to avoid hydration mismatch
function EditableField({
  value, onSave, isEditable, className,
}: { value: string; onSave: (v: string) => void; isEditable: boolean; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const isEditingRef = useRef(false);

  useEffect(() => {
    // Only set innerText when not actively editing (prevents overwrite of in-progress edits)
    if (ref.current && !isEditingRef.current) {
      ref.current.innerText = value;
    }
  }, [value]);

  return (
    <div
      ref={ref}
      contentEditable={isEditable}
      suppressContentEditableWarning
      onFocus={() => { isEditingRef.current = true; }}
      onBlur={() => {
        isEditingRef.current = false;
        const text = ref.current?.innerText.trim() ?? "";
        if (text !== value) onSave(text);
      }}
      className={cn("outline-none rounded px-1", isEditable && "hover:ring-1 hover:ring-border focus:ring-1 focus:ring-ring", className)}
    />
  );
}
```
Key: use `isEditingRef` to block `useEffect` from overwriting while user types.

**useUpdateTask mutation call** (`task.service.ts` lines 91-112):
```typescript
const updateTask = useUpdateTask();
// Title save on blur:
updateTask.mutate({ taskId: task.id, updates: { title: newTitle } });
// Status change:
updateTask.mutate({ taskId: task.id, updates: { status: newStatus } });
```
Note: after Phase 62 backend extension, `updates` will also accept `labels`, `auto_approve`, `isolated_worktree`.

**Status dropdown with D-06/D-07 guards** (RESEARCH.md Pattern 4 + `select.tsx` lines 9-196):
```typescript
// Only Backlog and Ready are interactive; others render as disabled items (base-ui SelectItem supports disabled)
const ALL_STATUSES: TaskStatus[] = ["Backlog", "Ready", "InProgress", "Review", "Done"];
const SELECTABLE = new Set<TaskStatus>(["Backlog", "Ready"]);
const [agentError, setAgentError] = useState<string | null>(null);

<Select value={task.status} onValueChange={(newStatus) => {
  if (newStatus === "Ready" && !task.agent_id) {
    setAgentError("Assign an agent before marking as Ready.");
    return;
  }
  setAgentError(null);
  updateTask.mutate({ taskId: task.id, updates: { status: newStatus as TaskStatus } });
}}>
  <SelectTrigger size="sm"><SelectValue /></SelectTrigger>
  <SelectContent>
    {ALL_STATUSES.map(s => (
      <SelectItem key={s} value={s} disabled={!SELECTABLE.has(s)}>{s}</SelectItem>
    ))}
  </SelectContent>
</Select>
{agentError && <p className="text-xs text-destructive mt-1">{agentError}</p>}
```

**Attachments query + remove** (`task.service.ts` lines 453-501):
```typescript
const { data: attachments = [] } = useTaskAttachmentsQuery(taskId);
const removeAttachment = useRemoveTaskAttachmentMutation();

// Remove button per attachment item:
removeAttachment.mutate({ attachmentId: att.id, taskId });
```

**File picker + add attachment** (`ComposeBar.tsx` lines 184-197 + `task.service.ts` lines 464-484):
```typescript
const addAttachment = useAddTaskAttachmentMutation();

async function handlePickFile() {
  const selected = await openFilePicker({ multiple: true });
  if (!selected) return;
  const paths = Array.isArray(selected) ? selected : [selected];
  for (const filePath of paths) {
    const filename = filePath.slice(
      Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\")) + 1,
    );
    // HTML5 drag-drop: use file.size from the File object
    // File picker: tauri-plugin-fs is NOT in project — pass 0 or add plugin
    addAttachment.mutate({ taskId, filename, filePath, fileSize: 0 });
  }
}
```

---

### InterruptModal (co-located in `TaskDetailScreen.tsx`)

**Analog:** `src/components/ui/dialog.tsx` (base-ui Dialog wrapper)

**base-ui Dialog onOpenChange signature** (`dialog.tsx` lines 10-11 — CRITICAL pitfall):
```typescript
// WRONG (Radix pattern): onOpenChange={(open) => !open && onClose()}
// CORRECT (base-ui pattern):
<Dialog open={isInterruptOpen} onOpenChange={(_, open) => { if (!open) setIsInterruptOpen(false); }}>
```

**Three-button interrupt modal** (`dialog.tsx` lines 39-98 + RESEARCH.md Pattern 5):
```typescript
// Use Dialog (not AlertDialog) for three-choice flow
// Buttons: Resume / Rework / Cancel Task
const interrupt = useInterruptTaskMutation();
const archiveTask = useArchiveTaskMutation();
const { data: sessions = [] } = useActiveSessionsQuery();

function handleResume() {
  const session = sessions.find(s => s.task_id === taskId);
  if (session) void api.sendAcpPrompt(session.session_key, "resume");
  setIsInterruptOpen(false);
}
function handleRework() {
  interrupt.mutate(taskId, { onSuccess: () => setIsInterruptOpen(false) });
}
function handleCancel() {
  // PITFALL: archiveTask does NOT set status=Cancelled.
  // A cancel_task IPC (sets status=Cancelled AND archived_at) must be added in Wave 1.
  // cancelTask.mutate(taskId, { onSuccess: () => setIsInterruptOpen(false) });
}
```

**DialogContent with showCloseButton=false** (`dialog.tsx` lines 39-71):
```typescript
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
```

---

### `src/services/task.service.ts` — extend `useUpdateTask` (Wave 1)

**Analog:** `task.service.ts` lines 91-112 (self-extension)

**Current mutationFn signature** (lines 95-105):
```typescript
mutationFn: ({ taskId, updates }: { taskId: number; updates: Partial<Task> }) =>
  api.updateTask(
    taskId,
    updates.status ?? null,
    updates.description ?? null,
    updates.title ?? null,
    updates.priority ?? null,
    updates.base_branch ?? null,
    updates.skills ?? null,
    updates.agent_id ?? null,
  ),
```
**Extend to add three new parameters** (after Rust handler is extended):
```typescript
// Add labels, auto_approve, isolated_worktree to the api.updateTask call
// (parameter order must match the Rust handler's new signature)
api.updateTask(
  taskId,
  updates.status ?? null,
  updates.description ?? null,
  updates.title ?? null,
  updates.priority ?? null,
  updates.base_branch ?? null,
  updates.skills ?? null,
  updates.agent_id ?? null,
  updates.labels ?? null,           // new
  updates.auto_approve ?? null,     // new
  updates.isolated_worktree ?? null, // new
),
```
Regenerate bindings with `pnpm tauri:gen` after the Rust change.

---

### `src-tauri/src/ipc/task_handlers.rs` — extend `update_task` (Wave 1)

**Analog:** `task_handlers.rs` lines 115-189 (self-extension)

**Current handler signature** (lines 119-129 — verified):
```rust
pub fn update_task(
    app_state: State<Arc<AppState>>,
    task_id: i32,
    status: Option<String>,
    description: Option<String>,
    title: Option<String>,
    priority: Option<String>,
    base_branch: Option<String>,
    skills: Option<Vec<String>>,
    agent_id: Option<String>,
) -> Result<Task, String>
```

**Add three new parameters** following the existing dynamic SET clause pattern (lines 136-168):
```rust
pub fn update_task(
    app_state: State<Arc<AppState>>,
    task_id: i32,
    status: Option<String>,
    description: Option<String>,
    title: Option<String>,
    priority: Option<String>,
    base_branch: Option<String>,
    skills: Option<Vec<String>>,
    agent_id: Option<String>,
    labels: Option<Vec<String>>,      // new
    auto_approve: Option<bool>,        // new
    isolated_worktree: Option<bool>,   // new
) -> Result<Task, String>
```

Add matching `if let Some` blocks for `labels` (JSON serialize same as `skills`), `auto_approve`, and `isolated_worktree` in the dynamic SET builder.

---

### New `cancel_task` IPC command in `task_handlers.rs` (Wave 1)

**Analog:** `task_handlers.rs` `archive_task` function (lines 227-244)

`archive_task` only sets `archived_at` — it does NOT set `status = "Cancelled"` (verified). The Interrupt → Cancel path requires both. Add a new `cancel_task` command modeled on `archive_task` but also sets `status = "Cancelled"` in the same UPDATE:

```rust
/// Cancel a task: sets status=Cancelled and archived_at in one transaction
#[tauri::command]
#[specta::specta]
pub fn cancel_task(
    app_state: State<Arc<AppState>>,
    task_id: i32,
) -> Result<Task, String> {
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE tasks SET status = 'Cancelled', archived_at = ?, updated_at = ? WHERE id = ?",
        rusqlite::params![now, now, task_id],
    ).map_err(|e| e.to_string())?;
    app_state.app_handle.emit("tasks-changed", ()).ok();
    // read back and return Task
    // ... (same read-back pattern as archive_task)
}
```

Register in `collect_commands![]` in `lib.rs` and regenerate bindings.

---

## Shared Patterns

### Error Toasts
**Source:** `src/utils/helpers/error-utils.ts` lines 22-26
**Apply to:** All mutation `onError` handlers in `TaskDetailScreen.tsx` (but prefer co-locating in service hooks)
```typescript
// Already wired in all service hooks via:
onError: createErrorToastHandler("Failed to <action>"),
// createErrorToastHandler signature:
export function createErrorToastHandler(actionName: string) {
  return (error: unknown) => {
    toast.error(`${actionName}: ${getErrorMessage(error)}`);
  };
}
```

### Mutation Loading State (disable buttons during pending)
**Source:** `TaskDetail.tsx` lines 106, 169, 275 — pattern: `disabled={mutation.isPending}`
**Apply to:** All action bar buttons, InterruptModal buttons
```typescript
<Button onClick={handleDeleteOrArchive} disabled={deleteTask.isPending || archiveTask.isPending}>
  {task.status === "Done" ? <Archive /> : <Trash2 />}
</Button>
```

### base-ui Popover / Select Trigger (no asChild)
**Source:** `KanbanView.tsx` lines 68, 104 — `buttonVariants()` on the element directly
**Apply to:** Any Popover or Select trigger in TaskDetailScreen that uses a custom element
```typescript
// WRONG: <PopoverTrigger asChild><Button>...</Button></PopoverTrigger>
// CORRECT:
<PopoverTrigger className={buttonVariants({ variant: "outline", size: "sm" })}>
  ...
</PopoverTrigger>
// Note: SelectTrigger renders as a button natively — no asChild needed
```

### TanStack Query — IPC via hooks only
**Source:** All service files, enforced across codebase
**Apply to:** Every IPC operation in `TaskDetailScreen.tsx`
```typescript
// NEVER: invoke("update_task", { ... })
// ALWAYS: useUpdateTask().mutate({ ... })
```

### isEditable guard
**Source:** `TaskDetail.tsx` line 190
```typescript
const isEditable = task.status === "Backlog";  // D-01: no field-level exceptions
```
Apply `isEditable` to: contenteditable `contentEditable` prop, attachment dropzone visibility (`{isEditable && <AttachmentsDropzone />}`), sidebar field editability.

---

## No Analog Found

| File / Capability | Role | Reason |
|-------------------|------|--------|
| Contenteditable inline editing | UI pattern | No prior `contenteditable` usage in codebase — use RESEARCH.md Pattern 2 with `isEditingRef` guard |
| HTML5 dropzone for attachments | UI pattern | No drag-drop patterns exist — use native HTML5 events (RESEARCH.md Pattern 8); prefer file picker for reliable path capture |

---

## Metadata

**Analog search scope:** `src/components/task/`, `src/views/`, `src/services/`, `src/store/`, `src/components/ui/`, `src/components/execution/activity/`, `src/utils/constants/`, `src-tauri/src/ipc/`
**Files scanned:** 14
**Pattern extraction date:** 2026-05-27

### Critical Pitfalls (must share with planner)

1. **contenteditable hydration:** Use `isEditingRef` ref in `useEffect` to block value overwrite while user types. `suppressContentEditableWarning={true}` is required.
2. **cancel_task must set status=Cancelled:** `archive_task` only sets `archived_at`. A new `cancel_task` IPC is required for the Interrupt → Cancel path (Wave 1 backend task).
3. **Execution button uses task.id not task.agent_id:** `navigate({ agentId: String(task.id) })` — AgentsView matches `String(session.task_id)`.
4. **base-ui Dialog onOpenChange:** `(_, open) => !open && onClose()` not `(open) => ...`.
5. **useUpdateTask missing labels/auto_approve/isolated_worktree:** Must extend Rust handler + service hook before sidebar editing of these fields works.
6. **File picker returns path strings without size:** `@tauri-apps/plugin-fs` is not in the project. For drag-drop use `file.size`; for file picker, pass `0` or add the plugin.
