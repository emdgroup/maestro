# Fix: Auto-approve empty plan permission

## Context

When agent exits plan mode without writing content (`ExitPlanMode` / `switch_mode`), full-screen overlay shows with only buttons, no text. Should auto-approve silently instead.

## Plan

### Step 1: Export `extractBodyText`

**File: `src/components/execution/activity/PermissionPrompt.tsx`**

Export the existing `extractBodyText` function (currently module-private).

### Step 2: Auto-approve empty plan + gate overlay

**File: `src/components/execution/AgentActivityPanel.tsx`**

1. Import `extractBodyText` from `./activity/PermissionPrompt`
2. Add `useEffect` — when `pendingPermission` is a plan permission with null body text, find first allow option and call `handlePermissionRespond` to auto-approve
3. In render section, only set `planOverlay` if `extractBodyText` returns non-null body

## Files to modify

1. `src/components/execution/activity/PermissionPrompt.tsx` — export `extractBodyText`
2. `src/components/execution/AgentActivityPanel.tsx` — import + use `extractBodyText`, add auto-approve effect, gate overlay

## Verification

Trigger agent `ExitPlanMode` with empty plan → no overlay, auto-approved silently.
