# Simplify: Unpushed Commits Code Review

## Context

Three-agent review (reuse, quality, efficiency) of 37 changed source files across origin/main..HEAD (phases 57-61).
Found 20+ issues; plan fixes the actionable ones with clean scope. Skips architectural-scale changes (always-mounted
view query isolation, `update_task` struct refactor that would force binding regeneration).

---

## Fixes

### 1. Export `PRIORITIES` from `priority.ts` — remove two duplicate definitions

**Files:** `src/utils/constants/priority.ts`, `src/components/kanban/CreateTaskModal.tsx:34`,
`src/views/KanbanView.tsx:72`

`PRIORITIES` list is defined three ways: module const in CreateTaskModal, inline literal in KanbanView,
and implicitly in `PRIORITY_COLORS` keys. Add one exported `PRIORITIES` const to `priority.ts`,
import it in both components.

```ts
// priority.ts — add:
export const PRIORITIES: TaskPriority[] = ["Urgent", "High", "Medium", "Low", "None"];
```

---

### 2. Simplify `useCreateTaskMutation` — remove redundant pass-through wrapping

**File:** `src/services/task.service.ts:80-103`

The mutation function takes a request object, then copies every field 1:1 into the API call. The
generated `CreateTaskRequest` binding already matches. Reduce to:

```ts
mutationFn: (request: CreateTaskRequest) => api.createTask(request),
```

Drop the inline type definition and manual field mapping.

---

### 3. Collapse four popover booleans to single discriminated state

**File:** `src/components/kanban/CreateTaskModal.tsx:78-83`

Replace:
```ts
const [branchPopoverOpen, setBranchPopoverOpen] = useState(false);
const [priorityPopoverOpen, setPriorityPopoverOpen] = useState(false);
const [agentPopoverOpen, setAgentPopoverOpen] = useState(false);
const [issuePopoverOpen, setIssuePopoverOpen] = useState(false);
```

With:
```ts
const [openPopover, setOpenPopover] = useState<"branch" | "priority" | "agent" | "issue" | null>(null);
```

Each Popover's `open` becomes `openPopover === "branch"` etc.
`onOpenChange={(v) => setOpenPopover(v ? "branch" : null)}`.

---

### 4. Extract `TogglePill` — remove copy-pasted toggle pill JSX

**File:** `src/components/kanban/CreateTaskModal.tsx:480-518`

`isolatedWorktree` and `autoApprove` Controller blocks are structurally identical (38 lines each).
Extract a `TogglePill` component inside the file:

```tsx
function TogglePill({
  name, label, control
}: { name: "isolatedWorktree" | "autoApprove"; label: string; control: Control<FormData> }) { ... }
```

Reduce both uses to one-liners.

---

### 5. Memoize `worktreeTaskIds` and `availableLabels`

**File:** `src/views/KanbanView.tsx:25-35`

Both are new object instances every render, passed as props (breaking downstream reference equality).

```ts
const worktreeTaskIds = useMemo(
  () => new Set((worktrees ?? []).filter(w => w.task_id != null).map(w => w.task_id!)),
  [worktrees],
);
const availableLabels = useMemo(
  () => [...new Set(taskList.flatMap(t => t.labels))].sort(),
  [taskList],
);
```

---

### 6. Stabilize `onTaskClick` no-op in App.tsx

**File:** `src/App.tsx:218`

`onTaskClick={() => {}}` creates a new function reference every render, invalidating
`KanbanProvider`'s context value and forcing all `useKanban()` consumers to re-render.

Extract to module-level:
```ts
const NOOP = () => {};
// then in JSX:
onTaskClick={NOOP}
```

---

### 7. Memoize `viewControls` object in App.tsx

**File:** `src/App.tsx:63-70`

`viewControls` is a plain object recreated every render but used in an effect without being listed
as a dependency. Wrap in `useMemo` (the animation control refs are stable, so deps is `[]`):

```ts
const viewControls = useMemo(() => ({
  kanban: kanbanControls,
  agents: agentsControls,
  worktrees: worktreesControls,
  settings: settingsControls,
} satisfies Record<ViewType, ReturnType<typeof useAnimationControls>>), []);
```

---

### 8. Derive `missingProvider` at usage site — remove redundant state

**File:** `src/App.tsx:43-44`

`missingProvider` is always set alongside `showMissingDialog` and derived from
`issueTrackingConfig.provider`. Replace the two-state pattern:

```ts
// Remove: const [missingProvider, setMissingProvider] = useState<string | null>(null);
// Keep: const [showMissingDialog, setShowMissingDialog] = useState(false);
// At usage: provider={issueTrackingConfig?.provider ?? ""}
```

Update the effect that sets both to only set `showMissingDialog`.

---

### 9. Use `binary_search` in `parse_branch_list`

**File:** `src-tauri/src/git/mod.rs:417`

After sorting, `remote.retain(|r| !local.contains(r))` is O(n*m). Since `local` is already sorted:

```rust
remote.retain(|r| local.binary_search(r).is_err());
```

Zero extra allocations, O(n log m) instead of O(n*m).

---

### 10. Remove WHAT-not-WHY JSX comments in CreateTaskModal

**File:** `src/components/kanban/CreateTaskModal.tsx:273, 288, 304, 389`

Delete: `{/* Seamless title */}`, `{/* Seamless description */}`, `{/* Branch selector */}`,
`{/* Priority + Agent + Toggle pills */}`. The JSX itself makes these self-evident.

---

## Skipped (noted, not fixing)

- `update_task` 8 positional params → `UpdateTaskRequest`: requires binding regen + frontend type updates, too broad for a simplify pass
- Always-mounted views still subscribing to queries when invisible: architectural, separate concern
- `interrupt_task` partial-teardown edge case: behavioral correctness, not code quality
- TaskCard per-instance mutation hooks: low impact, would need `React.memo` to be worth it

---

## Verification

After applying:

```bash
pnpm build       # TypeScript check passes
pnpm test        # All Vitest tests pass
pnpm lint        # No lint errors
cd src-tauri && cargo check   # Rust compiles
```

Manual smoke test:
1. Open project → KanbanView renders with correct filters
2. Click "+ Task" → CreateTaskModal opens, priority/branch/agent/issue popovers work correctly
3. Create a task → appears in Backlog column
4. Navigate between tabs → slide animation works in all directions
