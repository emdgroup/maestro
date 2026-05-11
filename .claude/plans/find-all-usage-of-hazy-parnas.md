# useEffect Audit — Remove Unnecessary Effects

## Context

Audit of all 76 `useEffect` calls in the frontend codebase against React's "You Might Not Need an Effect" guidelines. Goal: identify effects that update state from props/state (causing extra renders), derive state that could be computed during render, or handle logic that belongs in event handlers.

## Results Summary

| Category | Count |
|----------|-------|
| NECESSARY (external system sync) | 49 |
| REMOVABLE (anti-pattern) | 13 |
| SUSPICIOUS (borderline) | 14 |

---

## REMOVABLE Effects — Recommended Refactors

### 1. `useStagingState.ts:41` — Reset state on worktree change
**Anti-pattern:** Reset state on prop change  
**Fix:** Use `key={worktreePath}` on parent component, or track `prevWorktreePath` and reset during render

### 2. `useStagingState.ts:50` — Reset state on viewMode change
**Anti-pattern:** Reset state on prop change  
**Fix:** Same as above — key-based remount or render-time conditional reset

### 3. `useStagingState.ts:58` — Derive shelve name from worktree
**Anti-pattern:** Derived state in effect  
**Fix:** `useMemo` or compute inline during render

### 4. `useStagingState.ts:67` — Auto-select first file when diff loads
**Anti-pattern:** Conditional initialization  
**Fix:** Compute default selection during render: `selectedFileIndex ?? (diffFiles.length > 0 ? 0 : null)`

### 5. `CreateWorktreeDialog.tsx:40` — Sync ref to prop
**Anti-pattern:** Ref assignment in effect  
**Fix:** Direct assignment during render body: `currentBranchRef.current = currentBranch`

### 6. `ActivityPlanPanel.tsx:41` — Reset elapsed on task change
**Anti-pattern:** Reset state on derived value change  
**Fix:** Track `prevInProgressKey` and reset in timer effect, or key-based remount

### 7. `ActivityMessageItem.tsx:37` — Update ref with latest text
**Anti-pattern:** Ref assignment in effect  
**Fix:** Assign during render: `lastTextRef.current = { text: message.text, ts: Date.now() }`

### 8. `App.tsx:116` — Show toast on settings error
**Anti-pattern:** Event-specific logic in effect  
**Fix:** Use query's `onError` callback or `throwOnError` boundary

### 9. `ReviewModal.tsx:40` — Parse diff + open review
**Anti-pattern:** Mixed derived state + event handler logic  
**Fix:** Diff parsing → `useMemo`. `openReview()` call → event handler that opens modal

### 10. `FilePicker.tsx:58` — Reset keyboard index on path change
**Anti-pattern:** State-on-state-change  
**Fix:** Handle inside `useKeyboardNavigation` hook or derive from path

### 11. `ActivityToolCallGroup.tsx:99` — Auto-collapse on completion
**Anti-pattern:** Adjust state on prop change  
**Fix:** Derive `groupOpen` from `allDone` + `userToggled` ref during render

### 12. `useProjectPickerNavigation.ts:15` — Sync view to connection
**Anti-pattern:** Derived state  
**Fix:** Compute view from `activeConnection` at render time, or set in same handler

### 13. `useSshConnectionManager.ts:66` — Build connections array
**Anti-pattern:** Derived state in effect + setState  
**Fix:** Replace with `useMemo(() => [localConn, ...sshConnections.map(...)], [sshConnections])`

### 14. `usePathNavigation.ts:11` — Sync ref to drives
**Anti-pattern:** Ref assignment in effect  
**Fix:** `drivesRef.current = drives` inline during render

---

## SUSPICIOUS Effects — Case-by-case

These work but could be improved. Lower priority:

| File:Line | Pattern | Notes |
|-----------|---------|-------|
| `App.tsx:98` | Consume pending deep-link | Works; could be router-level |
| `App.tsx:106` | Mutation on project change | Should be in project-select handler |
| `WorktreesView.tsx:42` | Consume pending deep-link | Same pattern as App.tsx:98 |
| `AgentsView.tsx:45` | Consume pending deep-link + auto-select | Split into two concerns |
| `AgentActivityPanel.tsx:117` | Set status on init complete | Could derive in store |
| `AgentActivityPanel.tsx:122` | Remove status on session end | Could fire at event site |
| `AgentActivityPanel.tsx:159` | Notify parent of file changes | Callbacks at event site |
| `AgentActivityPanel.tsx:268` | Auto-approve plan permissions | Could handle in lifecycle hook |
| `SettingsPage.tsx:46` | RHF reset from async data | Common RHF pattern |
| `TaskForm.tsx:58` | Set default branch from async | Common RHF pattern |
| `TaskSettingsModal.tsx:66` | Reset form on open | Move to open handler |
| `SpawnSessionDialog.tsx:61` | Reset dialog on open | Move to open handler |
| `FilePicker.tsx:46` | Initial path sync | Potentially unstable deps |
| `carousel.tsx:87` | Pass API to parent | Library integration |

---

## NECESSARY Effects — Legitimate External System Sync

All of these subscribe to browser APIs, Tauri events, timers, DOM manipulation, or async initialization:

- **Tauri event subscriptions**: useAcpSessionLifecycle (10 effects), useAcpActivity, connection.service, execution.service (2), useConnectionHealth, AgentActivityPanel:81, AgentActivityPanel:320
- **DOM manipulation**: focus management (ConnectionHeader, calendar, AgentActivityPanel:311), scrollIntoView (ComposeBar ×2, useKeyboardNavigation, ExecutionTerminal:39), ResizeObserver (useAcpScrollBehavior)
- **Timers**: AgentActivityPanel:344, ActivityPlanPanel:45, ActivityMessageItem:43, LiquidContextIndicator:207, MarkdownBlock:435, useAcpSessionLifecycle:243
- **Animations**: LiquidContextIndicator (2 effects)
- **Async initialization**: DiffViewer (shiki), MarkdownBlock (shiki + mermaid), Terminal (xterm.js)
- **Media queries**: ThemeProvider, use-mobile
- **Data fetching**: ReviewChangesPanel, WorkingFilesPanel (2), ComposeBar:128
- **Keyboard events**: FilePicker:65, ProjectsListLayout, PermissionPrompt, sidebar
- **External libraries**: carousel (embla), Terminal (xterm)
- **Theme sync**: ThemeProvider (2 effects)

---

## Implementation Order

**Phase 1 — Quick wins (ref assignments, derived state):**
1. `usePathNavigation.ts:11` — inline ref assignment
2. `CreateWorktreeDialog.tsx:40` — inline ref assignment  
3. `ActivityMessageItem.tsx:37` — inline ref assignment
4. `useSshConnectionManager.ts:66` — replace with `useMemo`
5. `useStagingState.ts:58` — replace with `useMemo`

**Phase 2 — State-on-prop-change removals:**
6. `useProjectPickerNavigation.ts:15` — derive view from activeConnection
7. `ActivityToolCallGroup.tsx:99` — derive open state
8. `useStagingState.ts:41,50` — key-based remount or render-time reset
9. `ActivityPlanPanel.tsx:41` — merge into timer effect
10. `FilePicker.tsx:58` — handle in keyboard hook

**Phase 3 — Event handler migrations:**
11. `App.tsx:116` — move to query onError
12. `ReviewModal.tsx:40` — split into useMemo + event handler
13. `useStagingState.ts:67` — derive during render

---

## Verification

After each refactored effect:
1. `pnpm lint` — no new warnings
2. `pnpm test` — existing tests pass
3. Manual check affected component renders correctly
4. Confirm no extra re-renders via React DevTools Profiler (spot check)
