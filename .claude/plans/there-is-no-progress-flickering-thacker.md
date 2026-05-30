# Plan: Worktrees View — Loading Indicator & Manual Refresh

## Context

WorktreesView has no loading feedback. When data fetches (initial load or tab switch), user sees empty grid with no indication something is happening. No way to manually trigger refresh either.

## Preview

See `.claude/plans/worktrees-loading-preview.html` for visual mockup of all three states.

## Changes

### File: `src/views/WorktreesView.tsx`

1. **Destructure `isLoading` and `isFetching`** from `useWorktreesQuery()` (line 29)

2. **Add RefreshCw button** in action bar right side, before view toggle button (~line 148):
   - `RefreshCw` icon from lucide-react
   - `onClick={() => void refetchWorktrees()}`
   - `disabled={isFetching}`
   - Icon gets `animate-spin` class when `isFetching`
   - Follows existing pattern from `CreateTaskModal.tsx:410-421`

3. **Add initial loading state** — when `isLoading` is true, render centered `<Spinner />` + "Loading worktrees..." text instead of `<WorktreeCardGrid>`:
   - Uses existing `<Spinner />` from `@/ui/spinner`
   - Same pattern as `ProviderRepoPicker.tsx:54-61`

No new files. No new components. Single file change, ~20 lines added.

## Verification

1. `pnpm build` — type check passes
2. `pnpm tauri:dev` — open Worktrees tab
3. Verify: refresh button visible, spins on click, stops when data arrives
4. Verify: initial load shows spinner (clear TanStack Query cache or disconnect/reconnect project)
