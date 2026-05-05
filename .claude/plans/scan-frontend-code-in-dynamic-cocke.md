# Frontend Code Inconsistency Audit

## Context

Comprehensive scan of the React/TypeScript frontend for pattern violations, inconsistencies, dead code, and latent bugs. Findings organized by severity.

---

## BUGS (will crash or produce wrong behavior)

### 1. `JSON.parse(importConfig.toString())` crashes on any object input
- **File**: `src/services/project.service.ts:163-164`
- `importConfig` is `Record<string, unknown>`. `.toString()` on an object → `"[object Object]"` → `JSON.parse` throws `SyntaxError`.
- **Fix**: Pass `importConfig` directly to `api.saveImportConfig()`, or use `JSON.stringify` if serialization is needed.

### 2. `settings.service.ts:62` broken error interpolation
- **File**: `src/services/settings.service.ts:62`
- `toast.error(\`Failed to save settings: ${error}\`)` — if `error` is an object, prints `[object Object]`.
- **Fix**: Use `createErrorToastHandler("Failed to save settings")` (already exists in `error-utils.ts`).

### 3. Fire-and-forget API call with no error handling in projectStore
- **File**: `src/store/projectStore.ts:21`
- `void api.releaseActiveProjectLock()` — if this throws, error is silently swallowed.
- **Fix**: Add `.catch(console.error)` or wrap in try/catch.

---

## CACHE COHERENCY ISSUES

### 4. `useExecuteTask` bypasses service layer
- **File**: `src/utils/hooks/useExecuteTask.ts:13-48`
- Calls `api.listWorktreesWithStatus`, `api.createWorktree`, `api.spawnInteractiveExecution` directly.
- No React Query cache invalidation after worktree creation or session spawn.
- **Fix**: Use `useCreateWorktreeMutation` and `useSpawnInteractiveExecutionMutation` from service files.

### 5. ThemeProvider bypasses settings service
- **File**: `src/providers/ThemeProvider.tsx:97,133`
- Directly calls `api.getSettings()` / `api.saveSettings()` without invalidating `["settings"]` query cache.
- If settings page reads via `useSettings()`, it won't see theme changes.
- **Fix**: Accept this as intentional (ThemeProvider loads before QueryProvider) or invalidate manually.

### 6. Hardcoded query key `["tasks"]` in execution service
- **File**: `src/services/execution.service.ts:140`
- Should use `taskQueryKeys.all` from `task.service.ts`.

---

## UNNECESSARY RE-RENDERS

### 7. Context values without `useMemo`
- `src/contexts/ConnectionContext.tsx:41` — new object every render
- `src/contexts/KanbanContext.tsx:29` — new object every render
- **Fix**: Wrap in `useMemo` with appropriate deps.

### 8. Selector action hooks return new object references
- `src/store/navigationStore.ts:117-123` — `useNavigationActions` creates new object each call
- `src/store/projectStore.ts:29-33` — `useSelectedProjectActions` same issue
- **Fix**: Use `useShallow` from Zustand or memoize.

---

## DEAD CODE

### 9. `KanbanBoard` component never imported
- **File**: `src/components/kanban/KanbanBoard.tsx`
- Exported but zero consumers. Entire file is dead code.

### 10. `columnId` prop defined but never used
- **File**: `src/components/kanban/KanbanColumn.tsx:7,40`
- Prop in interface, not destructured in component.

### 11. `_projectPath` unused parameter
- **File**: `src/components/common/SettingsPage.tsx:34`

### 12. Dead exports in `src/utils/helpers/diff-utils.ts`
- `extractFileNames` (line 201) — never imported anywhere.

### 13. Dead types in `src/types/review.ts`
- `DiffLine`, `DiffHunk` (53-57), `ReviewFeedback` (64-72), `SaveReviewResponse` (74-77), `RequestChangesResponse` (79-83) — none imported anywhere.

---

## DUPLICATED CODE

### 14. `PRIORITY_BADGE_CLASSES` defined identically in two files
- `src/components/views/BacklogView.tsx:16`
- `src/components/views/ArchiveView.tsx:10`
- Same mapping, should be a shared constant.
- Note: `ArchiveView` types it as `Record<string, string>` vs `Record<TaskPriority, string>` — type inconsistency too.

### 15. Inline error handlers in `project.service.ts` duplicate `createErrorToastHandler`
- 7 occurrences of inline `toast.error` with manual `instanceof Error` check.
- `createErrorToastHandler` already does this correctly.

---

## PATTERN INCONSISTENCIES

### 16. Store state interface naming
| Store | Interface Name | Suffix |
|-------|---------------|--------|
| boardStore | `BoardState` | State |
| configStore | `ConfigState` | State |
| navigationStore | `NavigationState` | State |
| projectStore | `ProjectStore` | **Store** |
| sessionActivityStore | `SessionActivityStore` | **Store** |
| reviewStore | `ReviewState` | State |

### 17. Loading state naming
- `configStore.ts:13` uses `isLoading`
- `reviewStore.ts:9` uses `loading`

### 18. Inconsistent `void` on `invalidateQueries`
- `connection.service.ts`, `project.service.ts`, `task.service.ts` → always `void`
- `execution.service.ts`, `worktree.service.ts` → never `void` (floating promises)

### 19. Query key structure inconsistency
- `connectionQueryKeys` / `projectQueryKeys` → use `baseKey` property
- `taskQueryKeys` / `worktreeQueryKeys` / `settingsQueryKeys` → use `all` property
- `executionQueryKeys` → flat ad-hoc keys with no structure

### 20. Import path for `api`
- `src/services/settings.service.ts:2` → imports from `"@/utils/helpers/tauri-utils"` (deep path)
- All other services → import from `"@/lib"` (barrel alias)

### 21. Hook barrel file incomplete
- `src/utils/hooks/index.ts` doesn't export `useConnectionHealth` or `useExecuteTask`
- Consumers use direct imports like `@/hooks/useExecuteTask`

### 22. Selector hook pattern inconsistent
- Only `navigationStore` and `projectStore` export custom selector hooks
- Other 4 stores expose only raw store (consumers write inline selectors)

---

## RECOMMENDED FIXES (prioritized)

**Batch 1 — Bugs (fix immediately):**
1. Fix `project.service.ts:164` — remove `.toString()` / `JSON.parse`
2. Fix `settings.service.ts:62` — use `createErrorToastHandler`
3. Add error handling to `projectStore.ts:21`

**Batch 2 — Cache coherency:**
4. Refactor `useExecuteTask` to use service mutations
5. Replace hardcoded `["tasks"]` with `taskQueryKeys.all` in execution service

**Batch 3 — Performance:**
6. Add `useMemo` to ConnectionContext and KanbanContext values
7. Fix action selector hooks with `useShallow`

**Batch 4 — Cleanup:**
8. Delete `KanbanBoard.tsx` (dead code)
9. Remove unused `columnId` prop from KanbanColumn
10. Remove dead types from `review.ts`
11. Remove `extractFileNames` from diff-utils
12. Extract shared `PRIORITY_BADGE_CLASSES` constant
13. Standardize `project.service.ts` error handlers to use `createErrorToastHandler`
14. Add `void` prefix to floating promises in execution/worktree services
15. Fix import path in `settings.service.ts`

---

## STYLING PATTERN VIOLATIONS

### 23. BEM/custom CSS classes in 3 components (rest of app uses Tailwind)
- `src/components/common/ReviewModal.tsx` — uses `review-modal-overlay`, `review-modal-content`, `review-modal-header`, etc.
- `src/components/common/ApprovalForm.tsx` — uses `approval-form`, `approval-form-section`, `approval-form-heading`, etc.
- `src/components/common/SyncButton.tsx:52` — uses `btn-sync`, `spinner` classes + raw `<button>` instead of `<Button>` component.
- Every other component in the app uses Tailwind utility classes.

### 24. Component export style mix
- `React.FC<Props>` — AgentsView, KanbanView, WorktreesView, TaskCard, KanbanColumn
- `export function X(...)` — TaskModal, BacklogTaskSheet, ThemeToggle, AppHeader, BacklogView, BoardView, AgentMonitor
- `export const X = () =>` (no annotation) — KanbanBoard
- Not a bug, but noisy signal during review.

---

## LARGE COMPONENTS (decomposition candidates)

| File | Lines | Concern |
|------|-------|---------|
| `AgentActivityPanel.tsx` | 515 | Handles lifecycle, scroll, permissions, elicitation, messages, model selection, rendering + 4 helper functions at bottom |
| `WorktreesView.tsx` | 398 | 2 dialogs, filtering, grouping, view modes, slide navigation |
| `AgentsView.tsx` | 333 | Spawn dialog, session selection, history, search |
| `AgentMonitor.tsx` | 315 | Sidebar, content, rename, usage, grouping |

---

## MISSING MEMOIZATION IN VIEWS

### 25. Filtered/sorted lists recomputed every render without `useMemo`
- `BacklogView.tsx:47-53` — sorts and filters tasks inline
- `BoardView.tsx:43-46` — filters tasks per column inline
- `ArchiveView.tsx:50-54` — filters and sorts archive tasks inline
- `AgentsView.tsx:63` — filters sessions inline

These are fine at small scale but will cause unnecessary work as task counts grow.

### 26. Handler functions passed as props without `useCallback`
- `AgentsView` — `handleCloseSession`, `handleSpawn` passed to children, recreated every render
- `WorktreesView` — `toggleGroup`, `toggleAll` passed as props
- `BacklogView` — `handlePromote`, `handleDelete`, `openEdit` passed as props

---

## PROP / INTERFACE ISSUES

### 27. Interface name doesn't match component
- `src/components/kanban/BacklogTaskSheet.tsx:8` — Interface `BacklogTaskPanelProps` but component is `BacklogTaskSheet`

### 28. Nested ternary in App.tsx hard to read
- `src/App.tsx:133-143` — Triple-nested ternary for loading/error/picker/main state

---

## Verification

After fixes:
1. `pnpm lint` — should pass clean
2. `pnpm test` — all existing tests pass
3. `pnpm tauri:dev` — smoke test: create task, execute agent, change theme, import config
4. Verify no `[object Object]` in toast messages
