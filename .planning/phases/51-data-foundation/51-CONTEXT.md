# Phase 51: Data Foundation - Context

**Gathered:** 2026-05-20
**Status:** Ready for planning

<domain>
## Phase Boundary

Deliver schema V16 + Rust model types + ticketing config storage + removal of legacy import code. No UI, no OAuth, no API calls — pure data plumbing that Phases 52–55 build on.

</domain>

<decisions>
## Implementation Decisions

### Schema Migration
- **D-01:** V16 migration stays **destructive** — drops all tables and recreates. No data preservation. Bump `SCHEMA_VERSION` to 16, document as breaking change.
- **D-02:** The ROADMAP success criteria mentioning "task rows survive migration" is superseded by D-01. That language was aspirational and is not implemented.

### TicketingConfig Structure
- **D-03:** Stored at `.maestro/ticketing.json`, following the same `load_from_project` / `save_to_project` pattern as `models/project_config.rs`.
- **D-04:** `ProviderConfig` is a **serde externally-tagged enum** — the provider name is the discriminator key:
  ```json
  {
    "provider": {
      "jira": {
        "host": "mycompany.atlassian.net",
        "email": "user@company.com",
        "project_key": "PROJ",
        "jql_filter": null
      }
    },
    "updated_at": "2026-05-20T..."
  }
  ```
- **D-05:** `provider: null` when unconfigured (no active provider).
- **D-06:** One active provider at a time. Multi-provider is out of scope.
- **D-07:** Rust model:
  ```rust
  #[derive(Serialize, Deserialize, Type)]
  #[serde(rename_all = "lowercase")]
  enum ProviderConfig {
      Jira(JiraConfig),
      GitHub(GitHubConfig),
      GitLab(GitLabConfig),
      Linear(LinearConfig),
  }

  struct JiraConfig { host, email, project_key, jql_filter: Option<String> }
  struct GitHubConfig { owner, repo }
  struct GitLabConfig { host, project_id }
  struct LinearConfig { team_id }
  ```

### JQL Filter
- **D-08:** `jql_filter: Option<String>` on `JiraConfig`. When `None`, server-side default applied:
  ```
  assignee = currentUser() AND project = {project_key} AND statusCategory != Done
  ```
- **D-09:** Use `statusCategory != Done` (not `status != Done`) — portable across all Jira workflow configurations.

### Token Storage
- **D-10:** API tokens stored in OS keychain via `keyring`, **never** in `ticketing.json`.
- **D-11:** Keychain key format per provider: `maestro:jira:{project_id}`, `maestro:github:{project_id}`, `maestro:gitlab:{project_id}`, `maestro:linear:{project_id}`.
- **D-12:** `ticketing.json` is safe to commit / share — contains no secrets.

### Legacy Code Removal
- **D-13:** Remove from `ipc/settings_handlers.rs`: `sync_github_issues`, `sync_jira_issues`, `save_import_config`, `upsert_imported_tasks`.
- **D-14:** Remove from `lib.rs`: the three legacy command registrations for above functions.
- **D-15:** Remove `src/components/task/ImportSettings.tsx` and its lazy import in `src/App.tsx`.
- **D-16:** Remove or replace `models/sync.rs` types (`SyncResult`, `GitHubIssue`, `JiraIssue`, `JiraFields`, `JiraSearchResponse`) — these are legacy; Phase 54 will introduce new provider-specific response types.

### Tasks Table Cleanup
- **D-17:** `tasks` table retains `external_id`, `is_imported`, `import_source` columns — these are still semantically valid for tracking imported tickets. No column removal needed.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Existing Pattern to Follow
- `src-tauri/src/models/project_config.rs` — canonical pattern for `.maestro/` JSON file load/save; `TicketingConfig` must follow the same structure (`#[serde(default)]`, `#[specta(export)]`, `load_from_project` / `save_to_project`)

### Schema
- `src-tauri/src/db/schema.rs` — current V15 schema; V16 adds no new tables, only bumps version

### Legacy Code to Remove
- `src-tauri/src/ipc/settings_handlers.rs` — contains `sync_github_issues`, `sync_jira_issues`, `save_import_config` (all to be deleted)
- `src-tauri/src/models/sync.rs` — legacy sync types (to be removed or gutted)
- `src-tauri/src/lib.rs` — command registrations to remove
- `src/components/task/ImportSettings.tsx` — UI component to delete
- `src/App.tsx` — lazy import of ImportSettings to remove

### Phase Dependencies
- `.planning/STATE.md` §Decisions — cross-phase decisions locked at roadmap creation (external_id format, keyring version, reqwest pinning)

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `models/project_config.rs` — copy this pattern exactly for `models/ticketing.rs`
- `keyring 3.6.3` — already in `Cargo.toml` with expanded features (apple-native, linux-native-sync-persistent); no new dep needed for D-10 through D-12

### Established Patterns
- New flat module files preferred over `mod.rs` — add `models/ticketing.rs`, not a subdirectory
- `#[serde(default)]` on config structs — required for forward-compatibility when new fields added
- `pnpm tauri:gen` must be run after any Rust model change — regenerates `src/types/bindings.ts`

### Integration Points
- `TicketingConfig` will be read by Phase 52 (token management), Phase 53 (OAuth), Phase 54 (API calls), Phase 55 (import modal)
- Schema V16 migration: add new `SCHEMA_V16` const and bump `SCHEMA_VERSION` in `db/schema.rs`; update `initialize_schema` drop list if any new tables added (none in this phase)

</code_context>

<specifics>
## Specific Ideas

- `TicketingConfig` lives at `src-tauri/src/models/ticketing.rs` (new flat file)
- IPC commands needed in Phase 51: `get_ticketing_config`, `save_ticketing_config` (in `ipc/ticketing_handlers.rs`)
- No UI work — config read/write IPC only; the settings UI panel is Phase 55/56 scope

</specifics>

<deferred>
## Deferred Ideas

- OAuth flow implementation → Phase 53
- Per-provider API clients → Phase 54
- Import modal UI → Phase 55
- Multi-provider support — explicitly out of scope for v1.6

</deferred>

---

*Phase: 51-data-foundation*
*Context gathered: 2026-05-20*
