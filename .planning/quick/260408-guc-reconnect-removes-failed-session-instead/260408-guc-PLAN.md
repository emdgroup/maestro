---
phase: quick-260408-guc
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - src/views/AgentsView.tsx
autonomous: true
requirements: []
must_haves:
  truths:
    - "Clicking Reconnect on a failed session removes the old failed session and creates a new one"
    - "After reconnect, only the new running session appears in the sidebar (no duplicate)"
    - "The new session is auto-selected after spawn"
  artifacts:
    - path: "src/views/AgentsView.tsx"
      provides: "onReconnect handler that deletes old session then spawns new one"
  key_links:
    - from: "src/views/AgentsView.tsx onReconnect"
      to: "deleteMutation + spawnMutation"
      via: "delete old execution in onSuccess of spawn"
      pattern: "deleteMutation\\.mutate.*onSuccess.*spawnMutation"
---

<objective>
Fix the reconnect flow in AgentsView so that the old failed session is automatically removed
when a new session is spawned via the Reconnect button, eliminating duplicate sessions.

Purpose: Currently, clicking Reconnect on a failed agent session creates a new session but
leaves the old failed one in the list, resulting in duplicates. The old session should be
cleaned up automatically.

Output: Updated AgentsView.tsx with reconnect handler that deletes the old failed session
after successfully spawning the replacement.
</objective>

<execution_context>
@/home/m306213/workspace/maestro/.claude/get-shit-done/workflows/execute-plan.md
@/home/m306213/workspace/maestro/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@src/views/AgentsView.tsx
@src/services/execution.service.ts
</context>

<tasks>

<task type="auto">
  <name>Task 1: Delete old failed session on successful reconnect</name>
  <files>src/views/AgentsView.tsx</files>
  <action>
In AgentsView.tsx, modify the `onReconnect` callback (lines 121-137) to delete the old
failed execution after the new session spawns successfully.

Current code spawns a new session and selects it in `onSuccess`, but never removes the
old failed session referenced by `execution.id`.

Change the `onSuccess` callback of `spawnMutation.mutate` inside `onReconnect` to:
1. Set the selected execution to the new `logId` (existing behavior).
2. Call `deleteMutation.mutate({ executionId: execution.id })` to remove the old failed
   session from the database and sidebar list.

The delete should happen inside `onSuccess` so the old session is only removed after the
new one is confirmed to exist. The `deleteMutation` is already imported and instantiated
at line 54 (`const deleteMutation = useDeleteExecutionMutation()`).

Do NOT add any toast for the delete — the spawn already succeeds silently and the
delete mutation's built-in toast ("Session deleted") should be suppressed for this
automatic cleanup. Override onSuccess on the deleteMutation.mutate call to suppress
the toast by passing an empty onSuccess callback, or alternatively, call
`api.deleteExecutionLog(execution.id)` directly (fire-and-forget) to skip the toast
entirely. The direct API call is cleaner — use `void api.deleteExecutionLog(execution.id)`
as a fire-and-forget cleanup after setting the selected execution.
  </action>
  <verify>
    <automated>cd /home/m306213/workspace/maestro && pnpm build</automated>
  </verify>
  <done>
Reconnect handler deletes the old failed session after successfully spawning the new one.
Build passes with zero TypeScript errors. The old failed session no longer remains in the
sidebar after reconnecting.
  </done>
</task>

</tasks>

<verification>
- `pnpm build` passes with 0 errors
- In the onReconnect handler, the old execution.id is cleaned up via api.deleteExecutionLog
  after the new session spawns successfully
- No duplicate sessions remain after reconnecting
</verification>

<success_criteria>
- Reconnect spawns a new session AND removes the old failed session
- No TypeScript errors
- Production build succeeds
</success_criteria>

<output>
After completion, create `.planning/quick/260408-guc-reconnect-removes-failed-session-instead/260408-guc-SUMMARY.md`
</output>
