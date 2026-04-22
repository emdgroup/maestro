---
phase: 47-frontend-agentactivitypanel
plan: "01"
subsystem: frontend-activity-data-layer
tags: [acp, activity-panel, hooks, typescript, rust-ipc]
dependency_graph:
  requires: [46-frontend-agent-selector-spawn-flow]
  provides: [activity-types, useAcpActivity, useStructuredOutputQuery, get_structured_output-ipc, activityReducer]
  affects: [47-02-PLAN]
tech_stack:
  added: [react-markdown@10.1.0]
  patterns: [discriminated-union-types, useReducer-accumulation, tanstack-query-dead-session, tauri-event-listen-cleanup]
key_files:
  created:
    - src/components/execution/activity/types.ts
    - src/components/execution/activity/useAcpActivity.ts
  modified:
    - src-tauri/src/ipc/acp_handlers.rs
    - src-tauri/src/lib.rs
    - src/types/bindings.ts
    - src/services/execution.service.ts
    - package.json
decisions:
  - "SessionUpdate types defined frontend-only (not Rust-generated): backend emits serde_json::Value; TS types narrow at consume site"
  - "activityReducer exported from useAcpActivity.ts as single canonical accumulation path for both live and dead sessions (Plan 02 uses useReducer + load_from_db dispatch)"
  - "Unknown sessionUpdate variants silently ignored via default: return newState in processEvent — T-47-02 threat mitigation"
  - "useStructuredOutputQuery uses staleTime: Infinity — dead sessions are immutable once completed"
metrics:
  duration: "0.060h"
  completed: "2026-04-22"
  tasks_completed: 2
  files_modified: 7
---

# Phase 47 Plan 01: ACP Activity Data Layer Summary

**One-liner:** get_structured_output Rust IPC + discriminated union SessionUpdate types + useAcpActivity live event hook + useStructuredOutputQuery dead session hook, with exported activityReducer for Plan 02 replay.

## What Was Built

### Task 1: get_structured_output IPC + bindings regen + react-markdown

- Added `get_structured_output` async Rust command to `acp_handlers.rs` — queries `structured_output` column from `execution_logs` by `log_id`, returns `Vec<serde_json::Value>` (empty array for NULL rows)
- Registered in `lib.rs` `collect_commands!` after `check_remote_agents`
- Ran `pnpm tauri:gen` — `getStructuredOutput` now present in `bindings.ts`
- Installed `react-markdown@10.1.0` for Plan 02 markdown rendering in agent messages

### Task 2: Activity types + useStructuredOutputQuery + useAcpActivity

- Created `src/components/execution/activity/types.ts` with full discriminated union on `sessionUpdate` field:
  - `AgentMessageChunk` — streaming text chunks
  - `ToolCallCreated` — new tool call with `toolCallId`, `title`, `kind`
  - `ToolCallUpdate` — status/content updates for existing tool calls
  - `PlanUpdate` — plan entries array with priority/status
  - `ActivityState` — accumulated rendering state with `items`, `toolCallMap`, `plan`, `isInitializing`, `sessionEnded`
  - `INITIAL_ACTIVITY_STATE` constant

- Added `structuredOutput` query key + `useStructuredOutputQuery(logId: number | null)` to `execution.service.ts` (`staleTime: Infinity` since dead sessions are immutable)

- Created `src/components/execution/activity/useAcpActivity.ts`:
  - `activityReducer` — handles `event`, `session_ended`, `load_from_db` actions; `processEvent` accumulates message chunks into streaming turns, manages `toolCallMap`, finalizes streaming messages on tool call events
  - `ActivityAction` discriminated union — exported for Plan 02
  - `useAcpActivity(logId)` — subscribes to `acp://session-update/{logId}` and `acp://session-ended/{logId}` Tauri events, follows exact cleanup pattern from `useConnectionHealth.ts` (`unlisteners.then(...)`)

## Decisions Made

1. **Frontend-only types**: `SessionUpdate` types not generated from Rust — backend emits `serde_json::Value` which TS cannot auto-generate into discriminated unions. Types defined in `activity/types.ts` and narrowed at hook boundary.

2. **Exported activityReducer**: Plan 02's `AgentActivityPanel` imports `activityReducer` and uses `useReducer(activityReducer, INITIAL_ACTIVITY_STATE)`, dispatching `{ type: "load_from_db", payloads }` for dead session replay. Single canonical accumulation path — no duplicate logic.

3. **T-47-02 mitigation**: `processEvent` has `default: return newState` — unknown `sessionUpdate` variants are silently ignored, no throws that could crash the component.

4. **staleTime: Infinity**: Dead sessions are immutable — `structured_output` column never changes after session ends. No refetching needed.

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

None — no stub values, placeholder text, or unconnected data sources in the created files. Hooks are ready for component consumption by Plan 02.

## Threat Flags

None — no new network endpoints or auth paths introduced beyond what the plan's threat model covers.

## Self-Check: PASSED

All created files exist on disk. Both task commits (c915c2a, d56f8ca) verified in git log.
