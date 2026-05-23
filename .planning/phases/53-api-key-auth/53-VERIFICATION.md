---
phase: 53-api-key-auth
verified: 2026-05-21T17:30:00Z
status: human_needed
score: 10/10 must-haves verified
overrides_applied: 0
human_verification:
  - test: "SC1 — gh CLI absent path surfaces PAT input field in UI"
    expected: "When save_github_credentials is called with token=None and gh is not installed, the IPC returns Err('GitHub: gh CLI not available or not authenticated. Provide a PAT.'). The frontend (Phase 55, not yet built) should render a PAT input field on receiving this error."
    why_human: "The Settings UI (Phase 55) that renders the PAT input field is not yet built. The backend IPC surface returns the correct error string, but whether the frontend correctly handles this error to show a PAT field cannot be verified programmatically until Phase 55 ships."
---

# Phase 53: GitHub/GitLab/Forgejo Auth + API Clients Verification Report

**Phase Goal:** Users can connect GitHub (with gh CLI auto-detect), GitLab (self-hosted), and Forgejo via PAT; the app validates credentials, stores them in the OS keychain, and fetches open issues mapped to RemoteIssue
**Verified:** 2026-05-21T17:30:00Z
**Status:** human_needed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| #   | Truth                                                                                                                                     | Status     | Evidence                                                                                                                                                                                    |
|-----|-------------------------------------------------------------------------------------------------------------------------------------------|------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| 1   | save_github_credentials with token: None detects gh CLI token and stores it; with a PAT string, stores the PAT                           | ✓ VERIFIED | `github.rs:30-48` — `try_gh_cli_token()` checks `which::which("gh")`, runs `gh auth token`, returns trimmed stdout or None. `validate_and_store` lines 61-67: resolves token from None via `try_gh_cli_token()`, returns Err if still None. |
| 2   | save_gitlab_credentials validates against /api/v4/user, resolves numeric project_id via /api/v4/projects/:path, stores token, returns displayName | ✓ VERIFIED | `gitlab.rs:56-122` — GET `{base}/api/v4/user` with `PRIVATE-TOKEN` header; GET `{base}/api/v4/projects/{urlencoded_path}` to resolve `id: i64`; saves GitLabConfig with `project_id: i64`; returns `user.username`. |
| 3   | save_forgejo_credentials validates against /api/v1/user, stores token, returns displayName                                               | ✓ VERIFIED | `forgejo.rs:55-98` — GET `{base}/api/v1/user` with `Authorization: token {token}`; deserializes `ForgejoUserResponse { login }`; saves ForgejoConfig; returns `user.login`.                |
| 4   | delete_ticketing_credentials removes token from keychain and deletes .maestro/ticketing.json                                             | ✓ VERIFIED | `ticketing_handlers.rs:139-163` — calls `app_state.token_manager.delete_token(...)`, then `fs::remove_file` on `.maestro/ticketing.json` if it exists.                                     |
| 5   | fetch_remote_issues reads TicketingConfig, gets token, dispatches to correct provider, returns Vec<RemoteIssue>                           | ✓ VERIFIED | `ticketing_handlers.rs:166-213` — loads config, gets token from manager, matches on ProviderConfig variant (Github/Gitlab/Forgejo/catch-all), dispatches to provider `fetch_issues`.       |
| 6   | GitHub issues exclude PRs (pull_request field absent); external_id is github:{number}                                                    | ✓ VERIFIED | `github.rs:163-173` — `.filter(|issue| issue.pull_request.is_none())`, `external_id: format!("github:{}", issue.number)`. Unit test `test_github_issue_with_pull_request_field_excluded` passes. |
| 7   | GitLab external_id is gitlab:{numeric_project_id}/{issue_iid}; iid not id                                                                | ✓ VERIFIED | `gitlab.rs:167` — `external_id: format!("gitlab:{}/{}", project_id, issue.iid)`. `GitLabIssueResponse` has separate `iid: u64` and `id: u64` fields. Unit test `test_gitlab_response_uses_iid_not_id` passes. |
| 8   | Forgejo external_id is forgejo:{number}; PRs excluded via type=issues query param                                                        | ✓ VERIFIED | `forgejo.rs:115-117` — URL includes `?state=open&type=issues&limit=50`. `external_id: format!("forgejo:{}", issue.number)`.                                                                |
| 9   | ProviderConfig has 7 variants: Github, Gitlab, Forgejo, Linear, JiraCloud, JiraServer, AzureDevOps                                       | ✓ VERIFIED | `models/ticketing.rs:21-29` — 7 variants present. Note: actual Rust identifiers are `Jiracloud`, `Jiraserver`, `Azuredevops` (serde lowercase rename). This is a naming deviation vs. plan spec but functionally equivalent; bindings.ts shows `{ jiracloud: JiraCloudConfig }` etc. |
| 10  | RemoteIssue struct exported; cargo check and pnpm tauri:gen both pass                                                                     | ✓ VERIFIED | `models/ticketing.rs:86-95` — `RemoteIssue` with all 6 fields, `#[specta(export)]`. `lib.rs:15` re-exports `RemoteIssue`. `bindings.ts:1418` contains `export type RemoteIssue = ...`. `cargo check` exits 0, 26 unit tests pass (1 ignored — keychain requires OS). |

**Score:** 10/10 truths verified

### Deferred Items

No items deferred to later phases.

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src-tauri/src/models/ticketing.rs` | ProviderConfig 7-variant enum + RemoteIssue struct | ✓ VERIFIED | 7 variants (Jiracloud/Jiraserver/Azuredevops naming due to serde lowercase), RemoteIssue struct with all required fields, ForgejoConfig present |
| `src-tauri/src/ticketing/github.rs` | try_gh_cli_token + validate_and_store + fetch_issues | ✓ VERIFIED | All three functions present and substantive, 213 lines |
| `src-tauri/src/ticketing/gitlab.rs` | normalize_instance_url + validate_and_store + fetch_issues | ✓ VERIFIED | All three functions present and substantive, 236 lines, urlencoding applied |
| `src-tauri/src/ticketing/forgejo.rs` | normalize_instance_url + validate_and_store + fetch_issues | ✓ VERIFIED | All three functions present and substantive, 205 lines |
| `src-tauri/src/ipc/ticketing_handlers.rs` | 5 new IPC commands | ✓ VERIFIED | save_github_credentials, save_gitlab_credentials, save_forgejo_credentials, delete_ticketing_credentials, fetch_remote_issues — all present with #[tauri::command] and #[specta::specta] |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `ticketing_handlers.rs` | `ticketing/github.rs` | `crate::ticketing::github::validate_and_store / fetch_issues` | ✓ WIRED | Lines 68-76 and 190-192 |
| `ticketing_handlers.rs` | `token_manager` | `app_state.token_manager.store_token / get_token / delete_token` | ✓ WIRED | Store: github.rs:115, gitlab.rs:115, forgejo.rs:91. Get: ticketing_handlers.rs:185-188. Delete: ticketing_handlers.rs:151-154 |
| `ticketing_handlers.rs` | `TicketingConfig::save_to_project` | writes .maestro/ticketing.json after successful validation | ✓ WIRED | `config.save_to_project(project_path)?` in github.rs:107, gitlab.rs:107, forgejo.rs:83 |
| `lib.rs collect_commands` | `ticketing_handlers.rs` | `crate::ipc::save_github_credentials` etc. | ✓ WIRED | `lib.rs:129-133` — all 5 new commands registered |
| `ticketing/mod.rs` | provider modules | `pub mod github; pub mod gitlab; pub mod forgejo;` | ✓ WIRED | `ticketing/mod.rs:3-5` |

### Data-Flow Trace (Level 4)

Not applicable — this phase delivers Rust IPC backend only. No frontend components with state/render cycles were modified.

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| cargo check passes | `cargo check -p maestro 2>&1 \| grep "^error"` | No output (exit 0) | ✓ PASS |
| Unit tests pass | `cargo test -p maestro -- ticketing` | 26 passed, 1 ignored | ✓ PASS |
| bindings.ts has RemoteIssue | `grep RemoteIssue src/types/bindings.ts` | Found at line 1418 | ✓ PASS |
| bindings.ts has all 5 IPC commands | `grep "save_github_credentials\|save_gitlab_credentials\|save_forgejo_credentials\|delete_ticketing_credentials\|fetch_remote_issues" src/types/bindings.ts` | All 5 found at lines 1293-1325 | ✓ PASS |
| tauri-plugin-oauth removed | `grep "tauri-plugin-oauth\|oauth2" src-tauri/Cargo.toml` | No matches | ✓ PASS |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-------------|-------------|--------|----------|
| AUTH-01 | 53-01-PLAN.md | OAuth PKCE flow for GitHub (original) → PAT auth with gh CLI auto-detect (pivoted) | ? NEEDS HUMAN | REQUIREMENTS.md still describes OAuth PKCE; 53-CONTEXT.md documents the deliberate pivot to PAT. The implementation delivers PAT auth (not OAuth PKCE). The requirement text in REQUIREMENTS.md was not updated to reflect the pivot. Functionality implemented is correct per the phase goal and context file, but AUTH-01 as written in REQUIREMENTS.md is not satisfied by this phase. |
| AUTH-02 | 53-01-PLAN.md | OAuth PKCE flow for GitLab cloud (original) → GitLab + Forgejo PAT auth (pivoted) | ? NEEDS HUMAN | Same situation as AUTH-01. Implementation delivers PAT auth for GitLab/Forgejo which differs from the OAuth PKCE spec in REQUIREMENTS.md. |
| PROV-01 | 53-01-PLAN.md | GitHub Issues client — fetch open issues, filter PRs, map fields | ✓ SATISFIED | github.rs fetch_issues implemented and tested. Traceability table maps PROV-01 to Phase 54 but implementation is complete here. |
| PROV-02 | 53-01-PLAN.md | GitLab Issues client — fetch open issues, map fields | ✓ SATISFIED | gitlab.rs fetch_issues implemented, iid used correctly, labels mapped. Traceability table maps PROV-02 to Phase 54 but implementation is complete here. |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `ticketing_handlers.rs` | 211 | `_ => Err("Provider not yet supported in this phase")` | ℹ️ Info | Intentional stub for Linear/Jira/AzDO providers; documented in SUMMARY.md Known Stubs section. Phase 54 will replace this. |

No TODO/FIXME/placeholder comments found in the three provider files or ticketing_handlers.rs. No empty implementations. No hardcoded empty data on rendering paths.

### Human Verification Required

#### 1. PAT input field rendered when gh CLI absent

**Test:** Ensure the Settings UI (Phase 55) correctly handles the Err response from `save_github_credentials` when `token: None` is passed and `gh` is not installed. The error message is "GitHub: gh CLI not available or not authenticated. Provide a PAT."
**Expected:** A PAT input field should appear in the UI, allowing the user to enter a token manually.
**Why human:** The Settings UI has not been built (Phase 55 is not started). The SC1 wording in the roadmap says "a PAT input field is shown instead" — this is a frontend behavior that cannot be verified until Phase 55 ships.

### Gaps Summary

No blocking gaps identified. All 10 must-have truths are verified against actual code. The phase backend IPC surface is complete and correct.

**Documentation inconsistency (non-blocking):** REQUIREMENTS.md AUTH-01 and AUTH-02 still describe OAuth PKCE flows; the deliberate pivot to PAT auth is documented in 53-CONTEXT.md but the requirements file was not updated. This is a documentation debt that should be cleaned up — AUTH-01/AUTH-02 should be reworded to describe PAT auth. The traceability table in REQUIREMENTS.md also lists PROV-01/PROV-02 as Phase 54 scope, but this phase delivers them. These discrepancies are editorial, not code gaps.

**ProviderConfig variant naming:** Rust enum variants are `Jiracloud`, `Jiraserver`, `Azuredevops` (due to `#[serde(rename_all = "lowercase")]` affecting variant identifiers). ROADMAP SC4 and the plan specify `JiraCloud`, `JiraServer`, `AzureDevOps`. The JSON/TypeScript wire format and the bindings both show lowercase forms, which is consistent and intentional. The `fetch_remote_issues` function correctly uses `_ =>` to catch all non-active providers.

---

_Verified: 2026-05-21T17:30:00Z_
_Verifier: Claude (gsd-verifier)_
