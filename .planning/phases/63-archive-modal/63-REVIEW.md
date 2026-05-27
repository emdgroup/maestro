---
phase: 63
status: issues_found
reviewer: gsd-code-reviewer
reviewed_at: 2026-05-27T15:24:59Z
depth: standard
files_reviewed: 3
files_reviewed_list:
  - src/components/kanban/ArchiveModal.tsx
  - src/components/kanban/__tests__/ArchiveModal.test.tsx
  - src/views/KanbanView.tsx
findings_count: 4
critical: 0
warning: 3
info: 1
---

# Code Review — Phase 63: archive-modal

## Summary

Three files reviewed at standard depth. `ArchiveModal.tsx` is well-structured — the filter chain, reset-on-close effect, and navigation pattern are all sound. Two warnings require attention: the test file ships zero implemented tests (all `it.todo()`), and the `projectId ?? 0` fallback in `KanbanView.tsx` can cause a spurious IPC query with an invalid project ID. A third warning concerns the filter logic: when the "Done" tab is active, a Done task without `archived_at` can appear in the list, which contradicts the archive semantic.

## Findings

### [WARNING] "Done" tab can surface non-archived Done tasks

**File:** `src/components/kanban/ArchiveModal.tsx:50-56`

**Issue:** The first filter in `archiveTasks` is:

```ts
.filter((t) => t.archived_at != null || t.status === "Cancelled")
```

This admits two disjoint sets: tasks that have been explicitly archived (`archived_at` set) and tasks that are Cancelled (whether or not `archived_at` is set). A Done task is only included if it has `archived_at`. That is correct.

However, once a Done task is in the set, the "Done" tab filter on line 53:

```ts
.filter((t) => filter === "all" || t.status === filter)
```

has no way to distinguish "Done with `archived_at`" from a hypothetical "Done without `archived_at`" because the first filter already enforces that. This is fine given the current first filter.

The real gap is the inverse: a `Done` task that has `archived_at = null` is correctly excluded. But the "All" tab counts Cancelled tasks that have `archived_at = null` (because `status === "Cancelled"` alone passes line 52). When the "Done" tab is selected, only Done+archived tasks appear — correct. When the "Cancelled" tab is selected, Cancelled tasks appear whether archived or not — correct per design.

The actual bug: the "All" tab is inconsistent with the "Done" tab semantic. "All" shows all archived tasks plus all Cancelled tasks (even un-archived ones). "Done" shows only Done tasks that were explicitly archived. "Cancelled" shows all Cancelled tasks including those whose `archived_at` is null. If a Cancelled task is not archived (edge case; cancel_task sets both fields simultaneously per `task_handlers.rs:228`), the task appears in "All" and "Cancelled" but would not be found if you searched across tabs expecting consistent membership. This is currently a theoretical inconsistency, but it will become real if any code path sets `status = Cancelled` without setting `archived_at`.

**Fix:** Make the first filter explicitly union-based: include a task if it is either archived or is cancelled, and keep the tabs consistent. Either enforce `archived_at` for all non-board statuses, or change the first filter to:

```ts
.filter((t) => t.archived_at != null || t.status === "Cancelled")
```

(current — acceptable for now, but add a comment documenting the intent). The real risk is adding future "out-of-band" Cancelled transitions. Guard against this at the cancel mutation site, not in the modal. No code change strictly required today, but this should be documented.

---

### [WARNING] All five test cases are unimplemented stubs

**File:** `src/components/kanban/__tests__/ArchiveModal.test.tsx:36-41`

**Issue:** The test file contains a complete mock setup for `useTasksQuery` and `useNavigationActions`, plus five `it.todo()` entries covering exactly the behaviours that could fail (search filter, tab filter, row click handler). No assertion runs. The phase ships with 0% unit test coverage for `ArchiveModal`. The mocks are wired correctly and the test IDs match the component's observable behavior, so the scaffolding is ready — but `it.todo()` produces passing tests in Vitest by design; these are false-green.

**Fix:** Implement at minimum the two filter tests and the click handler test. Recommended minimal set:

```tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { ArchiveModal } from "../ArchiveModal";

it("renders task list when isOpen=true", () => {
  render(<ArchiveModal isOpen={true} onClose={vi.fn()} projectId={1} />);
  expect(screen.getByText("Completed task")).toBeInTheDocument();
  expect(screen.getByText("Cancelled task")).toBeInTheDocument();
});

it("filters tasks by search input value", async () => {
  render(<ArchiveModal isOpen={true} onClose={vi.fn()} projectId={1} />);
  fireEvent.change(screen.getByPlaceholderText("Search archived tasks..."), {
    target: { value: "Completed" },
  });
  expect(screen.getByText("Completed task")).toBeInTheDocument();
  expect(screen.queryByText("Cancelled task")).not.toBeInTheDocument();
});

it("calls setActiveTaskId and onClose when a task row is clicked", async () => {
  const onClose = vi.fn();
  render(<ArchiveModal isOpen={true} onClose={onClose} projectId={1} />);
  fireEvent.click(screen.getByText("Completed task").closest("button")!);
  expect(setActiveTaskId).toHaveBeenCalledWith(1);
  expect(onClose).toHaveBeenCalled();
});
```

---

### [WARNING] `projectId ?? 0` passes an invalid project ID to the modal query

**File:** `src/views/KanbanView.tsx:163`

**Issue:** Both `CreateTaskModal` (line 158) and `ArchiveModal` (line 163) receive `projectId ?? 0` when no project is selected. `useTasksQuery` inside `ArchiveModal` calls `api.getTasks(projectId!)` and is gated on `enabled: projectId !== null`. Because `0 !== null` evaluates to `true`, passing `0` bypasses the `enabled` guard and fires an IPC call to `get_tasks` with `project_id = 0`. The backend query (`WHERE project_id = ?`) returns an empty result set for a non-existent project rather than an error, so no crash occurs. However, the intent of the `enabled` guard is defeated.

In practice `KanbanView` is only mounted after a project is selected (the project picker must complete first), so `projectId` is never actually null here. The fallback is defensive dead code that silently breaks the guard when it fires.

**Fix:** Either assert that `projectId` is non-null before rendering the modals (throw or return early), or ensure the modals accept `projectId: number | null` and propagate null correctly. The simplest safe option:

```tsx
// KanbanView.tsx — only render modals when projectId is known
{projectId !== null && (
  <>
    <CreateTaskModal
      isOpen={isCreateModalOpen}
      onClose={() => setIsCreateModalOpen(false)}
      projectId={projectId}
    />
    <ArchiveModal
      isOpen={isArchiveModalOpen}
      onClose={() => setIsArchiveModalOpen(false)}
      projectId={projectId}
    />
  </>
)}
```

---

### [INFO] `STATUS_BADGE_CLASSES` and `formatDate` duplicated from deleted `ArchiveView`

**File:** `src/components/kanban/ArchiveModal.tsx:12-28`

**Issue:** Both `STATUS_BADGE_CLASSES` and `formatDate` are self-contained utilities that were copied from the deleted `ArchiveView`. They are not exported or shared. If other components need status badge styling or date formatting, this pattern will be copied again rather than reused.

**Fix:** Extract to shared utilities. `formatDate` belongs in `src/utils/helpers/` (e.g., `date-utils.ts`). `STATUS_BADGE_CLASSES` could be co-located with `PRIORITY_BADGE_CLASSES` in `src/utils/constants/`. No blocking issue — the code is correct as-is — but this is technical debt to address before further reuse occurs.

---

## Verdict

issues_found — No critical defects. Three warnings: the test suite ships zero implemented tests (all stubs), the `projectId ?? 0` fallback silently defeats the `enabled` guard in `useTasksQuery`, and the archive filter exposes a latent inconsistency in how Cancelled tasks without `archived_at` are surfaced across tabs. The component logic itself is otherwise sound.
