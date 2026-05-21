---
phase: 53-api-key-auth
plan: "01"
subsystem: ticketing
tags: [rust, ticketing, github, gitlab, forgejo, pat-auth, ipc, specta]
dependency_graph:
  requires: [52-token-management]
  provides: [ticketing-provider-auth, remote-issue-fetch]
  affects: [src/types/bindings.ts, src-tauri/src/ipc/ticketing_handlers.rs]
tech_stack:
  added: [reqwest-0.13, which, urlencoding, tokio::process]
  patterns: [per-call reqwest client, gh-cli-auto-detect, specta-type-override]
key_files:
  created:
    - src-tauri/src/ticketing/github.rs
    - src-tauri/src/ticketing/gitlab.rs
    - src-tauri/src/ticketing/forgejo.rs
  modified:
    - src-tauri/src/models/ticketing.rs
    - src-tauri/src/models/mod.rs
    - src-tauri/src/ticketing/mod.rs
    - src-tauri/src/ipc/ticketing_handlers.rs
    - src-tauri/src/lib.rs
    - src/types/bindings.ts
decisions:
  - "Used specta(type = i32) override on GitLabConfig.project_id (i64 in Rust, number in TypeScript) to satisfy specta's BigIntForbidden constraint"
  - "Three separate provider files (github.rs, gitlab.rs, forgejo.rs) with per-call reqwest::Client — no shared singleton needed for low-frequency ticketing calls"
  - "GitLab validate_and_store makes two API calls: /api/v4/user (auth) + /api/v4/projects/{path} (resolve numeric project_id) to satisfy locked external_id format"
metrics:
  duration: "~25 minutes"
  completed: "2026-05-21T16:56:04Z"
  tasks_completed: 3
  files_changed: 9
---

# Phase 53 Plan 01: GitHub/GitLab/Forgejo PAT Auth + API Clients Summary

**One-liner:** PAT-based GitHub/GitLab/Forgejo authentication with gh CLI auto-detect, numeric project_id resolution, and 5 IPC commands for provider connect/disconnect/issue-fetch.

## Tasks Completed

| Task | Name | Commit | Key Files |
|------|------|--------|-----------|
| 1 | Update ProviderConfig enum and add RemoteIssue struct | c5c148b | models/ticketing.rs, models/mod.rs, lib.rs |
| 2 | Create github.rs, gitlab.rs, forgejo.rs provider modules | a1e1ad7 | ticketing/github.rs, gitlab.rs, forgejo.rs, mod.rs |
| 3 | Add 5 IPC commands and register in lib.rs | 65b85e3 | ipc/ticketing_handlers.rs, lib.rs, models/ticketing.rs, bindings.ts |

## Verification Results

- `cargo check -p maestro`: exit 0, no errors
- `cargo test -p maestro -- ticketing`: 26 passed, 1 ignored (keychain test requires OS keychain)
- `pnpm tauri:gen`: exit 0
- `bindings.ts` contains: `RemoteIssue`, `ForgejoConfig`, `JiraCloudConfig`, `JiraServerConfig`, `AzureDevOpsConfig`, all 5 new IPC command signatures

## Implementation Details

### ProviderConfig (7 variants)

Replaced the 4-variant enum (`Jira`, `GitHub`, `GitLab`, `Linear`) with:
- `Github(GitHubConfig)`, `Gitlab(GitLabConfig)`, `Forgejo(ForgejoConfig)` — active in this phase
- `Linear(LinearConfig)`, `Jiracloud(JiraCloudConfig)`, `Jiraserver(JiraServerConfig)`, `Azuredevops(AzureDevOpsConfig)` — stubs for Phase 54

`#[serde(rename_all = "lowercase")]` serializes `JiraCloud` → `"jiracloud"` in JSON. This is consistent with the existing approach.

### Provider Module Structure

Each provider file (`github.rs`, `gitlab.rs`, `forgejo.rs`) follows the same structure:
1. Private deserialization structs for API responses
2. `normalize_instance_url` helper (gitlab.rs, forgejo.rs only)
3. `validate_and_store` — validates PAT via provider API, saves TicketingConfig, stores token
4. `fetch_issues` — fetches open issues, maps to `Vec<RemoteIssue>`
5. `#[cfg(test)] mod tests` — unit tests covering normalization, deserialization, filtering, external_id formats

### GitHub Auto-Detect

`try_gh_cli_token()` checks `which::which("gh")` first (avoids spawning a process unnecessarily), then runs `gh auth token` via `TokioCommand`. Token is never logged. Returned as `Option<String>` — never returns `Err`.

### GitLab Numeric Project ID

`validate_and_store` makes two sequential API calls:
1. `GET /api/v4/user` — validates token, returns username
2. `GET /api/v4/projects/{urlencoded_path}` — resolves numeric `id` field

The numeric ID is stored in `GitLabConfig.project_id: i64` for use in `external_id` format (`gitlab:{project_id}/{iid}`) and the issues endpoint URL.

### External ID Formats

- GitHub: `github:42`
- GitLab: `gitlab:12345/7` (numeric project_id / issue iid)
- Forgejo: `forgejo:42`

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] specta BigIntForbidden on GitLabConfig.project_id**

- **Found during:** Task 3 (pnpm tauri:gen)
- **Issue:** specta 2.0.0-rc.20 forbids `i64` fields on exported types because JavaScript lacks native 64-bit integers. `GitLabConfig.project_id: i64` caused `pnpm tauri:gen` to panic with `BigIntForbidden`.
- **Fix:** Added `#[specta(type = i32)]` attribute on the field. The Rust type remains `i64` (full precision for ID storage and arithmetic), while TypeScript sees `number`. GitLab project IDs fit well within i32 range in practice.
- **Files modified:** `src-tauri/src/models/ticketing.rs`
- **Commit:** 65b85e3

## Known Stubs

The following ProviderConfig variants are stub structs with no provider implementation (Phase 54 scope):
- `JiraCloudConfig` — fields present, no IPC commands
- `JiraServerConfig` — fields present, no IPC commands
- `AzureDevOpsConfig` — fields present, no IPC commands
- `LinearConfig` — field present (team_id: Option<String>), no IPC commands

`fetch_remote_issues` returns `Err("Provider not yet supported in this phase")` for all four. This is intentional and documented.

## Threat Model Compliance

All mitigations from the threat register were implemented:
- **T-53-01** (token disclosure): `try_gh_cli_token` token never logged; stored only via `TokenManager`
- **T-53-02** (instance_url spoofing): `normalize_instance_url` enforces `https://` by default; explicit `http://` preserved
- **T-53-03** (project_id elevation): DB query validates `project_id` before token access; no cross-project leakage
- **T-53-04** (DoS): All `reqwest::Client` instances built with `.timeout(Duration::from_secs(15))`
- **T-53-06** (path traversal): `urlencoding::encode(project_path)` applied before embedding in GitLab URL

## Self-Check: PASSED

Files verified:
- `src-tauri/src/ticketing/github.rs`: FOUND
- `src-tauri/src/ticketing/gitlab.rs`: FOUND
- `src-tauri/src/ticketing/forgejo.rs`: FOUND
- `src-tauri/src/models/ticketing.rs`: FOUND (7 variants, RemoteIssue struct)
- `src/types/bindings.ts`: FOUND (RemoteIssue, ForgejoConfig, all 5 commands)

Commits verified:
- c5c148b (Task 1): FOUND
- a1e1ad7 (Task 2): FOUND
- 65b85e3 (Task 3): FOUND
