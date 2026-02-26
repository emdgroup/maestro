---
phase: 20
plan: 02
subsystem: Frontend Data Layer
tags: [TanStack Query, hooks, data-fetching, mutations, execution, settings]
dependency_graph:
  requires: ["Phase 20-01 (Task and Project Query Hooks established)"]
  provides: ["Execution and Settings mutation/query hooks for App.tsx and component migrations"]
  affects: ["Phase 20-03+ (component migrations), all execution and settings-dependent components"]
tech_stack:
  added: ["TanStack Query mutation hooks in execution.service.ts", "TanStack Query query/mutation hooks in settings.service.ts"]
  patterns: ["useMutation for side-effect operations", "useQuery with staleTime tuning", "Query key factories", "Sonner toast error handling"]
key_files:
  created: []
  modified:
    - "src/services/execution.service.ts (+147 lines, 227 total)"
    - "src/services/settings.service.ts (+58 lines, 88 total)"
decisions:
  - "Execution mutations are fire-and-forget RPC operations with no complex cache invalidation needed"
  - "Settings staleTime: 600000ms (10min) for getSettings, Infinity for system accent color (OS-level, rarely changes)"
  - "All mutations have onError toast.error callbacks for consistent error feedback"
  - "useSaveSettingsMutation invalidates settingsQueryKeys.lists() to keep UI in sync"
  - "Query hooks use refetchOnWindowFocus: true for data consistency when tab switches"
metrics:
  duration: "0:02:37 (2 min 37 sec)"
  completed_date: "2026-02-26"
  tasks: 2
  files_modified: 2
  lines_added: 205
---

# Phase 20 Plan 02: Add TanStack Query Hooks to Execution and Settings Services

**Summary:** Added 7 TanStack Query mutation hooks to execution.service.ts and 3 hooks (query + mutation) to settings.service.ts, completing Wave 1 infrastructure with 21 total hooks across 4 service files (task + project + execution + settings).

## Completed Tasks

### Task 1: Add 7 mutation hooks to execution.service.ts

**Status:** COMPLETE ✓

**Changes:**
- Added `executionQueryKeys` factory (lines 82-86) for consistency and potential future cache invalidation
  - all, details, detail(executionId)

**Mutation Hooks (All Side-Effect Operations):**
1. `useSpawnExecutionMutation()` (lines 92-107)
   - Calls executionService.spawnAgentExecution(projectId, taskId, repoPath)
   - Fire-and-forget side effect (no cache invalidation)
   - onError: toast.error with error message

2. `usePauseExecutionMutation()` (lines 110-121)
   - Calls executionService.pauseAgentExecution(taskId)
   - onError: toast.error with error message

3. `useResumeExecutionMutation()` (lines 124-141)
   - Calls executionService.resumeAgentExecution(taskId, projectId, repoPath)
   - onError: toast.error with error message

4. `useAttachTerminalMutation()` (lines 144-159)
   - Calls executionService.attachTerminal(taskId, outputChannel)
   - onError: toast.error with error message

5. `useDetachTerminalMutation()` (lines 162-173)
   - Calls executionService.detachTerminal(taskId)
   - onError: toast.error with error message

6. `useSendTerminalInputMutation()` (lines 176-191)
   - Calls executionService.sendTerminalInput(taskId, input)
   - onError: toast.error with error message

7. `useResizeTerminalMutation()` (lines 194-211)
   - Calls executionService.resizeTerminal(taskId, cols, rows)
   - onError: toast.error with error message

**Architecture Notes:**
- Execution mutations are primarily RPC side-effects (remote procedure calls)
- No data fetching involved; no complex cache invalidation needed
- All mutations accept typed parameters with proper TypeScript inference
- Error handling via Sonner toast for consistent user feedback across app

**Files Modified:**
- src/services/execution.service.ts: +147 lines (80 → 227 total lines)

**Commit:** 3b878cc (feat(20-02): add 7 TanStack Query mutation hooks to execution.service.ts)

---

### Task 2: Add 3 hooks to settings.service.ts

**Status:** COMPLETE ✓

**Changes:**
- Added `settingsQueryKeys` factory (lines 32-37) for global settings state
  - all, lists, accentColor

**Query Hooks (Data Fetching):**
1. `useSettingsQuery()` (lines 40-48)
   - Fetches all application settings
   - staleTime: 600000ms (10 minutes—settings rarely change)
   - refetchOnWindowFocus: true (ensures fresh data if user switches tabs)
   - Global app state, no parameters needed

2. `useSystemAccentColorQuery()` (lines 51-59)
   - Fetches OS system accent color
   - staleTime: Infinity (OS color doesn't change until app restart)
   - refetchOnWindowFocus: true (refetch if window focus lost/regained, may have changed appearance)
   - Provides dynamic theme accent color integration

**Mutation Hook (Write Operation):**
3. `useSaveSettingsMutation()` (lines 62-77)
   - Saves application settings via settingsService.saveSettings(settings)
   - onSuccess: Invalidates settingsQueryKeys.lists() + shows "Settings saved" toast
   - onError: Shows "Failed to save settings: {error}" toast
   - Ensures cache consistency after persistence

**Architecture Notes:**
- Settings are global app state (not project-specific)
- staleTime tuned for data volatility: settings persist long (10min), OS color persists until restart (Infinity)
- Both queries use refetchOnWindowFocus: true for multi-window scenarios (user may change OS theme while app is in background)
- Mutation cache invalidation ensures UI stays in sync with persisted state

**Files Modified:**
- src/services/settings.service.ts: +58 lines (30 → 88 total lines)

**Commit:** 13d8c17 (feat(20-02): add 3 TanStack Query hooks to settings.service.ts)

---

## Overall Verification

**Success Criteria Met:**

✓ **execution.service.ts exports 7 mutation hooks**
- useSpawnExecutionMutation
- usePauseExecutionMutation
- useResumeExecutionMutation
- useAttachTerminalMutation
- useDetachTerminalMutation
- useSendTerminalInputMutation
- useResizeTerminalMutation

✓ **settings.service.ts exports 3 hooks**
- useSettingsQuery
- useSystemAccentColorQuery
- useSaveSettingsMutation

✓ **Query key factories exported**
- executionQueryKeys: 3 query key definitions (all, details, detail(executionId))
- settingsQueryKeys: 3 query key definitions (all, lists, accentColor)

✓ **All execution mutations have toast error handling**
- 7 onError callbacks with toast.error(...)
- Consistent error feedback across execution operations

✓ **Settings query hooks have appropriate staleTime tuning**
- useSettingsQuery: 600000ms (10 minutes—settings rarely change)
- useSystemAccentColorQuery: Infinity (OS color doesn't change until restart)
- Both queries: refetchOnWindowFocus: true

✓ **Settings mutation has proper cache invalidation**
- useSaveSettingsMutation: invalidates settingsQueryKeys.lists() on success
- Shows success toast: "Settings saved"
- Shows error toast on failure with error message

✓ **No direct invoke() calls in mutation callbacks**
- All mutations delegate to service methods (executionService.*, settingsService.*)
- Service layer pattern maintained for testability and centralization

✓ **Execution mutations focused on RPC side-effects, not data fetching**
- All mutations are write-only operations
- No query hooks needed (no data fetching from execution service)
- Simple fire-and-forget pattern with error handling

✓ **TypeScript compilation successful**
- npm run build: ✓ PASSED
- 0 TypeScript errors
- All hooks properly typed with generics
- Production bundle verification: ✓ PASSED (CSS coverage OK, no mock code)

---

## Wave 1 Infrastructure Summary

**Phase 20-01 (Task + Project Services):** 17 hooks
- 10 query/mutation hooks in task.service.ts
- 7 query/mutation hooks in project.service.ts

**Phase 20-02 (Execution + Settings Services):** 10 hooks
- 7 mutation hooks in execution.service.ts
- 3 query/mutation hooks in settings.service.ts

**Total Wave 1:** 27 hooks across 4 service files with consistent TanStack Query patterns, query key factories, and error handling via Sonner toast.

**Ready for Phase 20-03:** Component migration to use service query hooks instead of direct IPC calls. Core infrastructure now in place for automatic caching, refetching, and optimistic updates across all data operations.

---

## Deviations from Plan

None - plan executed exactly as written. All 7 execution mutation hooks and 3 settings hooks implemented with proper patterns and error handling.

## Next Steps

Phase 20-03+: Migrate components to use query hooks from services
- App.tsx to use useSettingsQuery, useSystemAccentColorQuery
- Execution components to use execution mutation hooks
- Settings components to use useSettingsQuery and useSaveSettingsMutation
- Continue with connection.service.ts queries and remaining migrations

---

## Self-Check

✓ src/services/execution.service.ts exists and contains 7 mutation hooks + executionQueryKeys
✓ src/services/settings.service.ts exists and contains 3 hooks + settingsQueryKeys (2 query + 1 mutation)
✓ All commits present:
  - 3b878cc: feat(20-02): add 7 TanStack Query mutation hooks to execution.service.ts
  - 13d8c17: feat(20-02): add 3 TanStack Query hooks to settings.service.ts
✓ Build verification: npm run build PASSED (CSS coverage OK, no mock code)
✓ TypeScript verification: 0 errors
✓ All 10 hooks properly typed and exported
✓ Execution mutations have 7 onError toast callbacks
✓ Settings hooks have tuned staleTime values and proper cache invalidation
✓ Query key factories exported for both services
✓ Wave 1 infrastructure: 21 hooks created (task 10 + project 7 + execution 7 + settings 3)

**PASSED**
