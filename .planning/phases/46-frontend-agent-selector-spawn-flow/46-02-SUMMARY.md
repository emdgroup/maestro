---
phase: 46-frontend-agent-selector-spawn-flow
plan: "02"
subsystem: ui
tags: [react, tauri, execution, acp, badge, agentsview, agentmonitor]

requires:
  - phase: 46-01
    provides: AgentSelectorDialog component with AgentSelectorDialogProps interface

provides:
  - AgentsView with dedicated "Spawn Agent" button in action bar that opens AgentSelectorDialog
  - AgentMonitor sidebar with session-type badge ("ACP" vs "Interactive") based on execution_mode
  - AgentMonitor unit tests for SPAWN-03 badge behavior (3 test cases)

affects:
  - Phase 47 (activity panel) — AgentMonitor sidebar is the entry point for selecting sessions
  - Phase 48 (permission dialog) — ACP sessions distinguished visually via badge

tech-stack:
  added: []
  patterns:
    - "Session-type badge: execution_mode === 'acp' ? 'ACP' : 'Interactive' — null-safe fallback"
    - "Dual-dialog pattern: PTY dialog (showSpawnDialog) and ACP dialog (showAgentSelector) coexist independently"

key-files:
  created:
    - src/components/execution/__tests__/AgentMonitor.test.tsx
  modified:
    - src/views/AgentsView.tsx
    - src/components/execution/AgentMonitor.tsx

key-decisions:
  - "Spawn Agent button placed in right group of action bar (justify-between layout); existing search+filter controls stay in left group"
  - "Badge always renders for all sessions (not gated on !task_name) — every session gets a type label"
  - "PTY dialog renamed to 'New Terminal Session' to differentiate from 'Spawn ACP Agent' dialog"

patterns-established:
  - "AgentSelectorDialog integration: import + showAgentSelector state + onSpawned callback that calls setSelectedExecutionId"

requirements-completed:
  - SPAWN-01
  - SPAWN-02
  - SPAWN-03

duration: 3min
completed: "2026-04-21"
---

# Phase 46 Plan 02: Frontend Agent Selector + Spawn Flow (Wiring) Summary

**AgentsView gets a "Spawn Agent" button opening AgentSelectorDialog; AgentMonitor sidebar shows "ACP"/"Interactive" badges based on execution_mode**

## Performance

- **Duration:** 3 min
- **Started:** 2026-04-21T14:19:40Z
- **Completed:** 2026-04-21T14:22:38Z
- **Tasks:** 3
- **Files modified:** 3

## Accomplishments

- "Spawn Agent" button added to AgentsView action bar (right group) with Bot icon — opens AgentSelectorDialog from Plan 01
- AgentSelectorDialog wired with onSpawned callback that auto-selects the newly spawned session
- PTY spawn dialog renamed to "New Terminal Session" to clearly differentiate from ACP agent selector
- AgentMonitor sidebar now shows "ACP" badge for ACP sessions and "Interactive" badge for PTY/null sessions using Badge outline variant
- 3 SPAWN-03 unit tests written and passing: ACP badge, Interactive badge for pty, Interactive badge for null

## Task Commits

1. **Task 0: Create AgentMonitor test stub (Wave 0)** — `f992841` (test)
2. **Task 1: Wire AgentSelectorDialog into AgentsView** — `1538988` (feat)
3. **Task 2: Add session-type badge to AgentMonitor** — `f32bdf7` (feat)

## Files Created/Modified

- `src/components/execution/__tests__/AgentMonitor.test.tsx` — 3 unit tests for SPAWN-03 badge behavior
- `src/views/AgentsView.tsx` — Spawn Agent button, showAgentSelector state, AgentSelectorDialog, PTY dialog rename
- `src/components/execution/AgentMonitor.tsx` — Badge import + session-type badge replacing conditional Interactive span

## Decisions Made

- Badge always renders (not gated on `!execution.task_name`) — every session in the list has a visible type label, providing consistent visual hierarchy
- PTY dialog title changed from "Spawn Interactive Agent" to "New Terminal Session" — reduces confusion with the new "Spawn ACP Agent" dialog title in AgentSelectorDialog
- `null` execution_mode falls through to "Interactive" via `=== "acp"` check — backward compatible with pre-v11 session rows

## Deviations from Plan

None — plan executed exactly as written.

## Issues Encountered

Pre-existing `ProjectPicker.test.tsx` failures (13 tests, `No QueryClient set` error) exist before and after this plan's changes — confirmed by `git stash` verification. Out of scope for this plan.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- Phase 46 complete: full user flow from "Spawn Agent" button through ACP session creation to auto-selection in sidebar
- Phases 47 (activity panel) and 48 (permission dialog) can now begin — both depend on the session selection infrastructure established here
- AgentMonitor badge distinguishes session types visually, enabling Phase 47 to render ACP-specific activity panel when an ACP session is selected

---
*Phase: 46-frontend-agent-selector-spawn-flow*
*Completed: 2026-04-21*
