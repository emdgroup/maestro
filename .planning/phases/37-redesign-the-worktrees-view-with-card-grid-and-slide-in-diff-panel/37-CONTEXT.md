# Phase 37: Redesign the worktrees view with card grid and slide-in diff panel - Context

**Gathered:** 2026-04-01
**Status:** Ready for planning

<domain>
## Phase Boundary

Replace the current side-by-side list+diff layout in WorktreesView/WorktreeManager with:
1. A full-page card grid grouped by base branch under collapsible section headers
2. A slide-in diff panel (full-screen CSS transition) triggered by clicking a card
3. An updated action bar with expand/collapse all toggle and New Worktree button

The diff panel reuses the existing file list + single-file diff rendering from Phase 36. Git diff content and DiffTarget::Head behavior are unchanged. Backend changes include: persisting `base_branch` in the DB, and adding ahead/behind counts to the worktree list query.

</domain>

<decisions>
## Implementation Decisions

### Card Content
- **Primary label:** `branch_name` — the unique identifier per worktree, shown prominently
- **Secondary info displayed on each card:**
  - Changes delta: `+X / -Y` lines from `diff_stat`
  - Last modified: `created_at` as relative time (e.g. "3 days ago")
  - Ahead/behind indicator: number of commits ahead/behind the remote (e.g. ↑2 ↓1)
- **Ahead/behind data source:** Add `git rev-list --left-right --count` call to `list_worktrees_with_status` backend handler — included in the single list query, not lazy-loaded
- **Delete action:** Trash icon revealed on card hover (top-right corner); hidden by default. Still triggers the existing confirmation dialog.

### Card Grid Layout
- Cards displayed as `flex-wrap` row grid filling the full width below the action bar
- Grouped under collapsible section headers (one section per base branch)

### Action Bar (cards view)
- **Expand/collapse all toggle:** Button or icon that collapses or expands all section groups at once
- **New Worktree button:** Moved from the sidebar into the action bar
- **Search input:** Keep existing branch search (filters across all groups)
- **Status filter toggle group:** Keep existing All/Active/Modified/Idle filter

### Grouping by Origin Branch
- Group cards by the `base_branch` value stored per worktree at creation time
- `base_branch` is currently passed at creation but **not persisted** → requires:
  1. Add `base_branch TEXT` column to `worktrees` DB table (schema migration)
  2. Store it in `create_worktree` IPC handler
  3. Expose it in `WorktreeWithStatus` model
- **Fallback for worktrees without stored base_branch** (legacy rows, interactive sessions): use `branch_name` as the group key — best-effort, no orphan group
- **Group header:** Shows `{base_branch} ({count})` — e.g. `main (3)`
- **Collapse state:** Groups are expanded by default; user can collapse individual groups or toggle all via action bar

### Slide-in Diff Panel
- **Transition type:** Full-screen CSS slide — cards grid slides out to the left, diff panel slides in from the right. Both views occupy 100% of the content area. No cards visible while in diff view.
- **Close button:** × button positioned at the **top-right** of the diff panel's action bar
- **Diff panel action bar layout:**
  - Left side: worktree name (branch_name) as label + file search input + file filter controls
  - Right side: unified/split diff mode toggle (existing) + × close button
- **No separate worktree header section** inside the diff panel — the action bar carries the identity

### Empty and Loading States
- **Empty view (no worktrees):** Centered muted text message only (e.g. "No worktrees yet"). No button — New Worktree is in the action bar.
- **Empty group after filter:** Show "No matches" within the group or collapse the empty group
- **Claude's Discretion:** Loading skeleton design, card min/max width, exact grid gap, animation duration/easing for the slide transition

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Existing implementation to preserve/reuse
- `src/views/WorktreesView.tsx` — current page-level orchestrator; owns query, filter state, action bar
- `src/components/execution/WorktreeManager.tsx` — current split-pane component; file list + diff body to be reused inside slide-in panel
- `src/components/execution/FileTree.tsx` — file tree component reused in diff panel
- `src/components/execution/DiffViewer.tsx` — diff renderer; unchanged

### Backend
- `src-tauri/src/models/worktree.rs` — `WorktreeWithStatus` struct; add `base_branch` and `ahead_behind` fields
- `src-tauri/src/ipc/worktree_handlers.rs` — `create_worktree` (persist base_branch), `list_worktrees_with_status` (add ahead/behind git call)
- `src-tauri/src/db/schema.rs` — `worktrees` table; add `base_branch TEXT` column with schema migration

### Services and state
- `src/services/worktree.service.ts` — `useWorktreesQuery`, `useWorktreeDiffQuery`, `useDeleteWorktreeMutation`, `useCreateWorktreeMutation`
- `src/store/navigationStore.ts` — `pendingWorktreeId` deep-link handling must be adapted for new layout

### Patterns to follow
- Phase 36 decisions in `STATE.md` (Accumulated Context section) — file list panel, auto-select first file, DiffTarget::Head constant
- Phase 27 pattern: WorktreeManager is a pure display component; WorktreesView owns data and state

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `WorktreeManager.tsx`: The file list panel + single-file diff rendering (FileTree + DiffViewer + useWorktreeDiffQuery wiring) is the content of the slide-in panel — extract this logic into the new diff panel component
- `parseDiffStat()` helper in WorktreeManager.tsx: reuse for card diff stat display
- `useWorktreesQuery`: already returns `diff_stat`, `git_status`, `agent_status`, `created_at` — extend with `base_branch` and `ahead_behind`
- `AlertDialog` for delete confirmation: keep as-is
- `useCreateWorktreeMutation` + create dialog: keep, move trigger to action bar

### Established Patterns
- Pure display components receiving props (Phase 27/26 pattern) — new card grid component should be pure
- WorktreesView owns all state and passes down — keep this split
- `formatDistanceToNow` from date-fns: already imported, use for "3 days ago" relative time
- `cn()` utility for conditional class names
- `STATUS_FILTERS` and `StatusFilter` type: keep in WorktreeManager or move to WorktreesView

### Integration Points
- Deep-link via `pendingWorktreeId` in navigationStore: when a deep-link fires, the new layout must auto-trigger the slide-in for the matched worktree
- `taskQueryKeys` invalidation on branch refresh (currently in create dialog button handler): keep
- Schema migration: increment `SCHEMA_VERSION` in `src-tauri/src/db/schema.rs` and add ALTER TABLE for `base_branch`

</code_context>

<specifics>
## Specific Ideas

- "Cards displayed as flex row" — user wants a horizontal card layout (flex-wrap), not a vertical list
- "Grouped by base branch under collapsible separator" — collapsible section headers similar to backlog view grouping
- "Similar to the backlog view" — use the KanbanView / backlog section grouping as a visual reference for the group header style
- "Entire screen should slide to the left" — CSS transform/translate animation on the full content area, not a modal or drawer
- Ahead/behind display: user specifically called out "if the branch needs to be pushed or pulled if it is behind" — indicator like ↑2 ↓1 or "2 ahead · 1 behind"

</specifics>

<deferred>
## Deferred Ideas

- None — discussion stayed within phase scope

</deferred>

---

*Phase: 37-redesign-the-worktrees-view-with-card-grid-and-slide-in-diff-panel*
*Context gathered: 2026-04-01*
