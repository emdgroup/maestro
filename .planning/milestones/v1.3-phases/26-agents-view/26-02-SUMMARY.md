---
phase: 26-agents-view
plan: "02"
subsystem: ui
tags: [react, xterm, agents-view, terminal, execution-monitoring]

# Dependency graph
requires:
  - phase: 26-agents-view-01
    provides: AgentsView with TanStack Query + AgentMonitor props interface + ExecutionWithTask type
provides:
  - AgentMonitor with real sidebar (three-line rows, filter toolbar, left-border selection)
  - DeadSessionTerminal for completed/failed execution history playback
  - Terminal routing (TerminalComponent for running, DeadSessionTerminal for non-running)
affects: [agents-view, execution-monitoring, terminal-components]

# Tech tracking
tech-stack:
  added: [date-fns formatDistanceStrict, xterm disableStdin mode]
  patterns: [pure-display component pattern, xterm write-only terminal, sidebar filter toolbar]

key-files:
  created:
    - src/components/execution/DeadSessionTerminal.tsx
  modified:
    - src/components/execution/AgentMonitor.tsx

key-decisions:
  - "AgentMonitor is a pure display component — all data comes via props from AgentsView (no IPC inside)"
  - "Left-border accent (border-l-2 + border-ring) for selected row instead of background fill (Linear-style)"
  - "w-72 sidebar with three-line rows: status dot, status label + elapsed, branch in font-mono"
  - "DeadSessionTerminal uses disableStdin:true and never calls attachTerminal/detachTerminal"
  - "useEffect in DeadSessionTerminal depends on execution.id for correct remount on selection change"

patterns-established:
  - "Sidebar filter toolbar: Input + ToggleGroup chips inside h-12 border-b bg-muted/30 row"
  - "Terminal routing: running -> TerminalComponent keyed by task_id; non-running -> DeadSessionTerminal keyed by id"
  - "Dead terminal: write terminal_output once on mount, ResizeObserver for fit, no PTY calls"

requirements-completed: [REQ-17, REQ-18, REQ-19, REQ-20, REQ-21]

# Metrics
duration: 2min
completed: 2026-03-29
---

# Phase 26 Plan 02: Agents View — Sidebar + Terminal Routing Summary

**AgentMonitor rewritten with real filter sidebar (three-line rows, ToggleGroup chips, left-border selection) and terminal routing; DeadSessionTerminal created for xterm.js write-only history playback of completed/failed executions**

## Performance

- **Duration:** ~2 min
- **Started:** 2026-03-29T22:19:30Z
- **Completed:** 2026-03-29T22:21:05Z
- **Tasks:** 2
- **Files modified:** 2 (1 rewrite + 1 new)

## Accomplishments

- Rewrote AgentMonitor.tsx as a pure display component with real sidebar: three-line rows (status dot, status+elapsed, branch), ToggleGroup filter chips (All/Running/Done/Failed), search input, left-border accent selection pattern
- Created DeadSessionTerminal.tsx: write-only xterm.js terminal for completed/failed executions, SessionEndedBanner with timestamp and duration, no PTY attach/detach
- Terminal routing correctly switches between live TerminalComponent (keyed by task_id) and DeadSessionTerminal (keyed by execution.id) based on status

## Task Commits

Each task was committed atomically:

1. **Task 1: Rewrite AgentMonitor with real sidebar and terminal routing** - `8de15fc` (feat)
2. **Task 2: Create DeadSessionTerminal component** - `f35706d` (feat)

## Files Created/Modified

- `src/components/execution/AgentMonitor.tsx` - Complete rewrite: real sidebar with filter toolbar and three-line rows, terminal routing for running/completed executions
- `src/components/execution/DeadSessionTerminal.tsx` - New: xterm.js write-only terminal showing DB-stored output with session ended banner

## Decisions Made

- Build-only verification (no unit tests): xterm.js DOM requirements make unit testing impractical without heavy mocking — behavioral verification is manual via Tauri app
- ToggleGroup `pressed` prop used for controlled state instead of `value` to match existing KanbanView pattern

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Phase 26 fully complete (both plans done)
- AgentsView has real data via TanStack Query (Plan 01) + real UI with terminal routing (Plan 02)
- REQ-17 through REQ-21 all implemented: sidebar list, sort, filter, live terminal, dead session history
- Ready for Phase 27 (Worktrees view) or production validation

---
*Phase: 26-agents-view*
*Completed: 2026-03-29*

## Self-Check: PASSED

- [x] `src/components/execution/AgentMonitor.tsx` exists and contains all required patterns
- [x] `src/components/execution/DeadSessionTerminal.tsx` exists with export function
- [x] Commit `8de15fc` exists (Task 1)
- [x] Commit `f35706d` exists (Task 2)
- [x] `pnpm build` completed with 0 TypeScript errors
