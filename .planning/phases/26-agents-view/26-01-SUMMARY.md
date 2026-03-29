---
phase: 26-agents-view
plan: 01
subsystem: ui
tags: [react, tanstack-query, xterm, zustand, typescript]

# Dependency graph
requires:
  - phase: 25-backend-overhaul
    provides: list_executions_with_task_info IPC command and ExecutionWithTask type
provides:
  - useExecutionsWithTaskInfoQuery hook with 2s polling in execution.service.ts
  - AgentsView as data owner passing executions/selectedTaskId/onSelect to AgentMonitor
  - REQ-22 compliant TerminalComponent cleanup (detach + ResizeObserver + dispose)
  - Updated AgentMonitor interface accepting ExecutionWithTask[] props
affects:
  - 26-02 (AgentMonitor rewrite depends on execution data from AgentsView props)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "View owns data query (TanStack Query in view, passes props down to display components)"
    - "Deep-link via pending ID pattern: useEffect compares String(e.task_id) === pendingAgentId then clears"
    - "Cleanup triple: resizeObserver.disconnect() → api.detachTerminal().catch(() => {}) → terminal.dispose()"

key-files:
  created: []
  modified:
    - src/services/execution.service.ts
    - src/views/AgentsView.tsx
    - src/components/execution/AgentMonitor.tsx
    - src/components/execution/Terminal.tsx
    - src/App.tsx

key-decisions:
  - "AgentsView owns TanStack Query call; AgentMonitor is a pure display component receiving props"
  - "AgentMonitor interface updated to accept ExecutionWithTask[] props now; Plan 02 will complete the full UI rewrite"
  - "detachTerminal .catch(() => {}) suppresses errors when PTY already ended on task completion"
  - "ResizeObserver added for auto-resize when pane dimensions change (not just initial fit)"

patterns-established:
  - "View-owns-data pattern: AgentsView calls useExecutionsWithTaskInfoQuery, passes executions down"
  - "Deep-link resolution via pendingAgentId in useEffect with String cast for type-safe comparison"

requirements-completed: [REQ-16, REQ-22, REQ-23, REQ-24]

# Metrics
duration: 2min
completed: 2026-03-29
---

# Phase 26 Plan 01: Agents View Data Layer Summary

**TanStack Query execution polling hook (2s), AgentsView data-ownership rewrite, and REQ-22 compliant TerminalComponent cleanup with ResizeObserver and explicit PTY detach**

## Performance

- **Duration:** 2 min (0.031h)
- **Started:** 2026-03-29T22:14:55Z
- **Completed:** 2026-03-29T22:16:48Z
- **Tasks:** 2
- **Files modified:** 5

## Accomplishments

- Added `useExecutionsWithTaskInfoQuery(projectId)` to execution.service.ts with `refetchInterval: 2000` polling
- Exported `executionQueryKeys` and extended with `withTaskInfo(projectId)` key for Plan 02 cache invalidation
- Rewrote AgentsView from prop-receiving passive component to data-owning view with TanStack Query, `selectedTaskId` state, and deep-link logic via `pendingAgentId`
- Updated AgentMonitor interface to accept `ExecutionWithTask[]` props (bridge for Plan 02 full rewrite)
- Fixed TerminalComponent cleanup to call `resizeObserver.disconnect()`, `api.detachTerminal(taskId).catch(() => {})`, and `terminal.dispose()` in that order per REQ-22

## Task Commits

1. **Task 1: Add useExecutionsWithTaskInfoQuery hook and rewrite AgentsView** - `ac97d1b` (feat)
2. **Task 2: Fix TerminalComponent cleanup for REQ-22 compliance** - `92bcaf1` (fix)

## Files Created/Modified

- `src/services/execution.service.ts` - Added `useQuery` import, exported `executionQueryKeys` with `withTaskInfo` key, added `useExecutionsWithTaskInfoQuery` hook
- `src/views/AgentsView.tsx` - Rewritten as data owner: owns execution query, manages `selectedTaskId`, implements deep-link via `pendingAgentId`
- `src/components/execution/AgentMonitor.tsx` - Interface updated from `agents/activeAgentId/onAgentSelect` to `executions/selectedTaskId/onSelect` (adapts to Plan 02 props shape)
- `src/components/execution/Terminal.tsx` - REQ-22 compliant cleanup: ResizeObserver, detachTerminal, dispose in correct order
- `src/App.tsx` - Removed `agents={[]}` and `activeAgentId={null}` props from AgentsView call site

## Decisions Made

- AgentMonitor interface updated immediately (Rule 3 fix) so Plan 01 build passes with new AgentsView props; Plan 02 will complete the full AgentMonitor UI rewrite with actual data rendering
- `executionQueryKeys` exported (changed from `const` to `export const`) so Plan 02 can use it for targeted cache invalidation

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Updated AgentMonitor props interface to match new AgentsView pass-through**

- **Found during:** Task 1 (Add useExecutionsWithTaskInfoQuery hook and rewrite AgentsView)
- **Issue:** AgentsView now passes `executions`, `selectedTaskId`, `onSelect` props but AgentMonitor expected `agents`, `activeAgentId`, `onAgentSelect` — TypeScript would fail to compile
- **Fix:** Updated AgentMonitor's `AgentMonitorProps` interface to accept the new shape; added local adapter variables to preserve the existing stub UI rendering during the Plan 01/02 transition
- **Files modified:** `src/components/execution/AgentMonitor.tsx`
- **Verification:** `pnpm build` passes with 0 TypeScript errors
- **Committed in:** `ac97d1b` (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (Rule 3 - blocking compile issue)
**Impact on plan:** Necessary bridge for two-plan execution. Plan 02 will complete the AgentMonitor rewrite. No scope creep.

## Issues Encountered

None - plan executed as specified with one blocking compile fix applied automatically.

## Known Stubs

- `src/components/execution/AgentMonitor.tsx` — adapter variables map `ExecutionWithTask[]` to old `AgentStatus[]` shape for stub UI rendering. Plan 02 will replace all stub UI with real xterm.js terminal panels.

## Next Phase Readiness

- Plan 02 (AgentMonitor rewrite) can import `useExecutionsWithTaskInfoQuery` from `execution.service.ts` and `ExecutionWithTask` from `types/bindings.ts`
- `executionQueryKeys.withTaskInfo` is exported for cache invalidation if needed
- AgentMonitor interface is already accepting the correct props shape
- TerminalComponent is REQ-22 compliant and ready to use in the new AgentMonitor layout

---
*Phase: 26-agents-view*
*Completed: 2026-03-29*
