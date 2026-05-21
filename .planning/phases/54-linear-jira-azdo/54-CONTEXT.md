---
phase: 54-linear-jira-azdo
created: 2026-05-21
---

# Phase 54: Linear/Jira/AzDO Auth + API Clients - Context

**Gathered:** 2026-05-21
**Status:** Ready for planning

<domain>
## Phase Boundary

Add four new PAT/API-key provider modules — Linear (GraphQL), Jira Cloud (email + API token, REST v3), Jira Server (PAT/Bearer, REST v2), Azure DevOps (PAT, work items API). Each module follows the Phase 53 pattern: `validate_and_store()` + `fetch_issues()`. Phase 54 also adds `list_linear_teams()` IPC so Phase 55 can render a team picker.

Does NOT include: Settings UI (Phase 55), import modal (Phase 56), any OAuth flows (dropped in Phase 53).

</domain>

<decisions>
## Implementation Decisions

### Azure DevOps work item scope
- **D-01:** Fetch all work item types in the project (no type filter). User filters by label/type in Phase 56 import modal.
- **D-02:** Use WIQL to query open work items: `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = '{project}' AND [System.State] <> 'Closed'`. No configurable WIQL — fixed query sufficient for v1.6.

### Linear team scope
- **D-03:** `save_linear_credentials(project_id, api_key)` validates via `{ viewer { id name } }` and stores token. Does NOT require team at connect time.
- **D-04:** Phase 54 adds `list_linear_teams(project_id) -> Result<Vec<LinearTeam>, String>` IPC command returning `{ id, name, key }` per team. Phase 55 consumes this to show a team picker in Settings.
- **D-05:** `fetch_remote_issues` with `team_id = None` fetches all workspace issues; `team_id = Some(id)` filters to that team via GraphQL `filter: { team: { id: { eq: $teamId } } }`.

### Jira ADF body conversion
- **D-06:** Use `jc-adf` Rust crate for ADF → Markdown conversion. Add to `src-tauri/Cargo.toml`. Call `jc_adf::from_adf::to_markdown()` on the ADF JSON body field.
- **D-07:** If ADF parse/conversion fails (malformed or unsupported node types), fall back to `None` body rather than surfacing an error. Title is always available; body failure should not block issue import.

### Jira module structure
- **D-08:** Two separate files: `src-tauri/src/ticketing/jira_cloud.rs` and `src-tauri/src/ticketing/jira_server.rs`. Auth differs (Basic vs Bearer), endpoints differ (REST v3 vs v2) — shared helpers (ADF conversion, pagination) extracted to a private `jira_common` block or inline helpers. No `jira_common.rs` file — keep shared logic minimal and inline in each module.

### IPC command signatures (all new in this phase)
- **D-09:** `save_linear_credentials(project_id: i32, api_key: String) -> Result<String, String>` — returns display name
- **D-10:** `list_linear_teams(project_id: i32) -> Result<Vec<LinearTeam>, String>` — `LinearTeam { id, name, key }`
- **D-11:** `save_jira_cloud_credentials(project_id: i32, site_url: String, email: String, api_token: String, project_key: String) -> Result<String, String>` — returns display name
- **D-12:** `save_jira_server_credentials(project_id: i32, base_url: String, project_key: String, token: String) -> Result<String, String>` — returns display name
- **D-13:** `save_azure_devops_credentials(project_id: i32, org_url: String, project: String, token: String) -> Result<String, String>` — returns display name
- **D-14:** Existing `fetch_remote_issues(project_id: i32)` dispatches to all four new providers via new match arms — no new top-level IPC needed.
- **D-15:** Existing `delete_ticketing_credentials(project_id: i32)` already handles all providers — no changes needed.

### Claude's Discretion
- GraphQL client structure for Linear: use `graphql_client` crate's `graphql!` macro for inline query definitions (no `.graphql` schema file required for small query surface)
- Pagination: same approach as Phase 53 — single-page fetch with `per_page=100` or equivalent limit; no cursor pagination for v1.6
- Error message format: mirror Phase 53 pattern (`"Linear: ..."`, `"Jira Cloud: ..."`, etc.)
- Jira Cloud `site_url` normalization: apply `normalize_instance_url()` from `ticketing/mod.rs`
- Azure DevOps `org_url` normalization: same helper

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase 53 patterns (the template this phase follows)
- `src-tauri/src/ticketing/github.rs` — reference implementation: validate_and_store + fetch_issues pattern, reqwest usage, token manager calls
- `src-tauri/src/ticketing/gitlab.rs` — reference for self-hosted URL normalization and project_id resolution
- `src-tauri/src/ticketing/mod.rs` — normalize_instance_url() helper, module re-exports
- `src-tauri/src/ipc/ticketing_handlers.rs` — IPC handler pattern: project path lookup, validate_and_store delegation, fetch_remote_issues dispatch

### Models (locked shapes)
- `src-tauri/src/models/ticketing.rs` — ProviderConfig enum (7 variants, all Phase 54 stubs already defined), RemoteIssue struct, LinearConfig/JiraCloudConfig/JiraServerConfig/AzureDevOpsConfig structs

### Token management
- `src-tauri/src/ticketing/token_manager.rs` — store_token, get_token, delete_token
- `src-tauri/src/ticketing/keychain.rs` — KeychainStore implementation

### External ID formats (locked, must not change)
- `.planning/phases/53-api-key-auth/53-CONTEXT.md` §External ID Formats — `linear:{identifier}`, `jira:{issue_key}`, `azuredevops:{id}`

### Dependency config
- `src-tauri/Cargo.toml` — `graphql_client = { version = "0.16", default-features = false, features = ["reqwest"] }` already present; add `jc-adf` for ADF conversion

### Phase context
- `.planning/ROADMAP.md` §Phase 54 — success criteria for each provider
- `.planning/REQUIREMENTS.md` §PROV-03, PROV-04, AUTH-03, AUTH-04 — note: AUTH-03/04 reference OAuth (stale); actual auth approach is PAT/API key per Phase 53 pivot

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `ticketing::normalize_instance_url()` — already in mod.rs, use for Jira Server and Azure DevOps base URL normalization
- `TokenManager::store_token / get_token` — same call signature as Phase 53 modules
- `TicketingConfig::save_to_project / load_from_project` — same pattern for writing provider config
- `now_rfc3339()` from `models/project_config.rs` — for TicketingConfig.updated_at

### Established Patterns
- Module structure: `validate_and_store(project_id, ...params, project_path, app_state) -> Result<String, String>` + `fetch_issues(project_id, config, app_state) -> Result<Vec<RemoteIssue>, String>`
- IPC handler: drop Mutex lock in scoped block before `.await`; delegate to `ticketing::{module}::validate_and_store`
- `fetch_remote_issues` dispatch: match on `ProviderConfig` variant, call module `fetch_issues`
- Error prefix: `"<ProviderName>: <message>"` format for user-facing errors
- Unit tests: each module gets inline `#[cfg(test)]` tests for URL normalization, response deserialization, external_id format, PR/issue filtering

### Integration Points
- `src-tauri/src/ipc/ticketing_handlers.rs` — add 5 new commands (D-09 through D-13), add 4 new match arms to `fetch_remote_issues`
- `src-tauri/src/ticketing/mod.rs` — add `pub mod linear; pub mod jira_cloud; pub mod jira_server; pub mod azure_devops;`
- `src-tauri/src/lib.rs` — register new commands in `collect_commands![]`
- `src/types/bindings.ts` — regenerate via `pnpm tauri:gen` after adding LinearTeam type

</code_context>

<specifics>
## Specific Ideas

- `jc-adf` crate for ADF → Markdown: `jc_adf::from_adf::to_markdown(adf_value)` — fall back to `None` on error (D-06, D-07)
- `list_linear_teams` returns `Vec<LinearTeam>` where `LinearTeam { id: String, name: String, key: String }` — must be exported to TypeScript bindings via `#[derive(Type)] #[specta(export)]`
- Linear GraphQL uses `graphql_client` inline macro — no `.graphql` file needed for 2-query surface (viewer validation + issues fetch)
- Azure DevOps Basic auth: base64-encode `:{token}` (empty username) per AzDO PAT docs
- Jira Cloud validation: `GET {site_url}/rest/api/3/myself` with `Authorization: Basic base64(email:token)`
- Jira Server validation: `GET {base_url}/rest/api/2/myself` with `Authorization: Bearer {token}`
- Azure DevOps validation: `GET {org_url}/_apis/connectionData?api-version=7.1` with Basic auth

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>

---

*Phase: 54-linear-jira-azdo*
*Context gathered: 2026-05-21*
