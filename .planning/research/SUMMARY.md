# Project Research Summary

**Project:** Maestro v1.6 — OAuth-Based Ticketing Integration
**Domain:** OAuth 2.0 + PKCE multi-provider ticket import into a Tauri 2 desktop app
**Researched:** 2026-05-20
**Confidence:** HIGH

## Executive Summary

Maestro v1.6 adds ticket import from GitHub, GitLab, Linear, and Jira Cloud into the existing Kanban board. The integration is an OAuth-first, read-only import pipeline: users authenticate per project via a localhost redirect flow, browse open issues in a modal with Available/Imported/Changed tabs, and selectively import tickets as Backlog tasks. The recommended approach centers on `tauri-plugin-oauth` for the redirect server, `oauth2 5.0.0` (no default features) with a custom reqwest adapter for PKCE flows, `keyring 3.6.3` (already installed) for OS keychain token storage, `octocrab` for GitHub, `graphql_client` for Linear, and raw reqwest + serde for Jira and GitLab. The architecture is a clean layered `ticketing/` module built directly on top of established codebase conventions.

The highest-value differentiator is non-destructive change detection: the "Changed" tab surfaces imported tickets whose upstream content has drifted, giving users per-ticket "Update task" and "Dismiss" actions instead of the destructive delete-and-reimport pattern competitors use. Deliberately deferred are two-way sync, webhook-driven updates, and multi-provider-per-project — all carry disproportionate complexity relative to v1.6 scope and create risks (write OAuth scopes, public endpoint requirement, external_id namespace collisions) that are not worth taking.

The dominant risk category is infrastructure setup order. CSP must be updated before any provider code is written. The `tauri-plugin-oauth` capability must be registered in both `lib.rs` and `capabilities/default.json` atomically. Token refresh races across providers require a `TokenManager` mutex abstraction in place before GitLab and Jira integration begins. These are not implementation details — they are blockers that, if deferred, produce non-obvious failures well into the build.

## Key Findings

### Recommended Stack

The new dependencies are minimal and fit cleanly alongside the existing stack. `tauri-plugin-oauth 2.0.0` is the canonical Tauri 2 OAuth redirect solution — it handles port selection, response HTML, and cancellation. `oauth2 5.0.0` must be used with `default-features = false` because enabling default features pulls in `reqwest 0.12`, which cannot deduplicate against the existing `reqwest 0.13` in the dependency tree (open issue as of Jan 2026). The bridge is a ~20-line `AsyncHttpClient` trait adapter. `keyring 3.6.3` is already in `Cargo.toml`; it only needs feature flag expansion for macOS (`apple-native`) and Linux (`linux-native-sync-persistent`). The `keyring 4.x` release is a sample application — do not upgrade.

**Core technologies:**
- `tauri-plugin-oauth 2.0.0`: localhost redirect server for OAuth code capture — purpose-built for Tauri 2, no custom TCP server needed
- `oauth2 5.0.0` (no default features): typed PKCE, CSRF state, token exchange — avoids reqwest 0.12 conflict via custom adapter (~20 lines)
- `keyring 3.6.3` (existing, expand features): OS keychain storage for all tokens — already installed, never use file storage for credentials
- `octocrab 0.51.0`: GitHub Issues API — uses hyper 1.x directly, zero reqwest version conflict
- `graphql_client 0.16.0`: typed Linear GraphQL queries — compile-time safety against Linear's complex schema
- `reqwest 0.13` + `serde_json` (existing): Jira Cloud and GitLab REST APIs — no dedicated crate needed for 4-5 endpoints each

### Expected Features

The feature set is anchored by a complete MVP that must ship all at once — partial delivery (e.g., OAuth without the import modal, or import without change detection) produces a broken experience. The "Changed" tab with Update/Dismiss actions is the named v1.6 requirement and the primary differentiator.

**Must have (table stakes) — v1.6:**
- OAuth connect/disconnect per project for all four providers — no token means no import
- Schema v16: `external_url`, `external_updated_at`, `labels` columns — required by all import writes
- Remove existing broken `sync_github_issues` / `sync_jira_issues` code — clean slate, prevents old Basic-auth URL pattern confusion
- Import modal with Available/Imported/Changed tabs — core UX entry point
- Checkbox multi-select + bulk "Import N selected" action — batch import is expected in any list UI
- Field mapping for all four providers with ADF plaintext stripping for Jira
- Linear team selector (required for the API query to work) and JQL field for Jira
- Auto-refresh polling (2-minute interval while modal open) + manual refresh button
- Acceptance criteria placeholder on import — required by NOT NULL DB constraint
- External link icon on modal rows and task cards

**Should have (competitive) — v1.6:**
- Change detection "Changed" tab with per-ticket "Update task" and "Dismiss" actions — the named v1.6 requirement and the feature that distinguishes Maestro's import from competitors
- Provider connection status indicator (colored dot) visible outside the modal in project Settings

**Defer (v1.x patch):**
- Label filter chips for GitHub/GitLab
- Full ADF to markdown conversion for Jira (MVP is plaintext strip)
- GitLab self-hosted support (cloud first)
- Description diff view in Changed tab (MVP is two-column static text comparison)

**Defer (v2+):**
- Webhook-driven real-time updates (requires public endpoint)
- Two-way sync (push task status back to ticket — write OAuth scopes, complex state machines)
- Multi-provider per project (external_id namespace collisions)
- Import sub-tasks / epics as task relationships

### Architecture Approach

The implementation is a new `ticketing/` module in the Rust backend with four layers: data models, storage (config file + OS keychain), provider clients (one file per provider), and an OAuth state machine. IPC commands in `ipc/ticketing_handlers.rs` are thin dispatchers — 10-20 lines each — that delegate to the module. On the frontend, `ticketing.service.ts` provides TanStack Query hooks, `OAuthConnectSection.tsx` handles connect/disconnect UI, and `ImportIssuesModal.tsx` drives the entire import experience. Issue classification (Available/Imported/Changed) is a pure frontend derivation using already-cached task data plus the live remote issue list — no extra IPC round-trip.

**Major components:**
1. `ticketing/oauth.rs` — PKCE state machine; code verifier captured in the `start_with_config` closure, never passed to frontend or stored in AppState
2. `ticketing/keychain.rs` — keyring wrappers keyed by `(provider, project_id)`; single source of truth for token access and the only place `keyring::Error` is handled
3. `ticketing/providers/*.rs` — one file per provider implementing the `ProviderClient` async trait (GitHub, GitLab, Linear, Jira)
4. `ipc/ticketing_handlers.rs` — 7 new IPC commands; 3 old sync commands removed in the same phase
5. `models/ticketing.rs` — `TicketingConfig`, `RemoteIssue`, `ProviderKind`, `OAuthFlowStarted` with ts-rs derive
6. `.maestro/ticketing.json` — non-secret provider config per project (provider type, repo slug, base URL); tokens are never stored here
7. `ImportIssuesModal.tsx` — three-tab issue browser with checkbox multi-select; local React state only (no Zustand required)

### Critical Pitfalls

1. **CSP blocks all new provider API calls** — The existing `tauri.conf.json` `connect-src` only permits `api.github.com` and `*.atlassian.net`. GitLab, Linear, `auth.atlassian.com`, and `127.0.0.1` (OAuth redirect) are all absent. Fix by expanding `connect-src` in the very first commit. All token exchange must happen in Rust via reqwest — never in frontend TypeScript — to minimize what needs CSP coverage.

2. **`tauri-plugin-oauth` capability registration has three required steps, none of which fail at compile time** — Cargo dependency, `lib.rs` plugin registration, and `capabilities/default.json` entries (`oauth:allow-start`, `oauth:allow-cancel`) must all be completed together. A missing step produces a runtime failure only when the user clicks "Connect." Verify immediately after wiring.

3. **Token refresh race condition on concurrent 401s** — GitLab (2-hour tokens) and Jira (rotating refresh tokens) will trigger multiple concurrent refresh attempts when the modal auto-polls and a token expires. The first successful refresh invalidates the refresh token for all concurrent attempts. Fix with a `TokenManager` holding `Arc<tokio::Mutex<TokenState>>` per provider. Must be implemented before any provider that uses refresh tokens.

4. **Linux keyring unavailable on WSL and headless environments** — WSL is a confirmed Maestro use case. `keyring::Error` on `set_password()` must not be silently discarded. Implement an encrypted-file fallback with a warning toast; test on WSL before declaring the keychain phase done.

5. **Jira Cloud requires `cloud_id` discovery and a different URL pattern than the existing code** — The existing `sync_jira_issues` uses a direct host URL (Basic auth pattern). OAuth calls must use `api.atlassian.com/ex/jira/{cloudId}/rest/api/3/...`. The `cloudId` is obtained from `accessible-resources` after token exchange; if multiple Jira sites are returned, the user must confirm the correct one. The old URL pattern must be deleted entirely — it cannot coexist with OAuth.

6. **Inconsistent `external_id` format causes deduplication failures and duplicate task creation** — Define a canonical format once, before writing any provider code: `github:1234`, `gitlab:12345/67`, `linear:abc-123`, `jira:PROJ-42`. Schema v16's destructive migration clears all previously imported tasks — document this as an explicit breaking change.

## Implications for Roadmap

The architecture file identifies a 7-phase build order driven by hard compile-time and runtime dependencies. Each phase maps cleanly to a roadmap phase.

### Phase 1: Infrastructure Setup
**Rationale:** CSP and capability registration are silent failures that waste time debugging at any later phase. These must be the first commit. Nothing else can be verified without them.
**Delivers:** `tauri.conf.json` CSP expanded with all provider origins and `127.0.0.1:*`; `tauri-plugin-oauth` registered in Cargo, `lib.rs`, and `capabilities/default.json`; all new Cargo dependencies added (`oauth2`, `octocrab`, `graphql_client`, `async-trait`, `url`); `keyring` feature flags expanded for macOS and Linux
**Avoids:** Pitfall 1 (CSP silent failures), Pitfall 2 (capability not registered)

### Phase 2: Data Foundation
**Rationale:** All downstream types — provider clients, IPC handlers, frontend bindings — require the Rust model types to compile. Schema v16 must exist before any import write can be tested. The canonical `external_id` format must be decided here, not per-provider.
**Delivers:** Schema v16 with `external_url`, `external_updated_at`, `labels` columns; `models/ticketing.rs` with all new types; `Task` struct and `TASK_SELECT` updated; `pnpm tauri:gen` regenerates bindings
**Avoids:** Pitfall 6 (canonical external_id format locked in here, not per-provider)
**Uses:** `TicketingConfig`, `RemoteIssue`, `ProviderKind`, `OAuthFlowStarted` types from `models/ticketing.rs`

### Phase 3: Storage Layer
**Rationale:** Provider clients and IPC handlers both depend on config storage and keychain access. Both are independently verifiable at this phase without any HTTP calls.
**Delivers:** `ticketing/keychain.rs` with store/load/delete token wrappers; `db/project_storage.rs` wrappers for `load_ticketing_config` / `save_ticketing_config`; Linux keyring fallback with warning toast
**Avoids:** Pitfall 4 (Linux keyring unavailable — fallback implemented now, not as a post-launch patch)

### Phase 4: Provider Clients
**Rationale:** Providers depend on models (Phase 2) and storage (Phase 3). Implement GitHub first — simplest OAuth (non-expiring tokens, REST, most common) — to validate the `ProviderClient` trait design before committing it across four providers. Linear last due to GraphQL shape difference.
**Delivers:** `ProviderClient` async trait; `TokenManager` with per-provider refresh serialization mutex; GitHub, GitLab, Jira, and Linear provider implementations; Jira `accessible-resources` multi-site handling; ADF plaintext stripping; Linear no-refresh 401 path
**Avoids:** Pitfall 3 (TokenManager lives here), Pitfall 5 (Jira cloudId and URL pattern), Pitfall 7 (GitHub OAuth App vs GitHub App — use OAuth App, non-expiring tokens), Pitfall 8 (Linear no-refresh path)
**Uses:** `octocrab` for GitHub; `graphql_client` for Linear; `reqwest`/`serde_json` for Jira and GitLab

### Phase 5: OAuth State Machine
**Rationale:** OAuth depends on providers (needs `build_auth_url` and `exchange_code`). This phase wires the full browser redirect dance, PKCE token exchange in Rust, and keychain persistence.
**Delivers:** `ticketing/oauth.rs` with full PKCE state machine; PKCE verifier and state nonce captured in `start_with_config` closure (never in AppState); `ticketing:connected` and `ticketing:error` Tauri events emitted to frontend; `cancel(port)` called on user cancellation and on error
**Avoids:** Token exchange in frontend JS; OAuth state stored in AppState (both anti-patterns documented in ARCHITECTURE.md)

### Phase 6: IPC Commands + Old Code Removal
**Rationale:** IPC layer depends on all lower layers. Old sync commands must be removed in the same phase to prevent Jira's old Basic-auth URL pattern from persisting alongside the new OAuth pattern.
**Delivers:** `ipc/ticketing_handlers.rs` with 7 new commands; `sync_github_issues`, `sync_jira_issues`, `save_import_config` removed from `settings_handlers.rs` and deregistered from `lib.rs`; `pnpm tauri:gen` regenerates bindings — this is the Rust-to-frontend handoff boundary

### Phase 7: Frontend Services + Settings UI
**Rationale:** Depends on generated bindings from Phase 6. `OAuthConnectSection` and settings config form are self-contained; building them before the modal reduces the modal's surface area.
**Delivers:** `ticketing.service.ts` with all TanStack Query hooks and OAuth event listeners; `OAuthConnectSection.tsx` with connect/disconnect UI and OAuth event handling; provider config form in SettingsPage; connection status dot (green/gray/red)

### Phase 8: Import Modal
**Rationale:** The user-facing culmination of all preceding work. Issue classification (Available/Imported/Changed) is a pure derivation from data already in React Query cache — no extra IPC needed.
**Delivers:** `ImportIssuesModal.tsx` with Available/Imported/Changed tabs; checkbox multi-select; "Update task" and "Dismiss" actions in Changed tab; auto-refresh (2-minute polling while open); manual refresh button; "Import Issues" button added to BacklogView, conditionally shown when provider is configured

### Phase Ordering Rationale

- Phases 1-3 are pure infrastructure with no user-visible output — they must not be deferred because they eliminate the most dangerous failure modes before any provider logic is written
- Phase 4 implements GitHub first to validate the `ProviderClient` trait cheaply before locking in the interface for all four providers
- Phase 6's `pnpm tauri:gen` is the explicit Rust-to-frontend handoff; Phases 7 and 8 can only begin after this
- Phase 8 is the most dependent phase and cannot be parallelized; Phases 7 and 8 are sequential

### Research Flags

Phases with well-documented patterns (research not needed during planning):
- **Phase 1 (Infrastructure):** tauri-plugin-oauth setup is confirmed in STACK.md research against official docs
- **Phase 2 (Data Foundation):** schema migration and ts-rs model patterns are established in the existing codebase
- **Phase 3 (Storage):** keyring API verified; Linux fallback approach fully documented in PITFALLS.md
- **Phase 6 (IPC Commands):** IPC command registration pattern is identical to `acp_handlers.rs` and `task_handlers.rs`
- **Phase 7 (Frontend Services):** TanStack Query hook patterns are established and consistent across the codebase

Phases that may benefit from targeted validation before or during planning:
- **Phase 4 (Provider Clients) — Jira:** Atlassian localhost redirect acceptance is implied but not explicitly documented. Validate by registering a test Atlassian OAuth app before finalizing the Jira implementation plan.
- **Phase 4 (Provider Clients) — Linear:** Linear's GraphQL query complexity budget is not published. The proposed minimal-field query needs empirical validation with a real token before finalizing the Linear provider plan.
- **Phase 4 (Provider Clients) — `graphql_client` reqwest feature pin:** If `graphql_client 0.16.0`'s `reqwest` feature pins reqwest 0.12, the feature must be disabled and generated types used manually. Verify at dependency install time; resolve before writing Linear code.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | All versions verified against crates.io and official docs; version conflicts explicitly confirmed with open issue references; workarounds documented and validated |
| Features | HIGH | All four provider APIs verified via Context7 against official docs; field mappings confirmed; existing codebase inspected to identify constraints (NOT NULL on acceptance_criteria, existing broken sync commands) |
| Architecture | HIGH | Based on direct codebase inspection; patterns follow established project conventions exactly; build order derived from real compile-time dependencies; all integration points identified with specific file names |
| Pitfalls | HIGH | CSP gap and capability gap confirmed by direct inspection of `tauri.conf.json` and `capabilities/default.json`; all critical pitfalls sourced from official provider docs and codebase-specific findings |

**Overall confidence:** HIGH

### Gaps to Address

- **Atlassian localhost OAuth acceptance:** Not explicitly documented; confirmed in practice. Validate by registering a test Atlassian OAuth app before committing implementation effort to Jira.
- **Linear query complexity budget:** Not published by Linear. Test the proposed minimal-field flat query with a real token before finalizing the Linear provider plan. If complexity is exceeded, split into pages of 50.
- **`graphql_client 0.16.0` reqwest feature pin:** Verify at install time whether the `reqwest` feature pins reqwest 0.12. If so, use `default-features = false` and call generated types manually via a reqwest 0.13 client.
- **keyring Linux SQLite fallback API:** `use_sqlite_store` is recommended in PITFALLS.md but needs confirmation against the exact keyring 3.6.3 API before implementation. Resolve in Phase 3 planning.

## Sources

### Primary (HIGH confidence)
- crates.io API — `tauri-plugin-oauth 2.0.0`, `oauth2 5.0.0`, `octocrab 0.51.0`, `graphql_client 0.16.0`, `keyring 3.6.3`, `url 2.5.8` versions confirmed
- Context7 `/fabianlars/tauri-plugin-oauth` — `start_with_config`, `cancel`, `OauthConfig` API; capability requirements confirmed
- Context7 `/open-source-cooperative/keyring-rs` — `Entry::new`, `set_password`, `get_password`, `delete_credential`, `Error::NoEntry` API confirmed
- docs.rs `oauth2 5.0.0` — `AsyncHttpClient` trait; custom HTTP adapter pattern confirmed
- GitHub ramosbugs/oauth2-rs issue #333 — reqwest 0.13 incompatibility confirmed open as of Jan 2026
- docs.github.com — OAuth App non-expiring tokens; 127.0.0.1 redirect confirmed; `gho_` token prefix
- docs.gitlab.com — PKCE flow; 2-hour token lifetime; localhost redirect permitted
- linear.app/developers — localhost OAuth example; persistent non-expiring tokens; GraphQL API
- Atlassian developer docs — `accessible-resources` endpoint; rotating refresh tokens; OAuth 2.0 3LO flow
- Direct codebase inspection — `tauri.conf.json` (CSP gap confirmed), `capabilities/default.json` (plugin absent), `settings_handlers.rs` (old sync commands), `db/schema.rs` (v15 confirmed), `Cargo.toml` (existing deps), `models/task.rs`, `ipc/task_handlers.rs`

### Secondary (MEDIUM confidence)
- Atlassian developer docs — localhost redirect URL acceptance for registered apps (implied, not stated explicitly)
- Jira Cloud rate limiting docs — 100 RPS burst, 65,000 points/hour quota

### Tertiary (LOW confidence — validate during implementation)
- Linear GraphQL complexity budget — not published; test empirically with minimal query before finalizing
- `graphql_client 0.16.0` reqwest feature pin behavior — verify at dependency install time

---
*Research completed: 2026-05-20*
*Ready for roadmap: yes*
