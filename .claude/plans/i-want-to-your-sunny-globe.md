# Session History Panel UX Improvements

## Context

Session history panel (`SessionHistoryPanel.tsx`) is a 300px absolute-positioned floating overlay in AgentsView. User reports: ugly heavy shadow, tiny agent pills, too narrow, no branch info, no manual refresh, renders behind other panels. User wants it to behave as a side panel that opens above content (not floating popover).

**Preview**: `.claude/plans/session-history-ux-preview.html` — shows full app context with agent monitor visible behind.

## Changes

### 1. Side panel overlay (not floating popover)
- **Current**: `absolute top-2 right-2 bottom-2` with insets creating a "floating card" look
- **Proposed**: `absolute top-0 right-0 bottom-0` — flush to edges, `border-left` for separation
- Removes the floating appearance, becomes a proper side panel sliding over content
- Agent monitor remains visible on the left side

### 2. Subtle shadow
- Replace `shadow-[0_8px_32px_rgba(0,0,0,0.4),-2px_0_16px_rgba(0,0,0,0.2)]` with `shadow-lg` or lighter
- Primary visual separator becomes `border-left` not shadow

### 3. Bigger agent filter pills
- Height: `h-6` → `h-[30px]`
- Font: `text-[10px]` → `text-xs` (12px)
- Icons: `w-3 h-3` → `w-4 h-4`

### 4. Wider panel
- Width: `w-[300px]` → `w-[380px]`

### 5. Action row: New Session + Search + Refresh
- Replace current search section with a combined action row
- Layout: `[+ New Session btn]` `[Search input]` `[Refresh btn]`
- "New Session" button: ghost variant, plus icon, triggers `SpawnSessionDialog` (already exists in AgentsView)
- Search input: `flex-1`, fills remaining space
- Refresh button: `RefreshCw` icon, same height (30px), border-matched
- On refresh click: invalidate TanStack Query sessionList cache
- Show spin animation while `isFetching` is true

### 6. Branch badge on session entries
- Show git branch icon + branch name below session title
- Monospace font, muted color, small badge background
- **Backend approach**: extend `session_aliases` table with nullable `branch_name` column. Store on spawn/load. Return in `SessionListEntryDto`. Only shown when available.

### 7. Z-index fix
- Raise from `z-30` to `z-50` so panel stays above working files / review changes overlays

### 8. CWD filtering
- Already works via `repoPath` param. No change needed.

## Implementation

### Commit 1: Frontend UX (items 1-5, 7)
- `src/components/execution/SessionHistoryPanel.tsx`
  - Remove `top-2 right-2 bottom-2` → use `top-0 right-0 bottom-0`
  - Remove rounded corners on right side (`rounded-lg` → `rounded-l-lg`)
  - Replace shadow with `shadow-lg` + `border-l border-border`
  - Widen to `w-[380px]`, raise to `z-50`
  - Increase agent pill sizing
  - Replace search section with action row: `[New Session]` + `[Search]` + `[Refresh]`
  - "New Session" opens `SpawnSessionDialog` (pass `onOpenChange` prop or emit via callback)
  - Refresh uses `useQueryClient()` + `invalidateQueries`
  - Import `RefreshCw`, `Plus` from lucide

### Commit 2: Branch metadata (item 6)
- `src-tauri/src/db/schema.rs` — add `branch_name TEXT` to session_aliases table
- `src-tauri/src/acp/manager.rs` — store branch on `upsert_session_alias`
- `src-tauri/src/ipc/acp_handlers.rs` — read branch in `list_acp_sessions`, overlay onto DTO
- `src-tauri/src/models/worktree.rs` — add `branch_name: Option<String>` to `SessionListEntryDto`
- `src/types/bindings.ts` — regenerated via `pnpm tauri:gen`
- `src/components/execution/SessionHistoryPanel.tsx` — render branch badge when present

## Verification

1. `pnpm dev` → Agents view → toggle History
2. Confirm: panel is flush-right side overlay, subtle shadow, bigger pills, wider
3. Click refresh button → sessions re-fetch with spin animation
4. Open WorkingFilesPanel/ReviewChangesPanel → confirm history stays on top
5. Branch badge: spawn session from worktree → reopen history → badge visible
