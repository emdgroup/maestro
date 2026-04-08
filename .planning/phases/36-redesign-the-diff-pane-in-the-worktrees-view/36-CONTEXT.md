# Phase 36: redesign the diff pane in the worktrees view - Context

**Gathered:** 2026-04-01
**Status:** Ready for planning

<domain>
## Phase Boundary

Redesign the right panel of `WorktreeManager` (the diff pane in the Worktrees view). The goal is a file-navigable diff experience: a narrow file list sub-panel on the left lets the user click to view one file's diff at a time in the main diff body. The diff target controls are simplified — always show uncommitted changes, remove the toggle.

**In scope:**
- `src/components/execution/WorktreeManager.tsx` — layout restructure, file list panel, per-file header, remove toggle
- `src/components/execution/DiffViewer.tsx` — possibly minor updates for the new per-file header
- Frontend only — no backend changes required

**Out of scope:**
- Backend IPC changes (Phase 35 already implemented DiffTarget, it stays but Branch mode is not exposed in UI)
- Schema changes
- Any new data fetching (existing `useWorktreeDiffQuery` + `parseDiffString` covers this)

</domain>

<decisions>
## Implementation Decisions

### File navigation panel
- Add a ~200px fixed-width file list sub-panel inside the right panel, left of the diff body
- Not resizable
- Clicking a file in the list shows ONLY that file's diff in the diff body (not all files at once)
- Auto-select the first changed file when a worktree is selected (no manual click required to see the first diff)
- If the worktree has no uncommitted changes, the file list is empty and the diff body shows "No uncommitted changes"

### File list entry format
Each entry in the file list shows three pieces of information:
- M/A/D status icon (Modified / Added / Deleted) — derived from the diff data
- Filename (not full path — just the basename)
- +/- stats (insertions/deletions) for that file

### Diff target simplification
- Remove the ToggleGroup "Uncommitted" / "Branch diff" toggle entirely
- Remove the branch text input entirely
- Always call `get_worktree_diff` with `DiffTarget::Head` (uncommitted changes)
- The `diffMode` and `diffBranch` state variables are removed
- The diff target bar row is removed from the layout

### Per-file diff header
- A header bar appears above the diff body (below the file list / diff split)
- Shows: full relative path + M/A/D status + +/- stats
- Example: `src/components/execution/DiffViewer.tsx  M  +12 -4`

### Layout structure
```
┌─────────────────────────────────────────────────────┐
│  Worktree header (branch name, task link, delete)   │  ← full width, unchanged
├──────────────┬──────────────────────────────────────┤
│  File list   │  [Full path + stats header]           │
│  (~200px)    │  ─────────────────────────────────── │
│              │                                       │
│  M DiffViewer│  Diff body (selected file only)       │
│    +12 -4    │                                       │
│  A new.ts    │                                       │
│    +30 -0    │                                       │
│              │                                       │
└──────────────┴──────────────────────────────────────┘
```
- The worktree info header spans full width (unchanged from current)
- Below the header: two-column split — file list left | diff body right

### Claude's Discretion
- Exact visual styling of M/A/D status icons (color-coded letters, small icons, or colored dots)
- Whether the selected file in the file list has a highlight style (likely: border-l-2 bg-muted/20 like the worktree list)
- Exact font/size for the per-file header bar
- How to extract status (M/A/D) and per-file stats from `parseDiffString` output (may need to inspect `DiffFile` type)

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Current implementation to modify
- `src/components/execution/WorktreeManager.tsx` — current diff pane layout, state, and rendering (entire file)
- `src/components/execution/DiffViewer.tsx` — existing DiffViewer component
- `src/types/review.ts` — `DiffFile` type definition (check what fields are available: filename, status, hunks, stats)

### Helpers already in use
- `src/lib/index.ts` (or wherever `parseDiffString` lives) — parses raw diff string into `DiffFile[]` array; check what per-file data it exposes
- `src/services/worktree.service.ts` — `useWorktreeDiffQuery` hook signature (check params, especially how DiffTarget is passed)

### Pattern references
- `src/views/WorktreesView.tsx` — page-level component (minor or no changes needed)
- `src/types/bindings.ts` — `DiffTarget` type (always pass `{ type: "Head" }`)

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `DiffViewer.tsx` — used as-is per file; receives `DiffFile | null` + `loading` + `error` props
- `parseDiffString(diffString)` — already called in WorktreeManager, returns `DiffFile[]`
- `useWorktreeDiffQuery(worktreeId, diffTarget)` — existing query, just always pass `{ type: "Head" }`
- `ToggleGroup` / `cn` / `Button` — already imported in WorktreeManager
- Worktree sidebar entry pattern (border-l-2, selected highlight) — reuse this exact pattern for the file list

### Established Patterns
- Border-l-2 selected state with `bg-muted/20` for the active item — use same pattern for file list selection
- `shrink-0` for fixed panels, `flex-1 min-w-0` for expanding panels
- `overflow-y-auto` for scrollable lists
- `text-success` / `text-destructive` for +/- stats (already used in worktree list diff stat display)

### Integration Points
- `diffFiles` (from `parseDiffString`) is already available in WorktreeManager — pivot from rendering all files to driving the file list + selected file state
- State to add: `selectedFileIndex: number | null` — auto-set to 0 when diffFiles loads, user can click others
- Remove: `diffMode`, `diffBranch` state variables and related JSX

</code_context>

<specifics>
## Specific Ideas

- The file list's selected state should mirror the worktree list: `border-l-2 bg-muted/20` on the active file, `border-transparent hover:bg-muted/10` on others
- `text-success` / `text-destructive` for the +/- stats in both the file list and the per-file header (consistent with existing diff stat display in the worktree sidebar)
- Auto-select first file: set `selectedFileIndex = 0` whenever `diffFiles` array becomes non-empty

</specifics>

<deferred>
## Deferred Ideas

- Branch diff mode (DiffTarget::Branch) — was removed from the UI in this phase. Could be re-added as an advanced option in a future phase if needed.
- Resizable file list panel — deferred, fixed width is sufficient for now.
- Collapsible/expandable file sections — deferred.

</deferred>

---

*Phase: 36-redesign-the-diff-pane-in-the-worktrees-view*
*Context gathered: 2026-04-01*
