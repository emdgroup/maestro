# Fix: ComposeBar not showing interrupt mode when agent is working

## Context

The ComposeBar send button has two modes: "send" (arrow icon) and "interrupt" (red stop icon). The interrupt mode should display whenever the agent is actively processing a turn. However, `isProcessing` — the sole boolean controlling this toggle — is only set to `true` inside `handleSend()`. When a task is executed from the Kanban board (the primary workflow), the initial prompt is sent by `useExecuteTask` **before** `AgentActivityPanel` even mounts. The panel then initializes with `isProcessing = false` and never transitions to `true` until the user manually sends a second message.

**Result:** Agent is visibly streaming output, but the button shows "send" instead of "interrupt". User cannot interrupt the agent's first turn.

## Root Cause

Two disconnected state systems:
1. `sessionActivityStore` (Zustand) — correctly tracks "spawning"/"thinking"/"acting"/"idle" from streaming events
2. `isProcessing` (local useState in `AgentActivityPanel`) — only set by `handleSend`, not by external state

They are never synchronized. The store knows the agent is working, but the ComposeBar doesn't check it.

## Reproduction Steps

1. Open project with at least one Ready task
2. Click play/execute on a task card in the Kanban board
3. Navigate to Agents tab (or wait for auto-navigation)
4. Observe the ComposeBar — shows send button (not interrupt) while agent streams its first turn
5. Once agent finishes first turn and user sends a second message via ComposeBar, interrupt mode works correctly thereafter

## Fix Approach

**Derive `isProcessing` from the session activity status instead of tracking it independently.**

In `AgentActivityPanel.tsx`:

1. Remove the `useState(false)` for `isProcessing`
2. Compute `isProcessing` from `activityInfo?.status`:
   ```ts
   const isProcessing = activityInfo?.status === "thinking" || activityInfo?.status === "acting";
   ```
3. Keep `handleSend` setting status to "thinking" (already does this via `setActivityStatus`) — this provides the optimistic update
4. Remove the redundant `setIsProcessing(false)` in the `turn-ended` listener (the store already handles this via `useAcpSessionLifecycle` setting status to "idle")
5. Remove `setIsProcessing(false)` from the `sessionEnded` effect (store `removeActivityStatus` already handles cleanup)
6. Keep the catch block in `handleSend` resetting activity status to "idle" (already does this)
7. Keep the catch block in `handleCancel` resetting activity status to "idle" (already does this)

This unifies both paths: ComposeBar `handleSend` and `useExecuteTask` both flow through the same activity store, and the button reflects the store's status.

## Files to Modify

- `src/components/execution/agent-activity-panel/AgentActivityPanel.tsx` — replace `isProcessing` useState with derived value from `activityInfo`

## Verification

1. Execute task from Kanban → Agents tab should show interrupt button immediately as agent streams
2. Send message from ComposeBar → interrupt button shows (optimistic via "thinking" status)
3. Click interrupt → button reverts to send after `turn-ended`
4. Agent finishes turn naturally → button reverts to send
5. Session ends → button shows send
6. Existing tests: `pnpm test AgentActivityPanel` (if they exist) or `pnpm test`
