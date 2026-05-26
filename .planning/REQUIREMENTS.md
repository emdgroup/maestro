# Requirements: Maestro

**Defined:** 2026-05-20
**Core Value:** Orchestrate multiple AI coding agents in parallel with isolation, visibility, and control

## v1.6 Requirements

### Foundation

- [ ] **FNDTN-01**: Tauri CSP updated to allow `api.github.com`, `gitlab.com`, `api.linear.app`, `auth.atlassian.com`, `api.atlassian.com`, `127.0.0.1:*`
- [ ] **FNDTN-02**: `tauri-plugin-oauth` registered in Cargo.toml, lib.rs, and capabilities/default.json
- [x] **FNDTN-03**: SQLite schema v16 adds `external_url`, `external_updated_at`, `labels` columns on tasks table
- [x] **FNDTN-04**: Old import code removed — `ImportSettings.tsx`, `sync_github_issues`, `sync_jira_issues`, `save_import_config` IPC handlers

### Auth

- [ ] **AUTH-01**: OAuth PKCE flow (localhost redirect via tauri-plugin-oauth) for GitHub
- [ ] **AUTH-02**: OAuth PKCE flow for GitLab cloud
- [ ] **AUTH-03**: OAuth flow for Linear
- [ ] **AUTH-04**: OAuth 2.0 3LO flow for Jira Cloud
- [ ] **AUTH-05**: Tokens stored in OS keychain via `keyring 3.6.3`; entry key `maestro:{project_id}:ticketing`
- [ ] **AUTH-06**: Mutex-guarded token refresh for GitLab (2h expiry) and Jira (1h expiry) prevents concurrent 401 race

### Config

- [x] **CFG-01**: `.maestro/ticketing.json` stores provider type and non-sensitive config (repo, project key, team, filters)
- [x] **CFG-02**: One provider per project enforced — connecting a new provider replaces the existing one

### Providers

- [ ] **PROV-01**: GitHub Issues client — fetch open issues, filter PRs, map title/body/labels/url/updated_at
- [ ] **PROV-02**: GitLab Issues client — fetch open issues, map title/description/labels/url/updated_at
- [ ] **PROV-03**: Linear Issues client — GraphQL, team selection during setup, map title/description/labels/url/updated_at
- [ ] **PROV-04**: Jira Cloud client — REST API v3 via `api.atlassian.com/ex/jira/{cloudId}/`, strip ADF from descriptions

### Settings UI

- [ ] **SETT-01**: Project settings has Ticketing section with provider picker (GitHub / GitLab / Linear / Jira)
- [ ] **SETT-02**: Connect button triggers OAuth flow, shows connected status (provider name + account username)
- [ ] **SETT-03**: Disconnect button clears token from keychain and config from `.maestro/ticketing.json`

### Import Modal

- [ ] **IMPT-01**: "Import tickets" button in Backlog column header, visible only when provider is connected
- [ ] **IMPT-02**: Modal shows tickets in Available / Imported / Changed tabs
- [ ] **IMPT-03**: Checkbox multi-select → "Import Selected" creates Backlog tasks with `external_url`, `labels`, `external_updated_at`
- [ ] **IMPT-04**: Auto-refresh fetches fresh tickets every 5 min while modal is open
- [ ] **IMPT-05**: Manual Refresh button forces immediate fetch
- [ ] **IMPT-06**: Filter by label and state (open/closed) for providers that support it

### Change Detection

- [ ] **CHNG-01**: On ticket fetch, compare provider `updated_at` against stored `external_updated_at`; flag task as Changed if different
- [ ] **CHNG-02**: Changed tab shows flagged tasks with Update action (overwrites title/description/labels from provider) and Dismiss action (clears flag, keeps current task)

## Future Requirements

### Auth

- **AUTH-F01**: OAuth for GitLab self-hosted instances (requires user-provided client_id + secret)
- **AUTH-F02**: Azure DevOps integration (PAT-based, work items API)

### Import

- **IMPT-F01**: Webhook-based real-time sync instead of polling
- **IMPT-F02**: Two-way sync — update ticket status when Maestro task moves to Done
- **IMPT-F03**: Bulk re-import all Changed tasks in one action

## Out of Scope

| Feature | Reason |
|---------|--------|
| GitLab self-hosted | Requires per-instance OAuth app registration — deferred to future |
| Azure DevOps | Deferred to v1.7+ |
| Write-back to ticket platform | Field mapping complexity, workflow differences per provider |
| Jira Server / Data Center | No OAuth 2.0 3LO support; Cloud only |
| Multiple providers per project | Adds complexity with no clear UX benefit |
| Webhook-based sync | Desktop app lifecycle makes reliable webhook handling impractical |

## v1.7 Requirements

### Board Layout

- [ ] **BOARD-01**: User sees all 5 task statuses (Backlog, Ready, InProgress, Review, Done) on single board without switching views
- [ ] **BOARD-02**: User can search tasks across all columns by title
- [ ] **BOARD-03**: User can filter tasks by priority
- [ ] **BOARD-04**: User can filter tasks by label

### Task Cards

- [ ] **CARD-01**: Card shows priority, labels (max 3 + overflow count), title (2 lines max), agent name, worktree badge, auto-approve icon
- [ ] **CARD-02**: Clicking card navigates to task detail screen
- [ ] **CARD-03**: Ready cards show inline Execute action
- [ ] **CARD-04**: InProgress cards show inline Interrupt action
- [ ] **CARD-05**: Review cards show inline Review action (navigates to diff view)
- [ ] **CARD-06**: Done cards show inline Archive action

### Task Creation

- [ ] **CREATE-01**: User can create task via "From Branch" tab (title, description, branch, priority, agent, isolated worktree, auto-approve)
- [ ] **CREATE-02**: User can create task via "From Issue" tab when provider configured — selecting issue pre-fills title and description
- [ ] **CREATE-03**: Branch selector shows local/remote branches with search and refresh
- [ ] **CREATE-04**: "Create another" toggle keeps modal open after creation

### Task Detail

- [ ] **DETAIL-01**: Task detail is a dedicated full screen (not overlay/modal)
- [ ] **DETAIL-02**: Title and description editable only when status is Backlog
- [ ] **DETAIL-03**: Locked banner + Interrupt button appear in action bar when status ≠ Backlog
- [ ] **DETAIL-04**: Interrupt stops active agent session and moves task to Backlog
- [ ] **DETAIL-05**: User can upload and remove file attachments (only in Backlog)
- [ ] **DETAIL-06**: User changes task status via sidebar dropdown
- [ ] **DETAIL-07**: Execution button in action bar links to agent session (InProgress/Review only)
- [ ] **DETAIL-08**: Delete action removes task; becomes Archive when status is Done

### Archive

- [ ] **ARCHIVE-01**: User views archived/cancelled tasks via modal from board action bar
- [ ] **ARCHIVE-02**: Archive modal supports search and filter by Done/Cancelled
- [ ] **ARCHIVE-03**: Clicking archived task opens read-only task detail screen

### Backend/Data

- [ ] **DATA-01**: Task model has auto_approve (bool, default false) and isolated_worktree (bool, default true) fields
- [ ] **DATA-02**: task_attachments table with CASCADE delete on task removal
- [x] **DATA-03**: IPC commands for attachment CRUD (get, add, remove)
- [x] **DATA-04**: interrupt_task IPC command stops agent session and moves task to Backlog

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| FNDTN-01 | Phase 50 | Pending |
| FNDTN-02 | Phase 50 | Pending |
| FNDTN-03 | Phase 51 | Complete |
| FNDTN-04 | Phase 51 | Complete |
| CFG-01 | Phase 51 | Complete |
| CFG-02 | Phase 51 | Complete |
| AUTH-05 | Phase 52 | Pending |
| AUTH-06 | Phase 52 | Pending |
| AUTH-01 | Phase 53 | Pending |
| AUTH-02 | Phase 53 | Pending |
| AUTH-03 | Phase 53 | Pending |
| AUTH-04 | Phase 53 | Pending |
| PROV-01 | Phase 54 | Pending |
| PROV-02 | Phase 54 | Pending |
| PROV-03 | Phase 54 | Pending |
| PROV-04 | Phase 54 | Pending |
| SETT-01 | Phase 55 | Pending |
| SETT-02 | Phase 55 | Pending |
| SETT-03 | Phase 55 | Pending |
| IMPT-01 | Phase 56 | Pending |
| IMPT-02 | Phase 56 | Pending |
| IMPT-03 | Phase 56 | Pending |
| IMPT-04 | Phase 56 | Pending |
| IMPT-05 | Phase 56 | Pending |
| IMPT-06 | Phase 56 | Pending |
| CHNG-01 | Phase 56 | Pending |
| CHNG-02 | Phase 56 | Pending |
| DATA-01 | Phase 57 | Pending |
| DATA-02 | Phase 57 | Pending |
| DATA-03 | Phase 57 | Complete |
| DATA-04 | Phase 57 | Complete |
| BOARD-01 | Phase 59 | Pending |
| BOARD-02 | Phase 59 | Pending |
| BOARD-03 | Phase 59 | Pending |
| BOARD-04 | Phase 59 | Pending |
| CARD-01 | Phase 60 | Pending |
| CARD-02 | Phase 60 | Pending |
| CARD-03 | Phase 60 | Pending |
| CARD-04 | Phase 60 | Pending |
| CARD-05 | Phase 60 | Pending |
| CARD-06 | Phase 60 | Pending |
| CREATE-01 | Phase 61 | Pending |
| CREATE-02 | Phase 61 | Pending |
| CREATE-03 | Phase 61 | Pending |
| CREATE-04 | Phase 61 | Pending |
| DETAIL-01 | Phase 62 | Pending |
| DETAIL-02 | Phase 62 | Pending |
| DETAIL-03 | Phase 62 | Pending |
| DETAIL-04 | Phase 62 | Pending |
| DETAIL-05 | Phase 62 | Pending |
| DETAIL-06 | Phase 62 | Pending |
| DETAIL-07 | Phase 62 | Pending |
| DETAIL-08 | Phase 62 | Pending |
| ARCHIVE-01 | Phase 63 | Pending |
| ARCHIVE-02 | Phase 63 | Pending |
| ARCHIVE-03 | Phase 63 | Pending |

**Coverage:**
- v1.6 requirements: 27 total
- Mapped to phases: 27
- Unmapped: 0 ✓
- v1.7 requirements: 26 total
- Mapped to phases: 26
- Unmapped: 0 ✓

---
*Requirements defined: 2026-05-20*
*Last updated: 2026-05-26 — v1.7 requirements mapped to phases 57-63*
