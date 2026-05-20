# Stack Research

**Domain:** OAuth-based ticketing integration for Tauri 2 desktop app
**Researched:** 2026-05-20
**Confidence:** HIGH (all versions verified against crates.io and official docs)

## Scope

This file covers only the NEW capabilities required for v1.6 Ticketing Integration. It does not revisit existing stack decisions (Tauri 2, React 19, reqwest 0.13, serde_json, SQLite, keyring 3.6.3) already validated in prior milestones.

---

## Recommended Stack

### Core Technologies

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| tauri-plugin-oauth | 2.0.0 | Localhost redirect server for OAuth code capture | Purpose-built for this exact use case in Tauri 2; spawns a temporary HTTP server on a random available port, emits the full redirect URL to the frontend via Tauri events. No custom TCP server code needed, handles port selection and cancellation. Confirmed compatible with tauri@2 (Cargo.toml declares `tauri = "2"`). |
| keyring | 3.6.3 (existing — pin) | OS keychain token storage | Already in Cargo.toml at this version. Needs feature flag expansion: add `apple-native` and `linux-native-sync-persistent` alongside the existing `windows-native`. Do NOT upgrade to 4.x — keyring v4 restructured into a sample application, the actual library is now `keyring-core` 1.0.0 which provides only mock and sample stores, not production platform implementations. |
| oauth2 | 5.0.0 | OAuth 2.0 URL construction, PKCE, CSRF state, token types, refresh token flow | Strongly-typed RFC 6749/7662/7009 implementation. Use with `default-features = false` to avoid the reqwest 0.12 dependency (oauth2 pins `reqwest = "^0.12"`, maestro uses reqwest 0.13, and this conflict is an open issue as of Jan 2026). With features disabled, implement the `AsyncHttpClient` trait as a thin adapter (~20 lines) over the existing reqwest 0.13 client. Handles PKCE, state, code exchange, and token refresh uniformly across all four providers. |
| reqwest | 0.13 (existing) | HTTP transport for token exchange and all provider API calls | Already present. Drives the oauth2 `AsyncHttpClient` adapter and all REST/GraphQL API calls. No new HTTP client needed. |

### Supporting Libraries — Provider API Clients

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| octocrab | 0.51.0 | GitHub Issues API client | GitHub provider only. Uses hyper 1.x directly (not reqwest), so zero version conflict with maestro's reqwest 0.13. Provides typed issue models, built-in pagination via `all_pages()`, label filtering, and `user_access_token()` auth. Latest stable as of May 17, 2026. |
| graphql_client | 0.16.0 | Typed GraphQL for Linear Issues API | Linear provider only. Generates typed Rust structs from `.graphql` query files against Linear's schema at compile time via `#[derive(GraphQLQuery)]`. Prevents runtime field-mismatch errors on a complex schema. Use the `reqwest` feature with `default-features = false` check (see Version Compatibility). Latest stable Jan 15, 2026. |
| serde_json | 1.0 (existing) | JSON parsing for Jira Cloud REST API v3 and GitLab REST API v4 responses | Jira and GitLab providers. Both are straightforward JSON REST APIs; hand-written serde structs for the 4-5 fields needed (id, title, description, labels, updated_at) are sufficient. No dedicated client crate warranted. |
| url | 2.5.8 (likely transitive) | URL parsing for OAuth redirect parameter extraction | All providers. Used to parse `code` and `state` parameters from the redirect URL received by tauri-plugin-oauth. Likely already in the dependency tree via reqwest; add explicitly only if needed. |

### Development Tools

| Tool | Purpose | Notes |
|------|---------|-------|
| graphql_client CLI or build.rs codegen | Generate Linear GraphQL types at compile time | Download Linear's introspection schema once via `npx get-graphql-schema https://api.linear.app/graphql -h "Authorization: Bearer TOKEN" > linear_schema.json`. Check into repo. Add `build.rs` with `GraphQLQuery` derive. |

---

## Installation

```toml
# src-tauri/Cargo.toml additions

[dependencies]
# OAuth redirect server — Tauri 2 compatible
tauri-plugin-oauth = "2"

# OAuth 2.0 typed flows — no reqwest feature to avoid 0.12 conflict
oauth2 = { version = "5.0.0", default-features = false }

# GitHub Issues API (uses hyper, not reqwest — no version conflict)
octocrab = { version = "0.51", default-features = false, features = ["default-client", "rustls"] }

# Linear GraphQL API (typed codegen)
graphql_client = { version = "0.16", default-features = false, features = ["reqwest"] }

# keyring — already present, expand feature flags:
keyring = { version = "3.6.3", features = ["windows-native", "apple-native", "linux-native-sync-persistent"] }

# serde_json, reqwest, url — already present, no changes
```

```json
// tauri.conf.json — register plugin
{
  "plugins": {
    "oauth": {}
  }
}
```

```bash
# Frontend — TypeScript bindings for tauri-plugin-oauth
npm install @fabianlars/tauri-plugin-oauth@2
```

```rust
// src-tauri/src/lib.rs — plugin registration
tauri::Builder::default()
    .plugin(tauri_plugin_oauth::init())
    // ... existing plugins
```

---

## Alternatives Considered

| Recommended | Alternative | When to Use Alternative |
|-------------|-------------|-------------------------|
| tauri-plugin-oauth 2.0.0 | Custom Rust TCP listener on a random port | Never — tauri-plugin-oauth is the canonical Tauri 2 solution and handles port selection, response HTML, and cancellation. Writing a custom server adds maintenance burden for zero benefit. |
| keyring 3.6.3 (pin existing) | keyring 4.0.x / keyring-core 1.0.0 | When keyring-core ships production platform credential store implementations (macOS Keychain, Windows Credential Store, Linux Secret Service). Not yet available as of May 2026. |
| oauth2 5.0.0 no-default-features + custom reqwest adapter | Manual PKCE/state/code-exchange implementation | If the project wants zero extra dependencies. The oauth2 crate's value is the strong typing and RFC correctness, not the HTTP; skipping it means re-implementing ~300 lines of crypto/encoding logic. Not recommended. |
| oauth2 5.0.0 no-default-features + custom reqwest adapter | oauth2 with default-features (reqwest 0.12) | Never in this project — adding reqwest 0.12 alongside 0.13 doubles TLS stack weight in the binary. |
| octocrab 0.51.0 | Raw reqwest + GitHub REST API | Only if octocrab's hyper 1.x transitive deps cause binary size issues at link time. octocrab provides pagination, rate limiting, and type-safe models that would all need reimplementing. |
| graphql_client 0.16.0 | Raw reqwest + JSON for Linear | For a quick prototype only. Linear's GraphQL schema is large; untyped serde_json access creates silent runtime bugs when fields change. |
| serde_json + reqwest (raw) for Jira and GitLab | gitlab crate (0.1811.0) | The gitlab crate is well-maintained but pulls in a heavyweight dependency graph (graphql_client, itertools, percent-encoding, async-trait) for 2-3 issue endpoints. Not worth it. There is no maintained Jira Rust crate as of May 2026. |
| Authorization Code + PKCE via localhost redirect | Device Authorization flow (GitHub) | Only for headless/CLI scenarios. Device flow adds friction (user must visit github.com/login/device separately and type a code). Maestro is a GUI app; localhost redirect is the better UX. |

---

## What NOT to Use

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| `oauth2` with default features | Pulls in `reqwest = "^0.12"`. Cargo will carry both reqwest 0.12 and 0.13 (they are incompatible major versions that do not deduplicate), doubling TLS and runtime overhead in the binary. Open issue ramosbugs/oauth2-rs#333 confirms no fix as of Jan 2026. | `oauth2 = { version = "5.0.0", default-features = false }` with custom `AsyncHttpClient` adapter |
| keyring 4.x | v4 is a sample application demonstrating credential stores, not a library. The actual library is `keyring-core` 1.0.0, which currently only provides mock/sample stores — no macOS Keychain, Windows Credential Store, or Linux Secret Service implementations in stable form. | keyring 3.6.3 (already in Cargo.toml) |
| Custom URI scheme redirects (`maestro://oauth`) | GitHub, Jira, and GitLab do not accept custom URI scheme callback URLs in their OAuth app configuration for security reasons. Only Linear may permit it. Relying on custom schemes creates inconsistent per-provider implementation paths. | tauri-plugin-oauth localhost redirect for all providers uniformly |
| `gitlab` crate 0.1811.0 | Heavyweight transitive dependency graph for 2-3 REST endpoints. Overkill. | reqwest + hand-written serde structs for GitLab Issues REST API v4 |
| Any third-party Jira Rust crate | None are actively maintained as of May 2026. Jira Cloud REST API v3 is a stable JSON REST API — direct reqwest calls with typed serde models are more reliable than abandoned wrappers. | reqwest + serde structs matching Jira Issue fields |
| Storing OAuth tokens in `.maestro/ticketing.json` | Tokens are secrets; file-based storage is readable by any process with filesystem access. Config files are committed to git by some users accidentally. | OS keychain via keyring 3.6.3 for all tokens and secrets |

---

## Stack Patterns by Variant

**GitHub provider:**
- Auth: Authorization Code + PKCE via tauri-plugin-oauth (`http://127.0.0.1:{port}` — GitHub docs recommend 127.0.0.1 over localhost)
- API: octocrab with `personal_token()` or `user_access_token()` set to token from keyring
- Pagination: `octocrab.all_pages::<models::issues::Issue>(first_page)` handles full list

**GitLab provider (cloud + self-hosted):**
- Auth: Authorization Code + PKCE via tauri-plugin-oauth. GitLab explicitly permits `http://localhost` redirects for development in their OAuth docs.
- API: reqwest + serde_json structs; base URL is configurable (cloud = `https://gitlab.com`, self-hosted = user-supplied URL stored in `.maestro/ticketing.json`)
- Pagination: GitLab uses `X-Next-Page` response header; loop until header is absent

**Linear provider:**
- Auth: Authorization Code via tauri-plugin-oauth. Linear docs show `http://localhost:3000/oauth/callback` as an example, confirming localhost support.
- API: graphql_client generated types against `https://api.linear.app/graphql` with Bearer token header
- Issue list: `IssueConnection` query filtered by `team` argument

**Jira Cloud provider:**
- Auth: OAuth 2.0 3LO against Atlassian (`https://auth.atlassian.com/authorize` → `https://auth.atlassian.com/oauth/token`). Atlassian docs state callback URL should be "any URL accessible by the app"; localhost is accepted for registered apps in practice.
- API: reqwest + serde_json; base URL constructed from `cloudId` in token response: `https://api.atlassian.com/ex/jira/{cloudId}/rest/api/3/issue/search`
- Pagination: Jira uses `startAt` / `maxResults` / `total` fields in response body; loop until `startAt + maxResults >= total`

**Token refresh:**
- oauth2's `RefreshTokenRequest` type wraps the exchange call
- All four providers return a `refresh_token` in the initial token response
- Implement a `refresh_if_needed()` function in `src-tauri/src/oauth.rs` that checks token expiry from stored `expires_at` and calls the token endpoint with the refresh token
- Store the new access token + new refresh token back to keyring after each refresh

---

## Version Compatibility

| Package A | Compatible With | Notes |
|-----------|-----------------|-------|
| tauri-plugin-oauth@2.0.0 | tauri@2.x | Confirmed; plugin Cargo.toml declares `tauri = "2"` |
| oauth2@5.0.0 (no default features) | reqwest@0.13 | No conflict; reqwest feature disabled, custom adapter bridges them |
| oauth2@5.0.0 (default features) | reqwest@0.12 ONLY | Incompatible with reqwest 0.13. Open issue #333 on oauth2-rs as of Jan 2026. Do not enable default features. |
| octocrab@0.51.0 | reqwest@0.13 | No conflict. octocrab uses hyper@1.x directly with no reqwest dependency. |
| graphql_client@0.16.0 reqwest feature | reqwest version | Verify on install: if graphql_client pins reqwest@0.12, use `default-features = false` and call the generated `build_query()` / parse logic manually with a reqwest 0.13 client. The `reqwest` feature flag in graphql_client just adds a convenience extension trait. |
| keyring@3.6.3 windows-native | Windows | Already declared in Cargo.toml |
| keyring@3.6.3 apple-native | macOS | Add to `[target.'cfg(target_os = "macos")'.dependencies]` section |
| keyring@3.6.3 linux-native-sync-persistent | Linux | Requires `libdbus-1-dev` at build time; document in README prerequisites for Linux builds |

---

## Integration Points with Existing Code

- **keyring feature expansion**: The current Cargo.toml declares `features = ["windows-native"]` only. Expand to include `apple-native` and `linux-native-sync-persistent` for full cross-platform support. Use `cfg` target sections to keep platform deps clean.
- **tauri-plugin-oauth registration**: Add `.plugin(tauri_plugin_oauth::init())` to `tauri::Builder::default()` in `lib.rs` alongside the existing plugin registrations.
- **oauth2 AsyncHttpClient adapter**: Create `src-tauri/src/oauth.rs`. Implement a newtype wrapper around `reqwest::Client` that satisfies the `AsyncHttpClient` trait from oauth2 5.0. This is the single place where reqwest 0.13 and oauth2 5.0 are bridged.
- **ProviderClient per provider**: Create a typed `ProviderClient` enum or struct per provider in `src-tauri/src/` that owns the bearer token and constructs appropriate API requests. Store active provider client in `AppState` behind an `Arc<Mutex<Option<ProviderClient>>>`.
- **`.maestro/ticketing.json`**: Stores provider type, client ID, and provider-specific configuration (GitLab base URL, Jira cloudId). Tokens are NOT stored here — they go to keyring using the project path as the keyring service name for namespacing.
- **reqwest instance reuse**: Use the same `reqwest::Client` instance from `AppState` for all outbound API calls to avoid duplicate TLS connection pool overhead.

---

## Sources

- crates.io `/api/v1/crates/tauri-plugin-oauth` — v2.0.0 confirmed latest stable (HIGH confidence)
- crates.io `/api/v1/crates/tauri-plugin-oauth/2.0.0/dependencies` — tauri@2 confirmed (HIGH confidence)
- Context7 `/fabianlars/tauri-plugin-oauth` — API usage patterns (HIGH confidence)
- crates.io `/api/v1/crates/keyring` — v4.0.1 exists, confirmed sample app restructure (HIGH confidence)
- crates.io `/api/v1/crates/keyring-core` — v1.0.0 confirmed, only mock/sample stores (HIGH confidence)
- docs.rs keyring 3.6.3 — features and cross-platform API confirmed (HIGH confidence)
- crates.io `/api/v1/crates/oauth2` — v5.0.0 confirmed latest stable (Jan 21, 2025) (HIGH confidence)
- docs.rs oauth2 5.0.0 `AsyncHttpClient` trait — custom HTTP client adapter confirmed possible (HIGH confidence)
- GitHub ramosbugs/oauth2-rs issue #333 — reqwest 0.13 incompatibility open as of Jan 3, 2026 (HIGH confidence)
- crates.io `/api/v1/crates/octocrab` — v0.51.0 confirmed latest (May 17, 2026) (HIGH confidence)
- octocrab 0.51.0 dependency list — hyper@1.x direct, no reqwest, confirmed no conflict (HIGH confidence)
- docs.rs octocrab 0.51.0 — Issues API, pagination, token auth confirmed (HIGH confidence)
- crates.io `/api/v1/crates/graphql_client` — v0.16.0 confirmed (Jan 15, 2026) (HIGH confidence)
- crates.io `/api/v1/crates/url` — v2.5.8 confirmed latest stable (HIGH confidence)
- docs.github.com OAuth — 127.0.0.1 loopback redirect URI confirmed (HIGH confidence)
- docs.gitlab.com OAuth 2.0 — Authorization Code + PKCE, localhost HTTP permitted (HIGH confidence)
- linear.app/developers OAuth 2.0 — localhost example in official docs confirmed (HIGH confidence)
- Atlassian developer docs OAuth 2.0 3LO — authorization and token endpoints confirmed (MEDIUM confidence — localhost localhost acceptance implied, not stated explicitly)

---

*Stack research for: Maestro v1.6 — OAuth-based ticketing integration (GitHub, GitLab, Linear, Jira)*
*Researched: 2026-05-20*
