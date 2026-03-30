---
phase: quick
plan: 260330-khs
subsystem: frontend/agents-view
tags: [ui, agents, spawn, sidebar]
dependency_graph:
  requires: []
  provides: [new-session-button-in-sidebar]
  affects: [AgentsView, AgentMonitor]
tech_stack:
  added: []
  patterns: [WorktreeManager sidebar button pattern]
key_files:
  created: []
  modified:
    - src/views/AgentsView.tsx
    - src/components/execution/AgentMonitor.tsx
decisions:
  - onSpawn prop is optional on AgentMonitor so the component remains usable without the button
metrics:
  duration: 0.01h
  completed: "2026-03-30"
  tasks_completed: 1
  files_modified: 2
---

# Quick Task 260330-khs: Move Spawn Button to Sidebar Summary

**One-liner:** Moved "Spawn Agent" button from action bar into AgentMonitor sidebar as "New Session", matching the WorktreeManager "New Worktree" pattern.

## What Was Done

- Added `onSpawn?: () => void` to `AgentMonitorProps`
- Added `Button` and `Plus` imports to `AgentMonitor.tsx`
- Added "New Session" button row above the scrollable execution list (only renders when `onSpawn` prop is provided)
- Removed "Spawn Agent" `Button` from `AgentsView` action bar
- Removed `Play` import from `AgentsView` (no longer used)
- Passed `onSpawn` callback from `AgentsView` to `AgentMonitor` that opens the spawn dialog

## Verification

- Build: `pnpm build` — succeeded with 0 TypeScript errors
- Grep: No "Spawn Agent" button text in source (only code comments remain)
- "New Session" text confirmed in `AgentMonitor.tsx` line 78

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

None.

## Self-Check: PASSED

- `src/views/AgentsView.tsx` — modified, staged and committed
- `src/components/execution/AgentMonitor.tsx` — modified, staged and committed
- Commit `2445a8b` exists in git log
