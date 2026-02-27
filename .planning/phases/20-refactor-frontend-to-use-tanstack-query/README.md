# Phase 20: Refactor Frontend to use TanStack Query

**Status:** Planning Complete ✓
**Date:** 2026-02-26
**Phase Milestone:** v1.1 UI/UX Polish
**Total Plans:** 7 (19 tasks across 3 waves)

## Quick Links

- **PLANNING-SUMMARY.md** - Overview, scope breakdown, key patterns (START HERE)
- **20-RESEARCH.md** - Detailed research, architecture patterns, code examples
- **PHASE PLANS** (ordered by execution):
  - Wave 1 (Parallel): [20-01-PLAN.md](20-01-PLAN.md), [20-02-PLAN.md](20-02-PLAN.md), [20-03-PLAN.md](20-03-PLAN.md)
  - Wave 2 (Parallel): [20-04-PLAN.md](20-04-PLAN.md), [20-05-PLAN.md](20-05-PLAN.md), [20-06-PLAN.md](20-06-PLAN.md)
  - Wave 3 (Sequential): [20-07-PLAN.md](20-07-PLAN.md)

## Phase Goal

Replace all 50+ direct Tauri `invoke()` calls with TanStack Query hooks for consistent data fetching, automatic caching, cache invalidation, and optimistic updates.

## Success Criteria

- ✓ All Tauri IPC data fetching operations use `useQuery` hook
- ✓ All Tauri IPC mutations use `useMutation` hook
- ✓ Query/mutation hooks defined in service files, not separate hooks folder
- ✓ Automatic cache invalidation configured for all mutations
- ✓ Loading and error states managed through TanStack Query
- ✓ Zero direct `invoke()` calls remaining in React components

## Execution Model

### Wave 1: Service Layer (Parallel)

Create query/mutation hooks in all 5 service files:

| Plan | Files | Hooks | Focus |
|------|-------|-------|-------|
| 20-01 | task.service.ts, project.service.ts | 17 | Core task/project operations |
| 20-02 | execution.service.ts, settings.service.ts | 10 | Execution control + app settings |
| 20-03 | connection.service.ts | 2-3 | SSH connection management (audit + extend) |

**Total Wave 1:** ~27 hooks across 5 services

### Wave 2: Component Migration (Parallel, depends on Wave 1)

Refactor 9 components to use new hooks:

| Plan | Components | Focus |
|------|------------|-------|
| 20-04 | App.tsx, ApprovalForm.tsx, ReviewModal.tsx | App init + review workflow |
| 20-05 | SyncButton.tsx, TaskCard.tsx, TaskModal.tsx | Kanban board core functionality |
| 20-06 | FilePicker.tsx, ImportSettings.tsx, useRecentProjects.ts | Project setup + recent projects |

**Total Wave 2:** 9 files migrated to use Wave 1 hooks

### Wave 3: Verification (Sequential, depends on Wave 2)

Comprehensive quality gate:
- Verify no direct `invoke()` calls remain in components
- Verify TanStack Query patterns consistent across services
- Build and runtime verification
- Generate completion report

## Key Patterns

### Query Key Factories

Centralized query key management (one per service):

```typescript
export const taskQueryKeys = {
  all: ["tasks"] as const,
  lists: () => [...taskQueryKeys.all, "list"] as const,
  list: (projectId: number) => [...taskQueryKeys.lists(), { projectId }] as const,
  details: () => [...taskQueryKeys.all, "detail"] as const,
  detail: (taskId: number) => [...taskQueryKeys.details(), taskId] as const,
};
```

### Query Hooks with Dependent Data

Always include `enabled` condition for null parameters:

```typescript
export function useTasksQuery(projectId: number | null) {
  return useQuery({
    queryKey: taskQueryKeys.list(projectId!),
    queryFn: () => taskService.getTasks(projectId!),
    enabled: projectId !== null, // Prevent query if projectId not ready
    staleTime: 30000,
    refetchOnWindowFocus: true,
  });
}
```

### Cache Invalidation on Mutations

All mutations invalidate appropriate cache keys:

```typescript
export function useCreateTaskMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (request: CreateTaskRequest) => taskService.createTask(request),
    onSuccess: () => {
      // Invalidate task list so it refetches with new task
      queryClient.invalidateQueries({ queryKey: taskQueryKeys.lists() });
    },
  });
}
```

### Optimistic Updates (for status changes)

Immediate UI updates before server response:

```typescript
export function useUpdateTaskStatusMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ taskId, status }) => taskService.updateTaskStatus(taskId, status),
    onMutate: async ({ taskId, status }) => {
      // Cancel outgoing refetches
      await queryClient.cancelQueries({ queryKey: taskQueryKeys.detail(taskId) });

      // Save previous value
      const previousTask = queryClient.getQueryData(taskQueryKeys.detail(taskId));

      // Update cache optimistically
      queryClient.setQueryData(taskQueryKeys.detail(taskId), (old: Task) => ({
        ...old,
        status,
      }));

      return { previousTask };
    },
    onError: (error, variables, context) => {
      // Rollback on error
      if (context?.previousTask) {
        queryClient.setQueryData(taskQueryKeys.detail(variables.taskId), context.previousTask);
      }
    },
    onSettled: (data, error, variables) => {
      // Always sync with server
      queryClient.invalidateQueries({ queryKey: taskQueryKeys.detail(variables.taskId) });
    },
  });
}
```

## Files Modified Summary

### Phase 20-01 & 20-02 & 20-03 (Wave 1)

Service files with new hooks:
- `src/services/task.service.ts` - 10 query/mutation hooks + taskQueryKeys
- `src/services/project.service.ts` - 7 query/mutation hooks + projectQueryKeys
- `src/services/execution.service.ts` - 7 mutation hooks + executionQueryKeys
- `src/services/settings.service.ts` - 3 query/mutation hooks + settingsQueryKeys
- `src/services/connection.service.ts` - SSH hooks audit + connectionQueryKeys

### Phase 20-04 & 20-05 & 20-06 (Wave 2)

Components refactored to use Wave 1 hooks:
- `src/App.tsx` - useSettingsQuery for app init
- `src/components/common/ApprovalForm.tsx` - useDiffForReviewQuery
- `src/components/common/ReviewModal.tsx` - Review mutations
- `src/components/common/SyncButton.tsx` - Sync mutations
- `src/components/kanban/TaskCard.tsx` - useTasksQuery + useUpdateTaskStatusMutation (optimistic)
- `src/components/kanban/TaskModal.tsx` - Task creation/edit mutations
- `src/components/project-picker/FilePicker.tsx` - SSH connection hooks
- `src/components/task/ImportSettings.tsx` - useSaveImportConfigMutation
- `src/utils/hooks/useRecentProjects.ts` - useSettingsQuery wrapper

### Phase 20-07 (Wave 3)

No file modifications (verification only). Generates:
- `.planning/phases/20-refactor-frontend-to-use-tanstack-query/20-COMPLETION-REPORT.md`

## Estimated Context per Plan

| Plan | Tasks | Context | Type |
|------|-------|---------|------|
| 20-01 | 2 | ~35% | Complex (17 hooks) |
| 20-02 | 2 | ~30% | Medium (10 hooks) |
| 20-03 | 1 | ~15% | Small (audit) |
| 20-04 | 3 | ~25% | Component refactoring |
| 20-05 | 3 | ~25% | Component refactoring (Kanban focus) |
| 20-06 | 3 | ~25% | Component refactoring |
| 20-07 | 4 | ~15% | Verification only |

**Total Estimated:** ~170-190% context (each plan stays under 50%)

## Verification Checklist

Before marking Phase 20 complete:

- [ ] npm run build succeeds with 0 TypeScript errors
- [ ] npm run tauri:dev launches app without runtime errors
- [ ] `grep "invoke<" src/components/ --include="*.tsx"` returns 0 matches
- [ ] `grep "invoke<" src/utils/hooks/ --include="*.tsx"` returns 0 matches
- [ ] All 5 query key factories exist (taskQueryKeys, projectQueryKeys, executionQueryKeys, settingsQueryKeys, connectionQueryKeys)
- [ ] All mutation hooks use `queryClient.invalidateQueries()` for cache invalidation
- [ ] Optimistic updates working (TaskCard drag-drop shows immediate status change)
- [ ] Manual smoke tests pass:
  - [ ] App loads settings on startup
  - [ ] Project loads and renders task list
  - [ ] Drag-drop updates task status with optimistic UI update
  - [ ] Creating new task works via mutation
  - [ ] Form submissions show loading state via isPending
  - [ ] Errors show via Sonner toast
- [ ] Phase 20-COMPLETION-REPORT.md generated and signed off

## Timeline Estimate

**Wave 1 (Parallel):** ~3 hours execution time (parallel = ~1 hour real time)
**Wave 2 (Parallel):** ~3 hours execution time (parallel = ~1 hour real time)
**Wave 3 (Sequential):** ~30 min

**Total Real Time:** ~2.5 hours (if fully parallelized)

## Documentation

- **PLANNING-SUMMARY.md** - Detailed planning overview
- **20-RESEARCH.md** - Technical research and reference patterns
- **20-*-PLAN.md** - Individual execution plans (7 total)
- **20-*-SUMMARY.md** - Individual plan summaries (generated after execution)
- **20-COMPLETION-REPORT.md** - Final phase completion report (generated in Wave 3)

## Next Phase (Phase 21)

Potential improvements deferred to Phase 21:
- Real-time updates via WebSocket (currently polling)
- React Query DevTools integration
- Advanced cache strategies (selective invalidation)
- Mutation request deduplication
- Performance monitoring

---

**Phase 20 Status:** Planning Complete ✓
**Quality Gate:** Passed ✓
**Ready for Execution:** Yes ✓

Generated: 2026-02-26
Planner: Claude Opus 4.6 (gsd-planner agent)
