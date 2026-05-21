---
phase: 54-linear-jira-azdo
plan: 01
subsystem: api
tags: [rust, graphql, linear, graphql_client, reqwest, specta, ticketing]

# Dependency graph
requires:
  - phase: 53-api-key-auth
    provides: TokenManager, StoredToken, TicketingConfig, RemoteIssue, validate_and_store pattern
provides:
  - graphql_client dependency fixed (reqwest 0.12 conflict removed)
  - jc-adf 0.2 dependency added for Jira Cloud ADF conversion (Plan 02)
  - src-tauri/src/ticketing/linear.rs with validate_and_store, list_teams, fetch_issues
  - LinearTeam struct exported to TypeScript bindings via specta
affects: [54-02, 54-03, 54-04, phase-55]

# Tech tracking
tech-stack:
  added:
    - jc-adf = "0.2" (ADF-to-Markdown conversion, used by Plan 02)
  patterns:
    - Plain serde structs + graphql_client::Response<T> for GraphQL (no reqwest feature, no schema file)
    - Two separate query strings for optional team filter (ISSUES_QUERY_ALL vs ISSUES_QUERY_TEAM)
    - post_graphql_query helper centralises Authorization header and endpoint

key-files:
  created:
    - src-tauri/src/ticketing/linear.rs
  modified:
    - src-tauri/Cargo.toml
    - src-tauri/src/ticketing/mod.rs
    - Cargo.lock

key-decisions:
  - "Remove features = [\"reqwest\"] from graphql_client to eliminate reqwest 0.12 conflict; use plain serde structs + graphql_client::Response<T> instead of post_graphql() helper"
  - "Add jc-adf = \"0.2\" for ADF-to-Markdown conversion needed by jira_cloud.rs in Plan 02"
  - "Use two separate query constants (ISSUES_QUERY_ALL, ISSUES_QUERY_TEAM) instead of a parameterised query with optional filter, because GraphQL does not accept null as a skip signal for filter conditions"

patterns-established:
  - "Pattern: Linear GraphQL via plain serde — GraphqlRequest<'a> { query: &'a str, variables: serde_json::Value } + graphql_client::Response<T> for deserialization"
  - "Pattern: post_graphql_query() private helper centralises endpoint URL and Authorization header"
  - "Pattern: Two query constants for optional team filter — ISSUES_QUERY_ALL (no filter) and ISSUES_QUERY_TEAM (with $teamId variable)"

requirements-completed: [AUTH-03, PROV-03]

# Metrics
duration: 20min
completed: 2026-05-21
---

# Phase 54 Plan 01: Fix graphql_client conflict and implement Linear API client

**Linear GraphQL client using plain serde structs and graphql_client::Response<T>, with reqwest 0.12 conflict eliminated and jc-adf added for Plan 02**

## Performance

- **Duration:** ~20 min
- **Started:** 2026-05-21T20:56:00Z
- **Completed:** 2026-05-21T21:16:00Z
- **Tasks:** 2
- **Files modified:** 4 (Cargo.toml, Cargo.lock, ticketing/mod.rs, ticketing/linear.rs)

## Accomplishments
- Removed `features = ["reqwest"]` from graphql_client, eliminating the reqwest 0.12/0.13 dual-version conflict
- Added jc-adf = "0.2" to Cargo.toml (needed by jira_cloud.rs in Plan 02)
- Implemented `linear.rs` with `validate_and_store`, `list_teams`, and `fetch_issues` following Phase 53 patterns
- `LinearTeam` struct derives `specta::Type` with `#[specta(export)]` for TypeScript binding generation
- 5 unit tests pass covering viewer deserialization, issues deserialization, external_id format, labels extraction, and teams deserialization

## Task Commits

Each task was committed atomically:

1. **Task 1: Fix Cargo.toml deps (graphql_client feature + jc-adf)** - `4767dd8` (chore)
2. **Task 2: Implement src-tauri/src/ticketing/linear.rs** - `2746db4` (feat)

## Files Created/Modified
- `src-tauri/Cargo.toml` - Removed `features = ["reqwest"]` from graphql_client; added `jc-adf = "0.2"`
- `Cargo.lock` - Resolved updated deps: jc-adf 0.2.0, pulldown-cmark 0.12.2, unicase 2.9.0 added; reqwest 0.12.x removed
- `src-tauri/src/ticketing/mod.rs` - Added `pub mod linear;`
- `src-tauri/src/ticketing/linear.rs` - New file: Linear GraphQL client with validate_and_store, list_teams, fetch_issues, LinearTeam, 5 unit tests

## Decisions Made
- Used plain serde structs + `graphql_client::Response<T>` instead of `#[derive(GraphQLQuery)]` — avoids the .graphql schema file requirement and reqwest version conflict (per RESEARCH.md Critical Finding #1 and #2)
- Two separate query constant strings for issues (ISSUES_QUERY_ALL and ISSUES_QUERY_TEAM) rather than a single parameterised query with optional filter — GraphQL filter conditions cannot be conditionally omitted via null variables
- `post_graphql_query()` private helper centralises the endpoint URL and Authorization header construction across all three public functions

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None. The graphql_client feature fix resolved cleanly with cargo resolving jc-adf and its transitive deps (pulldown-cmark, unicase) on first update.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Task 1 unblocks Plan 02 (jira_cloud.rs): jc-adf is now in Cargo.toml and the reqwest conflict is gone
- Task 2 unblocks Plan 02 (ticketing_handlers.rs): `linear::validate_and_store`, `linear::list_teams`, and `linear::fetch_issues` are ready for IPC wiring
- `LinearTeam` type is available for `pnpm tauri:gen` regeneration once IPC handlers are registered in lib.rs (Plan 02 or later)
- No blockers for subsequent plans

## Self-Check: PASSED
- `src-tauri/src/ticketing/linear.rs` exists: FOUND
- `4767dd8` exists in git log: FOUND
- `2746db4` exists in git log: FOUND
- `cargo test -p maestro linear` exits 0 with 5 tests passing: VERIFIED
- `cargo check -p maestro` exits 0: VERIFIED
- `graphql_client = { version = "0.16", default-features = false }` in Cargo.toml: VERIFIED
- `jc-adf = "0.2"` in Cargo.toml: VERIFIED
- No reqwest 0.12 in Cargo.lock from graphql_client: VERIFIED

---
*Phase: 54-linear-jira-azdo*
*Completed: 2026-05-21*
