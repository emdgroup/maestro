# Fix: Agent session state lost on tab switch

## Context

When users navigate away from the "agents" tab mid-session (e.g., to check worktrees or tasks), the entire `AgentsView` unmounts due to conditional rendering in `App.tsx`. This destroys all accumulated messages, event listeners, and activity state. The backend keeps running fine — the subprocess continues — but the UI appears "restarted" with all messages gone. Events emitted during the unmount window are irrecoverably lost (spawned sessions have no replay buffer).

## Root Cause

`App.tsx` lines 191-213: `{activeTab === "agents" && <motion.div>...<AgentsView/></motion.div>}` inside `AnimatePresence`. Tab switch → condition false → React unmounts entire subtree → useReducer state (messages), Tauri event listeners, all destroyed.

## Fix

Apply the same pattern already used in `AgentMonitor.tsx` line 317 (`"ACP panels always mounted so state survives navigation"`): render AgentsView unconditionally, toggle visibility with CSS `hidden` class.

## Changes (single file: `src/App.tsx`)

1. Add import: `import { cn } from "@/lib/ui-utils";`

2. Remove the `activeTab === "agents"` block (lines 191-213) from inside `<AnimatePresence>`

3. Add always-mounted AgentsView div before `<AnimatePresence>`:

```tsx
{/* AgentsView always mounted — session state survives tab navigation */}
<div className={cn("absolute inset-0 overflow-hidden", activeTab !== "agents" && "hidden")}>
  <Suspense fallback={fallback}>
    <AgentsView
      projectId={currentProject.id}
      repoPath={currentProject.path}
      connectionId={currentProject.connection_id}
    />
  </Suspense>
</div>
```

## Why This Works

- `hidden` = `display: none` → no z-index conflicts with AnimatePresence views
- Component stays mounted → useReducer keeps accumulating events → listeners stay active
- Other views keep their slide animations (kanban/worktrees/settings still in AnimatePresence)
- No backend changes needed
- Lazy-loaded chunk loads in background (invisible inside hidden div)
- Matches existing codebase pattern (AgentMonitor)

## No Other Files Need Changes

- `AgentActivityPanel` cleanup effects only fire on true unmount (session close) — correct
- `useAcpActivity` listeners stay subscribed — correct
- `navigationStore.pendingAgentId` still works — AgentsView is already mounted when the effect fires

## Verification

1. Start agent session → send message → switch to kanban → wait → switch back → messages intact
2. Trigger long tool call → switch tab during execution → switch back → result appears
3. Verify slide animations still work between kanban/worktrees/settings
4. Verify agent events continue accumulating while on other tab (check activity status dot)
5. Open session from another tab via `navigate({ agentId })` → correct session selected
