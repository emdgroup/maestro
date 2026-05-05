# Frontend Code Audit — 2026-05-05

Structured findings from full frontend scan. Work through issues one at a time.

---

## BUGS

- [ ] **BUG-1**: `src/services/project.service.ts:163-164` — `JSON.parse(importConfig.toString())` crashes on any object input. `.toString()` → `"[object Object]"` → SyntaxError.
- [ ] **BUG-2**: `src/services/settings.service.ts:62` — `toast.error(\`Failed to save settings: ${error}\`)` prints `[object Object]` for non-string errors. Use `createErrorToastHandler`.
- [ ] **BUG-3**: `src/store/projectStore.ts:21` — `void api.releaseActiveProjectLock()` silently swallows errors. Needs `.catch()`.

---

## CACHE COHERENCY

- [ ] **CACHE-1**: `src/utils/hooks/useExecuteTask.ts` — Calls `api.*` directly, bypasses React Query cache invalidation. Should use service mutations.
- [ ] **CACHE-2**: `src/providers/ThemeProvider.tsx:97,133` — Calls `api.getSettings()`/`api.saveSettings()` directly, doesn't invalidate `["settings"]` cache.
- [ ] **CACHE-3**: `src/services/execution.service.ts:140` — Hardcoded `["tasks"]` query key instead of `taskQueryKeys.all`.

---

## PERFORMANCE (unnecessary re-renders)

- [x] **PERF-1**: `src/contexts/ConnectionContext.tsx:41` — Handled by React Compiler (auto-memoizes context value).
- [x] **PERF-2**: `src/contexts/KanbanContext.tsx:29` — Handled by React Compiler.
- [x] **PERF-3**: `src/store/navigationStore.ts` — Fixed with `useShallow`.
- [x] **PERF-4**: `src/store/projectStore.ts` — Fixed with `useShallow`.

---

## DEAD CODE

- [ ] **DEAD-1**: `src/components/kanban/KanbanBoard.tsx` — Entire component never imported. Delete file.
- [ ] **DEAD-2**: `src/components/kanban/KanbanColumn.tsx:7` — `columnId` prop defined but never used.
- [ ] **DEAD-3**: `src/components/common/SettingsPage.tsx:34` — `_projectPath` unused parameter.
- [ ] **DEAD-4**: `src/utils/helpers/diff-utils.ts:201` — `extractFileNames` exported but never imported.
- [ ] **DEAD-5**: `src/types/review.ts:53-83` — `DiffLine`, `DiffHunk`, `ReviewFeedback`, `SaveReviewResponse`, `RequestChangesResponse` all unused.

---

## DUPLICATED CODE

- [ ] **DUP-1**: `PRIORITY_BADGE_CLASSES` defined identically in `src/components/views/BacklogView.tsx:16` and `src/components/views/ArchiveView.tsx:10`. Extract shared constant.
- [ ] **DUP-2**: `src/services/project.service.ts` — 7 inline `toast.error` handlers duplicate `createErrorToastHandler` logic.

---

## PATTERN INCONSISTENCIES

- [ ] **PAT-1**: Store interface naming — `projectStore` and `sessionActivityStore` use `*Store` suffix; others use `*State`.
- [ ] **PAT-2**: Loading state naming — `configStore` uses `isLoading`, `reviewStore` uses `loading`.
- [ ] **PAT-3**: `void` on `invalidateQueries` — missing in `execution.service.ts` and `worktree.service.ts` (all other services use it).
- [ ] **PAT-4**: Query key structure — `baseKey` vs `all` vs flat ad-hoc keys across services.
- [ ] **PAT-5**: `src/services/settings.service.ts:2` imports `api` from deep path `"@/utils/helpers/tauri-utils"` instead of `"@/lib"`.
- [ ] **PAT-6**: `src/utils/hooks/index.ts` barrel incomplete — missing `useConnectionHealth` and `useExecuteTask`.
- [ ] **PAT-7**: Only 2/6 stores export selector hooks; others expose raw store only.

---

## STYLING VIOLATIONS

- [ ] **STYLE-1**: `src/components/common/ReviewModal.tsx` — BEM classes (`review-modal-*`) instead of Tailwind.
- [ ] **STYLE-2**: `src/components/common/ApprovalForm.tsx` — BEM classes (`approval-form-*`) instead of Tailwind.
- [ ] **STYLE-3**: `src/components/common/SyncButton.tsx:52` — `btn-sync`/`spinner` classes + raw `<button>` instead of `<Button>` component.

---

## LARGE COMPONENTS (future decomposition)

- [ ] **SIZE-1**: `src/components/execution/AgentActivityPanel.tsx` — 515 lines, 7+ state vars, helper functions at bottom.
- [ ] **SIZE-2**: `src/views/WorktreesView.tsx` — 398 lines, 2 dialogs + filtering + grouping.
- [ ] **SIZE-3**: `src/views/AgentsView.tsx` — 333 lines, spawn dialog + session selection + history.

---

## MINOR

- [ ] **MINOR-1**: `src/components/kanban/BacklogTaskSheet.tsx:8` — Interface named `BacklogTaskPanelProps` but component is `BacklogTaskSheet`.
- [ ] **MINOR-2**: `src/App.tsx:133-143` — Triple-nested ternary for state switching.
- [ ] **MINOR-3**: Component export style mix (`React.FC` vs `export function` vs `const =`).
