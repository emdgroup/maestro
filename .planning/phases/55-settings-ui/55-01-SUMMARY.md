---
phase: 55-settings-ui
plan: "01"
subsystem: rust-backend
tags:
  - ticketing
  - integration
  - keychain
  - ipc
  - refactor
dependency_graph:
  requires:
    - 54-linear-jira-azdo (keychain.rs, token_manager.rs, provider API clients)
  provides:
    - IntegrationStatus IPC type
    - CredentialSource IPC type
    - ProjectTicketingConfig IPC type
    - list_integrations handler
    - save_integration handler
    - delete_integration handler
    - test_integration handler
    - get_project_ticketing_config handler
    - save_project_ticketing_config handler
    - fetch_remote_issues (rewritten for global keychain)
  affects:
    - src-tauri/src/ipc/
    - src-tauri/src/models/
    - src-tauri/src/ticketing/
    - src/types/bindings.ts
tech_stack:
  added: []
  patterns:
    - Provider-keyed global keychain (maestro:integration:{provider})
    - IntegrationCredentials as internal-only type (no #[specta(export)])
    - KNOWN_PROVIDERS allowlist for IPC input validation
key_files:
  created:
    - src-tauri/src/models/integration.rs
    - src-tauri/src/ipc/integration_handlers.rs
  modified:
    - src-tauri/src/models/mod.rs
    - src-tauri/src/models/project_config.rs
    - src-tauri/src/ticketing/keychain.rs
    - src-tauri/src/ipc/ticketing_handlers.rs
    - src-tauri/src/ipc/mod.rs
    - src-tauri/src/lib.rs
    - src-tauri/src/ipc/project_handlers.rs
    - src/types/bindings.ts
decisions:
  - "Kept legacy store_token/get_token/delete_token in keychain.rs alongside new provider-keyed methods — TokenManager in AppState still references them; removing requires architectural AppState change"
  - "GitLab project_id stored in ProjectTicketingConfig.project_key as a string — this avoids adding a new i64 field and reuses existing optional field; callers must parse to i64"
  - "Old provider validate_and_store functions retained (github.rs, gitlab.rs, etc.) as unused dead code — safe since no caller registers them anymore; cleanup deferred to a future phase"
metrics:
  duration: "~40 minutes"
  completed: "2026-05-23"
  tasks_completed: 2
  files_changed: 10
---

# Phase 55 Plan 01: Integration Model and Global Keychain Backend Summary

Global credential model for 7 ticketing providers — per-project token storage replaced with provider-keyed global keychain under `maestro:integration:{provider}` key. 4 new IPC handlers for integration CRUD. TypeScript bindings updated with IntegrationStatus, CredentialSource, ProjectTicketingConfig types.

## What Was Built

### Task 1: Integration model + provider-keyed keychain

Created `src-tauri/src/models/integration.rs` with three types:
- `IntegrationStatus` — returned over IPC, never contains raw token (T-55-01 compliance)
- `CredentialSource` — Manual vs GhCli enum, exported to TypeScript
- `IntegrationCredentials` — internal-only storage type, NOT exported to TypeScript

Extended `src-tauri/src/models/project_config.rs`:
- Added `ProjectTicketingConfig` struct (7 optional fields: provider, owner, repo, project_path, team_id, project_key, project_name)
- Added `ticketing: Option<ProjectTicketingConfig>` field to `ProjectConfig` (backward-compatible via `#[serde(default)]`)

Rewrote `src-tauri/src/ticketing/keychain.rs`:
- Added new `store_integration` / `get_integration` / `delete_integration` methods keyed by provider string (`maestro:integration:{provider}`)
- New file fallback uses `{provider}.enc` filename instead of `{project_id}.enc`
- Kept legacy `store_token` / `get_token` / `delete_token` methods for `TokenManager` backward compatibility
- Added 10 new unit tests for the provider-keyed file roundtrip

### Task 2: Integration IPC handlers + ticketing rewrite

Created `src-tauri/src/ipc/integration_handlers.rs` with 4 `#[tauri::command]` handlers:
- `list_integrations` — probes all 7 provider keys, special gh CLI fallback for GitHub
- `save_integration` — validates via provider API, stores globally (KNOWN_PROVIDERS allowlist per T-55-02)
- `delete_integration` — removes from keyring and file fallback
- `test_integration` — validates credentials without storing

Private `validate_credentials` helper implements API calls for all 7 providers with:
- 15-second timeout (T-55-03)
- `normalize_instance_url()` on all instance URLs (T-55-03)
- Provider-specific auth headers and response parsing

Rewrote `src-tauri/src/ipc/ticketing_handlers.rs` with 3 handlers replacing 9 old ones:
- `get_project_ticketing_config` — reads ticketing field from `.maestro/settings.json`
- `save_project_ticketing_config` — writes ticketing field to `.maestro/settings.json`
- `fetch_remote_issues` — reads credentials from global keychain, project fields from `ProjectTicketingConfig`

Removed from `lib.rs`: `get_ticketing_config`, `save_ticketing_config`, `save_github_credentials`, `save_gitlab_credentials`, `save_forgejo_credentials`, `delete_ticketing_credentials`, `save_linear_credentials`, `list_linear_teams`, `save_jira_cloud_credentials`, `save_azure_devops_credentials` (10 handlers removed, 7 new registered).

Ran `pnpm tauri:gen` — TypeScript bindings updated with `IntegrationStatus`, `CredentialSource`, `ProjectTicketingConfig` types.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed project_handlers.rs struct literal missing ticketing field**
- **Found during:** Task 1 cargo check
- **Issue:** `ProjectConfig` gained a new `ticketing` field but project_handlers.rs constructed it with a struct literal omitting that field, causing E0063
- **Fix:** Added `ticketing: None` to the struct literal in `update_project_settings` handler
- **Files modified:** `src-tauri/src/ipc/project_handlers.rs`
- **Commit:** 177f3da (Task 1 commit)

## Threat Surface Scan

All threat flags from the plan's threat register are addressed:

| Flag | File | Mitigation |
|------|------|------------|
| T-55-01 Information Disclosure | integration_handlers.rs | `IntegrationCredentials` has no `#[specta(export)]`; only `IntegrationStatus` returned over IPC |
| T-55-02 Tampering (provider param) | integration_handlers.rs | `KNOWN_PROVIDERS` allowlist check before any keychain operation in `save_integration` |
| T-55-03 SSRF (instance_url) | integration_handlers.rs | `normalize_instance_url()` called on all instance URLs; 15s request timeout |

No new threat surface introduced beyond what is in the plan's threat register.

## Self-Check: PASSED

| Item | Status |
|------|--------|
| `src-tauri/src/models/integration.rs` | FOUND |
| `src-tauri/src/ipc/integration_handlers.rs` | FOUND |
| `.planning/phases/55-settings-ui/55-01-SUMMARY.md` | FOUND |
| Task 1 commit `177f3da` | FOUND |
| Task 2 commit `d2a8af3` | FOUND |
| `cargo check` passes | PASSED (0 errors) |
| `cargo test -p maestro` | 75 passed, 1 ignored |
| TypeScript bindings regenerated | IntegrationStatus, ProjectTicketingConfig, CredentialSource present |
