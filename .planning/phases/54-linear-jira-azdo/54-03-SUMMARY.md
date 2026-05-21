---
phase: 54-linear-jira-azdo
plan: 03
subsystem: api
tags: [rust, azure-devops, reqwest, base64, wiql, workitemsbatch, ticketing]

# Dependency graph
requires:
  - phase: 54-01
    provides: TicketingConfig/ProviderConfig types, normalize_instance_url, token_manager, mod.rs structure
provides:
  - Azure DevOps API client module (azure_devops.rs) with validate_and_store + fetch_issues
  - WIQL + workitemsbatch two-step fetch pattern with 200-item batch chunking
  - Basic auth with empty username for AzDO PAT authentication
affects:
  - 54-04 (IPC handler wiring for save_azure_devops_credentials)
  - 55 (team picker / issue import UI)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "AzDO two-step fetch: POST WIQL for IDs, POST workitemsbatch per 200-item chunk"
    - "AzDO Basic auth: base64(:token) — empty username"
    - "AzDO browser URL: {base}/{project}/_workitems/edit/{id} (not the WIQL url field)"
    - "Tags split on '; ' separator to produce Vec<String> labels"

key-files:
  created:
    - src-tauri/src/ticketing/azure_devops.rs
  modified:
    - src-tauri/src/ticketing/mod.rs

key-decisions:
  - "Jira Server task skipped per explicit scope change — azure_devops.rs only"
  - "Description stored as-is (HTML) per RESEARCH.md Pitfall 5 — no HTML stripping for v1.6"
  - "WIQL query is hardcoded (D-02) — no user injection possible beyond project name string"

patterns-established:
  - "make_azdo_auth helper: fn make_azdo_auth(token: &str) -> String encoding format!(':{}', token)"
  - "WIQL_FIELDS constant: &[&str] of System.* field names reused for all batch requests"
  - "ids.chunks(200) batch loop with per-chunk error handling"

requirements-completed: []

# Metrics
duration: 12min
completed: 2026-05-21
---

# Phase 54 Plan 03: Azure DevOps API Client Summary

**Azure DevOps API client with WIQL + workitemsbatch two-step fetch, Basic auth (empty username), 200-item batch chunking, and browser URL construction**

## Performance

- **Duration:** 12 min
- **Started:** 2026-05-21T00:00:00Z
- **Completed:** 2026-05-21T00:12:00Z
- **Tasks:** 1 (Task 2 only — Task 1 skipped per scope change)
- **Files modified:** 2

## Accomplishments
- `azure_devops.rs` implemented with `validate_and_store` (connectionData validation) and `fetch_issues` (WIQL + batch)
- Two-step fetch pattern: POST WIQL returns IDs, POST workitemsbatch in chunks of 200 returns full details
- All 6 unit tests pass: WIQL deserialization, batch deserialization, external_id format, URL normalization, tags split, ID chunking
- `cargo check -p maestro` exits clean

## Task Commits

1. **Task 2: Implement azure_devops.rs** - `299430f` (feat)

## Files Created/Modified
- `src-tauri/src/ticketing/azure_devops.rs` - Azure DevOps API client: make_azdo_auth, validate_and_store, fetch_issues, 6 unit tests
- `src-tauri/src/ticketing/mod.rs` - Added `pub mod azure_devops;` declaration

## Decisions Made
- Task 1 (jira_server.rs) skipped entirely per objective scope change — Jira Server dropped from this phase
- HTML description stored as-is (no stripping) per RESEARCH.md Pitfall 5 recommendation for v1.6
- WIQL query is a format! call with the project name interpolated — fixed query per D-02, no user-injectable WIQL

## Deviations from Plan

### Scope Change (User-Directed)

**Task 1 skipped — Jira Server dropped from phase**
- The objective explicitly excluded Task 1 (jira_server.rs)
- Only Task 2 (azure_devops.rs) was executed
- SUMMARY.md reflects this reduced scope

---

**Total deviations:** 0 auto-fixed (scope change was user-directed, not a deviation rule trigger)
**Impact on plan:** azure_devops.rs fully implemented as specified. jira_server.rs not created.

## Issues Encountered
None — azure_devops.rs compiled clean on first attempt with all 6 tests passing.

## Threat Surface Scan
No new network endpoints, auth paths, or schema changes beyond those already documented in the plan's threat model (T-54-08, T-54-09, T-54-10). The `azure_devops.rs` module follows the identical threat mitigations:
- `normalize_instance_url()` applied to org_url
- WIQL query is hardcoded — no user-injectable arbitrary WIQL
- Error messages use "Azure DevOps: bad credentials" — token value never echoed

## Known Stubs
None — `validate_and_store` and `fetch_issues` are fully implemented. IPC handler wiring (`save_azure_devops_credentials` command and `fetch_remote_issues` match arm) is NOT part of this plan's scope and remains in the `_ => Err(...)` catch-all in `ticketing_handlers.rs`.

## User Setup Required
None — no external service configuration required.

## Next Phase Readiness
- `azure_devops.rs` is ready to be wired into `ticketing_handlers.rs` (add `save_azure_devops_credentials` command + `Azuredevops` match arm in `fetch_remote_issues`)
- `jira_server.rs` not created — needs a separate plan if Jira Server support is re-scoped

## Self-Check: PASSED

- `src-tauri/src/ticketing/azure_devops.rs` exists: FOUND
- `src-tauri/src/ticketing/jira_server.rs` does NOT exist: CONFIRMED
- Commit `299430f` exists: CONFIRMED
- `cargo check -p maestro` exits 0: CONFIRMED
- `cargo test -p maestro azure_devops` all 6 tests pass: CONFIRMED

---
*Phase: 54-linear-jira-azdo*
*Completed: 2026-05-21*
