# Phase 54: Linear/Jira/AzDO Auth + API Clients - Pattern Map

**Mapped:** 2026-05-21
**Files analyzed:** 8 (4 new provider modules, 4 modified integration points)
**Analogs found:** 8 / 8

---

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `src-tauri/src/ticketing/linear.rs` | service | request-response (GraphQL) | `src-tauri/src/ticketing/github.rs` | role-match (same validate_and_store + fetch pattern; different transport) |
| `src-tauri/src/ticketing/jira_cloud.rs` | service | request-response (REST) | `src-tauri/src/ticketing/gitlab.rs` | role-match (URL normalization + multi-field config) |
| `src-tauri/src/ticketing/jira_server.rs` | service | request-response (REST) | `src-tauri/src/ticketing/gitlab.rs` | role-match (self-hosted URL + Bearer auth) |
| `src-tauri/src/ticketing/azure_devops.rs` | service | request-response (REST, 2-step) | `src-tauri/src/ticketing/github.rs` | role-match (PAT auth; different API shape) |
| `src-tauri/src/ticketing/mod.rs` | config/module | — | `src-tauri/src/ticketing/mod.rs` | exact (add 4 pub mod lines) |
| `src-tauri/src/ipc/ticketing_handlers.rs` | controller | request-response | `src-tauri/src/ipc/ticketing_handlers.rs` | exact (add commands following existing handler pattern) |
| `src-tauri/src/lib.rs` | config | — | `src-tauri/src/lib.rs` | exact (add entries to collect_commands![]) |
| `src-tauri/Cargo.toml` | config | — | `src-tauri/Cargo.toml` | exact (add jc-adf dep, fix graphql_client feature) |

---

## Pattern Assignments

### `src-tauri/src/ticketing/linear.rs` (service, request-response GraphQL)

**Analog:** `src-tauri/src/ticketing/github.rs`

**Imports pattern** (github.rs lines 1-4):
```rust
use crate::models::ticketing::{LinearConfig, ProviderConfig, RemoteIssue, TicketingConfig};
use crate::models::project_config::now_rfc3339;
use crate::ticketing::token_manager::StoredToken;
```

**Response struct pattern** (github.rs lines 6-25):
```rust
// Plain serde structs — do NOT use #[derive(GraphQLQuery)] or graphql_client reqwest feature
// See RESEARCH.md Critical Finding #1 and #2
#[derive(serde::Deserialize)]
struct ViewerResponseData {
    viewer: ViewerUser,
}

#[derive(serde::Deserialize)]
struct ViewerUser {
    id: String,
    name: String,
}

#[derive(serde::Serialize)]
struct GraphqlRequest<'a> {
    query: &'a str,
    variables: serde_json::Value,
}
```

**Inline query constants** (no .graphql file needed):
```rust
const VIEWER_QUERY: &str = "{ viewer { id name } }";
const TEAMS_QUERY: &str = "{ teams { nodes { id name key } } }";
// For issues with optional team filter — use two separate query strings:
const ISSUES_QUERY_ALL: &str = r#"query { issues(first: 100) { nodes { identifier title description url updatedAt labels { nodes { name } } } } }"#;
const ISSUES_QUERY_TEAM: &str = r#"query IssuesByTeam($teamId: ID!) { issues(filter: { team: { id: { eq: $teamId } } }, first: 100) { nodes { identifier title description url updatedAt labels { nodes { name } } } } }"#;
```

**LinearTeam type for TypeScript export** (required by D-04; use ts-rs derive pattern from models/ticketing.rs lines 86-88):
```rust
// Must appear in linear.rs (or ticketing/mod.rs — planner's discretion); must have specta(export)
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, specta::Type)]
#[specta(export)]
pub struct LinearTeam {
    pub id: String,
    pub name: String,
    pub key: String,
}
```

**validate_and_store pattern** (github.rs lines 53-123):
```rust
pub async fn validate_and_store(
    project_id: i32,
    api_key: &str,
    project_path: &str,
    app_state: &crate::db::AppState,
) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))?;

    let body = GraphqlRequest { query: VIEWER_QUERY, variables: serde_json::Value::Null };
    let response = client
        .post("https://api.linear.app/graphql")
        .header("Authorization", format!("Bearer {}", api_key))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Network error: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        if status.as_u16() == 401 {
            return Err("Linear: bad credentials".to_string());
        }
        return Err(format!("Linear API error {}: {}", status.as_u16(), status.canonical_reason().unwrap_or("Unknown")));
    }

    // Use graphql_client::Response<T> for GQL envelope (no feature flag needed — always available)
    let gql: graphql_client::Response<ViewerResponseData> = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse Linear response: {}", e))?;
    if let Some(errors) = &gql.errors {
        if !errors.is_empty() {
            return Err(format!("Linear: {}", errors[0].message));
        }
    }
    let display_name = gql.data
        .ok_or_else(|| "Linear: empty response".to_string())?
        .viewer
        .name;

    let config = TicketingConfig {
        provider: Some(ProviderConfig::Linear(LinearConfig { team_id: None })),
        updated_at: now_rfc3339(),
    };
    config.save_to_project(project_path)?;

    let stored_token = StoredToken {
        access_token: api_key.to_string(),
        refresh_token: None,
        expires_at: None,
        provider: "linear".to_string(),
    };
    app_state.token_manager.store_token(
        project_id,
        stored_token,
        &app_state.app_data_dir,
        &app_state.app_handle,
    )?;

    Ok(display_name)
}
```

**fetch_issues pattern** (github.rs lines 126-178):
```rust
pub async fn fetch_issues(
    token: &str,
    team_id: Option<&str>,
) -> Result<Vec<RemoteIssue>, String> {
    // Build client, POST to https://api.linear.app/graphql
    // Use ISSUES_QUERY_ALL when team_id.is_none(), ISSUES_QUERY_TEAM otherwise
    // Map nodes to RemoteIssue { external_id: format!("linear:{}", issue.identifier), ... }
    // labels from issue.labels.nodes.into_iter().map(|l| l.name).collect()
}
```

**list_teams function** (new, analogous to fetch_issues structure):
```rust
pub async fn list_teams(token: &str) -> Result<Vec<LinearTeam>, String> {
    // POST TEAMS_QUERY to https://api.linear.app/graphql
    // Return Vec<LinearTeam> from response.teams.nodes
}
```

**Error format:** `"Linear: <message>"` — match github.rs pattern at lines 86-93.

**Test pattern** (github.rs lines 180-213):
```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_viewer_response_deserialization() {
        let json = r#"{"data":{"viewer":{"id":"abc","name":"Jane Doe"}}}"#;
        let resp: graphql_client::Response<ViewerResponseData> =
            serde_json::from_str(json).unwrap();
        assert_eq!(resp.data.unwrap().viewer.name, "Jane Doe");
    }

    #[test]
    fn test_linear_external_id_format() {
        assert_eq!(format!("linear:{}", "ENG-42"), "linear:ENG-42");
    }
    // Add: issues deserialization, team filter switch, labels extraction
}
```

---

### `src-tauri/src/ticketing/jira_cloud.rs` (service, request-response REST)

**Analog:** `src-tauri/src/ticketing/gitlab.rs`

**Imports pattern** (gitlab.rs lines 1-4 + forgejo.rs line 25):
```rust
use crate::models::ticketing::{JiraCloudConfig, ProviderConfig, RemoteIssue, TicketingConfig};
use crate::models::project_config::now_rfc3339;
use crate::ticketing::token_manager::StoredToken;
use super::normalize_instance_url;
```

**Response struct pattern** (gitlab.rs lines 5-25):
```rust
#[derive(serde::Deserialize)]
struct JiraMyselfResponse {
    #[serde(rename = "displayName")]
    display_name: Option<String>,
    #[serde(rename = "emailAddress")]
    email_address: Option<String>,
}

#[derive(serde::Deserialize)]
struct JiraSearchResponse {
    issues: Vec<JiraIssueResponse>,
}

#[derive(serde::Deserialize)]
struct JiraIssueResponse {
    key: String,             // e.g. "PROJ-42"
    #[serde(rename = "self")]
    self_url: String,
    fields: JiraIssueFields,
}

#[derive(serde::Deserialize)]
struct JiraIssueFields {
    summary: String,
    description: Option<serde_json::Value>,  // ADF object — NOT Option<String>
    labels: Vec<String>,
    updated: Option<String>,
}
```

**Basic auth construction** (base64 encode, from RESEARCH.md Pattern 4):
```rust
use base64::Engine as _;

fn make_basic_auth(email: &str, api_token: &str) -> String {
    let credentials = format!("{}:{}", email, api_token);
    let encoded = base64::engine::general_purpose::STANDARD.encode(&credentials);
    format!("Basic {}", encoded)
}
```

**ADF body extraction** (RESEARCH.md Pattern 2 — jc-adf usage):
```rust
fn extract_body(description: Option<serde_json::Value>) -> Option<String> {
    description.map(|adf| jc_adf::from_adf::to_markdown(&adf))
}
// Note: to_markdown() is infallible — no ? needed. Fallback is at the Option level.
```

**validate_and_store pattern** (gitlab.rs lines 32-113):
```rust
pub async fn validate_and_store(
    project_id: i32,
    site_url: &str,
    email: &str,
    api_token: &str,
    project_key: &str,
    project_path: &str,
    app_state: &crate::db::AppState,
) -> Result<String, String> {
    let base = normalize_instance_url(site_url);  // normalize once, reuse
    let auth = make_basic_auth(email, api_token);

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))?;

    let response = client
        .get(format!("{}/rest/api/3/myself", base))
        .header("Authorization", auth)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("Network error: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        if status.as_u16() == 401 {
            return Err("Jira Cloud: bad credentials".to_string());
        }
        return Err(format!("Jira Cloud API error {}: {}", status.as_u16(), status.canonical_reason().unwrap_or("Unknown")));
    }

    let user: JiraMyselfResponse = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse Jira Cloud response: {}", e))?;
    let display_name = user.display_name
        .or(user.email_address)
        .unwrap_or_else(|| "unknown".to_string());

    let config = TicketingConfig {
        provider: Some(ProviderConfig::Jiracloud(JiraCloudConfig {
            site_url: base,
            email: email.to_string(),
            project_key: project_key.to_string(),
        })),
        updated_at: now_rfc3339(),
    };
    config.save_to_project(project_path)?;

    let stored_token = StoredToken {
        access_token: api_token.to_string(),
        refresh_token: None,
        expires_at: None,
        provider: "jira_cloud".to_string(),
    };
    app_state.token_manager.store_token(
        project_id,
        stored_token,
        &app_state.app_data_dir,
        &app_state.app_handle,
    )?;

    Ok(display_name)
}
```

**fetch_issues pattern** (gitlab.rs lines 117-168):
```rust
pub async fn fetch_issues(
    site_url: &str,
    email: &str,
    api_token: &str,
    project_key: &str,
) -> Result<Vec<RemoteIssue>, String> {
    // base = normalize_instance_url(site_url) — call again here (not stored in JiraCloudConfig)
    // GET {base}/rest/api/3/search?jql=...&maxResults=100&fields=...
    // Map issues to RemoteIssue { external_id: format!("jira:{}", issue.key), ... }
    // body: extract_body(issue.fields.description)
    // url: issue.self_url (or construct from base + issue key — self_url is the API URL; prefer constructing browser URL)
}
```

**external_id format:** `"jira:{issue.key}"` e.g. `"jira:PROJ-42"` — from CONTEXT.md §External ID Formats.

**Test pattern** (gitlab.rs lines 170-227):
```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_jira_cloud_response_deserialization() { /* fixture JSON with ADF description */ }

    #[test]
    fn test_adf_body_extraction_some() {
        let adf = serde_json::json!({"type":"doc","version":1,"content":[]});
        let result = extract_body(Some(adf));
        assert!(result.is_some());
    }

    #[test]
    fn test_adf_body_extraction_none() {
        assert_eq!(extract_body(None), None);
    }

    #[test]
    fn test_jira_cloud_external_id_format() {
        assert_eq!(format!("jira:{}", "PROJ-42"), "jira:PROJ-42");
    }

    #[test]
    fn test_normalize_instance_url_strips_trailing_slash() {
        assert_eq!(normalize_instance_url("https://myco.atlassian.net/"), "https://myco.atlassian.net");
    }
}
```

---

### `src-tauri/src/ticketing/jira_server.rs` (service, request-response REST)

**Analog:** `src-tauri/src/ticketing/gitlab.rs`

**Imports pattern** (same as jira_cloud.rs; replace JiraCloudConfig with JiraServerConfig):
```rust
use crate::models::ticketing::{JiraServerConfig, ProviderConfig, RemoteIssue, TicketingConfig};
use crate::models::project_config::now_rfc3339;
use crate::ticketing::token_manager::StoredToken;
use super::normalize_instance_url;
```

**Response struct pattern** — Server v2 description is `Option<String>`, NOT ADF:
```rust
// Jira Server v2: description is plain text string (RESEARCH.md Pitfall 3, Assumption A5)
#[derive(serde::Deserialize)]
struct JiraServerMyselfResponse {
    #[serde(rename = "displayName")]
    display_name: Option<String>,
    name: Option<String>,  // Jira Server may use 'name' instead of 'displayName'
}

#[derive(serde::Deserialize)]
struct JiraServerSearchResponse {
    issues: Vec<JiraServerIssueResponse>,
}

#[derive(serde::Deserialize)]
struct JiraServerIssueResponse {
    key: String,
    fields: JiraServerIssueFields,
}

#[derive(serde::Deserialize)]
struct JiraServerIssueFields {
    summary: String,
    description: Option<String>,  // plain string in v2 (not ADF)
    labels: Vec<String>,
    updated: Option<String>,
}
```

**Bearer auth** (differs from Jira Cloud Basic auth — no base64 needed):
```rust
// Jira Server: Authorization: Bearer {token}
// Source: Atlassian Server PAT docs (RESEARCH.md Pattern 4)
let auth_header = format!("Bearer {}", token);
```

**validate_and_store pattern** (gitlab.rs lines 32-113 — same structure, different endpoint/auth):
```rust
pub async fn validate_and_store(
    project_id: i32,
    base_url: &str,
    project_key: &str,
    token: &str,
    project_path: &str,
    app_state: &crate::db::AppState,
) -> Result<String, String> {
    let base = normalize_instance_url(base_url);
    // GET {base}/rest/api/2/myself with Authorization: Bearer {token}
    // Save JiraServerConfig { base_url: base, project_key }
    // store_token with provider: "jira_server"
}
```

**fetch_issues:** `GET {base}/rest/api/2/search?jql=project = {project_key} AND statusCategory != Done&maxResults=100`
- `external_id`: `format!("jira:{}", issue.key)`
- `body`: `issue.fields.description` directly (no ADF conversion)

**Test pattern** (gitlab.rs lines 170-227):
```rust
#[cfg(test)]
mod tests {
    // normalize_instance_url tests (same as gitlab.rs/forgejo.rs — copy exactly)
    // Response deserialization with plain string description
    // external_id format test
}
```

---

### `src-tauri/src/ticketing/azure_devops.rs` (service, request-response REST 2-step)

**Analog:** `src-tauri/src/ticketing/github.rs`

**Imports pattern** (github.rs lines 1-4):
```rust
use crate::models::ticketing::{AzureDevOpsConfig, ProviderConfig, RemoteIssue, TicketingConfig};
use crate::models::project_config::now_rfc3339;
use crate::ticketing::token_manager::StoredToken;
use super::normalize_instance_url;
use base64::Engine as _;
```

**AzDO Basic auth** (RESEARCH.md Pattern 4 — empty username):
```rust
fn make_azdo_auth(token: &str) -> String {
    let credentials = format!(":{}", token);
    let encoded = base64::engine::general_purpose::STANDARD.encode(&credentials);
    format!("Basic {}", encoded)
}
```

**Response structs for WIQL + batch** (RESEARCH.md Code Examples):
```rust
#[derive(serde::Serialize)]
struct WiqlRequest<'a> {
    query: &'a str,
}

#[derive(serde::Deserialize)]
struct WiqlResponse {
    #[serde(rename = "workItems")]
    work_items: Vec<WiqlWorkItemRef>,
}

#[derive(serde::Deserialize)]
struct WiqlWorkItemRef {
    id: i32,
}

#[derive(serde::Serialize)]
struct BatchRequest<'a> {
    ids: &'a [i32],
    fields: &'a [&'a str],
}

#[derive(serde::Deserialize)]
struct BatchResponse {
    value: Vec<WorkItemDetail>,
}

#[derive(serde::Deserialize)]
struct WorkItemDetail {
    id: i32,
    fields: WorkItemFields,
}

#[derive(serde::Deserialize)]
struct WorkItemFields {
    #[serde(rename = "System.Title")]
    title: String,
    #[serde(rename = "System.Description")]
    description: Option<String>,
    #[serde(rename = "System.WorkItemType")]
    work_item_type: Option<String>,
    #[serde(rename = "System.ChangedDate")]
    changed_date: Option<String>,
    #[serde(rename = "System.Tags")]
    tags: Option<String>,
}
```

**WIQL query constant** (D-02):
```rust
const WIQL_QUERY: &str =
    "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = '{project}' AND [System.State] <> 'Closed'";
// Note: format! with project name to substitute {project} at runtime
```

**validate_and_store pattern** (github.rs lines 53-123):
```rust
pub async fn validate_and_store(
    project_id: i32,
    org_url: &str,
    project: &str,
    token: &str,
    project_path: &str,
    app_state: &crate::db::AppState,
) -> Result<String, String> {
    let base = normalize_instance_url(org_url);
    let auth = make_azdo_auth(token);

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))?;

    // Validation: GET {base}/_apis/connectionData?api-version=7.1
    // Extract display name from response (authenticatedUser.providerDisplayName or subjectDescriptor)
    // Save AzureDevOpsConfig { org_url: base, project }
    // store_token with provider: "azure_devops"
}
```

**fetch_issues — 2-step pattern** (unique to AzDO):
```rust
pub async fn fetch_issues(
    org_url: &str,
    project: &str,
    token: &str,
) -> Result<Vec<RemoteIssue>, String> {
    let base = normalize_instance_url(org_url);
    let auth = make_azdo_auth(token);
    let wiql_query = format!(
        "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = '{}' AND [System.State] <> 'Closed'",
        project
    );

    // Step 1: POST WIQL — returns Vec<WiqlWorkItemRef> with IDs
    // Step 2: chunk IDs into groups of 200 (batch limit), POST to workitemsbatch for each chunk
    // Construct browser URL: format!("{}/{}/workitems/edit/{}", base, project, item.id) — NOT the API url field
    // external_id: format!("azuredevops:{}", item.id)
    // body: item.fields.description as-is (HTML for v1.6 — acceptable per RESEARCH.md Pitfall 5)
    // labels: split tags on "; " if present
    // updated_at: item.fields.changed_date
}
```

**Test pattern** (github.rs lines 180-213):
```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_wiql_response_deserialization() { /* fixture with work_items array */ }

    #[test]
    fn test_batch_response_deserialization() { /* fixture with value array */ }

    #[test]
    fn test_azdo_external_id_format() {
        let id: i32 = 42;
        assert_eq!(format!("azuredevops:{}", id), "azuredevops:42");
    }

    #[test]
    fn test_normalize_instance_url_strips_trailing_slash() {
        assert_eq!(normalize_instance_url("https://dev.azure.com/myorg/"), "https://dev.azure.com/myorg");
    }
}
```

---

### `src-tauri/src/ticketing/mod.rs` (config, module declarations)

**Analog:** `src-tauri/src/ticketing/mod.rs` (exact match — add 4 lines)

**Current content** (lines 1-19):
```rust
pub mod keychain;
pub mod token_manager;
pub mod github;
pub mod gitlab;
pub mod forgejo;

pub use keychain::KeychainStore;
pub use token_manager::{StoredToken, TokenManager};

pub(crate) fn normalize_instance_url(url: &str) -> String { ... }
```

**Modification — add after line 5:**
```rust
pub mod linear;
pub mod jira_cloud;
pub mod jira_server;
pub mod azure_devops;
```

No other changes to mod.rs.

---

### `src-tauri/src/ipc/ticketing_handlers.rs` (controller, request-response)

**Analog:** `src-tauri/src/ipc/ticketing_handlers.rs` (exact match — add 5 commands and 4 match arms)

**IPC handler pattern** (ticketing_handlers.rs lines 62-87 — copy for each new command):
```rust
#[tauri::command]
#[specta::specta]
pub async fn save_linear_credentials(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    api_key: String,
) -> Result<String, String> {
    let project_path = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        conn.query_row(
            "SELECT path FROM projects WHERE id = ?",
            [project_id],
            |row| row.get::<_, String>(0),
        ).map_err(|_| format!("Project {} not found", project_id))?
    };  // Mutex lock released here — BEFORE .await
    crate::ticketing::linear::validate_and_store(
        project_id,
        &api_key,
        &project_path,
        &app_state,
    )
    .await
}
```

**list_linear_teams command** (D-04 — new command, same handler shape):
```rust
#[tauri::command]
#[specta::specta]
pub async fn list_linear_teams(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
) -> Result<Vec<crate::ticketing::linear::LinearTeam>, String> {
    let token = app_state
        .token_manager
        .get_token(project_id, &app_state.app_data_dir, &app_state.app_handle)?
        .ok_or_else(|| "No stored Linear credentials found".to_string())?;
    crate::ticketing::linear::list_teams(&token.access_token).await
}
```

**fetch_remote_issues match arms** (ticketing_handlers.rs lines 199-221 — add after Forgejo arm):
```rust
ProviderConfig::Linear(cfg) => {
    crate::ticketing::linear::fetch_issues(
        &token.access_token,
        cfg.team_id.as_deref(),
    )
    .await
}
ProviderConfig::Jiracloud(cfg) => {
    crate::ticketing::jira_cloud::fetch_issues(
        &cfg.site_url,
        &cfg.email,
        &token.access_token,
        &cfg.project_key,
    )
    .await
}
ProviderConfig::Jiraserver(cfg) => {
    crate::ticketing::jira_server::fetch_issues(
        &cfg.base_url,
        &cfg.project_key,
        &token.access_token,
    )
    .await
}
ProviderConfig::Azuredevops(cfg) => {
    crate::ticketing::azure_devops::fetch_issues(
        &cfg.org_url,
        &cfg.project,
        &token.access_token,
    )
    .await
}
// Remove the catch-all: _ => Err("Provider not yet supported in this phase".to_string()),
```

**Critical: Mutex lock drop pattern** (ticketing_handlers.rs lines 70-77 — must be replicated exactly in every new command):
```rust
let project_path = {
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
    conn.query_row(
        "SELECT path FROM projects WHERE id = ?",
        [project_id],
        |row| row.get::<_, String>(0),
    ).map_err(|_| format!("Project {} not found", project_id))?
};  // <-- closing brace drops the MutexGuard before the first .await
```

---

### `src-tauri/src/lib.rs` (config, command registration)

**Analog:** `src-tauri/src/lib.rs` (exact match — add 5 entries)

**Current ticketing block** (lib.rs lines 125-133):
```rust
// Ticketing providers (Phase 53)
crate::ipc::save_github_credentials,
crate::ipc::save_gitlab_credentials,
crate::ipc::save_forgejo_credentials,
crate::ipc::delete_ticketing_credentials,
crate::ipc::fetch_remote_issues,
```

**Add after line 131 (Phase 53 providers block):**
```rust
// Ticketing providers (Phase 54)
crate::ipc::save_linear_credentials,
crate::ipc::list_linear_teams,
crate::ipc::save_jira_cloud_credentials,
crate::ipc::save_jira_server_credentials,
crate::ipc::save_azure_devops_credentials,
```

---

### `src-tauri/Cargo.toml` (config, dependency management)

**Analog:** `src-tauri/Cargo.toml` (exact match — 2 changes)

**Change 1 — fix graphql_client feature** (line 23, RESEARCH.md Critical Finding #1):
```toml
# Before (current — pulls reqwest 0.12 conflict):
graphql_client = { version = "0.16", default-features = false, features = ["reqwest"] }

# After (correct — no reqwest conflict; Response<T> type still available):
graphql_client = { version = "0.16", default-features = false }
```

**Change 2 — add jc-adf** (insert after line 23, D-06):
```toml
jc-adf = "0.2"
```

---

## Shared Patterns

### Token Store Pattern
**Source:** `src-tauri/src/ticketing/github.rs` lines 108-120
**Apply to:** All 4 new provider modules — `validate_and_store()` in each
```rust
let stored_token = StoredToken {
    access_token: token.to_string(),  // the PAT/API key value
    refresh_token: None,
    expires_at: None,
    provider: "linear".to_string(),   // change per provider: "jira_cloud", "jira_server", "azure_devops"
};
app_state.token_manager.store_token(
    project_id,
    stored_token,
    &app_state.app_data_dir,
    &app_state.app_handle,
)?;
```

### TicketingConfig Save Pattern
**Source:** `src-tauri/src/ticketing/github.rs` lines 100-107
**Apply to:** All 4 new provider modules — end of `validate_and_store()`
```rust
let config = TicketingConfig {
    provider: Some(ProviderConfig::Linear(LinearConfig { team_id: None })),
    updated_at: now_rfc3339(),
};
config.save_to_project(project_path)?;
```

### HTTP Client Construction
**Source:** `src-tauri/src/ticketing/github.rs` lines 70-73 and `src-tauri/src/ticketing/gitlab.rs` lines 42-45
**Apply to:** All 4 new modules — both `validate_and_store()` and `fetch_issues()` build their own client
```rust
let client = reqwest::Client::builder()
    .timeout(std::time::Duration::from_secs(15))
    .build()
    .map_err(|e| format!("Failed to build HTTP client: {}", e))?;
```

### HTTP Error Response Pattern
**Source:** `src-tauri/src/ticketing/github.rs` lines 83-93
**Apply to:** All 4 new modules — after every `.send().await`
```rust
if !response.status().is_success() {
    let status = response.status();
    if status.as_u16() == 401 {
        return Err("<Provider>: bad credentials".to_string());
    }
    return Err(format!(
        "<Provider> API error {}: {}",
        status.as_u16(),
        status.canonical_reason().unwrap_or("Unknown")
    ));
}
```

### URL Normalization Pattern
**Source:** `src-tauri/src/ticketing/gitlab.rs` line 40 and `src-tauri/src/ticketing/forgejo.rs` line 38
**Apply to:** `jira_cloud.rs`, `jira_server.rs`, `azure_devops.rs` (all self-hosted/variable URLs)
```rust
// At top of validate_and_store() AND fetch_issues() — normalize once, store in `base`
let base = normalize_instance_url(instance_url);
// Never call normalize_instance_url() twice on the same value in a single function call
```

### Mutex Lock Drop Pattern (IPC)
**Source:** `src-tauri/src/ipc/ticketing_handlers.rs` lines 70-77
**Apply to:** All 5 new IPC commands in `ticketing_handlers.rs`
```rust
let project_path = {
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
    conn.query_row(
        "SELECT path FROM projects WHERE id = ?",
        [project_id],
        |row| row.get::<_, String>(0),
    ).map_err(|_| format!("Project {} not found", project_id))?
};  // MutexGuard dropped here — BEFORE any .await
```

### Error Message Format
**Source:** `src-tauri/src/ticketing/github.rs` line 86, `src-tauri/src/ticketing/gitlab.rs` line 55
**Apply to:** All 4 new modules
- Pattern: `"<ProviderName>: <message>"`
- Examples: `"Linear: bad credentials"`, `"Jira Cloud: bad credentials"`, `"Jira Server: bad credentials"`, `"Azure DevOps: bad credentials"`
- Never echo the token value in error messages

---

## No Analog Found

All files have close analogs. No entries needed in this section.

---

## Metadata

**Analog search scope:** `src-tauri/src/ticketing/`, `src-tauri/src/ipc/ticketing_handlers.rs`, `src-tauri/src/models/ticketing.rs`, `src-tauri/src/lib.rs`, `src-tauri/Cargo.toml`
**Files scanned:** 7 (github.rs, gitlab.rs, forgejo.rs, mod.rs, ticketing_handlers.rs, models/ticketing.rs, Cargo.toml)
**Pattern extraction date:** 2026-05-21

### Key Notes for Planner

1. **graphql_client feature MUST be fixed** before linear.rs can compile — change `features = ["reqwest"]` to `features = []` (or omit features entirely). This removes reqwest 0.12 from the build. See RESEARCH.md Critical Finding #1.

2. **`graphql_client::Response<T>`** is available with no feature flags. Use it only for deserialization typing — do not use `post_graphql()` helper (reqwest 0.12 incompatible).

3. **`LinearTeam` struct** must derive `specta::Type` and be tagged `#[specta(export)]` so `pnpm tauri:gen` regenerates `src/types/bindings.ts`. The struct can live in `linear.rs` and be re-exported from `ticketing/mod.rs`, OR placed in `models/ticketing.rs`. Either is acceptable — planner should pick one location and keep it consistent.

4. **Jira Cloud description is `Option<serde_json::Value>`** (ADF JSON object), NOT `Option<String>`. Jira Server description IS `Option<String>`. These are different types in their respective struct definitions.

5. **AzDO browser URL** must be constructed as `{base}/{project}/_workitems/edit/{id}` — the `url` field in WIQL/batch responses is an API URL, not a browser URL. See RESEARCH.md Pitfall 6.

6. **`list_linear_teams` IPC** does not need a project_path lookup — it only needs the stored token. The handler shape differs slightly from save_* handlers (no `validate_and_store` delegation). See handler pattern excerpt above.

7. **The `_ => Err(...)` catch-all arm** in `fetch_remote_issues` must be removed once all 7 provider arms are handled. After Phase 54, all `ProviderConfig` variants will have explicit arms — the exhaustive match will cover the entire enum.
