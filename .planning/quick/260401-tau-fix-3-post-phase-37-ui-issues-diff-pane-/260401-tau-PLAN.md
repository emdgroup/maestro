---
phase: quick-260401-tau
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - src/components/execution/WorktreeCard.tsx
  - src/views/WorktreesView.tsx
  - src/components/execution/WorktreeDiffPanel.tsx
autonomous: true
requirements: [TAU-01, TAU-02, TAU-03]

must_haves:
  truths:
    - "Clicking a clean worktree card (empty git_status and null diff_stat) does nothing"
    - "Action bar slides out with the card grid when diff panel is visible"
    - "Branch name is horizontally centered in the diff panel action bar"
  artifacts:
    - path: "src/components/execution/WorktreeCard.tsx"
      provides: "Conditional click gate on dirty status"
    - path: "src/views/WorktreesView.tsx"
      provides: "Action bar moved inside slide container Screen 1"
    - path: "src/components/execution/WorktreeDiffPanel.tsx"
      provides: "Centered branch name in action bar"
  key_links:
    - from: "WorktreeCard.tsx"
      to: "onSelect callback"
      via: "onClick handler guards on git_status or diff_stat"
      pattern: "git_status.*diff_stat"
---

<objective>
Fix three post-phase-37 UI issues in the worktrees view: gate diff pane opening on dirty status, slide the action bar with the card grid, and center the branch name in the diff panel action bar.

Purpose: Polish the redesigned worktrees view so clean worktrees don't open an empty diff panel, the action bar transitions cleanly, and the diff panel header is visually balanced.
Output: Three targeted edits across WorktreeCard, WorktreesView, and WorktreeDiffPanel.
</objective>

<execution_context>
@/home/m306213/workspace/maestro/.claude/get-shit-done/workflows/execute-plan.md
@/home/m306213/workspace/maestro/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@src/views/WorktreesView.tsx
@src/components/execution/WorktreeCard.tsx
@src/components/execution/WorktreeDiffPanel.tsx
@src/components/execution/WorktreeCardGrid.tsx
</context>

<tasks>

<task type="auto">
  <name>Task 1: Gate diff pane on dirty status and move action bar into slide container</name>
  <files>src/components/execution/WorktreeCard.tsx, src/views/WorktreesView.tsx</files>
  <action>
**WorktreeCard.tsx (line 33):** Change the onClick handler to only call `onSelect` when the worktree has uncommitted changes. Replace:
```
onClick={() => worktree.id != null && onSelect(worktree.id)}
```
with:
```
onClick={() => {
  if (worktree.id == null) return;
  if (worktree.git_status === "" && worktree.diff_stat === null) return;
  onSelect(worktree.id);
}}
```
Also add a visual cue: make the cursor conditional. Change the card's className from always having `cursor-pointer` to using `cn(...)` with a conditional:
- If `worktree.git_status !== "" || worktree.diff_stat !== null` => `cursor-pointer hover:bg-muted/10`
- Otherwise => `cursor-default` (no hover highlight)

**WorktreesView.tsx:** Move the entire action bar `<div>` (lines 131-182, the `h-12 border-b` div with search, filters, collapse-all, and New Worktree button) from its current position (above the slide container) to inside Screen 1 — place it as the first child of the `<div className="w-1/2 h-full flex flex-col min-w-0">` that wraps the card grid (line 193). This way when selectedWorktreeId triggers `-translate-x-1/2`, the action bar slides out with the cards.

The outer container (line 129) should remain `<div className="flex flex-col h-full">` but now the slide container `<div className="flex-1 min-h-0 overflow-hidden">` becomes the direct child (no action bar between them).
  </action>
  <verify>
    <automated>cd /home/m306213/workspace/maestro && pnpm build 2>&1 | tail -5</automated>
  </verify>
  <done>Clean worktree cards do not trigger diff panel. Action bar slides out with the card grid when diff panel is shown. Build passes with zero errors.</done>
</task>

<task type="auto">
  <name>Task 2: Center branch name in diff panel action bar</name>
  <files>src/components/execution/WorktreeDiffPanel.tsx</files>
  <action>
In WorktreeDiffPanel.tsx, restructure the action bar (lines 79-141) to center the branch name. Replace the current two-group flex layout with a three-layer approach using relative positioning:

1. Keep the outer div as `relative h-12 border-b border-border bg-muted/30 flex items-center px-4 shrink-0`.

2. **Left group** (file search, flat/tree toggle): wrap in a `flex items-center gap-2 z-10` div. Remove the branch name `<span>` from this group.

3. **Center** (branch name): Add an absolutely positioned element that spans the full width and centers the text:
```tsx
<div className="absolute inset-0 flex items-center justify-center pointer-events-none">
  <span className="font-mono text-sm font-semibold truncate max-w-[300px]">
    {worktree.branch_name}
  </span>
</div>
```

4. **Right group** (unified/split toggle, close button): keep as `ml-auto flex items-center gap-2 z-10`.

The `z-10` on left and right groups ensures their interactive elements sit above the absolutely-positioned centered branch name (which has `pointer-events-none` so it doesn't intercept clicks).
  </action>
  <verify>
    <automated>cd /home/m306213/workspace/maestro && pnpm build 2>&1 | tail -5</automated>
  </verify>
  <done>Branch name displays in the horizontal center of the diff panel action bar. Left controls and right controls remain interactive. Build passes.</done>
</task>

</tasks>

<verification>
- `pnpm build` completes with zero TypeScript errors
- Visual: clicking a clean worktree card does nothing; clicking a dirty card opens the diff panel
- Visual: when diff panel slides in, the search/filter action bar is gone; only the diff panel's action bar is visible
- Visual: branch name is centered in the diff panel action bar between left and right control groups
</verification>

<success_criteria>
All three UI issues resolved: diff pane gated on dirty status, action bar slides with card grid, branch name centered in diff panel header. Production build passes.
</success_criteria>

<output>
After completion, create `.planning/quick/260401-tau-fix-3-post-phase-37-ui-issues-diff-pane-/260401-tau-01-SUMMARY.md`
</output>
