# Phase 36: Redesign the Diff Pane in the Worktrees View - Research

**Researched:** 2026-04-01
**Domain:** React / TypeScript frontend layout refactor — WorktreeManager diff pane
**Confidence:** HIGH (frontend-only, all code read directly from source)

## Summary

This phase is a focused frontend-only refactor of `WorktreeManager.tsx`. The existing component already has all the data it needs: `diffFiles` (from `parseDiffString`) is a `DiffFileWithName[]` array, and `DiffViewer` already accepts a single `DiffFile | null`. The change is purely about layout and state: replace the all-files-at-once rendering with a file list panel + selected-file state.

The key insight is that `parseDiffString` returns `DiffFileWithName[]`, where each entry already has `fileName` (the relative path from repo root). Per-file stats (insertions/deletions) are **not** stored in `DiffFileWithName` — they must be derived by scanning the `hunks` array. The diff target toggle row and its associated state (`diffMode`, `diffBranch`) are removed entirely; the query always passes `{ type: "Head" }`.

The implementation touches exactly two files in `src/components/execution/`: `WorktreeManager.tsx` (main layout refactor + new state) and potentially `DiffViewer.tsx` (no changes are expected unless the per-file header is placed inside it — but per CONTEXT.md decisions, the header belongs above the diff body in `WorktreeManager`, not inside `DiffViewer`).

**Primary recommendation:** Implement as a single plan: remove diff mode state + toggle row, add `selectedFileIndex` state, add file list sub-panel, add per-file header bar, wire selection to `DiffViewer`. All within `WorktreeManager.tsx`.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- Add a ~200px fixed-width file list sub-panel inside the right panel, left of the diff body — not resizable
- Clicking a file in the list shows ONLY that file's diff in the diff body (not all files at once)
- Auto-select the first changed file when a worktree is selected (set `selectedFileIndex = 0` when `diffFiles` becomes non-empty)
- If the worktree has no uncommitted changes, file list is empty and diff body shows "No uncommitted changes"
- Each file list entry shows: M/A/D status icon, filename (basename only, not full path), +/- stats for that file
- Remove the ToggleGroup "Uncommitted" / "Branch diff" toggle entirely
- Remove the branch text input entirely
- Always call `get_worktree_diff` with `DiffTarget::Head` (uncommitted changes) — hardcode `{ type: "Head" }`
- Remove `diffMode` and `diffBranch` state variables and all related JSX
- Remove the diff target bar row from the layout
- A header bar appears above the diff body showing: full relative path + M/A/D status + +/- stats
  Example: `src/components/execution/DiffViewer.tsx  M  +12 -4`
- Layout: worktree info header spans full width (unchanged), below: two-column split file list | diff body
- File list selected state: `border-l-2 bg-muted/20` on active, `border-transparent hover:bg-muted/10` on others
- `text-success` / `text-destructive` for +/- stats (consistent with worktree sidebar)

### Claude's Discretion
- Exact visual styling of M/A/D status icons (color-coded letters, small icons, or colored dots)
- Whether the selected file in the file list has a highlight style (likely: border-l-2 bg-muted/20)
- Exact font/size for the per-file header bar
- How to extract status (M/A/D) and per-file stats from `parseDiffString` output

### Deferred Ideas (OUT OF SCOPE)
- Branch diff mode (DiffTarget::Branch) — removed from UI in this phase, could be re-added later
- Resizable file list panel — deferred, fixed width is sufficient
- Collapsible/expandable file sections — deferred
</user_constraints>

## Standard Stack

### Core (already in project — no new installs)
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| React | 19 | Component rendering | Project standard |
| TypeScript | strict | Type safety | Project standard |
| Tailwind CSS v4 | (project) | Utility styling | Project standard — all layout/color via Tailwind classes |
| `@git-diff-view/react` | (project) | Diff rendering | Already used in DiffViewer.tsx |

No new dependencies are required. This phase uses only existing imports already present in `WorktreeManager.tsx` and `DiffViewer.tsx`.

**Installation:** N/A — no new packages.

## Architecture Patterns

### Recommended Project Structure
No new files needed. Changes are confined to:
```
src/components/execution/
├── WorktreeManager.tsx   ← primary change target
└── DiffViewer.tsx        ← no changes expected
```

### Pattern 1: Selected-item state with auto-reset on data change
**What:** `selectedFileIndex: number | null` state, reset to `0` via `useEffect` when `diffFiles` changes to non-empty.
**When to use:** Any list where the selection should auto-advance when data loads.
**Example:**
```typescript
// Source: read from WorktreeManager.tsx existing pattern (worktree selection in WorktreesView)
const [selectedFileIndex, setSelectedFileIndex] = useState<number | null>(null);

useEffect(() => {
  if (diffFiles.length > 0) {
    setSelectedFileIndex(0);
  } else {
    setSelectedFileIndex(null);
  }
}, [diffFiles]);

const selectedFile = selectedFileIndex !== null ? (diffFiles[selectedFileIndex] ?? null) : null;
```

### Pattern 2: Two-column split with fixed left panel
**What:** `flex` row with `w-[200px] shrink-0` left panel and `flex-1 min-w-0` right panel.
**When to use:** Fixed-width sidebar + expanding content area.
**Example:**
```typescript
// Source: existing WorktreeManager.tsx sidebar pattern
<div className="flex flex-1 min-h-0">
  {/* File list */}
  <div className="w-[200px] shrink-0 flex flex-col border-r border-border overflow-y-auto">
    {/* file entries */}
  </div>
  {/* Diff body */}
  <div className="flex-1 flex flex-col min-w-0">
    {/* per-file header + DiffViewer */}
  </div>
</div>
```

### Pattern 3: File list entry (M/A/D + basename + stats)
**What:** Each file entry shows status letter, basename, and per-file +/- stats.
**When to use:** File navigation panel.
**Notes:**
- `file.fileName` from `DiffFileWithName` is the full relative path (e.g. `src/foo/bar.ts`)
- Basename: `file.fileName.split("/").pop() ?? file.fileName`
- Status (M/A/D): derived by checking `file.oldFile` and `file.newFile` presence — see "Deriving M/A/D status" below
- Per-file stats: must be computed from `file.hunks` — see "Per-file stat extraction" below

### Pattern 4: Per-file header bar
**What:** A `shrink-0` bar above the diff body showing full path + status + stats.
**Example:**
```typescript
<div className="px-3 py-1.5 border-b border-border bg-muted/20 shrink-0 flex items-center gap-2 text-xs">
  <span className="font-mono text-foreground truncate">{selectedFile.fileName}</span>
  <span className={cn("font-medium shrink-0", statusColor)}>{statusLetter}</span>
  {insertions > 0 && <span className="text-success shrink-0">+{insertions}</span>}
  {deletions > 0 && <span className="text-destructive shrink-0">-{deletions}</span>}
</div>
```

### Anti-Patterns to Avoid
- **Rendering all diffFiles at once:** The old pattern `diffFiles.map((file, i) => <DiffViewer key={i} diffFile={file} />)` is removed. Only the selected file is rendered.
- **Keeping diffMode / diffBranch state:** These are explicitly removed. Do not leave dead state variables.
- **Putting the per-file header inside DiffViewer:** The header is in WorktreeManager, not in DiffViewer — DiffViewer remains a pure data display component.
- **Using `key={i}` for file list:** Use `key={file.fileName}` — file path is stable and unique within a diff.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Diff rendering | Custom syntax-highlighted diff | `DiffViewer` (already uses `@git-diff-view/react`) | Already exists, handles highlighting, themes, loading states |
| Diff fetching | Direct invoke | `useWorktreeDiffQuery` hook | Already exists with caching |
| Diff parsing | Custom parser | `parseDiffString` from `@/lib` | Already exists, returns `DiffFileWithName[]` |
| Status coloring | Custom color logic | `text-success` / `text-destructive` Tailwind classes | Already used in worktree sidebar; consistent with project |

**Key insight:** Every data pipeline piece already exists. The only new logic is (1) per-file stat extraction from hunks and (2) M/A/D status derivation from `DiffFileWithName` shape.

## Data Shape Analysis

### DiffFileWithName — available fields
```typescript
// Source: src/types/review.ts (read directly)
interface DiffFile {
  oldFile?: { fileName?: string | null; fileLang?: string; content?: string | null; };
  newFile?: { fileName?: string | null; fileLang?: string; content?: string | null; };
  hunks: string[];  // each element is either a @@ header or a diff line (+/-/space)
}
interface DiffFileWithName extends DiffFile {
  fileName: string;  // full relative path (e.g. "src/components/execution/DiffViewer.tsx")
}
```

### Deriving M/A/D status from DiffFileWithName
`parseDiffString` sets `newFile` with `fileName` for all parsed files; `oldFile` is never set by the current parser. This means the current data shape cannot distinguish Added vs Modified vs Deleted purely from `oldFile`/`newFile` presence — the parser doesn't populate `oldFile`.

**Important finding (HIGH confidence, read from source):** The current `parseDiffString` implementation at `src/utils/helpers/diff-utils.ts` only sets `newFile` — never `oldFile`. It also doesn't capture the git status character (`A`, `M`, `D`) from the diff header lines like `new file mode`, `deleted file mode`. The only reliable signal is the `diff --git a/... b/...` header line itself. A file is "deleted" if the diff contains `deleted file mode`; it's "added" if it contains `new file mode`; otherwise it's "modified".

**Resolution for the planner:** The implementer has two options:
1. **Extend `parseDiffString`** to capture and return the status character (`A`/`M`/`D`) — this adds a `status?: "A" | "M" | "D"` field to `DiffFileWithName`
2. **Re-parse minimally** in WorktreeManager by scanning the raw `diffString` for `new file mode` / `deleted file mode` markers per file — hacky but avoids touching the shared parser

Option 1 is cleaner and aligns with CONTEXT.md's "Claude's Discretion" note about how to extract status from `parseDiffString` output. This is recommended.

### Per-file stat extraction from hunks
`DiffFileWithName.hunks` is a `string[]` where each element is either a `@@` header or a `+`/`-`/` ` diff line. Stats can be computed by counting lines starting with `+` (not `++`) and `-` (not `--`).

```typescript
// Source: derived from reading diff-utils.ts — hunks format is known
function computeFileStats(hunks: string[]): { insertions: number; deletions: number } {
  let insertions = 0;
  let deletions = 0;
  for (const line of hunks) {
    if (line.startsWith("+") && !line.startsWith("+++")) insertions++;
    else if (line.startsWith("-") && !line.startsWith("---")) deletions++;
  }
  return { insertions, deletions };
}
```

This is safe: `+++`/`---` are the file header lines that `parseDiffString` does NOT include in `hunks` (it only adds `@@` headers and `+`/`-`/` ` content lines to hunks).

## Common Pitfalls

### Pitfall 1: selectedFileIndex stale after worktree switch
**What goes wrong:** User switches to a different worktree; `diffFiles` loads new data; `selectedFileIndex` still points to the old index — could be out of bounds or show wrong file.
**Why it happens:** `selectedFileIndex` is component state, not derived from `diffFiles`.
**How to avoid:** The `useEffect` that resets `selectedFileIndex = 0` when `diffFiles` changes handles this, but must also handle the case where `selectedFileIndex` is pointing to an index that no longer exists (e.g., was file 3 of 5, new diff has 2 files). Reset unconditionally on `diffFiles` identity change, not just on length change.
**Warning signs:** `diffFiles[selectedFileIndex]` returns `undefined`.

### Pitfall 2: Diff query not re-running after removing diffMode state
**What goes wrong:** The `diffTarget` constant was previously derived from `diffMode` state. After removing `diffMode`, the `diffTarget` must be hardcoded as `{ type: "Head" }` — but if it is declared as a `const` inside the component without `useMemo`, React will create a new object reference every render, causing `useWorktreeDiffQuery` to re-fetch on every render (TanStack Query serializes the query key which includes `diffTarget`).
**Why it happens:** `worktreeQueryKeys.diff` includes `diffTarget` in the key array. A new object reference `{ type: "Head" }` each render changes the key.
**How to avoid:** Declare as a module-level constant outside the component: `const DIFF_TARGET_HEAD: DiffTarget = { type: "Head" };`
**Warning signs:** The diff flickers or refetches on every render.

### Pitfall 3: Empty state flash when switching worktrees
**What goes wrong:** User clicks a new worktree; `diffFiles` briefly becomes `[]`; the file list panel shows empty; then data loads. The auto-select effect then fires.
**Why it happens:** React renders the empty state before the query resolves.
**How to avoid:** Already partially handled by the existing `diffLoading` check in WorktreeManager. Show a loading skeleton or just the `diffLoading` state in the file list panel the same way the diff body currently shows the `DiffViewer` loading placeholder. The existing pattern (`if (diffLoading) return <DiffViewer diffFile={null} loading={true} />`) can be adapted: show "Loading..." in the file list panel when `diffLoading`.
**Warning signs:** File list flickers to empty between worktree selection changes.

### Pitfall 4: basename collision
**What goes wrong:** Two files with the same basename in different directories (e.g., `src/a/index.ts` and `src/b/index.ts`) show the same name in the file list — user cannot distinguish them.
**Why it happens:** The locked decision says "just the basename" in the file list entry. This is the accepted tradeoff per CONTEXT.md (the full path is shown in the per-file header bar).
**How to avoid:** Accepted per design. No action needed. The per-file header shows the full path to disambiguate.

## Code Examples

### Constant DiffTarget (avoids query key churn)
```typescript
// Source: derived from worktree.service.ts query key structure
// Place at module level, outside the component
const DIFF_TARGET_HEAD: DiffTarget = { type: "Head" };
```

### File list entry with status + basename + stats
```typescript
// Source: derived from existing WorktreeManager.tsx worktree list entry pattern
{diffFiles.map((file, i) => {
  const stats = computeFileStats(file.hunks);
  const basename = file.fileName.split("/").pop() ?? file.fileName;
  const status = file.status ?? "M";
  const statusColor = status === "A" ? "text-success" : status === "D" ? "text-destructive" : "text-muted-foreground";
  return (
    <div
      key={file.fileName}
      onClick={() => setSelectedFileIndex(i)}
      className={cn(
        "px-2 py-2 cursor-pointer border-l-2 transition-colors",
        i === selectedFileIndex
          ? "border-ring bg-muted/20"
          : "border-transparent hover:bg-muted/10",
      )}
    >
      <div className="flex items-center gap-1.5">
        <span className={cn("text-xs font-medium shrink-0", statusColor)}>{status}</span>
        <span className="text-xs font-mono truncate">{basename}</span>
      </div>
      <div className="text-xs mt-0.5 pl-3">
        {stats.insertions > 0 && <span className="text-success">+{stats.insertions}</span>}
        {stats.deletions > 0 && <span className="text-destructive ml-1">-{stats.deletions}</span>}
      </div>
    </div>
  );
})}
```

### Auto-select first file effect
```typescript
// Source: derived from existing useEffect pattern in WorktreeManager.tsx
useEffect(() => {
  setSelectedFileIndex(diffFiles.length > 0 ? 0 : null);
}, [diffFiles]);
```

### Per-file stat helper
```typescript
// Source: derived from reading diff-utils.ts hunks format
function computeFileStats(hunks: string[]): { insertions: number; deletions: number } {
  let insertions = 0;
  let deletions = 0;
  for (const line of hunks) {
    if (line.startsWith("+") && !line.startsWith("+++")) insertions++;
    else if (line.startsWith("-") && !line.startsWith("---")) deletions++;
  }
  return { insertions, deletions };
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| All files rendered at once | Single selected file rendered | Phase 36 | Simpler, faster for large diffs |
| diffMode toggle (uncommitted/branch) | Always uncommitted (Head) | Phase 36 | Less UI complexity |
| diffBranch input | Removed | Phase 36 | Fewer state variables |

**Items to remove in WorktreeManager.tsx:**
- `diffMode` state (`useState<"uncommitted" | "branch">`)
- `diffBranch` state (`useState<string>`)
- `useEffect` that pre-populates `diffBranch` from `selectedWorktree.branch_name`
- `diffTarget` const (replace with module-level `DIFF_TARGET_HEAD`)
- The entire "Diff target selector" JSX block (lines ~312-338)
- The old `diffFiles.map((file, i) => <DiffViewer ...>)` rendering pattern
- The `ToggleGroup` / `ToggleGroupItem` import (no longer needed)
- The `Input` and `Label` imports if no longer used elsewhere in this file (check: `Label` is used in the Create dialog, `Input` is used in Create dialog and diffBranch — after removing diffBranch, `Input` is still used in Create dialog)

**Items to add:**
- `selectedFileIndex: number | null` state
- Module-level `DIFF_TARGET_HEAD` constant
- File list sub-panel (200px fixed, scrollable)
- Per-file header bar
- `computeFileStats` helper function (local to file or extracted to diff-utils.ts)
- Optional: `status` field on `DiffFileWithName` (requires extending `parseDiffString`)

## Open Questions

1. **Should `parseDiffString` be extended to return status (A/M/D) per file?**
   - What we know: Current parser does not capture git status character. Status can be derived from `new file mode` / `deleted file mode` markers in diff headers.
   - What's unclear: Whether the planner wants to add `status?: "A" | "M" | "D"` to `DiffFileWithName` type and update the parser, or do a lightweight scan in WorktreeManager.
   - Recommendation: Extend `parseDiffString` — it's the cleaner approach and keeps WorktreeManager lean. The test file `diff-utils.test.ts` exists and should have a test added for status detection.

2. **Where does `computeFileStats` live?**
   - Option A: Inline helper in `WorktreeManager.tsx` (simple, one-use)
   - Option B: Extract to `diff-utils.ts` alongside `parseDiffString` (reusable, testable)
   - Recommendation: Given the existing test file `diff-utils.test.ts`, adding it to `diff-utils.ts` and testing it is preferable.

## Environment Availability

Step 2.6: SKIPPED — this phase is purely frontend code changes with no external dependencies beyond the existing project stack.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest (configured in vite.config.ts, `test` block) |
| Config file | `vite.config.ts` (inline test config, no separate vitest.config.ts) |
| Quick run command | `pnpm test --run src/utils/helpers/diff-utils.test.ts` |
| Full suite command | `pnpm test --run` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| — | `computeFileStats` counts + and - lines from hunks correctly | unit | `pnpm test --run src/utils/helpers/diff-utils.test.ts` | ✅ (extend existing) |
| — | `parseDiffString` returns `status: "A"` for new files | unit | `pnpm test --run src/utils/helpers/diff-utils.test.ts` | ✅ (extend existing) |
| — | `parseDiffString` returns `status: "D"` for deleted files | unit | `pnpm test --run src/utils/helpers/diff-utils.test.ts` | ✅ (extend existing) |
| — | `parseDiffString` returns `status: "M"` for modified files | unit | `pnpm test --run src/utils/helpers/diff-utils.test.ts` | ✅ (extend existing) |
| — | WorktreeManager renders (smoke) | manual-only | N/A | N/A — Tauri component, no JSDOM test |

**Note on WorktreeManager testing:** The component relies on Tauri IPC (`useWorktreeDiffQuery`) which is not mockable without significant setup. Visual correctness must be verified manually via `pnpm tauri:dev`. Unit tests are appropriate only for the pure utility helpers.

### Sampling Rate
- **Per task commit:** `pnpm test --run src/utils/helpers/diff-utils.test.ts`
- **Per wave merge:** `pnpm test --run`
- **Phase gate:** Full test suite green + manual visual check in `pnpm tauri:dev`

### Wave 0 Gaps
- [ ] Add `computeFileStats` tests to `src/utils/helpers/diff-utils.test.ts` — covers per-file stat extraction
- [ ] Add `parseDiffString` status detection tests to `src/utils/helpers/diff-utils.test.ts` — covers A/M/D derivation

*(Existing test file is present; gaps are new test cases within it, not a new file)*

## Sources

### Primary (HIGH confidence)
- `src/components/execution/WorktreeManager.tsx` — full file read; current state, imports, layout, all state variables documented
- `src/components/execution/DiffViewer.tsx` — full file read; props interface confirmed
- `src/types/review.ts` — full file read; `DiffFile`, `DiffFileWithName`, `DiffHunk` types confirmed
- `src/utils/helpers/diff-utils.ts` — full file read; `parseDiffString` implementation, hunks format, `DiffFileWithName` confirmed
- `src/services/worktree.service.ts` — full file read; `useWorktreeDiffQuery` signature, `worktreeQueryKeys.diff` structure confirmed
- `.planning/phases/36-redesign-the-diff-pane-in-the-worktrees-view/36-CONTEXT.md` — full file read; all locked decisions

### Secondary (MEDIUM confidence)
- `.planning/STATE.md` — project history and architectural decisions for cross-reference (Phase 27, 29, 35 decisions relevant)

### Tertiary (LOW confidence)
- None

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all existing libraries read from source
- Architecture: HIGH — all implementation patterns derived from reading actual component code
- Pitfalls: HIGH — identified from direct code analysis, not speculation
- Data shape: HIGH — `DiffFileWithName` and `parseDiffString` internals read from source

**Research date:** 2026-04-01
**Valid until:** Until `diff-utils.ts`, `WorktreeManager.tsx`, or `DiffViewer.tsx` are modified
