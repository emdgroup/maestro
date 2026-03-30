# Phase 27: Worktrees View - Context

**Gathered:** 2026-03-30
**Status:** Ready for planning

<domain>
## Phase Boundary

Replace the placeholder `WorktreeManager` component with a real-data Agents-view-style sidebar list + right detail panel. Data comes from `list_worktrees_with_status` (IPC added in Phase 25). One small backend addition: add `git diff --shortstat` output per worktree to `WorktreeWithStatus`. Everything else is pure frontend wiring.

</domain>

<decisions>
## Implementation Decisions

### Layout — Sidebar list + right panel

- **Abandon the 3-col card grid entirely.** Use the Agents-view-style layout: fixed-width left sidebar list + right detail panel.
- **Sidebar width:** Match Agents view (`w-72`).
- **Right panel (no selection):** Centered muted text — `"Select a worktree to view details"` — same as Agents view empty state.
- **Selected row:** Left-border accent highlight (same Linear-style as Agents view).

### Sidebar row layout — Three lines (matching Agents view pattern)

- **Line 1:** Status dot (green = clean, yellow = dirty) + branch name (truncated).
- **Line 2:** Task name (or `"No task"` if `task_id` is null), in muted text.
- **Line 3 (dirty worktrees only):** Diff shortstat — e.g. `"12 files changed"` with `+175` in green and `-100` in red. Line 3 is empty for clean worktrees.
- The dot sits inline before the branch name on line 1.

### git_status + diff shortstat — Backend addition in Phase 27

- **New backend field:** Add `diff_stat: Option<String>` to `WorktreeWithStatus`. Run `git diff --shortstat` per worktree (same parallelism pattern as the existing `git status --porcelain` calls — `tokio::spawn` per worktree).
- **Existing `git_status` field:** Keep as-is (raw porcelain). Frontend uses `diff_stat` for display.
- **Canonical format returned:** Raw `git diff --shortstat` string (e.g. `" 12 files changed, 175 insertions(+), 100 deletions(-)"`) — parse on the frontend into the colored display.

### Right detail panel content

- **Header:** Branch name (bold), task name (linked via `navigationStore`), agent status badge, last activity timestamp, Clean up button.
- **Body:** DiffViewer (`@git-diff-view/react`) showing changes vs origin branch — reusing the existing `DiffViewer` component unchanged.
- **Loading state:** Spinner while `useWorktreeDiffQuery` is fetching.
- **Clean worktree:** Show `"No uncommitted changes"` message instead of DiffViewer.

### Filter toolbar — Action bar matching KanbanView / Agents view pattern

- **Container:** `h-12 border-b border-border bg-muted/30` — identical to Agents view and KanbanView action bars.
- **Left:** `Input` component for branch name search (client-side).
- **Right:** `ToggleGroup` with `ToggleGroupItem` chips: **All / Active / Modified / Idle**.
  - **Active:** Worktree has a running agent (agent status = Running).
  - **Modified:** Has uncommitted changes (`diff_stat` is non-null/non-empty; or `git_status` porcelain is non-empty).
  - **Idle:** No running agent AND no uncommitted changes.
- Filtering applied client-side to the full `WorktreeWithStatus[]` list.
- **"New Worktree" button** lives in the action bar on the far right (outside the ToggleGroup).

### Zombie + Orphan badge treatment

- **Zombie:** Row shows a `"Zombie"` badge (the `is_zombie` flag from Phase 25 — tracked worktree that lost its task link). Same styling as a status badge.
- **Orphan:** Row shows an `"Orphan"` badge. Same visual treatment as Zombie — badge only, no row styling change.
- **Right panel for orphans:** Show best-effort data — branch name from git, diff vs origin (if available). Metadata section shows `"No task linked"` and `"No database record"`. Clean up button still present.
- Neither zombie nor orphan triggers auto-deletion. Badges are informational.

### Empty + loading states

- **Loading:** Sidebar shows spinner/skeleton while `useWorktreesQuery` is fetching.
- **Zero worktrees:** `"No worktrees found"` centered in the sidebar list area.
- **No filter results:** `"No worktrees match your filter"` in `text-xs text-muted-foreground`.

### Architecture — Props-down (matching Phase 26 pattern)

- `WorktreesView.tsx` owns the `useWorktreesQuery(projectId)` call and passes `WorktreeWithStatus[]` as props to `WorktreeManager`. No direct IPC inside `WorktreeManager`.
- `useWorktreeDiffQuery(worktreeId)` called inside `WorktreeManager` (triggered by selection state) — acceptable since it's a UI-reactive secondary query, not the primary data owner.

### Claude's Discretion

- Exact Tailwind classes for the Zombie and Orphan badges (suggest `bg-warning/15 text-warning` and `bg-muted text-muted-foreground` respectively)
- Whether `diff_stat` is parsed with regex or string splitting
- Exact wording of the panel "No uncommitted changes" message
- Error state when `listWorktreesWithStatus` query fails

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Requirements
- `.planning/REQUIREMENTS.md` §Worktrees View (Phase 27) — REQ-25 through REQ-33; complete specification for all deliverables

### Backend types (already implemented)
- `src/types/bindings.ts` — `WorktreeWithStatus` type shape (check after adding `diff_stat` field); `WorktreeWithStatus` fields: `id`, `project_id`, `task_id`, `branch_name`, `path`, `git_status`, `created_at`, `task_name`, `agent_status`, `is_zombie`

### Existing components to reuse (do not modify internals)
- `src/components/execution/DiffViewer.tsx` — `@git-diff-view/react` wrapper; already handles loading/error states. Props: `diffFile`, `loading`, `error`.
- `src/components/execution/AgentMonitor.tsx` — Reference implementation for sidebar list + right panel layout, three-line rows, filter toolbar, selected-row left-border accent.

### Backend to extend
- `src-tauri/src/ipc/worktree_handlers.rs` — `list_worktrees_with_status` must be extended to also run `git diff --shortstat` per worktree and populate a new `diff_stat` field.
- `src-tauri/src/models/worktree.rs` — Add `diff_stat: Option<String>` to `WorktreeWithStatus`; run `pnpm tauri:gen` after.

### Service patterns to follow
- `src/services/execution.service.ts` — Reference for TanStack Query hook patterns; `worktree.service.ts` follows the same structure.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `AgentMonitor.tsx`: The layout shell, three-line row pattern, left-border selection, filter toolbar — copy the structural pattern, adapt for worktree data.
- `DiffViewer.tsx`: Drop-in component. Used in `ReviewModal.tsx` — check that file for usage example.
- `KanbanView.tsx` action bar: `h-12 border-b border-border bg-muted/30` pattern with `Input` + `ToggleGroup`/`ToggleGroupItem` from shadcn/ui.
- `navigationStore.navigate({ taskId })`: Already used throughout the app for task deep links.

### Established Patterns
- TanStack Query: `useQuery` with `refetchInterval` (2s) for live worktree status. See `useExecutionsWithTaskInfoQuery` in `execution.service.ts` as the template.
- Status dots: `bg-success` (green) for clean/idle, `bg-warning animate-pulse` for active agents, `bg-warning` (static yellow) for dirty/modified.
- Props-down: view owns primary query → display component renders; secondary queries (like diff) are fine inside the display component.

### Integration Points
- `src/services/worktree.service.ts` — New file to create. Add `useWorktreesQuery`, `useWorktreeDiffQuery`, `useDeleteWorktreeMutation`, `useCreateWorktreeMutation`.
- `api.listWorktreesWithStatus(projectId)` — IPC binding from Phase 25. Verify it exists in `src/lib/index.ts` before writing the hook.
- `pnpm tauri:gen` — Must be run after adding `diff_stat` to `WorktreeWithStatus` in Rust.
- `WorktreesView.tsx` — Currently a placeholder; rewrite to wire TanStack Query and pass props to `WorktreeManager`.
- `WorktreeManager.tsx` — Currently a placeholder with static data; full rewrite.

</code_context>

<specifics>
## Specific Ideas

- Diff stat display format on line 3: `"12 files changed"` in muted text, then `"+175"` in green, `"-100"` in red — inline colored spans within the row.
- Filter chips: All / Active / Modified / Idle — the user specifically chose these over zombie/orphan-based filtering, as they reflect runtime state rather than provenance.
- The dot + branch name approach on line 1 mirrors what the user wants for at-a-glance git status.

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>

---

*Phase: 27-worktrees-view*
*Context gathered: 2026-03-30*
