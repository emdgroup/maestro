---
phase: 53-api-key-auth
created: 2026-05-21
supersedes: 53-oauth (dropped — OAuth requires platform app registration, too complex for v1.6)
---

# Phase 53 Context: GitHub/GitLab/Forgejo API Key Auth + API Clients

## Pivot Decision

OAuth was dropped in favor of API key / PAT authentication for all providers.
- No platform OAuth app registration required
- No PKCE/3LO state machines, no token refresh, no browser redirects
- `tauri-plugin-oauth` and `oauth2` crates removed in this phase
- `KeychainStore` + `TokenManager` from Phase 52 store PATs identically to OAuth tokens — no changes needed

## Providers in This Phase (Batch 1 of 2)

| Provider | Auth Type | Header | Validation Endpoint |
|----------|-----------|--------|---------------------|
| GitHub | PAT (classic) | `Authorization: Bearer <token>` | `GET https://api.github.com/user` |
| GitLab | PAT (`read_api` scope) | `PRIVATE-TOKEN: <token>` | `GET {instance_url}/api/v4/user` |
| Forgejo | API Token | `Authorization: token <token>` | `GET {instance_url}/api/v1/user` |

Batch 2 (Phase 54): Linear, Jira Cloud/Server, Azure DevOps.

## GitHub-Specific: gh CLI Auto-Detect

1. On connect, try `gh auth token` (shell out, capture stdout)
2. If returns a non-empty token → validate via `GET /user` → store in keychain → done (no UI needed)
3. If `gh` not found OR exits non-zero → show PAT input field
4. No device flow. No `gh auth login` subprocess. No interactive shell.

## GitLab: Self-Hosted Support

- User provides `instance_url` (default shown: `https://gitlab.com`)
- `normalizeHostedInstanceUrl()` strips trailing slash, ensures https://
- Owner/repo derived from project's git remote matching the instance host

## Forgejo: Self-Hosted Support

- Same pattern as GitLab: user provides instance URL + API token
- Owner/repo derived from git remote matching the instance host
- API compatible with Gitea (same endpoints)

## External ID Formats (locked)

These formats are canonical and must not change across phases:

| Provider | Format | Example |
|----------|--------|---------|
| GitHub | `github:{number}` | `github:42` |
| GitLab | `gitlab:{project_id}/{issue_iid}` | `gitlab:12345/7` |
| Forgejo | `forgejo:{number}` | `forgejo:42` |
| Linear | `linear:{identifier}` | `linear:ENG-123` |
| Jira (Cloud+Server) | `jira:{issue_key}` | `jira:PROJ-123` |
| Azure DevOps | `azuredevops:{id}` | `azuredevops:9876` |

## ProviderConfig Enum Update (Task 1)

Current variants in `src-tauri/src/models/ticketing.rs`: `GitHub`, `GitLab`, `Linear`, `Jira`

Replace with:

```rust
pub enum ProviderConfig {
    Github(GitHubConfig),
    Gitlab(GitLabConfig),
    Forgejo(ForgejoConfig),
    Linear(LinearConfig),
    JiraCloud(JiraCloudConfig),
    JiraServer(JiraServerConfig),
    AzureDevOps(AzureDevOpsConfig),
}
```

Config structs:
- `GitHubConfig { owner: String, repo: String }` — parsed from git remote
- `GitLabConfig { instance_url: String, project_path: String }`
- `ForgejoConfig { instance_url: String, owner: String, repo: String }`
- `LinearConfig { team_id: Option<String> }` — Phase 54
- `JiraCloudConfig { site_url: String, email: String, project_key: String }` — Phase 54
- `JiraServerConfig { base_url: String, project_key: String }` — Phase 54
- `AzureDevOpsConfig { org_url: String, project: String }` — Phase 54

All structs need `#[derive(Serialize, Deserialize, Clone, Debug, Default, Type)]` and `#[serde(default)]`.

## Crate Cleanup (Task in This Phase)

Remove from `src-tauri/Cargo.toml`:
- `tauri-plugin-oauth`
- `oauth2`

Remove from `src-tauri/src/main.rs`:
- `.plugin(tauri_plugin_oauth::init())`

Remove from `src-tauri/capabilities/default.json`:
- `oauth:allow-start`
- `oauth:allow-cancel`

## RemoteIssue Shape

Each provider client returns `Vec<RemoteIssue>`:

```rust
pub struct RemoteIssue {
    pub external_id: String,      // e.g. "github:42"
    pub title: String,
    pub body: Option<String>,
    pub url: String,
    pub labels: Vec<String>,
    pub updated_at: Option<String>, // ISO 8601
}
```

GitHub: filter out pull_request field (PRs have it, issues don't).
GitLab: use `iid` (internal) not `id` (global) for issue number in external_id.
Forgejo: same as GitHub structure.

## IPC Commands to Add

```rust
// Connect a provider (validate + store credentials)
save_github_credentials(project_id: i32, owner: String, repo: String, token: Option<String>) -> Result<String, String>
save_gitlab_credentials(project_id: i32, instance_url: String, token: String) -> Result<String, String>
save_forgejo_credentials(project_id: i32, instance_url: String, token: String) -> Result<String, String>

// Disconnect
delete_ticketing_credentials(project_id: i32) -> Result<(), String>

// Fetch issues (used by Phase 56 import modal)
fetch_remote_issues(project_id: i32) -> Result<Vec<RemoteIssue>, String>
```

`save_github_credentials` with `token: None` triggers the `gh auth token` auto-detect path.

## Key Files

- `src-tauri/src/models/ticketing.rs` — ProviderConfig enum update
- `src-tauri/src/ticketing/mod.rs` — add provider modules
- `src-tauri/src/ticketing/github.rs` — connection service + issue client
- `src-tauri/src/ticketing/gitlab.rs` — connection service + issue client
- `src-tauri/src/ticketing/forgejo.rs` — connection service + issue client
- `src-tauri/src/ipc/ticketing_handlers.rs` — new IPC commands
- `src-tauri/src/main.rs` — remove tauri_plugin_oauth init
- `src-tauri/Cargo.toml` — remove oauth2 + tauri-plugin-oauth
- `src-tauri/capabilities/default.json` — remove oauth capabilities

## Decisions from Prior Phases Still Valid

- CSP expansion (Phase 50) covers all provider API hosts — no changes needed
- `KeychainStore` service key: `maestro:{project_id}:ticketing`
- `TokenManager.store_token(project_id, token, app_data_dir, app_handle)` — Phase 53 calls this after validation
- `TokenManager.get_token(project_id, app_data_dir, app_handle)` — provider clients call this before each request
- One provider per project: enforced by `TicketingConfig.provider: Option<ProviderConfig>`
