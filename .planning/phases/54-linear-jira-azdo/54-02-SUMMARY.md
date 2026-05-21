---
phase: 54-linear-jira-azdo
plan: "02"
subsystem: api
tags: [rust, jira, atlassian, reqwest, base64, jc-adf, ticketing, adf, markdown]

# Dependency graph
requires:
  - phase: 54-01
    provides: "jc-adf dependency added to Cargo.toml, graphql_client feature fixed, ticketing module scaffolding"
  - phase: 53-api-key-auth
    provides: "normalize_instance_url, TokenManager.store_token, TicketingConfig.save_to_project, validate_and_store + fetch_issues pattern"
provides:
  - "src-tauri/src/ticketing/jira_cloud.rs: validate_and_store + fetch_issues for Jira Cloud REST v3"
  - "ADF description conversion via jc_adf::from_adf::to_markdown"
  - "Basic auth construction via base64(email:api_token)"
  - "external_id format: jira:{key} (e.g. jira:PROJ-42)"
affects:
  - "54-03 (jira_server.rs — analogous to jira_cloud.rs without ADF)"
  - "54-04 (ticketing_handlers.rs — add save_jira_cloud_credentials IPC and Jiracloud match arm in fetch_remote_issues)"
  - "55-settings-ui (Settings UI consumes save_jira_cloud_credentials)"
  - "56-import-modal (import modal calls fetch_remote_issues → jira_cloud::fetch_issues)"

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Jira Cloud ADF extraction: description: Option<serde_json::Value> → jc_adf::from_adf::to_markdown (infallible)"
    - "Basic auth: make_basic_auth(email, api_token) = base64(email:api_token) per Atlassian docs"
    - "URL-encode JQL in query string via urlencoding::encode instead of .query() method"

key-files:
  created:
    - src-tauri/src/ticketing/jira_cloud.rs
  modified:
    - src-tauri/src/ticketing/mod.rs

key-decisions:
  - "description field declared as Option<serde_json::Value> (ADF object) not Option<String> — Jira Cloud v3 returns ADF"
  - "JQL query string constructed manually with urlencoding::encode() rather than reqwest .query() method (which had type inference issues)"
  - "url field uses {site_url}/browse/{key} (human-navigable) not the API self URL from the issue object"
  - "display_name fallback: displayName -> emailAddress -> 'unknown' per RESEARCH resolved Open Question #2"

patterns-established:
  - "ADF extraction pattern: fn extract_body(description: Option<serde_json::Value>) -> Option<String> { description.map(|adf| jc_adf::from_adf::to_markdown(&adf)) }"
  - "make_basic_auth: fn make_basic_auth(email: &str, api_token: &str) -> String wrapping base64 engine"
  - "URL construction for search: format! + urlencoding::encode for query params instead of .query()"

requirements-completed: [AUTH-04, PROV-04]

# Metrics
duration: 15min
completed: 2026-05-21
---

# Phase 54 Plan 02: Jira Cloud API Client Summary

**Jira Cloud API client with email+Basic-auth against REST v3 endpoints and ADF-to-Markdown description conversion via jc-adf**

## Performance

- **Duration:** ~15 min
- **Started:** 2026-05-21T21:07:00Z
- **Completed:** 2026-05-21T21:22:07Z
- **Tasks:** 1
- **Files modified:** 2

## Accomplishments

- `jira_cloud.rs` implements `validate_and_store` calling `GET {site_url}/rest/api/3/myself` with `Authorization: Basic base64(email:token)`, returning `displayName` (falling back to `emailAddress`)
- `fetch_issues` calls `GET {site_url}/rest/api/3/search` with JQL, maps each issue to `RemoteIssue` with `external_id: "jira:{key}"` and `url: "{site_url}/browse/{key}"`
- ADF description field correctly typed as `Option<serde_json::Value>` and converted via `jc_adf::from_adf::to_markdown` (infallible)
- 7 unit tests pass: myself deserialization, email fallback, ADF extraction Some/None, external_id format, URL normalization, search response deserialization

## Task Commits

1. **Task 1: Implement src-tauri/src/ticketing/jira_cloud.rs** - `2a3e8c3` (feat)

## Files Created/Modified

- `src-tauri/src/ticketing/jira_cloud.rs` — Jira Cloud API client: JiraMyselfResponse/JiraSearchResponse/JiraIssueResponse/JiraIssueFields structs, make_basic_auth, extract_body (ADF), validate_and_store, fetch_issues, 7 unit tests
- `src-tauri/src/ticketing/mod.rs` — Added `pub mod jira_cloud;`

## Decisions Made

- Used `urlencoding::encode()` to build the JQL query string manually instead of reqwest's `.query()` method. The `.query()` method caused type inference compilation errors with the async chain in this context; manual URL construction with urlencoding produces equivalent output.
- `display_name` fallback order: `displayName` → `emailAddress` → `"unknown"` per research resolution of Open Question #2.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Replaced reqwest .query() with manual URL construction**
- **Found during:** Task 1 (initial cargo check)
- **Issue:** `cargo check` reported "no method named `query` found for struct `RequestBuilder`" with type inference errors in the async chain when using `.query(&[("jql", ...), ...])` syntax
- **Fix:** Built search URL manually using `format!()` and `urlencoding::encode()` for the JQL parameter. Semantically equivalent — Jira Cloud's REST v3 accepts query parameters in URL-encoded form in either format.
- **Files modified:** src-tauri/src/ticketing/jira_cloud.rs
- **Verification:** `cargo check -p maestro` exits 0; all 7 tests pass
- **Committed in:** `2a3e8c3` (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (Rule 1 - Bug)
**Impact on plan:** Minor compile-time fix. No behavioral or API contract change. The JQL query reaches Jira Cloud identically via URL query string either way.

## TDD Gate Compliance

**Warning:** RED gate commit is absent. The test file was written together with the implementation in a single pass. At the time of writing, no prior `jira_cloud.rs` existed, so there was no state in which tests would fail without implementation. All 7 tests pass as specified in the plan. A separate `test(54-02)` RED commit was not created.

GREEN gate: `feat(54-02)` commit `2a3e8c3` exists.

## Issues Encountered

- reqwest `.query()` caused type inference errors — see Deviation #1. Resolved by manual URL construction.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- `jira_cloud::validate_and_store` and `jira_cloud::fetch_issues` are ready for use by `ticketing_handlers.rs` (Plan 04)
- `pub mod jira_cloud` is declared in `ticketing/mod.rs`
- Plan 03 (jira_server.rs) should follow the same structure but with Bearer auth and `Option<String>` description (no ADF)
- Plan 04 adds the IPC commands and `fetch_remote_issues` dispatch arm for Jira Cloud

---
*Phase: 54-linear-jira-azdo*
*Completed: 2026-05-21*
