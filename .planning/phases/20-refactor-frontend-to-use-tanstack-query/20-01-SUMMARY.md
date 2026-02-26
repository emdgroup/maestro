---
phase: 20
plan: 01
subsystem: Frontend Data Layer
tags: [TanStack Query, hooks, data-fetching, caching, mutations]
dependency_graph:
  requires: ["Phase 19 (Service Layer established)"]
  provides: ["Task and Project data layer with automatic caching and optimistic updates"]
  affects: ["Phase 20-02+ (component migrations), all data-dependent components"]
tech_stack:
  added: ["TanStack Query hooks in service files"]
  patterns: ["useQuery with enabled conditions", "useMutation with optimistic updates", "Query key factories"]
key_files:
  created: []
  modified:
    - "src/services/task.service.ts (+204 lines, 295 total)"
    - "src/services/project.service.ts (+145 lines, 249 total)"
decisions:
  - "Query hooks defined in service files (not separate hooks folder) for co-location with business logic"
  - "Query key factories exported for consistent cache invalidation across components"
  - "staleTime tuned by data volatility: tasks/logs 10-30s, projects/settings 5min"
  - "useUpdateTaskStatusMutation implements optimistic updates (onMutate + onError + onSettled)"
  - "All mutations use queryClient.invalidateQueries() for automatic cache consistency"
metrics:
  duration: "0:03:47 (3 min 47 sec)"
  completed_date: "2026-02-26"
  tasks: 2
  files_modified: 2
  lines_added: 349
---

# Phase 20 Plan 01: Add TanStack Query Hooks to Task and Project Services

**Summary:** Added 10 TanStack Query hooks to task.service.ts and 7 to project.service.ts, establishing the primary data layer for Phase 20 with automatic caching, refetching, and optimistic updates.

## Completed Tasks

### Task 1: Add 10 TanStack Query hooks to task.service.ts

**Status:** COMPLETE ✓

**Changes:**
- Added `taskQueryKeys` factory (lines 14-27) providing nested query key structure:
  - all, lists, list(projectId), details, detail(taskId), logs, logsByTask(taskId), settings, settingsByTask(projectId, taskId)

**Query Hooks (Data Fetching):**
1. `useTasksQuery(projectId | null)` (lines 113-125)
   - Fetches all tasks for a project
   - staleTime: 30 seconds (tasks change fairly frequently)
   - enabled: projectId !== null
   - refetchOnWindowFocus: true

2. `useExecutionLogsQuery(taskId | null)` (lines 127-139)
   - Fetches execution logs for a task
   - staleTime: 10 seconds (logs update very frequently)
   - enabled: taskId !== null
   - refetchOnWindowFocus: true

3. `useTaskSettingsQuery(projectId | null, taskId | null)` (lines 141-154)
   - Fetches task configuration and settings
   - staleTime: 60 seconds (settings change rarely)
   - enabled: both projectId and taskId !== null

4. `useDiffForReviewQuery(taskId | null)` (lines 156-169)
   - Fetches diff for code review
   - staleTime: 0 (always fresh—diffs should reflect current state)
   - enabled: taskId !== null

**Mutation Hooks (Write Operations):**
5. `useCreateTaskMutation()` (lines 171-184)
   - Creates new task
   - Invalidates: taskQueryKeys.lists()
   - Error handling: Sonner toast

6. `useUpdateTaskMutation()` (lines 186-201)
   - Updates task details
   - Invalidates: taskQueryKeys.detail(taskId)
   - Error handling: Sonner toast

7. `useUpdateTaskStatusMutation()` (lines 203-232)
   - Updates task status with optimistic updates
   - onMutate: cancels outgoing queries, snapshots previous state, updates cache optimistically
   - onError: rolls back to previous state on failure
   - onSettled: invalidates both detail and lists for consistency
   - Status type: TaskStatus enum (proper type safety)

8. `useRetryExecutionMutation()` (lines 234-247)
   - Retries task execution
   - Invalidates: taskQueryKeys.logsByTask(taskId)
   - Error handling: Sonner toast

9. `useCancelExecutionMutation()` (lines 249-257)
   - Cancels execution
   - Success toast: "Execution cancelled"
   - Error handling: Sonner toast

10. `useUpdateTaskSettingsMutation()` (lines 259-295)
    - Updates task settings/configuration
    - Invalidates: taskQueryKeys.settingsByTask(projectId, taskId)
    - Error handling: Sonner toast

**TypeScript Improvements:**
- Added `TaskStatus` import for type-safe status enums
- Updated `taskService.updateTaskStatus()` signature to accept TaskStatus instead of string
- All mutation callbacks properly typed to suppress TypeScript warnings

**Verification:**
```
✓ npm run build successful (no TypeScript errors)
✓ All 10 hooks exported and callable
✓ taskQueryKeys factory exported for cache consistency
✓ All hooks use TanStack Query hooks (useQuery, useMutation, useQueryClient)
✓ All mutations integrate with Sonner for error/success feedback
✓ Optimistic update pattern visible in useUpdateTaskStatusMutation
✓ staleTime tuned for data volatility (10s, 30s, 60s, 0s)
✓ All query hooks have proper enabled conditions
```

**Files Modified:**
- src/services/task.service.ts: +204 lines (112 → 295 total lines)

**Commit:** 45dd7b1 (feat(20-01): add 10 TanStack Query hooks to task.service.ts)

---

### Task 2: Add 7 TanStack Query hooks to project.service.ts

**Status:** COMPLETE ✓

**Changes:**
- Added `projectQueryKeys` factory (lines 113-121) providing nested query key structure:
  - all, lists, list, details, detail(id), settings, settingsDetail(projectId)

**Query Hooks (Data Fetching):**
1. `useProjectsQuery()` (lines 123-132)
   - Fetches all projects
   - staleTime: 300 seconds (5 min—projects rarely change)
   - refetchOnWindowFocus: true

2. `useProjectQuery(projectId | null)` (lines 134-147)
   - Fetches single project by ID
   - staleTime: 300 seconds (5 min)
   - enabled: projectId !== null

3. `useProjectSettingsQuery(projectId | null)` (lines 149-161)
   - Fetches project configuration and settings
   - staleTime: 300 seconds (5 min)
   - enabled: projectId !== null

**Mutation Hooks (Write Operations):**
4. `useCreateProjectMutation()` (lines 163-183)
   - Creates new project
   - Invalidates: projectQueryKeys.lists()
   - Error handling: Sonner toast

5. `useRemoveProjectMutation()` (lines 185-202)
   - Removes a project
   - Invalidates: projectQueryKeys.lists() and projectQueryKeys.detail(projectId)
   - Error handling: Sonner toast

6. `useUpdateProjectSettingsMutation()` (lines 204-225)
   - Updates project configuration and settings
   - Invalidates: projectQueryKeys.settingsDetail(projectId)
   - Error handling: Sonner toast

7. `useSaveImportConfigMutation()` (lines 227-249)
   - Saves GitHub/Jira import configuration
   - Invalidates: projectQueryKeys.settingsDetail(projectId)
   - Error handling: Sonner toast

**Verification:**
```
✓ npm run build successful (no TypeScript errors)
✓ All 7 hooks exported and callable
✓ projectQueryKeys factory exported for cache consistency
✓ All hooks use TanStack Query hooks (useQuery, useMutation, useQueryClient)
✓ All mutations integrate with Sonner for error/success feedback
✓ Query key factory structure mirrors taskQueryKeys (nested selectors)
✓ staleTime tuned for data volatility (5 min for projects/settings—rarely change)
✓ All query hooks have proper enabled conditions
```

**Files Modified:**
- src/services/project.service.ts: +145 lines (104 → 249 total lines)

**Commit:** dfc5ed1 (feat(20-01): add 7 TanStack Query hooks to project.service.ts)

---

## Overall Verification

**Success Criteria Met:**

✓ **task.service.ts exports 10 hooks**
- useTasksQuery, useExecutionLogsQuery, useTaskSettingsQuery, useDiffForReviewQuery
- useCreateTaskMutation, useUpdateTaskMutation, useUpdateTaskStatusMutation
- useRetryExecutionMutation, useCancelExecutionMutation, useUpdateTaskSettingsMutation

✓ **project.service.ts exports 7 hooks**
- useProjectsQuery, useProjectQuery, useProjectSettingsQuery
- useCreateProjectMutation, useRemoveProjectMutation
- useUpdateProjectSettingsMutation, useSaveImportConfigMutation

✓ **Query key factories exported**
- taskQueryKeys: 9 query key definitions (all, lists, list(projectId), details, detail(taskId), logs, logsByTask(taskId), settings, settingsByTask(projectId, taskId))
- projectQueryKeys: 7 query key definitions (all, lists, list, details, detail(id), settings, settingsDetail(projectId))
- Both exported from service files for cache consistency

✓ **useUpdateTaskStatusMutation implements optimistic updates**
- onMutate: cancels queries, snapshots state, updates cache optimistically
- onError: rolls back to previous state
- onSettled: invalidates both detail and lists

✓ **All mutation hooks use queryClient.invalidateQueries()**
- createTask invalidates taskQueryKeys.lists()
- updateTask invalidates taskQueryKeys.detail(taskId)
- updateTaskStatus invalidates both detail and lists
- retryExecution invalidates taskQueryKeys.logsByTask(taskId)
- cancelExecution (no cache invalidation needed)
- updateTaskSettings invalidates taskQueryKeys.settingsByTask(projectId, taskId)
- createProject invalidates projectQueryKeys.lists()
- removeProject invalidates lists and detail
- updateProjectSettings invalidates projectQueryKeys.settingsDetail(projectId)
- saveImportConfig invalidates projectQueryKeys.settingsDetail(projectId)

✓ **Query hooks with staleTime configured based on data volatility**
- Task data: 30 seconds (changes fairly frequently)
- Execution logs: 10 seconds (changes very frequently)
- Task settings: 60 seconds (changes rarely)
- Diff for review: 0 seconds (always fresh)
- Project data: 5 minutes (rarely changes)
- Project settings: 5 minutes (rarely changes)

✓ **All query hooks have proper enabled conditions**
- useTasksQuery(projectId): enabled: projectId !== null
- useExecutionLogsQuery(taskId): enabled: taskId !== null
- useTaskSettingsQuery(projectId, taskId): enabled: projectId !== null && taskId !== null
- useDiffForReviewQuery(taskId): enabled: taskId !== null
- useProjectQuery(projectId): enabled: projectId !== null
- useProjectSettingsQuery(projectId): enabled: projectId !== null

✓ **TypeScript compilation successful**
- 0 TypeScript errors
- All hooks properly typed with generics
- QueryClient type inference working
- Sonner toast integration verified

✓ **Build verification passed**
- npm run build: ✓ PASSED
- Production bundle verification: ✓ PASSED (CSS coverage OK, no mock code)
- 3286 modules transformed

---

## Architecture Impact

**Data Layer Now Follows TanStack Query Standard:**
- All data operations wrapped with consistent useQuery/useMutation patterns
- Automatic caching, refetching, deduplication via QueryClient
- Optimistic updates for better perceived performance (useUpdateTaskStatusMutation)
- Query key factories for cache invalidation consistency
- Proper enabled conditions prevent queries running with undefined parameters
- Sonner integration for consistent error/success feedback

**Ready for Phase 20-02 (Component Migrations):**
- Services now provide both raw methods (for non-React code) and hooks (for components)
- Components can migrate to query hooks with minimal changes
- Cache invalidation strategies pre-configured for common operations
- 17 of 27 planned hooks complete (63%)

---

## Deviations from Plan

None - plan executed exactly as written. All 10 task hooks and 7 project hooks implemented with proper patterns.

## Next Steps

Phase 20-02: Execute execution, settings, and connection service queries and mutations (remaining 10 hooks)
Phase 20-03+: Migrate components to use query hooks instead of direct service calls

---

## Self-Check

✓ src/services/task.service.ts exists and contains 10 hooks + taskQueryKeys
✓ src/services/project.service.ts exists and contains 7 hooks + projectQueryKeys
✓ All commits present:
  - 45dd7b1: feat(20-01): add 10 TanStack Query hooks to task.service.ts
  - dfc5ed1: feat(20-01): add 7 TanStack Query hooks to project.service.ts
✓ Build verification: Production bundle passed (CSS coverage OK, no mock code)
✓ TypeScript verification: 0 errors
✓ All 17 hooks properly typed and exported

**PASSED**
