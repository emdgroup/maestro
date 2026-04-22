---
phase: 46-frontend-agent-selector-spawn-flow
verified: 2026-04-21T14:26:49Z
status: human_needed
score: 7/7 must-haves verified
overrides_applied: 0
human_verification:
  - test: "Open AgentsView with a project loaded and click 'Spawn Agent' button"
    expected: "AgentSelectorDialog opens showing a searchable list of ACP agents with name and description; typing in the search box filters the list"
    why_human: "Visual rendering and cmdk fuzzy-filter interaction require a running Tauri app; cannot verify list display or input filtering programmatically"
  - test: "Select an agent, choose a worktree, optionally type a session name, and click 'Spawn Agent'"
    expected: "Dialog closes, a new ACP session row appears in the AgentMonitor sidebar, and that session is auto-selected (sidebar highlights it)"
    why_human: "Requires a live Tauri app with a running backend + agent registry CDN connectivity; end-to-end spawn flow cannot be simulated with static grep checks"
  - test: "In the AgentMonitor sidebar, compare an existing PTY session row with a new ACP session row"
    expected: "PTY sessions display an 'Interactive' badge (outline variant); ACP sessions display an 'ACP' badge (outline variant); both are visually distinguishable at a glance"
    why_human: "Badge styling (outline variant, text size, color contrast) is a visual quality check that requires rendering in a browser"
---

# Phase 46: Frontend Agent Selector + Spawn Flow Verification Report

**Phase Goal:** Users can browse and search the ACP agent registry in a modal, select an agent and worktree, and spawn a live ACP session — with ACP sessions distinguished from PTY sessions in the execution sidebar
**Verified:** 2026-04-21T14:26:49Z
**Status:** human_needed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Registry agent list is available for display when agent selector opens | VERIFIED | `useAgentRegistryQuery(open)` — gates fetch on `enabled=open`; calls `api.fetchAgentRegistry(false)` → IPC → Rust; staleTime 5 min; data flows to `registry?.agents ?? []` rendered as CommandItems |
| 2 | Spawning an agent calls the backend and the new session appears in the sidebar | VERIFIED | `useSpawnAcpSessionMutation` calls `api.spawnAcpSession(agentId, cwd, sessionName)` → IPC; on success invalidates `executionQueryKeys.all`; `onSpawned(logId)` callback calls `setSelectedExecutionId(logId)` in AgentsView |
| 3 | AgentSelectorDialog renders a searchable list of agents with worktree selection and spawn action | VERIFIED | Component exists with `<Command shouldFilter={true}>`, `<CommandInput>`, `<CommandList>`, worktree `<Select>`, session name `<Input>`, and `<Button>` for spawn |
| 4 | User can click 'Spawn Agent' button in AgentsView action bar to open the AgentSelectorDialog | VERIFIED | `showAgentSelector` state, button at line 104 with `onClick={() => setShowAgentSelector(true)}`, `<AgentSelectorDialog open={showAgentSelector} ...>` |
| 5 | User can search agents, select one, pick a worktree, and click Spawn to create an ACP session | VERIFIED | Full flow wired: agent selection sets `selectedAgent`, worktree select sets `selectedWorktree`, Spawn button calls `spawnMutation.mutate({ agentId, cwd, sessionName })`; disabled until both selected |
| 6 | Newly spawned ACP session is auto-selected in the sidebar after spawn | VERIFIED | `onSpawned={(logId) => setSelectedExecutionId(logId)}` — passed to AgentSelectorDialog; called with backend-returned `logId` on successful mutation |
| 7 | ACP sessions show 'ACP' badge in the AgentMonitor sidebar; PTY and null-mode sessions show 'Interactive' | VERIFIED | AgentMonitor line 116: `{execution.execution_mode === "acp" ? "ACP" : "Interactive"}` — null-safe, backward-compatible |

**Score:** 7/7 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/services/execution.service.ts` | useAgentRegistryQuery and useSpawnAcpSessionMutation hooks | VERIFIED | Both hooks present; `registryQueryKeys` factory, `staleTime: 5 * 60 * 1000`, `gcTime: 10 * 60 * 1000`, `api.fetchAgentRegistry(false)`, `api.spawnAcpSession(agentId, cwd, sessionName)` with query invalidation on success |
| `src/components/execution/AgentSelectorDialog.tsx` | Modal dialog with agent search, worktree select, and spawn action | VERIFIED | 185 lines; `AgentSelectorDialogProps` interface; Command-based fuzzy search; two-step reveal; `data-checked` on CommandItem; `registry?.stale` notice; reset effect on open |
| `src/components/execution/__tests__/AgentSelectorDialog.test.tsx` | Unit tests covering SPAWN-01 and SPAWN-02 behaviors | VERIFIED | 4 tests passing: renders agent list, shows loading state, disables Spawn when no agent, calls mutation with correct args |
| `src/views/AgentsView.tsx` | AgentSelectorDialog integration with open/close state and onSpawned callback | VERIFIED | Import, `showAgentSelector` state, "Spawn Agent" button with Bot icon, `<AgentSelectorDialog open={showAgentSelector} worktrees={worktrees} repoPath={repoPath} onSpawned={(logId) => setSelectedExecutionId(logId)} />` |
| `src/components/execution/AgentMonitor.tsx` | Session-type badge rendering based on execution_mode | VERIFIED | `import { Badge } from "@/ui/badge"` added; badge always renders for all sessions; ternary on `execution.execution_mode === "acp"` |
| `src/components/execution/__tests__/AgentMonitor.test.tsx` | Unit tests covering SPAWN-03 badge behavior | VERIFIED | 3 tests passing: ACP badge for "acp", Interactive badge for "pty", Interactive badge for null |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `src/services/execution.service.ts` | `api.fetchAgentRegistry` | TanStack Query useQuery | WIRED | `queryFn: () => api.fetchAgentRegistry(false)` at line 233 |
| `src/services/execution.service.ts` | `api.spawnAcpSession` | TanStack Query useMutation | WIRED | `return await api.spawnAcpSession(agentId, cwd, sessionName)` at line 257 |
| `src/components/execution/AgentSelectorDialog.tsx` | `src/services/execution.service.ts` | import useSpawnAcpSessionMutation | WIRED | Import at line 2; `const spawnMutation = useSpawnAcpSessionMutation()` at line 46 |
| `src/views/AgentsView.tsx` | `src/components/execution/AgentSelectorDialog.tsx` | import and render | WIRED | Import at line 25; rendered at lines 224-230 with all required props |
| `src/views/AgentsView.tsx` | `showAgentSelector` state | setShowAgentSelector(true) | WIRED | State at line 49; button at line 104 sets it to true |
| `src/components/execution/AgentMonitor.tsx` | `execution.execution_mode` | conditional badge text | WIRED | Line 116: ternary on `execution.execution_mode === "acp"` |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|-------------------|--------|
| `AgentSelectorDialog.tsx` | `registry` | `useAgentRegistryQuery(open)` → `api.fetchAgentRegistry(false)` → `commands.fetchAgentRegistry` (IPC) | Yes — Rust IPC to CDN/cached registry, returns `RegistryResponse { agents: AgentInfo[] }` | FLOWING |
| `AgentSelectorDialog.tsx` | `spawnMutation` | `useSpawnAcpSessionMutation()` → `api.spawnAcpSession(agentId, cwd, sessionName)` → IPC | Yes — Rust IPC spawns ACP session and returns `log_id: number` | FLOWING |
| `AgentMonitor.tsx` | `execution.execution_mode` | `executions` prop from `useExecutionsWithTaskInfoQuery` in AgentsView (pre-existing) | Yes — DB-backed IPC query, `execution_mode` field from `execution_logs` table | FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| useAgentRegistryQuery exported from service | node string check | Found in file | PASS |
| useSpawnAcpSessionMutation exported from service | node string check | Found in file | PASS |
| api.fetchAgentRegistry called in hook | grep | `queryFn: () => api.fetchAgentRegistry(false)` | PASS |
| api.spawnAcpSession called in mutation | grep | `return await api.spawnAcpSession(agentId, cwd, sessionName)` | PASS |
| AgentSelectorDialog imported in AgentsView | grep | Line 25: `import { AgentSelectorDialog }` | PASS |
| Badge ternary on execution_mode | grep | Line 116: `execution_mode === "acp" ? "ACP" : "Interactive"` | PASS |
| Old conditional Interactive span removed | grep | No `!execution.task_name &&` before badge span | PASS |
| AgentSelectorDialog tests (4 tests) | `pnpm test AgentSelectorDialog` | 4 passed | PASS |
| AgentMonitor tests (3 tests) | `pnpm test AgentMonitor` | 3 passed | PASS |
| Frontend build | `pnpm build` | built in 2.11s, exit 0 | PASS |
| All 6 phase commits exist | git log | 2476027 8e44de8 2c68c1a f992841 1538988 f32bdf7 all present | PASS |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|----------|
| SPAWN-01 | 46-01, 46-02 | User can browse and search available ACP agents by name and description in a modal | SATISFIED | AgentSelectorDialog renders `(registry?.agents ?? []).map(agent => <CommandItem>` with name + description; `<Command shouldFilter={true}>` enables cmdk fuzzy search by name |
| SPAWN-02 | 46-01, 46-02 | User can spawn an ACP session by selecting an agent, choosing a worktree/branch, and clicking Spawn | SATISFIED | Spawn button calls `spawnMutation.mutate({ agentId: selectedAgent.id, cwd: selectedWorktree.path, sessionName })` — gated on both `selectedAgent` and `selectedWorktree` non-null |
| SPAWN-03 | 46-02 | ACP sessions displayed with "ACP" badge in execution sidebar alongside PTY ("Interactive") sessions | SATISFIED | AgentMonitor line 116: `<Badge variant="outline">{execution.execution_mode === "acp" ? "ACP" : "Interactive"}</Badge>` — always rendered, null-safe |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| Multiple files | Various | `placeholder="..."` attribute | Info | HTML input placeholder attributes — not stub indicators, expected UX text |

No blockers or warnings found. The `placeholder` matches are all UI input placeholder text (search box, select prompt, text input hint) — none are code stubs.

### Human Verification Required

All automated checks pass. Three items require a running Tauri application to verify:

#### 1. Agent List Display and Search Filtering

**Test:** With a project loaded in AgentsView, click the "Spawn Agent" button in the action bar.
**Expected:** A modal titled "Spawn ACP Agent" opens with a search input and a list of agents showing name and description. Typing in the search input filters the list to matching agents.
**Why human:** cmdk fuzzy search behavior and visual layout require a running browser environment. Cannot verify list rendering or keyboard/text filtering behavior programmatically.

#### 2. Full Spawn Flow End-to-End

**Test:** In the AgentSelectorDialog, type to find an agent, click it to select it (check icon should appear), choose a worktree from the dropdown, optionally enter a session name, and click "Spawn Agent".
**Expected:** The dialog closes, a new session row appears in the AgentMonitor sidebar, and that session row is highlighted/selected immediately (auto-selection via `onSpawned` callback).
**Why human:** Requires a live Tauri backend with a real agent registry (CDN or cached) and the ability to actually spawn a subprocess. The IPC round-trip and UI state update after spawn cannot be tested without a running app.

#### 3. Session-Type Badge Visual Distinction

**Test:** With at least one PTY session and one ACP session in the sidebar, visually compare the session rows.
**Expected:** PTY sessions have an "Interactive" badge with outline styling; ACP sessions have an "ACP" badge with outline styling. Both are legible and visually distinct from session names and branch labels.
**Why human:** Badge styling (outline variant border, text contrast against background, padding) is a visual quality check that requires rendering in a browser.

### Gaps Summary

No gaps found. All 7 observable truths verified. All 6 artifacts pass Levels 1-4 (exist, substantive, wired, data flowing). All 3 requirement IDs (SPAWN-01, SPAWN-02, SPAWN-03) satisfied. Build passes. 7/7 tests pass. No anti-patterns blocking goal achievement.

---

_Verified: 2026-04-21T14:26:49Z_
_Verifier: Claude (gsd-verifier)_
