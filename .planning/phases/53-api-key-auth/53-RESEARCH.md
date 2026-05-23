# Phase 53: GitHub/GitLab/Forgejo PAT Auth + API Clients — Research

**Researched:** 2026-05-21
**Domain:** Rust async HTTP (reqwest), tokio::process, Tauri IPC, provider REST APIs
**Confidence:** HIGH

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

- PAT / API key auth only. No OAuth, no browser redirects, no tauri-plugin-oauth.
- Providers in this phase: GitHub (PAT Bearer), GitLab (PRIVATE-TOKEN), Forgejo (token).
- GitHub auto-detect: `gh auth token` subprocess; if fails/absent → show PAT input.
- `TokenManager.store_token` / `get_token` from Phase 52 used as-is.
- `ProviderConfig` enum renamed variants: `Github`, `Gitlab`, `Forgejo`, `Linear`, `JiraCloud`, `JiraServer`, `AzureDevOps`.
- External ID formats are canonical (locked in CONTEXT.md).
- IPC commands: `save_github_credentials`, `save_gitlab_credentials`, `save_forgejo_credentials`, `delete_ticketing_credentials`, `fetch_remote_issues`.
- `KeychainStore` service key: `maestro:{project_id}:ticketing`.
- One provider per project (`TicketingConfig.provider: Option<ProviderConfig>`).
- CSP from Phase 50 already covers all provider API hosts.

### Claude's Discretion

- Internal structure of `github.rs`, `gitlab.rs`, `forgejo.rs` modules.
- How to build and reuse the `reqwest::Client` within provider modules.
- Error message formatting for HTTP status codes.
- Test strategy.

### Deferred Ideas (OUT OF SCOPE)

- Linear, Jira Cloud, Jira Server, Azure DevOps (Phase 54).
- Issue pagination beyond first page.
- Issue writing / creating / updating.
- PR filtering UI.
</user_constraints>

---

## Summary

This phase adds PAT-based authentication and open-issue fetching for three Git forges (GitHub, GitLab, Forgejo). The implementation is purely additive: new Rust modules under `src-tauri/src/ticketing/`, new IPC commands in `ticketing_handlers.rs`, and a model update.

The codebase already has all required infrastructure. `reqwest 0.13.x` is declared in `Cargo.toml` (with `json` feature) but has zero source usages today — Phase 53 will be its first consumer. `tokio::process::Command` is extensively used in `src-tauri/src/git/mod.rs` with a consistent pattern; the `gh auth token` call follows that pattern exactly. `AppState` already contains `token_manager` and `app_data_dir`. IPC handler structure is stable and uniform across all domain files.

**Primary recommendation:** Follow the established `tokio::process::Command` + `reqwest::Client` patterns from git.rs; keep provider logic in dedicated modules; IPC handlers are thin glue only.

---

## 1. reqwest Usage Patterns

### Current State

`reqwest` is declared in `src-tauri/Cargo.toml` but not yet used in any `.rs` source file.
[VERIFIED: Grep across src-tauri/src/**/*.rs — no reqwest imports found]

**Declared dependency:**
```toml
reqwest = { version = "0.13", default-features = true, features = ["json"] }
```
[VERIFIED: src-tauri/Cargo.toml line 29]

**Resolved version:** 0.13.3 with `default-tls` (native-tls) and `json` feature active.
[VERIFIED: cargo metadata]

### Recommended Client Pattern

Since there are no existing reqwest usages to mirror, create a per-call `Client::builder()` — no shared singleton needed for low-frequency ticketing calls. Do not attach default headers at the client level; add auth headers per-request so different providers can use the same construction path.

```rust
// Source: reqwest 0.13 docs — per-call client with timeout
let client = reqwest::Client::builder()
    .timeout(std::time::Duration::from_secs(15))
    .build()
    .map_err(|e| format!("Failed to build HTTP client: {}", e))?;

// Add auth header per-request
let response = client
    .get(&url)
    .header("Authorization", format!("Bearer {}", token))
    .header("User-Agent", "maestro/1.0")
    .send()
    .await
    .map_err(|e| format!("Request failed: {}", e))?;
```

**TLS note:** `default-features = true` activates `default-tls` (native-tls). This works on all three platforms without additional config. No `rustls-tls` feature is enabled; do not add it — the native-tls path is what the workspace is built with.
[VERIFIED: cargo metadata features list for reqwest 0.13.3]

**No shared client singleton needed.** Provider functions are called infrequently (on connect + on import). Constructing a client per call avoids lifetime/Arc complexity and the overhead is negligible.

---

## 2. subprocess (gh auth token) Pattern

### Established Pattern in Codebase

`tokio::process::Command` is used extensively in `src-tauri/src/git/mod.rs`.
[VERIFIED: git/mod.rs lines 6, 19, 39-48, 256-269, 300-309, etc.]

**Canonical pattern for capturing stdout:**
```rust
use tokio::process::Command as TokioCommand;

let output = TokioCommand::new("gh")
    .args(["auth", "token"])
    .output()
    .await
    .map_err(|e| format!("Failed to spawn gh: {}", e))?;
```

**Check availability first using `which`:**
```rust
// which crate is already in Cargo.toml (v8.0.2) and used in process/pty.rs, execution_handlers.rs
if which::which("gh").is_err() {
    return Ok(None); // gh not installed — fall through to PAT input
}
```
[VERIFIED: which crate usage in acp/resolve.rs, process/pty.rs, ipc/execution_handlers.rs]

**Full gh auto-detect pattern:**
```rust
pub async fn try_gh_cli_token() -> Option<String> {
    if which::which("gh").is_err() {
        return None;
    }
    let output = TokioCommand::new("gh")
        .args(["auth", "token"])
        .output()
        .await
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let token = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if token.is_empty() { None } else { Some(token) }
}
```

**`std::process::Command`** is also used (in `ipc/filesystem_handlers.rs` for synchronous accent color detection). For the gh call, use `tokio::process::Command` since it runs inside an async IPC handler.
[VERIFIED: filesystem_handlers.rs line 106]

---

## 3. IPC Handler Structure

### Pattern (from ticketing_handlers.rs and worktree_handlers.rs)

All async IPC commands follow this exact structure:
[VERIFIED: src-tauri/src/ipc/ticketing_handlers.rs, worktree_handlers.rs, acp_handlers.rs]

```rust
use std::sync::Arc;
use tauri::State;
use crate::db::AppState;

#[tauri::command]
#[specta::specta]
pub async fn save_github_credentials(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    owner: String,
    repo: String,
    token: Option<String>,
) -> Result<String, String> {
    // 1. Get project path from DB (requires lock drop before await)
    let path = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        conn.query_row(
            "SELECT path FROM projects WHERE id = ?",
            [project_id],
            |row| row.get::<_, String>(0),
        ).map_err(|_| format!("Project {} not found", project_id))?
    }; // lock released here

    // 2. Async work (HTTP, subprocess) — no DB lock held
    // ...

    // 3. TokenManager (uses app_state.token_manager + app_state.app_data_dir + app_state.app_handle)
    app_state.token_manager.store_token(
        project_id,
        stored_token,
        &app_state.app_data_dir,
        &app_state.app_handle,
    )?;

    Ok("connected".to_string())
}
```

**Critical:** The `Mutex<Connection>` (sync mutex) must be released before any `.await` point. Pattern: wrap DB access in a block `{ let conn = ...; ... }` to drop the guard, then do async work. This is already the established pattern in the codebase.
[VERIFIED: ticketing_handlers.rs lines 13-20, worktree_handlers.rs lines 20-30]

**AppState fields available to handlers:**
- `app_state.db` — `Mutex<Connection>` (sync)
- `app_state.app_handle` — `AppHandle` (for `app_handle.emit(...)` and passing to TokenManager)
- `app_state.app_data_dir` — `PathBuf` (for TokenManager file fallback)
- `app_state.token_manager` — `crate::ticketing::TokenManager`

[VERIFIED: src-tauri/src/db/connection.rs lines 126-140]

**Registration:** New commands go in `src-tauri/src/lib.rs` inside `collect_commands![...]`.
[VERIFIED: lib.rs lines 125-128 show existing ticketing commands at the bottom]

**Module pub-use:** `ticketing_handlers.rs` already exists and its contents are re-exported via `ipc/mod.rs` line `pub use ticketing_handlers::*;`.
[VERIFIED: ipc/mod.rs line 24]

**Error return:** All IPC commands return `Result<T, String>`. Error strings are user-visible. Format as: `"GitHub API error 401: Unauthorized"` or `"GitHub: bad credentials"`.
[VERIFIED: ticketing_handlers.rs, task_handlers.rs — consistent Result<T, String>]

---

## 4. Provider API Mappings

### Serde Structs for Response Deserialization

Only the fields needed for `RemoteIssue` mapping are included.

#### GitHub

Endpoint: `GET https://api.github.com/issues` (user auth check) and `GET https://api.github.com/repos/{owner}/{repo}/issues?state=open&per_page=100`

Required header: `User-Agent: maestro/1.0` (GitHub returns 403 without it)
[CITED: https://docs.github.com/en/rest/using-the-rest-api/getting-started-with-the-rest-api#user-agent-required]

Filter: exclude items where `pull_request` field is present (issues lack it, PRs have it).
[CITED: https://docs.github.com/en/rest/issues/issues#list-repository-issues]

```rust
#[derive(Deserialize)]
struct GitHubIssueResponse {
    number: u64,
    title: String,
    body: Option<String>,
    html_url: String,
    labels: Vec<GitHubLabel>,
    updated_at: Option<String>,
    pull_request: Option<serde_json::Value>, // present on PRs, absent on issues
}

#[derive(Deserialize)]
struct GitHubLabel {
    name: String,
}

#[derive(Deserialize)]
struct GitHubUserResponse {
    login: String, // used to confirm token is valid
}
```

**external_id:** `format!("github:{}", issue.number)`

#### GitLab

Validation endpoint: `GET {instance_url}/api/v4/user` with header `PRIVATE-TOKEN: {token}`
Issues endpoint: `GET {instance_url}/api/v4/projects/{encoded_project_path}/issues?state=opened&per_page=100`

Project path encoding: URL-encode with `urlencoding::encode()` (already in Cargo.toml v2.1).
[VERIFIED: urlencoding in Cargo.toml line 42 — `urlencoding = "2.1"`]

```rust
#[derive(Deserialize)]
struct GitLabIssueResponse {
    iid: u64,        // project-scoped issue number (use this for external_id)
    id: u64,         // global GitLab ID (do NOT use for external_id)
    title: String,
    description: Option<String>,
    web_url: String,
    labels: Vec<String>, // GitLab returns labels as plain strings
    updated_at: Option<String>,
}

#[derive(Deserialize)]
struct GitLabUserResponse {
    username: String,
}
```

**external_id:** `format!("gitlab:{}/{}", project_id_or_path_numeric, issue.iid)`

Note: CONTEXT.md specifies format `gitlab:{project_id}/{issue_iid}`. The `project_id` here is the GitLab numeric project ID (obtained from the validate-user step or a separate `GET /projects/:path` call). Simplest approach: call `GET /api/v4/projects/{encoded_path}` once to get the numeric `id`, then use it in external_id.
[CITED: https://docs.gitlab.com/ee/api/projects.html#get-single-project]

#### Forgejo

Validation endpoint: `GET {instance_url}/api/v1/user` with header `Authorization: token {token}`
Issues endpoint: `GET {instance_url}/api/v1/repos/{owner}/{repo}/issues?state=open&type=issues&limit=50`

Forgejo API is Gitea-compatible. Response shape is identical to GitHub for issues.
[CITED: https://codeberg.org/api/swagger — Forgejo public API reference]

```rust
#[derive(Deserialize)]
struct ForgejoIssueResponse {
    number: u64,
    title: String,
    body: Option<String>,
    html_url: String,
    labels: Vec<ForgejoLabel>,
    updated_at: Option<String>,
    // No pull_request field — Forgejo type=issues filter excludes PRs at query time
}

#[derive name="ForgejoLabel"]
#[derive(Deserialize)]
struct ForgejoLabel {
    name: String,
}

#[derive(Deserialize)]
struct ForgejoUserResponse {
    login: String,
}
```

**external_id:** `format!("forgejo:{}", issue.number)`

**Key difference from GitHub:** Forgejo uses `?type=issues` query param to exclude PRs server-side; GitHub requires client-side filtering on the `pull_request` field.
[CITED: https://codeberg.org/api/swagger#/issue/issueListIssues]

### RemoteIssue Mapping Summary

| Provider | `external_id` | `title` | `body` | `url` | `labels` | `updated_at` |
|----------|--------------|---------|--------|-------|----------|--------------|
| GitHub | `github:{number}` | `title` | `body` | `html_url` | `labels[].name` | `updated_at` |
| GitLab | `gitlab:{numeric_project_id}/{iid}` | `title` | `description` | `web_url` | `labels[]` (strings) | `updated_at` |
| Forgejo | `forgejo:{number}` | `title` | `body` | `html_url` | `labels[].name` | `updated_at` |

---

## 5. URL Normalization

### No Existing Utility Found

There is no shared URL normalization helper in the codebase. The only existing trim patterns are `trim_end_matches('/')` applied inline in path concatenation (acp_handlers.rs, project_handlers.rs).
[VERIFIED: Grep for "normalize", "trailing_slash", "trim_end_matches" — only path strings found, no URL struct]

### Recommended Pattern

Implement a small inline function in each of `gitlab.rs` and `forgejo.rs`:

```rust
fn normalize_instance_url(url: &str) -> String {
    let trimmed = url.trim_end_matches('/');
    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        trimmed.to_string()
    } else {
        format!("https://{}", trimmed)
    }
}
```

This is consistent with `trim_end_matches('/')` already used elsewhere in the codebase and adds the https-default behavior specified in CONTEXT.md.

---

## 6. Error Handling

### Established Pattern

All IPC commands return `Result<T, String>`. Error strings are directly user-visible.
[VERIFIED: All handler files consistently use `Result<T, String>`]

**Pattern for HTTP errors:**
```rust
let response = client.get(&url)
    .header("Authorization", format!("Bearer {}", token))
    .send()
    .await
    .map_err(|e| format!("Network error: {}", e))?;

if !response.status().is_success() {
    let status = response.status();
    return Err(format!("GitHub API error {}: {}", status.as_u16(), status.canonical_reason().unwrap_or("Unknown")));
}

let body: GitHubUserResponse = response.json().await
    .map_err(|e| format!("Failed to parse GitHub response: {}", e))?;
```

**No custom error type needed.** The codebase uniformly uses `String` errors from IPC. Do not introduce `thiserror` for these handlers even though `thiserror = "2"` is in Cargo.toml — it is only used in other crates.
[VERIFIED: Cargo.toml has thiserror; src-tauri/src/ipc/ handlers all use String errors]

---

## 7. Test Approach

### Existing Test Infrastructure

Tests exist in `src-tauri/src/ticketing/token_manager.rs` and `src-tauri/src/ticketing/keychain.rs`.
[VERIFIED: Both files have `#[cfg(test)] mod tests { ... }` blocks]

**Pattern from `keychain.rs`:**
- Pure unit tests using `tempfile::tempdir()` for filesystem isolation
- `#[ignore = "requires OS keychain (run manually)"]` for tests needing OS resources
- `tempfile` is already in `[dev-dependencies]`
[VERIFIED: Cargo.toml line 50: `tempfile = "3"`]

**Pattern from `token_manager.rs`:**
- Sync tests (no `#[tokio::test]`) for logic that doesn't need async
- `Arc::ptr_eq` for identity checks on shared state

### Recommended Test Strategy for Phase 53

Provider modules (`github.rs`, `gitlab.rs`, `forgejo.rs`) should be tested with unit tests covering:

1. **URL normalization** — pure function, sync, no deps
2. **Response deserialization** — construct JSON literal, deserialize, assert field mapping
3. **PR filtering (GitHub)** — verify `pull_request` field presence/absence filters correctly
4. **external_id formatting** — verify the `github:42`, `gitlab:12345/7`, `forgejo:42` formats

These tests require no network and no OS keychain. They can run in CI with `cargo test`.

**Integration tests against live APIs** should be `#[ignore = "requires network and PAT"]` following the keychain.rs pattern.

Example unit test pattern:
```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_normalize_instance_url_strips_trailing_slash() {
        assert_eq!(normalize_instance_url("https://gitlab.com/"), "https://gitlab.com");
    }

    #[test]
    fn test_github_issue_excludes_pr() {
        let json = r#"{"number":1,"title":"PR","body":null,"html_url":"","labels":[],"updated_at":null,"pull_request":{}}"#;
        let issue: GitHubIssueResponse = serde_json::from_str(json).unwrap();
        assert!(issue.pull_request.is_some());
    }

    #[test]
    fn test_gitlab_response_uses_iid() {
        let json = r#"{"iid":7,"id":99999,"title":"Bug","description":null,"web_url":"","labels":[],"updated_at":null}"#;
        let issue: GitLabIssueResponse = serde_json::from_str(json).unwrap();
        assert_eq!(issue.iid, 7);
        assert_eq!(issue.id, 99999);
    }
}
```

---

## 8. State of Crate Cleanup

The CONTEXT.md mentions removing `tauri-plugin-oauth` and `oauth2`. Checking the current state:

- `src-tauri/main.rs`: No `tauri_plugin_oauth::init()` call present
- `src-tauri/capabilities/default.json`: No oauth permissions present (`"core:default", "opener:default", "dialog:default", "core:window:allow-show"` only)
- `src-tauri/Cargo.toml`: No `tauri-plugin-oauth` or `oauth2` dependency present

[VERIFIED: main.rs full read, capabilities/default.json read, Cargo.toml read]

**The cleanup is already done.** The CONTEXT.md describes it as a task but it has been completed in the phase 53 pivot commit (`98d8771: chore(53): pivot to API key auth, update ROADMAP/STATE, remove OAuth crates`). No cleanup work needed.

---

## 9. Key Risks and Unknowns

### Risk 1: reqwest 0.13 First Usage — Potential Compilation Issues

`reqwest 0.13.x` with `default-tls` pulls in `native-tls`. On Linux dev machines, this requires `libssl-dev` (OpenSSL headers). If the dev environment lacks these headers, `cargo build` will fail.

**Mitigation:** The project already builds (other crates like `russh` use TLS). If build issues arise, switching to `rustls-tls` feature is the fallback — but do not preemptively change features.

### Risk 2: GitLab Numeric Project ID Required for external_id

The CONTEXT.md locks the `external_id` format to `gitlab:{project_id}/{issue_iid}` where `project_id` is numeric. The user configures a `project_path` (e.g., `mygroup/myrepo`), not a numeric ID. This means `save_gitlab_credentials` must call `GET /api/v4/projects/{encoded_path}` to resolve the numeric ID, then store it in `GitLabConfig`.

**Required action:** `GitLabConfig` needs a `project_id: Option<i64>` field (stored after first API call) in addition to `project_path: String`. Alternatively, use `project_path` in both `external_id` generation and the issues endpoint URL — but this breaks the locked format. The locked format requires numeric ID.

**Recommended resolution:** Store the numeric project ID at connect time. `GitLabConfig` becomes:
```rust
pub struct GitLabConfig {
    pub instance_url: String,
    pub project_path: String,
    pub project_id: i64, // numeric, resolved at connect time
}
```

### Risk 3: StoredToken.provider Field Mismatch

`StoredToken` has a `provider: String` field. The `token_manager.rs` doesn't validate this field — it's informational. Use `"github"`, `"gitlab"`, `"forgejo"` as string values when constructing `StoredToken` for each provider.
[VERIFIED: StoredToken struct in token_manager.rs line 9-15]

### Risk 4: octocrab Unused

`octocrab = { version = "0.51" }` is in `Cargo.toml` with JWT features. It appears to have been added in anticipation of GitHub API work. It is not used anywhere in the current source.
[VERIFIED: Grep for "octocrab" in src/**/*.rs — zero matches]

**Recommendation:** Do NOT use `octocrab` for this phase. The IPC handlers return `Result<T, String>` and `octocrab`'s error types don't convert to `String` cleanly. Plain `reqwest` calls with manual JSON deserialization are simpler and consistent with how the rest of the codebase handles external processes. `octocrab` can be removed from `Cargo.toml` in this phase as dead weight, or left for a future decision.

### Risk 5: ProviderConfig Enum Rename — Serialization Breaking Change

The current enum variants are `GitHub`, `GitLab`, etc. with `#[serde(rename_all = "lowercase")]` producing `"github"`, `"gitlab"` keys. The CONTEXT.md renames them to `Github`, `Gitlab` (removing the uppercase B/L).

With `#[serde(rename_all = "lowercase")]`, both `GitHub` and `Github` serialize to `"github"` — so the on-disk JSON format does not change. The rename is purely cosmetic for Rust code.
[VERIFIED: ticketing.rs line 20 `#[serde(rename_all = "lowercase")]`]

---

## Architecture Patterns

### Recommended Module Structure

```
src-tauri/src/ticketing/
├── mod.rs              — pub mod declarations + pub use
├── keychain.rs         — (Phase 52, exists)
├── token_manager.rs    — (Phase 52, exists)
├── github.rs           — GitHub connection + issue client
├── gitlab.rs           — GitLab connection + issue client
└── forgejo.rs          — Forgejo connection + issue client
```

Each provider file exposes:
- `pub async fn validate_and_store(...)` — validate PAT, write TicketingConfig, store token
- `pub async fn fetch_issues(...)` — get token, call issues API, return `Vec<RemoteIssue>`

IPC handlers in `ticketing_handlers.rs` call these functions and handle `Result<T, String>` propagation.

### Data Flow

```
IPC call (frontend)
    → ticketing_handlers.rs (thin glue, gets project path + calls provider fn)
        → github.rs / gitlab.rs / forgejo.rs (HTTP calls, response mapping)
            → TokenManager (read/write PAT via keychain or file fallback)
                → KeychainStore (OS keychain or AES-GCM encrypted file)
        → TicketingConfig::save_to_project (write .maestro/ticketing.json)
    → Result<T, String> back to frontend
```

---

## Sources

### Primary (HIGH confidence)
- `src-tauri/src/git/mod.rs` — tokio::process::Command patterns
- `src-tauri/src/db/connection.rs` — AppState structure
- `src-tauri/src/ipc/ticketing_handlers.rs` — IPC handler pattern
- `src-tauri/src/ticketing/token_manager.rs` — StoredToken + TokenManager API
- `src-tauri/src/ticketing/keychain.rs` — KeychainStore API
- `src-tauri/Cargo.toml` — exact dependencies and features
- `src-tauri/src/lib.rs` — command registration pattern
- `src-tauri/src/ipc/mod.rs` — module export pattern

### Secondary (MEDIUM confidence)
- [CITED: docs.github.com/en/rest] — GitHub REST API issue shape + User-Agent requirement
- [CITED: docs.gitlab.com/ee/api] — GitLab REST API issue shape, iid vs id, projects endpoint
- [CITED: codeberg.org/api/swagger] — Forgejo API (Gitea-compatible), type=issues filter

### Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Forgejo `type=issues` query param excludes PRs server-side | Provider API Mappings | PRs would appear in results; add client-side filter as fallback |
| A2 | GitLab `labels[]` is `Vec<String>` (not `Vec<{name, color, ...}>`) | Provider API Mappings | Deserialization would fail; use `serde_json::Value` as escape hatch |

**Both A1 and A2 are consistent with public API documentation but should be confirmed against a live Forgejo/GitLab instance during implementation.**

---

## Metadata

**Confidence breakdown:**
- reqwest patterns: HIGH — verified in Cargo.toml; TLS config from cargo metadata
- tokio::process pattern: HIGH — verified in git/mod.rs (extensively used)
- IPC handler structure: HIGH — verified in ticketing_handlers.rs and acp_handlers.rs
- Provider API response shapes: MEDIUM — cited from official docs; A1/A2 assumptions noted
- URL normalization: HIGH — no existing utility confirmed; pattern is simple and consistent with codebase

**Research date:** 2026-05-21
**Valid until:** 2026-06-21 (stable codebase, locked deps)
