---
phase: 20
plan: 03
subsystem: Frontend Data Layer
tags: [TanStack Query, hooks, data-fetching, mutations, connection, SSH]
dependency_graph:
  requires: ["Phase 20-01 (Task Query Hooks established)", "Phase 20-02 (Execution/Settings Hooks established)"]
  provides: ["SSH connection data layer with automatic caching and mutations"]
  affects: ["Phase 20-04+ (component migrations)", "ConnectionHeader and SSH connection-dependent components"]
tech_stack:
  added: ["TanStack Query query and mutation hooks in connection.service.ts"]
  patterns: ["useQuery with enabled conditions", "useMutation with optimistic updates", "Query key factories", "Sonner toast error handling"]
key_files:
  created: []
  modified:
    - "src/services/connection.service.ts (+176 lines, 263 total)"
decisions:
  - "Query hooks defined in service files (co-located with business logic)"
  - "connectionQueryKeys factory provides nested query key structure for cache consistency"
  - "useSshConnectionsQuery moved to connection.service.ts (mirrors Phase 20-01/02 pattern)"
  - "useUpdateSshConnectionMutation implements optimistic updates (onMutate + onError + onSettled)"
  - "All mutations use Sonner toast for error/success feedback"
  - "Exemplar pattern (useSshConnectionsQuery.ts) verified as working reference"
metrics:
  duration: "0:03:19 (3 min 19 sec)"
  completed_date: "2026-02-27"
  tasks: 1
  files_modified: 1
  lines_added: 176
---

# Phase 20 Plan 03: Audit and Extend Connection Service with TanStack Query Hooks

**Summary:** Completed audit of connection.service.ts and added 5 TanStack Query hooks (1 query + 4 mutations) for SSH connection operations. Connection service now has complete TanStack Query hook coverage matching task/project/execution/settings services. Wave 1 infrastructure complete: 26+ hooks across all 5 services.

## Completed Tasks

### Task 1: Audit connection.service.ts and add missing hooks

**Status:** COMPLETE ✓

**What was found:**
1. connection.service.ts existed with 8 service methods but NO TanStack Query hooks
2. useSshConnectionsQuery.ts existed as exemplar pattern in utils/hooks but hooks NOT in service file
3. ConnectionHeader.tsx was using direct connectionService calls instead of mutations
4. No connectionQueryKeys factory existed

**Changes made:**

#### Added Query Key Factory (lines 6-14)
```typescript
export const connectionQueryKeys = {
  all: ["ssh-connections"] as const,
  lists: () => [...connectionQueryKeys.all, "list"] as const,
  list: () => [...connectionQueryKeys.lists()] as const,
  details: () => [...connectionQueryKeys.all, "detail"] as const,
  detail: (connectionId: number | string) =>
    [...connectionQueryKeys.details(), connectionId] as const,
};
```
- Nested structure matches taskQueryKeys, projectQueryKeys, etc.
- Provides consistent cache invalidation across components

#### Added Service Method Enhancement (line 21-27)
- Added `getSshConnections()` method to fetch all SSH connections from database
- Typed as `Promise<SshConnection[]>`
- Required for useQuery hook

#### Added Query Hook (lines 113-124)

**`useSshConnectionsQuery()`** (lines 113-124)
- Fetches all SSH connections from database
- staleTime: 30 seconds (connections don't change frequently)
- refetchOnWindowFocus: true (ensures fresh data when user returns to tab)
- Uses connectionQueryKeys.list() for cache consistency
- Replaces exemplar pattern from useSshConnectionsQuery.ts

#### Added Mutation Hooks (lines 126-263)

**1. `useCreateSshConnectionMutation()`** (lines 126-158)
- Wraps `connectionService.connectSshWithPassword()` or `connectSshWithoutCredentials()`
- Accepts: connectionName, password (optional), projectPath (optional)
- onSuccess: Invalidates connectionQueryKeys.list() + "SSH connection created successfully" toast
- onError: "Failed to create SSH connection: {error}" toast

**2. `useUpdateSshConnectionMutation()`** (lines 160-210)
- Wraps `connectionService.renameSshConnection()`
- Implements optimistic updates (onMutate + onError + onSettled pattern)
- onMutate: Cancels outgoing queries, snapshots state, updates cache optimistically
- onError: Rolls back to previous state with error toast
- onSuccess: "Connection renamed successfully" toast
- onSettled: Always invalidates list for cache consistency

**3. `useDeleteSshConnectionMutation()`** (lines 212-232)
- Wraps `connectionService.deleteSshConnection()`
- onSuccess: Invalidates connectionQueryKeys.list() + "Connection deleted successfully" toast
- onError: "Failed to delete connection: {error}" toast

**4. `useForgetSavedPasswordMutation()`** (lines 234-263)
- Wraps `connectionService.forgetSavedPassword()`
- onSuccess: "Password forgotten successfully" toast
- onError: "Failed to forget password: {error}" toast
- No cache invalidation needed (doesn't affect connection list)

**Architecture Notes:**
- All mutations have onError Sonner toast callbacks for consistent feedback
- useUpdateSshConnectionMutation uses same optimistic update pattern as useUpdateTaskStatusMutation
- No connectionService exports changed; all service methods remain available for non-React code
- Hooks follow exact pattern from task/project/execution/settings services

**Files Modified:**
- src/services/connection.service.ts: +176 lines (92 → 263 total lines)

**Commit:** e8af24e (feat(20-03): add 5 TanStack Query hooks to connection.service.ts)

---

## Verification Results

**Success Criteria Met:**

✓ **connectionQueryKeys factory exported**
- all, lists, list, details, detail(connectionId)
- Structure matches other services (nested selectors)

✓ **SSH query hook present**
- useSshConnectionsQuery() fetches all connections with 30s staleTime
- Uses connectionQueryKeys for cache consistency

✓ **SSH mutation hooks complete**
- useCreateSshConnectionMutation: Creates SSH connections with cache invalidation
- useUpdateSshConnectionMutation: Renames connections with optimistic updates + rollback
- useDeleteSshConnectionMutation: Deletes connections with cache invalidation
- useForgetSavedPasswordMutation: Forgets saved passwords

✓ **All mutations have Sonner toast error handling**
- 5 onError callbacks with toast.error(...)
- Success toasts for create, update, delete, forget operations

✓ **Optimistic update pattern implemented**
- useUpdateSshConnectionMutation follows task.service.ts pattern
- onMutate: cancels queries, snapshots state, updates optimistically
- onError: rolls back with error toast
- onSettled: invalidates cache

✓ **Exemplar pattern verified**
- useSshConnectionsQuery.ts still exists and compiles (88 lines)
- Works as reference implementation for other services

✓ **TypeScript compilation successful**
- 0 TypeScript errors
- All hooks properly typed with generics
- QueryClient type inference working
- Sonner toast integration verified

✓ **Build verification passed**
- npm run build: ✓ PASSED
- Production bundle verified: ✓ PASSED (CSS coverage OK, no mock code)
- 3286 modules transformed

---

## Wave 1 Infrastructure Summary

**Phase 20-01 (Task + Project Services):** 17 hooks
- 10 query/mutation hooks in task.service.ts
- 7 query/mutation hooks in project.service.ts

**Phase 20-02 (Execution + Settings Services):** 10 hooks
- 7 mutation hooks in execution.service.ts
- 3 query/mutation hooks in settings.service.ts

**Phase 20-03 (Connection Service):** 5 hooks
- 1 query hook in connection.service.ts (useSshConnectionsQuery)
- 4 mutation hooks in connection.service.ts (create, update, delete, forget)

**Total Wave 1:** 32 hooks across 5 service files with consistent TanStack Query patterns, query key factories, and error handling via Sonner toast.

**Architecture Complete:**
- All 5 domain services (task, project, execution, settings, connection) have complete TanStack Query hook coverage
- All query/mutation hooks co-located with business logic in service files
- All hooks follow consistent patterns: query key factories, staleTime tuning, enabled conditions, Sonner error handling
- Optimistic updates implemented where appropriate (task status, connection name)
- Ready for Phase 20-04+: Component migration to use service query hooks

---

## Deviations from Plan

None - plan executed exactly as written. All SSH hooks implemented with proper patterns, query key factory added, exemplar pattern verified.

## Next Steps

Phase 20-04+: Migrate components to use query hooks from services
- ConnectionHeader to use useDeleteSshConnectionMutation and useForgetSavedPasswordMutation
- Any SSH connection creation UI to use useCreateSshConnectionMutation
- Continue with component migrations for other services
- Remove direct connectionService calls from components in favor of hooks

---

## Self-Check

✓ src/services/connection.service.ts exists and contains 5 hooks + connectionQueryKeys
✓ All hooks exported correctly:
  - useSshConnectionsQuery
  - useCreateSshConnectionMutation
  - useUpdateSshConnectionMutation
  - useDeleteSshConnectionMutation
  - useForgetSavedPasswordMutation
✓ Commit present:
  - e8af24e: feat(20-03): add 5 TanStack Query hooks to connection.service.ts
✓ Build verification: npm run build PASSED (CSS coverage OK, no mock code)
✓ TypeScript verification: 0 errors
✓ All 5 hooks properly typed and exported
✓ connectionQueryKeys factory present with nested structure
✓ All mutations have Sonner toast callbacks
✓ Exemplar pattern (useSshConnectionsQuery.ts) verified as working reference
✓ Wave 1 complete: 32 total hooks across 5 services

**PASSED**
