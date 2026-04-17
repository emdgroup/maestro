# Roadmap: Maestro

## Milestones

- ✅ **v1.0 MVP** — Phases 1-12 (shipped 2026-02-09)
- ✅ **v1.1 UI/UX Polish** — Phases 13-22 (shipped 2026-03-16)
- ✅ **v1.2 Deep Linking & Project Picker** — Phases 23-24 (shipped 2026-03-29)
- ✅ **v1.3 Agents & Worktrees** — Phases 25-28 (shipped 2026-03-30)
- ✅ **v1.4 Quality & Worktrees** — Phases 29-41 (shipped 2026-04-17)
- 🚧 **v1.5 ACP Integration** — Phases 42-49 (in progress)

## Phases

<details>
<summary>✅ v1.0 MVP (Phases 1-12) — SHIPPED 2026-02-09</summary>

- [x] Phase 1: Foundation — completed 2026-02-04
- [x] Phase 2: Core Orchestration — completed 2026-02-05
- [x] Phase 3: Git Worktree Infrastructure — completed 2026-02-05
- [x] Phase 4: Agent Execution — completed 2026-02-06
- [x] Phase 5: Real-time Monitoring — completed 2026-02-06
- [x] Phase 6: Review & Merge Workflow — completed 2026-02-07
- [x] Phase 7: Configuration Management — completed 2026-02-07
- [x] Phase 8: Error Handling & Polish — completed 2026-02-08
- [x] Phase 9: Remote Project Support (SSH) — completed 2026-02-08
- [x] Phase 10: Documentation Completeness — completed 2026-02-08
- [x] Phase 11: Agent Execution UX Polish — completed 2026-02-09
- [x] Phase 12: Worktree Disk Cleanup — completed 2026-02-09

See `.planning/milestones/v1.0-ROADMAP.md` for full details.

</details>

<details>
<summary>✅ v1.1 UI/UX Polish (Phases 13-22) — SHIPPED 2026-03-16</summary>

- [x] Phase 13: Bug Fixes — completed 2026-02-09
- [x] Phase 14: UI Foundation — completed 2026-02-10
- [x] Phase 15: Component & Design System — completed 2026-02-10
- [x] Phase 16: Page Redesigns — completed 2026-02-10
- [x] Phase 17: Polish & Testing — completed 2026-02-10
- [x] Phase 17.1: Critical UI Fixes (INSERTED) — completed 2026-02-11
- [x] Phase 18: Maestro Folder Architecture & Rebranding — completed 2026-02-23
- [x] Phase 19: Frontend Architecture Refactoring — completed 2026-02-26
- [x] Phase 20: Refactor Frontend to use TanStack Query — completed 2026-02-27
- [x] Phase 21: Refactor Components Using Commands Object — completed 2026-02-28
- [x] Phase 22: Auto-remove Stale Projects — completed 2026-03-16

See `.planning/milestones/v1.1-ROADMAP.md` for full details.

</details>

<details>
<summary>✅ v1.2 Deep Linking & Project Picker (Phases 23-24) — SHIPPED 2026-03-29</summary>

- [x] Phase 23: Add in-app routing for deep linking to specific screens (2/2 plans) — completed 2026-03-28
- [x] Phase 24: Improve project picker screen (2/2 plans) — completed 2026-03-28

See `.planning/milestones/v1.2-ROADMAP.md` for full details.

</details>

<details>
<summary>✅ v1.3 Agents & Worktrees (Phases 25-28) — SHIPPED 2026-03-30</summary>

- [x] Phase 25: Backend Overhaul (4/4 plans) — completed 2026-03-29
- [x] Phase 26: Agents View (2/2 plans) — completed 2026-03-29
- [x] Phase 27: Worktrees View (3/3 plans) — completed 2026-03-30
- [x] Phase 28: Zombie Cleanup on Project Open (1/1 plan) — completed 2026-03-30

See `.planning/milestones/v1.3-ROADMAP.md` for full details.

</details>

<details>
<summary>✅ v1.4 Quality & Worktrees (Phases 29-41) — SHIPPED 2026-04-17</summary>

- [x] Phase 29: v1.3 Polish & Bug Fixes (2/2 plans) — completed 2026-03-30
- [x] Phase 30: Post-testing UI & worktree bug fixes (3/3 plans) — completed 2026-03-30
- [x] Phase 31: Fix remote SSH worktree bugs (2/2 plans) — completed 2026-03-30
- [x] Phase 32: Backend code quality fixes (5/5 plans) — completed 2026-03-30
- [x] Phase 33: Backend refactoring for maintainability (3/3 plans) — completed 2026-03-30
- [x] Phase 34: Remove Node.js sidecar, squash merge in Rust (2/2 plans) — completed 2026-03-31
- [x] Phase 35: Fix worktree diff status, remove git2, add DiffTarget (2/2 plans) — completed 2026-03-31
- [x] Phase 36: Redesign diff pane in worktrees view (2/2 plans) — completed 2026-03-31
- [x] Phase 37: Redesign worktrees view with card grid and slide-in diff panel (3/3 plans) — completed 2026-04-01
- [x] Phase 38: Add git commit features to the diff view (3/3 plans) — completed 2026-04-07
- [x] Phase 39: Fix SSH terminal session switching (3/3 plans) — completed 2026-04-08
- [x] Phase 40: SSH disconnection handling — heartbeat keepalive, reconnect backdrop, PTY cleanup (4/4 plans) — completed 2026-04-16
- [x] Phase 41: ACP Agent Selection & Discovery System (3/3 plans) — completed 2026-04-17

See `.planning/milestones/v1.4-ROADMAP.md` for full details.

</details>

### 🚧 v1.5 ACP Integration (In Progress)

**Milestone Goal:** Activate ACP protocol integration so users can select agents from the registry, spawn them locally, see structured output (plans, tool calls, diffs), approve/reject permission requests, with PTY fallback for non-ACP agents.

- [x] **Phase 42: maestro-server Activation** — Wire real ACP message loop in maestro-server binary (completed 2026-04-17)
- [ ] **Phase 43: Local ACP Session Manager** — Tauri backend tracks live ACP sessions in AppState
- [ ] **Phase 44: DB Schema + ACP IPC Handlers** — Schema v11 + full IPC surface for ACP lifecycle
- [ ] **Phase 45: Agent Registry Fetch + Caching** — Fetch, cache, and resolve agents from ACP CDN registry
- [ ] **Phase 46: Frontend: Agent Selector + Spawn Flow** — Browse registry and spawn ACP sessions from UI
- [ ] **Phase 47: Frontend: AgentActivityPanel** — Structured output viewer with real-time event streaming
- [ ] **Phase 48: Frontend: PermissionDialog** — Approve/deny permission requests with session allowlist
- [ ] **Phase 49: Dual-Mode Execution Dispatcher** — Route spawn/attach through ACP or PTY path transparently

## Phase Details

### Phase 42: maestro-server Activation
**Goal**: maestro-server binary handles the full ACP stdin/stdout message loop — receiving spawn requests, spawning agents via ClientSideConnection, and forwarding structured session events and permission requests to the Tauri host
**Depends on**: Phase 41 (ACP infrastructure skeleton)
**Requirements**: SERVER-01, SERVER-02, SERVER-03, SERVER-04
**Success Criteria** (what must be TRUE):
  1. maestro-server receives a SpawnRequest on stdin and spawns the target agent subprocess via ACP ClientSideConnection without error
  2. Structured session events (messages, tool calls, diffs, plans) arrive on stdout as ServerResponse::SessionUpdate JSON frames
  3. Raw terminal output from the agent's PTY callbacks arrives on stdout as ServerResponse::TerminalOutput frames
  4. Permission requests pause the agent and arrive on stdout as ServerResponse::PermissionRequest; sending PermissionResponse on stdin unblocks the agent
**Plans**: 2 plans
Plans:
- [x] 42-01-PLAN.md — Protocol extension + session types + ACP Client trait implementation
- [x] 42-02-PLAN.md — Agent spawner + main.rs stdin/stdout read loop with full ACP lifecycle

### Phase 43: Local ACP Session Manager
**Goal**: Tauri backend can launch maestro-server as a managed subprocess per session, track live ACP sessions in AppState, and stream typed Tauri events to the frontend for each session
**Depends on**: Phase 42
**Requirements**: SESSION-01, SESSION-02, SESSION-03
**Success Criteria** (what must be TRUE):
  1. Developer can call an IPC command that spawns a maestro-server child process with piped stdin/stdout and a unique log_id key
  2. A background reader task parses maestro-server stdout and emits typed Tauri events (acp://session-update/{log_id}, acp://terminal-output/{log_id}, acp://permission-request/{log_id})
  3. Active ACP sessions are accessible in AppState.acp_sessions and cleaned up when the session ends
**Plans**: TBD

### Phase 44: DB Schema + ACP IPC Handlers
**Goal**: Database schema v11 captures ACP-specific fields on execution_logs, and the full IPC surface (spawn, prompt, permission response, cancel, structured output flush) is available to the frontend
**Depends on**: Phase 43
**Requirements**: PERSIST-01, PERSIST-02, PERSIST-03, PERSIST-04, PERSIST-05, PERSIST-06
**Success Criteria** (what must be TRUE):
  1. Schema migration to v11 adds execution_mode, agent_id, and structured_output columns to execution_logs without breaking existing PTY session records
  2. Calling spawn_acp_session IPC creates an execution_log row with execution_mode='acp' and returns the log_id to the caller
  3. Calling send_acp_prompt and respond_acp_permission IPC commands forward the payloads to the correct maestro-server stdin without error
  4. Structured output from in-memory AcpSession is periodically flushed to execution_logs.structured_output so dead session replay works after app restart
**Plans**: TBD

### Phase 45: Agent Registry Fetch + Caching
**Goal**: Tauri backend can fetch the ACP agent registry from the CDN, cache it in AppState with a 5-minute TTL, and resolve a concrete launch command for any agent in the registry
**Depends on**: Nothing (independent — can be developed in parallel with Phases 42-43)
**Requirements**: REGISTRY-01, REGISTRY-02, REGISTRY-03
**Success Criteria** (what must be TRUE):
  1. Calling the fetch_agent_registry IPC returns the current list of available ACP agents from https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json
  2. A second call within 5 minutes returns the cached result without hitting the network; calling force-refresh bypasses the cache
  3. Given an AgentInfo from the registry, the backend resolves the correct launch command (npx package, binary target, or uvx package) for use in SpawnRequest
**Plans**: TBD
**UI hint**: no

### Phase 46: Frontend: Agent Selector + Spawn Flow
**Goal**: Users can browse and search the ACP agent registry in a modal, select an agent and worktree, and spawn a live ACP session — with ACP sessions distinguished from PTY sessions in the execution sidebar
**Depends on**: Phase 44, Phase 45
**Requirements**: SPAWN-01, SPAWN-02, SPAWN-03
**Success Criteria** (what must be TRUE):
  1. User can open an agent selector modal that lists available ACP agents with name and description, and filter them by typing in a search box
  2. User can select an agent and a worktree/branch, click Spawn, and see a new ACP session appear in the execution sidebar
  3. ACP sessions in the sidebar display an "ACP" badge, distinguishing them from PTY ("Interactive") sessions at a glance
**Plans**: TBD
**UI hint**: yes

### Phase 47: Frontend: AgentActivityPanel
**Goal**: Users see a structured, real-time view of ACP agent output — messages, tool calls with args/results, file diffs, and plans — alongside the raw terminal, with completed sessions replaying from the database
**Depends on**: Phase 46
**Requirements**: ACTIVITY-01, ACTIVITY-02, ACTIVITY-03
**Success Criteria** (what must be TRUE):
  1. While an ACP session is running, structured output (messages, tool calls, diffs, plans) appears in real-time in the activity panel via Tauri event subscription
  2. Raw terminal output from the agent is visible in a split pane using the existing TerminalComponent alongside the structured view
  3. Selecting a completed ACP session loads its structured output from the database and renders it identically to the live view
**Plans**: TBD
**UI hint**: yes

### Phase 48: Frontend: PermissionDialog
**Goal**: Users are surfaced permission requests from the running agent as a blocking modal, can allow or deny each request, can grant session-scoped blanket approval for a tool, and are notified of pending requests even when viewing a different tab
**Depends on**: Phase 46
**Requirements**: PERM-01, PERM-02, PERM-03, PERM-04
**Success Criteria** (what must be TRUE):
  1. When the agent requests a permission (file write, terminal command, or other tool), a dialog appears showing the request details and blocks until the user responds
  2. User can click Allow or Deny; the decision is forwarded via respond_acp_permission IPC and the agent unblocks immediately
  3. User can check "Allow all for this session" for a given tool; subsequent requests for that tool are auto-approved without showing the dialog again
  4. If the user is on a different tab when a permission request arrives, an urgent badge or indicator signals there is a pending request
**Plans**: TBD
**UI hint**: yes

### Phase 49: Dual-Mode Execution Dispatcher
**Goal**: spawn_interactive_execution routes transparently to the ACP or PTY execution path based on whether an agent_id is provided, attach_terminal handles both session types, and all existing PTY flows continue working without modification
**Depends on**: Phase 47, Phase 48
**Requirements**: DISPATCH-01, DISPATCH-02, DISPATCH-03
**Success Criteria** (what must be TRUE):
  1. Calling spawn_interactive_execution with an agent_id found in the registry launches an ACP session; calling it without agent_id (or with an unknown id) falls through to the existing PTY path
  2. attach_terminal correctly serves the terminal_output buffer for ACP sessions and uses the existing PTY attach path for PTY sessions — callers see no difference
  3. All existing PTY execution flows (spawn, attach, detach, cancel, resume) continue working without regression after the dispatcher is wired
**Plans**: TBD

## Progress

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 1-12 | v1.0 | 45/45 | Complete | 2026-02-09 |
| 13-22 | v1.1 | 36/36 | Complete | 2026-03-16 |
| 23 - In-app routing | v1.2 | 2/2 | Complete | 2026-03-28 |
| 24 - Project picker improvements | v1.2 | 2/2 | Complete | 2026-03-28 |
| 25 - Backend Overhaul | v1.3 | 4/4 | Complete | 2026-03-29 |
| 26 - Agents View | v1.3 | 2/2 | Complete | 2026-03-29 |
| 27 - Worktrees View | v1.3 | 3/3 | Complete | 2026-03-30 |
| 28 - Zombie Cleanup on Project Open | v1.3 | 1/1 | Complete | 2026-03-30 |
| 29 - v1.3 Polish & Bug Fixes | v1.4 | 2/2 | Complete | 2026-03-30 |
| 30 - Post-testing UI & worktree bug fixes | v1.4 | 3/3 | Complete | 2026-03-30 |
| 31 - Fix remote SSH worktree bugs | v1.4 | 2/2 | Complete | 2026-03-30 |
| 32 - Backend code quality fixes | v1.4 | 5/5 | Complete | 2026-03-30 |
| 33 - Backend refactoring for maintainability | v1.4 | 3/3 | Complete | 2026-03-30 |
| 34 - Remove Node.js sidecar, squash merge in Rust | v1.4 | 2/2 | Complete | 2026-03-31 |
| 35 - Fix worktree diff status, remove git2, add DiffTarget | v1.4 | 2/2 | Complete | 2026-03-31 |
| 36 - Redesign diff pane in worktrees view | v1.4 | 2/2 | Complete | 2026-03-31 |
| 37 - Redesign worktrees view with card grid and slide-in diff panel | v1.4 | 3/3 | Complete | 2026-04-01 |
| 38 - Add git commit features to diff view | v1.4 | 3/3 | Complete | 2026-04-07 |
| 39 - Fix SSH terminal session switching | v1.4 | 3/3 | Complete | 2026-04-08 |
| 40 - SSH disconnection handling | v1.4 | 4/4 | Complete | 2026-04-16 |
| 41 - ACP Agent Selection & Discovery System | v1.4 | 3/3 | Complete | 2026-04-17 |
| 42 - maestro-server Activation | v1.5 | 2/2 | Complete   | 2026-04-17 |
| 43 - Local ACP Session Manager | v1.5 | 0/? | Not started | - |
| 44 - DB Schema + ACP IPC Handlers | v1.5 | 0/? | Not started | - |
| 45 - Agent Registry Fetch + Caching | v1.5 | 0/? | Not started | - |
| 46 - Frontend: Agent Selector + Spawn Flow | v1.5 | 0/? | Not started | - |
| 47 - Frontend: AgentActivityPanel | v1.5 | 0/? | Not started | - |
| 48 - Frontend: PermissionDialog | v1.5 | 0/? | Not started | - |
| 49 - Dual-Mode Execution Dispatcher | v1.5 | 0/? | Not started | - |

---

*Roadmap created: 2026-02-09*
*v1.0 shipped: 2026-02-09*
*v1.1 shipped: 2026-03-16*
*v1.2 shipped: 2026-03-29*
*v1.3 shipped: 2026-03-30*
*v1.4 shipped: 2026-04-17*
*v1.5 roadmap defined: 2026-04-17*
