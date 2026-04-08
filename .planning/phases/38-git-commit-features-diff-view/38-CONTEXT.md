# Phase 38: Add git commit features to the diff view - Context

**Gathered:** 2026-04-02
**Status:** Ready for planning

<domain>
## Phase Boundary

Add git commit workflow actions to the existing `WorktreeDiffPanel`: file-level selection via checkboxes, hunk-level selection via per-hunk checkboxes, commit (with message), discard/revert (file + hunk granularity), and shelve (git stash with name). The diff view itself (file list, DiffViewer, flat/tree modes, action bar) is unchanged — this phase adds write operations on top.

**In scope:**
- File checkboxes in the file list panel (3-state: unchecked / indeterminate / checked)
- Hunk checkboxes in the diff body (per-hunk @@ header)
- Commit area (textarea + Commit button) that appears at the bottom of the file list panel when any file/hunk is staged
- Revert button in the action bar — applies to checked files/hunks
- Shelve button in the action bar — popover with auto-filled name + Confirm
- New Rust IPC commands: `stage_worktree_files`, `commit_worktree`, `discard_worktree_changes`, `shelve_worktree_changes`

**Out of scope:**
- Branch diff mode (DiffTarget::Branch) — still deferred
- Stash list / stash browser — separate phase
- Amend last commit — separate phase

</domain>

<decisions>
## Implementation Decisions

### File selection model
- Each file entry in the file list panel gets a **checkbox** (3-state: unchecked, indeterminate, checked)
- Checked = staged (git add). Unchecked = not staged. Indeterminate = some hunks staged, some not.
- Staging flow: **stage-then-commit** (git add → git commit). Not direct commit (-a style).
- Diff view always shows **HEAD diff** (uncommitted changes) regardless of staging state. The diff is visual-only; staging state is expressed by checkbox state only — not by switching to `git diff --staged`.

### Commit area
- Commit area lives at the **bottom of the file list panel** (left panel, below the file entries).
- **Only appears when at least one file or hunk is staged** (any checkbox is checked). Hidden when nothing is staged.
- Layout: textarea for commit message + Commit button below it.
- **After successful commit:**
  - Always show a success toast.
  - If **no remaining uncommitted changes** after commit → close the diff panel (return to card grid). Invalidate worktrees query.
  - If **uncommitted changes remain** (partial commit) → stay in diff panel. Clear commit message, refresh the diff. Invalidate worktrees + diff queries.

### Action bar — commit controls
- **Revert button** in the diff panel action bar: applies discard to checked files/hunks. Icon button (e.g. `RotateCcw` from lucide). Requires confirmation dialog before destructive action.
- **Shelve button** in the diff panel action bar: opens a popover. Popover contains a text input pre-filled with an automatic name (e.g. `wip-{branch}-{YYYY-MM-DD}`) + Confirm button. Applies `git stash push` on checked files.
- Both Revert and Shelve buttons are **disabled** when nothing is selected (no checkboxes checked).

### Block-level (hunk) staging
- Each hunk in the diff body gets a **checkbox next to the @@ hunk header**.
- Hunk checkbox checked = stage that hunk. Uses `git apply --cached` with the patch for just that hunk.
- Checking a file's top-level checkbox toggles ALL hunks for that file at once.
- Checking individual hunk checkboxes updates the file checkbox state:
  - All hunks checked → file checkbox checked
  - No hunks checked → file checkbox unchecked
  - Some hunks checked → file checkbox **indeterminate** (dash/minus icon)
- **Revert also respects hunk selection**: if hunks (not the whole file) are selected, revert applies `git apply --reverse` on only those hunks. If the whole file is checked, revert uses `git checkout -- file`.

### Claude's Discretion
- Exact icon choices for Revert / Shelve buttons in the action bar
- Visual appearance of indeterminate checkbox state (browser native or custom)
- Exact hunk checkbox placement and size within the diff view gutter
- Confirmation dialog copy for the Revert action
- Auto-name format for shelve (pattern: `wip-{branch}-{date}` or similar)
- How `DiffViewer` exposes hunk header rows for checkbox injection (may need a prop for hunk selection callbacks)

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Existing diff panel to extend
- `src/components/execution/WorktreeDiffPanel.tsx` — current diff panel; file list + diff body; add checkboxes, revert, shelve, commit area
- `src/components/execution/DiffViewer.tsx` — current diff renderer; needs hunk checkbox injection support
- `src/components/execution/FileTree.tsx` — tree mode file entries; also needs checkbox state support

### Backend IPC to add to
- `src-tauri/src/ipc/worktree_handlers.rs` — existing worktree handlers; add new stage/commit/discard/shelve commands here
- `src-tauri/src/git/mod.rs` — `run_git_in_dir` utility (pattern for all new git operations)
- `src-tauri/src/models/worktree.rs` — `WorktreeWithStatus` model (reference for types)

### Services and state
- `src/services/worktree.service.ts` — `useWorktreeDiffQuery`, `useWorktreesQuery`; add new mutations for stage/commit/discard/shelve
- `src/types/bindings.ts` — auto-generated types; regenerate after adding new IPC commands
- `src/types/review.ts` — `DiffFile`, `DiffFileWithName` types (check hunk structure for hunk-level operations)

### Diff parsing utilities
- `src/utils/helpers/diff-utils.ts` (or wherever `parseDiffString` and `computeFileStats` live) — understand hunk data structure for per-hunk patch extraction
- `src/utils/helpers/diff-utils.test.ts` — existing tests; don't break them

### Patterns to follow
- Phase 36 CONTEXT.md decisions — file list selected state, flat/tree mode, DiffTarget::Head
- Phase 37 CONTEXT.md decisions — action bar layout (left: controls, center: branch name, right: mode toggle + close); slide-in panel architecture
- Worktree card delete confirmation dialog pattern — reuse for Revert confirmation

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `WorktreeDiffPanel.tsx`: file list already has `selectedFileIndex` state, flat/tree toggle, file search — add checkbox state alongside existing selection state
- `parseDiffString(diffString)` → `DiffFile[]`: each `DiffFile` has `hunks` array — use for per-hunk patch extraction
- `computeFileStats(hunks)` — already imported in WorktreeDiffPanel; use for displaying stats in commit area
- `AlertDialog` (already in use for worktree delete) — reuse for Revert confirmation
- `Button`, `Input`, `ToggleGroup` — already imported in WorktreeDiffPanel
- `RotateCcw`, `Archive` from lucide — candidate icons for Revert / Shelve buttons
- `run_git_in_dir` in Rust — pattern for all new git shell commands (git add, git commit, git stash, git apply --cached, git apply --reverse)

### Established Patterns
- `useDeleteWorktreeMutation` pattern — use as model for new write mutation hooks (stage, commit, discard, shelve)
- Invalidating `useWorktreesQuery` + `useWorktreeDiffQuery` after mutations (already done in delete flow)
- `border-l-2 bg-muted/20` selected state — don't conflict with checkbox UI (may need to separate click-to-view from checkbox-to-stage)
- `text-success` / `text-destructive` for +/- stats — already established

### Integration Points
- State to add in `WorktreeDiffPanel`: `stagedFiles: Set<string>` (checked file paths), `stagedHunks: Map<string, Set<number>>` (file → hunk indices)
- `DiffViewer` will need new props to render hunk checkboxes: `hunkSelection?: Set<number>`, `onHunkToggle?: (hunkIndex: number) => void`
- After commit: invalidate both `worktreeQueryKeys.diff(worktreeId)` and `worktreeQueryKeys.list` so the card grid updates

</code_context>

<specifics>
## Specific Ideas

- Commit area is anchored to the bottom of the file list panel (left side, not the diff body) — mirrors VS Code Source Control panel layout
- Commit area visibility is conditional: only renders when `stagedFiles.size > 0 || stagedHunks total > 0`
- Shelve auto-name format: `wip-{branch_name}-{YYYY-MM-DD}` — pre-filled, user can override
- Hunk checkboxes appear next to the @@ hunk header line in the diff body — not in the file list panel

</specifics>

<deferred>
## Deferred Ideas

- Stash browser / stash list — view and apply saved stashes (separate phase)
- Amend last commit (git commit --amend) — separate phase
- Line-level staging (individual line selection within a hunk) — too granular for now, hunk-level is sufficient
- Branch diff mode (DiffTarget::Branch) — already deferred from Phase 36

</deferred>

---

*Phase: 38-git-commit-features-diff-view*
*Context gathered: 2026-04-02*
