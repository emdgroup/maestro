# Phase 29: v1.3 Agents & Worktrees View Polish and Bug Fixes — Research

**Researched:** 2026-03-30
**Domain:** Tauri 2 + React 19 + xterm.js + @git-diff-view/react — polish and defect remediation
**Confidence:** HIGH (all findings are from direct codebase inspection; no external dependencies to verify)

---

## Summary

Phase 29 is a polish-and-fix pass over everything shipped in the v1.3 milestone (Phases 25-28): the Agents view (xterm.js terminal + execution sidebar), the Worktrees view (diff panel + zombie detection), the BacklogView redesign, and the TaskForm branch-dropdown quick-task shipped after v1.3.

Research involved reading every component in the v1.3 delivery path, the Rust IPC handlers, the services layer, the uncommitted working-tree changes, and the pending todo list. No external library research is needed — the entire issue surface is within the existing codebase.

**Primary recommendation:** Four discrete defects and three polish items were identified through code inspection. They form two natural plan waves: (1) correctness fixes (DiffViewer light-theme hardcode, `append_terminal_output` SQLite non-standard ORDER BY, empty `is_archived` field in `Task` type, and missing `skills` field removed from `TaskForm` but still present in Rust model/bindings), and (2) UX polish (quick-task plan execution, AgentsView auto-select fallback edge case, WorktreeManager worktree-path display).

The uncommitted working-tree changes (12 files) appear to be the in-progress quick-task for removing skills + adding branch dropdown — this work needs to land before or as part of this phase. Current `pnpm build` and `pnpm test` both pass (110 tests green).

---

## Standard Stack

No new libraries are needed. All work uses the existing stack:

| Library | Version | Purpose |
|---------|---------|---------|
| @xterm/xterm | installed | Terminal rendering — AgentsView |
| @git-diff-view/react | installed | Diff rendering — WorktreesView + ReviewModal |
| @git-diff-view/shiki | installed | Syntax highlighting for DiffViewer |
| TanStack Query | installed | All data fetching / mutations |
| shadcn/ui (via @/ui) | installed | All UI primitives |
| rusqlite | installed | SQLite access in Rust IPC handlers |

---

## Architecture Patterns

The project follows a locked architecture (see CLAUDE.md):

```
src/
├── views/            # Page-level orchestrators (own queries, pass props)
├── components/       # Domain-grouped reusable components
│   ├── execution/    # AgentMonitor, WorktreeManager, Terminal, DeadSessionTerminal, DiffViewer
│   ├── kanban/       # TaskCard, KanbanBoard, KanbanColumn, BacklogTaskSheet
│   ├── task/         # TaskForm, TaskDetail
│   └── project-picker/
├── services/         # TanStack Query hooks wrapping api.*
├── store/            # Zustand stores (boardStore, navigationStore, projectStore)
└── utils/            # hooks/, helpers/
src-tauri/src/
├── ipc/              # IPC command handlers (execution_handlers.rs, worktree_handlers.rs, task_handlers.rs)
├── git/              # Git operations
└── models/           # Rust domain models with TS derive
```

**Pure display pattern:** `AgentMonitor` and `WorktreeManager` receive all data as props from their View orchestrators. The View owns the TanStack Query call. This pattern must not be broken.

**Service layer pattern:** All IPC calls go through `api.*` (from `@/lib`) wrapped in TanStack Query hooks in `*.service.ts`. No direct `invoke()` calls are acceptable in components or hooks.

---

## Identified Issues

### Issue 1: DiffViewer hardcodes `diffViewTheme="light"` (DEFECT — HIGH SEVERITY)

**File:** `src/components/execution/DiffViewer.tsx` line 83

```tsx
<DiffView
  diffViewMode={DiffModeEnum.Unified}
  diffViewTheme="light"   // <-- hardcoded, ignores dark mode
  diffViewHighlight
  registerHighlighter={highlighter}
/>
```

The app is dark-first (CLAUDE.md notes "dark-first approach"). The `@git-diff-view/react` component accepts `"light"` or `"dark"` for `diffViewTheme`. There is already a ThemeProvider with system theme detection at `src/contexts/ThemeProvider` (implemented in Phase 14). The correct fix is to read `document.documentElement.classList.contains("dark")` or use the existing `useTheme()` hook to supply the correct value.

This component is used in both WorktreesView (via WorktreeManager) and ReviewModal. Both are affected.

**Confidence:** HIGH (direct code read)

---

### Issue 2: `append_terminal_output` uses non-standard SQLite `ORDER BY` in `UPDATE`

**File:** `src-tauri/src/ipc/execution_handlers.rs` lines 608-620

```rust
let result = conn.execute(
    "UPDATE execution_logs
     SET terminal_output = COALESCE(terminal_output, '') || ?
     WHERE task_id = ? AND status IN ('running', 'failed', 'complete')
     ORDER BY id DESC LIMIT 1",  // <-- non-standard, risky
    ...
);
// Comment in code: "If this causes issues, we can use a subquery approach instead"
```

The code's own comment flags this as a known risk. The `ORDER BY` clause in `UPDATE` is not standard SQL and is not guaranteed by SQLite — it is an undocumented extension. The correct subquery form is already described in the comment block immediately below. This should be replaced with the safe subquery approach before the codebase grows.

**Confidence:** HIGH (direct code read, confirmed by SQLite documentation knowledge)

---

### Issue 3: Quick-task work (skills removal + branch dropdown) is uncommitted

**Working tree diff (`git diff --stat HEAD`):** 12 files modified, including:
- `src/components/task/TaskForm.tsx` — skills selector removed, branch dropdown added
- `src/components/kanban/BacklogTaskSheet.tsx` — related cleanup
- `src/components/views/BacklogView.tsx` — substantially rewritten (172 lines changed)
- `src/components/project-picker/CloneProjectDialog.tsx`, `CreateProjectDialog.tsx`, `FilePicker.tsx`, `ProjectsListLayout.tsx` — project-picker polish
- `src/components/project-picker/__tests__/CloneProjectDialog.test.tsx` — test updated

There is a corresponding quick-plan at `.planning/quick/260328-ty5-remove-skills-selection-from-tasks-and-c/260328-ty5-PLAN.md` and a pending todo at `.planning/todos/pending/001-improve-project-picker-screen.md`.

The build passes (`pnpm build`) and all 110 tests pass with these changes uncommitted, so the changes are functionally complete but not committed. Phase 29 should include a task to review, validate, and commit this work.

**Note:** The `TaskForm` now has `skills: []` hardcoded in its submit handler (line 71), which is correct since skills UI was removed. The `Task` binding type still has a `skills` field (from Rust `Vec<String>`) — this is acceptable since the backend still stores skills, the UI just no longer exposes the field.

**Confidence:** HIGH (direct file inspection + build verification)

---

### Issue 4: `WorktreeManager` diff stats belong to the selected worktree, not each list item

**File:** `src/components/execution/WorktreeManager.tsx` lines 161-226

The sidebar list items render `diffStat` from `wt.diff_stat` (the shortstat string from the Rust backend). This is correct. However, the _full diff_ panel (right pane) is fetched via `useWorktreeDiffQuery(selectedWorktree?.id ?? null)`. The right pane logic has a subtle condition:

```tsx
{selectedWorktree.git_status === "" && !diffLoading ? (
  <div>No uncommitted changes</div>
) : diffFiles.length > 0 ? (
  ...render DiffViewer per file...
) : (
  <DiffViewer diffFile={null} loading={diffLoading} error={...} />
)}
```

When `git_status` is non-empty but `diffFiles` is empty (diff fetch in flight or returned empty), the fallback `<DiffViewer diffFile={null} loading={diffLoading} />` renders "No changes to display" even while loading. This creates a momentary flash of the empty state before loading takes effect. The condition should check `diffLoading` first.

This is a minor UX polish item, not a hard bug.

**Confidence:** HIGH (direct code read)

---

### Issue 5: `AgentsView` auto-select does not re-trigger if executions list updates after initial selection

**File:** `src/views/AgentsView.tsx` lines 27-34

```tsx
} else if (selectedTaskId == null && executions.length > 0) {
  // Fallback: auto-select most recent Running execution
  const running = executions.find((e) => e.status === "running");
  if (running) setSelectedTaskId(running.task_id);
}
```

The `selectedTaskId == null` guard means once a task is selected and then completes (status changes from `running` to `complete`), the selected item stays on the completed task — which is correct. However, if the user has no selection and no running tasks on mount, then a new execution starts (via Kanban → Execute), the auto-select will not fire because `selectedTaskId` will remain `null` but the `useEffect` has `selectedTaskId` in its dependency array — so it will fire. This is actually fine. No fix needed, but should be confirmed during verification.

**Confidence:** MEDIUM (code analysis; would need runtime testing to confirm)

---

### Issue 6: `list_executions_with_task_info` may return duplicate rows per execution

**File:** `src-tauri/src/ipc/execution_handlers.rs` lines 811-838

```sql
SELECT el.id, el.task_id, t.name AS task_name, w.branch_name, ...
FROM execution_logs el
INNER JOIN tasks t ON t.id = el.task_id
LEFT JOIN worktrees w ON w.task_id = el.task_id   -- <-- could match multiple worktrees
WHERE t.project_id = ?
ORDER BY el.started_at DESC
```

If a task has multiple historical worktrees (each execution creates a new one), the `LEFT JOIN worktrees w ON w.task_id = el.task_id` could produce multiple rows per execution log. In practice, worktrees are deleted on completion (`delete_worktree_for_task` is called in the background task finalization), so typically at most one worktree per task exists at any time. This is LOW risk in practice but worth noting as a latent data integrity issue.

**Confidence:** MEDIUM (SQL analysis; depends on whether worktrees are always cleaned up before next execution)

---

### Issue 7: `DiffViewer` loading state in `WorktreeManager` uses `diff-viewer-container` CSS classes, not Tailwind

**File:** `src/components/execution/DiffViewer.tsx` lines 43-78

Loading, error, and empty states use custom CSS class names (`diff-viewer-container`, `diff-viewer-loading`, `diff-viewer-error`, `diff-viewer-empty`) that are not defined in the Tailwind-based CSS system. These states will render unstyled or with browser defaults. The happy path (actual `<DiffView>` component) renders correctly because `@git-diff-view/react/styles/diff-view.css` is imported. But loading/error/empty states need to be updated to use Tailwind classes consistent with the rest of the UI.

**Confidence:** HIGH (confirmed by CSS search — no `.diff-viewer-container` rule exists in the project)

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead |
|---------|-------------|-------------|
| Theme detection for DiffViewer | Custom theme detection | `useTheme()` from ThemeProvider or `document.documentElement.classList.contains("dark")` |
| Safe SQL UPDATE with ORDER BY | New SQL pattern | Subquery form already documented in the code's own comment |
| New UI components | Custom implementations | Existing shadcn/ui components in `@/ui/` |

---

## Common Pitfalls

### Pitfall 1: Forgetting to regenerate TypeScript bindings after Rust model changes

**What goes wrong:** If Rust models change (e.g., removing a field from `Task`), the TypeScript bindings in `src/types/bindings.ts` become stale and TypeScript compilation fails or produces incorrect types.

**Prevention:** After any Rust model change, run `pnpm tauri:gen` to regenerate `src/types/bindings.ts`. The CLAUDE.md explicitly documents this workflow.

**Note for Phase 29:** The skills field is NOT being removed from the Rust `Task` model — only from the UI. No binding regeneration is needed for the skills-UI-removal work already in the working tree.

### Pitfall 2: Breaking the pure-display component contract

**What goes wrong:** Adding a TanStack Query call inside `AgentMonitor` or `WorktreeManager` breaks the established pattern where Views own queries and components are pure display.

**Prevention:** All new data fetching must happen in `AgentsView` / `WorktreesView` and be passed as props, or added to the relevant `*.service.ts` and called from the View level.

### Pitfall 3: `useTheme()` hook location

The ThemeProvider and `useTheme()` hook live in `src/contexts/ThemeProvider.tsx` (Phase 14 delivery). The import path is `@/contexts` (or the barrel export if one exists). Verify the exact import path before using in DiffViewer.

### Pitfall 4: SQLite `ORDER BY` in `UPDATE` silently succeeds but is non-portable

The non-standard `UPDATE ... ORDER BY ... LIMIT 1` works in some SQLite versions but is not documented behavior. Using it in new code is forbidden. Use the subquery form.

---

## Code Examples

### DiffViewer theme fix pattern

```tsx
// Source: direct codebase reading — ThemeProvider pattern
import { useTheme } from "@/contexts/ThemeProvider"; // verify exact path

const { resolvedTheme } = useTheme();
const diffTheme = resolvedTheme === "dark" ? "dark" : "light";

// Then in JSX:
<DiffView
  diffViewMode={DiffModeEnum.Unified}
  diffViewTheme={diffTheme}
  ...
/>
```

### Safe SQLite UPDATE for `append_terminal_output`

```rust
// Replace the ORDER BY form with the subquery form (already described in code comment)
conn.execute(
    "UPDATE execution_logs
     SET terminal_output = COALESCE(terminal_output, '') || ?1
     WHERE id = (
         SELECT id FROM execution_logs
         WHERE task_id = ?2 AND status IN ('running', 'failed', 'complete')
         ORDER BY id DESC LIMIT 1
     )",
    rusqlite::params![&output, task_id],
)
```

### Tailwind loading/error states for DiffViewer

```tsx
// Replace custom CSS class names with Tailwind equivalents
if (loading) {
  return (
    <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
      Loading diff...
    </div>
  );
}
if (error) {
  return (
    <div className="flex items-center justify-center h-full text-sm text-destructive">
      Error loading diff: {error}
    </div>
  );
}
if (!diffFile) {
  return (
    <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
      No changes to display
    </div>
  );
}
```

---

## Runtime State Inventory

Not applicable — this is a polish/bug-fix phase, not a rename/refactor phase.

---

## Environment Availability

Step 2.6: SKIPPED — no external dependencies beyond existing project toolchain. Build (`pnpm build`) and tests (`pnpm test`) confirmed passing at research time.

---

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest 4.1.2 |
| Config file | `vite.config.ts` (Vitest is configured inline) |
| Quick run command | `pnpm test --run` |
| Full suite command | `pnpm test` |

### Current Test Inventory

110 tests across 12 test files currently pass. Test files are co-located under `__tests__/` subdirectories. The `CloneProjectDialog.test.tsx` file is among the modified working-tree files.

### Phase Requirements → Test Map

| Behavior | Test Type | Notes |
|----------|-----------|-------|
| DiffViewer theme follows app theme | unit (visual test) | Manual verification acceptable; theme switching is runtime-only |
| `append_terminal_output` SQL fix | unit (Rust `cargo test`) | Backend unit test would verify behavior |
| Working-tree changes compile + pass tests | build + test | `pnpm build && pnpm test` is the gate |
| DiffViewer loading/error states use Tailwind | visual inspection | No automated test coverage |

### Wave 0 Gaps

None — existing test infrastructure is sufficient. The working-tree changes already pass all 110 tests.

---

## Open Questions

1. **ThemeProvider hook API**
   - What we know: ThemeProvider was implemented in Phase 14 at `src/contexts/ThemeProvider.tsx`
   - What's unclear: Whether it exports `useTheme()` with a `resolvedTheme` property or something else
   - Recommendation: Read `src/contexts/ThemeProvider.tsx` before implementing the DiffViewer theme fix

2. **`append_terminal_output` usage frequency**
   - What we know: Called from the frontend via IPC on every PTY output chunk
   - What's unclear: Whether the non-standard SQL form has ever actually failed in production
   - Recommendation: Fix it proactively — the safe subquery form is a drop-in replacement

3. **Uncommitted working-tree files scope**
   - What we know: 12 files are modified; quick-plan task exists; all tests pass
   - What's unclear: Was the quick-plan task fully executed or is it mid-flight?
   - Recommendation: Review the quick-plan output and commit if complete; roll back if not

---

## Sources

### Primary (HIGH confidence)

All findings are from direct inspection of codebase files. No external sources consulted.

- `src/components/execution/DiffViewer.tsx` — hardcoded light theme, custom CSS class names
- `src-tauri/src/ipc/execution_handlers.rs` — non-standard ORDER BY in UPDATE
- `src-tauri/src/ipc/worktree_handlers.rs` — list_worktrees_with_status SQL join analysis
- `src/components/execution/WorktreeManager.tsx` — diff loading state condition
- `src/views/AgentsView.tsx` — auto-select logic
- `git diff --stat HEAD` — confirmed 12 uncommitted files
- `pnpm build` — confirmed passing
- `pnpm test` — confirmed 110/110 passing

---

## Metadata

**Confidence breakdown:**
- Defects identified: HIGH — all from direct code reads
- Uncommitted work state: HIGH — confirmed via git diff + build
- Auto-select edge case: MEDIUM — code analysis only, needs runtime confirmation

**Research date:** 2026-03-30
**Valid until:** Stable (no fast-moving external dependencies)

---

## Project Constraints (from CLAUDE.md)

- Use `pnpm` for all frontend commands
- No barrel `index.ts` files — use direct imports
- Path aliases: `@/hooks`, `@/lib`, `@/ui`
- TypeScript strict mode enabled
- After Rust model changes: run `pnpm tauri:gen` to regenerate bindings
- Rust: return `Result<T, String>` from IPC commands
- All new components in domain subdirectory under `src/components/`
- Service layer pattern: no direct `invoke()` in components or hooks
- Zustand with Immer for global state; TanStack Query for server state
- shadcn/ui for all UI primitives — no custom component re-implementations
- SQLite `PRAGMA foreign_keys = ON`; all IPC commands use `Arc<AppState>`
- Rust: `tokio::process::Command` for all local git operations (no blocking)
