# Roadmap: Maestro

## Milestones

- ✅ **v1.0 MVP** — Phases 1-12 (shipped 2026-02-09)
- ✅ **v1.1 UI/UX Polish** — Phases 13-22 (shipped 2026-03-16)
- ✅ **v1.2 Deep Linking & Project Picker** — Phases 23-24 (shipped 2026-03-29)
- ✅ **v1.3 Agents & Worktrees** — Phases 25-28 (shipped 2026-03-30)
- ✅ **v1.4 Quality & Worktrees** — Phases 29-41 (shipped 2026-04-17)
- ✅ **v1.5 ACP Integration** — Phases 42-49 (shipped 2026-05-20)
- 🚧 **v1.6 Ticketing Integration** — Phases 50-56 (in progress)

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

### 🚧 v1.6 Ticketing Integration (In Progress)

**Milestone Goal:** Connect each project to one ticket tracking tool (GitHub, GitLab, Forgejo, Linear, Jira Cloud/Server, or Azure DevOps) so users can browse and import open issues as Backlog tasks via an import modal, with per-project API key authentication and non-destructive change detection.

- [x] **Phase 50: Infrastructure** — CSP expansion + new Cargo dependencies (completed 2026-05-21)
- [x] **Phase 51: Data Foundation** — Schema v16 + Rust model types + ticketing config storage + old import code removal (completed 2026-05-20)
- [x] **Phase 52: Token Management** — OS keychain storage + mutex-guarded token manager (completed 2026-05-21)
- [ ] **Phase 53: GitHub/GitLab/Forgejo Auth + API Clients** — PAT-based connection + issue fetching for GitHub (gh CLI auto-detect), GitLab (self-hosted), and Forgejo
- [ ] **Phase 54: Linear/Jira/AzDO Auth + API Clients** — API key connection + issue fetching for Linear (GraphQL), Jira Cloud (email+token) and Server (PAT), Azure DevOps (PAT)
- [ ] **Phase 55: Settings UI** — Ticketing section in project settings with provider picker, connect/disconnect, and connection status for all 6 providers
- [ ] **Phase 56: Import Modal + Change Detection** — Full import modal with Available/Imported/Changed tabs, multi-select, auto-refresh, and change detection

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
**Plans**: TBD

### Phase 54: Linear/Jira/AzDO Auth + API Clients
**Goal**: Users can connect Linear (API key), Jira Cloud (email + API token), Jira Server 8.14+ (PAT), and Azure DevOps (PAT); the app validates credentials, stores them in the keychain, and fetches open issues mapped to `RemoteIssue`
**Depends on**: Phase 53
**Requirements**: AUTH-03, AUTH-04, PROV-03, PROV-04
**Success Criteria** (what must be TRUE):
  1. Linear: API key validated via GraphQL `{ viewer { id name } }`; issues fetched via Linear GraphQL API with `external_id` in `linear:{identifier}` format; team selection supported
  2. Jira Cloud (`JiraCloudConfig`): site URL + email + API token validated via `GET /rest/api/3/myself` with Basic auth; issues fetched from REST v3; ADF body stripped to plain text; `external_id` in `jira:{issue_key}` format
  3. Jira Server (`JiraServerConfig`): base URL + PAT validated via `GET /rest/api/2/myself` with Bearer auth; same `external_id` format
  4. Azure DevOps: org URL + PAT (Basic auth with empty username) validated via `GET /_apis/connectionData`; work items fetched; `external_id` in `azuredevops:{id}` format
**Plans**: TBD

### Phase 55: Settings UI
**Goal**: Users can connect and disconnect any of the 6 providers from project settings and see at a glance whether a provider is currently active
**Depends on**: Phase 54
**Requirements**: SETT-01, SETT-02, SETT-03
**Success Criteria** (what must be TRUE):
  1. Project settings has a Ticketing section with a provider picker offering GitHub, GitLab, Forgejo, Linear, Jira Cloud, Jira Server, and Azure DevOps as options
  2. After entering credentials and clicking "Connect", the section shows the provider name, account username/display name, and a green connected indicator without a page reload
  3. Clicking "Disconnect" removes the token from the keychain and deletes `.maestro/ticketing.json`; the UI returns to the disconnected state showing the provider picker
**Plans**: TBD
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
**Plans**: TBD
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
| 53 - GitHub/GitLab/Forgejo Auth + API Clients | v1.6 | 0/TBD | Not started | - |
| 54 - Linear/Jira/AzDO Auth + API Clients | v1.6 | 0/TBD | Not started | - |
| 55 - Settings UI | v1.6 | 0/TBD | Not started | - |
| 56 - Import Modal + Change Detection | v1.6 | 0/TBD | Not started | - |

---

*Roadmap created: 2026-02-09*
*v1.0 shipped: 2026-02-09*
*v1.1 shipped: 2026-03-16*
*v1.2 shipped: 2026-03-29*
*v1.3 shipped: 2026-03-30*
*v1.4 shipped: 2026-04-17*
*v1.5 shipped: 2026-05-20*
*v1.6 roadmap created: 2026-05-20*
