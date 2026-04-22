---
status: complete
phase: 46-frontend-agent-selector-spawn-flow
source: 46-01-SUMMARY.md, 46-02-SUMMARY.md
started: 2026-04-21T14:30:00Z
updated: 2026-04-22T00:00:00Z
---

## Current Test

[testing complete]

## Tests

### 1. Spawn Agent Button in AgentsView
expected: AgentsView action bar has a "Spawn Agent" button with a bot icon on the right side. Existing search/filter controls remain on the left. Button is visible and clickable.
result: pass

### 2. AgentSelectorDialog Opens with Loading State
expected: Clicking "Spawn Agent" opens a dialog. While the agent registry is loading, a loading/empty state is shown inside the command list (e.g., spinner or "Loading agents..." text). Dialog has a search input.
result: pass

### 3. Agent Fuzzy Search
expected: Once agents are loaded, typing in the search input filters the agent list in real time. Partial matches work (e.g., typing "code" shows agents with "code" in name/description).
result: pass

### 4. Two-Step Reveal After Agent Selection
expected: Before selecting an agent, only the search/agent list is shown. After clicking an agent (it gets a checkmark), a second section appears below showing: selected agent badge, a worktree dropdown, and an optional session name input.
result: pass

### 5. Spawn Button Gating
expected: The "Spawn Agent" (or "Spawn"/"Spawning...") button in the dialog is disabled when no agent is selected or no worktree is selected. It becomes enabled only when both are chosen.
result: pass

### 6. Session Spawn and Auto-Select
expected: With agent and worktree selected, clicking Spawn triggers the mutation. Button shows "Spawning..." during the call. On success, dialog closes and the newly spawned session is auto-selected in the AgentMonitor sidebar.
result: pass

### 7. Session-Type Badges in Sidebar
expected: AgentMonitor sidebar shows a badge next to each session. ACP sessions show "ACP" badge. PTY/interactive sessions show "Interactive" badge. Null execution_mode also shows "Interactive".
result: pass

### 8. PTY Dialog Renamed
expected: The existing PTY spawn dialog (non-ACP) now has the title "New Terminal Session" (not "Spawn Interactive Agent" or similar). The two dialogs are clearly differentiated.
result: pass

## Summary

total: 8
passed: 8
issues: 0
pending: 0
skipped: 0

## Gaps

[none]
