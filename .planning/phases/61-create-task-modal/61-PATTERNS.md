# Phase 61: Create Task Modal - Pattern Map

**Mapped:** 2026-05-26
**Files analyzed:** 8 new/modified files
**Analogs found:** 8 / 8

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `src/components/kanban/CreateTaskModal.tsx` | component (modal) | request-response | `src/components/kanban/TaskModal.tsx` + `src/components/kanban/ImportTicketsModal.tsx` | exact |
| `src/views/KanbanView.tsx` | view | request-response | itself (modification) | self |
| `src/services/task.service.ts` | service | CRUD | itself (modification) | self |
| `src/contexts/KanbanContext.tsx` | context/provider | request-response | itself (modification) | self |
| `src/App.tsx` | config/wiring | request-response | itself (modification — remove dead code) | self |
| `src-tauri/src/models/task.rs` | model | CRUD | itself (modification) | self |
| `src-tauri/src/db/schema.rs` | migration/config | CRUD | itself (modification) | self |
| `src-tauri/src/ipc/task_handlers.rs` | controller (IPC) | CRUD | itself (modification) | self |

**Deleted files (no pattern output needed):**
- `src/components/kanban/TaskModal.tsx`
- `src/components/kanban/BacklogTaskSheet.tsx`
- `src/components/kanban/ImportTicketsModal.tsx`
- `src/components/kanban/__tests__/ImportTicketsModal.test.tsx`

---

## Pattern Assignments

### `src/components/kanban/CreateTaskModal.tsx` (component, request-response)

**Primary analog:** `src/components/kanban/TaskModal.tsx`
**Secondary analogs:** `src/components/kanban/ImportTicketsModal.tsx`, `src/components/common/SettingsPage.tsx`

**Imports pattern** — copy from `TaskModal.tsx` lines 1-12 and `ImportTicketsModal.tsx` lines 1-31:
```typescript
import { useState } from "react";
import { useForm, SubmitHandler, Controller } from "react-hook-form";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/ui/tabs";
import { Button, buttonVariants } from "@/ui/button";
import { Label } from "@/ui/label";
import { Input } from "@/ui/input";
import { Textarea } from "@/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/ui/select";
import { Switch } from "@/ui/switch";
import { Popover, PopoverTrigger, PopoverContent } from "@/ui/popover";
import { Command, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem } from "@/ui/command";
import { RefreshCw, ChevronDown, Check } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useCreateTaskMutation,
  useProjectBranchesQuery,
  useFetchRemoteIssuesQuery,
  taskQueryKeys,
} from "@/services/task.service";
import { useProjectIssueTrackingConfig } from "@/services/integration.service";
import { useAgentDiscoveryQuery } from "@/services/execution.service";
import { useProjectSettings } from "@/services/project.service";
import { cn } from "@/lib/ui-utils";
import type { Task } from "@/types/bindings";
```

**Dialog wrapper pattern** — copy from `TaskModal.tsx` lines 44-70:
```typescript
// Dialog open/close uses base-ui Dialog with onOpenChange
<Dialog open={isOpen} onOpenChange={onClose}>
  <DialogContent className="sm:max-w-[520px]">
    <DialogTitle>New Task</DialogTitle>
    <DialogDescription>...</DialogDescription>
    {/* content */}
  </DialogContent>
</Dialog>
```
Note: `DialogContent` already wraps `DialogPortal` + `DialogOverlay` internally (see `src/components/ui/dialog.tsx` lines 39-71). Do NOT add a second `<DialogPortal>` around it.

**Error display pattern** — copy from `TaskModal.tsx` lines 54-58 and `BacklogTaskSheet.tsx` lines 99-103:
```typescript
{error && (
  <div className="bg-destructive/10 border border-destructive/30 text-destructive px-4 py-3 rounded mb-4 text-sm">
    {error}
  </div>
)}
```

**Conditional tabs pattern** — from `ImportTicketsModal.tsx` (conditional rendering) combined with `tabs.tsx` primitives:
```typescript
// D-05: tabs only when provider is configured
const { data: issueConfig } = useProjectIssueTrackingConfig(projectId);
const hasProvider = issueConfig != null;

return hasProvider ? (
  <Tabs defaultValue="branch">
    <TabsList>
      <TabsTrigger value="branch">From Branch</TabsTrigger>
      <TabsTrigger value="issue">From Issue</TabsTrigger>
    </TabsList>
    <TabsContent value="branch"><FromBranchForm ... /></TabsContent>
    <TabsContent value="issue"><FromIssueTab ... /></TabsContent>
  </Tabs>
) : (
  <FromBranchForm ... />
);
```
Use `defaultValue` (uncontrolled) not `value` — per RESEARCH.md Pitfall 6 to avoid tab state persisting across open/close.

**react-hook-form setup** — copy from `TaskForm.tsx` lines 35-48:
```typescript
const {
  register,
  handleSubmit,
  control,
  setValue,
  resetField,
  formState: { errors },
} = useForm<FormData>({
  mode: "onBlur",
  defaultValues: {
    title: "",
    description: "",
    priority: "Medium",
    baseBranch: "",
    agentId: "",
    isolatedWorktree: true,
    autoApprove: false,
  },
});
```

**Branch auto-default useEffect** — copy from `TaskForm.tsx` lines 57-61 exactly:
```typescript
// Set default origin branch to the current checked-out branch when
// branch data loads and form has no initial value
useEffect(() => {
  if (currentBranch && !initialValues?.baseBranch) {
    setValue("baseBranch", currentBranch);
  }
}, [currentBranch, initialValues?.baseBranch, setValue]);
```

**Agent selector pre-fill** — from `SettingsPage.tsx` lines 47-49, 64-68:
```typescript
// D-02: use useProjectSettings to get default_agent (NOT useSelectedProject)
const { data: projectSettings } = useProjectSettings(projectId);

// On modal open, read default_agent from settings query
useEffect(() => {
  if (projectSettings?.default_agent) {
    setValue("agentId", projectSettings.default_agent);
  }
}, [projectSettings?.default_agent, setValue]);
```

**Priority Select with Controller** — copy from `TaskForm.tsx` lines 131-148:
```typescript
<Controller
  name="priority"
  control={control}
  render={({ field: { value, onChange } }) => (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger id="priority" className="w-full">
        <SelectValue placeholder="Select priority..." />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="Urgent">Urgent</SelectItem>
        <SelectItem value="High">High</SelectItem>
        <SelectItem value="Medium">Medium</SelectItem>
        <SelectItem value="Low">Low</SelectItem>
        <SelectItem value="None">None</SelectItem>
      </SelectContent>
    </Select>
  )}
/>
```

**Agent Select with Controller** — copy from `SettingsPage.tsx` lines 173-214:
```typescript
<Controller
  name="agentId"
  control={control}
  render={({ field }) => (
    <Select value={field.value} onValueChange={field.onChange} disabled={agentsLoading}>
      <SelectTrigger className="w-full">
        <SelectValue placeholder={agentsLoading ? "Loading agents…" : "None (no agent)"}>
          {field.value === ""
            ? "None (no agent)"
            : (agents.find((a) => a.id === field.value)?.name ?? field.value)}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="">None (no agent)</SelectItem>
        {agents.map((agent) => (
          <SelectItem key={agent.id} value={agent.id}>
            {agent.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )}
/>
```
Agents come from: `const { data: discovery } = useAgentDiscoveryQuery(connectionId, wslConnectionId ?? null)` → `const agents = discovery?.agents ?? []`

**Branch combobox with Popover + Command** — from RESEARCH.md Pattern 1 (verified against `src/components/ui/command.tsx` and `src/components/ui/popover.tsx`):
```typescript
// D-12: Popover + Command for branch selector (no free-text input per D-14)
// D-13: refresh button calls queryClient.invalidateQueries
const queryClient = useQueryClient();
const { data: branchData, isFetching } = useProjectBranchesQuery(projectId);
const branches: string[] = branchData?.[0] ?? [];
const currentBranch: string = branchData?.[1] ?? "";
// Query key for invalidation (from task.service.ts line 331):
// [...taskQueryKeys.base, "branches", projectId]

<Controller
  name="baseBranch"
  control={control}
  rules={{ required: "Base branch is required" }}
  render={({ field: { value, onChange } }) => (
    <Popover>
      <div className="flex items-center gap-1">
        <PopoverTrigger className={buttonVariants({ variant: "outline", size: "sm" })}>
          {value || "Select branch..."}
          <ChevronDown className="ml-auto size-3.5 opacity-50" />
        </PopoverTrigger>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={() => void queryClient.invalidateQueries({ queryKey: [...taskQueryKeys.base, "branches", projectId] })}
          disabled={isFetching}
        >
          <RefreshCw className={cn("size-3.5", isFetching && "animate-spin")} />
        </Button>
      </div>
      <PopoverContent className="w-64 p-0">
        <Command>
          <CommandInput placeholder="Search branches..." />
          <CommandList>
            <CommandEmpty>No branches found.</CommandEmpty>
            <CommandGroup>
              {branches.map((branch) => (
                <CommandItem
                  key={branch}
                  value={branch}
                  data-checked={value === branch}
                  onSelect={() => { onChange(branch); }}
                >
                  {branch}
                  <Check className="ml-auto size-3.5 opacity-0 data-[checked=true]:opacity-100" />
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )}
/>
```
Note: `PopoverTrigger` from base-ui has no `asChild` prop — use `className={buttonVariants(...)}` directly (verified from `KanbanView.tsx` lines 60-63, same pattern).

**Switch toggle with Controller** — from `src/components/ui/switch.tsx` (lines 7-30) with Controller wrapper:
```typescript
// Switch has size="sm" variant (data-size="sm" = h-[14px] w-[24px])
<Controller
  name="isolatedWorktree"
  control={control}
  render={({ field: { value, onChange } }) => (
    <div className="flex items-center justify-between">
      <Label htmlFor="isolatedWorktree" className="text-xs text-muted-foreground">
        Isolated worktree
      </Label>
      <Switch
        id="isolatedWorktree"
        checked={value}
        onCheckedChange={onChange}
        size="sm"
      />
    </div>
  )}
/>
```

**Issue combobox (From Issue tab)** — from `ImportTicketsModal.tsx` lines 166, 373-384 for data fetching; Popover+Command pattern same as branch combobox above:
```typescript
// D-09: Fetch only when From Issue tab is active + modal open
const { data: remoteIssues, isLoading: isRemoteLoading } = useFetchRemoteIssuesQuery(
  projectId,
  isOpen && activeTab === "issue",  // enabled gate per RESEARCH.md anti-pattern note
);

// D-10: selecting issue pre-fills title + description only
const handleIssueSelect = (issue: RemoteIssue) => {
  setValue("title", issue.title);
  setValue("description", issue.description ?? "");
};
```

**Mutation + submit + "Create another" pattern** — from `BacklogTaskSheet.tsx` lines 38-54 (error handling) + RESEARCH.md Pattern "Create another":
```typescript
const { mutate: createTask, isPending } = useCreateTaskMutation();

const onSubmit: SubmitHandler<FormData> = (data) => {
  setError(null);
  createTask(
    {
      project_id: projectId,
      title: data.title,
      description: data.description,
      skills: [],
      base_branch: data.baseBranch,
      agent_id: data.agentId || null,
      priority: data.priority,
      auto_approve: data.autoApprove,
      isolated_worktree: data.isolatedWorktree,
    },
    {
      onSuccess: () => {
        if (createAnother) {
          // D-16: reset title + description only; other fields persist
          resetField("title");
          resetField("description");
        } else {
          onClose();
        }
      },
      onError: (err) => {
        setError(err instanceof Error ? err.message : "Failed to create task");
      },
    },
  );
};
```

---

### `src/views/KanbanView.tsx` (view, request-response — modification)

**Analog:** `src/views/KanbanView.tsx` lines 1-138 (self, adding to existing file)

**Addition pattern** — "+ New Task" button in action bar:

Current action bar (lines 49-132) ends with label filter popover. Add to the right side of the flex bar (uses `ml-auto` to push to right):
```typescript
// Add to imports at top of KanbanView.tsx:
import { Plus } from "lucide-react";
import { Button } from "@/ui/button";
import { CreateTaskModal } from "@/components/kanban/CreateTaskModal";

// Add to component state:
const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);

// Add button in action bar div (line 49), after label filter Popover:
<div className="ml-auto">
  <Button
    size="sm"
    onClick={() => setIsCreateModalOpen(true)}
  >
    <Plus className="size-4" />
    New Task
  </Button>
</div>

// Add modal after the action bar div, before <BoardView>:
<CreateTaskModal
  isOpen={isCreateModalOpen}
  onClose={() => setIsCreateModalOpen(false)}
  projectId={projectId ?? 0}
/>
```
Note: The action bar div at line 49 is `className="h-12 border-b border-border bg-muted/30 flex items-center px-4 gap-2 shrink-0"` — this is the correct flex container. `ml-auto` on the button wrapper pushes it to the right (verified from the existing left-aligned filter pattern).

---

### `src/services/task.service.ts` (service, CRUD — modification)

**Analog:** `src/services/task.service.ts` lines 76-93 (self, modifying `useCreateTaskMutation`)

**Current `useCreateTaskMutation`** (lines 76-93) calls:
```typescript
api.createTask(
  request.project_id,
  request.title,
  request.description,
  request.skills,
  request.base_branch,
)
```

**Updated signature** — after Rust handler is extended:
```typescript
export function useCreateTaskMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (request: {
      project_id: number;
      title: string;
      description: string;
      skills: string[];
      base_branch: string;
      agent_id: string | null;
      priority: string;
      auto_approve: boolean;
      isolated_worktree: boolean;
    }) =>
      api.createTask(
        request.project_id,
        request.title,
        request.description,
        request.skills,
        request.base_branch,
        request.agent_id,
        request.priority,
        request.auto_approve,
        request.isolated_worktree,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: taskQueryKeys.lists() });
    },
    onError: createErrorToastHandler("Failed to create task"),
  });
}
```
The `api.*` call args mirror the Rust `#[tauri::command]` parameter order exactly (tauri-specta generates typed wrappers).

---

### `src/contexts/KanbanContext.tsx` (context, request-response — modification)

**Analog:** `src/contexts/KanbanContext.tsx` lines 1-41 (self, removing `onAddTask`)

Remove `onAddTask` from `KanbanContextValue` interface (line 8), `KanbanProviderProps` (line 17-18), `KanbanProvider` destructure (line 22), and the `KanbanContext.Provider value` (line 29).

The entire `onAddTask` prop was only used by `App.tsx` to open `TaskModal`. Once `TaskModal` is deleted and `CreateTaskModal` lives inside `KanbanView`, no caller needs this prop.

---

### `src/App.tsx` (config/wiring — modification)

**Analog:** `src/App.tsx` (self, removing dead code)

Lines to remove (verified by Grep):
- Line 44-46: `const TaskModal = lazy(...)` import
- Line 49: `const [showNewTaskModal, setShowNewTaskModal] = useState(false)` state
- Line 216: `onAddTask={() => setShowNewTaskModal(true)}` prop on `<KanbanProvider>`
- Lines 272-276: `<TaskModal isOpen={showNewTaskModal} onClose={...} projectId={...} />` render

---

### `src-tauri/src/models/task.rs` (model, CRUD — modification)

**Analog:** `src-tauri/src/models/task.rs` lines 1-157 (self, adding `agent_id` field)

**TASK_SELECT comment update** (lines 6-11) — add `agent_id` column index 22:
```rust
/// Column order: id(0), project_id(1), title(2), description(3), status(4), priority(5),
/// base_branch(6), archived_at(7), external_id(8), is_imported(9), import_source(10),
/// skills(11), model_override(12), mcp_allowlist(13), skills_override(14), labels(15),
/// external_url(16), external_updated_at(17), created_at(18), updated_at(19),
/// auto_approve(20), isolated_worktree(21), agent_id(22)
```

**TASK_SELECT constant** (lines 12-17) — add `agent_id` at end:
```rust
pub const TASK_SELECT: &str =
    "SELECT id, project_id, title, description, status, priority, \
     base_branch, archived_at, external_id, is_imported, import_source, skills, \
     model_override, mcp_allowlist, skills_override, labels, \
     external_url, external_updated_at, created_at, updated_at, \
     auto_approve, isolated_worktree, agent_id FROM tasks";
```

**Task struct** (after `isolated_worktree` field at line 52) — add:
```rust
#[specta(optional)]
pub agent_id: Option<String>,
```
Pattern for `#[specta(optional)]` with `Option<String>` is established at lines 29-30, 31-32, etc.

**Task::from_row** (line 154) — add after `isolated_worktree`:
```rust
agent_id: row.get(22)?,
```
Pattern: `row.get(N)?` for nullable text column → `Option<String>` (established at lines 132-141 for multiple optional string fields).

---

### `src-tauri/src/db/schema.rs` (migration/config — modification)

**Analog:** `src-tauri/src/db/schema.rs` lines 1-100 (self, bumping version + adding column)

**Version bump** (line 3):
```rust
pub const SCHEMA_VERSION: u32 = 19;
```

**Schema constant rename** — rename `SCHEMA_V18` to `SCHEMA_V19` and add `agent_id TEXT` column to tasks table after `isolated_worktree` (currently line 51):
```sql
-- In SCHEMA_V19 tasks table definition (after isolated_worktree column):
    isolated_worktree INTEGER NOT NULL DEFAULT 1,
    agent_id TEXT,
```
`agent_id` is nullable (no `NOT NULL`), consistent with the optional pattern for `import_source`, `model_override`, `archived_at`, etc.

**Test assertion** (line 267 of schema.rs):
```rust
// Change from:
assert_eq!(version, 18);
// To:
assert_eq!(version, 19);
```

---

### `src-tauri/src/ipc/task_handlers.rs` (controller/IPC, CRUD — modification)

**Analog:** `src-tauri/src/ipc/task_handlers.rs` lines 28-77 (self, extending `create_task_impl` and `create_task`)

**`create_task_impl` signature** (line 28-35) — add new params after `base_branch`:
```rust
fn create_task_impl(
    conn: &rusqlite::Connection,
    project_id: i32,
    title: String,
    description: String,
    skills: Vec<String>,
    base_branch: String,
    agent_id: Option<String>,
    priority: Option<String>,
    auto_approve: bool,
    isolated_worktree: bool,
) -> Result<Task, String> {
```

**INSERT statement** (line 49-53) — extend to include all user-supplied fields:
```rust
conn.execute(
    "INSERT INTO tasks (project_id, title, description, skills, status, base_branch, \
     agent_id, priority, auto_approve, isolated_worktree, created_at, updated_at) \
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    rusqlite::params![
        project_id, &title, &description, &skills_json,
        "Backlog", &base_branch,
        &agent_id,
        priority.as_deref().unwrap_or("Medium"),
        auto_approve,
        isolated_worktree,
        &now, &now
    ],
)
```
Pattern for `rusqlite::params![]` with `Option<String>` is established in `update_task_settings` (line 178-179); nullable params serialize as NULL automatically.

**`create_task` command signature** (lines 62-77) — add params and pass through:
```rust
#[tauri::command]
#[specta::specta]
pub fn create_task(
    app_state: State<Arc<AppState>>,
    project_id: i32,
    title: String,
    description: String,
    skills: Vec<String>,
    base_branch: String,
    agent_id: Option<String>,
    priority: Option<String>,
    auto_approve: bool,
    isolated_worktree: bool,
) -> Result<Task, String> {
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
    let task = create_task_impl(
        &conn, project_id, title, description, skills, base_branch,
        agent_id, priority, auto_approve, isolated_worktree,
    )?;
    app_state.app_handle.emit("tasks-changed", ()).ok();
    Ok(task)
}
```

**`update_task` command** (lines 82-150) — add `agent_id: Option<String>` to signature and dynamic SET clause block following the existing pattern (lines 102-127):
```rust
if let Some(ref v) = agent_id {
    set_parts.push("agent_id = ?".to_string());
    params.push(Box::new(v.clone()));
}
```

---

## Shared Patterns

### Dialog Modal Wrapper
**Source:** `src/components/kanban/TaskModal.tsx` lines 44-70, `src/components/ui/dialog.tsx` lines 39-71
**Apply to:** `CreateTaskModal.tsx`
```typescript
// DialogContent already includes DialogPortal + DialogOverlay internally.
// Only need: <Dialog open={...} onOpenChange={...}><DialogContent>...</DialogContent></Dialog>
// Do NOT add <DialogPortal> manually — it would double-wrap.
<Dialog open={isOpen} onOpenChange={onClose}>
  <DialogContent className="sm:max-w-[520px]">
    <DialogTitle>New Task</DialogTitle>
    {/* content */}
  </DialogContent>
</Dialog>
```

### Error Display
**Source:** `src/components/kanban/TaskModal.tsx` lines 54-58 and `src/components/kanban/BacklogTaskSheet.tsx` lines 99-103
**Apply to:** `CreateTaskModal.tsx` (inline form error, above form fields)
```typescript
{error && (
  <div className="bg-destructive/10 border border-destructive/30 text-destructive px-4 py-3 rounded mb-4 text-sm">
    {error}
  </div>
)}
```

### buttonVariants() on PopoverTrigger (base-ui has no asChild)
**Source:** `src/views/KanbanView.tsx` lines 60-63 and 96-99
**Apply to:** `CreateTaskModal.tsx` branch combobox trigger, issue combobox trigger
```typescript
// base-ui PopoverTrigger has no asChild prop.
// Apply button styles via className={buttonVariants({...})} directly.
<PopoverTrigger className={buttonVariants({ variant: "outline", size: "sm" })}>
  ...
</PopoverTrigger>
```

### IPC Error Propagation (Rust)
**Source:** `src-tauri/src/ipc/task_handlers.rs` lines 14-23 (get_tasks pattern)
**Apply to:** `task_handlers.rs` create_task and update_task modifications
```rust
// All IPC handlers follow: lock → operate → propagate with ?
let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
// Return type: Result<T, String>
```

### #[specta(optional)] for Option fields (Rust)
**Source:** `src-tauri/src/models/task.rs` lines 29-32 (archived_at, external_id)
**Apply to:** `agent_id` field in Task struct
```rust
#[specta(optional)]
pub agent_id: Option<String>,
```

### Compact design system tokens
**Source:** `src/components/kanban/ImportTicketsModal.tsx`, `src/components/kanban/BacklogTaskSheet.tsx`
**Apply to:** All form elements in `CreateTaskModal.tsx`
- Labels: `text-xs text-muted-foreground`
- Compact row layout: `flex items-center justify-between`
- Section gaps: `flex flex-col gap-3` or `gap-4`
- Form groups: `flex flex-col gap-1.5` or `gap-2`
- Full-width inputs in modal: `w-full`

---

## No Analog Found

All files have close analogs in the codebase. No new frameworks or patterns are needed.

---

## Metadata

**Analog search scope:** `src/components/kanban/`, `src/components/task/`, `src/components/common/`, `src/views/`, `src/services/`, `src/contexts/`, `src/components/ui/`, `src-tauri/src/models/`, `src-tauri/src/db/`, `src-tauri/src/ipc/`
**Files scanned:** 14 source files read
**Pattern extraction date:** 2026-05-26
