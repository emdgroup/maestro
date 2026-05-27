---
phase: 63
fixed_at: 2026-05-27T15:35:58Z
review_path: .planning/phases/63-archive-modal/63-REVIEW.md
iteration: 1
findings_in_scope: 3
fixed: 3
skipped: 0
status: all_fixed
---

# Phase 63: Code Review Fix Report

**Fixed at:** 2026-05-27T15:35:58Z
**Source review:** .planning/phases/63-archive-modal/63-REVIEW.md
**Iteration:** 1

**Summary:**
- Findings in scope: 3
- Fixed: 3
- Skipped: 0

## Fixed Issues

### WR-1: All five test cases are unimplemented stubs

**Files modified:** `src/components/kanban/__tests__/ArchiveModal.test.tsx`
**Commit:** 9ffb491
**Applied fix:** Replaced all five `it.todo()` stubs with real test implementations. Lifted `setActiveTaskId` to a module-level `mockSetActiveTaskId` variable so assertions can reference it. Added `beforeEach(() => vi.clearAllMocks())`. The tab-filter tests use `screen.getByRole("tab", { name: "Done" })` and `screen.getByRole("tab", { name: "Cancelled" })` to disambiguate tab buttons from status badge spans that share the same text. All 5 tests pass.

### WR-2: `projectId ?? 0` passes invalid project ID to modal query

**Files modified:** `src/views/KanbanView.tsx`
**Commit:** fb3088f
**Applied fix:** Wrapped both `CreateTaskModal` and `ArchiveModal` in a `{projectId !== null && (...)}` conditional render block. The modals now receive `projectId` directly (typed as `number`) rather than `projectId ?? 0`, eliminating the dead fallback that silently bypassed the `enabled: projectId !== null` guard in `useTasksQuery`.

### WR-3: Archive filter latent inconsistency (Cancelled without archived_at)

**Files modified:** `src/components/kanban/ArchiveModal.tsx`
**Commit:** 5fd6d2f
**Applied fix:** Added inline comment on the first filter line documenting the intent: `// Include archived tasks and Cancelled tasks (cancel_task always sets archived_at, but guard by status too)`. No logic change — the reviewer confirmed no code change is strictly required today.

---

_Fixed: 2026-05-27T15:35:58Z_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
