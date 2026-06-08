# Fix: Subagents show "Running" after session interruption

## Context

When user interrupts agent work (Ctrl+C / stop button), subagent cards stay stuck showing "Running" tag + typing dots. Root cause: `turn_ended` and `session_ended` reducer actions call `finalizeLastStreaming()` which only finalizes message/thinking items — never touches in-progress `ToolCallItem` statuses. Subagents with `status: "in_progress"` stay that way forever.

## Approach

Add `"interrupted"` to `ToolCallItem.status` (frontend-only type). On `turn_ended`/`session_ended`, sweep all stalled tool calls to `"interrupted"`. Update SubagentCard + ActivityToolCallGroup to render the new state.

Normal flow unaffected — backend sends `tool_call_update` with `completed` before turn ends, so `interruptStalledToolCalls` finds nothing and returns early.

## Changes

### 1. `src/components/execution/activity/types.ts`

Add `"interrupted"` to `ToolCallItem.status` union (line 137).

### 2. `src/components/execution/activity/useAcpActivity.ts`

Add `interruptStalledToolCalls(state)` helper after `flushOrphans`:
- Iterate `toolCallMap`, collect IDs with status `"in_progress"` or `"pending"`
- Early return if none found
- Clone map, set each to `"interrupted"`, update matching items in `items` array

Call in both `session_ended` and `turn_ended` cases, between `flushOrphans` and `finalizeLastStreaming`:
```
flushOrphans → interruptStalledToolCalls → finalizeLastStreaming
```

### 3. `src/components/execution/activity/SubagentCard.tsx`

- Add `isInterrupted = item.status === "interrupted"` (after line 134)
- Status badge: add `isInterrupted && "bg-warning/15 text-warning"` styling, show "Interrupted" text
- Subtitle area: show `<span className="text-warning/70">Session interrupted</span>` instead of TypingDots or null
- Child tool calls (`SubagentToolCallList`): add interrupted label after error label (line 97)

### 4. `src/components/execution/activity/ActivityToolCallGroup.tsx`

- `groupStatus()`: add `interrupted` check after `in_progress`
- `allDone`: include `"interrupted"` as terminal state so groups auto-collapse
- `statusText`: add `"Interrupted"` case
- Status color: add `text-warning` for interrupted

## Verification

1. `pnpm build` — type check passes (exhaustive status handling)
2. Start session, trigger subagent, interrupt mid-execution — subagent shows "Interrupted" tag, no typing dots
3. Normal session completion — subagents show "Done" as before
4. Expanded subagent with child tool calls — children also show "Interrupted" if stalled
