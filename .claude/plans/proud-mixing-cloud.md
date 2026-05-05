# Plan: Add React Compiler + Fix Performance Items

## Context

Frontend audit (`.planning/frontend-audit.md`) identified 4 PERF items — all about unstable object references causing unnecessary re-renders. Instead of manually adding `useMemo` everywhere, React Compiler automates memoization for React 19 projects. However, Zustand selector issues (PERF-3, PERF-4) need `useShallow` — compiler can't fix store-level equality checks.

## Changes

### 1. Install React Compiler

```bash
pnpm add -D babel-plugin-react-compiler
```

### 2. Configure in `vite.config.ts`

Add babel plugin to `@vitejs/plugin-react`:

```ts
plugins: [
  react({
    babel: {
      plugins: [["babel-plugin-react-compiler", {}]],
    },
  }),
  tailwindcss(),
],
```

### 3. Fix PERF-3 & PERF-4 — Zustand selectors with `useShallow`

Compiler doesn't fix Zustand's internal `Object.is` check on selector returns. Wrap with `useShallow`:

**`src/store/navigationStore.ts`** (line 116):
```ts
import { useShallow } from "zustand/react/shallow";

export const useNavigationActions = () =>
  useNavigationStore(useShallow((s) => ({
    setActiveTab: s.setActiveTab,
    setActiveSubView: s.setActiveSubView,
    clearPendingTask: s.clearPendingTask,
    clearPendingAgent: s.clearPendingAgent,
    clearPendingWorktree: s.clearPendingWorktree,
  })));
```

**`src/store/projectStore.ts`** (line 29):
```ts
import { useShallow } from "zustand/react/shallow";

export const useSelectedProjectActions = () =>
  useStore(useShallow((state) => ({
    setSelectedProject: state.setSelectedProject,
    clearSelectedProject: state.clearSelectedProject,
  })));
```

Consumer API unchanged — 10 call sites keep working.

### 4. Remove manual useMemo/useCallback from app hooks (optional cleanup)

With compiler active, these are redundant noise in custom hooks:

- `src/utils/hooks/usePathNavigation.ts` — 3x `useCallback` → plain functions
- `src/utils/hooks/useProjectPickerNavigation.ts` — 2x `useCallback` → plain functions  
- `src/utils/hooks/useConnectionHealth.ts` — 1x `useCallback` → plain function
- `src/utils/hooks/useFilePickerInitialization.ts` — 2x `useMemo` → plain `const`
- `src/utils/hooks/useSshConnectionManager.ts` — 6x `useCallback` + 1x `useMemo` → plain

**NOT touching**: `src/components/ui/*` (shadcn library components — leave as-is).

### 5. Update audit doc

Mark PERF-1 through PERF-4 as resolved in `.planning/frontend-audit.md`.

## Files Modified

| File | Change |
|------|--------|
| `package.json` | Add `babel-plugin-react-compiler` dev dep |
| `vite.config.ts` | Configure babel plugin |
| `src/store/navigationStore.ts` | Add `useShallow` import + wrap selector |
| `src/store/projectStore.ts` | Add `useShallow` import + wrap selector |
| `src/utils/hooks/usePathNavigation.ts` | Remove useCallback wrappers |
| `src/utils/hooks/useProjectPickerNavigation.ts` | Remove useCallback wrappers |
| `src/utils/hooks/useConnectionHealth.ts` | Remove useCallback wrapper |
| `src/utils/hooks/useFilePickerInitialization.ts` | Remove useMemo wrappers |
| `src/utils/hooks/useSshConnectionManager.ts` | Remove useCallback/useMemo wrappers |
| `.planning/frontend-audit.md` | Mark PERF items done |

## Verification

1. `pnpm dev` — app starts without errors
2. `pnpm lint` — no new lint issues  
3. `pnpm test` — all tests pass
4. Browser check: navigate between views, verify no runtime errors in console
5. Check React DevTools "Highlight updates" — context consumers shouldn't flash on unrelated state changes
