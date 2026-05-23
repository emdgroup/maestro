# Plan: "Done" vs "Ready" Session Indicator + Color Rework

## Context

When agent finishes its turn, pill shows grey "Ready" regardless of whether user has seen result. No way to know which sessions have new results. Additionally, swapping thinking/acting colors for clarity, and removing PTY status indicators (inherently always running).

## Final Pill States

| State | Color | Animation | Label |
|-------|-------|-----------|-------|
| Spawning | Grey | pulse | "Starting" |
| Thinking | Purple | glow ring | "Thinking" |
| Acting | Blue | glow ring | "Calling tool" / specific |
| Awaiting input | Yellow | pulse | "Waiting" |
| **Done** | Green | pulse | "Done" |
| Ready | Grey | none | "Ready" |
| PTY | *(no dot, no label)* | — | — |

## "Seen" Condition

User has seen the result when **all three** are true:
1. Session is selected (`isSelected`)
2. Agents tab is active (`activeTab === "agents"`) — needed because AgentsView stays mounted on tab switch
3. Last agent message is in viewport (`atBottomRef.current === true`)

Mark-seen logic lives in `AgentActivityPanel` (has access to scroll state + isSelected).

## Implementation

### 1. `src/store/sessionActivityStore.ts`

- Add `seen: boolean` to `SessionActivityInfo`
- Add `markSeen(executionId: number)` action
- In `setActivity`: when status changes TO `"idle"`, set `seen = false`
- New entry creation → `seen: true` (user just spawned it)
- `markSeen`: sets `seen = true` only if `status === "idle" && !seen`
- Export `markSeen` in `useSessionActivityActions`

### 2. `src/components/execution/activity/useAcpScrollBehavior.ts`

- Expose `atBottomRef` (or add `isAtBottom: boolean` state that mirrors it) so `AgentActivityPanel` can read viewport position
- Simplest: return `atBottomRef` directly in the result object

### 3. `src/components/execution/AgentActivityPanel.tsx`

Add mark-seen effect:
```typescript
const activeTab = useActiveTab();
const { markSeen } = useSessionActivityActions();
const activityInfo = useSessionActivity(sessionKey);

useEffect(() => {
  if (
    isSelected &&
    activeTab === "agents" &&
    atBottomRef.current &&
    activityInfo?.status === "idle" &&
    activityInfo?.seen === false
  ) {
    markSeen(sessionKey);
  }
}, [isSelected, activeTab, activityInfo?.status, activityInfo?.seen, sessionKey, markSeen]);
```

Also mark seen when user scrolls to bottom on idle+unseen session — add to `handleChatScroll` or add separate effect triggered by scroll reaching bottom. Cleanest: in the `handleChatScroll` callback within the hook, expose an `onReachBottom` callback, or handle in `AgentActivityPanel` by watching the `hasUnread` → `false` transition (which happens when user scrolls to bottom).

**Simplest approach**: In `AgentActivityPanel`, watch for `!hasUnread` (set false when user reaches bottom) combined with idle+unseen:

```typescript
useEffect(() => {
  if (
    isSelected &&
    activeTab === "agents" &&
    !hasUnread &&
    activityInfo?.status === "idle" &&
    activityInfo?.seen === false
  ) {
    markSeen(sessionKey);
  }
}, [isSelected, activeTab, hasUnread, activityInfo?.status, activityInfo?.seen, sessionKey, markSeen]);
```

This works because:
- `hasUnread = false` when user is at bottom (line 46 of scroll hook)
- `hasUnread = true` when content grows while user is scrolled up (line 111)
- When turn ends at bottom: `hasUnread` stays false → effect fires → marks seen → shows "Ready"
- When turn ends while scrolled up: `hasUnread` becomes true → not marked seen → shows "Done"
- When user scrolls to bottom: `hasUnread` → false → effect fires → marks seen → transitions to "Ready"

**No need to expose `atBottomRef`** — `hasUnread` is already the public reactive signal for "user is not at bottom".

### 4. `src/components/execution/AgentMonitor.tsx`

**Color swap + Done state:**
```typescript
const ACTIVITY_DOT: Record<SessionActivityStatus, string> = {
  spawning: "bg-muted-foreground/60 animate-pulse",
  thinking: "bg-purple animate-glow-purple",    // swapped
  acting: "bg-info animate-glow-info",           // swapped
  awaiting_input: "bg-warning animate-pulse",
  idle: "bg-muted-foreground/40",
};
```

**Update `getStatusDot`:**
```typescript
function getStatusDot(session: ActiveSessionInfo, activityInfo: SessionActivityInfo | undefined): string {
  if (session.execution_mode !== "acp") return ""; // PTY: no dot
  const status = activityInfo?.status ?? "thinking";
  if (status === "idle" && activityInfo && !activityInfo.seen) {
    return "bg-success animate-pulse"; // Done
  }
  return ACTIVITY_DOT[status];
}
```

**Update `getStatusLabel`:**
```typescript
function getStatusLabel(activityInfo: SessionActivityInfo): string {
  const { status, label, seen } = activityInfo;
  if (label) return label;
  if (status === "idle" && !seen) return "Done";
  return STATUS_FALLBACK[status];
}
```

**PTY: remove dot AND label.** In `SessionRow` rendering:
- Wrap dot `<span>` in condition: only render if `session.execution_mode === "acp"`
- Remove the PTY status text section (lines 159-165 that show "Running" + branch)
- PTY rows show only session name + "Terminal" badge

### 5. Files touched

| File | Change |
|------|--------|
| `src/store/sessionActivityStore.ts` | Add `seen`, `markSeen` |
| `src/components/execution/AgentMonitor.tsx` | Color swap, Done/Ready logic, PTY dot+label removal |
| `src/components/execution/AgentActivityPanel.tsx` | Add mark-seen effect using `hasUnread` |

No changes to: `useAcpScrollBehavior.ts`, `useAcpSessionLifecycle.ts`, backend.

## Edge Cases

- **User at bottom when turn ends**: `hasUnread` stays false → marks seen immediately → "Ready"
- **User scrolled up when turn ends**: `hasUnread` becomes true → stays "Done" until scroll to bottom
- **User on different tab**: `activeTab !== "agents"` blocks marking seen
- **Session resumes after "Done"**: `seen` only checked when `idle`
- **AgentsView always mounted**: tab guard prevents false "seen" when visually hidden

## Verification

1. `pnpm test` — existing + new tests pass
2. `pnpm dev`:
   - Start agent, scroll up in session, let it finish → green pulsing "Done"
   - Scroll to bottom → transitions to grey "Ready"
   - Start agent, stay at bottom → goes straight to "Ready" on completion
   - Start agent, switch to Kanban tab → return → "Done" until scrolled to bottom
   - Verify thinking = purple glow, acting = blue glow
   - Verify PTY sessions show no dot and no status label
