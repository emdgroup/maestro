# Phase 61: Create Task Modal - Research

**Researched:** 2026-05-26
**Domain:** React modal UI, Rust model extension, SQLite schema migration
**Confidence:** HIGH

## Summary

Phase 61 replaces three legacy creation components (`TaskModal`, `BacklogTaskSheet`, `ImportTicketsModal`) with a single `CreateTaskModal`. The work divides into two halves: a Rust/backend half (add `agent_id` to the `Task` model, bump schema to V19, extend `create_task` and `update_task` IPC handlers) and a frontend half (build the modal with its two tabs, branch combobox, agent selector, and "Create another" toggle, then wire it into `KanbanView`).

The codebase already has all necessary UI primitives: `Dialog`, `Tabs`, `Select`, `Switch`, `Popover`, `Command`, and the `react-hook-form + Controller` pattern established in `TaskForm.tsx`. Every required service hook (`useCreateTaskMutation`, `useProjectBranchesQuery`, `useFetchRemoteIssuesQuery`, `useProjectIssueTrackingConfig`, `useAgentDiscoveryQuery`) is already in the services layer and just needs to be consumed. There is no framework research needed — this phase is entirely assembly and integration work.

One complexity worth planning around: `TaskModal` is currently lazy-loaded and wired through `App.tsx` + `KanbanContext.onAddTask`. The new button and modal state must move inside `KanbanView` per D-06; the `App.tsx` lazy load of `TaskModal` and the `onAddTask` prop on `KanbanProvider` should be removed. The `ImportTicketsModal` test file tests only the pure `classifyIssues` helper — that helper is deleted with the file, so the test file is cleanly removed.

**Primary recommendation:** Build `CreateTaskModal` as a self-contained component that owns its own modal state only; trigger it via a "+ New Task" button added to `KanbanView`'s action bar. Do not route state through `App.tsx` or `KanbanContext`.

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Agent Field (new Task property)**
- D-01: `agent_id: Option<String>` added to Task model. Schema bump V18 → V19 (destructive). Bindings regenerated via `pnpm tauri:gen`. Conceptually the "assignee" field.
- D-02: Default = `project.default_agent`. When modal opens, agent selector pre-fills with the project's configured default agent. User can override per-task.
- D-03: UI = `<Select>` dropdown. Same pattern as Priority. Lists discovered agents by display name via `useAgentDiscoveryQuery(connectionId, wslConnectionId)`.
- D-04: Optional on create/edit. `agent_id` is not required to save a task.

**Modal Structure**
- D-05: Tabs conditional on provider. When `useProjectIssueTrackingConfig` returns null/unconfigured → tabs UI hidden entirely, modal renders "From Branch" form directly. When provider is configured → both tabs shown.
- D-06: "+ New Task" trigger in KanbanView action bar. Right side of the action bar.

**"From Branch" Tab**
- D-07: Fields: title (required), description, base branch (combobox, required), priority (Select), agent (Select, optional), isolated worktree toggle (default on), auto-approve toggle (default off).
- D-08: Form library: `react-hook-form` + `Controller` — same as existing `TaskForm`.

**"From Issue" Tab**
- D-09: Issue picker = combobox (Popover + Command pattern). Searchable dropdown. Select one issue → pre-fills title + description in the form below.
- D-10: Full form fields appear after selection. Same fields as "From Branch" (branch, priority, agent, toggles) appear below the combobox. Issue pre-fills title + description only.
- D-11: Available/Imported/Changed tracking dropped. Simple fetch + pick.

**Branch Selector**
- D-12: Combobox (Popover + Command pattern). Type to filter. `useProjectBranchesQuery(projectId)` returns `[branches: string[], currentBranch]` — auto-selects current branch as default.
- D-13: Explicit refresh button. Small icon button next to combobox trigger. Calls `queryClient.invalidateQueries` on the branches query key. Shows loading state during refetch.
- D-14: List only. No free-text input — must select from existing branches.

**"Create Another" Toggle**
- D-15: Off by default.
- D-16: On submit with toggle on: reset title + description only. Branch, priority, agent, isolated worktree, auto-approve persist.

**Legacy Component Deletion**
- D-17: Three files deleted: `src/components/kanban/TaskModal.tsx`, `src/components/kanban/BacklogTaskSheet.tsx`, `src/components/kanban/ImportTicketsModal.tsx` (and its test file `__tests__/ImportTicketsModal.test.tsx`).

### Claude's Discretion

*(none specified — all decisions are locked)*

### Deferred Ideas (OUT OF SCOPE)

- Backlog→Ready gate for agent_id — belongs in Phase 62 (Task Detail Screen action bar)
- Available/Imported/Changed change detection — IMPT-01 through IMPT-06 and CHNG-01 through CHNG-02 dropped/superseded
</user_constraints>

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| CREATE-01 | User can create task via "From Branch" tab (title, description, branch, priority, agent, isolated worktree, auto-approve) | All fields map to existing IPC params + new `agent_id`. `react-hook-form` Controller pattern verified in `TaskForm.tsx`. |
| CREATE-02 | User can create task via "From Issue" tab when provider configured — selecting issue pre-fills title and description | `useFetchRemoteIssuesQuery` already exists; `useProjectIssueTrackingConfig` null-check controls tab visibility per D-05. |
| CREATE-03 | Branch selector shows local/remote branches with search and refresh | `useProjectBranchesQuery` returns `[string[], string]`. Popover + Command pattern available in `command.tsx`. Refresh via `queryClient.invalidateQueries`. |
| CREATE-04 | "Create another" toggle keeps modal open after creation | Implemented via local `useState` boolean; on success with toggle on, reset title/description (D-16) and skip `onClose`. |
</phase_requirements>

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| `agent_id` model + migration | Rust backend | — | New column on `tasks` table; must be in Task struct for ts-rs binding generation |
| `create_task` IPC extension | Rust backend | — | Handler signature must accept `agent_id: Option<String>` |
| `update_task` IPC extension | Rust backend | — | Handler signature must accept `agent_id: Option<String>` |
| Bindings regeneration | Build tooling | — | `pnpm tauri:gen` produces updated `src/types/bindings.ts` |
| CreateTaskModal component | Frontend (React) | — | All modal state, form logic, and conditional rendering lives here |
| "+ New Task" button | Frontend (KanbanView) | — | `KanbanView.tsx` owns the open/close boolean and renders the modal |
| Agent selector pre-fill | Frontend (React) | — | On modal open, read `project.default_agent` from `useSelectedProject()` |
| Branch combobox + refresh | Frontend (React) | — | `useProjectBranchesQuery` + `queryClient.invalidateQueries` |
| Issue combobox (From Issue tab) | Frontend (React) | — | `useFetchRemoteIssuesQuery` with `enabled` gated on modal open |

---

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| react-hook-form | existing in project | Form state + validation | Established pattern in `TaskForm.tsx`; Controller wraps non-native inputs |
| @tanstack/react-query | existing in project | Data fetching + cache invalidation | All IPC calls go through TanStack Query; `queryClient.invalidateQueries` for refresh |
| cmdk | existing in project | Command/combobox list | Already wrapped in `src/components/ui/command.tsx`; used for Popover + Command pattern |
| @base-ui/react | existing in project | Dialog, Tabs, Switch, Popover | All UI primitives used in this phase are from base-ui |
| lucide-react | existing in project | Icons (RefreshCw, Check, ChevronDown) | Consistent icon library across the app |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| rusqlite | existing in Cargo.toml | SQLite access | Schema V19 migration and new column INSERT |
| specta + ts-rs | existing in Cargo.toml | TypeScript binding generation | `#[specta(optional)]` decorator on new `agent_id` field |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Popover + Command (branch combobox) | Select dropdown | Select is used for Priority/Agent (short lists). Command gives fuzzy search + keyboard nav — needed for long branch lists per D-12 |
| base-ui Tabs | Custom animated tab toggle (like ImportTicketsModal used) | base-ui Tabs are already standardized; ImportTicketsModal's animated tab is being deleted |

**No new npm packages required.** All dependencies are already installed. [VERIFIED: codebase grep]

---

## Architecture Patterns

### System Architecture Diagram

```
KanbanView
  ├── Action Bar (h-12 border-b)
  │     ├── Search input (left)
  │     ├── Priority filter popover (left)
  │     ├── Label filter popover (left)
  │     └── "+ New Task" button (right) ── sets isModalOpen=true
  │
  └── <CreateTaskModal open={isModalOpen} onClose={...} projectId={...}>
        │
        ├── [No provider] → FromBranchForm directly (no Tabs)
        │
        └── [Provider configured] → Tabs
              ├── "From Branch" tab → <FromBranchForm>
              └── "From Issue" tab  → <IssueCombobox> + <FromBranchForm> (pre-filled)
```

```
FromBranchForm (react-hook-form)
  title (Input, required)
  description (Textarea, optional)
  ─── row ────────────────────────────────────────
  BaseBranchCombobox (Popover + Command)
    ├── PopoverTrigger (buttonVariants — base-ui has no asChild)
    ├── RefreshCw icon button → queryClient.invalidateQueries(branchQueryKey)
    └── PopoverContent → Command → CommandInput + CommandList
          ├── Local sub-tab
          └── Remote sub-tab   [implementation detail — see CREATE-03]
  Priority (Select)
  ─── row ────────────────────────────────────────
  Agent (Select, optional) — useAgentDiscoveryQuery
  ─── toggles ────────────────────────────────────
  Isolated Worktree Switch (default on)
  Auto-Approve Switch (default off)
  ─── footer ─────────────────────────────────────
  "Create another" Checkbox + Submit + Cancel
```

```
Rust: create_task IPC (task_handlers.rs)
  add agent_id: Option<String> parameter
  INSERT … agent_id = ?  (NULL-able column in V19 schema)
  ↓
  Task::from_row — add agent_id field at column index 22
  ↓
  pnpm tauri:gen → bindings.ts Task type updated
```

### Recommended Project Structure
```
src/components/kanban/
├── CreateTaskModal.tsx    # NEW — the single replacement component
│                          # (TaskModal.tsx, BacklogTaskSheet.tsx, ImportTicketsModal.tsx DELETED)
└── __tests__/
    └── ImportTicketsModal.test.tsx   # DELETED with parent

src-tauri/src/
├── models/task.rs         # Add agent_id field + update TASK_SELECT
├── db/schema.rs           # Bump SCHEMA_VERSION to 19, add agent_id column
└── ipc/task_handlers.rs   # Extend create_task + update_task signatures
```

### Pattern 1: Popover + Command Combobox (branch selector)
**What:** Popover trigger shows selected value; inside PopoverContent, a Command wraps a text search input and a scrollable list. Selected item shows a checkmark.
**When to use:** Any list > ~6 items that benefits from search (branches, issues).
**Example:**
```typescript
// Source: verified from src/components/ui/command.tsx + src/components/ui/popover.tsx
// Established in codebase; see also KanbanView.tsx for buttonVariants() on PopoverTrigger

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
      onClick={() => void queryClient.invalidateQueries({ queryKey: branchQueryKey })}
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
              onSelect={() => { onChange(branch); setOpen(false); }}
            >
              {branch}
              <CheckIcon className="ml-auto size-3.5 opacity-0 data-[checked=true]:opacity-100" />
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </Command>
  </PopoverContent>
</Popover>
```

### Pattern 2: react-hook-form Controller for custom inputs
**What:** `Controller` from `react-hook-form` wraps non-native inputs (Select, Switch, custom combobox) to integrate them with form state.
**When to use:** Any input that isn't a plain `<input>` or `<textarea>` and needs to participate in form validation and `reset()`.
```typescript
// Source: verified from src/components/task/TaskForm.tsx lines 131-148
<Controller
  name="priority"
  control={control}
  render={({ field: { value, onChange } }) => (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger><SelectValue /></SelectTrigger>
      <SelectContent>
        <SelectItem value="High">High</SelectItem>
      </SelectContent>
    </Select>
  )}
/>
```

### Pattern 3: base-ui Switch (toggle)
**What:** `Switch` from `@base-ui/react/switch` wraps boolean state. Has `size="sm"` variant.
**When to use:** Isolated worktree and auto-approve toggles.
```typescript
// Source: verified from src/components/ui/switch.tsx
// When used with react-hook-form, use Controller:
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

### Pattern 4: Conditional tabs (D-05)
**What:** Check `useProjectIssueTrackingConfig` result before rendering Tabs. If config is null, render `FromBranchForm` directly without a `TabsList`.
```typescript
// Source: [ASSUMED] — pattern inferred from D-05 decision
const { data: issueConfig } = useProjectIssueTrackingConfig(projectId);
const hasProvider = issueConfig != null;

return (
  <Dialog open={open} onOpenChange={onClose}>
    <DialogContent className="sm:max-w-[520px]">
      <DialogTitle>New Task</DialogTitle>
      {hasProvider ? (
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
      )}
    </DialogContent>
  </Dialog>
);
```

### Pattern 5: Schema V19 — adding agent_id
**What:** Destructive migration: bump constant, add column to CREATE TABLE statement, add column to TASK_SELECT, add field to Task struct.
**When to use:** Per project convention — no additive migrations in v1.7.
```rust
// Source: [VERIFIED: src-tauri/src/db/schema.rs + src-tauri/src/models/task.rs]
// In schema.rs:
pub const SCHEMA_VERSION: u32 = 19;
// In SCHEMA_V19 tasks table:
//   agent_id TEXT,   -- add after isolated_worktree column

// In models/task.rs — TASK_SELECT:
pub const TASK_SELECT: &str =
    "SELECT id, project_id, title, description, status, priority, \
     base_branch, archived_at, external_id, is_imported, import_source, skills, \
     model_override, mcp_allowlist, skills_override, labels, \
     external_url, external_updated_at, created_at, updated_at, \
     auto_approve, isolated_worktree, agent_id FROM tasks";

// In Task struct (models/task.rs):
#[specta(optional)]
pub agent_id: Option<String>,  // column index 22

// In Task::from_row:
agent_id: row.get(22)?,
```

### Anti-Patterns to Avoid
- **Routing modal state through App.tsx:** The current `TaskModal` is lazy-loaded in `App.tsx` and opened via `KanbanContext.onAddTask`. The new modal must be self-contained in `KanbanView` — do not continue the `App.tsx` pattern for `CreateTaskModal`.
- **Using `asChild` on base-ui PopoverTrigger:** base-ui's `Popover.Trigger` has no `asChild` prop. Use `buttonVariants()` directly on `PopoverTrigger` (established in Phase 59 Plan 02). [VERIFIED: src/contexts/ + KanbanView.tsx]
- **Free-text branch input:** D-14 locks this to list-only. Do not add a fallback text input for "new branch name" — that is a separate feature.
- **Fetching remote issues on modal open without the `enabled` gate:** `useFetchRemoteIssuesQuery` accepts `isModalOpen: boolean`. The From Issue tab should only trigger the fetch when the tab is active (or when the modal is open with the issue tab selected). Pass `enabled={activeTab === "issue" && isOpen}`.
- **Forgetting to update the `test_schema_initialization` unit test:** `schema.rs` has a test that asserts `SCHEMA_VERSION = 18` — this must be updated to 19. [VERIFIED: src-tauri/src/db/schema.rs line 267]

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Searchable branch list | Custom filtered `<ul>` | `Command` + `CommandInput` + `CommandList` | Built-in keyboard nav, accessibility, empty state, fuzzy filtering |
| Modal accessibility | Raw `<div>` with portal | `Dialog` from base-ui | Focus trap, Escape key, aria-modal, backdrop click close |
| Form state + validation | Manual `useState` per field | `react-hook-form` + `Controller` | Established pattern; handles reset(), validation, isDirty — critical for "Create another" reset |
| Toggle boolean fields | `<button>` with click handler | `Switch` from base-ui | Correct ARIA role, keyboard support, visual feedback |
| Branch list with sub-tabs (Local/Remote) | Separate `useState` + filter logic | `CommandGroup` with heading labels | Groups cleanly separate Local/Remote without extra state |

**Key insight:** Every UI primitive needed here is already in `src/components/ui/`. Building custom replacements would duplicate working, accessible components.

---

## Runtime State Inventory

Phase 61 is not a rename/refactor/migration phase. This section is omitted.

---

## Common Pitfalls

### Pitfall 1: App.tsx cleanup incomplete
**What goes wrong:** `CreateTaskModal` is built and works, but `TaskModal` lazy import and `setShowNewTaskModal` state remain in `App.tsx`, and `KanbanContext.onAddTask` still calls `setShowNewTaskModal`. The new button in `KanbanView` opens a second modal correctly, but the old pathway persists as dead code that TypeScript won't catch.
**Why it happens:** The task to remove legacy wiring in `App.tsx` is easy to forget when focused on building the new component.
**How to avoid:** Plan deletion of `App.tsx` lazy import (`const TaskModal = lazy(...)`) and `showNewTaskModal` state explicitly as a task step. Also remove `onAddTask` from `KanbanContext` and `KanbanProvider` if it has no other callers.
**Warning signs:** `showNewTaskModal` state still exists in `App.tsx` after the plan executes.

### Pitfall 2: schema test assertion not updated
**What goes wrong:** `cargo test` passes during development but the schema test at `schema.rs:267` asserts `assert_eq!(version, 18)` — once SCHEMA_VERSION becomes 19, this assertion fails.
**Why it happens:** The test hardcodes the expected version number.
**How to avoid:** Update `assert_eq!(version, 18)` to `assert_eq!(version, 19)` as part of the schema task.
**Warning signs:** `cargo test` output shows `test_schema_initialization` failed.

### Pitfall 3: create_task IPC signature not updated to accept agent_id
**What goes wrong:** `agent_id` is saved to Task struct and shown in the modal, but the frontend form passes `agent_id` in the mutation request and the Rust handler ignores it (old signature). Task is created without the agent_id set.
**Why it happens:** The IPC handler `create_task` currently accepts `project_id, title, description, skills, base_branch` — `agent_id` is not in the signature.
**How to avoid:** Update `create_task` function signature in `task_handlers.rs` and the corresponding INSERT statement. Also update the `useCreateTaskMutation` in `task.service.ts` to pass `agent_id`.
**Warning signs:** Created tasks always have `agent_id = null` even when set in the form.

### Pitfall 4: ImportTicketsModal test file references classifyIssues from the deleted file
**What goes wrong:** After deleting `ImportTicketsModal.tsx`, the test file `__tests__/ImportTicketsModal.test.tsx` tries to import `classifyIssues` from the now-deleted module, causing `pnpm test` to fail with a module-not-found error.
**Why it happens:** The test imports directly from the deleted component file.
**How to avoid:** Delete the test file as part of D-17 (the CONTEXT.md explicitly includes it).
**Warning signs:** `pnpm test` output shows `Cannot find module '@/components/kanban/ImportTicketsModal'`.

### Pitfall 5: Agent selector pre-fill — useProjectSettings vs useSelectedProject
**What goes wrong:** D-02 requires pre-filling the agent selector with `project.default_agent`. The `useSelectedProject()` store returns the `Project` type from `src/types/bindings.ts`. But `Project` may not have `default_agent` — that field comes from `ProjectConfigResponse` returned by `useProjectSettings`. Using the wrong data source leaves the agent selector always empty on open.
**Why it happens:** Two data sources: the store's `Project` object and the project settings query.
**How to avoid:** Use `useProjectSettings(projectId)` (from `project.service.ts`) to get `default_agent`, not `useSelectedProject()`. The `SettingsPage.tsx` pattern at lines 47-68 shows the correct approach: `projectSettingsQuery.data?.default_agent`.
**Warning signs:** Agent select is always empty when modal opens despite a default agent being configured.

### Pitfall 6: base-ui Tabs `value` prop vs `defaultValue`
**What goes wrong:** If the From Issue tab is the active tab and the user closes then re-opens the modal, it re-opens on "From Issue" instead of "From Branch" — because `value` was persisted in state.
**Why it happens:** Using controlled `value` state that isn't reset when the modal closes.
**How to avoid:** Use `defaultValue="branch"` (uncontrolled) unless tab-switching behavior needs external control. Reset tab state when `onClose` fires if using controlled mode.
**Warning signs:** Reopened modal shows "From Issue" tab unexpectedly.

---

## Code Examples

### IPC extension — create_task with agent_id
```rust
// Source: [VERIFIED: src-tauri/src/ipc/task_handlers.rs lines 65-77 (current)]
// Updated signature:
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
    // ... pass agent_id to INSERT
}
```

### Mutation — useCreateTaskMutation extended
```typescript
// Source: [VERIFIED: src/services/task.service.ts lines 76-93 (current signature)]
// Must add agent_id, priority, auto_approve, isolated_worktree to mutation call
export function useCreateTaskMutation() {
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
    }) => api.createTask(
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
    // ...
  });
}
```

### "Create another" reset pattern
```typescript
// Source: [ASSUMED] — inferred from D-16
const onSubmit: SubmitHandler<FormData> = (data) => {
  mutate(data, {
    onSuccess: () => {
      if (createAnother) {
        // D-16: reset title + description only; keep branch, priority, agent, toggles
        resetField("title");
        resetField("description");
      } else {
        onClose();
      }
    },
  });
};
```

### Branch query key for invalidation
```typescript
// Source: [VERIFIED: src/services/task.service.ts line 330]
// The query key for branches:
queryKey: [...taskQueryKeys.base, "branches", projectId]
// For invalidation:
queryClient.invalidateQueries({ queryKey: [...taskQueryKeys.base, "branches", projectId] })
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `TaskModal` in `App.tsx` lazy-loaded, opened via context | `CreateTaskModal` self-contained in `KanbanView` | Phase 61 | Removes context prop drilling for modal open |
| Three separate creation entry points | Single modal with tabs | Phase 61 | One consistent creation UX |
| No `agent_id` on Task | `agent_id: Option<String>` in Task model + V19 schema | Phase 61 | Enables Phase 62 agent-required gate for Backlog→Ready |

**Deprecated/outdated:**
- `TaskModal.tsx`: deleted in D-17
- `BacklogTaskSheet.tsx`: deleted in D-17 (edit mode for tasks moves to Phase 62 TaskDetailScreen)
- `ImportTicketsModal.tsx`: deleted in D-17 (bulk import UX replaced by single-issue picker)
- `classifyIssues` helper (exported from ImportTicketsModal): deleted with the file — its test also deleted

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `create_task` IPC handler needs `priority`, `auto_approve`, and `isolated_worktree` added alongside `agent_id` — current handler omits them (uses DB defaults) | Code Examples / Common Pitfalls | If wrong: priority, auto_approve, isolated_worktree may already be wired (check INSERT statement) — verify before changing handler signature |
| A2 | The "Create another" reset uses `resetField("title")` + `resetField("description")` to preserve other field values | Code Examples | If `reset()` is used instead it clears all fields — must use `resetField` for D-16 behavior |
| A3 | `KanbanContext.onAddTask` has no callers other than `App.tsx`; it can be removed from the context interface | Common Pitfalls | If another component calls `onAddTask`, removing it breaks that component |

---

## Open Questions (RESOLVED)

1. **Priority/auto_approve/isolated_worktree in current create_task**
   - What we know: Current `create_task_impl` INSERT only sets `project_id, title, description, skills, status, base_branch, created_at, updated_at`. Priority defaults to `'Medium'`, auto_approve defaults to `0`, isolated_worktree defaults to `1` from the schema column defaults.
   - What's unclear: Whether the plan should extend the IPC to accept these fields, or just add `agent_id` and leave the others as schema defaults.
   - Recommendation: Extend the IPC to accept `priority`, `auto_approve`, `isolated_worktree`, and `agent_id` together — this is the only place task creation happens and all four fields are in the CreateTaskModal form. A user setting priority=Urgent should not silently revert to Medium.
   - **RESOLVED:** Plan 61-01 Task 2 extends `create_task` and `update_task` IPC to accept all four fields: `agent_id`, `priority`, `auto_approve`, `isolated_worktree`.

2. **Branch sub-tabs (Local vs Remote) in CREATE-03**
   - What we know: CREATE-03 specifies "Local and Remote sub-tabs" in the branch selector. `useProjectBranchesQuery` returns `[branches: string[], currentBranch: string]` — a single flat list.
   - What's unclear: Whether branches are already split into local/remote by the backend, or if sub-tabs are cosmetic.
   - Recommendation: Verify what `api.listProjectBranches` actually returns. If it's a flat list, the planner should decide whether to add Local/Remote split to the backend or filter by prefix (e.g., `remotes/` prefix) on the frontend.
   - **RESOLVED:** Verified — `git.list_branches()` returns a flat deduplicated `Vec<String>` (local + remote-tracking merged, `origin/` prefix stripped). No local/remote split is available from the backend. CONTEXT.md D-12 and D-14 (flat combobox list only) supersede ROADMAP SC-3's "Local and Remote sub-tabs" clause. Plan 61-02 Task 1 implements a single `CommandGroup` with search. Sub-tabs are not implemented and not needed given the backend data shape.

---

## Environment Availability

Step 2.6: SKIPPED — phase is frontend/backend code changes with no new external dependencies. All tools (pnpm, cargo, rust toolchain) verified present from Phase 60 execution.

---

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest (via vite.config.ts `test` block) |
| Config file | `vite.config.ts` (test.environment: happy-dom, setupFiles: ./src/test/setup.ts) |
| Quick run command | `pnpm test CreateTaskModal` |
| Full suite command | `pnpm test` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| CREATE-01 | CreateTaskModal renders From Branch form fields | unit | `pnpm test CreateTaskModal` | ❌ Wave 0 |
| CREATE-01 | Submit creates task with correct fields (title, branch, priority, agent, toggles) | unit | `pnpm test CreateTaskModal` | ❌ Wave 0 |
| CREATE-02 | From Issue tab hidden when no provider | unit | `pnpm test CreateTaskModal` | ❌ Wave 0 |
| CREATE-02 | Issue selection pre-fills title + description | unit | `pnpm test CreateTaskModal` | ❌ Wave 0 |
| CREATE-03 | Branch combobox renders branch list | unit | `pnpm test CreateTaskModal` | ❌ Wave 0 |
| CREATE-04 | "Create another" keeps modal open after submit | unit | `pnpm test CreateTaskModal` | ❌ Wave 0 |
| DATA-01 | Task model has auto_approve and isolated_worktree fields | manual/build | `cargo test` | ✅ (schema test in schema.rs) |
| — | Schema V19 initializes correctly | unit (Rust) | `cargo test test_schema_initialization` | ✅ (needs assertion update) |

### Sampling Rate
- **Per task commit:** `pnpm test CreateTaskModal`
- **Per wave merge:** `pnpm test`
- **Phase gate:** `pnpm test` + `cargo test` green before `/gsd-verify-work`

### Wave 0 Gaps
- [ ] `src/components/kanban/__tests__/CreateTaskModal.test.tsx` — covers CREATE-01, CREATE-02, CREATE-03, CREATE-04
- [ ] Update `src-tauri/src/db/schema.rs` test assertion from `assert_eq!(version, 18)` to `assert_eq!(version, 19)`

*(Existing test infrastructure otherwise covers all phase requirements — no new framework install needed)*

---

## Security Domain

Phase 61 creates a task creation form. No authentication, cryptography, or session management is involved. ASVS V5 (Input Validation) is the only applicable category.

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no | — |
| V3 Session Management | no | — |
| V4 Access Control | no | — |
| V5 Input Validation | yes | react-hook-form + Rust-side title/description validation (existing: title 3-255 chars, description ≥10 chars) |
| V6 Cryptography | no | — |

### Known Threat Patterns

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Oversized title/description input | Tampering | Rust `create_task_impl` already validates title (3-255) and description (≥10 chars) — [VERIFIED: task_handlers.rs lines 37-43] |
| SQLite injection via agent_id | Tampering | rusqlite parameterized queries — new `agent_id` param uses `rusqlite::params![]` same as all existing fields |

---

## Sources

### Primary (HIGH confidence)
- `src/components/kanban/TaskModal.tsx` — existing Dialog + TaskForm pattern
- `src/components/kanban/BacklogTaskSheet.tsx` — taskToFormValues helper, create/edit modes
- `src/components/kanban/ImportTicketsModal.tsx` — useFetchRemoteIssuesQuery usage, Dialog patterns
- `src/components/task/TaskForm.tsx` — react-hook-form + Controller pattern, branch auto-default useEffect
- `src/views/KanbanView.tsx` — action bar layout (h-12 border-b, left-aligned filters), buttonVariants() on PopoverTrigger
- `src/services/task.service.ts` — all task query/mutation hooks, branch query key
- `src/services/integration.service.ts` — useProjectIssueTrackingConfig, PROVIDER_NAMES
- `src/services/execution.service.ts` — useAgentDiscoveryQuery signature
- `src/components/common/SettingsPage.tsx` — agent selector pattern with Controller + Select
- `src/components/ui/tabs.tsx` — base-ui Tabs, TabsTrigger has no asChild
- `src/components/ui/dialog.tsx` — DialogContent, showCloseButton prop
- `src/components/ui/switch.tsx` — Switch from base-ui, size prop
- `src/components/ui/command.tsx` — Command, CommandInput, CommandItem with data-checked
- `src/components/ui/popover.tsx` — PopoverTrigger (base-ui, no asChild)
- `src-tauri/src/models/task.rs` — Task struct, TASK_SELECT, from_row column indices
- `src-tauri/src/db/schema.rs` — SCHEMA_VERSION=18, SCHEMA_V18 tasks table definition
- `src-tauri/src/ipc/task_handlers.rs` — create_task, update_task signatures and INSERT
- `src/contexts/KanbanContext.tsx` — onAddTask context prop
- `src/App.tsx` — TaskModal lazy load, showNewTaskModal state, KanbanProvider wiring
- `.planning/phases/61-create-task-modal/61-CONTEXT.md` — all locked decisions

### Secondary (MEDIUM confidence)
- `.claude/plans/61-create-task-modal-preview.html` — design layout reference for From Branch tab and From Issue combobox Option B

### Tertiary (LOW confidence)
- None

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all libraries verified in codebase, no new dependencies
- Architecture: HIGH — all patterns verified from existing source files
- Pitfalls: HIGH (Pitfalls 1-4 verified from source); MEDIUM (Pitfall 5-6 inferred from patterns)
- Assumptions: A1 and A2 are LOW and need planner verification

**Research date:** 2026-05-26
**Valid until:** 2026-06-26 (stable, no external dependencies)
