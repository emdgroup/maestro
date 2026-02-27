# Phase 20 Planning Summary

**Phase:** 20-refactor-frontend-to-use-tanstack-query
**Date:** 2026-02-26
**Planner:** Claude Opus 4.6 (Agent: gsd-planner)
**Status:** Planning Complete ✓

## Overview

Phase 20 refactors the Maestro frontend to use TanStack Query for all data fetching, caching, and mutations. This modernizes the data layer architecture by replacing 50+ direct `invoke()` calls with query/mutation hooks, providing automatic caching, request deduplication, optimistic updates, and cache invalidation strategies.

## Phase Goal

Replace all Tauri IPC data fetching operations with TanStack Query's `useQuery` and `useMutation` hooks for consistent patterns, better cache management, and reduced boilerplate across the application.

## Success Criteria (from research)

1. ✓ All Tauri IPC data fetching operations use TanStack Query's useQuery hook
2. ✓ All Tauri IPC mutations use TanStack Query's useMutation hook
3. ✓ Query hooks defined in corresponding service files (not separate hooks folder)
4. ✓ Automatic cache invalidation and refetching configured for all mutations
5. ✓ Loading and error states managed through TanStack Query state
6. ✓ No direct invoke() calls remaining in React components for data operations

## Planning Approach

### Execution Model: 3 Waves

**Wave 1 (Service Layer):** Create query/mutation hooks in all 5 service files
**Wave 2 (Component Migration):** Refactor 9 components to use the new hooks
**Wave 3 (Verification):** Comprehensive quality gate and completion verification

### Wave Distribution

**Wave 1 Plans (Parallel execution):**
- Plan 20-01: task.service.ts + project.service.ts (17 hooks)
- Plan 20-02: execution.service.ts + settings.service.ts (10 hooks)
- Plan 20-03: connection.service.ts (audit + extend SSH hooks)

**Wave 2 Plans (Parallel execution, depends on Wave 1):**
- Plan 20-04: App.tsx, ApprovalForm.tsx, ReviewModal.tsx (3 components)
- Plan 20-05: SyncButton.tsx, TaskCard.tsx, TaskModal.tsx (3 components)
- Plan 20-06: FilePicker.tsx, ImportSettings.tsx, useRecentProjects.ts (3 files)

**Wave 3 (Sequential, depends on Wave 2):**
- Plan 20-07: Comprehensive verification and completion report

## Plan Breakdown

### Plan 20-01: Task & Project Service Hooks

**Files Modified:**
- `src/services/task.service.ts` (add 10 hooks + taskQueryKeys factory)
- `src/services/project.service.ts` (add 7 hooks + projectQueryKeys factory)

**Tasks:**
1. Add 10 TanStack Query hooks to task.service.ts (useTasksQuery, useCreateTaskMutation, useUpdateTaskStatusMutation with optimistic updates, useExecutionLogsQuery, useRetryExecutionMutation, useCancelExecutionMutation, useTaskSettingsQuery, useUpdateTaskSettingsMutation, useDiffForReviewQuery)
2. Add 7 TanStack Query hooks to project.service.ts (useProjectsQuery, useProjectQuery, useCreateProjectMutation, useRemoveProjectMutation, useProjectSettingsQuery, useUpdateProjectSettingsMutation, useSaveImportConfigMutation)

**Context Estimate:** ~35% (complex, 17 hooks total)

### Plan 20-02: Execution & Settings Service Hooks

**Files Modified:**
- `src/services/execution.service.ts` (add 7 mutation hooks + executionQueryKeys factory)
- `src/services/settings.service.ts` (add 3 hooks + settingsQueryKeys factory)

**Tasks:**
1. Add 7 mutation hooks to execution.service.ts (useSpawnExecutionMutation, usePauseExecutionMutation, useResumeExecutionMutation, useAttachTerminalMutation, useDetachTerminalMutation, useSendTerminalInputMutation, useResizeTerminalMutation)
2. Add 3 hooks to settings.service.ts (useSettingsQuery, useSystemAccentColorQuery, useSaveSettingsMutation)

**Context Estimate:** ~30% (10 hooks total)

### Plan 20-03: Connection Service Audit & Extend

**Files Modified:**
- `src/services/connection.service.ts` (audit + extend SSH hooks)

**Tasks:**
1. Audit connection.service.ts for TanStack Query hook coverage; add missing SSH mutation hooks (useCreateSshConnectionMutation, useDeleteSshConnectionMutation); add connectionQueryKeys factory

**Context Estimate:** ~15% (smaller, audit-focused)

### Plan 20-04: App & Review Components

**Files Modified:**
- `src/App.tsx` (migrate to useSettingsQuery)
- `src/components/common/ApprovalForm.tsx` (migrate to useDiffForReviewQuery)
- `src/components/common/ReviewModal.tsx` (migrate to review mutation hooks)

**Tasks:**
1. Migrate App.tsx to use useSettingsQuery hook
2. Migrate ApprovalForm.tsx to use query hooks for review operations
3. Migrate ReviewModal.tsx to use mutation hooks for approve/reject

**Context Estimate:** ~25% (component refactoring)

### Plan 20-05: Kanban Components

**Files Modified:**
- `src/components/common/SyncButton.tsx` (migrate to sync mutations)
- `src/components/kanban/TaskCard.tsx` (migrate to useTasksQuery + useUpdateTaskStatusMutation)
- `src/components/kanban/TaskModal.tsx` (migrate to task mutation hooks)

**Tasks:**
1. Migrate SyncButton.tsx to use sync mutation hooks
2. Migrate TaskCard.tsx to use task query/mutation hooks (optimistic updates for status changes)
3. Migrate TaskModal.tsx to use task mutation hooks

**Context Estimate:** ~25% (high-traffic components, optimistic updates)

### Plan 20-06: File Management Components

**Files Modified:**
- `src/components/project-picker/FilePicker.tsx` (migrate to connection service hooks)
- `src/components/task/ImportSettings.tsx` (migrate to project settings mutations)
- `src/utils/hooks/useRecentProjects.ts` (refactor to use settings hooks)

**Tasks:**
1. Migrate FilePicker.tsx to use connection service hooks
2. Migrate ImportSettings.tsx to use project settings mutation hooks
3. Refactor useRecentProjects.ts to use settings query/mutation hooks

**Context Estimate:** ~25% (final component migrations)

### Plan 20-07: Verification & Completion

**Tasks:**
1. Verify no direct invoke() calls remain in React components
2. Verify TanStack Query hook consistency and patterns
3. Verify application builds and runs without errors
4. Generate Phase 20 completion report

**Context Estimate:** ~15% (verification only)

## Key Patterns Implemented

### 1. Query Key Factories

All services export centralized query key factories:
```typescript
export const taskQueryKeys = {
  all: ["tasks"] as const,
  lists: () => [...taskQueryKeys.all, "list"] as const,
  list: (projectId: number) => [...taskQueryKeys.lists(), { projectId }] as const,
  details: () => [...taskQueryKeys.all, "detail"] as const,
  detail: (taskId: number) => [...taskQueryKeys.details(), taskId] as const,
};
```

### 2. Query Hooks

```typescript
export function useTasksQuery(projectId: number | null) {
  return useQuery({
    queryKey: taskQueryKeys.list(projectId!),
    queryFn: () => taskService.getTasks(projectId!),
    enabled: projectId !== null,
    staleTime: 30000,
    refetchOnWindowFocus: true,
  });
}
```

### 3. Mutation Hooks with Cache Invalidation

```typescript
export function useCreateTaskMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (request: CreateTaskRequest) => taskService.createTask(request),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: taskQueryKeys.lists() });
    },
  });
}
```

### 4. Optimistic Updates (for status changes)

```typescript
export function useUpdateTaskStatusMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ taskId, status }: { taskId: number; status: string }) =>
      taskService.updateTaskStatus(taskId, status),
    onMutate: async ({ taskId, status }) => {
      await queryClient.cancelQueries({ queryKey: taskQueryKeys.detail(taskId) });
      const previousTask = queryClient.getQueryData(taskQueryKeys.detail(taskId));
      queryClient.setQueryData(taskQueryKeys.detail(taskId), (old: Task | undefined) => {
        if (!old) return old;
        return { ...old, status };
      });
      return { previousTask };
    },
    onError: (error, variables, context) => {
      if (context?.previousTask) {
        queryClient.setQueryData(taskQueryKeys.detail(variables.taskId), context.previousTask);
      }
    },
    onSettled: (data, error, variables) => {
      queryClient.invalidateQueries({ queryKey: taskQueryKeys.detail(variables.taskId) });
      queryClient.invalidateQueries({ queryKey: taskQueryKeys.lists() });
    },
  });
}
```

## Scope Summary

### Hooks to Create

**Wave 1 Infrastructure:**
- task.service.ts: 10 hooks
- project.service.ts: 7 hooks
- execution.service.ts: 7 hooks
- settings.service.ts: 3 hooks
- connection.service.ts: 2-3 hooks (extend existing)

**Total: ~27-28 hooks**

### Components to Migrate

**Wave 2 Refactoring:**
- App.tsx (1 hook)
- ApprovalForm.tsx (1 hook)
- ReviewModal.tsx (1-2 hooks)
- SyncButton.tsx (1 hook)
- TaskCard.tsx (2 hooks)
- TaskModal.tsx (3-4 hooks)
- FilePicker.tsx (1-2 hooks)
- ImportSettings.tsx (1 hook)
- useRecentProjects.ts (2 hooks)

**Total: 9 files, ~16 hook usages**

### Direct invoke() Calls to Replace

Research identified 50+ direct `invoke()` calls across 14 files. After Wave 2, all should be eliminated from component layer (only remain in service layer delegation).

## Dependencies & Risks

### Internal Dependencies

- **Wave 1 → Wave 2:** Wave 2 components depend on Wave 1 hooks being complete
- **Wave 2 → Wave 3:** Wave 3 verification depends on all Wave 2 migrations being complete

### External Dependencies

- **TanStack Query:** Already installed (v5.90.21)
- **Sonner:** Already installed for toast notifications
- **QueryProvider:** Already configured in app

### Known Risks

1. **Query Key Mismatches:** If mutation invalidation keys don't match query definition keys, cache invalidation fails silently. Mitigation: Use centralized query key factories.
2. **Over-aggressive Refetching:** Too many refetchOnWindowFocus or refetchInterval settings cause excessive network requests. Mitigation: Conservative defaults, opt-in per query.
3. **Optimistic Update Rollback:** If optimistic update fails to rollback on error, UI shows incorrect state. Mitigation: Always implement onError + onMutate pair.
4. **Dependent Query Timing:** If dependent queries fire before parent data loads, undefined errors. Mitigation: Always use `enabled: parentData !== null`.

## Quality Gate Criteria

Before Phase 20 is marked complete:

1. ✓ npm run build succeeds with 0 TypeScript errors
2. ✓ npm run tauri:dev launches app without runtime errors
3. ✓ grep "invoke<" src/components/ returns 0 matches
4. ✓ grep "invoke<" src/utils/hooks/ returns 0 matches
5. ✓ All 5 query key factories exist in services
6. ✓ All mutation hooks use cache invalidation
7. ✓ Optimistic updates working in Kanban drag-drop
8. ✓ Manual smoke tests pass (load settings, render tasks, create task, update status)

## Estimated Timeline

**Wave 1 (Parallel):** 3 plans × ~1 hour each = ~3 hours execution (parallel = 1 hour real time)
**Wave 2 (Parallel):** 3 plans × ~1 hour each = ~3 hours execution (parallel = 1 hour real time)
**Wave 3 (Sequential):** 1 plan × ~30 min = ~30 min execution

**Total: ~2.5 hours real execution time (if fully parallelized)**

## Success Metrics

- [x] All 7 PLAN.md files created with valid frontmatter
- [x] Each plan has specific, actionable tasks (2-3 tasks per plan)
- [x] Dependency graph correctly identifies Wave 1 → Wave 2 → Wave 3 sequence
- [x] Files to modify clearly listed in each plan
- [x] must-haves derived from phase goal (no direct invoke() calls, TanStack Query hooks everywhere)
- [x] Context budget respected (all plans under 50% context)
- [x] Verification criteria specific and measurable
- [x] Research document referenced extensively (20-RESEARCH.md)

## Deliverables

**Upon Phase 20 Execution Completion:**
1. All 7 PLAN.md files executed
2. 5 service files with ~27 TanStack Query hooks
3. 9 components refactored to use hooks
4. 0 direct invoke() calls in component layer
5. Phase 20 COMPLETION-REPORT.md with verification results

## Next Steps (if Phase 21 scheduled)

Potential Phase 21 work:
- Real-time updates via WebSocket (currently using polling with refetchInterval)
- Performance monitoring with React Query DevTools
- Advanced cache strategies (selective invalidation, progressive updates)
- Mutation deduplication and request coalescing

---

**Planning Status:** ✓ COMPLETE
**Ready for Execution:** Yes
**Quality Gate:** Passed (all plans valid, dependencies correct, context budgeted)

Generated: 2026-02-26
Phase: 20-refactor-frontend-to-use-tanstack-query
