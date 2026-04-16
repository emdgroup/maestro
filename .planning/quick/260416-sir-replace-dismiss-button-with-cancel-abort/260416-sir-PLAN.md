---
phase: quick
plan: 260416-sir
type: execute
wave: 1
depends_on: []
files_modified:
  - src/components/common/DisconnectBackdrop.tsx
  - src/App.tsx
  - src/components/common/__tests__/DisconnectBackdrop.test.tsx
autonomous: true
requirements: []
must_haves:
  truths:
    - "Failed-state backdrop shows 'Leave Connection' button instead of 'Dismiss'"
    - "Clicking 'Leave Connection' navigates to the project picker screen"
    - "Dismiss callback is still called (to reset connection health state) before navigating away"
  artifacts:
    - path: "src/components/common/DisconnectBackdrop.tsx"
      provides: "Updated backdrop with Leave Connection button"
    - path: "src/App.tsx"
      provides: "Wires Leave Connection to clearSelectedProject + dismissBackdrop"
    - path: "src/components/common/__tests__/DisconnectBackdrop.test.tsx"
      provides: "Updated tests for new button label and callback"
  key_links:
    - from: "src/components/common/DisconnectBackdrop.tsx"
      to: "src/App.tsx"
      via: "onLeaveConnection callback prop"
      pattern: "onLeaveConnection"
---

<objective>
Replace the "Dismiss" button on the SSH disconnect backdrop with a "Leave Connection" button that navigates the user back to the project picker screen.

Purpose: When SSH connection fails permanently, the user should be taken back to the connection/project picker screen rather than staying on a stale project view.
Output: Updated DisconnectBackdrop component, updated App.tsx wiring, updated tests.
</objective>

<execution_context>
@/home/m306213/workspace/maestro/.claude/get-shit-done/workflows/execute-plan.md
@/home/m306213/workspace/maestro/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@src/components/common/DisconnectBackdrop.tsx
@src/App.tsx
@src/components/common/__tests__/DisconnectBackdrop.test.tsx
@src/utils/hooks/useConnectionHealth.ts

<interfaces>
From src/store/projectStore.ts:
```typescript
clearSelectedProject: () => void;  // Sets currentProject to null, which causes App.tsx to render ProjectPickerView
```

From src/utils/hooks/useConnectionHealth.ts:
```typescript
export type ConnectionHealthState = "connected" | "lost" | "reconnecting" | "failed";

interface ConnectionHealth {
  state: ConnectionHealthState;
  attempt: number;
  maxAttempts: number;
  dismiss: () => void;  // Resets state to "connected" and attempt to 0
}
```
</interfaces>
</context>

<tasks>

<task type="auto">
  <name>Task 1: Replace Dismiss with Leave Connection in DisconnectBackdrop</name>
  <files>src/components/common/DisconnectBackdrop.tsx, src/components/common/__tests__/DisconnectBackdrop.test.tsx</files>
  <action>
In DisconnectBackdrop.tsx:
1. Rename the `onDismiss` prop to `onLeaveConnection` in the interface and destructured params.
2. Change the button label from "Dismiss" to "Leave Connection".
3. Wire onClick to the renamed `onLeaveConnection` callback.
4. Update the helper text from "then reconnect from the project picker." to "then try connecting again." (since the button itself takes them to the picker).
5. Add the `LogOut` icon import from lucide-react and render it inside the button before the label text (h-3.5 w-3.5 mr-1.5 inline).

In DisconnectBackdrop.test.tsx:
1. Update `defaultProps` to use `onLeaveConnection` instead of `onDismiss`.
2. Update the "renders failed state with dismiss button" test: query for button with name matching /leave connection/i.
3. Update the "calls onDismiss when dismiss button is clicked" test: rename to "calls onLeaveConnection when button is clicked", use onLeaveConnection callback, query for /leave connection/i.
4. Update the "does not show dismiss button" test: query for /leave connection/i instead of /dismiss/i.
  </action>
  <verify>
    <automated>cd /home/m306213/workspace/maestro && pnpm test DisconnectBackdrop</automated>
  </verify>
  <done>DisconnectBackdrop shows "Leave Connection" button in failed state, tests pass with updated assertions.</done>
</task>

<task type="auto">
  <name>Task 2: Wire Leave Connection to navigate back to project picker</name>
  <files>src/App.tsx</files>
  <action>
In App.tsx, update the DisconnectBackdrop usage (around line 268):

1. Create a `handleLeaveConnection` callback that:
   - Calls `dismissBackdrop()` first (to reset the connection health state so the backdrop does not persist)
   - Then calls `clearSelectedProject()` (which sets currentProject to null, causing App.tsx to render ProjectPickerView)

2. Pass `onLeaveConnection={handleLeaveConnection}` to DisconnectBackdrop instead of `onDismiss={dismissBackdrop}`.

Use `useCallback` with dependencies on `dismissBackdrop` and `clearSelectedProject`.
  </action>
  <verify>
    <automated>cd /home/m306213/workspace/maestro && pnpm build</automated>
  </verify>
  <done>Clicking "Leave Connection" on the failed-state backdrop dismisses the overlay and navigates to the project picker. Build passes with zero TypeScript errors.</done>
</task>

</tasks>

<verification>
1. `pnpm test DisconnectBackdrop` -- all tests pass with updated button label
2. `pnpm build` -- zero TypeScript errors, production bundle builds
3. Manual: trigger SSH disconnect failure state; verify "Leave Connection" button appears and clicking it returns to project picker
</verification>

<success_criteria>
- "Dismiss" button no longer exists anywhere in DisconnectBackdrop
- "Leave Connection" button visible in failed state
- Clicking the button resets connection health state AND navigates to project picker
- All existing tests updated and passing
- Build compiles cleanly
</success_criteria>

<output>
After completion, create `.planning/quick/260416-sir-replace-dismiss-button-with-cancel-abort/260416-sir-SUMMARY.md`
</output>
