---
phase: quick-260402-ctz
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - src/views/WorktreesView.tsx
  - src/components/execution/WorktreeCardGrid.tsx
autonomous: true
requirements: [QUICK-GROUP-TOGGLE]
must_haves:
  truths:
    - "User can toggle between grouped mode and flat grid mode via a button in the action bar"
    - "Flat grid mode shows all cards in a single flex row sorted by most recent created_at"
    - "Toggle state persists while navigating between card grid and diff panel"
  artifacts:
    - path: "src/views/WorktreesView.tsx"
      provides: "viewMode state and toggle button between collapse-all and new-worktree buttons"
      contains: "viewMode"
    - path: "src/components/execution/WorktreeCardGrid.tsx"
      provides: "Flat grid rendering path when viewMode is grid"
      contains: "viewMode"
  key_links:
    - from: "src/views/WorktreesView.tsx"
      to: "src/components/execution/WorktreeCardGrid.tsx"
      via: "viewMode prop"
      pattern: "viewMode"
---

<objective>
Add a group/grid toggle button to the WorktreesView action bar (between the collapse-all button and the new-worktree button) that switches between the current grouped-by-base-branch layout and a flat grid layout showing all cards sorted by most recent `created_at`.

Purpose: Let users quickly see all worktrees at a glance without branch grouping, sorted by recency.
Output: Toggle button in action bar, flat grid rendering mode in WorktreeCardGrid.
</objective>

<execution_context>
@/home/m306213/workspace/maestro/.claude/get-shit-done/workflows/execute-plan.md
@/home/m306213/workspace/maestro/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@src/views/WorktreesView.tsx
@src/components/execution/WorktreeCardGrid.tsx
@src/components/execution/WorktreeCardGroup.tsx
@src/components/execution/WorktreeCard.tsx

<interfaces>
From src/views/WorktreesView.tsx:
```typescript
export const STATUS_FILTERS = ["All", "Active", "Modified", "Idle"] as const;
export type StatusFilter = (typeof STATUS_FILTERS)[number];
```

From src/components/execution/WorktreeCardGrid.tsx:
```typescript
interface WorktreeCardGridProps {
  groups: Array<{ groupKey: string; items: WorktreeWithStatus[] }>;
  collapsedGroups: Record<string, boolean>;
  onToggleGroup: (group: string) => void;
  onSelectWorktree: (id: number) => void;
  onDeleteWorktree: (id: number) => void;
  emptyMessage?: string;
}
```

From src/types/bindings.ts:
```typescript
export type WorktreeWithStatus = {
  id: number | null; project_id: number | null; task_id: number | null;
  branch_name: string; path: string; git_status: string;
  created_at: string | null; task_name: string | null;
  agent_status: string | null; is_zombie: boolean; is_orphan: boolean;
  diff_stat: string | null; base_branch: string | null;
  ahead_behind: AheadBehind | null;
}
```
</interfaces>
</context>

<tasks>

<task type="auto">
  <name>Task 1: Add viewMode state and toggle button to WorktreesView</name>
  <files>src/views/WorktreesView.tsx</files>
  <action>
1. Add a `viewMode` state: `useState<"grouped" | "grid">("grouped")`.

2. Import `LayoutGrid` and `Group` (or `Rows3`) from lucide-react for the toggle icon. Use `LayoutGrid` for grid mode icon and `Group` for grouped mode icon (show the icon for the mode you will switch TO, not the current mode).

3. In the action bar div (the right-side flex container with collapse-all and new-worktree), insert a new Button BETWEEN the collapse-all button and the new-worktree button:
   ```tsx
   <Button
     variant="ghost"
     size="sm"
     className="h-8"
     onClick={() => setViewMode(prev => prev === "grouped" ? "grid" : "grouped")}
   >
     {viewMode === "grouped" ? <LayoutGrid className="w-3.5 h-3.5 mr-1" /> : <Group className="w-3.5 h-3.5 mr-1" />}
     <span className="text-xs">{viewMode === "grouped" ? "Grid view" : "Grouped view"}</span>
   </Button>
   ```

4. Conditionally hide the collapse-all button when viewMode is "grid" (collapsing groups makes no sense in flat mode).

5. Pass `viewMode` as a new prop to `WorktreeCardGrid`. Also pass `flatWorktrees` — the filtered worktrees sorted by `created_at` descending (most recent first). Compute with useMemo:
   ```tsx
   const flatWorktrees = useMemo(() => {
     return [...filteredWorktrees].sort((a, b) => {
       const dateA = a.created_at ? new Date(a.created_at).getTime() : 0;
       const dateB = b.created_at ? new Date(b.created_at).getTime() : 0;
       return dateB - dateA;
     });
   }, [filteredWorktrees]);
   ```

6. Update the WorktreeCardGrid usage to pass the new props:
   ```tsx
   <WorktreeCardGrid
     viewMode={viewMode}
     flatWorktrees={flatWorktrees}
     groups={groupedWorktrees}
     ...existing props
   />
   ```
  </action>
  <verify>
    <automated>cd /home/m306213/workspace/maestro && npx tsc --noEmit 2>&1 | head -30</automated>
  </verify>
  <done>Toggle button visible in action bar between collapse-all and new-worktree. Clicking toggles viewMode state. Collapse-all hidden in grid mode.</done>
</task>

<task type="auto">
  <name>Task 2: Render flat grid mode in WorktreeCardGrid</name>
  <files>src/components/execution/WorktreeCardGrid.tsx</files>
  <action>
1. Update the WorktreeCardGridProps interface to accept two new props:
   ```typescript
   viewMode: "grouped" | "grid";
   flatWorktrees: WorktreeWithStatus[];
   ```

2. In the component body, when `viewMode === "grid"`:
   - Skip the grouped rendering entirely
   - If `flatWorktrees.length === 0`, show the same empty message as the grouped path
   - Otherwise render a single `div` with the same styling as the card container inside WorktreeCardGroup (`flex flex-wrap gap-3 px-2 pb-3`) but wrapped in the scrollable outer container (`flex-1 overflow-y-auto p-4`):
     ```tsx
     if (viewMode === "grid") {
       if (flatWorktrees.length === 0) {
         return (
           <div className="flex-1 flex items-center justify-center">
             <span className="text-sm text-muted-foreground">{emptyMessage ?? "No worktrees yet"}</span>
           </div>
         );
       }
       return (
         <div className="flex-1 overflow-y-auto p-4">
           <div className="flex flex-wrap gap-3">
             {flatWorktrees.map((wt) => (
               <WorktreeCard
                 key={wt.path}
                 worktree={wt}
                 onSelect={onSelectWorktree}
                 onDelete={onDeleteWorktree}
               />
             ))}
           </div>
         </div>
       );
     }
     ```

3. The existing grouped rendering remains as the `else` path (viewMode === "grouped"), unchanged.
  </action>
  <verify>
    <automated>cd /home/m306213/workspace/maestro && pnpm build 2>&1 | tail -5</automated>
  </verify>
  <done>Grid mode renders all cards in a flat flex-wrap row sorted by most recent created_at. Grouped mode unchanged. Build passes.</done>
</task>

</tasks>

<verification>
- `pnpm build` succeeds with no TypeScript errors
- Toggle button appears in the action bar between collapse-all and new-worktree
- Clicking toggle switches between grouped (with collapsible branch sections) and flat grid (all cards, sorted by recency)
- Collapse-all button hidden in grid mode
- Card selection still works in both modes (clicking a card slides to diff panel)
</verification>

<success_criteria>
- viewMode toggle button renders in the action bar
- Grouped mode shows branch-grouped collapsible sections (existing behavior, unchanged)
- Grid mode shows all filtered worktrees as a flat flex row sorted by created_at descending
- Build passes with zero TypeScript errors
</success_criteria>

<output>
After completion, create `.planning/quick/260402-ctz-in-the-worktrees-view-add-a-group-toggle/260402-ctz-SUMMARY.md`
</output>
