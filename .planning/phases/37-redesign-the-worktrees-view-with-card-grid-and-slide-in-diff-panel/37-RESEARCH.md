# Phase 37: Redesign the Worktrees View with Card Grid and Slide-in Diff Panel - Research

**Researched:** 2026-04-01
**Domain:** React/TypeScript UI redesign + SQLite schema migration + Rust IPC extension
**Confidence:** HIGH

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Card Content**
- Primary label: `branch_name` — shown prominently
- Secondary: `+X / -Y` lines from `diff_stat`, `created_at` as relative time ("3 days ago"), ahead/behind indicator (↑2 ↓1)
- Ahead/behind data source: `git rev-list --left-right --count` added to `list_worktrees_with_status` — not lazy-loaded
- Delete: trash icon revealed on card hover (top-right corner); triggers existing confirmation dialog

**Card Grid Layout**
- `flex-wrap` row grid filling full width below action bar
- Grouped under collapsible section headers (one per base branch)

**Action Bar (cards view)**
- Expand/collapse all toggle button/icon
- New Worktree button (moved from sidebar into action bar)
- Keep existing branch search (filters across all groups)
- Keep existing All/Active/Modified/Idle filter toggle group

**Grouping by Origin Branch**
- Group cards by `base_branch` stored per worktree at creation time
- `base_branch` not currently persisted → requires DB schema migration:
  1. Add `base_branch TEXT` column to `worktrees` table (schema migration)
  2. Store it in `create_worktree` IPC handler
  3. Expose it in `WorktreeWithStatus` model
- Fallback for legacy rows (no stored base_branch): use `branch_name` as group key
- Group header: `{base_branch} ({count})` e.g. `main (3)`
- Groups expanded by default; individual collapse + toggle-all supported

**Slide-in Diff Panel**
- Full-screen CSS slide: cards grid slides left, diff panel slides in from right — 100% content area, no cards visible in diff view
- Close button: × at top-right of diff panel action bar
- Diff panel action bar layout: left = worktree name + file search + file filter; right = unified/split toggle + × close
- No separate worktree header section inside diff panel

**Empty and Loading States**
- Empty view: centered muted text only ("No worktrees yet") — no button in the empty state
- Empty group after filter: show "No matches" within group or collapse empty group
- Claude's Discretion: loading skeleton design, card min/max width, exact grid gap, animation duration/easing

### Claude's Discretion
- Loading skeleton design for cards
- Card min/max width values
- Exact grid gap
- Animation duration and easing curve for the slide transition

### Deferred Ideas (OUT OF SCOPE)
- None — discussion stayed within phase scope
</user_constraints>

---

## Summary

Phase 37 is a full UI redesign of the Worktrees view combined with two backend additions: persisting `base_branch` in the DB and computing ahead/behind counts per worktree. The frontend work replaces the current side-by-side list+diff layout with a two-screen card-grid/diff-panel architecture driven by a CSS transform slide transition. All reusable diff rendering logic (FileTree, DiffViewer, useWorktreeDiffQuery) is kept intact and repurposed inside the new slide-in panel.

The backend changes are additive and non-breaking: `base_branch TEXT` column added to the `worktrees` table (schema V5 → V6 via full drop-and-recreate, as that is the existing migration strategy), `origin_branch` parameter already accepted by `create_worktree` IPC is now also written to `base_branch`, and `git rev-list --left-right --count HEAD...@{u}` is appended to the existing parallel status/diff-stat spawning loop in `list_worktrees_with_status`.

The existing architectural invariant (WorktreesView owns state, child components are pure display components) is preserved and extended. WorktreesView becomes the owner of a new `selectedWorktreeId` state that controls which "screen" is visible. The new card-grid component and the new diff-panel component are pure display components receiving props.

**Primary recommendation:** Build in three waves — (1) backend schema+model+IPC, (2) card grid + grouping in WorktreesView replacing WorktreeManager, (3) slide-in diff panel extraction.

---

## Standard Stack

### Core (already installed — no new dependencies needed)

| Library | Version in project | Purpose | Notes |
|---------|-------------------|---------|-------|
| React | ^19.2.4 | Component model | Hooks, useMemo, useState, useEffect |
| Tailwind CSS | ^4.2.2 | Layout + animation | CSS transform transition for slide |
| TanStack Query | ^5.95.2 | Data fetching | useWorktreesQuery + useWorktreeDiffQuery |
| date-fns | ^4.1.0 | Relative timestamps | `formatDistanceToNow` already imported |
| lucide-react | ^1.7.0 | Icons | Trash2, ChevronDown, ChevronRight, X, Plus |
| Zustand + Immer | ^4.5.7 | Navigation store | pendingWorktreeId deep-link handling |
| @git-diff-view/react | ^0.1.3 | Diff rendering | DiffViewer — unchanged |

**No new npm packages required.** All needed libraries are already in the project.

### Supporting (Rust — already in Cargo.toml)
| Crate | Purpose |
|-------|---------|
| rusqlite | SQLite schema migration |
| tokio | Async git subprocess for ahead/behind |
| serde + specta | WorktreeWithStatus model extension |
| chrono | Timestamps |

**Installation:** No new installs required.

---

## Architecture Patterns

### Recommended Component Structure After Phase 37

```
src/
├── views/
│   └── WorktreesView.tsx           # Owns ALL state: worktrees query, selectedWorktreeId,
│                                   # search, statusFilter, groupCollapsed map
├── components/execution/
│   ├── WorktreeCard.tsx            # Pure: renders single card (branch, stats, delete)
│   ├── WorktreeCardGroup.tsx       # Pure: renders one collapsible section (header + cards)
│   ├── WorktreeCardGrid.tsx        # Pure: renders all groups; receives grouped worktrees
│   ├── WorktreeDiffPanel.tsx       # Pure: slide-in panel (action bar + FileTree + DiffViewer)
│   ├── FileTree.tsx                # Unchanged — reused in WorktreeDiffPanel
│   └── DiffViewer.tsx              # Unchanged — reused in WorktreeDiffPanel
```

`WorktreeManager.tsx` is retired (replaced by the above split). Its reusable logic is extracted:
- Diff state (diffViewMode, selectedFileIndex, fileSearch, diffFiles logic) moves to `WorktreeDiffPanel`
- Create worktree dialog logic moves to `WorktreesView` (action bar owns the trigger)
- `parseDiffStat()` stays in or moves to `WorktreeCard`
- `STATUS_FILTERS` + `StatusFilter` type move to `WorktreesView` (or a shared constants file)

### Pattern 1: Two-Screen Slide via CSS Transform

**What:** The content area uses `overflow-hidden` + two full-width children positioned side-by-side via flexbox. A CSS `transform: translateX(-100%)` (or `translate-x-[-100%]` in Tailwind) applied to the wrapper when a worktree is selected slides both screens together. The transition is driven by a `transition-transform` Tailwind class.

**When to use:** User clicks a card → `selectedWorktreeId` set → CSS class applied → slide fires.

**Example structure:**
```tsx
// WorktreesView.tsx — slide container
<div className="flex-1 min-h-0 overflow-hidden relative">
  <div
    className={cn(
      "flex h-full w-[200%] transition-transform duration-300 ease-in-out",
      selectedWorktreeId != null && "-translate-x-1/2"
    )}
  >
    {/* Screen 1 — card grid, 50% of the 200%-wide strip = 100vw */}
    <div className="w-1/2 h-full flex flex-col min-w-0">
      <WorktreeCardGrid ... />
    </div>
    {/* Screen 2 — diff panel, 50% of the 200%-wide strip = 100vw */}
    <div className="w-1/2 h-full flex flex-col min-w-0">
      <WorktreeDiffPanel ... />
    </div>
  </div>
</div>
```

**Why this approach:** Pure CSS — no JS animation libraries needed. Tailwind's `transition-transform`, `duration-300`, and `ease-in-out` are sufficient. The `-translate-x-1/2` shift on a `200%`-wide flexbox container is a standard full-page slide pattern. The user's "entire screen slides left" requirement is met without `position:fixed` or portals.

**Confidence:** HIGH — standard CSS approach, no library required.

### Pattern 2: Collapsible Section Groups

**What:** A `Record<string, boolean>` collapse state map in WorktreesView, keyed by base_branch. Default: all `true` (expanded). Individual toggle flips one entry. Toggle-all computes target state (all collapsed if any are expanded, else all expanded) and sets all keys.

**Example:**
```tsx
// WorktreesView.tsx
const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
const isCollapsed = (group: string) => collapsedGroups[group] ?? false;
const toggleGroup = (group: string) =>
  setCollapsedGroups((prev) => ({ ...prev, [group]: !prev[group] }));
const toggleAll = () => {
  const anyExpanded = Object.values(collapsedGroups).some((v) => !v)
    || groupKeys.some((k) => !collapsedGroups[k]);
  const next = Object.fromEntries(groupKeys.map((k) => [k, anyExpanded]));
  setCollapsedGroups(next);
};
```

**Group section header visual pattern:** Follow KanbanView section header style — `text-xs font-semibold text-muted-foreground uppercase tracking-wide` with a chevron icon and count badge.

**Confidence:** HIGH — established pattern within the codebase.

### Pattern 3: Grouping Logic

**What:** A `useMemo` in WorktreesView groups filtered worktrees by `base_branch`. Returns an ordered array of `{ groupKey: string, worktrees: WorktreeWithStatus[] }`. Groups ordered by first-seen `created_at` (most recent group first). Within group, worktrees ordered by `created_at` desc.

```tsx
const groupedWorktrees = useMemo(() => {
  const groupMap = new Map<string, WorktreeWithStatus[]>();
  for (const wt of filteredWorktrees) {
    const key = wt.base_branch ?? wt.branch_name; // fallback for legacy rows
    if (!groupMap.has(key)) groupMap.set(key, []);
    groupMap.get(key)!.push(wt);
  }
  return Array.from(groupMap.entries()).map(([groupKey, items]) => ({ groupKey, items }));
}, [filteredWorktrees]);
```

**Confidence:** HIGH.

### Pattern 4: Ahead/Behind Git Command

**What:** `git rev-list --left-right --count HEAD...@{u}` outputs two numbers: ahead (local commits not on remote) and behind (remote commits not on local). Returns error if no upstream is set (orphan branches, new branches never pushed) — must be caught gracefully.

**Command output format:**
```
2	1
```
(ahead=2, behind=1 — tab-separated)

**Integration point:** Added to the existing `tokio::spawn` closure inside `list_worktrees_with_status` Step 5, alongside the status and diff_stat git calls. Parse as `(u32, u32)` tuple. If command fails or output is malformed, default to `(0, 0)` — never fail the whole list query for a missing upstream.

```rust
let ahead_behind_raw = crate::git::run_git_in_dir(
    &conn,
    &wt_path,
    &["rev-list", "--left-right", "--count", "HEAD...@{u}"],
)
.await
.unwrap_or_default();
let ahead_behind: Option<(u32, u32)> = ahead_behind_raw
    .trim()
    .split_once('\t')
    .and_then(|(a, b)| a.parse::<u32>().ok().zip(b.parse::<u32>().ok()));
```

**Confidence:** HIGH — `git rev-list --left-right --count` is a well-established git command. `@{u}` is the upstream tracking ref shorthand. Fails gracefully when no upstream exists.

### Pattern 5: Deep-Link Adaptation

**What:** When `pendingWorktreeId` fires, the new layout must auto-trigger the slide-in (i.e., set `selectedWorktreeId`). The existing useEffect in WorktreesView already does `setSelectedWorktreeId(match.id)` on the pending ID. This remains correct — the CSS slide transition reacts to `selectedWorktreeId != null`. No structural change needed beyond keeping this useEffect.

**Confidence:** HIGH.

### Pattern 6: Card Delete Action

**What:** Trash icon overlay rendered inside `WorktreeCard` using `group-hover` / Tailwind's group pattern. The icon is `opacity-0 group-hover:opacity-100`. Clicking the icon fires `onDelete(worktree)` callback. The confirmation AlertDialog is owned by WorktreesView (not the card) to avoid per-card dialog instances. Alternatively, a single AlertDialog in WorktreesView renders when `deletingWorktreeId` is set.

**Preferred pattern (per CONTEXT.md "existing confirmation dialog"):** The AlertDialog for delete already exists in WorktreeManager — move it to WorktreesView and drive it with `pendingDeleteWorktreeId: number | null` state.

**Confidence:** HIGH.

### Anti-Patterns to Avoid

- **Do not lift FileTree/DiffViewer into WorktreesView** — they belong in WorktreeDiffPanel, which is pure display
- **Do not use `position:fixed` for the slide** — CSS transform on a flex container is simpler and avoids z-index/stacking context issues
- **Do not lazy-load ahead/behind** — user decision: it must come from the list query, not a separate per-card query
- **Do not re-fetch `base_branch` from git at runtime** — it is stored in DB at creation time; only fallback to `branch_name` for legacy rows

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| CSS slide animation | JS animation library | Tailwind `transition-transform` + `duration-300` | Zero extra dependencies; hardware-accelerated via CSS |
| Relative timestamps | Custom date formatter | `formatDistanceToNow` from date-fns (already imported) | Already used in WorktreeManager; handles locale, edge cases |
| Diff rendering | Custom diff parser | `DiffViewer` + `parseDiffString` (existing) | Proven, handles split/unified modes, status colors |
| Type-safe IPC extension | Manual fetch | Extend `WorktreeWithStatus` struct + run `pnpm tauri:gen` | Generates bindings automatically; avoids type drift |
| Ahead/behind parsing | Complex git wrapper | Inline `split_once('\t')` parsing in the spawn closure | Single git command, trivial output format |

---

## Backend Changes Required

### B1: Schema Migration (worktrees table)

Current `SCHEMA_VERSION = 5`. Must increment to `6`.

**Existing migration strategy** (confirmed in `schema.rs`): When `current_version < SCHEMA_VERSION`, drop all tables and recreate. This means ALL existing worktree rows are lost on first upgrade — acceptable per project convention (no production data to preserve).

Add `base_branch TEXT` column to the `worktrees` CREATE TABLE statement in `SCHEMA_V6`:
```sql
CREATE TABLE IF NOT EXISTS worktrees (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
    branch_name TEXT NOT NULL,
    base_branch TEXT,              -- NEW: stores origin branch at creation time
    path TEXT NOT NULL,
    git_status TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
```

Also update the schema test `assert_eq!(version, 5)` → `assert_eq!(version, 6)` and the `assert!(!worktree_columns.contains(...))` for dropped columns.

### B2: WorktreeWithStatus model extension

Add two fields to the `WorktreeWithStatus` struct in `src-tauri/src/models/worktree.rs`:

```rust
pub base_branch: Option<String>,        // stored value or None for legacy/orphan rows
pub ahead_behind: Option<(u32, u32)>,   // (ahead, behind) — None if no upstream
```

**Note:** `(u32, u32)` is Rust but must be expressible via specta/ts-rs for TypeScript generation. Specta supports tuples natively — TypeScript will see `[number, number] | null`.

Run `pnpm tauri:gen` after model change to regenerate `src/types/bindings.ts`.

### B3: create_worktree IPC — store base_branch

The `create_worktree` IPC command already receives `origin_branch: String`. The INSERT statement:
```rust
"INSERT INTO worktrees (project_id, task_id, branch_name, path, created_at) VALUES (?, ?, ?, ?, ?)"
```
Must become:
```rust
"INSERT INTO worktrees (project_id, task_id, branch_name, base_branch, path, created_at) VALUES (?, ?, ?, ?, ?, ?)"
```
With `origin_branch` passed as the `base_branch` parameter.

`create_worktree_for_task` (internal helper) has no origin branch concept — it creates from `HEAD`. Store `None` / `NULL` for `base_branch` in that path (or store `"HEAD"` if a string is needed for grouping — but `None` is cleaner, fallback to `branch_name` handles it).

### B4: list_worktrees_with_status — ahead/behind + base_branch

Two additions:

1. **DB query**: Add `w.base_branch` to the SELECT in Step 3.

2. **Parallel git spawn** (Step 5): Add `git rev-list --left-right --count HEAD...@{u}` to the existing tokio::spawn closure. Parse result as described above.

3. **WorktreeWithStatus construction** (Step 6): Pass `base_branch` from DB row and `ahead_behind` from git info.

The `DbWorktreeRow` inner struct must gain a `base_branch: Option<String>` field.

---

## Common Pitfalls

### Pitfall 1: Slide Container Height
**What goes wrong:** The 200%-wide flex container overflows vertically if not properly constrained, causing scrollbars on the outer page.
**Why it happens:** `flex` children don't inherit height from overflow-hidden containers without explicit `h-full`.
**How to avoid:** Both screen halves must have `h-full` and `min-h-0`. Outer container must be `flex-1 min-h-0 overflow-hidden` inheriting from the flex column parent.
**Warning signs:** Page-level scrollbar appears; content area taller than viewport.

### Pitfall 2: `ahead_behind` Tuples in Specta
**What goes wrong:** Specta may not serialize `(u32, u32)` tuples correctly for TypeScript if the outer type uses serde's default representation.
**Why it happens:** Specta maps Rust tuples to TypeScript tuples but only when the type is a named newtype or explicitly typed. A bare `Option<(u32, u32)>` may or may not map cleanly.
**How to avoid:** If specta fails to generate the tuple, use a small named struct instead:
```rust
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct AheadBehind {
    pub ahead: u32,
    pub behind: u32,
}
```
Then `ahead_behind: Option<AheadBehind>` — guaranteed specta compatibility.
**Warning signs:** `cargo test generate_typescript_bindings` fails or produces `any` in bindings.ts.

### Pitfall 3: Legacy Rows With `base_branch = NULL`
**What goes wrong:** Grouping logic crashes or creates an `undefined` group key if `wt.base_branch` is not handled.
**Why it happens:** Existing worktrees in the DB (before migration drops them) and orphan rows will have `base_branch = null`.
**How to avoid:** The grouping key must be: `wt.base_branch ?? wt.branch_name`. Never use `wt.base_branch` as a map key without the fallback.

### Pitfall 4: Slide Does Not Reset When Worktree Deleted
**What goes wrong:** User deletes the selected worktree from within the diff panel. `onSuccess` calls `onSelect(null)`, but if the transition back to the card grid is not handled, the diff panel stays visible with a stale worktree.
**Why it happens:** `selectedWorktreeId` is set to `null` but the slide component may conditionally render `WorktreeDiffPanel` only when a worktree is selected, causing an abrupt disappearance rather than a smooth slide back.
**How to avoid:** Keep `WorktreeDiffPanel` mounted but pass `null` as worktree when none selected. The CSS slide back (when `selectedWorktreeId = null`) will animate before the panel unmounts. Or: unmount only after `transitionend`.

### Pitfall 5: Schema Version Test Assertion
**What goes wrong:** The schema test `assert_eq!(version, 5)` fails after incrementing to 6.
**How to avoid:** Update the test assertion in `src-tauri/src/db/schema.rs` at the same time as the schema version bump.

### Pitfall 6: `git rev-list` Fails on Branches With No Upstream
**What goes wrong:** New branches that have never been pushed have no upstream tracking ref. `git rev-list HEAD...@{u}` exits non-zero with a fatal error.
**Why it happens:** `@{u}` resolves to nothing when no upstream is configured.
**How to avoid:** `.unwrap_or_default()` already handles this — the empty string parses as `None` for `ahead_behind`. Do not propagate this error.

### Pitfall 7: `createWorktreeMutation` Signature Unchanged But Response Model Changed
**What goes wrong:** `create_worktree` returns `Worktree` (not `WorktreeWithStatus`). After adding `base_branch` to the schema, the Worktree struct's INSERT must include it, and the returned `Worktree` struct may need the field if TS bindings are regenerated.
**How to avoid:** Add `base_branch: Option<String>` to the `Worktree` struct as well (it is already close to `WorktreeWithStatus` minus the enrichment fields). Run `pnpm tauri:gen` and verify TypeScript compiles.

---

## Code Examples

### CSS Slide Container (verified pattern)

```tsx
// Source: Standard Tailwind/CSS transform technique — no library dependency
<div className="flex-1 min-h-0 overflow-hidden">
  <div
    className={cn(
      "flex h-full w-[200%] transition-transform duration-300 ease-in-out",
      selectedWorktreeId != null && "-translate-x-1/2"
    )}
  >
    {/* Card grid — left screen */}
    <div className="w-1/2 h-full overflow-y-auto flex flex-col">
      {/* WorktreeCardGrid */}
    </div>
    {/* Diff panel — right screen */}
    <div className="w-1/2 h-full flex flex-col min-h-0">
      {/* WorktreeDiffPanel */}
    </div>
  </div>
</div>
```

### Card Component Skeleton (project pattern)

```tsx
// WorktreeCard.tsx — pure display, follows Phase 27 pattern
interface WorktreeCardProps {
  worktree: WorktreeWithStatus;
  onSelect: (id: number) => void;
  onDelete: (id: number) => void;
}

export function WorktreeCard({ worktree, onSelect, onDelete }: WorktreeCardProps) {
  const diffStat = parseDiffStat(worktree.diff_stat);
  // Card has `group` class on wrapper for hover-reveal delete icon
  return (
    <div
      className="relative group rounded-lg border bg-card p-4 cursor-pointer hover:bg-muted/10 transition-colors"
      onClick={() => worktree.id != null && onSelect(worktree.id)}
    >
      <button
        className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity"
        onClick={(e) => { e.stopPropagation(); worktree.id != null && onDelete(worktree.id); }}
      >
        <Trash2 className="w-3.5 h-3.5 text-muted-foreground hover:text-destructive" />
      </button>
      <span className="font-mono text-sm font-medium">{worktree.branch_name}</span>
      {/* diff stat, relative time, ahead/behind */}
    </div>
  );
}
```

### Ahead/Behind Git Parsing (Rust)

```rust
// Source: git rev-list --left-right --count documentation
let ahead_behind_raw = crate::git::run_git_in_dir(
    &conn, &wt_path, &["rev-list", "--left-right", "--count", "HEAD...@{u}"],
).await.unwrap_or_default();

let ahead_behind: Option<(u32, u32)> = ahead_behind_raw
    .trim()
    .split_once('\t')
    .and_then(|(a, b)| a.parse::<u32>().ok().zip(b.parse::<u32>().ok()));
```

### Ahead/Behind Frontend Display

```tsx
// In WorktreeCard
{worktree.ahead_behind && (worktree.ahead_behind[0] > 0 || worktree.ahead_behind[1] > 0) && (
  <span className="text-xs text-muted-foreground font-mono">
    {worktree.ahead_behind[0] > 0 && `↑${worktree.ahead_behind[0]}`}
    {worktree.ahead_behind[0] > 0 && worktree.ahead_behind[1] > 0 && " "}
    {worktree.ahead_behind[1] > 0 && `↓${worktree.ahead_behind[1]}`}
  </span>
)}
```

### Schema V6 Migration Strategy

The existing migration strategy drops and recreates all tables when `current_version < SCHEMA_VERSION`. No `ALTER TABLE` is needed. Simply:
1. Set `SCHEMA_VERSION = 6`
2. Add `base_branch TEXT` to the CREATE TABLE statement in `SCHEMA_V6` constant (rename from `SCHEMA_V5`)
3. Update test assertion from `5` to `6`

---

## State of the Art

| Old Approach | Current Approach | Impact |
|--------------|------------------|--------|
| Side-by-side list+diff (WorktreeManager) | Card grid + full-screen slide-in diff | Replaces WorktreeManager entirely |
| Inline sidebar New Worktree button | New Worktree in action bar | Action bar is the canonical control surface |
| No base_branch persistence | DB column `base_branch TEXT` | Enables stable grouping across sessions |
| No ahead/behind data | Computed per-worktree in list query | Shows push/pull status on cards |

---

## Environment Availability

Step 2.6: SKIPPED — phase is code and DB schema changes only; no external tools beyond git (already available in the project environment) and the Tauri toolchain (already in use).

---

## Validation Architecture

`workflow.nyquist_validation` key is absent from `.planning/config.json` — treated as enabled.

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest (via vite.config.ts `test` block) |
| Config file | `vite.config.ts` (inline test config) |
| Setup file | `src/test/setup.ts` |
| Quick run command | `pnpm test --reporter=verbose` |
| Full suite command | `pnpm test` |

### Phase Requirements → Test Map

| Area | Behavior | Test Type | Automated Command | Notes |
|------|----------|-----------|-------------------|-------|
| Grouping logic | `groupedWorktrees` useMemo returns correct groups from mixed `base_branch` values including nulls | unit | `pnpm test src/utils/helpers/` | Logic can be extracted to a helper and unit tested |
| `parseDiffStat` | Already tested indirectly via diff-utils.test.ts | unit | `pnpm test` | No new test needed |
| Schema migration | Schema V6 has `base_branch` column | Rust unit | `cargo test test_schema_initialization` | Update existing test assertion |
| CSS slide transition | Manual visual check | manual-only | — | CSS transform not testable in happy-dom |
| Deep-link → slide-in | pendingWorktreeId triggers slide | manual-only | — | Navigation store has unit tests; integration is manual |
| Ahead/behind display | Display correct ↑/↓ when data present | unit | Component test (if added) | LOW priority — display logic is trivial |

### Wave 0 Gaps
- [ ] `src/utils/helpers/worktree-group-utils.ts` — grouping function extracted for unit testing (if planner decides to extract it)
- Existing `src/store/navigationStore.test.ts` covers deep-link mechanics — no new file needed

---

## Open Questions

1. **AheadBehind struct vs tuple in specta**
   - What we know: Specta supports Rust tuples as TypeScript tuples, but behavior with `Option<(u32, u32)>` has not been verified in this project
   - What's unclear: Whether specta emits `[number, number] | null` or falls back to `any`
   - Recommendation: Run `pnpm tauri:gen` after adding the field; if TypeScript shows `any`, switch to a named `AheadBehind { ahead: u32, behind: u32 }` struct immediately

2. **Group ordering**
   - What we know: The user said "grouped by base branch" without specifying group order
   - What's unclear: Should groups be alphabetically ordered by base branch name, or by the most recently modified worktree in each group?
   - Recommendation: Use insertion-order from the sorted worktree list (most-recently-created worktree defines group order). Simplest approach, consistent with current list sort.

3. **`create_worktree_for_task` base_branch value**
   - What we know: This internal function creates from `HEAD` with no concept of origin branch
   - What's unclear: Should these task-created worktrees be grouped under "HEAD" or under `branch_name`?
   - Recommendation: Store `NULL` for `base_branch` in this path → fallback to `branch_name` → each task worktree appears in its own single-item group, which is accurate (each is its own branch)

---

## Sources

### Primary (HIGH confidence)
- Source code audit: `src/views/WorktreesView.tsx`, `src/components/execution/WorktreeManager.tsx`, `src/services/worktree.service.ts`, `src-tauri/src/ipc/worktree_handlers.rs`, `src-tauri/src/models/worktree.rs`, `src-tauri/src/db/schema.rs`, `src-tauri/src/git/mod.rs` — direct code reading
- `src/store/navigationStore.ts` — deep-link mechanism confirmed
- `.planning/phases/37-redesign-the-worktrees-view-with-card-grid-and-slide-in-diff-panel/37-CONTEXT.md` — locked decisions
- `.planning/STATE.md` — established patterns (Phase 27 pure display, Phase 36 DiffTarget::Head, Phase 35 run_git_in_dir)
- `tsconfig.json` — path aliases confirmed (`@/lib` = `src/utils/helpers`, `@/ui` = `src/components/ui/*`)
- `package.json` — all dependencies confirmed present, no new installs needed

### Secondary (MEDIUM confidence)
- `git rev-list --left-right --count HEAD...@{u}` — well-documented git command; `@{u}` is standard upstream ref syntax
- Tailwind CSS transform slide pattern — standard technique, no external verification needed

---

## Project Constraints (from CLAUDE.md)

- **Frontend stack:** React 19 + TypeScript, Vite, Tailwind 4
- **State management:** Zustand with Immer middleware
- **UI components:** Radix UI (Dialog, Select), shadcn/ui copy-paste pattern
- **Type safety:** ts-rs/specta for Rust → TypeScript type generation; run `pnpm tauri:gen` after Rust model changes
- **Import conventions:** Direct imports only; NO barrel `index.ts` files in domain directories
- **Path aliases:** `@/hooks`, `@/lib` for hooks/helpers; `@/ui` for UI components
- **Naming:** PascalCase for React components/types, camelCase for functions/variables, snake_case for Rust
- **IPC pattern:** `invoke()` via service layer hooks only (TanStack Query); no direct `invoke()` in components
- **Database migrations:** Increment `SCHEMA_VERSION`, add/alter schema in `SCHEMA_VX` constant; current version is 5
- **Error handling:** Rust IPC returns `Result<T, String>`; frontend errors via Sonner toast
- **No barrel exports:** Direct imports from file paths in components/domain directories
- **Pure display components:** Views own data and state; display components receive props (Phase 27 pattern)

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — verified directly from package.json and source files
- Architecture patterns: HIGH — derived from existing codebase patterns, no speculative choices
- Backend changes: HIGH — schema strategy confirmed from schema.rs; git command is standard
- Pitfalls: HIGH — identified from direct code reading and known edge cases
- Ahead/behind tuple in specta: MEDIUM — behavior not confirmed without running tauri:gen

**Research date:** 2026-04-01
**Valid until:** 2026-05-01 (stable stack)
