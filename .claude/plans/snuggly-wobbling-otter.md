# Phase 53-56 Pivot: OAuth → API Key Authentication

## Context

OAuth was originally planned for Phase 53 but requires registering Maestro as an OAuth app on every platform — too complex for the value. Pivoting to API key/PAT authentication for all providers. This simplifies Phase 53-54 dramatically while keeping the same end-user UX (paste token → validate → connected).

Phase 52's KeychainStore + TokenManager remain fully valid — they store PATs the same way they'd store OAuth tokens.

## Scope of Changes

### 1. Update ROADMAP.md + STATE.md

Rewrite Phase 53/54 descriptions and success criteria to reflect API key auth and 6 providers (was 4).

**Phase 53 (batch 1):** GitHub + GitLab + Forgejo — connect + validate + issue fetching
**Phase 54 (batch 2):** Linear + Jira (Cloud+Server) + Azure DevOps — connect + validate + issue fetching

Remove references to OAuth, PKCE, 3LO, token refresh, `tauri-plugin-oauth` usage for ticketing.

### 2. Create `.planning/phases/53-api-key-auth/53-CONTEXT.md`

Capture all decisions from this discussion (see below).

### 3. Update ProviderConfig enum (first task of Phase 53)

File: `src-tauri/src/models/ticketing.rs`

Current variants: `GitHub`, `GitLab`, `Linear`, `Jira`
New variants: `GitHub`, `GitLab`, `Forgejo`, `Linear`, `JiraCloud`, `JiraServer`, `AzureDevOps`

### 4. Remove unused OAuth crates

`tauri-plugin-oauth` and `oauth2` crate were added in Phase 50 for OAuth. No longer needed. Remove them:

- `src-tauri/Cargo.toml`: remove `tauri-plugin-oauth` and `oauth2` dependencies
- `src-tauri/src/main.rs`: remove `.plugin(tauri_plugin_oauth::init())` registration
- `src-tauri/capabilities/default.json`: remove `oauth:allow-start` and `oauth:allow-cancel` permissions
- Verify `cargo check` still passes

---

## Locked Decisions (for CONTEXT.md)

### Providers (6 total, 7 variants)

| Provider | Credentials | Auth Header | Validation | Extra Config |
|----------|------------|-------------|------------|--------------|
| GitHub | PAT (classic) | `Bearer <token>` | `GET /user` | Owner/repo from git remote |
| GitLab | PAT (`read_api` scope) | `PRIVATE-TOKEN: <token>` | `GET /api/v4/user` | Instance URL (default: gitlab.com) |
| Forgejo | API Token | `Authorization: token <token>` | `GET /api/v1/user` | Instance URL + owner/repo from remote |
| Linear | API Key | `Authorization: <key>` | GraphQL `{ viewer { id name } }` | Team selection after connect |
| Jira Cloud | API Token | `Basic base64(email:token)` | `GET /rest/api/3/myself` | Site URL + email |
| Jira Server | PAT | `Bearer <token>` | `GET /rest/api/2/myself` | Base URL (8.14+ required) |
| Azure DevOps | PAT | `Basic base64("":token)` | `GET /_apis/connectionData` | Org URL (`dev.azure.com/{org}`) + project |

### GitHub `gh auth` Integration

1. Try `gh auth token` → if returns token, validate + store automatically
2. If `gh` not found OR not authenticated → show PAT input field
3. No device flow, no interactive `gh auth login` subprocess

### External ID Formats

- `github:{number}`
- `gitlab:{project_id}/{issue_iid}`
- `forgejo:{number}`
- `linear:{identifier}`
- `jira:{issue_key}` (same for Cloud and Server)
- `azuredevops:{id}`

### Phase Batching

- **Phase 53:** GitHub + GitLab + Forgejo (similar REST auth, single PAT, instance URL pattern)
- **Phase 54:** Linear + Jira (Cloud+Server) + Azure DevOps (GraphQL, Basic auth variants, more config)
- **Phase 55:** Settings UI (all 6 providers)
- **Phase 56:** Import Modal + Change Detection

### ProviderConfig Enum (updated)

```rust
#[derive(Serialize, Deserialize, Clone, Debug, Type)]
#[serde(rename_all = "lowercase")]
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
- `GitHubConfig { owner: String, repo: String }` — derived from git remote
- `GitLabConfig { instance_url: String, project_path: String }`
- `ForgejoConfig { instance_url: String, owner: String, repo: String }`
- `LinearConfig { team_id: Option<String> }`
- `JiraCloudConfig { site_url: String, email: String, project_key: String }`
- `JiraServerConfig { base_url: String, project_key: String }`
- `AzureDevOpsConfig { org_url: String, project: String }`

### Azure DevOps

- Only `dev.azure.com/{org}` format (not legacy visualstudio.com)
- Work items fetched via `GET {org_url}/{project}/_apis/wit/wiql` or `workitems` endpoint

### Jira Cloud vs Server

- Cloud: `https://site.atlassian.net` + email + API token → Basic auth → REST API v3
- Server: `https://jira.company.com` + PAT → Bearer auth → REST API v2 (8.14+ required for PAT)
- Same `external_id` format: `jira:{issue_key}` (e.g., `jira:PROJ-123`)

### What stays from Phase 52

- `KeychainStore` stores PATs identically to how it would store OAuth tokens
- `TokenManager` provides secure storage/retrieval — no refresh logic needed (PATs don't expire)
- Service key format: `maestro:{project_id}:ticketing`

---

## Files to Modify

- `.planning/ROADMAP.md` — Phase 53/54 descriptions + success criteria
- `.planning/STATE.md` — current focus text
- `.planning/phases/53-api-key-auth/53-CONTEXT.md` — new file with all decisions above
- `src-tauri/src/models/ticketing.rs` — ProviderConfig enum expansion (Phase 53 task 1)

## Verification

- `cargo check` passes after ProviderConfig update
- `pnpm tauri:gen` regenerates bindings with new variants
- ROADMAP.md accurately reflects API key approach
- CONTEXT.md captures all decisions from this discussion
