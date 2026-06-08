# Review State — Implementation Plan

## Context

Task workflow works up to Review state but the review experience is a basic modal with no inline feedback capability. This plan replaces it with a full diff panel (same layout as worktree diff) supporting inline comments, file-level comments, viewed tracking, and contextual actions. The same DiffViewer component serves three contexts with different feature flags: **Task Review** (comments + viewed), **Worktree Management** (staging + commit), **Agent Session** (read-only observation).

See `review-modal-preview.html` for all UI mockups aligned with user.

## Design Decisions

1. **Task Review = full panel** (same layout as WorktreeDiffPanel), replaces ReviewModal dialog
2. **Unified DiffViewer** — reused across 3 contexts with `mode` prop controlling features
3. **Scope selector** — Bitbucket-style position (top of sidebar), opens as popover/dropdown (not inline collapsible)
4. **Inline + file comments** — blue "+" gutter on hover, file comment 💬 button in header
5. **Viewed toggle** — per-file icon button using Lucide `CheckCheck` icon (visible when viewed, no icon when not viewed). Available in ALL diff contexts. Counter in action bar.
6. **Multi-state action button** — split button, smart default (Approve when no comments, Rework when comments exist). Dropdown: Approve / Rework / Discard
7. **No schema change** for comments — line info embedded in comment text
8. **start_sha already captured** — `session_handlers.rs` already runs `git rev-parse HEAD` at session spawn, stored in `AcpProcess.session_start_sha`
9. **DiffTarget::Commit(sha)** already does `git diff --unified=6 {sha}` (working tree vs commit) — works correctly for agent session diff
10. **Request Changes → auto re-execute** immediately after mutation succeeds
11. **Pre-execution dirty check** — shows counts only, multi-state button (Ignore default / Stash / Discard)
12. **Approve modal** — conditional: radio options only when multiple choices exist; single-choice states show description + confirm button
13. **Discard modal** — multi-state button for Backlog/Cancel (not radio)

## Context-Based Feature Flags

Same DiffViewer + panel, different capabilities per context:

| Feature | Task Review | Worktree (uncommitted) | Worktree (committed/all) | Agent Session |
|---------|:-----------:|:-----:|:-----:|:-----:|
| Inline line comments | ✓ | — | — | — |
| File-level comments | ✓ | — | — | — |
| Viewed toggle (CheckCheck icon) | ✓ | ✓ | ✓ | ✓ |
| File/hunk checkboxes | — | ✓ | — | — |
| Commit message + button | — | ✓ | — | — |
| Track/discard/shelve | — | ✓ | — | — |
| Scope selector | ✓ | ✓ | ✓ | — |
| Multi-state action button | ✓ | — | — | — |
| Read-only (no actions) | — | — | ✓ | ✓ |

## Existing Infrastructure (already works, no changes needed)

- **`session_start_sha`** — captured in `src-tauri/src/acp/session_handlers.rs:112-127` via `git rev-parse HEAD`, stored in `AcpProcess.session_start_sha`, accessible via `api.getAcpSessionMeta(sessionKey)`
- **`DiffTarget::Commit(sha)`** — in `src-tauri/src/git/worktree_handlers.rs`, runs `git diff --unified=6 {sha}` = working-tree-vs-commit
- **`ReviewChangesPanel`** — already fetches `session_start_sha` and passes `DiffTarget::Commit(startSha)` to `useWorktreeDiffQuery`. Already read-only, filters by session changed files. No changes needed for agent session diff.
- **`request_changes` handler** — already moves task to InProgress and saves comments as `task_instructions` with source="review"
- **`useWorktreeDiffQuery`** — generic hook accepting any `DiffTarget`, polls every 10s, staleTime 4s
- **HunkCheckboxOverlay** in DiffViewer — portal-based overlay using MutationObserver (pattern to reuse for comment gutters)

---

## Implementation Phases

### Phase 1: Backend — New DiffTarget Variants + IPC Commands

**Goal:** Enable "all changes" and "single commit" scope views. Add dirty check + helper commands.

**`src-tauri/src/git/diff_models.rs`** — add to DiffTarget enum:
```rust
pub enum DiffTarget {
    Head,                           // git diff HEAD (existing)
    Branch(String),                 // git diff --unified=6 origin/{b}..HEAD (existing)
    Commit(String),                 // git diff --unified=6 {sha} (existing)
    BranchAll(String),              // NEW: git diff --unified=6 origin/{b} (working tree vs remote = all changes)
    CommitRange(String, String),    // NEW: git diff --unified=6 {from}..{to} (single commit view)
}
```
Add new model structs:
```rust
pub struct DirtyStatus { pub modified_count: u32, pub untracked_count: u32 }
pub struct CommitInfo { pub sha: String, pub message: String, pub file_count: u32 }
```
All with `#[derive(Debug, Clone, Serialize, Deserialize, Type, TS)]`.

**`src-tauri/src/git/worktree_handlers.rs`** — new match arms in `get_worktree_diff`:
```rust
DiffTarget::BranchAll(branch) => {
    let target = format!("origin/{}", branch);
    run_git_in_dir(&git_conn, &worktree_path, &["diff", "--unified=6", &target]).await?
}
DiffTarget::CommitRange(from, to) => {
    let range = format!("{}..{}", from, to);
    run_git_in_dir(&git_conn, &worktree_path, &["diff", "--unified=6", &range]).await?
}
```

New IPC commands:
- `check_worktree_dirty(project_id, worktree_path) -> Result<DirtyStatus, String>` — runs `git status --porcelain`, counts modified vs untracked (reuse pattern from `list_worktrees_with_status`)
- `get_worktree_commits(project_id, worktree_path, base_branch) -> Result<Vec<CommitInfo>, String>` — runs `git log --oneline {base_branch}..HEAD`, parses output
- `stash_worktree(project_id, worktree_path) -> Result<(), String>` — runs `git stash push -m "maestro-auto-stash"` (stash all, no file selection)
- `discard_all_worktree_changes(project_id, worktree_path) -> Result<(), String>` — runs `git checkout -- .` + `git clean -fd`

**`src-tauri/src/ipc/mod.rs`** — register 4 new commands in `collect_commands![]`

Run `pnpm tauri:gen` → new types appear in `src/types/bindings.ts`.

---

### Phase 2: Backend — Review Reject Cleanup + Rollback

**Goal:** Discard flow properly cleans up worktree/commits.

**`src-tauri/src/git/review_handlers.rs`** — modify `reject_review`:

When action = `"SendToBacklog"` or `"CancelTask"`:
1. Query associated worktree: `SELECT id, path, branch_name FROM worktrees WHERE task_id = ?`
2. If worktree exists: call existing `delete_worktree` logic (already in `worktree_handlers.rs`)
3. If no worktree + agent made commits: query most recent session's `start_sha`, run `git reset --hard {start_sha}` to rollback
4. Clean up uncommitted: `git checkout -- .` + `git clean -fd`

Need to make `start_sha` available to review handler:
- Option A: Store `start_sha` in tasks table (new column `execution_start_sha`)
- Option B: Query from ACP session registry by task_id
- **Recommend Option A** — simpler, survives session cleanup. Add column in schema, set it in `spawn_acp_session` or `try_complete_task`.

If Option A: add `execution_start_sha TEXT` column to tasks table in schema.rs. Set via `UPDATE tasks SET execution_start_sha = ? WHERE id = ?` during session spawn. This IS a schema change but not for reviews/comments — it's for task execution tracking.

---

### Phase 3: Frontend — ScopeSelector Component

**Goal:** Reusable popover for switching between All/Uncommitted/individual commits.

**New file: `src/components/execution/diff/ScopeSelector.tsx`**

```typescript
interface ScopeSelectorProps {
  selectedScope: DiffScope;
  onScopeChange: (scope: DiffScope) => void;
  commits: CommitInfo[];
  uncommittedFileCount: number;
  totalFileCount: number;
  isLoading?: boolean;
}

type DiffScope =
  | { type: "all" }
  | { type: "uncommitted" }
  | { type: "commit"; sha: string };
```

Renders:
- Trigger bar: colored dot + label + file/commit counts + ▼ chevron
- Popover (base-ui `Popover`): All changes / Uncommitted / divider / individual commits
- Click option → select + close → parent maps scope to DiffTarget

**New hook in `src/services/worktree.service.ts`:**
- `useWorktreeCommitsQuery(projectId, worktreePath, baseBranch)` → calls `get_worktree_commits` IPC
- Enabled only when worktreePath is set

---

### Phase 4: Frontend — DiffViewer Review Mode

**Goal:** Add comment gutters and inline comment rendering to DiffViewer.

**Modify: `src/components/execution/diff/DiffViewer.tsx`**

New props:
```typescript
reviewMode?: boolean;
comments?: PendingComment[];
activeCommentLine?: { lineNumber: number; side: "old" | "new" } | null;
onAddComment?: (lineNumber: number, side: "old" | "new") => void;
onRemoveComment?: (commentId: string) => void;
onCancelComment?: () => void;
onSubmitComment?: (text: string) => void;
```

Implementation: same portal/MutationObserver pattern as existing `HunkCheckboxOverlay`:
- Observe diff container for line cells (`td.diff-line-num`)
- Inject blue "+" buttons into gutter (shown on row hover via CSS)
- Click "+" → calls `onAddComment(lineNumber, side)` → parent sets `activeCommentLine`
- When `activeCommentLine` matches a line: render `InlineCommentInput` portal after that row
- For each comment in `comments[]` matching current file: render `PendingCommentBlock` portal after target line

**New file: `src/components/execution/diff/InlineCommentInput.tsx`**
- Textarea with placeholder "Add a comment..."
- Cancel + Add buttons
- On "Add": calls `onSubmitComment(text)` → parent creates PendingComment entry

**New file: `src/components/execution/diff/PendingCommentBlock.tsx`**
- Yellow block: comment text + ✕ remove button
- On ✕: calls `onRemoveComment(commentId)`

Comment state shape (owned by TaskReviewPanel):
```typescript
interface PendingComment {
  id: string;          // crypto.randomUUID()
  filePath: string;
  lineNumber: number;  // 0 = file-level comment
  side: "old" | "new";
  text: string;
}
```

---

### Phase 5: Frontend — DiffActionBar + DiffFilePanel Mode Support

**Goal:** Make existing components context-aware via `mode` prop.

**Modify: `src/components/execution/diff/DiffActionBar.tsx`**

Add prop: `mode: "worktree" | "review" | "session"`

Conditional layout:

| mode | Left | Center | Right |
|------|------|--------|-------|
| `worktree` | filter + list/tree + revert + shelve | branch name | viewed counter + unified/split + close |
| `review` | filter + list/tree | "Review: {title}" (purple) | viewed counter + unified/split + SplitButton + close |
| `session` | filter + list/tree | "Changes since {sha}" | viewed counter + unified/split (no close — embedded) |

New props (all modes):
- `viewedCount?: number`, `totalFileCount?: number` — for "✓ 2/5 viewed" counter (shown in all modes when > 0)
- `splitButtonNode?: ReactNode` — slot for multi-state button (review mode only)
- `centerLabel?: string` — overrides branch name

Existing worktree-specific props (`hasAnyStaged`, `onRevert`, `onShelve`, etc.) become optional — only used when `mode === "worktree"`.

**Modify: `src/components/execution/diff/DiffFilePanel.tsx`**

Add prop: `mode: "worktree" | "review" | "session"`

New props:
- `viewedFiles?: Set<string>` — renders Lucide `CheckCheck` icon per file when viewed (no icon when not viewed). Available in ALL modes.
- `onToggleViewed?: (fileName: string) => void`
- `scopeSelector?: ReactNode` — rendered at top of sidebar before file list
- `onFileComment?: (fileName: string) => void` — 💬 button in file header (review mode only)

Conditional rendering:
- `mode === "worktree"` + scope "uncommitted": show checkboxes, Modified/Untracked tabs, commit area (existing behavior)
- `mode === "worktree"` + scope NOT "uncommitted": hide checkboxes/tabs/commit area, show read-only file list
- `mode === "review"`: no checkboxes, no tabs, no commit area
- `mode === "session"`: plain file list, no extra controls

Viewed toggle (all modes):
- Sidebar: `CheckCheck` icon (Lucide) shown after filename when file is viewed, nothing when not viewed
- File header: toggle button with `CheckCheck` icon + "Viewed" label
- Click toggles viewed state in local `Set<string>`

File header (above diff body) — conditional buttons:
- All modes: `CheckCheck` Viewed toggle button
- Review mode: additionally 💬 file comment button

---

### Phase 6: Frontend — TaskReviewPanel (replaces ReviewModal)

**Goal:** New full review panel. Main orchestrator for review experience.

**New file: `src/components/execution/diff/TaskReviewPanel.tsx`**

Props:
```typescript
interface TaskReviewPanelProps {
  taskId: number;
  taskName: string;
  onClose: () => void;
}
```

Internal state:
- `diffViewMode: DiffModeEnum` — unified/split
- `fileListMode: "flat" | "tree"`
- `fileSearch: string`
- `selectedFileIndex: number | null`
- `scope: DiffScope` — default `{ type: "all" }`
- `viewedFiles: Set<string>` — local, per-session
- `comments: PendingComment[]` — all inline + file comments
- `activeCommentLine: { fileIndex, lineNumber, side } | null`
- `reworkModalOpen / approveModalOpen / discardModalOpen: boolean`

Data sources:
- `useDiffForReviewQuery(taskId)` — for "all" scope (existing hook, `staleTime: 0`)
- `useWorktreeDiffQuery(projectId, worktreePath, diffTarget)` — for other scopes
- `useWorktreeCommitsQuery(projectId, worktreePath, baseBranch)` — for scope selector
- Task worktree info: query task → join worktrees table to get worktree path + base branch

Renders:
1. `<DiffActionBar mode="review">` with viewed counter + multi-state split button
2. Flex row:
   - `<DiffFilePanel mode="review">` with ScopeSelector slot, viewed icons, no checkboxes
   - File header with 💬 + Viewed buttons + DiffViewer with `reviewMode=true`
3. Confirmation modals (Phase 7)

Multi-state button:
- No comments → default "Approve" (green)
- With comments → default "Rework" (amber)
- Dropdown: Approve / Rework / divider / Discard

---

### Phase 7: Frontend — Confirmation Modals

**Goal:** Three modals triggered from the multi-state button.

**New file: `src/components/execution/diff/ReviewConfirmModals.tsx`**

Exports: `ReworkModal`, `ApproveModal`, `DiscardModal`

**ReworkModal:**
- Collapsible list of pending comments (▼/▶ toggle, file:line + text)
- Global feedback textarea (optional)
- Cancel + "Submit review" button (amber)
- On submit:
  1. Serialize: `per_file_comments = comments.map(c => [c.filePath, \`line:${c.lineNumber} — ${c.text}\`])`
  2. Call `useRequestChangesMutation({ taskId, generalFeedback, perFileComments })`
  3. On success: call `execute(task)` from `useExecuteTask` → auto re-execute
  4. Close panel

**ApproveModal (conditional):**
- Detect: `hasWorktree` (task has associated worktree), `hasUncommitted` (dirty status)
- **State A** (worktree + uncommitted): radio — "Commit + Merge + Delete worktree" / "Commit only"
- **State B** (worktree + clean): description only + "Approve & Merge" button
- **State C** (no worktree + uncommitted): description only + "Approve & Commit" button
- **State D** (no worktree + clean): description only + "Approve" button
- On confirm: `useApproveTaskAndMergeMutation({ taskId, mergeStrategy })`

**DiscardModal (conditional):**
- Detect: `hasWorktree`, `hasAgentCommits` (commits since start_sha)
- Warning box: what gets deleted (worktree path + branch + commit count) or rolled back
- Cancel + multi-state split button: "Send to Backlog" (default) / "Cancel task" (dropdown)
- On confirm: `useRejectReviewMutation({ taskId, action })`
- Backend handles cleanup (Phase 2)

---

### Phase 8: Frontend — Pre-Execution Dirty Check

**Goal:** Warn user before executing on dirty worktree.

**Modify: `src/utils/hooks/useExecuteTask.ts`**

Insert before session spawn (after worktree path is resolved):
1. Call `api.checkWorktreeDirty(projectId, worktreePath)` → `DirtyStatus`
2. If `modified_count > 0 || untracked_count > 0`:
   - Set state to show dialog, return Promise that resolves with user choice
   - Await choice before proceeding
3. Handle choice:
   - "Ignore" → continue
   - "Stash" → call `api.stashWorktree(projectId, worktreePath)`, then continue
   - "Discard" → call `api.discardAllWorktreeChanges(projectId, worktreePath)`, then continue
   - "Cancel" → abort, return early

**New file: `src/components/execution/DirtyWorktreeDialog.tsx`**
- Description: "Target worktree has **3 modified** and **1 untracked** files. Choose how to handle them before execution starts."
- Cancel button + multi-state split button: "Ignore" (default) / Stash / divider / Discard
- Returns user choice via `onChoice: (choice: "ignore" | "stash" | "discard") => void`

**New hook in `src/services/worktree.service.ts`:**
- `useCheckWorktreeDirty` or just inline `api.checkWorktreeDirty()` call (one-shot, not polling)

---

### Phase 9: Frontend — Wire TaskReviewPanel into BoardView

**Goal:** Replace ReviewModal with TaskReviewPanel.

**Modify: `src/views/kanban/board-view/BoardView.tsx`**
- Remove `ReviewModal` import + render
- Add `TaskReviewPanel` with same trigger pattern:
  ```tsx
  {reviewPanelOpen && selectedTaskId && (
    <TaskReviewPanel
      taskId={selectedTaskId}
      taskName={selectedTaskName}
      onClose={() => { setReviewPanelOpen(false); ... }}
    />
  )}
  ```
- Panel renders as overlay or slides in (same pattern as `ExecutionTerminal` drawer)

**Delete: `src/views/kanban/review-modal/ReviewModal.tsx`**
**Delete: `src/views/kanban/review-modal/ApprovalForm.tsx`**

**Simplify: `src/store/reviewStore.ts`** — remove or simplify (TaskReviewPanel manages own state). Keep if needed for cross-component communication, otherwise delete.

---

### Phase 10: Frontend — WorktreeDiffPanel Scope Integration

**Goal:** Add scope selector to existing worktree diff panel.

**Modify: `src/components/execution/diff/WorktreeDiffPanel.tsx`**

Add state:
- `scope: DiffScope` — default `{ type: "uncommitted" }`

Add data:
- `useWorktreeCommitsQuery(projectId, worktreePath, worktree.base_branch)` — for scope selector commit list

Map scope → DiffTarget:
| Scope | DiffTarget | Notes |
|-------|-----------|-------|
| `{ type: "uncommitted" }` | `Head` | Existing behavior |
| `{ type: "all" }` | `BranchAll(baseBranch)` | New variant from Phase 1 |
| `{ type: "commit", sha }` | `CommitRange(sha + "~1", sha)` | New variant from Phase 1 |

When scope != "uncommitted":
- Hide staging state (stagedFiles, stagedHunks = empty)
- Hide commit area, checkboxes, Modified/Untracked tabs
- DiffViewer shows read-only (no `onHunkToggle`)
- DiffActionBar hides revert/shelve buttons

Mount `<ScopeSelector>` as `scopeSelector` prop to DiffFilePanel.

---

## File Change Summary

### New Files (7)
| File | Purpose |
|------|---------|
| `src/components/execution/diff/TaskReviewPanel.tsx` | Main review panel replacing ReviewModal |
| `src/components/execution/diff/ScopeSelector.tsx` | Popover for All/Uncommitted/Commit scope |
| `src/components/execution/diff/InlineCommentInput.tsx` | Comment textarea between diff lines |
| `src/components/execution/diff/PendingCommentBlock.tsx` | Submitted comment display (yellow block) |
| `src/components/execution/diff/ReviewConfirmModals.tsx` | Rework + Approve + Discard modals |
| `src/components/execution/DirtyWorktreeDialog.tsx` | Pre-execution dirty check dialog |
| `src/components/ui/SplitButton.tsx` | Reusable multi-state split button (used 3+ places) |

### Modified Files (11)
| File | Changes |
|------|---------|
| `src/components/execution/diff/DiffViewer.tsx` | Add `reviewMode`, comment gutter overlays via portals |
| `src/components/execution/diff/DiffActionBar.tsx` | Add `mode` prop, conditional layout per context |
| `src/components/execution/diff/DiffFilePanel.tsx` | Add `mode` prop, viewed icons, scope slot, conditional sections |
| `src/components/execution/diff/WorktreeDiffPanel.tsx` | Add scope state + ScopeSelector integration |
| `src/utils/hooks/useExecuteTask.ts` | Add dirty check before spawn |
| `src/views/kanban/board-view/BoardView.tsx` | Replace ReviewModal with TaskReviewPanel |
| `src/services/worktree.service.ts` | Add `useWorktreeCommitsQuery`, `useCheckWorktreeDirty` |
| `src-tauri/src/git/worktree_handlers.rs` | 4 new IPC commands + 2 new DiffTarget match arms |
| `src-tauri/src/git/diff_models.rs` | `BranchAll`, `CommitRange` variants + `DirtyStatus`, `CommitInfo` structs |
| `src-tauri/src/git/review_handlers.rs` | Worktree cleanup on reject, rollback on cancel |
| `src-tauri/src/ipc/mod.rs` | Register new commands |

### Deleted Files (2)
| File | Reason |
|------|--------|
| `src/views/kanban/review-modal/ReviewModal.tsx` | Replaced by TaskReviewPanel |
| `src/views/kanban/review-modal/ApprovalForm.tsx` | Replaced by ReviewConfirmModals |

### Potentially Modified
| File | Change |
|------|--------|
| `src-tauri/src/db/schema.rs` | Add `execution_start_sha TEXT` column to tasks table (for discard rollback) |
| `src-tauri/src/acp/session_handlers.rs` | Write `start_sha` to task row on session spawn |
| `src/store/reviewStore.ts` | Simplify or delete |

---

## Verification

### Happy Path
1. Create task → assign agent → execute → agent makes 3 commits → session ends → task in Review
2. Click "Review" → TaskReviewPanel slides in with full combined diff
3. Scope selector shows "All changes · 5 files · 3 commits" — click to see per-commit breakdown
4. Click "+" gutter on diff line → comment input → type → "Add" → yellow block appears
5. Click 💬 on file header → file-level comment input → add
6. Toggle "Viewed" on 3 files → counter shows "✓ 3/5 viewed"
7. Multi-state button shows "Rework" (comments exist) → click → modal with collapsible comment list
8. "Submit review" → task InProgress → auto re-executes with comments as instructions
9. Agent finishes → back to Review → no issues → "Approve" → squash merge → task Done

### Worktree Scope
10. Worktree diff panel → scope selector "Uncommitted" (default) → checkboxes visible
11. Switch scope "All changes" → checkboxes disappear, shows committed + uncommitted vs base
12. Switch scope to specific commit → single commit diff
13. Switch back "Uncommitted" → checkboxes + commit area return

### Dirty Check
14. Task on worktree with uncommitted changes → click Execute
15. Dialog: "3 modified and 1 untracked. Choose how to handle..."
16. "Stash" → stashed → execution proceeds
17. "Ignore" → proceeds with dirty state
18. "Discard" → changes gone → proceeds

### Approve Edge Cases
19. Approve + worktree + uncommitted → radio: "Commit+Merge+Delete" vs "Commit only"
20. Approve + worktree + clean → confirm: "Approve & Merge"
21. Approve + no worktree + uncommitted → confirm: "Approve & Commit"
22. Approve + no worktree + clean → confirm: "Approve"
23. Merge conflict → auto-rejects to InProgress with conflict details

### Discard Edge Cases
24. Discard + worktree → warns about deletion → split button: Backlog / Cancel task
25. Discard + no worktree + commits → warns about rollback → split button: Backlog / Cancel task

### Agent Session (no changes needed, verify existing)
26. Execute → agent activity panel → "Review changes" → diff vs start_sha (committed + uncommitted)

---

## Dependency Graph

```
Phase 1 (Backend: DiffTarget + IPCs)
  │
  ├──→ Phase 3 (ScopeSelector) ──→ Phase 10 (WorktreeDiffPanel scope)
  │                                       ↓
  ├──→ Phase 4 (DiffViewer review mode)   │
  │         ↓                             │
  │    Phase 5 (ActionBar + FilePanel modes)
  │         ↓
  │    Phase 6 (TaskReviewPanel) ←────────┘
  │         ↓
  │    Phase 7 (Confirm modals)
  │         ↓
  │    Phase 9 (Wire into BoardView)
  │
Phase 2 (Backend: cleanup + rollback)
  │
  └──→ Phase 8 (Dirty check dialog)
```

Parallelizable: Phase 3 + Phase 4. Phase 8 independent of Phase 5-9.
