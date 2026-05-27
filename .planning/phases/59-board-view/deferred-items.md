# Deferred Items — Phase 59

## Pre-existing TypeScript errors (out of scope for Phase 59)

### Missing Task fixture fields in tests

- `src/components/kanban/__tests__/ImportTicketsModal.test.tsx` lines 52, 90: test fixtures missing `auto_approve` and `isolated_worktree` fields added in Phase 57 schema bump
- `src/components/task/TaskForm.tsx` line 65: similar fixture mismatch

These errors pre-date Phase 59 and are not caused by any Phase 59 changes. They should be addressed in a future cleanup task.
