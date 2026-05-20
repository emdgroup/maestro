# Requirements: Maestro

**Defined:** 2026-05-20
**Core Value:** Orchestrate multiple AI coding agents in parallel with isolation, visibility, and control

## v1.6 Requirements

### Foundation

- [ ] **FNDTN-01**: Tauri CSP updated to allow `api.github.com`, `gitlab.com`, `api.linear.app`, `auth.atlassian.com`, `api.atlassian.com`, `127.0.0.1:*`
- [ ] **FNDTN-02**: `tauri-plugin-oauth` registered in Cargo.toml, lib.rs, and capabilities/default.json
- [x] **FNDTN-03**: SQLite schema v16 adds `external_url`, `external_updated_at`, `labels` columns on tasks table
- [ ] **FNDTN-04**: Old import code removed — `ImportSettings.tsx`, `sync_github_issues`, `sync_jira_issues`, `save_import_config` IPC handlers

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

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| FNDTN-01 | Phase 50 | Pending |
| FNDTN-02 | Phase 50 | Pending |
| FNDTN-03 | Phase 51 | Complete |
| FNDTN-04 | Phase 51 | Pending |
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

**Coverage:**
- v1.6 requirements: 27 total
- Mapped to phases: 27
- Unmapped: 0 ✓

---
*Requirements defined: 2026-05-20*
*Last updated: 2026-05-20 — traceability filled after roadmap creation (Phases 50-56)*
