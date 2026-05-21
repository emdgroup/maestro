---
gsd_state_version: 1.0
milestone: v1.6
milestone_name: Ticketing Integration
status: in_progress
stopped_at: Phase 52 complete — ready for Phase 53
last_updated: "2026-05-21T00:00:00.000Z"
last_activity: 2026-05-21 -- Phase 52 complete (5 tasks, 9 tests pass)
progress:
  total_phases: 7
  completed_phases: 3
  total_plans: 2
  completed_plans: 4
  percent: 43
---

# Project State: v1.6 — Ticketing Integration

## Project Reference

See: .planning/PROJECT.md (updated 2026-05-20)

**Core value:** Orchestrate multiple AI coding agents in parallel with isolation, visibility, and control
**Current focus:** Phase 53 — oauth-flows

## Current Position

Phase: 52 — COMPLETE
Plan: 1 of 1
Status: Phase 52 complete
Last activity: 2026-05-21 -- Phase 52 complete (TokenManager + KeychainStore)

Progress: [██████████] 100%

## Performance Metrics

**Velocity:** (v1.6 not yet started — reference v1.5 baselines)

- Average plan duration: ~0.06h per plan
- Reference: Phase 47 (3 plans, 0.143h total), Phase 46 (2 plans, 0.123h total)

**By Phase:** (to be filled as plans complete)

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 50 | TBD | — | — |
| 51 | TBD | — | — |
| 52 | TBD | — | — |
| 53 | TBD | — | — |
| 54 | TBD | — | — |
| 55 | TBD | — | — |
| 56 | TBD | — | — |

*Updated after each plan completion*
| Phase 51-data-foundation P01 | 7min | 2 tasks | 6 files |

## Accumulated Context

### Decisions

Key v1.6 decisions locked in at roadmap creation:

- [Phase 50]: CSP and tauri-plugin-oauth capability registration must be atomic (three required steps: Cargo, lib.rs, capabilities/default.json) — missing any step produces runtime failure only at click time
- [Phase 51]: Canonical external_id format locked before provider code: `github:{number}`, `gitlab:{project_id}/{issue_iid}`, `linear:{identifier}`, `jira:{issue_key}` — schema v16 migration is destructive; document as breaking change
- [Phase 52]: `keyring 3.6.3` already installed; needs feature flag expansion for apple-native and linux-native-sync-persistent; keyring 4.x is a sample app — do not upgrade
- [Phase 52]: `oauth2 5.0.0` must use `default-features = false` — enabling defaults pulls reqwest 0.12, which conflicts with existing reqwest 0.13 (open issue, Jan 2026); bridge via ~20-line `AsyncHttpClient` trait adapter
- [Phase 52]: Linux/WSL is a confirmed Maestro use case; keyring unavailability must not be silently discarded — encrypted file fallback with warning toast required
- [Phase 53]: Token exchange happens in Rust via reqwest, never in frontend TypeScript — minimizes CSP surface
- [Phase 53]: PKCE verifier and state nonce captured in `start_with_config` closure, never stored in AppState
- [Phase 53]: Jira `cloudId` discovered via `accessible-resources` after token exchange; multiple Jira sites require user confirmation
- [Phase 54]: GitHub via `octocrab`; Linear via `graphql_client` (verify reqwest feature pin at install time); GitLab + Jira via existing `reqwest 0.13`
- [Phase 55/56]: Issue classification (Available/Imported/Changed) is a pure frontend derivation — no extra IPC round-trip needed; uses TanStack Query cached task data + live remote issue list

### Pending Todos

None.

### Blockers/Concerns

- **Atlassian localhost OAuth acceptance:** Implied but not explicitly documented — validate by registering a test Atlassian OAuth app before committing Jira implementation effort in Phase 53
- **Linear GraphQL complexity budget:** Not published; test proposed minimal-field query empirically before finalizing Phase 54 Linear plan
- **graphql_client reqwest feature pin:** Verify at dependency install (Phase 50) whether graphql_client 0.16.0 reqwest feature pins reqwest 0.12; if so, use `default-features = false` and call generated types via reqwest 0.13 client

## Session Continuity

Last session: 2026-05-21T00:00:00.000Z
Stopped at: Phase 52 complete
Resume file: .planning/phases/53-oauth/PLAN.md (not yet created)
