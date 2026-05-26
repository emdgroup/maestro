# Phase 61: Create Task Modal — Context

**Gathered:** 2026-05-26
**Status:** Ready for planning

<domain>
## Phase Boundary

Build `CreateTaskModal` — a single tabbed modal replacing three legacy components (`TaskModal`, `BacklogTaskSheet`, `ImportTicketsModal`, all deleted). Add a "+ New Task" button to the KanbanView action bar that opens it. Two tabs: "From Branch" (new task with full field set) and "From Issue" (combobox issue picker → pre-fills → same full field set). Also add `agent_id` to the Task model with schema V19.

</domain>

<decisions>
## Implementation Decisions

### Agent Field (new Task property)

- **D-01: `agent_id: Option<String>` added to Task model.** Schema bump V18 → V19 (destructive). Bindings regenerated via `pnpm tauri:gen`. Conceptually the "assignee" field — assignee is an AI agent.
- **D-02: Default = `project.default_agent`.** When modal opens, agent selector pre-fills with the project's configured default agent. User can override per-task.
- **D-03: UI = `<Select>` dropdown.** Same pattern as Priority. Lists discovered agents by display name via `useAgentDiscoveryQuery(connectionId, wslConnectionId)`.
- **D-04: Optional on create/edit.** `agent_id` is not required to save a task. The required gate (agent must be set before Backlog→Ready transition) lives in Phase 62's action bar — NOT in `CreateTaskModal`.

### Modal Structure

- **D-05: Tabs conditional on provider.** When `useProjectIssueTrackingConfig` returns null/unconfigured → tabs UI hidden entirely, modal renders "From Branch" form directly (no tab switcher). When provider is configured → both tabs shown.
- **D-06: "+ New Task" trigger in KanbanView action bar.** Right side of the action bar (search + filters are left-aligned per Phase 59 D-03). Phase 61 adds the button.

### "From Branch" Tab

- **D-07: Fields:** title (required), description, base branch (combobox, required), priority (Select), agent (Select, optional), isolated worktree toggle (default on), auto-approve toggle (default off).
- **D-08: Form library:** `react-hook-form` + `Controller` — same as existing `TaskForm`.

### "From Issue" Tab

- **D-09: Issue picker = combobox (Popover + Command pattern).** Searchable dropdown. Select one issue → pre-fills title + description in the form below.
- **D-10: Full form fields appear after selection.** Same fields as "From Branch" (branch, priority, agent, toggles) appear below the combobox. Issue pre-fills title + description only; user configures the rest.
- **D-11: Available/Imported/Changed tracking dropped.** `IMPT-*` and `CHNG-*` v1.6 requirements are superseded. No change detection, no multi-tab browser, no bulk select. Simple fetch + pick.

### Branch Selector

- **D-12: Combobox (Popover + Command pattern).** Type to filter. `useProjectBranchesQuery(projectId)` returns `[branches: string[], currentBranch]` — auto-selects current branch as default.
- **D-13: Explicit refresh button.** Small icon button next to combobox trigger. Calls `queryClient.invalidateQueries` on the branches query key. Shows loading state during refetch.
- **D-14: List only.** No free-text input — must select from existing branches.

### "Create Another" Toggle

- **D-15: Off by default.**
- **D-16: On submit with toggle on:** reset title + description only. Branch, priority, agent, isolated worktree, auto-approve persist. Enables batch task creation for same context.

### Legacy Component Deletion

- **D-17: Three files deleted:** `src/components/kanban/TaskModal.tsx`, `src/components/kanban/BacklogTaskSheet.tsx`, `src/components/kanban/ImportTicketsModal.tsx` (and its test file `__tests__/ImportTicketsModal.test.tsx`).

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Requirements
- `.planning/REQUIREMENTS.md` §CREATE-01 through CREATE-04 — 4 task creation requirements for this phase
- `.planning/REQUIREMENTS.md` §DATA-01, DATA-02 — `auto_approve` + `isolated_worktree` fields (already in schema V18; `agent_id` is the new addition for V19)

### Phase Context
- `.planning/phases/59-board-view/59-CONTEXT.md` — KanbanView action bar layout (D-03: left-aligned search + filters); "+ New Task" button goes on the right
- `.planning/phases/60-task-card-redesign/60-CONTEXT.md` — D-11: agent name omitted from Phase 60 cards ("Phase 61 establishes the agent field on Task")
- `.planning/STATE.md` — Phase 57 decisions: schema V18, `auto_approve` default false, `isolated_worktree` default true

### Existing Source Files
- `src/components/kanban/TaskModal.tsx` — legacy file being deleted; contains Dialog wrapper pattern
- `src/components/kanban/BacklogTaskSheet.tsx` — legacy file being deleted; contains `taskToFormValues` helper and edit mode
- `src/components/kanban/ImportTicketsModal.tsx` — legacy file being deleted; contains `useFetchRemoteIssuesQuery` and `useProjectIssueTrackingConfig` usage patterns
- `src/components/task/TaskForm.tsx` — existing form with `react-hook-form` + `Controller` pattern, `useProjectBranchesQuery` usage, branch auto-default logic
- `src/views/KanbanView.tsx` — where "+ New Task" button and modal state live
- `src/services/task.service.ts` — `useCreateTaskMutation`, `useProjectBranchesQuery`
- `src/services/integration.service.ts` — `useProjectIssueTrackingConfig` (provider check)
- `src/services/execution.service.ts` — `useAgentDiscoveryQuery`, `useAgentCacheQuery`
- `src/components/ui/tabs.tsx` — base-ui Tabs (Trigger has no `asChild` prop — use `buttonVariants()` directly per Phase 59 lesson)
- `src/components/common/SettingsPage.tsx` — reference for agent selector pattern (uses `useAgentDiscoveryQuery` + Select)

### Design Reference
- `.claude/plans/61-create-task-modal-preview.html` — HTML mockup showing From Branch tab layout, Option A vs B for From Issue picker (user selected B — combobox)

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `useCreateTaskMutation()` in `task.service.ts` — create task IPC, already handles success/error
- `useProjectBranchesQuery(projectId)` in `task.service.ts` — returns `[branches, currentBranch]`, `staleTime: 60s`
- `useFetchRemoteIssuesQuery(projectId, enabled)` in `task.service.ts` (via ImportTicketsModal) — fetches `RemoteIssue[]`
- `useProjectIssueTrackingConfig(projectId)` in `integration.service.ts` — null when no provider configured
- `useAgentDiscoveryQuery(connectionId, wslConnectionId)` in `execution.service.ts` — agent list
- `Tabs`, `TabsList`, `TabsTrigger`, `TabsContent` from `@/ui/tabs` — already available, base-ui
- `Dialog`, `DialogContent`, `DialogTitle`, `DialogDescription` from `@/ui/dialog`
- `Select`, `SelectContent`, `SelectItem`, `SelectTrigger`, `SelectValue` from `@/ui/select`
- `Switch` or toggle from `@/ui/` — check if Switch component exists; used for isolated worktree + auto-approve toggles
- `useSelectedProject()` from `projectStore` — provides `projectId`, `project.path`, `project.connection_id`
- `useKanban()` from `KanbanContext` — provides `projectId`, `projectPath` inside Kanban tree (alternative access point)

### Established Patterns
- `react-hook-form` with `Controller` for complex inputs (Select, branch combobox)
- Branch auto-default: `useEffect` sets `baseBranch` to `currentBranch` when data loads and no initial value (from `TaskForm.tsx:57-61`)
- Compact design system: `text-xs`, `h-7`, `p-3`, `text-sm font-medium` throughout
- Modal error display: inline error div with `bg-destructive/10 border-destructive/30` (from both legacy modals)
- `buttonVariants()` on base-ui Popover triggers (no `asChild` — per Phase 59 Plan 02 lesson)
- Agent selector reference pattern in `SettingsPage.tsx` lines 49-50 + 174 (uses `useAgentDiscoveryQuery` + Controller + Select)

### Integration Points
- `KanbanView.tsx` → adds modal open state + "+ New Task" button in action bar + `<CreateTaskModal>` render
- `src-tauri/src/models/task.rs` → add `agent_id: Option<String>` with `#[ts(optional)]`
- `src-tauri/src/db/schema.rs` → bump `SCHEMA_VERSION` to 19, add `agent_id TEXT` column to tasks table in migration
- `src-tauri/src/ipc/task_handlers.rs` → `create_task` and `update_task` handlers accept `agent_id`
- `pnpm tauri:gen` → regenerates `src/types/bindings.ts` with updated `Task` type

</code_context>

<specifics>
## Specific Ideas

- Agent field labeled "Agent (assignee)" — per discussion, this is conceptually an assignee field where the assignee is an AI agent
- "From Issue" tab combobox: Option B layout from preview — trigger shows placeholder until selection, popover with search input + issue list
- From Branch tab matches the preview's layout exactly: title → description → branch/priority row → agent → toggles section → footer with "Create another"

</specifics>

<deferred>
## Deferred Ideas

- **Backlog→Ready gate for agent_id** — Validation that agent must be set before moving to Ready belongs in Phase 62 (Task Detail Screen action bar), not in CreateTaskModal
- **Available/Imported/Changed change detection** — IMPT-01 through IMPT-06 and CHNG-01 through CHNG-02 from v1.6 requirements are dropped/superseded by the simpler picker UX

</deferred>

---

*Phase: 61-Create Task Modal*
*Context gathered: 2026-05-26*
