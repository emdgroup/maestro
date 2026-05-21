---
gsd_state_version: 1.0
milestone: v1.6
milestone_name: Ticketing Integration
status: executing
stopped_at: Phase 54 complete
last_updated: "2026-05-21T00:00:00Z"
last_activity: 2026-05-21 -- Phase 54 complete (Linear/Jira Cloud/AzDO — 4 plans, 3 waves; Jira Server dropped per Atlassian EOL; 70 tests pass)
progress:
  total_phases: 7
  completed_phases: 4
  total_plans: 11
  completed_plans: 7
  percent: 57
---

# Project State: v1.6 — Ticketing Integration

## Project Reference

See: .planning/PROJECT.md (updated 2026-05-20)

**Core value:** Orchestrate multiple AI coding agents in parallel with isolation, visibility, and control
**Current focus:** Phase 54 — Linear/Jira/AzDO Auth + API Clients (next)

## Current Position

Phase: 54 (linear-jira-azdo) — COMPLETE
Next: Phase 55 (Settings UI)
Status: Phase 54 complete — ready for Phase 55 planning
Last activity: 2026-05-21 -- Phase 54 complete (4/4 plans, 70 tests pass)

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

- `/gsd:code-review 53 --fix` (optional): 3 advisory findings from Phase 53 code review — CR-01 URL encoding for owner/repo in GitHub/Forgejo paths, CR-02 stale .enc file cleanup on delete, CR-03 SHA-256 key stretching in file fallback

### Blockers/Concerns

- **Linear GraphQL complexity budget:** Not published; test proposed minimal-field query empirically before finalizing Phase 54 Linear plan
- **graphql_client reqwest feature pin:** Verify at dependency install whether graphql_client 0.16.0 reqwest feature pins reqwest 0.12; if so, use `default-features = false` and call generated types via reqwest 0.13 client

## Session Continuity

Last session: 2026-05-21T00:00:00Z
Stopped at: Phase 54 complete
Resume file: None — ready for Phase 55 planning
