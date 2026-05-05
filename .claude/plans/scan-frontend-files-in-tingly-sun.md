# Frontend Anti-Pattern Audit

## Context

Scanning the React/TypeScript frontend for code quality issues: oversized components, excessive complexity, duplicate logic, unnecessary useEffects, type escape hatches, and dead code.

---

## Findings

### 1. CRITICAL: `AgentActivityPanel.tsx` (527 lines, 17 useEffects)

**The worst offender in the codebase.** Single component managing:
- 13 `useState` calls + 7 `useRef` calls
- 17 `useEffect` hooks (7 of which are Tauri event listeners)
- Permission handling, elicitation handling, model management, scroll behavior, session lifecycle, usage tracking, capabilities sync
- 2 `eslint-disable-next-line react-hooks/exhaustive-deps` suppressed warnings

**Problems:**
- God component — does everything. Should be split into custom hooks:
  - `useAcpEventListeners(sessionKey)` — consolidate all 7 `listen<>` effects
  - `useAcpModels(sessionKey)` — model state + changes
  - `useAcpUsage(sessionKey)` — usage/cost tracking
  - `useScrollBehavior(ref)` — scroll FAB + unread indicator (already partially exists)
- Many effects duplicate the pattern: `listen → setState → return unlisten`. Extract once.
- `.catch(() => {})` on lines 140 and 158 — silently swallows init errors for capabilities and models

---

### 2. HIGH: `WorktreeDiffPanel.tsx` (712 lines)

**Largest frontend component.** Handles:
- File listing, file selection, diff viewing
- Staging (files + individual hunks)
- Commit, shelve, revert, delete untracked
- View mode switching, search filtering

**Problems:**
- Too many responsibilities — this is a full "git staging area" in one function
- 4 useEffects that reset state on prop changes (lines 295–328) — symptom of too much local state that should live in a reducer or be derived
- Should extract: `useStagingState(worktreePath, viewMode)` reducer hook

---

### 3. HIGH: `ComposeBar.tsx` (582 lines)

Large for a compose input. Mixes:
- Text input with auto-resize
- File attachment (MIME detection, drag-and-drop)
- Command picker (`/` prefix)
- Model selector
- Permission mode selector
- Usage/cost display
- Mention system

Should be split — at minimum extract file attachment logic and command picker into sub-components.

---

### 4. MEDIUM: Dead/empty handlers in `App.tsx`

```tsx
function handleTaskCreated(_newTask: Task) {
  // Task list is refreshed automatically via React Query cache invalidation
}
```
This does nothing. Remove it and the callback prop.

---

### 5. MEDIUM: `useEffect` for error logging (App.tsx:116)

```tsx
useEffect(() => {
  if (settingsError) {
    console.error("[DEBUG] App.tsx: Failed to load settings:", settingsError);
    toast.error("Failed to load settings");
  }
}, [settingsError]);
```
Unnecessary useEffect — error handling should be in query's `onError` or a derived render. Classic "you might not need an effect" pattern.

---

### 6. MEDIUM: 31 leftover `console.*` statements across frontend

Most are `[DEBUG]` prefixed or error logging that should use a toast or be removed entirely. Notable:
- `ThemeProvider.tsx` — 4 console statements (2 `log`, 2 `error`)
- `ExecutionTerminal.tsx` — 5 console statements
- `PermissionPrompt.tsx:279` — `console.log("[switch_mode] permission payload"...` (debug artifact)
- `useProjectPickerNavigation.ts:16` — `console.debug("changing view")` (dead debug)

---

### 7. MEDIUM: 6 `eslint-disable-next-line react-hooks/exhaustive-deps`

| File | Reason |
|------|--------|
| `AgentActivityPanel.tsx:325` | Missing deps in scroll effect |
| `AgentActivityPanel.tsx:391` | Missing deps in scroll-to-bottom |
| `WorktreeDiffPanel.tsx:301` | Resetting state on worktreePath change (intentional partial deps) |
| `FilePicker.tsx:63` | Omitting loader/keyboard deps |
| `LiquidContextIndicator.tsx:146` | Unknown |
| `App.tsx:112` | Omitting mutation from deps |

Most are workarounds for not extracting state into reducers or custom hooks.

---

### 8. LOW: Type escape hatches (only 2, acceptable)

- `DiffViewer.tsx:128` — `registerHighlighter={highlighter as any}` (Shiki API mismatch)
- `MarkdownBlock.tsx:420` — `components={MARKDOWN_COMPONENTS as any}` (react-markdown types)

Both are library boundary issues. Not easily fixable without upstream type updates.

---

### 9. LOW: `AppHeader.tsx` bypasses service layer

Direct `invoke<number[]>("drain_ready_queue", {...})` call instead of going through a service. Minor but inconsistent with the pattern used everywhere else.

---

### 10. LOW: `useSshConnectionStatus` polling + events

`connection.service.ts:252` — uses both `refetchInterval: 8000` AND Tauri event listeners for the same query. The event listeners already invalidate the cache, so polling is redundant (or the events are unreliable and that's a deeper bug).

---

## Priority Actions

| Priority | Action | Impact |
|----------|--------|--------|
| 1 | Extract `AgentActivityPanel` into 3-4 custom hooks | -400 lines, testable, readable |
| 2 | Extract `WorktreeDiffPanel` staging logic into reducer hook | -200 lines, clearer state flow |
| 3 | Remove dead handlers + unnecessary useEffect in App.tsx | Cleaner root |
| 4 | Remove `console.*` debug artifacts (keep error toasts) | 20+ fewer console noise |
| 5 | Split ComposeBar into sub-components | Easier to maintain |
| 6 | Replace eslint-disables with proper hook extraction | Correctness |

---

## Verification

After any refactor:
1. `pnpm test` — all unit tests pass
2. `pnpm lint` — no new warnings
3. `pnpm dev` — manual smoke test of affected features (agent sessions, diff panel, compose bar)
4. Check React DevTools for unnecessary re-renders
