# Roadmap: Maestro

## Milestones

- ✅ **v1.0 MVP** — Phases 1-12 (shipped 2026-02-09)
- ✅ **v1.1 UI/UX Polish** — Phases 13-22 (shipped 2026-03-16)
- ✅ **v1.2 Deep Linking & Project Picker** — Phases 23-24 (shipped 2026-03-29)
- ✅ **v1.3 Agents & Worktrees** — Phases 25-28 (shipped 2026-03-30)
- ✅ **v1.4 Quality & Worktrees** — Phases 29-41 (shipped 2026-04-17)
- ✅ **v1.5 ACP Integration** — Phases 42-49 (shipped 2026-05-20)
- ✅ **v1.6 Ticketing Integration** — Phases 50-56 (shipped 2026-05-24)
- 🚧 **v1.7 Tasks UX Rework** — Phases 57-63 (in progress)

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

<details>
<summary>✅ v1.5 ACP Integration (Phases 42-49) — SHIPPED 2026-05-20</summary>

- [x] **Phase 42: maestro-server Activation** — Wire real ACP message loop in maestro-server binary (completed 2026-04-17)
- [x] **Phase 43: Local ACP Session Manager** — Tauri backend tracks live ACP sessions in AppState (completed 2026-04-20)
- [x] **Phase 44: DB Schema + ACP IPC Handlers** — Schema v11 + full IPC surface for ACP lifecycle (completed 2026-04-22)
- [x] **Phase 45: Agent Registry Fetch + Caching** — Fetch, cache, and resolve agents from ACP CDN registry (completed 2026-04-21)
- [x] **Phase 46: Frontend: Agent Selector + Spawn Flow** — Browse registry and spawn ACP sessions from UI (completed 2026-04-22)
- [x] **Phase 47: Frontend: AgentActivityPanel** — Structured output viewer with real-time event streaming (completed 2026-04-22)
- [x] **Phase 48: Frontend: PermissionDialog** — Approve/deny permission requests with session allowlist (completed 2026-05-20)
- [x] **Phase 49: Dual-Mode Execution Dispatcher** — Route spawn/attach through ACP or PTY path transparently (completed 2026-05-20)

See phase details below (archived after milestone close).

</details>

### ✅ v1.6 Ticketing Integration (Phases 50-56) — SHIPPED 2026-05-24

**Milestone Goal:** Connect each project to one ticket tracking tool (GitHub, GitLab, Forgejo, Linear, Jira Cloud/Server, or Azure DevOps) so users can browse and import open issues as Backlog tasks via an import modal, with per-project API key authentication and non-destructive change detection.

- [x] **Phase 50: Infrastructure** — CSP expansion + new Cargo dependencies (completed 2026-05-21)
- [x] **Phase 51: Data Foundation** — Schema v16 + Rust model types + ticketing config storage + old import code removal (completed 2026-05-20)
- [x] **Phase 52: Token Management** — OS keychain storage + mutex-guarded token manager (completed 2026-05-21)
- [x] **Phase 53: GitHub/GitLab/Forgejo Auth + API Clients** — PAT-based connection + issue fetching for GitHub (gh CLI auto-detect), GitLab (self-hosted), and Forgejo (completed 2026-05-21)
- [x] **Phase 54: Linear/Jira/AzDO Auth + API Clients** — API key connection + issue fetching for Linear (GraphQL), Jira Cloud (email+token), Azure DevOps (PAT); Jira Server dropped (Atlassian EOL) (completed 2026-05-21)
- [x] **Phase 55: Settings UI** — Ticketing section in project settings with provider picker, connect/disconnect, and connection status for all 6 providers (completed 2026-05-23)
- [x] **Phase 56: Import Modal + Change Detection** — Full import modal with Available/Imported/Changed tabs, multi-select, auto-refresh, and change detection (completed 2026-05-24)

### 🚧 v1.7 Tasks UX Rework (In Progress)

**Milestone Goal:** Replace the 3-view Kanban/Backlog/Archive navigation with a unified 5-column board and consistent interaction patterns throughout the Tasks view — unified board, tabbed create modal, dedicated task detail screen, attachment support, interrupt flow, and archive modal.

- [x] **Phase 57: Data Model & Backend** — Schema bump + new task fields + attachments table + interrupt IPC command (completed 2026-05-26)
- [ ] **Phase 58: Navigation Store** — Replace activeSubView with activeTaskId; enable task detail screen routing
- [x] **Phase 59: Board View** — Unified 5-column board with search, priority filter, label filter (completed 2026-05-26)
- [x] **Phase 60: Task Card Redesign** — Redesigned cards with priority/labels/agent/badges and per-column inline actions (completed 2026-05-26)
- [x] **Phase 61: Create Task Modal** — Tabbed modal (From Branch / From Issue) replacing three legacy creation components (completed 2026-05-27)
- [x] **Phase 62: Task Detail Screen** — Dedicated full-screen detail with action bar, editable fields, attachments, interrupt flow (completed 2026-05-27)
- [x] **Phase 63: Archive Modal** — Modal dialog for browsing archived and cancelled tasks (completed 2026-05-27)

## Phase Details

### Phase 50: Infrastructure

**Goal**: The app can make authenticated HTTP calls to all provider APIs — every prerequisite that silently blocks later provider work is eliminated in a single commit
**Depends on**: Phase 49
**Requirements**: FNDTN-01, FNDTN-02
**Success Criteria** (what must be TRUE):

  1. The app can make fetch requests to `api.github.com`, `gitlab.com`, `api.linear.app`, `auth.atlassian.com`, `api.atlassian.com`, and `127.0.0.1:*` without CSP violations in the browser console
  2. All new Cargo dependencies (`octocrab`, `graphql_client`) are listed in `Cargo.toml` and `cargo check` compiles without errors

**Plans**: 2/2 complete

### Phase 51: Data Foundation

**Goal**: All downstream Rust types and database columns required by ticketing exist, the canonical `external_id` format is locked in before any provider writes data, and the old broken import code is fully removed from the codebase
**Depends on**: Phase 50
**Requirements**: FNDTN-03, FNDTN-04, CFG-01, CFG-02
**Success Criteria** (what must be TRUE):

  1. Schema v16 migration is destructive (drops and recreates all tables); new schema adds `external_url`, `external_updated_at`, and `labels` columns to the tasks table; `cargo test` passes
  2. `models/ticketing.rs` compiles with `TicketingConfig` and `ProviderConfig` (externally-tagged enum with `Jira`, `GitHub`, `GitLab`, `Linear` variants); `pnpm tauri:gen` regenerates `bindings.ts` with these types present
  3. `sync_github_issues`, `sync_jira_issues`, and `save_import_config` IPC handlers are removed from `settings_handlers.rs` and deregistered from `lib.rs`; `ImportSettings.tsx` is deleted; `cargo check` and `pnpm build` both pass
  4. `.maestro/ticketing.json` can be written and read back for a project; attempting to connect a second provider overwrites the first (one provider per project enforced)

**Plans:** 2/2 plans complete
Plans:

- [x] 51-01-PLAN.md — Schema V16 + TicketingConfig model + IPC handlers
- [x] 51-02-PLAN.md — Legacy import code removal (Rust + frontend)

### Phase 52: Token Management

**Goal**: Tokens can be stored in and retrieved from the OS keychain for any project; KeychainStore + TokenManager are wired into AppState
**Depends on**: Phase 51
**Requirements**: AUTH-05, AUTH-06
**Success Criteria** (what must be TRUE):

  1. A token can be stored via `ticketing/keychain.rs` using the `maestro:{project_id}:ticketing` key and retrieved in a subsequent call without error; deleting it returns `NoEntry` on the next get
  2. On Linux/WSL where the system keyring is unavailable, a warning toast is shown and the app falls back to an encrypted file store rather than failing silently
  3. Two concurrent calls for the same project lock serialize correctly via per-project mutex

**Plans**: 1/1 complete

### Phase 53: GitHub/GitLab/Forgejo Auth + API Clients

**Goal**: Users can connect GitHub (with gh CLI auto-detect), GitLab (self-hosted), and Forgejo via PAT; the app validates credentials, stores them in the OS keychain, and fetches open issues mapped to `RemoteIssue`
**Depends on**: Phase 52
**Requirements**: AUTH-01, AUTH-02, PROV-01, PROV-02
**Success Criteria** (what must be TRUE):

  1. For GitHub: if `gh auth token` succeeds, credentials are auto-detected and stored without user input; if `gh` is absent or unauthenticated, a PAT input field is shown instead
  2. For GitLab and Forgejo: user provides instance URL + PAT; `save_credentials` validates against `/api/v4/user` (GitLab) or `/api/v1/user` (Forgejo), stores token in keychain, and returns `displayName`
  3. Given stored credentials, each provider client returns open issues (PRs excluded for GitHub) with `title`, `body`, `labels`, `url`, `updated_at`, and `external_id` in `github:{number}`, `gitlab:{project_id}/{issue_iid}`, or `forgejo:{number}` format
  4. `ProviderConfig` enum updated to include `Forgejo`, `JiraCloud`, `JiraServer`, `AzureDevOps` variants; `cargo check` and `pnpm tauri:gen` both pass; `tauri-plugin-oauth` and `oauth2` crates removed from Cargo.toml

**Plans**: 1 plan
Plans:

- [x] 53-01-PLAN.md — ProviderConfig + RemoteIssue models, three provider modules, 5 IPC commands

### Phase 54: Linear/Jira/AzDO Auth + API Clients

**Goal**: Users can connect Linear (API key), Jira Cloud (email + API token), Jira Server 8.14+ (PAT), and Azure DevOps (PAT); the app validates credentials, stores them in the keychain, and fetches open issues mapped to `RemoteIssue`
**Depends on**: Phase 53
**Requirements**: AUTH-03, AUTH-04, PROV-03, PROV-04
**Success Criteria** (what must be TRUE):

  1. Linear: API key validated via GraphQL `{ viewer { id name } }`; issues fetched via Linear GraphQL API with `external_id` in `linear:{identifier}` format; team selection supported
  2. Jira Cloud (`JiraCloudConfig`): site URL + email + API token validated via `GET /rest/api/3/myself` with Basic auth; issues fetched from REST v3; ADF body stripped to plain text; `external_id` in `jira:{issue_key}` format
  3. Jira Server (`JiraServerConfig`): base URL + PAT validated via `GET /rest/api/2/myself` with Bearer auth; same `external_id` format
  4. Azure DevOps: org URL + PAT (Basic auth with empty username) validated via `GET /_apis/connectionData`; work items fetched; `external_id` in `azuredevops:{id}` format

**Plans:** 4 plans
Plans:

- [ ] 54-01-PLAN.md — Cargo.toml dep fix (graphql_client feature + jc-adf) + linear.rs module
- [ ] 54-02-PLAN.md — jira_cloud.rs module (Basic auth + ADF conversion)
- [ ] 54-03-PLAN.md — jira_server.rs + azure_devops.rs modules
- [ ] 54-04-PLAN.md — Wire all modules (mod.rs + IPC handlers + lib.rs + pnpm tauri:gen)

Wave 1 — **54-01** (Cargo.toml + Linear)
Wave 2 *(blocked on Wave 1)* — **54-02**, **54-03** (parallel: Jira Cloud | Jira Server + AzDO)
Wave 3 *(blocked on Wave 2)* — **54-04** (IPC wiring + bindings regeneration)

### Phase 55: Settings UI

**Goal**: Users can connect and disconnect any of the 6 providers from project settings and see at a glance whether a provider is currently active
**Depends on**: Phase 54
**Requirements**: SETT-01, SETT-02, SETT-03
**Success Criteria** (what must be TRUE):

  1. Project settings has a Ticketing section with a provider picker offering GitHub, GitLab, Forgejo, Linear, Jira Cloud, Jira Server, and Azure DevOps as options
  2. After entering credentials and clicking "Connect", the section shows the provider name, account username/display name, and a green connected indicator without a page reload
  3. Clicking "Disconnect" removes the token from the keychain and deletes `.maestro/ticketing.json`; the UI returns to the disconnected state showing the provider picker

**Plans**: 3 plans
Plans:

- [x] 55-01-PLAN.md — Backend: integration model + keychain rewrite + IPC handlers
- [x] 55-02-PLAN.md — Frontend: IntegrationsTab, ConnectDialog, ProjectPicker tabs, SettingsPage Ticketing card
- [x] 55-03-PLAN.md — Cascade check: IntegrationMissingDialog + project open validation

**UI hint**: yes

### Phase 56: Import Modal + Change Detection

**Goal**: Users can open the import modal from the Backlog column, browse available issues across three tabs (Available, Imported, Changed), bulk-import selected tickets as Backlog tasks, and act on tickets whose upstream content has changed since import
**Depends on**: Phase 55
**Requirements**: IMPT-01, IMPT-02, IMPT-03, IMPT-04, IMPT-05, IMPT-06, CHNG-01, CHNG-02
**Success Criteria** (what must be TRUE):

  1. The "Import tickets" button appears in the Backlog column header only when a provider is connected; clicking it opens the import modal
  2. The modal's Available tab lists open remote issues not yet imported; the Imported tab lists issues that have already been imported as tasks; the Changed tab lists imported tasks whose provider `updated_at` is newer than the stored `external_updated_at`
  3. Checking one or more issues in the Available tab and clicking "Import Selected" creates Backlog tasks with `external_url`, `labels`, and `external_updated_at` populated
  4. The ticket list refreshes automatically every 5 minutes while the modal is open; clicking the Refresh button forces an immediate fetch
  5. In the Changed tab, clicking "Update task" overwrites the task's title, description, and labels from the current provider data and clears the changed flag; clicking "Dismiss" clears the changed flag while keeping the current task content

**Plans**: 2 plans
Plans:

- [x] 56-01-PLAN.md — RemoteIssue priority field + AzDo HTML fix + 3 new IPC commands + lib.rs registration + bindings regen
- [x] 56-02-PLAN.md — Service hooks + ImportTicketsModal component + BacklogView Import button

**UI hint**: yes

### Phase 57: Data Model & Backend

**Goal**: The Rust backend has all data structures and IPC commands that v1.7 frontend phases depend on — new task fields, attachments table, and interrupt capability are available before any UI work begins
**Depends on**: Phase 56
**Requirements**: DATA-01, DATA-02, DATA-03, DATA-04
**Success Criteria** (what must be TRUE):

  1. `Task` struct has `auto_approve: bool` (default false) and `isolated_worktree: bool` (default true); `pnpm tauri:gen` regenerates bindings with these fields present; `cargo check` passes
  2. Schema is bumped to V17; `task_attachments` table exists with `id`, `task_id` (FK → tasks with CASCADE delete), `filename`, `file_path`, `file_size`, `created_at`; `cargo test` passes
  3. `get_task_attachments`, `add_task_attachment`, and `remove_task_attachment` IPC commands are registered and callable from TypeScript; attachment CRUD round-trips correctly (add → get → remove → get returns empty)
  4. `interrupt_task` IPC command stops the active agent session for the given task and moves the task status back to Backlog; calling it on a task with no active session returns an error surfaced to the UI

**Plans:** 2/2 plans complete
Plans:
**Wave 1**

- [x] 57-01-PLAN.md — Schema V18 + Task model extension + TaskAttachment model

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 57-02-PLAN.md — Attachment CRUD IPC + interrupt_task IPC + command registration + bindings

### Phase 58: Navigation Store

**Goal**: The navigation store supports task detail screen routing — `activeTaskId` replaces the obsolete sub-view state, enabling any component to navigate directly to a task detail screen without prop drilling
**Depends on**: Phase 57
**Requirements**: (infrastructure — enables DETAIL-01, DETAIL-03, DETAIL-04 in Phase 62)
**Success Criteria** (what must be TRUE):

  1. `navigationStore.ts` exports `activeTaskId: number | null`, `setActiveTaskId(id)`, and `useActiveTaskId()` hook; the old `activeSubView` state and `SubView` type are removed
  2. `navigate({ taskId })` sets `activeTaskId` to the given ID; `navigate({ view: 'tasks' })` clears `activeTaskId` back to null
  3. All existing `navigationStore.test.ts` tests pass with the updated store; new tests cover `activeTaskId` set/clear behavior
  4. KanbanView renders `<TaskDetailScreen>` when `activeTaskId` is set and the board when it is null; no regressions in other view routing

**Plans:** 2/2 plans executed
Plans:

**Wave 1**

- [x] 58-01-PLAN.md — Store refactor + tests + TaskDetailScreen stub

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 58-02-PLAN.md — KanbanView simplification + App.tsx cleanup

**UI hint**: yes

### Phase 59: Board View

**Goal**: Users see all five task statuses on a single board without switching views and can narrow visible tasks by title, priority, or label from a persistent action bar
**Depends on**: Phase 58
**Requirements**: BOARD-01, BOARD-02, BOARD-03, BOARD-04
**Success Criteria** (what must be TRUE):

  1. The Tasks view shows Backlog, Ready, InProgress, Review, and Done as five visible columns with no sub-view toggle; all task statuses are reachable without any navigation action
  2. Typing in the search input filters cards across all columns by title match in real time; clearing the input restores all cards
  3. Selecting a priority from the priority filter shows only cards matching that priority across all columns; selecting "All" restores full list
  4. Selecting a label from the label filter shows only cards carrying that label across all columns; filters compose correctly with the search and priority filter

**Plans:** 2/2 plans complete
Plans:

- [ ] 58-01-PLAN.md — Store refactor + tests + TaskDetailScreen stub
- [ ] 58-02-PLAN.md — KanbanView simplification + App.tsx cleanup

**UI hint**: yes

### Phase 60: Task Card Redesign

**Goal**: Every task card communicates its full context at a glance and provides the one action a user most needs for that task's current status — no extra navigation required for common workflows
**Depends on**: Phase 59
**Requirements**: CARD-01, CARD-02, CARD-03, CARD-04, CARD-05, CARD-06
**Success Criteria** (what must be TRUE):

  1. Each card shows priority pill, up to 3 label pills with overflow count, title capped at 2 lines, agent name, worktree badge, and auto-approve icon when enabled
  2. Clicking anywhere on a card (outside the inline action button) navigates to the task detail screen for that task
  3. Ready column cards show an Execute button; clicking it triggers execution and the task moves to InProgress without a confirmation dialog
  4. InProgress column cards show an Interrupt button; clicking it calls `interrupt_task` and the task returns to Backlog
  5. Review column cards show a Review button that navigates to the diff view for that task's worktree
  6. Done column cards show an Archive button that archives the task and removes it from the board

**Plans:** 2/2 plans complete
Plans:

- [ ] 58-01-PLAN.md — Store refactor + tests + TaskDetailScreen stub
- [ ] 58-02-PLAN.md — KanbanView simplification + App.tsx cleanup

**UI hint**: yes

### Phase 61: Create Task Modal

**Goal**: Users create tasks through one consistent modal that covers both the branch-first workflow and the issue-import workflow — the three legacy creation components are replaced entirely
**Depends on**: Phase 60
**Requirements**: CREATE-01, CREATE-02, CREATE-03, CREATE-04
**Success Criteria** (what must be TRUE):

  1. Clicking "+ New Task" opens a modal with a "From Branch" tab; the tab has title, description, branch selector, priority, agent, isolated worktree toggle, auto-approve toggle, and creates a Backlog task on submit
  2. When a ticketing provider is configured, a "From Issue" tab is visible; selecting an issue pre-fills the title and description fields; the same branch selector and pill row are present; submitting creates a Backlog task
  3. The branch selector opens a popover with Local and Remote sub-tabs, a search input, a refresh button that re-fetches branches, and a checkmark on the currently selected branch
  4. Enabling "Create another" keeps the modal open after successful creation with fields cleared, allowing rapid task entry

**Plans:** 2/2 plans complete
Plans:

**Wave 1**

- [x] 61-01-PLAN.md — Schema V19 + Task model agent_id + IPC handler extensions + frontend mutation

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 61-02-PLAN.md — CreateTaskModal component + KanbanView wiring + legacy deletion

**UI hint**: yes

### Phase 62: Task Detail Screen

**Goal**: Users can read, edit, and act on a task from one full-screen surface — the fullscreen overlay is replaced by a dedicated screen with a clear locked/unlocked editing model and attachment support
**Depends on**: Phase 61
**Requirements**: DETAIL-01, DETAIL-02, DETAIL-03, DETAIL-04, DETAIL-05, DETAIL-06, DETAIL-07, DETAIL-08
**Success Criteria** (what must be TRUE):

  1. Clicking a task card navigates to a dedicated full screen (not a modal overlay); pressing the close button returns to the board
  2. When the task is in Backlog status, the title and description fields are editable inline; when status is anything else, both fields are read-only and a locked banner reads "Task is locked. Click Interrupt to unlock."
  3. When status is not Backlog, an Interrupt button is visible in the action bar; clicking it calls `interrupt_task`, the task returns to Backlog, the locked banner disappears, and fields become editable
  4. When status is InProgress or Review, an Execution button is visible in the action bar that navigates to the Agents view for the task's active session
  5. In Backlog status, the user can drag-drop or browse to upload file attachments; uploaded files appear in the attachments list with filename, size, and a remove button; removing a file calls `remove_task_attachment`
  6. The right sidebar shows a status dropdown; changing it updates the task status without leaving the detail screen
  7. The action bar shows a delete button (trash icon) that removes the task; when status is Done the same button shows an archive icon and archives instead of deleting

**Plans:** 2/2 plans complete
Plans:

**Wave 1**

- [x] 62-01-PLAN.md — Extend update_task + add cancel_task IPC + regen bindings

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 62-02-PLAN.md — Full TaskDetailScreen implementation + delete legacy TaskDetail.tsx

**UI hint**: yes

### Phase 63: Archive Modal

**Goal**: Archived and cancelled tasks are accessible through a dedicated modal from the board action bar — the ArchiveView sub-view is removed entirely
**Depends on**: Phase 62
**Requirements**: ARCHIVE-01, ARCHIVE-02, ARCHIVE-03
**Success Criteria** (what must be TRUE):

  1. An "Archive" button in the board action bar opens a modal listing all tasks where `archived_at` is set or status is Cancelled; the modal is reachable without leaving the board view
  2. The archive modal has a search input that filters tasks by title and filter tabs for All, Done, and Cancelled; filters update the list in real time
  3. Clicking a row in the archive modal closes the modal and opens the task detail screen in read-only mode; no edit actions are available for archived tasks

**Plans:** 1/1 plans complete
Plans:

- [x] 63-01-PLAN.md — ArchiveModal component + KanbanView wiring + ArchiveView deletion

**UI hint**: yes

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
| 42 - maestro-server Activation | v1.5 | Complete | Complete | 2026-04-17 |
| 43 - Local ACP Session Manager | v1.5 | Complete | Complete | 2026-04-20 |
| 44 - DB Schema + ACP IPC Handlers | v1.5 | Complete | Complete | 2026-04-22 |
| 45 - Agent Registry Fetch + Caching | v1.5 | Complete | Complete | 2026-04-21 |
| 46 - Frontend: Agent Selector + Spawn Flow | v1.5 | 2/2 | Complete | 2026-04-22 |
| 47 - Frontend: AgentActivityPanel | v1.5 | 3/3 | Complete | 2026-04-22 |
| 48 - Frontend: PermissionDialog | v1.5 | Complete | Complete | 2026-05-20 |
| 49 - Dual-Mode Execution Dispatcher | v1.5 | Complete | Complete | 2026-05-20 |
| 50 - Infrastructure | v1.6 | 2/2 | Complete | 2026-05-21 |
| 51 - Data Foundation | v1.6 | 2/2 | Complete | 2026-05-20 |
| 52 - Token Management | v1.6 | 1/1 | Complete | 2026-05-21 |
| 53 - GitHub/GitLab/Forgejo Auth + API Clients | v1.6 | 1/1 | Complete   | 2026-05-21 |
| 54 - Linear/Jira/AzDO Auth + API Clients | v1.6 | 4/4 | Complete | 2026-05-21 |
| 55 - Settings UI | v1.6 | 3/3 | Complete | 2026-05-23 |
| 56 - Import Modal + Change Detection | v1.6 | 2/2 | Complete | 2026-05-24 |
| 57 - Data Model & Backend | v1.7 | 2/2 | Complete   | 2026-05-26 |
| 58 - Navigation Store | v1.7 | 2/2 | Complete | 2026-05-26 |
| 59 - Board View | v1.7 | 2/2 | Complete    | 2026-05-26 |
| 60 - Task Card Redesign | v1.7 | 2/2 | Complete    | 2026-05-26 |
| 61 - Create Task Modal | v1.7 | 2/2 | Complete   | 2026-05-27 |
| 62 - Task Detail Screen | v1.7 | 2/2 | Complete   | 2026-05-27 |
| 63 - Archive Modal | v1.7 | 1/1 | Complete   | 2026-05-27 |

---

*Roadmap created: 2026-02-09*
*v1.0 shipped: 2026-02-09*
*v1.1 shipped: 2026-03-16*
*v1.2 shipped: 2026-03-29*
*v1.3 shipped: 2026-03-30*
*v1.4 shipped: 2026-04-17*
*v1.5 shipped: 2026-05-20*
*v1.6 roadmap created: 2026-05-20*
*v1.6 shipped: 2026-05-24*
*v1.7 roadmap created: 2026-05-26*
