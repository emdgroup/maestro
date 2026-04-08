---
phase: quick-260408-iyu
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - src/components/kanban/TaskCard.tsx
autonomous: true
requirements: [fix-execute-button-removed-spawn]
must_haves:
  truths:
    - "Clicking Execute on a Ready task no longer throws an error"
    - "Clicking Execute navigates to the Agents tab"
    - "A toast informs the user to spawn a session from the Agents view"
  artifacts:
    - path: src/components/kanban/TaskCard.tsx
      provides: "Updated handleExecute that navigates instead of calling removed IPC"
  key_links:
    - from: src/components/kanban/TaskCard.tsx
      to: src/store/navigationStore.ts
      via: "useNavigate hook → navigate({ view: 'agents' })"
      pattern: "navigate.*agents"
---

<objective>
Fix the Execute button on Kanban task cards that throws "spawn_agent_execution has been removed" when clicked.

Purpose: The Kanban Execute button calls boardStore.executeTask(), which intentionally throws because spawn_agent_execution was removed in Phase 34. The new workflow is to start sessions from the Agents view using spawnInteractiveExecution. The button must redirect the user there rather than explode.

Output: TaskCard.tsx updated so handleExecute navigates to the Agents tab via navigationStore and shows an informative toast.
</objective>

<execution_context>
@/home/m306213/workspace/maestro/.claude/get-shit-done/workflows/execute-plan.md
@/home/m306213/workspace/maestro/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@/home/m306213/workspace/maestro/.planning/PROJECT.md
@/home/m306213/workspace/maestro/.planning/STATE.md

<interfaces>
<!-- From src/store/navigationStore.ts -->
```typescript
export type ViewType = "kanban" | "agents" | "worktrees" | "settings";
export type NavigationTarget =
  | { taskId: string }
  | { agentId: string }
  | { worktreeId: string }
  | { view: "backlog" | "board" | "archive" | "agents" | "worktree" | "settings" };

// Hook to get the navigate function
export const useNavigate = () => useNavigationStore((s) => s.navigate);
// Usage: navigate({ view: "agents" }) — switches to the Agents tab
```

<!-- From src/components/kanban/TaskCard.tsx (lines 87–101) -->
```typescript
// BEFORE (broken):
const handleExecute = async () => {
  setIsExecuting(true);
  try {
    const executionLogId = await store.executeTask(task.project_id, task.id, projectPath);
    // ^ throws: "spawn_agent_execution has been removed. Use spawnInteractiveExecution instead."
    console.log("Execution started:", executionLogId);
    toast.success(`Execution started for "${task.name}"`);
  } catch (error) {
    console.error("Execution failed:", error);
    toast.error(`Failed to start execution: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    setIsExecuting(false);
  }
};
```
</interfaces>
</context>

<tasks>

<task type="auto">
  <name>Task 1: Fix handleExecute to navigate to Agents tab</name>
  <files>src/components/kanban/TaskCard.tsx</files>
  <action>
Replace the broken handleExecute function in TaskCard.tsx with one that navigates to the Agents tab instead of calling the removed IPC.

Changes:
1. Import `useNavigate` from `@/store/navigationStore` at the top of the file (alongside the existing imports).
2. Inside the component, add: `const navigate = useNavigate();`
3. Replace the entire `handleExecute` function body with:

```typescript
const handleExecute = () => {
  navigate({ view: "agents" });
  toast.info(`Go to Agents view to start a session for "${task.name}"`);
};
```

4. Remove the `isExecuting` state variable and `setIsExecuting` calls — they are no longer needed (handleExecute is now synchronous).
5. In the JSX, update the Execute button: remove the `disabled={isExecuting}` condition and the conditional class based on isExecuting. The button should always be enabled. Change the label from `{isExecuting ? "Executing..." : "Execute"}` to `"Open Agents"` to accurately reflect the new behavior.

Also remove `const [isExecuting, setIsExecuting] = useState(false);` from the state declarations.

The `store` reference from `useBoardStore()` can remain — it is still used by resumeExecution/pauseExecution via handlePause/handleResume.
  </action>
  <verify>
    <automated>cd /home/m306213/workspace/maestro && pnpm build 2>&1 | tail -20</automated>
  </verify>
  <done>
    - Build passes with 0 TypeScript errors
    - No reference to `isExecuting` state remains in TaskCard.tsx
    - `handleExecute` calls `navigate({ view: "agents" })` and `toast.info(...)`, nothing else
    - Execute button label reads "Open Agents"
  </done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| User → UI | Button click triggers navigation, no external data crosses boundary |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-iyu-01 | Denial of Service | TaskCard.tsx handleExecute | accept | Navigation is a local synchronous store update with no external calls; no attack surface |
</threat_model>

<verification>
Run `pnpm build` — must complete without TypeScript errors. Confirm `grep -n "isExecuting" src/components/kanban/TaskCard.tsx` returns no results. Confirm `grep -n "navigate.*agents" src/components/kanban/TaskCard.tsx` returns a match.
</verification>

<success_criteria>
Clicking the Execute button on a Ready task card navigates to the Agents tab and shows a toast. No error is thrown. Build is clean.
</success_criteria>

<output>
After completion, create `.planning/quick/260408-iyu-fix-execute-button-calling-removed-spawn/260408-iyu-SUMMARY.md` using the summary template.
</output>
