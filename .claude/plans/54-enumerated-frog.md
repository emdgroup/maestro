# Execution Plan: Phase 54 — Linear/Jira Cloud/AzDO Auth + API Clients

## Context

Phase 54 adds three Rust provider modules (Linear GraphQL, Jira Cloud REST v3, Azure DevOps WIQL). **Jira Server dropped** — Atlassian announced end-of-support; only Jira Cloud remains.

Config: `parallelization: false`, `mode: "yolo"`, `branching_strategy: "none"`, `verifier: true`, `commit_docs: false`.

## Scope Change from Original Plans

**Dropped:** `jira_server.rs` module entirely. This affects:
- **Plan 54-03:** Remove Task 1 (jira_server.rs). Only Task 2 (azure_devops.rs) remains.
- **Plan 54-04:** Remove all jira_server references:
  - `pub mod jira_server;` NOT added to mod.rs (3 modules instead of 4)
  - `save_jira_server_credentials` handler NOT created (4 IPC commands instead of 5)
  - `ProviderConfig::Jiraserver` match arm NOT added to fetch_remote_issues
  - `crate::ipc::save_jira_server_credentials` NOT registered in lib.rs
- **Models:** `JiraServerConfig` and `ProviderConfig::Jiraserver` remain in models (already exist from Phase 51) but are unused — no provider code references them. Can be cleaned up in a future phase if desired.

## Wave Execution (Sequential)

**Wave 1:** Plan 54-01 (Cargo.toml fix + linear.rs) — as-is, no changes
- 2 tasks: fix deps + implement linear.rs
- Gate: `cargo check -p maestro` + `cargo test -p maestro linear`

**Wave 2:** Plans 54-02 + 54-03 (sequential)
- 54-02: implement jira_cloud.rs (1 task) — as-is
- 54-03: implement azure_devops.rs ONLY (1 task, skip jira_server task)
- Gate: `cargo check -p maestro` + `cargo test -p maestro`

**Wave 3:** Plan 54-04 (wiring) — reduced scope
- Wire 3 modules (linear, jira_cloud, azure_devops) into mod.rs
- 4 IPC commands: save_linear_credentials, list_linear_teams, save_jira_cloud_credentials, save_azure_devops_credentials
- 3 new match arms in fetch_remote_issues (Linear, Jiracloud, Azuredevops)
- Keep `_ => Err(...)` catch-all for Jiraserver variant (or match exhaustively with a "provider not supported" for that arm)
- Gate: `cargo check` + `cargo test` + `pnpm tauri:gen`

## Post-Execution

- Code review (advisory)
- Regression gate: `cargo test` full
- Verification: gsd-verifier
- Update STATE.md + ROADMAP.md

## Files Modified (Total: 8)

- `src-tauri/Cargo.toml` — graphql_client feature removal + jc-adf
- `src-tauri/src/ticketing/linear.rs` — new (GraphQL client)
- `src-tauri/src/ticketing/jira_cloud.rs` — new (REST v3 + ADF)
- `src-tauri/src/ticketing/azure_devops.rs` — new (WIQL + batch)
- `src-tauri/src/ticketing/mod.rs` — 3 module declarations
- `src-tauri/src/ipc/ticketing_handlers.rs` — 4 IPC commands + 3 match arms
- `src-tauri/src/lib.rs` — 4 command registrations
- `src/types/bindings.ts` — regenerated

## Success Criteria

- 18 unit tests pass (linear:5 + jira_cloud:7 + azure_devops:6)
- `cargo check -p maestro` exits 0
- `pnpm tauri:gen` succeeds with LinearTeam in bindings.ts
- No jira_server.rs file created
- No reqwest 0.12 in graphql_client dep chain
