---
phase: 30-v1-3-post-testing-ui-and-worktree-bug-fixes
plan: "03"
subsystem: frontend-ui
tags: [agents-view, worktrees-view, spawn-agent, branch-dropdown, interactive-sessions]
dependency_graph:
  requires: ["30-02"]
  provides: ["spawn-agent-ui", "worktree-create-dialog-redesign"]
  affects: ["src/views/AgentsView.tsx", "src/components/execution/WorktreeManager.tsx", "src/components/execution/AgentMonitor.tsx", "src/App.tsx"]
tech_stack:
  added: []
  patterns: ["branch-select-dropdown", "spawn-interactive-dialog", "inline-error-display"]
key_files:
  created: []
  modified:
    - src/components/execution/WorktreeManager.tsx
    - src/views/AgentsView.tsx
    - src/components/execution/AgentMonitor.tsx
    - src/App.tsx
decisions:
  - "Select onValueChange null-coalesce: (v) => setState(v ?? '') because base-ui Select passes string | null"
  - "Interactive badge shown alongside branch name (not replacing it) so taskless entries still display branch context"
metrics:
  duration: "0.061h"
  completed_date: "2026-03-30"
  tasks_completed: 2
  files_modified: 4
---

# Phase 30 Plan 03: Frontend UI — Spawn Agent Dialog and Worktree Create Redesign

One-liner: Origin branch dropdown for worktree creation (via useProjectBranchesQuery), Spawn Agent button + dialog in AgentsView action bar, repoPath wired through App.tsx, and "Interactive" badge for taskless agent list entries.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Redesign WorktreeManager create dialog | 739e4a8 | src/components/execution/WorktreeManager.tsx |
| 2 | Wire App.tsx repoPath, Spawn Agent button/dialog, AgentMonitor taskless entries | f0af5ef | src/App.tsx, src/views/AgentsView.tsx, src/components/execution/AgentMonitor.tsx |

## What Was Built

### Task 1: WorktreeManager Create Dialog Redesign

Replaced the single branch name `Input` with a two-field form:
- **Origin branch** — `Select` dropdown populated from `useProjectBranchesQuery`, initialized to `currentBranch` when dialog opens
- **New branch name** (optional) — `Input` text field; blank means check out origin directly
- Inline error display via `createError` state + `text-destructive` paragraph
- Dialog open handler now resets all three fields and sets `originBranch` to `currentBranch`
- Create button disabled when `originBranch` is empty (required) or mutation is pending
- Worktree path input completely removed (backend auto-derives path)

### Task 2: AgentsView Spawn Agent + App.tsx Wiring

**App.tsx:** Added `repoPath={currentProject.path}` to the `AgentsView` element.

**AgentsView:**
- Added `repoPath?: string` to `AgentsViewProps` and component destructuring
- Added imports: `useSpawnInteractiveExecutionMutation`, `useProjectBranchesQuery`, `Button`, `Dialog`, `Label`, `Select`, `Play`
- Spawn Agent button in action bar right slot; opens dialog initialized to `currentBranch`
- Spawn Agent dialog: branch `Select` dropdown + optional label `Input`
- `onSuccess(logId)` calls `setSelectedExecutionId(logId)` to auto-select the new session

**AgentMonitor:**
- Line 1 of agent list entry now shows `execution.task_name ?? execution.branch_name ?? "Interactive session"`
- "Interactive" badge (muted background) rendered when `task_name` is null

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Select onValueChange type mismatch**
- **Found during:** Task 1 build verification
- **Issue:** base-ui `Select.onValueChange` passes `string | null` but `setOriginBranch` accepts `string` (from `useState<string>`)
- **Fix:** Changed `onValueChange={setOriginBranch}` to `onValueChange={(v) => setOriginBranch(v ?? "")}` in both WorktreeManager and AgentsView
- **Files modified:** src/components/execution/WorktreeManager.tsx, src/views/AgentsView.tsx
- **Commit:** 739e4a8 (WorktreeManager), f0af5ef (AgentsView)

**2. [Rule 1 - Bug] Duplicate Input import in AgentsView**
- **Found during:** Task 2 implementation
- **Issue:** Accidentally imported `Input` twice (once for search bar, once as `InputAlias` for spawn label)
- **Fix:** Removed the alias import; reused the existing `Input` import
- **Files modified:** src/views/AgentsView.tsx
- **Commit:** f0af5ef

## Known Stubs

None — all data sources are wired. `useProjectBranchesQuery` provides real branch data; `useSpawnInteractiveExecutionMutation` calls the real IPC command.

## Verification

- `pnpm build` passes with 0 TypeScript errors (verified after each task)
- App.tsx contains `repoPath={currentProject.path}` on AgentsView
- WorktreeManager create dialog has Select dropdown for origin branch
- AgentsView action bar has "Spawn Agent" button
- AgentMonitor shows branch name for taskless executions with "Interactive" badge
- After spawning, new session is auto-selected via `setSelectedExecutionId(logId)`

## Self-Check: PASSED

Files exist:
- src/components/execution/WorktreeManager.tsx: FOUND (modified)
- src/views/AgentsView.tsx: FOUND (modified)
- src/components/execution/AgentMonitor.tsx: FOUND (modified)
- src/App.tsx: FOUND (modified)

Commits verified:
- 739e4a8: feat(30-03): redesign WorktreeManager create dialog
- f0af5ef: feat(30-03): add Spawn Agent dialog to AgentsView
