---
phase: quick
plan: 260330-khs
type: execute
wave: 1
depends_on: []
files_modified:
  - src/views/AgentsView.tsx
  - src/components/execution/AgentMonitor.tsx
autonomous: true
requirements: []
must_haves:
  truths:
    - "New Session button appears at top of agent list sidebar, above the execution entries"
    - "Clicking New Session opens the spawn dialog"
    - "Button is no longer in the top action bar"
    - "Button label reads New Session, not Spawn Agent"
  artifacts:
    - path: "src/views/AgentsView.tsx"
      provides: "Spawn dialog state and logic, passes onSpawn callback to AgentMonitor"
    - path: "src/components/execution/AgentMonitor.tsx"
      provides: "New Session button at top of sidebar list"
  key_links:
    - from: "AgentMonitor.tsx"
      to: "AgentsView.tsx"
      via: "onSpawn prop callback"
      pattern: "onSpawn"
---

<objective>
Move the "Spawn Agent" button from the AgentsView top action bar into the AgentMonitor sidebar (matching the "New Worktree" button pattern in WorktreeManager), and rename it to "New Session".

Purpose: Consistent UI pattern between Agents and Worktrees views -- both have their primary action button at the top of the sidebar list.
Output: Updated AgentsView.tsx and AgentMonitor.tsx
</objective>

<execution_context>
@/home/m306213/workspace/maestro/.claude/get-shit-done/workflows/execute-plan.md
@/home/m306213/workspace/maestro/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@src/views/AgentsView.tsx
@src/views/WorktreesView.tsx
@src/components/execution/AgentMonitor.tsx
@src/components/execution/WorktreeManager.tsx

<interfaces>
<!-- WorktreeManager pattern to replicate (from WorktreeManager.tsx lines 114-133): -->
```tsx
// Sidebar with "New Worktree" button at top, before scrollable list
<div className="w-72 flex flex-col border-r border-border bg-card shrink-0">
  {/* New Worktree button row */}
  <div className="px-3 py-2 border-b border-border">
    <Button variant="outline" size="sm" className="w-full h-8 text-xs justify-start" ...>
      <Plus className="w-3.5 h-3.5 mr-1" />
      New Worktree
    </Button>
  </div>
  {/* Scrollable list */}
  <div className="flex-1 overflow-y-auto">...</div>
</div>
```

<!-- AgentMonitor current props interface: -->
```tsx
interface AgentMonitorProps {
  executions: ExecutionLogWithTaskInfo[];
  selectedExecutionId: number | null;
  onSelect: (id: number) => void;
  search: string;
  statusFilter: StatusFilter;
}
```
</interfaces>
</context>

<tasks>

<task type="auto">
  <name>Task 1: Move spawn button from action bar to AgentMonitor sidebar</name>
  <files>src/views/AgentsView.tsx, src/components/execution/AgentMonitor.tsx</files>
  <action>
1. In AgentMonitor.tsx:
   - Add `onSpawn?: () => void` to the AgentMonitorProps interface
   - Import `Button` from `@/ui/button` and `Plus` from `lucide-react`
   - Add a button row above the scrollable execution list (inside the sidebar div, before the `flex-1 overflow-y-auto` div), matching WorktreeManager pattern exactly:
     ```
     <div className="px-3 py-2 border-b border-border">
       <Button variant="outline" size="sm" className="w-full h-8 text-xs justify-start" onClick={onSpawn}>
         <Plus className="w-3.5 h-3.5 mr-1" />
         New Session
       </Button>
     </div>
     ```
   - Only render button row if onSpawn prop is provided

2. In AgentsView.tsx:
   - Remove the "Spawn Agent" Button from the action bar (the right-side div containing the button with Play icon, lines 91-105)
   - Remove the `Play` import from lucide-react (no longer needed)
   - Pass `onSpawn` callback to AgentMonitor that opens the spawn dialog:
     ```
     onSpawn={() => {
       setSpawnBranch(currentBranch);
       setSpawnLabel("");
       setShowSpawnDialog(true);
     }}
     ```
   - The right-side div in the action bar becomes empty or is removed (keep empty div for layout balance, or remove if the left side looks fine alone)
   - The spawn dialog itself stays in AgentsView (it owns the state and mutation) -- only the trigger button moves
  </action>
  <verify>
    <automated>cd /home/m306213/workspace/maestro && pnpm build 2>&1 | tail -5</automated>
  </verify>
  <done>
    - "New Session" button appears at top of AgentMonitor sidebar, matching WorktreeManager's "New Worktree" layout
    - No "Spawn Agent" button in the top action bar
    - Spawn dialog still works when clicking "New Session"
    - Build passes with 0 TypeScript errors
  </done>
</task>

</tasks>

<verification>
- pnpm build succeeds with 0 errors
- Grep confirms no "Spawn Agent" text remains in codebase
- "New Session" text present in AgentMonitor.tsx
</verification>

<success_criteria>
- "New Session" button at top of agent sidebar list (same position as "New Worktree" in WorktreeManager)
- Button opens spawn dialog when clicked
- No button in the top action bar
- Production build passes
</success_criteria>

<output>
After completion, create `.planning/quick/260330-khs-move-spawn-agent-button-to-top-of-list-a/260330-khs-SUMMARY.md`
</output>
