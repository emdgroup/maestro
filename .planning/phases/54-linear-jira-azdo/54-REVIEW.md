---
phase: 54-linear-jira-azdo
reviewed: 2026-05-21T21:34:30Z
depth: standard
files_reviewed: 8
files_reviewed_list:
  - src-tauri/src/ticketing/linear.rs
  - src-tauri/src/ticketing/jira_cloud.rs
  - src-tauri/src/ticketing/azure_devops.rs
  - src-tauri/src/ticketing/mod.rs
  - src-tauri/src/ipc/ticketing_handlers.rs
  - src-tauri/src/lib.rs
  - src-tauri/Cargo.toml
  - src/types/bindings.ts
findings:
  critical: 3
  warning: 4
  info: 2
  total: 9
status: issues_found
---

# Phase 54: Code Review Report

**Reviewed:** 2026-05-21T21:34:30Z
**Depth:** standard
**Files Reviewed:** 8
**Status:** issues_found

## Summary

Phase 54 adds Linear, Jira Cloud, and Azure DevOps ticketing providers, following the pattern established in Phase 53 for GitHub/GitLab/Forgejo. The overall structure is sound and consistent. However, three critical issues were identified: two injection vulnerabilities (WIQL query injection and JQL injection where user-controlled values are interpolated directly into query strings), and a functional bug where the `save_ticketing_config` handler silently discards `delete_token` errors in violation of the project's explicit rule against `let _ =` on fallible operations. Four warnings cover a missing state filter in the Linear issues query, a cross-provider token confusion risk, and two code-quality issues.

## Critical Issues

### CR-01: WIQL injection in Azure DevOps fetch_issues

**File:** `src-tauri/src/ticketing/azure_devops.rs:171-174`
**Issue:** The `project` parameter (the AzDO project name, stored in `AzureDevOpsConfig.project`) is interpolated directly into the WIQL query string with no escaping. A project name containing a single-quote — either maliciously crafted or legitimately containing punctuation — will break out of the string literal, corrupting the query or enabling injection.

Example: a project named `O'Hara's App` would produce:
```
WHERE [System.TeamProject] = 'O'Hara's App'
```
which is a syntax error. A project named `' OR 1=1 --` would produce a logically different query.

The value comes from the persisted `AzureDevOpsConfig`, so exploitation requires a user who can supply the project name at setup time (the `save_azure_devops_credentials` IPC command accepts it from the frontend). In a multi-user or compromised-config scenario this is exploitable.

**Fix:** Escape single quotes by doubling them before interpolation, or — better — use a parameterised WIQL approach if the AzDO API supports it. For the simple escaping fix:
```rust
let project_escaped = project.replace('\'', "''");
let wiql_query = format!(
    "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = '{}' AND [System.State] <> 'Closed'",
    project_escaped
);
```
The URL segment (`wiql_url` and `batch_url`, lines 175 and 208) has the same issue — `project` is interpolated into the URL path without percent-encoding. Use `urlencoding::encode(project)` there:
```rust
let project_encoded = urlencoding::encode(project);
let wiql_url = format!("{}/{}/_apis/wit/wiql?api-version=7.1", base, project_encoded);
let batch_url = format!("{}/{}/_apis/wit/workitemsbatch?api-version=7.1", base, project_encoded);
```

---

### CR-02: JQL injection in Jira Cloud fetch_issues

**File:** `src-tauri/src/ticketing/jira_cloud.rs:129-137`
**Issue:** The `project_key` is interpolated directly into the JQL query string. JQL keywords and special characters (spaces, quotes, `OR`, `AND`) in a project key would alter the query semantics. The Jira project key is stored in `JiraCloudConfig.project_key` and originally provided by the user at credential-save time.

```rust
let jql = format!(
    "project = {} AND statusCategory != Done ORDER BY updated DESC",
    project_key
);
```

A `project_key` of `FOO OR statusCategory != Done` would return issues from all projects. A key of `FOO ORDER BY updated DESC--` could truncate the intended filter.

**Fix:** Quote the project key in JQL and escape any embedded double-quotes:
```rust
let safe_key = project_key.replace('"', "\\\"");
let jql = format!(
    "project = \"{}\" AND statusCategory != Done ORDER BY updated DESC",
    safe_key
);
```

---

### CR-03: `let _ =` on fallible `delete_token` in save_ticketing_config violates project coding rules

**File:** `src-tauri/src/ipc/ticketing_handlers.rs:46-51`
**Issue:** `CLAUDE.md` explicitly states: *"Never silently discard errors with `let _ =` on fallible operations."* The comment says "Best-effort — not fatal if no token stored," but `delete_token` can also fail for reasons beyond "no token exists" (e.g., keyring I/O error, file permission error). Silently swallowing these failures means a stale credential may remain in the keychain/file with no feedback to the user or any log trace.

```rust
let _ = app_state.token_manager.delete_token(
    project_id,
    &app_state.app_data_dir,
    &app_state.app_handle,
);
```

**Fix:** The intent is correct (don't fail the save if there's no token to delete), but the approach is wrong. Distinguish "not found" (benign) from actual errors:
```rust
match app_state.token_manager.delete_token(
    project_id,
    &app_state.app_data_dir,
    &app_state.app_handle,
) {
    Ok(()) => {}
    Err(e) => {
        // Non-fatal: stale credential may persist, but save_ticketing_config should not fail.
        // Surface to frontend via a separate warning event if needed.
        eprintln!("Warning: failed to clear stale ticketing token: {}", e);
    }
}
```
Or if the team decides this truly must be fire-and-forget, wrap it in a function that logs and returns `()`, making the intent explicit rather than silently discarding a `Result`.

---

## Warnings

### WR-01: Linear issues queries fetch all states — "open issues" claim is incorrect

**File:** `src-tauri/src/ticketing/linear.rs:79-80`
**Issue:** Both issue queries (`ISSUES_QUERY_ALL` and `ISSUES_QUERY_TEAM`) contain no state filter. The `fetch_issues` function's doc comment says "Fetch open issues from Linear" but these queries return issues in all states — including Completed, Cancelled, and Backlog.

```rust
const ISSUES_QUERY_ALL: &str = r#"{ issues(first: 100) { nodes { ... } } }"#;
const ISSUES_QUERY_TEAM: &str = r#"query IssuesByTeam($teamId: ID!) { issues(filter: { team: { id: { eq: $teamId } } }, first: 100) { ... } }"#;
```

For workspaces with many completed issues this will surface noise in the task import UI and waste the 100-item page budget on already-resolved items.

**Fix:** Add a state filter excluding completed/cancelled states. Linear's GraphQL API supports this:
```
issues(filter: { state: { type: { nin: ["completed", "cancelled"] } } }, first: 100)
```
For `ISSUES_QUERY_TEAM`, add to the existing filter object:
```
filter: { team: { id: { eq: $teamId } }, state: { type: { nin: ["completed", "cancelled"] } } }
```

---

### WR-02: list_linear_teams does not verify stored token belongs to Linear provider

**File:** `src-tauri/src/ipc/ticketing_handlers.rs:167-176`
**Issue:** `list_linear_teams` fetches the token via `token_manager.get_token(project_id, ...)` and passes it to `linear::list_teams`. The token manager stores one token per project regardless of which provider it belongs to. If a project previously had a Jira Cloud or GitHub token and has since been switched to Linear (but `validate_and_store` for Linear has not yet been called), the wrong provider's token will be sent to the Linear GraphQL API.

The `StoredToken` struct has a `provider` field precisely for this purpose, but it is never checked at the call site.

**Fix:** Validate the provider field before use:
```rust
let token = app_state
    .token_manager
    .get_token(project_id, &app_state.app_data_dir, &app_state.app_handle)?
    .ok_or_else(|| "No stored Linear credentials found".to_string())?;

if token.provider != "linear" {
    return Err(format!(
        "Stored token belongs to provider '{}', not 'linear'",
        token.provider
    ));
}
crate::ticketing::linear::list_teams(&token.access_token).await
```
The same cross-provider check applies to `fetch_remote_issues` — when dispatching to each provider arm in the `match`, the token's `provider` field is never validated against the matched `ProviderConfig` variant. This is a latent issue across all providers (lines 289-333 of `ticketing_handlers.rs`) but is most acute for `list_linear_teams` since it exists as a standalone endpoint with no provider-config guard.

---

### WR-03: Jira Cloud ADF description conversion silently drops non-doc-type nodes

**File:** `src-tauri/src/ticketing/jira_cloud.rs:39-41`
**Issue:** `extract_body` calls `jc_adf::from_adf::to_markdown(&adf)` on the raw ADF `serde_json::Value`. The `jc-adf` crate's `to_markdown` function silently returns an empty string or partial output for ADF documents that use node types it does not recognise. Since Jira Server and certain Jira Cloud configurations use different ADF schema versions, this will silently produce empty `body` fields on affected issues.

There is no error surface here — the conversion failure is invisible. A user importing an issue with a complex description will see an empty body with no indication that content was lost.

**Fix:** At minimum, log when the ADF conversion produces an empty string for a non-null ADF input:
```rust
fn extract_body(description: Option<serde_json::Value>) -> Option<String> {
    description.map(|adf| {
        let md = jc_adf::from_adf::to_markdown(&adf);
        if md.is_empty() {
            // ADF had content but produced no markdown — unsupported node types
            None
        } else {
            Some(md)
        }
    }).flatten()
}
```
If `jc_adf` provides an error variant, propagate it; otherwise this defensive check is the minimum.

---

### WR-04: Each provider function builds a new reqwest::Client per call

**File:** `src-tauri/src/ticketing/linear.rs:111-114`, `jira_cloud.rs:55-58`, `azure_devops.rs:94-97`, `azure_devops.rs:165-168`
**Issue:** Every call to `validate_and_store`, `list_teams`, and `fetch_issues` constructs a new `reqwest::Client`. `reqwest::Client` internally manages a connection pool; creating a new instance per call defeats connection reuse and pays TLS handshake cost on every call. In `azure_devops::fetch_issues` a single logical operation builds one client but calls it across multiple chunk iterations — that is fine — but the client itself is freshly constructed on every IPC invocation.

This is not a performance issue (out of v1 scope) but it is a code-quality issue: the pattern is inconsistent with idiomatic reqwest usage and will become a maintainability problem as more providers are added.

**Fix:** Share a single `reqwest::Client` stored in `AppState`, or at minimum document that the current per-call construction is intentional. A shared client stored in `AppState` avoids rebuilding the TLS session on every credential validation or issue fetch.

---

## Info

### IN-01: Linear `ISSUES_QUERY_ALL` comment is misleading (doc says "open issues")

**File:** `src-tauri/src/ticketing/linear.rs:208`
**Issue:** The doc comment on `fetch_issues` says *"Fetch open issues from Linear"* but the actual queries have no state filter (see WR-01). The comment is a false contract.

**Fix:** Update the doc comment to reflect actual behaviour until the filter is added:
```rust
/// Fetch issues from Linear (all states), optionally filtered to a specific team.
```

---

### IN-02: Unused `#[allow(dead_code)]` on ViewerUser.id

**File:** `src-tauri/src/ticketing/linear.rs:20-21`
**Issue:** `ViewerUser.id` is annotated `#[allow(dead_code)]`. The field is received from the API but never used. If it is truly not needed, it should be removed from the struct rather than suppressed. If it may be needed later, this is dead code.

**Fix:** Remove the `id` field from `ViewerUser` if it is not used:
```rust
#[derive(serde::Deserialize)]
struct ViewerUser {
    name: String,
}
```
This also removes the need for the `#[allow(dead_code)]` attribute.

---

_Reviewed: 2026-05-21T21:34:30Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
