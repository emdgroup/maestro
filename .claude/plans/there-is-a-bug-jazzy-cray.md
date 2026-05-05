# Fix: ComposeBar cancel button stuck after agent turn ends

## Context

Commit `063f2b3` extracted the `turn-ended` event listener from `AgentActivityPanel.tsx` into `useAcpSessionLifecycle.ts`. The extraction lost the `setIsProcessing(false)` call — the hook updates the global zustand store to `"idle"` but has no access to the local `isProcessing` state that drives ComposeBar's cancel/send button toggle.

Result: after agent finishes responding, `isProcessing` stays `true` → cancel button visible and non-functional (cancel calls `interruptAcpTurn` which does nothing after turn already ended).

## Fix

Add a `turn-ended` event listener in `AgentActivityPanel.tsx` that resets `isProcessing`. Two listeners for same Tauri event is fine — they're independent subscribers.

**File**: `src/components/execution/AgentActivityPanel.tsx`

Add after line ~50 (after the spawning/cleanup effect):

```tsx
useEffect(() => {
  const unlisten = listen<string>(`acp://turn-ended/${sessionKey}`, () => {
    setIsProcessing(false);
  });
  return () => { unlisten.then((fn) => fn()); };
}, [sessionKey]);
```

Also add import — `listen` not currently imported in this file:

```tsx
import { listen } from "@tauri-apps/api/event";
```

## Why not other approaches

- **Derive from store**: `activityStatus === "working"` doesn't map 1:1 — during permission prompts status is `"awaiting_input"` but cancel should still work (agent turn still active). Local state is correct design.
- **Callback param on hook**: Adds coupling for a simple one-liner. Two listeners is cleaner.
- **Move isProcessing to store**: Over-engineering for this fix.

## Verification

1. `pnpm dev` — start frontend
2. `pnpm tauri:dev` — start full app  
3. Start ACP session, send message, wait for agent to finish turn
4. Confirm: send button visible (not cancel) after turn ends
5. Confirm: cancel button still works during agent response (interrupt still functions)
6. Confirm: cancel button still shows during permission prompts
