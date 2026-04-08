# Phase 38: Add git commit features to the diff view - Research

**Researched:** 2026-04-02
**Domain:** Git staging workflow UI (tri-state checkboxes, hunk-level staging, commit/revert/shelve) layered on top of an existing Tauri + React diff panel
**Confidence:** HIGH — all findings sourced from direct codebase inspection of canonical files

## Summary

Phase 38 adds write operations (stage, commit, discard, shelve) to the existing `WorktreeDiffPanel`. The diff panel is already a mature, standalone React component with a file list, DiffViewer, flat/tree modes, and a polling query. This phase layers checkbox state onto those existing file entries and hunk header rows, and adds four new Rust IPC commands that run git operations through the already-established `run_git_in_dir` dispatcher.

The most complex part is hunk-level staging: `git apply --cached` requires producing a valid patch string for exactly one hunk, including the file headers. The diff parser (`parseDiffString`) stores each file's full content (including `---`/`+++` headers) as a single string in `hunks[0]`. To stage individual hunks, you need to split that string back into individual `@@` blocks and produce a minimal valid patch per hunk. This is purely a string manipulation problem with a clear shape — no new dependencies needed.

The Rust side follows a well-worn pattern: four new `#[tauri::command]` functions in `worktree_handlers.rs`, all using `run_git_in_dir` for dispatch (local + SSH), registered in `lib.rs::create_builder()`, and mirrored by four new mutation hooks in `worktree.service.ts`.

**Primary recommendation:** Build the staging state (`stagedFiles`/`stagedHunks`) entirely in frontend React state. The backend only applies git operations on explicit user action — it is not queried for current index state.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- File checkboxes in the file list panel (3-state: unchecked, indeterminate, checked). Checked = staged. Staging flow: stage-then-commit (git add → git commit). Not direct commit (-a style).
- Diff view always shows HEAD diff regardless of staging state. Staging state is expressed by checkbox state only — not by switching to `git diff --staged`.
- Commit area lives at the bottom of the file list panel (left panel, below file entries). Only appears when at least one file or hunk is staged.
- Layout: textarea for commit message + Commit button below it.
- After successful commit: toast. If no remaining uncommitted changes → close diff panel + invalidate worktrees query. If uncommitted changes remain → stay in diff panel, clear message, refresh diff, invalidate both queries.
- Revert button in action bar: icon button, requires confirmation dialog before destructive action. Applies discard to checked files/hunks.
- Shelve button in action bar: opens a popover with auto-filled name (`wip-{branch}-{YYYY-MM-DD}`) + Confirm button. Applies `git stash push` on checked files.
- Both Revert and Shelve are disabled when nothing is selected.
- Each hunk in the diff body gets a checkbox next to the `@@` hunk header.
- Hunk checkbox checked = stage that hunk via `git apply --cached` with patch for just that hunk.
- Checking a file's top-level checkbox toggles ALL hunks for that file at once.
- Checking individual hunk checkboxes updates the file checkbox state (all = checked, none = unchecked, some = indeterminate).
- Revert respects hunk selection: if hunks (not the whole file) are selected, revert applies `git apply --reverse` on only those hunks. If whole file is checked, revert uses `git checkout -- file`.
- New Rust IPC commands: `stage_worktree_files`, `commit_worktree`, `discard_worktree_changes`, `shelve_worktree_changes`.

### Claude's Discretion
- Exact icon choices for Revert / Shelve buttons in the action bar
- Visual appearance of indeterminate checkbox state (browser native or custom)
- Exact hunk checkbox placement and size within the diff view gutter
- Confirmation dialog copy for the Revert action
- Auto-name format for shelve (pattern: `wip-{branch}-{date}` or similar)
- How `DiffViewer` exposes hunk header rows for checkbox injection (may need a prop for hunk selection callbacks)

### Deferred Ideas (OUT OF SCOPE)
- Stash browser / stash list — view and apply saved stashes (separate phase)
- Amend last commit (git commit --amend) — separate phase
- Line-level staging (individual line selection within a hunk) — too granular for now
- Branch diff mode (DiffTarget::Branch) — already deferred from Phase 36
</user_constraints>

## Standard Stack

### Core — already in project, no new installs
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| React + TypeScript | 19 / strict | Component logic + types | Project baseline |
| @tanstack/react-query | existing | Mutations for stage/commit/discard/shelve | All IPC mutations use this pattern |
| sonner | existing | Success/error toasts | Already used in all mutation hooks |
| @base-ui/react/checkbox | existing | Checkbox primitive (3-state via `indeterminate` prop) | Already installed, used in WorktreesView |
| @base-ui/react/alert-dialog | existing | Revert confirmation dialog | Already used for delete worktree confirmation |
| @base-ui/react/popover | existing | Shelve name popover | Already installed and used |
| lucide-react | existing | Icons for action bar buttons | RotateCcw (revert), Archive (shelve) are available |
| tokio::process::Command | Rust stdlib pattern | git CLI dispatch in Rust backend | All git ops in this project use this |

**Installation:** No new dependencies required — all libraries are already present.

## Architecture Patterns

### Recommended Project Structure (additions only)

```
src/components/execution/
├── WorktreeDiffPanel.tsx    ← add checkbox state, commit area, revert/shelve buttons
├── DiffViewer.tsx           ← add hunkSelection/onHunkToggle props
└── FileTree.tsx             ← add checkedFiles/onToggleFile props

src/services/
└── worktree.service.ts      ← add 4 new mutation hooks

src-tauri/src/ipc/
└── worktree_handlers.rs     ← add 4 new #[tauri::command] functions

src-tauri/src/lib.rs         ← register the 4 new commands in create_builder()
src/types/bindings.ts        ← regenerate after Rust changes (pnpm tauri:gen)
```

### Pattern 1: Staging state in WorktreeDiffPanel

```typescript
// Source: WorktreeDiffPanel.tsx current structure + CONTEXT.md decisions
// State to add — local to WorktreeDiffPanel
const [stagedFiles, setStagedFiles] = useState<Set<string>>(new Set());
const [stagedHunks, setStagedHunks] = useState<Map<string, Set<number>>>(new Map());

// Derived: any staging active?
const hasAnyStaged = stagedFiles.size > 0 ||
  [...stagedHunks.values()].some(s => s.size > 0);

// Derived: effective staged hunk count for a file (for indeterminate state)
function getFileCheckState(fileName: string, file: DiffFileWithName): "checked" | "unchecked" | "indeterminate" {
  if (stagedFiles.has(fileName)) return "checked";
  const hunkSet = stagedHunks.get(fileName);
  if (!hunkSet || hunkSet.size === 0) return "unchecked";
  // count total hunks in this file
  const totalHunks = countHunks(file.hunks[0]);
  if (hunkSet.size === totalHunks) return "checked";
  return "indeterminate";
}
```

### Pattern 2: @base-ui Checkbox with indeterminate state

```typescript
// Source: src/components/ui/checkbox.tsx (base-ui/react/checkbox)
// The base-ui Checkbox.Root accepts indeterminate via the `indeterminate` prop.
// The Checkbox component in ui/checkbox.tsx wraps CheckboxPrimitive.Root directly.
// To render indeterminate, use the primitive directly or extend the ui/checkbox component.

// Option A: Use CheckboxPrimitive.Root directly with indeterminate prop:
import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox";
<CheckboxPrimitive.Root
  indeterminate={fileState === "indeterminate"}
  checked={fileState === "checked"}
  onCheckedChange={...}
/>

// Option B: Extend the existing Checkbox component to accept indeterminate prop.
// Either way is acceptable — CONTEXT.md leaves visual appearance to Claude's discretion.
```

### Pattern 3: Hunk-level patch extraction from current diff-utils data shape

The critical insight about the data shape: `parseDiffString` stores the ENTIRE per-file diff content (including `--- a/file`, `+++ b/file` headers and ALL `@@` blocks) as a single string in `file.hunks[0]`. The `hunks` array always has exactly one element per file.

To stage an individual hunk, you must:
1. Parse `file.hunks[0]` to split out individual `@@` blocks
2. Reconstruct a valid unified diff patch: `--- a/file\n+++ b/file\n@@ ... @@\n<lines>`
3. Pass that patch string to the Rust `stage_worktree_files` IPC command
4. Rust applies it via: `git apply --cached -` (read patch from stdin) or write to temp file

```typescript
// Source: diff-utils.ts structure analysis
// hunks[0] shape example:
// "--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1,5 +1,7 @@ context\n line\n+added\n"
//
// To extract hunk N:
function extractHunkPatch(fileHunkContent: string, hunkIndex: number): string {
  const lines = fileHunkContent.split("\n");
  const headerLines: string[] = [];
  const hunkBlocks: string[][] = [];
  let currentBlock: string[] | null = null;

  for (const line of lines) {
    if (line.startsWith("--- ") || line.startsWith("+++ ")) {
      headerLines.push(line);
    } else if (line.startsWith("@@")) {
      if (currentBlock) hunkBlocks.push(currentBlock);
      currentBlock = [line];
    } else if (currentBlock) {
      currentBlock.push(line);
    }
  }
  if (currentBlock) hunkBlocks.push(currentBlock);

  const targetBlock = hunkBlocks[hunkIndex];
  if (!targetBlock) return "";
  return [...headerLines, ...targetBlock].join("\n") + "\n";
}

// Count how many @@ blocks a file has (for indeterminate logic):
function countHunks(hunkContent: string): number {
  return (hunkContent.match(/^@@/gm) ?? []).length;
}
```

### Pattern 4: Rust IPC command shape (matches existing handlers)

```rust
// Source: worktree_handlers.rs existing pattern (get_worktree_diff, delete_worktree)
// All new commands follow this exact shape:

#[tauri::command]
#[specta::specta]
pub async fn stage_worktree_files(
    app_state: State<'_, Arc<AppState>>,
    worktree_id: i32,
    // For whole-file staging: list of file paths relative to worktree
    file_paths: Vec<String>,
    // For hunk staging: patch string to apply via git apply --cached
    patch: Option<String>,
) -> Result<(), String> {
    // 1. Query DB for worktree abs path (same JOIN as get_worktree_diff)
    // 2. Resolve GitConnection via get_project_with_git_conn
    // 3. If file_paths non-empty: run_git_in_dir(&conn, &abs_path, &["add", "--", ...file_paths])
    // 4. If patch Some: write patch to temp file, run git apply --cached <tempfile>
    //    OR: use run_git_in_dir with stdin piping (requires TokioCommand::new("git").stdin(...))
    // Note: run_git_in_dir does not support stdin — for patch apply, use TokioCommand directly
}

#[tauri::command]
#[specta::specta]
pub async fn commit_worktree(
    app_state: State<'_, Arc<AppState>>,
    worktree_id: i32,
    message: String,
) -> Result<(), String> {
    // git commit -m "{message}" in worktree abs path
    // Returns Err if nothing staged (git commit fails with non-zero exit)
}

#[tauri::command]
#[specta::specta]
pub async fn discard_worktree_changes(
    app_state: State<'_, Arc<AppState>>,
    worktree_id: i32,
    file_paths: Vec<String>,       // whole files: git checkout -- <files>
    patch: Option<String>,         // hunk-level: git apply --reverse <patch>
) -> Result<(), String> {
    // Mutually exclusive: either file_paths or patch, not both
}

#[tauri::command]
#[specta::specta]
pub async fn shelve_worktree_changes(
    app_state: State<'_, Arc<AppState>>,
    worktree_id: i32,
    stash_name: String,
    file_paths: Vec<String>,       // files to include in stash (empty = all)
) -> Result<(), String> {
    // git stash push -m "{stash_name}" -- <file_paths>
    // or git stash push -m "{stash_name}" if file_paths empty
}
```

### Pattern 5: TanStack Query mutation hooks (matches existing worktree.service.ts)

```typescript
// Source: worktree.service.ts useDeleteWorktreeMutation pattern
export function useStageWorktreeFilesMutation() {
  return useMutation({
    mutationFn: async ({ worktreeId, filePaths, patch }: {
      worktreeId: number;
      filePaths: string[];
      patch?: string;
    }) => api.stageWorktreeFiles(worktreeId, filePaths, patch ?? null),
    // No automatic invalidation — staging doesn't change git_status visible in card grid
    // Diff query stays live via its 5s polling interval
    onError: (error) => toast.error(`Failed to stage: ${error}`),
  });
}

export function useCommitWorktreeMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ worktreeId, message }: { worktreeId: number; message: string }) =>
      api.commitWorktree(worktreeId, message),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: worktreeQueryKeys.all });
      toast.success("Committed successfully");
    },
    onError: (error) => toast.error(`Commit failed: ${error}`),
  });
}
```

### Pattern 6: DiffViewer hunk checkbox injection

The `DiffViewer` currently renders `<DiffView data={diffFile} .../>` from `@git-diff-view/react`. The `DiffView` component renders hunk header rows. The approach with the least coupling is:

**Option A (overlay):** Render checkboxes as absolutely-positioned overlays on the hunk `@@` header rows using a ref + MutationObserver or a wrapping div with CSS targeting `[data-role="hunk"]` rows from the library's DOM output. HIGH risk of breaking on library updates.

**Option B (custom hunk renderer):** `@git-diff-view/react` `DiffView` accepts `renderWidgetLine` and other slot props for custom rendering. This is the documented extension point.

**Option C (render above DiffViewer):** Render checkboxes in a separate column overlay div that is scrolled in sync with the DiffViewer. Complex.

**Recommended approach (CONTEXT.md says Claude's discretion on how DiffViewer exposes hunk headers):** Add new props to `DiffViewer`:
```typescript
interface DiffViewerProps {
  diffFile: DiffFile | null;
  loading: boolean;
  error?: string;
  diffViewMode?: DiffModeEnum;
  // NEW props for hunk checkbox support
  hunkSelection?: Set<number>;
  onHunkToggle?: (hunkIndex: number) => void;
}
```
Then pass these into a wrapper that overlays checkbox elements on the `@@` rows. The simplest workable approach is to parse hunk header positions from the rendered DOM after mount (fragile) OR to render a parallel hunk header strip in the left panel that scrolls in sync. Given the complexity, the pragmatic approach may be rendering checkboxes ABOVE the DiffViewer in the per-file header section (one per hunk with a collapsed summary), rather than inline with the diff gutter.

**CONTEXT.md leaves hunk checkbox placement to Claude's discretion** — the planner should pick the least-risky approach.

### Anti-Patterns to Avoid
- **Querying `git status --porcelain=v2` or `git diff --cached` to drive UI checkbox state.** The decision (CONTEXT.md) is that checkbox state is pure React state, not synced from git index. The diff view always shows HEAD diff.
- **Mutating staging state via IPC for every checkbox click.** Stage only on explicit user action (select hunks then use the action bar), not live. This avoids race conditions with the 5s diff polling.
- **Using `run_git_in_dir` for stdin-based patch application.** `run_git_in_dir` captures stdout only and doesn't support stdin injection. Use `TokioCommand` directly for `git apply --cached -` (stdin pipe) or write to a temp file.
- **Calling `git add .` or `git add -u` in the stage command.** These stage untracked/all files, not specific files. Use `git add -- file1 file2` for precise file-level staging.
- **Forgetting to unstage before discard.** If files are staged (in git index) and the user hits Revert, you must also call `git reset HEAD -- <files>` before `git checkout -- <files>`. Otherwise git checkout will not discard staged changes.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Tri-state checkbox | Custom CSS checkbox | `@base-ui/react/checkbox` with `indeterminate` prop | Already installed; handles accessibility, keyboard nav |
| Confirmation before destructive action | Custom modal | `AlertDialog` from `@/ui/alert-dialog` | Already used in WorktreesView for delete; identical pattern |
| Shelve name popover | Custom floating div | `Popover` / `PopoverContent` from `@/ui/popover` | Already installed and used in project |
| Diff polling after commit | Manual polling or websocket | `queryClient.invalidateQueries` + existing `refetchInterval: 5000` | TanStack Query already handles live polling |
| Date formatting for auto-name | Manual date string | Use `new Date().toISOString().split('T')[0]` (no library needed) | Produces `YYYY-MM-DD`, matches the pattern requirement |

## Common Pitfalls

### Pitfall 1: Staged index state not reset after commit
**What goes wrong:** User commits, diff is still showing the now-committed lines (5s polling lag). More importantly, `stagedFiles` and `stagedHunks` sets still contain the committed files, so the commit area and action bar buttons remain enabled.
**Why it happens:** React state is not reset by query invalidation.
**How to avoid:** In the `onSuccess` callback of `useCommitWorktreeMutation`, explicitly call `setStagedFiles(new Set())` and `setStagedHunks(new Map())`. The CONTEXT.md decision already specifies "clear commit message" — extend to also clear staging state.
**Warning signs:** Commit area visible after successful commit.

### Pitfall 2: `git apply --cached` patch format is strict
**What goes wrong:** `git apply --cached` rejects the patch with "patch does not apply".
**Why it happens:** The patch must have correct line counts in the `@@` header. If the extracted hunk has a different number of lines than the `@@` header claims (due to parser quirk or trailing newline), git rejects it.
**How to avoid:** Preserve the hunk lines exactly as extracted from `parseDiffString` output without modifying them. Do not trim trailing newlines on the patch string — git apply is sensitive to the final newline.
**Warning signs:** `git apply --cached` exits non-zero with "patch does not apply" even for valid-looking patches.

### Pitfall 3: Unstage required before file-level discard
**What goes wrong:** `git checkout -- <file>` silently does nothing (or errors) if the file is in the staging area (index).
**Why it happens:** `git checkout --` restores the working tree from the index, not from HEAD, when a staged version exists.
**How to avoid:** In the `discard_worktree_changes` handler, always run `git reset HEAD -- <files>` before `git checkout -- <files>`. This ensures working tree is restored to HEAD state.
**Warning signs:** Revert appears to succeed (exit 0) but file content unchanged.

### Pitfall 4: Staging state drift on diff refresh
**What goes wrong:** The diff polling refreshes (5s), `diffFiles` changes (e.g., context lines update), and the `stagedHunks` map still has hunk indices pointing to stale positions.
**Why it happens:** Hunk indices in `stagedHunks` are positional (0, 1, 2...). If a file gains or loses a hunk between polls, the indices become wrong.
**How to avoid:** Treat a diff refresh as a signal to clear hunk selection for affected files (not staging — just the UI selection state). The simplest approach: when `diffFiles` changes identity (reference check), reset `stagedHunks` for files where the hunk count changed. Alternatively, key hunks by content hash rather than index (more robust but more complex).
**Warning signs:** Checking a hunk checkbox stages the wrong hunk after a background diff refresh.

### Pitfall 5: `shelve_worktree_changes` with file list vs. no file list
**What goes wrong:** `git stash push -- file1` does not include untracked files. `git stash push -u` includes untracked but stashes ALL files.
**Why it happens:** git stash path limiting and untracked handling interact.
**How to avoid:** Use `git stash push -m "{name}" -- <files>` for the checked files. Accept that untracked files within those paths are NOT stashed (standard git stash behavior). Document this limitation clearly in the UI copy.
**Warning signs:** User expects untracked files to be stashed but they remain after shelve.

### Pitfall 6: `run_git_in_dir` stdout-only — cannot pass stdin for patch apply
**What goes wrong:** Attempting to use `run_git_in_dir(&conn, &abs_path, &["apply", "--cached", "-"])` will hang or fail because there is no stdin pipe — `run_git_in_dir` uses `.output()` which closes stdin.
**Why it happens:** `TokioCommand::output()` does not allow writing to stdin.
**How to avoid:** For patch application, write the patch content to a `NamedTempFile` (using the `tempfile` crate, already available transitively, or use `std::env::temp_dir()` + random name), then pass the temp file path as the argument: `["apply", "--cached", &temp_path]`. Delete the temp file after the command completes.
**Warning signs:** `git apply` hangs waiting for stdin.

## Code Examples

### Staging state initialization pattern
```typescript
// Source: WorktreeDiffPanel.tsx + CONTEXT.md decisions
// Add these alongside existing useState declarations
const [stagedFiles, setStagedFiles] = useState<Set<string>>(new Set());
const [stagedHunks, setStagedHunks] = useState<Map<string, Set<number>>>(new Map());

// Reset staging state when worktree changes (mirrors existing selectedFileIndex reset)
useEffect(() => {
  setStagedFiles(new Set());
  setStagedHunks(new Map());
}, [worktreeId]);

const hasAnyStaged = stagedFiles.size > 0 ||
  [...stagedHunks.values()].some(s => s.size > 0);
```

### Indeterminate checkbox rendering (base-ui pattern)
```typescript
// Source: src/components/ui/checkbox.tsx (existing CheckboxPrimitive.Root import)
// The base-ui Checkbox.Root supports indeterminate as a first-class prop.
// Either extend the existing Checkbox wrapper or use CheckboxPrimitive.Root directly.
import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox";

// For file list entries:
<CheckboxPrimitive.Root
  checked={fileState === "checked"}
  indeterminate={fileState === "indeterminate"}
  onCheckedChange={(checked) => handleFileToggle(file.fileName, checked)}
  className="..." // size-4 border rounded styling matching existing checkbox.tsx
>
  <CheckboxPrimitive.Indicator>
    {fileState === "indeterminate" ? <Minus className="size-3.5" /> : <CheckIcon className="size-3.5" />}
  </CheckboxPrimitive.Indicator>
</CheckboxPrimitive.Root>
```

### Rust: DB path lookup pattern (reuse from get_worktree_diff)
```rust
// Source: worktree_handlers.rs get_worktree_diff (lines 239-267)
// All 4 new commands use the same 3-step path resolution:
let (wt_path, repo_path, wt_project_id): (String, String, i32) = {
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
    conn.query_row(
        "SELECT w.path, p.path, w.project_id
         FROM worktrees w
         JOIN projects p ON p.id = w.project_id
         WHERE w.id = ?",
        rusqlite::params![worktree_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )
    .map_err(|e| format!("Worktree {} not found: {}", worktree_id, e))?
};
let (_project, git_conn) = crate::db::get_project_with_git_conn(&app_state, wt_project_id).await?;
let worktree_abs = format!("{}/{}", repo_path, wt_path);
```

### Rust: Patch application via temp file
```rust
// Source: pattern derived from existing TokioCommand usage in git/mod.rs
use std::io::Write;

async fn apply_patch_cached(abs_path: &str, patch: &str) -> Result<(), String> {
    // Write patch to temp file
    let tmp_dir = std::env::temp_dir();
    let tmp_path = tmp_dir.join(format!("maestro-patch-{}.diff", std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis()));
    std::fs::write(&tmp_path, patch.as_bytes())
        .map_err(|e| format!("Failed to write patch file: {}", e))?;

    let output = tokio::process::Command::new("git")
        .args(["apply", "--cached", &tmp_path.to_string_lossy()])
        .current_dir(abs_path)
        .output()
        .await
        .map_err(|e| format!("git apply failed: {}", e))?;

    let _ = std::fs::remove_file(&tmp_path); // best-effort cleanup

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git apply --cached failed: {}", stderr));
    }
    Ok(())
}
```

### Auto-name for shelve
```typescript
// Source: CONTEXT.md decisions + standard JS date formatting
function buildShelveName(branchName: string): string {
  const date = new Date().toISOString().split("T")[0]; // "YYYY-MM-DD"
  // sanitize branch name: replace / and non-alphanumeric with -
  const sanitized = branchName.replace(/[^a-zA-Z0-9-]/g, "-").replace(/-+/g, "-");
  return `wip-${sanitized}-${date}`;
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| git index queried for staging state | Staging state in React useState only | Phase 38 decision (CONTEXT.md) | No round-trips; diff view remains HEAD-only |
| Monolithic diff panel with no write ops | Split: read-only diff + write staging actions | Phase 38 | WorktreeDiffPanel gains write capabilities |

## Open Questions

1. **How does `DiffViewer` render hunk `@@` headers for checkbox injection?**
   - What we know: `DiffView` from `@git-diff-view/react` renders the diff DOM. The library has `renderWidgetLine` and `extendData` extension points.
   - What's unclear: Whether these extension points allow rendering inline checkbox controls on hunk header rows, or whether a completely custom rendering approach is needed.
   - Recommendation: The planner should scope hunk checkboxes as a SEPARATE task after the file-level checkbox task is complete. If `@git-diff-view/react` extension points are insufficient, fall back to rendering hunk checkboxes as a list in the file header bar (below the file stats bar) rather than inline in the diff body.

2. **Remote SSH worktrees: does `git apply --cached` via SSH work through `run_git_in_dir`?**
   - What we know: `run_git_in_dir` for remote uses `ssh.execute_command(&cmd)` — it runs a shell command string on the remote host. Patch application needs the patch content to reach the remote.
   - What's unclear: The temp-file approach for patch application writes the patch locally but the remote git runs on the SSH host. The patch needs to be transferred.
   - Recommendation: For MVP, scope hunk-level staging as local-only. For remote worktrees with hunks, fall back to whole-file staging. The planner should note this scoping decision.

3. **`commit_worktree` git config requirement: user.name and user.email**
   - What we know: `git commit` requires `user.name` and `user.email` to be set in git config (global or local).
   - What's unclear: Whether worktrees in this project always have these configured (likely yes since they're created from an existing repo).
   - Recommendation: Add `-c user.email=maestro@local -c user.name=Maestro` fallback args to the git commit command to avoid failures on unconfigured systems.

## Environment Availability

Step 2.6: SKIPPED (no new external dependencies — all operations use git CLI which is already required by the project and validated by existing worktree operations)

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest |
| Config file | vite.config.ts (vitest configured inline) |
| Quick run command | `pnpm test` |
| Full suite command | `pnpm test` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| (hunk parsing) | `extractHunkPatch(hunkContent, 0)` returns valid patch for first hunk | unit | `pnpm test -- diff-utils` | ❌ Wave 0 — new function |
| (hunk counting) | `countHunks(hunkContent)` returns correct number of `@@` blocks | unit | `pnpm test -- diff-utils` | ❌ Wave 0 — new function |
| (staging state) | File checkbox state derived correctly (checked/unchecked/indeterminate) | unit | `pnpm test` | ❌ Wave 0 — new util |
| (existing) | `parseDiffString` still passes | unit | `pnpm test -- diff-utils` | ✅ exists |

### Sampling Rate
- **Per task commit:** `pnpm test`
- **Per wave merge:** `pnpm test`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `extractHunkPatch` function in `diff-utils.ts` — covers hunk patch extraction
- [ ] `countHunks` function in `diff-utils.ts` — covers indeterminate state logic
- [ ] Tests for both new functions in `diff-utils.test.ts`

## Project Constraints (from CLAUDE.md)

| Directive | Applies to Phase 38 |
|-----------|---------------------|
| Use `eprintln!` not `log::` for Rust diagnostic output | All 4 new IPC handlers must use `eprintln!` |
| Direct imports only — no barrel `index.ts` | Import from `@/components/execution/DiffViewer` directly |
| ts-rs: run `pnpm tauri:gen` after Rust model changes | Required after adding new IPC command types |
| IPC returns `Result<T, String>` | All 4 new commands return `Result<..., String>` |
| Register commands in `lib.rs::create_builder()` via `collect_commands![]` | Add all 4 new commands to the macro |
| State via `State<'_, Arc<AppState>>` + Mutex lock pattern | All new handlers use the established lock pattern |
| TypeScript strict mode | New hook types must compile with strict |
| TanStack Query for all IPC mutations | 4 new mutation hooks in `worktree.service.ts` |

## Sources

### Primary (HIGH confidence)
- Direct read of `WorktreeDiffPanel.tsx` — current component structure, state, queries
- Direct read of `DiffViewer.tsx` — current props interface
- Direct read of `FileTree.tsx` — current props interface
- Direct read of `diff-utils.ts` — exact data shape of `parseDiffString` output (hunks as single string)
- Direct read of `worktree_handlers.rs` — Rust IPC pattern, DB query pattern, `run_git_in_dir` usage
- Direct read of `git/mod.rs` — `run_git_in_dir` implementation (stdout-only, no stdin)
- Direct read of `worktree.service.ts` — mutation hook pattern, query key factory
- Direct read of `WorktreesView.tsx` — AlertDialog usage, Checkbox usage, Popover availability
- Direct read of `src/components/ui/checkbox.tsx` — base-ui Checkbox.Root with indeterminate prop
- Direct read of `src/components/ui/alert-dialog.tsx` — AlertDialog pattern
- Direct read of `src/components/ui/popover.tsx` — Popover pattern
- Direct read of `lib.rs` — command registration in `create_builder()`
- Direct read of `CONTEXT.md` — locked decisions and discretion areas

### Secondary (MEDIUM confidence)
- base-ui/react Checkbox `indeterminate` prop availability — inferred from base-ui documentation patterns (base-ui is a headless component library with standard ARIA checkbox support)

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all libraries present, confirmed by direct import/usage in codebase
- Architecture: HIGH — based on exact existing code patterns
- Pitfalls: HIGH for known git behavior (unstage before discard, apply format strictness); MEDIUM for diff library extension points
- Hunk injection into DiffViewer: LOW-MEDIUM — `@git-diff-view/react` extension points not inspected; plan should treat this as exploratory

**Research date:** 2026-04-02
**Valid until:** Stable for 30 days (no fast-moving dependencies)
