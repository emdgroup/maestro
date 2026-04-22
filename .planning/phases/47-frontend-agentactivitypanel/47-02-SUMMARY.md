---
phase: 47-frontend-agentactivitypanel
plan: "02"
subsystem: frontend-execution
tags: [acp, activity-panel, xterm, react-markdown, framer-motion, tanstack-query]
dependency_graph:
  requires:
    - 47-01 (types.ts, useAcpActivity, activityReducer, useStructuredOutputQuery)
    - execution.service (executionQueryKeys, useStructuredOutputQuery)
    - projectStore (useSelectedProject for projectId)
  provides:
    - ActivityMessageItem (streaming markdown message block)
    - ActivityToolCallCard (collapsible tool call with status badges)
    - ActivityPlanPanel (sticky plan checklist)
    - AcpTerminalPanel (xterm fed by acp://terminal-output Tauri events)
    - AgentActivityPanel (live + dead ACP session view)
    - AgentMonitor ACP routing (execution_mode === "acp" branch)
  affects:
    - src/components/execution/AgentMonitor.tsx (added ACP routing branch)
tech_stack:
  added: []
  patterns:
    - react-markdown with custom component overrides for code/lists/bold
    - animate-pulse blinking cursor for streaming messages
    - Collapsible (base-ui) auto-collapses tool cards on completion/error via useEffect
    - AcpTerminalPanel uses listen() not attachTerminal — key difference from TerminalComponent
    - Tauri Vec<u8> -> JSON number[] -> Uint8Array conversion for xterm write
    - useReducer(activityReducer, INITIAL_ACTIVITY_STATE) for dead session replay (canonical path)
    - load_from_db dispatch replays all DB payloads in one pass through shared reducer
    - queryClient.invalidateQueries on sessionEnded to refresh sidebar execution list
    - framer-motion AnimatePresence + motion.div for terminal bottom panel slide-in
key_files:
  created:
    - src/components/execution/activity/ActivityMessageItem.tsx
    - src/components/execution/activity/ActivityToolCallCard.tsx
    - src/components/execution/activity/ActivityPlanPanel.tsx
    - src/components/execution/activity/AcpTerminalPanel.tsx
    - src/components/execution/AgentActivityPanel.tsx
  modified:
    - src/components/execution/AgentMonitor.tsx
decisions:
  - "useSelectedProject() from projectStore used for projectId instead of non-existent useConnection() interface — plan referenced a hook that does not exist in the codebase"
  - "Dead session replay uses shared activityReducer via useReducer + load_from_db dispatch — single canonical accumulation path for live and dead sessions"
  - "AcpTerminalPanel uses listen() on acp://terminal-output/{logId} not attachTerminal IPC — ACP sessions have no PTY entry in pty_sessions"
  - "Terminal toggle button hidden for dead sessions — no persisted terminal output for completed ACP sessions"
metrics:
  duration: "0.068h"
  completed_date: "2026-04-22"
  tasks_completed: 2
  files_changed: 6
---

# Phase 47 Plan 02: Activity Sub-Components + AgentActivityPanel + AgentMonitor Routing Summary

**One-liner:** Six-file ACP activity panel implementation — streaming markdown messages, collapsible tool call cards, sticky plan checklist, xterm terminal fed by Tauri events, live/dead session orchestrator using shared activityReducer, and ACP routing branch in AgentMonitor.

## Tasks Completed

| Task | Description | Commit |
|------|-------------|--------|
| 1 | Create activity sub-components (MessageItem, ToolCallCard, PlanPanel, AcpTerminalPanel) | 430af20 |
| 2 | Create AgentActivityPanel + wire ACP branch in AgentMonitor | f39a627 |

## What Was Built

### Task 1: Activity Sub-Components

**ActivityMessageItem** — Renders streaming agent prose messages. While `isStreaming: true`, shows raw text with `animate-pulse` blinking cursor block. Once complete, renders through `react-markdown` with custom component overrides for code blocks (language-detected inline vs block), lists, and bold text. Clean Claude.ai-style output with no chat bubbles.

**ActivityToolCallCard** — Collapsible card for tool call events. Open by default while pending/in_progress; auto-collapses on completed or error via `useEffect`. Status badges: Running (default/blue), Done (secondary/gray), Failed (destructive/red), Pending (outline). Tool kind icons from lucide-react. Content blocks render text as preformatted, diffs show path + newText, terminal references show label.

**ActivityPlanPanel** — Sticky plan checklist rendering `PlanEntry[]`. Progress counter (completed/total) in header. Status icons: Circle (pending), Loader2 spinning (in_progress), CheckCircle2 (completed). Priority dots: high=destructive, medium=warning, low=muted. Completed items have line-through text.

**AcpTerminalPanel** — xterm terminal fed by Tauri events. Subscribes to `acp://terminal-output/{logId}` via `listen()`. Tauri serializes `Vec<u8>` as `number[]`; converts with `new Uint8Array(event.payload)` before writing to xterm. `disableStdin: true` — ACP terminal is read-only. ResizeObserver + FitAddon for auto-sizing. No `attachTerminal` call — this is the critical difference from `TerminalComponent`.

### Task 2: AgentActivityPanel + AgentMonitor Routing

**AgentActivityPanel** — Main orchestrating component for ACP sessions with two modes:

- **Live mode** (`isDead === false`): calls `useAcpActivity(execution.id)` for real-time event subscription. Shows spinner + "Starting agent..." while `state.isInitializing`.
- **Dead mode** (`isDead === true`): calls `useStructuredOutputQuery(execution.id)` then replays payloads through `useReducer(activityReducer, INITIAL_ACTIVITY_STATE)` via a `load_from_db` dispatch. Single canonical accumulation path — no inline reimplementation.

Session-end sidebar refresh: `useEffect` watching `state.sessionEnded` calls `queryClient.invalidateQueries({ queryKey: executionQueryKeys.withTaskInfo(projectId) })` so the sidebar execution list updates from "running" to final status.

Terminal toggle: `Button` in header bar; `AnimatePresence + motion.div` slide from 0 to 280px height for VS Code-style bottom panel. Hidden for dead sessions.

**AgentMonitor** — Added `AgentActivityPanel` import and ACP routing branch at the top of the content area conditional:
```
execution_mode === "acp" → AgentActivityPanel (live or dead via isDead prop)
PTY running → TerminalComponent (unchanged)
PTY dead → DeadSessionTerminal (unchanged)
no selection → placeholder (unchanged)
```

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] useConnection() hook does not exist — used useSelectedProject() instead**
- **Found during:** Task 2
- **Issue:** Plan specified `import { useConnection } from "@/contexts/ConnectionContext"` providing `projectId`. The actual `ConnectionContext.tsx` exports `useConnectionContext()` which manages SSH connection state for the ProjectPicker subtree — it has no `projectId` field.
- **Fix:** Used `useSelectedProject()` from `@/store/projectStore` which returns the current `Project | null`. Derived `projectId` as `selectedProject?.id ?? null`. This is the correct app-wide project state source (used throughout App.tsx and views).
- **Files modified:** `src/components/execution/AgentActivityPanel.tsx`
- **Commit:** f39a627

**2. [Rule 1 - Bug] Unused `Wrench` import in ActivityToolCallCard**
- **Found during:** Task 1 build verification
- **Issue:** TypeScript compiler error TS6133: `'Wrench' is declared but its value is never read` — the plan's template included it in the import but the component only uses FileText, Terminal, Search, Box.
- **Fix:** Removed `Wrench` from the lucide-react import.
- **Files modified:** `src/components/execution/activity/ActivityToolCallCard.tsx`
- **Commit:** 430af20

## Known Stubs

None — all components are fully wired. ActivityMessageItem renders real markdown, ActivityToolCallCard renders real tool call content, ActivityPlanPanel renders real plan entries, AcpTerminalPanel writes real terminal bytes, AgentActivityPanel routes to real hooks.

## Threat Surface Scan

No new network endpoints, auth paths, file access patterns, or schema changes introduced. All components are pure frontend rendering — they consume events and query data already established in Plan 01.

## Self-Check: PASSED

- All 5 created files exist on disk
- Task 1 commit 430af20 confirmed in git log
- Task 2 commit f39a627 confirmed in git log
- `pnpm build` passes with no TypeScript errors
