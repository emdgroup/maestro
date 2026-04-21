---
phase: 46-frontend-agent-selector-spawn-flow
plan: "01"
subsystem: frontend
tags: [react, tanstack-query, cmdk, ui, acp, agent-selector]
dependency_graph:
  requires:
    - "45-agent-registry-fetch-caching (api.fetchAgentRegistry, api.spawnAcpSession IPC commands)"
  provides:
    - "useAgentRegistryQuery hook for gated ACP registry fetching"
    - "useSpawnAcpSessionMutation hook for ACP session spawn"
    - "AgentSelectorDialog component for agent browsing and spawn"
  affects:
    - "src/services/execution.service.ts"
    - "src/components/execution/AgentSelectorDialog.tsx"
tech_stack:
  added:
    - "@testing-library/user-event 14.6.1 (dev)"
  patterns:
    - "TanStack Query useQuery with enabled flag for dialog-gated CDN fetch"
    - "TanStack Query useMutation with query invalidation on success"
    - "cmdk Command with shouldFilter=true for built-in fuzzy agent search"
    - "Two-step reveal: agent search always visible, worktree form revealed after agent selection"
key_files:
  created:
    - "src/components/execution/AgentSelectorDialog.tsx"
    - "src/components/execution/__tests__/AgentSelectorDialog.test.tsx"
  modified:
    - "src/services/execution.service.ts"
    - "package.json (added @testing-library/user-event)"
decisions:
  - "useAgentRegistryQuery gates fetch on enabled=open to avoid CDN calls on every AgentsView mount"
  - "5-minute staleTime mirrors backend registry TTL to prevent redundant IPC calls within cache window"
  - "cwd uses selectedWorktree.path (absolute path string) not worktree.id — spawn_acp_session takes cwd: string"
  - "data-checked attribute on CommandItem enables check icon from command.tsx CSS selector data-[checked=true]"
  - "Worktree select auto-defaults to worktrees[0] on open and resets on each dialog open"
metrics:
  duration: "0.067h"
  completed_date: "2026-04-21"
  tasks_completed: 3
  files_changed: 4
---

# Phase 46 Plan 01: Agent Selector Data Layer and Dialog Summary

One-liner: TanStack Query hooks for ACP registry fetch (5-min staleTime, enabled-gated) and session spawn mutation, plus cmdk-based AgentSelectorDialog with two-step reveal and 4-test unit suite.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 0 | Create AgentSelectorDialog test stub (Wave 0) | 2476027 | src/components/execution/__tests__/AgentSelectorDialog.test.tsx |
| 1 | Add registry query and ACP spawn mutation hooks | 8e44de8 | src/services/execution.service.ts, package.json, pnpm-lock.yaml |
| 2 | Create AgentSelectorDialog component | 2c68c1a | src/components/execution/AgentSelectorDialog.tsx |

## What Was Built

**Service hooks (execution.service.ts):**
- `registryQueryKeys` factory: `["agentRegistry", "fetch"]` query key
- `useAgentRegistryQuery(enabled)`: fires only when dialog is open (`enabled` flag); `staleTime: 5 * 60 * 1000` mirrors backend TTL; `gcTime: 10 * 60 * 1000` keeps data warm for quick re-open
- `useSpawnAcpSessionMutation()`: calls `api.spawnAcpSession(agentId, cwd, sessionName)`; invalidates `executionQueryKeys.all` on success; shows sonner toast on error

**AgentSelectorDialog.tsx:**
- Controlled Dialog with `open/onOpenChange` props from parent
- Accepts `worktrees: WorktreeWithStatus[]` (pre-fetched by parent to avoid duplicate fetch)
- Step 1: `<Command shouldFilter={true}>` with `CommandInput` for fuzzy agent search; `CommandItem` with `data-checked` attribute for check icon; loading/empty states handled via `CommandEmpty`
- Step 2: revealed after agent selection — `Badge` showing selected agent name+version, `Select` for worktree, `Input` for optional session name
- Spawn button disabled until both agent and worktree selected; shows "Spawning..." during mutation
- State resets on every dialog open via `useEffect([open])`
- `onSpawned(logId)` callback called on successful spawn for parent to select new session

**Test suite (4 tests, all passing):**
- SPAWN-01: renders agent list from registry data, shows loading state
- SPAWN-02: Spawn button disabled with no agent selected, mutation called with correct args on click

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Missing @testing-library/user-event dev dependency**
- **Found during:** Task 1 build verification
- **Issue:** Test stub (Task 0) uses `userEvent.setup()` but `@testing-library/user-event` was not installed — `pnpm build` failed with "Cannot find module '@testing-library/user-event'"
- **Fix:** `pnpm add -D @testing-library/user-event` — installed 14.6.1
- **Files modified:** package.json, pnpm-lock.yaml
- **Commit:** 8e44de8

**2. [Rule 3 - Blocking] Build order constraint — Tasks 0+1 committed before Task 2 created component**
- The test file (Task 0) imports AgentSelectorDialog which doesn't exist until Task 2. Build could not pass until Task 2 was complete. Verified build+tests only after Task 2 was written, as the plan intended.

## Known Stubs

None — all data flows are wired. `AgentSelectorDialog` consumes `useAgentRegistryQuery` (live CDN data via IPC) and `useSpawnAcpSessionMutation` (calls backend spawn). No hardcoded empty values flowing to UI rendering.

## Threat Flags

No new security-relevant surface introduced beyond what the plan's threat model covers:
- T-46-01 (agentId from RegistryResponse, not free-form input) — accepted
- T-46-02 (cwd from WorktreeWithStatus.path, DB-originated) — accepted
- T-46-03 (registry is public CDN data) — accepted

## Self-Check: PASSED
