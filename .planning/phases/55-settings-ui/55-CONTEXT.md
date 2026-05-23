# Phase 55: Settings UI - Context

**Gathered:** 2026-05-22
**Status:** Ready for planning

<domain>
## Phase Boundary

This phase delivers a two-level settings architecture and its UI:

1. **Integrations** (global, app-level) — User connects to external platforms (GitHub, GitLab, Forgejo, Linear, Jira Cloud, Azure DevOps) once. Credentials stored in OS keychain keyed by integration ID. Non-secret metadata (instance URL, email, display name) stored in a global SQLite table. Not project-scoped.

2. **Ticketing Configuration** (project-level) — Each project picks which connected integration to use, then sets project-specific fields (owner/repo, project_key, team_id). Stored in `.maestro/settings.json` (extends existing `ProjectConfig` struct — same file that holds `default_agent`/`default_model`).

**This is an architectural refactor of Phase 54's project-scoped approach.** Phase 54 made everything project-scoped (`maestro:<project_id>:ticketing` keychain key). This phase splits that into global credentials + per-project configuration, following the existing SSH connections pattern.

</domain>

<decisions>
## Implementation Decisions

### Architecture: Global vs Project Split

- **D-01:** Integrations are global (app-level). No SQLite table. All connection info stored as a JSON blob in OS keyring, one entry per provider.
- **D-02:** Keyring key format: `maestro:integration:<provider>` (e.g. `maestro:integration:github`, `maestro:integration:jira_cloud`). JSON blob contains token + any provider-global metadata (instance_url, email, etc.).
- **D-03:** Discovery: UI calls a handler that probes all 6 known provider keys in keyring, returns which are connected (no DB scan needed).
- **D-04:** Project-specific ticketing config stored in `.maestro/settings.json` (extends existing `ProjectConfig` struct). Contains: which provider to use + project-specific fields only. No separate `ticketing.json`.
- **D-05:** Phase 54's per-project handlers (`saveGithubCredentials(projectId, ...)`) will be rewritten to this new split model.

### What's Global vs Project-Specific per Provider

- **D-06: GitHub** — Global: PAT. Project: owner, repo.
- **D-07: GitLab** — Global: instance_url, PAT. Project: project_path (or project_id).
- **D-08: Forgejo** — Global: instance_url, PAT. Project: owner, repo.
- **D-09: Linear** — Global: API key. Project: team_id.
- **D-10: Jira Cloud** — Global: site_url, email, API token. Project: project_key.
- **D-11: Jira Server** — DROPPED. Removed in Phase 54 (Atlassian EOL). Not included in Phase 55.
- **D-12: Azure DevOps** — Global: org_url, PAT. Project: project name.

### Settings UI Layout

- **D-13:** Project settings page uses stacked cards layout (Proposal A — extend existing pattern). New "Ticketing" card below "Agent & Model" card.
- **D-14:** Integrations management lives in a separate location (global settings / app-level), NOT in project settings. Project settings only shows a picker from connected integrations + project-specific fields.

### Project Ticketing Configuration UX (project settings)

- **D-15:** Inline card picker + inline fields. Only connected integrations shown as cards. Click card → fields expand inline (others dim) → save → configured state shows provider card with `owner/repo` detail + Change/Remove buttons. "Change" returns to card selection. "Remove" clears config. No dropdown, no dialog.

### Integrations Management UI (global)

- **D-16:** Tabbed view on pre-project connection screen. Connection screen gets tabs: "Connections" (existing SSH/WSL list) and "Integrations" (ticketing providers). Same card/list visual style as current ConnectionList. No integration management from within opened projects.

### Integrations Tab UX

- **D-17:** 2-column grid showing all 6 providers. Not connected = card with provider icon + name + `+` icon button (opens dialog with provider-specific fields). Connected = green-tinted card + ✓ check + `×` icon button to disconnect.
- **D-18:** GitHub gh CLI auto-detect: on tab load, probe `gh auth token`. If valid → auto-add GitHub as connected with "gh cli" badge. × button disabled with tooltip "Managed by gh auth CLI". If gh CLI not detected/logged in, GitHub shows `+` for manual PAT entry like other providers.

### Cascade: Integration Removed While Project Configured

- **D-19:** If project has ticketing configured but integration is missing/invalid (removed, expired, etc.), interrupt project opening. Show prompt asking user to either fix the integration or drop ticketing config from project settings to continue.

### Claude's Discretion

- Schema migration approach (destructive v16→v17 is acceptable per project conventions)
- Internal code organization (new files vs extending existing)
- Test connection implementation details

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Prior Phase Context
- `.planning/phases/53-api-key-auth/53-CONTEXT.md` — OAuth dropped, PAT for all providers, gh CLI auto-detect for GitHub
- `.planning/phases/54-linear-jira-azdo/54-CONTEXT.md` — IPC signatures (to be refactored), external_id formats, fetch_remote_issues behavior

### Architecture Patterns
- `src-tauri/src/db/schema.rs` — Current schema (v15), SSH connections table as model for global integrations
- `src-tauri/src/ipc/ssh_handlers.rs` — Pattern: global resource CRUD (save/get/delete SSH connection)
- `src-tauri/src/project_storage.rs` — `.maestro/` file read/write pattern

### Current Ticketing Implementation (to be refactored)
- `src-tauri/src/ipc/ticketing_handlers.rs` — All current handlers (project-scoped, will be split)
- `src-tauri/src/ticketing/keychain.rs` — Current keychain storage (project-scoped key format)
- `src-tauri/src/ticketing/` — Provider fetch implementations (GitHub, GitLab, Forgejo, Linear, Jira, AzDO)

### Frontend
- `src/components/common/SettingsPage.tsx` — Current settings page (Agent & Model card)
- `src/services/execution.service.ts` — TanStack Query hook pattern to follow
- `src/types/bindings.ts` — Current TypeScript bindings (ProviderConfig enum, TicketingConfig)

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- SSH connections CRUD pattern (`ssh_handlers.rs`): Direct model for integrations CRUD handlers
- `TokenManager` in `ticketing/keychain.rs`: Reuse keychain read/write logic, change key format
- `SettingsPage.tsx` form pattern: react-hook-form + Controller + TanStack Query
- shadcn/ui Select, Dialog components: Available for picker and connect flows

### Established Patterns
- Global resources in SQLite table → project references via FK or config file
- Keychain: `keyring` crate with file-fallback encryption
- Project config: serde JSON in `.maestro/*.json` via `project_storage.rs`
- IPC: `#[tauri::command]` → service function → TanStack Query hook

### Integration Points
- `fetchRemoteIssues(projectId)` must look up integration_id from project config → get token from global keychain → call provider API
- Schema migration v15→v16: add `integrations` table, potentially modify or drop project-scoped ticketing columns
- Frontend: new hooks for `listIntegrations()`, `createIntegration()`, `deleteIntegration()`, `testIntegration()`
- Project settings: new hook for `getProjectTicketingConfig()`, `setProjectTicketingConfig()`

</code_context>

<specifics>
## Specific Ideas

- Follow SSH connections pattern exactly: global table, project references by ID, ON DELETE SET NULL semantics
- Integrations could also cover "code repository platforms" in future (not just ticketing) — keep the model generic enough
- GitHub gh CLI auto-detect still applies at integration creation time (not per-project)

</specifics>

<deferred>
## Deferred Ideas

- Code repository integrations (same global pattern, different config) — future phase
- OAuth flows — explicitly dropped in Phase 53, PAT only
- Import modal + change detection — Phase 56

</deferred>

---

*Phase: 55-settings-ui*
*Context gathered: 2026-05-22*
