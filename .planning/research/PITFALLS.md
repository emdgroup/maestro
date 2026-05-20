# Pitfalls Research

**Domain:** OAuth 2.0 + PKCE + OS keychain + multi-provider ticket import in a Tauri 2 desktop app
**Researched:** 2026-05-20
**Confidence:** HIGH — derived from codebase inspection, Context7 docs, and official provider documentation

---

## Critical Pitfalls

### Pitfall 1: Tauri CSP Blocks All New Provider API Calls

**What goes wrong:**

The existing `tauri.conf.json` CSP `connect-src` only permits `https://api.github.com` and `https://*.atlassian.net`. Every network call to GitLab (`https://gitlab.com`), Linear (`https://api.linear.app`), and Atlassian's OAuth auth server (`https://auth.atlassian.com`) will be blocked by the Tauri webview's Content Security Policy with a silent network error — the Tauri webview enforces CSP on all `fetch()`/`XMLHttpRequest` calls originating from the frontend. Calls made from Rust via `reqwest` are exempt, but any token exchange or API call triggered from TypeScript will fail.

Additionally, the localhost redirect server started by `tauri-plugin-oauth` runs on a dynamic port (`http://127.0.0.1:{port}`). If OAuth token exchange or any step of the flow is triggered from the frontend, the `connect-src` must include `http://127.0.0.1:*` — or alternatively the entire token exchange must happen in Rust (recommended).

**Why it happens:**

Developers add a new provider, test the Rust `reqwest` call (which works fine), then add a frontend fetch for token inspection or status checking and get a CORS/CSP error that looks like a network failure with no clear attribution.

**How to avoid:**

Add all required origins to `connect-src` before writing any API integration code:
```
connect-src 'self' ipc: http://ipc.localhost http://127.0.0.1:*
  https://api.github.com
  https://auth.atlassian.com https://*.atlassian.net https://api.atlassian.com
  https://gitlab.com https://*.gitlab.com
  https://api.linear.app https://auth.linear.app
  https://github.com
```
Do all token exchange (code-for-token POST) from Rust, not from the frontend, to avoid needing the OAuth provider's token endpoint in `connect-src`.

**Warning signs:**

- Network error in browser devtools with no HTTP response code
- `reqwest` call succeeds in Rust but equivalent `fetch()` in TypeScript fails
- Error message contains "Content Security Policy"

**Phase to address:** OAuth infrastructure phase (first phase of the milestone). Update CSP before writing any provider code.

---

### Pitfall 2: `tauri-plugin-oauth` Capability Not Registered — Plugin Silently Fails

**What goes wrong:**

Tauri 2 uses a capability system. `tauri-plugin-oauth` is not in the current `capabilities/default.json`. Calling `start()` from the TypeScript bindings will throw "plugin not found" or similar at runtime. The plugin must also be registered in `lib.rs` via `.plugin(tauri_plugin_oauth::init())`. Both steps are required and neither produces a compile-time error if skipped — only a runtime failure during the OAuth flow.

**Why it happens:**

Tauri 2's plugin capability system is less familiar than Tauri 1's. Developers add the Rust dependency and TypeScript import but forget to add the capability entry. The error only surfaces when the user clicks "Connect" and nothing happens.

**How to avoid:**

Three steps must all be completed in the same commit:
1. Add `tauri-plugin-oauth` to `Cargo.toml`
2. Register `.plugin(tauri_plugin_oauth::init())` in `lib.rs`
3. Add `"oauth:allow-start"` and `"oauth:allow-cancel"` to `capabilities/default.json`

Verify by starting the OAuth flow immediately after wiring — do not defer testing.

**Warning signs:**

- `invoke('plugin:oauth|start')` throws at runtime despite the Rust code compiling cleanly
- No localhost server appears when OAuth flow is initiated
- Port number returned is undefined or zero

**Phase to address:** OAuth infrastructure phase. Verify capability registration as the first integration test.

---

### Pitfall 3: Token Refresh Race Condition — Concurrent Requests Trigger Multiple Refreshes

**What goes wrong:**

The import modal auto-refreshes every N minutes while open. If the access token expires during the modal session and multiple in-flight requests detect the 401 simultaneously, each will attempt to exchange the refresh token for a new access token. For GitLab (2-hour token lifetime) and Jira Cloud (rotating refresh tokens), the first successful refresh invalidates the refresh token. All concurrent refresh attempts after the first will fail with a 400 "invalid_grant" error, leaving the session in a broken state that requires the user to re-authenticate.

The existing codebase has no token management layer — tokens are passed directly as parameters to `sync_github_issues` and `sync_jira_issues`.

**Why it happens:**

Without a centralized token manager, each API call independently reads the stored token, checks expiry, and refreshes if needed. Multiple callers checking at the same millisecond all find "expired" and all initiate refresh. The `tokio::Mutex` on the DB connection does not prevent this race because the refresh HTTP request is made outside the lock.

**How to avoid:**

Implement a single `TokenManager` (one per project, held in `AppState`) that:
1. Holds an `Arc<tokio::Mutex<TokenState>>` per provider
2. On access: acquires the lock, checks expiry, refreshes if needed, releases lock, then returns the token
3. Callers await the lock — the second caller blocks until the first finishes refreshing

```rust
async fn get_valid_token(&self, provider: &str) -> Result<String, String> {
    let mut state = self.tokens.lock().await;
    if state.is_expired() {
        let new_tokens = refresh_token(&state.refresh_token).await?;
        state.update(new_tokens); // persists to keyring
    }
    Ok(state.access_token.clone())
}
```

**Warning signs:**

- Intermittent 400 "invalid_grant" errors after leaving the modal open for an extended period
- User is logged out unexpectedly despite recently authenticating
- Jira or GitLab API returns 401 after a successful refresh just seconds earlier

**Phase to address:** OAuth token management phase. Must be implemented before any provider integration that uses refresh tokens (GitLab, Jira).

---

### Pitfall 4: Linux Keyring Unavailable — Silent Credential Loss

**What goes wrong:**

On Linux, `keyring` (v3.6.3 is already in `Cargo.toml`) defaults to the kernel keyutils backend. On headless or minimal desktop environments (CI, some Wayland compositors without a running secret service daemon, WSL without D-Bus), the keyutils backend may fail silently or return an error on `set_password()` that is discarded. If the error is not surfaced and token storage silently fails, the next call to `get_password()` returns `NoEntry`, and the user appears unauthenticated every launch — their OAuth flow appears to loop indefinitely.

WSL is a confirmed use case in this codebase (WSL connections table added in schema v15). WSL does not have a running secret service by default.

**Why it happens:**

`keyring::Entry::set_password()` returns `Result<(), keyring::Error>`. If this result is discarded with `let _ =` or `.ok()`, the failure is invisible. The OS keychain fails silently because the developer tests on macOS (where Keychain always works) and never tests the Linux path.

**How to avoid:**

- Always propagate `keyring` errors to the UI layer. Do not use `let _ =` on `set_password()` or `delete_credential()`.
- On Linux, call `keyring::set_default_credential_builder(keyring::set_default_credential_builder(...))` to prefer the Secret Service / D-Bus backend over kernel keyutils, with `use_native_store(true)` (prefers Secret Service when available).
- Implement an encrypted-file fallback using the `keyring` crate's SQLite backend (`use_sqlite_store`) stored in the app data directory, activated when the native store is unavailable. Surface a warning toast ("Credentials stored in local encrypted file — install GNOME Keyring for better security") rather than failing.
- Test explicitly on WSL and a headless Linux VM as part of the platform verification checklist.

**Warning signs:**

- `keyring::Error::NoEntry` immediately after `set_password()` on Linux
- User re-authenticates on every app launch on Linux
- `get_password()` returns the error variant `PlatformFailure` with a D-Bus connection error

**Phase to address:** OAuth keychain storage phase. Implement fallback before any integration testing on Linux/WSL targets.

---

### Pitfall 5: Jira Cloud `cloud_id` Discovery — Multiple Sites, Non-Unique IDs

**What goes wrong:**

Jira Cloud OAuth 3LO requires the `cloud_id` to construct all API URLs:
`https://api.atlassian.com/ex/jira/{cloudId}/rest/api/3/...`

The `cloud_id` is obtained by calling `https://api.atlassian.com/oauth/token/accessible-resources` with the access token. If the user has Atlassian access to multiple Jira Cloud instances (common in large organizations), this endpoint returns a list. If the code blindly picks `results[0]`, it will use the wrong site for users with multiple Jira organizations.

Additionally, Atlassian documents that "the `id` is not unique across containers" — two entries can share the same `id` value if they are different container types. The code must validate the site URL against the user's configured Jira host rather than assuming index 0.

The existing `sync_jira_issues` command in `settings_handlers.rs` constructs the URL as `https://{host}/rest/api/3/search` (direct host URL). This pattern does not work for OAuth — OAuth-authenticated calls must go through `api.atlassian.com/ex/jira/{cloudId}/`.

**Why it happens:**

The current code was written for Jira API Token auth (Basic auth with direct host), not OAuth. The two URL patterns are mutually exclusive. Copying the URL construction pattern from the existing code when adding OAuth support produces silent 401 or 404 errors.

**How to avoid:**

- After token exchange, always call `accessible-resources` and store both the `cloudId` and the `url` (site domain) in `ticketing.json`.
- Let the user confirm or select the correct site if multiple are returned.
- Construct all Jira API calls as: `https://api.atlassian.com/ex/jira/{storedCloudId}/rest/api/3/...`
- Delete the old URL pattern from `sync_jira_issues` entirely — it cannot coexist with OAuth.

**Warning signs:**

- Jira API calls return 401 despite a valid access token
- API calls return data from the wrong Jira organization
- `accessible-resources` returns an array with more than one element for the user's account

**Phase to address:** Jira provider integration phase. Accessible-resources call must happen before any task fetch. Remove old `sync_jira_issues` and `sync_github_issues` commands in the same phase to prevent confusion.

---

### Pitfall 6: Deduplication Fails Without a Stable External ID — Re-Import Creates Duplicates

**What goes wrong:**

The existing `upsert_imported_tasks` function deduplicates by `external_id` combined with `project_id`. This is correct but fragile: if the external ID format changes between the old code and the new code (e.g., GitHub: old code stored `"123"` as a string from `issue.number.to_string()`, new code stores `"github:owner/repo#123"`), every previously imported task will appear as a new entry — duplicating all tasks already in the Backlog.

The v1.6 requirements add `external_url` and `external_updated_at` columns to the schema (bumping schema version). The destructive migration (drop all tables, recreate) will wipe all existing imported tasks. This is intentional but must be documented — users will lose any tasks previously imported from GitHub/Jira.

**Why it happens:**

External ID format is not documented or enforced. New providers have different natural key types: GitHub uses numeric issue number, GitLab uses `iid` (project-scoped integer), Linear uses UUID, Jira uses alphanumeric key (`PROJ-123`). Without a canonical format, each developer independently chooses a format.

**How to avoid:**

Define and document a canonical external ID format before writing any provider code:
```
{provider}:{natural_key}
// GitHub:   "github:{number}"       e.g. "github:1234"
// GitLab:   "gitlab:{project_id}/{iid}" e.g. "gitlab:12345/67"
// Linear:   "linear:{issue_id}"    e.g. "linear:abc-123"
// Jira:     "jira:{issue_key}"     e.g. "jira:PROJ-42"
```

Write a migration note in the schema bump comment: "Schema v16: existing external_id values are invalidated by format change. Destructive migration clears imported tasks."

**Warning signs:**

- Backlog column fills with duplicate tasks after re-importing
- Imported count from `SyncResult` keeps increasing on every refresh even for unchanged issues
- Previously imported tasks with `InProgress` status lose their import tracking

**Phase to address:** Schema migration + import deduplication phase (same phase). Define the canonical ID format before implementing any provider's fetch logic.

---

### Pitfall 7: GitHub OAuth App vs GitHub App — Wrong App Type Causes Token Refresh Confusion

**What goes wrong:**

GitHub has two OAuth systems: OAuth Apps (classic) and GitHub Apps (newer). Their token behaviors are entirely different:
- **OAuth Apps**: Access tokens never expire. No refresh token. Token is permanent until revoked.
- **GitHub Apps** (with expiring tokens enabled): Access tokens expire after 8 hours, refresh tokens expire after 6 months.

If v1.6 uses a GitHub App by mistake (or if documentation implies GitHub Apps are the recommended path), the implementation will need token refresh logic for GitHub. If it uses a GitHub OAuth App, refresh logic will silently never be needed — but if the code also implements "refresh on 401", the refresh endpoint call will fail with a 404 (no refresh token exists), crashing the flow.

**Why it happens:**

"GitHub App" sounds like the right choice for a "GitHub integration." The distinction between OAuth App and GitHub App is subtle and the GitHub documentation navigation conflates them.

**How to avoid:**

Use a **GitHub OAuth App** for this integration. Reasons:
- OAuth Apps have non-expiring tokens (no refresh complexity)
- `repo` or `public_repo` scope gives read access to issues without fine-grained permission configuration
- GitHub Apps require specifying a GitHub App ID in the client, adding complexity

Document this decision explicitly. Do not implement GitHub token refresh — GitHub OAuth App tokens do not expire and will never trigger a 401 due to expiry.

**Warning signs:**

- GitHub integration requires the user to re-authenticate frequently
- POST to `https://github.com/login/oauth/access_token` with `grant_type=refresh_token` returns 404
- `ghu_` prefix on the GitHub token (GitHub Apps use this prefix; OAuth Apps use `gho_`)

**Phase to address:** GitHub provider setup phase. Choose app type before creating the GitHub OAuth App registration.

---

### Pitfall 8: Linear Uses Persistent Tokens (No Refresh) — But Handles Revocation Differently

**What goes wrong:**

Linear OAuth access tokens do not expire and there is no refresh token mechanism. This is simpler than the other providers but creates a different problem: if the token is revoked (user disconnects the app from Linear settings), every API call will silently return 401 with no token refresh recovery path. Code that assumes "401 means refresh" will loop indefinitely or crash.

Linear uses GraphQL, not REST. A query that exceeds Linear's query complexity limit returns a 400 with a GraphQL error payload, not a network-level 429. Code that only inspects HTTP status codes will miss these errors. Complexity errors look like: `{"errors": [{"message": "Query is too complex: ..."}]}`.

**Why it happens:**

All other providers in this integration use REST and have some form of token refresh. Linear's OAuth is simpler but different. Developers copy the refresh-on-401 pattern from other providers and then can't explain why Linear keeps "logging out" users.

**How to avoid:**

- For Linear: on 401, surface an immediate "reconnect required" message rather than attempting token refresh.
- Always check GraphQL `errors` array in responses — a 200 HTTP response can still contain errors.
- Keep Linear queries simple: fetch only `id`, `title`, `description`, `url`, `updatedAt` — avoid nesting more than 2 levels deep.

**Warning signs:**

- Linear provider returns 401 periodically despite the user not revoking access
- Infinite loop in token refresh logic for Linear (no refresh token available)
- Import returns empty results with HTTP 200 but the `data` key is null

**Phase to address:** Linear provider integration phase. Skip refresh token logic entirely for Linear.

---

## Technical Debt Patterns

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| Store OAuth tokens in `settings` table instead of OS keychain | Zero new dependency | Tokens in plaintext SQLite; readable by any process with file access | Never — the `keyring` crate is already in `Cargo.toml` |
| Pass token as parameter to every IPC command (current pattern) | No TokenManager to build | Token refresh races; token visible in Tauri IPC logs | Never for production; acceptable only in stub/scaffold phase |
| Hard-code `cloud_id` per Jira configuration | Skip `accessible-resources` call | Breaks for any user with multiple Jira sites or renamed workspace | Never — always discover dynamically |
| Ignore `external_updated_at` and always re-fetch all fields on refresh | Simpler refresh logic | Full re-import on every refresh; duplicates if ID format inconsistent | Never — store and compare to detect changes |
| Use the existing `sync_github_issues` / `sync_jira_issues` commands as-is | Faster initial integration | Old code uses Basic auth for Jira (incompatible with OAuth URL pattern); no `external_updated_at` support | Never — must be fully replaced |
| Single fixed port (e.g., 8080) for OAuth redirect | Simpler redirect URI registration | Port collision if another app uses 8080; blocks concurrent OAuth flows | Acceptable only if providers require pre-registered exact URIs (some do) |

---

## Integration Gotchas

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| Jira Cloud OAuth | Using `https://{host}/rest/api/3/` URL (old Basic auth pattern) | Use `https://api.atlassian.com/ex/jira/{cloudId}/rest/api/3/` for all OAuth calls |
| Jira Cloud OAuth | Assuming `accessible-resources[0]` is correct site | Let user confirm or match by `url` field against configured Jira domain |
| GitHub OAuth | Implementing token refresh for GitHub OAuth Apps | GitHub OAuth App tokens never expire; skip all refresh logic |
| GitHub OAuth | Using `repo` scope (gives full private repo access) | Use `public_repo` for public repos; use `repo` only if private repo issues needed |
| GitLab OAuth | Self-hosted URL hardcoded as `gitlab.com` | The base URL must be configurable; self-hosted uses different domain |
| GitLab OAuth | Forgetting to add `gitlab.com` and `*.gitlab.com` to CSP `connect-src` | Add all provider origins to CSP before testing |
| Linear GraphQL | Checking only HTTP status code for errors | Always inspect `response.data.errors` array; 200 can carry errors |
| Linear GraphQL | Requesting full issue history or deeply nested fields | Linear enforces query complexity limits; keep queries flat and minimal |
| `tauri-plugin-oauth` | Starting OAuth flow without stopping the server on cancel | Call `cancel(port)` if the user dismisses the connect dialog; stale server blocks the port |
| `tauri-plugin-oauth` | Not validating `state` parameter in the redirect URL callback | Omitting state validation allows authorization code injection attacks |
| keyring-rs on Linux | Not handling `keyring::Error::NoStorageAccess` | Detect unavailable keyring and fall back to encrypted file storage with a user warning |
| Token exchange | Doing code-for-token POST from TypeScript `fetch()` | Token exchange must happen in Rust via `reqwest` — avoids CSP issues and keeps client secret server-side |

---

## Performance Traps

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| Fetching all open issues on every modal open (no pagination) | Modal takes seconds to show; Jira 65,000-point hourly quota depletes quickly | Use `updated_at` cursor: only fetch issues updated since last sync; implement pagination | At >100 open issues per project |
| GraphQL query complexity budget exhausted (Linear) | 400 errors mid-import; partial imports | Keep queries to flat lists with minimal fields; split large fetches into pages of 50 | At >50 issues per Linear query |
| Jira rate limit: 100 RPS burst, 65,000 points/hour | 429 responses; import fails halfway | Implement exponential backoff on 429; respect `Retry-After` header; fetch issues in pages of 50 | During bulk import of large projects |
| DB mutex held during HTTP request (existing pattern in `sync_github_issues`) | HTTP timeout blocks all other IPC | Fetch all data over HTTP first, then acquire DB lock only for the upsert transaction | Always — never hold DB lock across `.await` |
| Re-computing `Changed` badge by re-fetching all tickets on every Kanban render | Excessive API calls; rate limit exhaustion | Compute `Changed` state at import time, store it; re-check only on explicit modal open or scheduled refresh | At >20 imported tasks |

---

## Security Mistakes

| Mistake | Risk | Prevention |
|---------|------|------------|
| Storing OAuth client secret in `ticketing.json` (per-project config file) | Client secret committed to git or readable by any process | For desktop apps using PKCE, no client secret is needed; OAuth Apps without PKCE use the secret only in Rust, never written to disk |
| Logging access tokens in Rust (e.g., in error messages) | Token exposed in crash logs or debug output | Never format tokens into error strings; use `"[redacted]"` placeholder in error messages |
| Storing access token as plain text in `ticketing.json` | Token readable by any process with file read access | Use OS keychain exclusively via `keyring`; `ticketing.json` stores provider config (provider type, project slug) but never credentials |
| Not validating OAuth `state` parameter | CSRF / authorization code injection — attacker substitutes their auth code | Generate a cryptographically random `state` before redirecting; verify it matches before exchanging the code |
| Accepting redirect to any origin via `tauri-plugin-oauth` callback | Open redirect abuse if URL not validated | Validate the callback URL host is `127.0.0.1` before processing |
| Not zeroizing access/refresh tokens in memory after use | Tokens remain in process memory indefinitely | Use `zeroize` (already in `Cargo.toml`) on token strings; store tokens in `Zeroizing<String>` |

---

## UX Pitfalls

| Pitfall | User Impact | Better Approach |
|---------|-------------|-----------------|
| Browser tab opens for OAuth but app stays behind it | User confused; thinks app crashed | After opening the browser, bring Maestro window back to focus after redirect; show "Waiting for authentication..." spinner |
| OAuth redirect server times out silently | Browser shows blank page; user must retry | Show a user-facing timeout (120s) and a "Try again" button; call `cancel(port)` on timeout |
| "Changed" badge shows for ticket already updated by the user intentionally | Alert fatigue; users ignore all badges | Only flag "Changed" if the ticket content (title or body) changed, not just `updated_at` timestamp |
| Import modal shows all tickets including those already `InProgress` or `Done` | Confusing list; user accidentally re-imports active tasks | Filter imported tickets by state: "Available" (not imported), "Imported" (in Backlog), "Changed" (title/description updated), but never show tickets whose tasks are `InProgress`/`Done` |
| Connecting a second provider replaces the first without warning | User loses first provider's imported tasks | Since v1.6 is one-provider-per-project, surface a clear "Replacing {GitHub} with {Linear} will disconnect your current integration" confirmation dialog |
| OAuth flow starts but user is not signed into the provider in browser | Browser shows provider login page; user completes login; redirect works | This is expected behavior — document it; do not show an error if the redirect takes >30s |

---

## "Looks Done But Isn't" Checklist

- [ ] **OAuth flow cancellation:** Test clicking "Cancel" in the connect dialog mid-flow — verify `cancel(port)` is called and the localhost server shuts down; a stale server will block the same port on the next OAuth attempt
- [ ] **Token persistence across restarts:** Authenticate, quit the app, relaunch — verify the import modal can fetch issues without re-authenticating (token retrieved from keychain)
- [ ] **Token refresh under load:** Leave the import modal open for longer than the provider's token lifetime (GitLab: 2 hours, Jira: 90 days), then refresh — verify new token is used automatically without user intervention
- [ ] **Linux keyring absent:** Run on WSL or a headless Linux environment — verify the app shows a warning toast rather than silently failing to save credentials
- [ ] **Jira multiple workspaces:** Authenticate with an Atlassian account that has access to two Jira Cloud instances — verify the correct workspace is selected (or user is prompted)
- [ ] **Duplicate prevention:** Import 10 issues, then open the modal again and click Import on all 10 — verify no duplicates are created in the Backlog
- [ ] **Change detection accuracy:** Import a ticket, update its title in GitHub, re-open the modal — verify the "Changed" badge appears; update `updated_at` only (no content change) — verify no badge appears if content is unchanged
- [ ] **CSP blocks nothing:** Open browser devtools Network tab, run a full OAuth flow and import — verify no requests are blocked by CSP (no red "blocked" entries)
- [ ] **`external_id` uniqueness across providers:** If the project was previously connected to GitHub and had issues imported, disconnect and connect to Linear — verify no collision on external IDs (canonical format prevents this)
- [ ] **Existing code removal:** Verify `sync_github_issues`, `sync_jira_issues`, and `save_import_config` IPC commands are not registered in `lib.rs` after the migration — old endpoints must be fully removed

---

## Recovery Strategies

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| CSP blocks provider calls in production build | MEDIUM | Update `tauri.conf.json` CSP, rebuild app; no data loss |
| Token refresh race left tokens in invalid state | LOW | User reconnects via OAuth flow; new tokens stored; existing imported tasks unaffected |
| Linux keyring silently dropped tokens | LOW | User re-authenticates; implement fallback storage and redeploy |
| Jira `accessible-resources[0]` selected wrong site | MEDIUM | User reconnects; code updated to show site selector; no data loss if deduplication is by external ID |
| Old `external_id` format caused duplicates | HIGH | Requires manual cleanup: identify and delete duplicates from DB; or bump schema version (destructive migration) to start clean |
| `tauri-plugin-oauth` port already in use | LOW | `start_with_config` with multiple fallback ports; first call that succeeds returns the active port |
| Client secret accidentally written to `ticketing.json` | HIGH | Revoke and regenerate the OAuth client credentials immediately; remove from git history |

---

## Pitfall-to-Phase Mapping

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| CSP blocks provider API calls | OAuth infrastructure setup (first phase) | All provider domains in `connect-src`; devtools shows no blocked requests |
| `tauri-plugin-oauth` capability not registered | OAuth infrastructure setup (first phase) | `invoke('plugin:oauth|start')` returns a port number without error |
| Token refresh race condition | OAuth token management phase | Two concurrent 401 responses result in exactly one refresh attempt; second caller waits and gets new token |
| Linux keyring unavailable | OAuth keychain storage phase | On WSL, warning toast appears; token is stored in fallback encrypted file; next launch restores session |
| Jira `cloud_id` multi-site confusion | Jira provider integration phase | Accessible-resources response with 2+ entries triggers site-selection UI |
| Deduplication with wrong `external_id` format | Schema migration + deduplication phase | Re-importing same issues produces zero new rows; `SyncResult.imported_count = 0` on second call |
| GitHub App vs OAuth App confusion | GitHub provider setup phase | Access token has `gho_` prefix (OAuth App); no refresh token stored |
| Linear GraphQL no refresh | Linear provider integration phase | Linear 401 shows "Reconnect required" immediately; no retry loop |

---

## Sources

- **Codebase inspection (HIGH):** `src-tauri/tauri.conf.json` — existing CSP allows only `api.github.com` and `*.atlassian.net`; missing GitLab, Linear, `auth.atlassian.com`, and `127.0.0.1`
- **Codebase inspection (HIGH):** `src-tauri/capabilities/default.json` — `tauri-plugin-oauth` not registered; must add `oauth:allow-start`, `oauth:allow-cancel`
- **Codebase inspection (HIGH):** `src-tauri/src/ipc/settings_handlers.rs` — existing `sync_jira_issues` uses direct host URL (incompatible with OAuth); `sync_github_issues` uses Basic auth pattern; both must be deleted
- **Codebase inspection (HIGH):** `src-tauri/Cargo.toml` — `keyring = "3.6.3"` already present; `zeroize = "1.8"` already present; `tauri-plugin-oauth` not yet added
- **Context7 / tauri-plugin-oauth docs (HIGH):** `start_with_config` accepts port list and custom response HTML; `cancel(port)` required on user cancellation; `state` parameter must be validated in URL callback
- **Context7 / keyring-rs docs (HIGH):** `use_native_store(true)` prefers Secret Service on Linux; `use_sqlite_store` provides file fallback; `release_store()` must be called on shutdown
- **Atlassian official docs (HIGH):** `accessible-resources` required for `cloud_id` discovery; non-unique IDs across container types; rotating refresh tokens expire after 90 days inactivity; all OAuth calls must use `api.atlassian.com/ex/jira/{cloudId}/` not direct host URL
- **GitHub official docs (HIGH):** OAuth Apps have non-expiring tokens (no refresh); GitHub Apps have 8-hour tokens with 6-month refresh; OAuth App tokens use `gho_` prefix
- **GitLab official docs (HIGH):** PKCE flow recommended for desktop; tokens expire after 2 hours; refresh token rotation invalidates old tokens immediately
- **Jira Cloud rate limiting docs (HIGH):** 100 RPS burst, 65,000 points/hour shared quota; 429 responses include `Retry-After` header; exponential backoff with jitter recommended
- **GitHub rate limit docs (HIGH):** 5,000 requests/hour for authenticated OAuth App calls; `x-ratelimit-reset` header gives retry-after epoch timestamp

---
*Pitfalls research for: Maestro v1.6 — OAuth + Ticket Import milestone*
*Researched: 2026-05-20*
