# Plan: Fix Inline Activity Cards Not Appearing

## Context

After a recent change to only display inline file cards when the tool call group is "Done" (to avoid flickering), the cards never appear during active sessions. The condition `groupSealed` at line 499-500 of `AgentActivityPanel.tsx` is too strict:

```typescript
const groupSealed = groupDone && (!isLastInSection || liveState.sessionEnded);
```

This means the **last** tool group in a section (which is always the most recent one) never shows its cards until the session ends or a subsequent message/thinking item arrives. The "Working Files" header button still works because it's driven by `sessionWorkingFiles` state computed from all items, not per-group gating.

---

## Root Cause

`!isLastInSection` checks `giIdx === items.length - 1`. The most recent tool group is always last in its section, so `groupSealed` stays false indefinitely during an active session.

---

## Fix

**Replace `groupSealed` with `groupDone`.**

Line 499-500 in `src/components/execution/AgentActivityPanel.tsx`:

```typescript
// BEFORE:
const groupSealed = groupDone && (!isLastInSection || liveState.sessionEnded);

// AFTER: just use groupDone directly
```

Then lines 505 and 512 change from `groupSealed &&` to `groupDone &&`.

**Why this is safe**: Tool groups form from consecutive tool call items (`groupToolCalls` in utils.ts). If a new pending tool call arrives, it extends the group and `groupDone` flips back to false (since the new item's status won't be "completed"). So cards only show when the group is truly quiescent — no flickering risk.

Also remove the now-unused `isLastInSection` variable.

---

## Files to Modify

| File | Change |
|------|--------|
| `src/components/execution/AgentActivityPanel.tsx` | Remove `groupSealed` / `isLastInSection`, use `groupDone` directly for card visibility |

---

## Verification

1. `pnpm tsc --noEmit` — 0 errors
2. Start agent session, trigger tool calls that modify files
3. Inline "Files Changed" card appears after tool group completes (without waiting for session end)
4. If agent immediately starts another tool call, cards hide until new group completes (no flicker)
