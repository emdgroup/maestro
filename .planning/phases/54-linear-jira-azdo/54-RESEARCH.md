# Phase 54: Linear/Jira/AzDO Auth + API Clients — Research

**Researched:** 2026-05-21
**Domain:** Rust ticketing provider modules (GraphQL + REST), dependency management
**Confidence:** HIGH (codebase verified) / MEDIUM (API shapes from official docs)

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **D-01:** Fetch all work item types in the AzDO project (no type filter).
- **D-02:** WIQL query: `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = '{project}' AND [System.State] <> 'Closed'`. Fixed query — not configurable.
- **D-03:** `save_linear_credentials(project_id, api_key)` validates via `{ viewer { id name } }` — does NOT require team at connect time.
- **D-04:** `list_linear_teams(project_id) -> Result<Vec<LinearTeam>, String>` IPC returns `{ id, name, key }` per team. Phase 55 consumes this for a team picker.
- **D-05:** `fetch_remote_issues` with `team_id = None` fetches all workspace issues; `team_id = Some(id)` filters via `filter: { team: { id: { eq: $teamId } } }`.
- **D-06:** Use `jc-adf` Rust crate for ADF → Markdown. Call `jc_adf::from_adf::to_markdown()`. Add to `src-tauri/Cargo.toml`.
- **D-07:** ADF parse/conversion failure falls back to `None` body — not an error.
- **D-08:** Two separate files: `jira_cloud.rs` and `jira_server.rs`. No `jira_common.rs`.
- **D-09:** `save_linear_credentials(project_id: i32, api_key: String) -> Result<String, String>`
- **D-10:** `list_linear_teams(project_id: i32) -> Result<Vec<LinearTeam>, String>`
- **D-11:** `save_jira_cloud_credentials(project_id: i32, site_url: String, email: String, api_token: String, project_key: String) -> Result<String, String>`
- **D-12:** `save_jira_server_credentials(project_id: i32, base_url: String, project_key: String, token: String) -> Result<String, String>`
- **D-13:** `save_azure_devops_credentials(project_id: i32, org_url: String, project: String, token: String) -> Result<String, String>`
- **D-14:** Existing `fetch_remote_issues` dispatches to all four new providers — no new top-level IPC.
- **D-15:** Existing `delete_ticketing_credentials` unchanged.

### Claude's Discretion
- GraphQL client structure: use `graphql_client` crate's inline approach (no `.graphql` schema file). **NOTE: See Critical Finding #1 below — the `graphql!` macro does not exist; correct approach is manual serde structs or `#[derive(GraphQLQuery)]` with schema file.**
- Pagination: single-page fetch with limit (100 for REST, first:100 for GraphQL).
- Error message format: `"<ProviderName>: <message>"`.
- Jira Cloud `site_url` normalization: use `normalize_instance_url()`.
- Azure DevOps `org_url` normalization: use `normalize_instance_url()`.

### Deferred Ideas (OUT OF SCOPE)
None — discussion stayed within phase scope.
</user_constraints>

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| AUTH-03 | OAuth flow for Linear | Note: requirements doc says OAuth; Phase 53 pivot changed this to PAT/API key. Actual implementation: PAT validation via `{ viewer { id name } }` per D-03. |
| AUTH-04 | OAuth 2.0 3LO flow for Jira Cloud | Note: requirements doc says OAuth; Phase 53 pivot changed this to email+API token. Actual: Basic auth against `/rest/api/3/myself`. |
| PROV-03 | Linear Issues client — GraphQL, team selection, map title/description/labels/url/updated_at | Research establishes GraphQL endpoint, auth header, field names, and two-query approach (viewer + issues with optional team filter). |
| PROV-04 | Jira Cloud client — REST API v3, strip ADF from descriptions | Research establishes JQL search endpoint, field names, and jc-adf API for ADF conversion. |
</phase_requirements>

---

## Summary

Phase 54 adds four Rust provider modules following the Phase 53 pattern: `validate_and_store()` + `fetch_issues()`. The codebase pattern is fully established — the main research value is in API shapes and dependency constraints.

**Critical Finding #1 — graphql_client reqwest feature conflict (HIGH confidence):** The current Cargo.toml has `graphql_client = { version = "0.16", default-features = false, features = ["reqwest"] }`. Cargo.lock confirms this resolves `reqwest 0.12.28` as a dependency. The project also uses `reqwest 0.13.3`. Both compile simultaneously (Rust allows multiple semver-incompatible crates), but the `graphql_client::reqwest::post_graphql()` helper takes a `reqwest 0.12` client. The correct fix is to drop the `reqwest` feature from graphql_client and instead use `features = ["graphql_query_derive"]`. This enables `#[derive(GraphQLQuery)]` (the proc-macro) without pulling in reqwest 0.12. HTTP calls go through the existing reqwest 0.13 client.

**Critical Finding #2 — `graphql!` macro does not exist (HIGH confidence):** The CONTEXT.md mentions "use `graphql_client` crate's `graphql!` macro for inline query definitions (no `.graphql` schema file required)". This macro does not exist in graphql_client 0.16. The `#[derive(GraphQLQuery)]` proc-macro does exist but requires a `.graphql` schema file at compile time. For Phase 54's minimal query surface (2 queries), the simplest correct approach is to skip graphql_client's derive machinery entirely and use plain `serde` structs + `graphql_client::Response<T>` for deserialization. This avoids both the reqwest version conflict and the schema file requirement.

**Critical Finding #3 — jc-adf API (HIGH confidence):** `jc_adf::from_adf::to_markdown(doc: &serde_json::Value) -> String` — the function never errors. The fallback to `None` (D-07) is achieved by wrapping the JSON parse step, not the conversion: if the ADF field is absent or malformed JSON, return `None`; if it parses, call `to_markdown()` which always returns a `String`.

**Primary recommendation:** Use plain serde structs for Linear GraphQL (not `#[derive(GraphQLQuery)]`). Update graphql_client feature to `graphql_query_derive` (not `reqwest`) if the derive macro is needed elsewhere; otherwise remove the dependency from features entirely. Add `jc-adf = "0.2"` to Cargo.toml.

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Linear API auth validation | API / Backend (Rust) | — | Token never touches frontend; Rust-only per Phase 53 decision |
| Linear issue fetch (GraphQL) | API / Backend (Rust) | — | HTTP call in Rust; frontend invokes via IPC |
| Linear team list | API / Backend (Rust) | — | `list_linear_teams` IPC; Phase 55 renders the picker |
| Jira Cloud auth + issue fetch | API / Backend (Rust) | — | Basic auth header assembled in Rust |
| Jira Server auth + issue fetch | API / Backend (Rust) | — | Bearer token in Rust |
| ADF → Markdown conversion | API / Backend (Rust) | — | jc-adf called synchronously inline in jira_cloud.rs |
| Azure DevOps WIQL + batch fetch | API / Backend (Rust) | — | Two-call sequence: WIQL returns IDs, batch fetch returns details |
| LinearTeam type → TypeScript | Build tooling | Frontend | ts-rs generates binding; frontend consumes |

---

## Standard Stack

### Core (existing — no changes except graphql_client feature)
| Library | Version | Purpose | Status |
|---------|---------|---------|--------|
| reqwest | 0.13.3 | HTTP client for all REST calls | Already in Cargo.toml |
| serde / serde_json | 1 | Serialization for all provider responses | Already present |
| base64 | 0.22 | Basic auth encoding for Jira Cloud, Jira Server (Bearer needs none), AzDO | Already present |
| urlencoding | 2.1 | URL-encode project paths in Jira Server | Already present |
| graphql_client | 0.16.0 | `graphql_client::Response<T>` type for GraphQL response deserialization | Already present — feature fix needed |
| specta | 2.0.0-rc.20 | TypeScript type export for `LinearTeam` | Already present |

### New Dependency
| Library | Version | Purpose | Why |
|---------|---------|---------|-----|
| jc-adf | 0.2.0 | ADF → Markdown conversion (Jira Cloud description field) | Locked in D-06; pure Rust, no unsafe |

**Version verification:** `cargo search jc-adf` returns `jc-adf = "0.2.0"` [VERIFIED: cargo search, 2026-05-21]

### graphql_client Feature Fix (REQUIRED)
```toml
# Before (current — pulls reqwest 0.12 conflict):
graphql_client = { version = "0.16", default-features = false, features = ["reqwest"] }

# After (correct — no reqwest dependency, keeps Response<T> type):
graphql_client = { version = "0.16", default-features = false }
```

The `graphql_client::Response<T>`, `graphql_client::QueryBody<V>`, and `graphql_client::Error` types are always available regardless of feature flags — they are in `src/lib.rs` behind no feature gate. [VERIFIED: graphql_client-0.16.0/src/lib.rs in cargo cache]

**Installation (new dependency only):**
```bash
cd src-tauri && cargo add jc-adf@0.2
```

---

## Architecture Patterns

### System Architecture Diagram

```
Frontend IPC call (project_id)
         │
         ▼
ticketing_handlers.rs
  ├── project path lookup (drop Mutex before .await)
  ├── save_*_credentials → module::validate_and_store()
  │     ├── HTTP validation call → extract display_name
  │     ├── TicketingConfig::save_to_project()
  │     └── token_manager.store_token()
  ├── fetch_remote_issues → match ProviderConfig variant
  │     ├── Linear(cfg) → linear::fetch_issues(token, team_id)
  │     │     └── POST https://api.linear.app/graphql  (Bearer token)
  │     ├── Jiracloud(cfg) → jira_cloud::fetch_issues(token, site_url, project_key)
  │     │     └── GET {site_url}/rest/api/3/search (Basic auth)
  │     │         └── jc_adf::from_adf::to_markdown() for each description
  │     ├── Jiraserver(cfg) → jira_server::fetch_issues(token, base_url, project_key)
  │     │     └── GET {base_url}/rest/api/2/search (Bearer token)
  │     └── Azuredevops(cfg) → azure_devops::fetch_issues(token, org_url, project)
  │           ├── POST {org_url}/{project}/_apis/wit/wiql  → Vec<work_item_id>
  │           └── POST {org_url}/{project}/_apis/wit/workitemsbatch → details
  └── list_linear_teams → linear::list_teams(token)
        └── POST https://api.linear.app/graphql (teams query)
```

### Recommended Project Structure (additions only)
```
src-tauri/src/ticketing/
├── mod.rs              ← add: pub mod linear; pub mod jira_cloud; pub mod jira_server; pub mod azure_devops;
├── linear.rs           ← new
├── jira_cloud.rs       ← new
├── jira_server.rs      ← new
└── azure_devops.rs     ← new
```

### Pattern 1: Linear GraphQL (manual serde, no derive macro)
**What:** POST to `https://api.linear.app/graphql` with `Authorization: Bearer <token>`. Use `serde` structs + `graphql_client::Response<T>` for response shape.
**When to use:** Any GraphQL endpoint when schema file is not available / not worth maintaining.

```rust
// Source: graphql_client-0.16.0/src/lib.rs (verified in cargo cache)
use graphql_client::Response;

#[derive(serde::Serialize)]
struct GraphqlRequest {
    query: &'static str,
    variables: serde_json::Value,
}

#[derive(serde::Deserialize)]
struct ViewerData {
    viewer: ViewerInfo,
}

#[derive(serde::Deserialize)]
struct ViewerInfo {
    id: String,
    name: String,
}

const VIEWER_QUERY: &str = "{ viewer { id name } }";

async fn validate(token: &str, client: &reqwest::Client) -> Result<String, String> {
    let body = GraphqlRequest { query: VIEWER_QUERY, variables: serde_json::Value::Null };
    let resp = client
        .post("https://api.linear.app/graphql")
        .header("Authorization", format!("Bearer {}", token))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Linear: Network error: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Linear: HTTP {}", resp.status().as_u16()));
    }
    let gql: Response<ViewerData> = resp.json().await.map_err(|e| format!("Linear: {}", e))?;
    if let Some(errors) = gql.errors {
        if !errors.is_empty() {
            return Err(format!("Linear: {}", errors[0].message));
        }
    }
    Ok(gql.data.ok_or("Linear: empty response")?.viewer.name)
}
```

### Pattern 2: Jira Cloud ADF → Markdown conversion
**What:** Jira Cloud issues return `description` as an ADF JSON object. Use jc-adf to convert; fall back to `None` if the field is absent.

```rust
// Source: docs.rs/jc-adf/0.2.0 — to_markdown takes &serde_json::Value, returns String (infallible)
fn extract_body(description: Option<serde_json::Value>) -> Option<String> {
    description.map(|adf| jc_adf::from_adf::to_markdown(&adf))
}
```

### Pattern 3: Azure DevOps two-step fetch
**What:** WIQL returns only IDs; batch endpoint fetches full work item details. IDs are chunked to respect the 200-item batch limit.

```rust
// Source: Microsoft Learn AzDO REST 7.1 docs (verified)
// Step 1: WIQL
POST {org_url}/{project}/_apis/wit/wiql?api-version=7.1
Body: { "query": "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = '{project}' AND [System.State] <> 'Closed'" }
Response: { "workItems": [{ "id": 42, "url": "..." }, ...] }

// Step 2: batch fetch (max 200 IDs per call)
POST {org_url}/{project}/_apis/wit/workitemsbatch?api-version=7.1
Body: {
  "ids": [42, 43, ...],
  "fields": ["System.Id", "System.Title", "System.Description",
             "System.WorkItemType", "System.State", "System.ChangedDate",
             "System.Tags", "System.AreaPath"]
}
Response: { "value": [{ "id": 42, "fields": {...}, "url": "..." }] }
```

### Pattern 4: Basic Auth construction (Jira Cloud + AzDO)
```rust
// Jira Cloud: base64(email:api_token)
// Source: Atlassian Basic Auth docs (verified)
let credentials = format!("{}:{}", email, api_token);
let encoded = base64::engine::general_purpose::STANDARD.encode(&credentials);
let auth_header = format!("Basic {}", encoded);

// Azure DevOps: base64("":pat)  — empty username per MS docs (verified)
let credentials = format!(":{}", token);
let encoded = base64::engine::general_purpose::STANDARD.encode(&credentials);
let auth_header = format!("Basic {}", encoded);
```

### Pattern 5: LinearTeam type for TypeScript export
```rust
// Must derive specta::Type and be tagged #[specta(export)] for pnpm tauri:gen
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, specta::Type)]
#[specta(export)]
pub struct LinearTeam {
    pub id: String,
    pub name: String,
    pub key: String,
}
```

### Anti-Patterns to Avoid
- **Using `graphql_client` reqwest feature:** Pulls reqwest 0.12 alongside 0.13 — the `post_graphql()` helper takes a reqwest 0.12 client and cannot be used with the existing reqwest 0.13 client. Drop this feature.
- **Using `graphql!` macro:** This macro does not exist in graphql_client 0.16. The CONTEXT.md note was incorrect. Use plain serde.
- **Providing ADF as raw `Option<String>`:** Jira Cloud description is a JSON object, not a string. Deserialize as `Option<serde_json::Value>`, pass to `jc_adf::from_adf::to_markdown()`.
- **Single batch call for AzDO > 200 items:** The batch endpoint maximum is 200 IDs. Chunk the ID list from WIQL.
- **Calling `normalize_instance_url()` twice:** The function is `pub(crate)` in `ticketing/mod.rs` — use it exactly once at module entry, store the normalized base URL in a local binding, reuse for subsequent calls.
- **Not dropping Mutex before `.await`:** IPC handlers must release the DB lock before any async network call. Use a scoped block: `let path = { let conn = app_state.db.lock()...; conn.query_row(...)? };`.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| ADF to Markdown | Custom ADF parser | `jc-adf 0.2` | ADF has 20+ node types; custom implementation misses blockquote, table, mention, media nodes |
| URL normalization | Custom scheme/slash handling | `normalize_instance_url()` from `ticketing/mod.rs` | Already battle-tested in Phase 53 |
| Token storage/retrieval | Custom file/keychain logic | `token_manager.store_token` / `get_token` | Handles keychain + file fallback + cache layer |
| GraphQL HTTP transport | Custom wrapper | `reqwest 0.13` + plain serde structs | Adding `graphql_client` reqwest feature pulls reqwest 0.12 conflict |
| Base64 encoding | Manual byte ops | `base64::engine::general_purpose::STANDARD.encode()` | Already in Cargo.toml |

---

## Common Pitfalls

### Pitfall 1: graphql_client reqwest feature version conflict
**What goes wrong:** Build compiles with two reqwest versions. `post_graphql()` helper expects a reqwest 0.12 `Client` — passing the reqwest 0.13 client causes a type mismatch compile error.
**Why it happens:** `graphql_client 0.16` pins `reqwest = ">=0.11, <=0.12"`. Cargo resolves both, but types are incompatible.
**How to avoid:** Set `graphql_client = { version = "0.16", default-features = false }` (no `reqwest` feature). Use only `graphql_client::Response<T>` for response shape, and call the Linear API manually via reqwest 0.13.
**Warning signs:** `Cargo.lock` shows both `reqwest 0.12.x` and `reqwest 0.13.x` simultaneously.
[VERIFIED: Cargo.lock inspection shows reqwest 0.12.28 and 0.13.3 both present]

### Pitfall 2: jc-adf to_markdown() called on wrong type
**What goes wrong:** Deserializing Jira Cloud `description` as `Option<String>` causes a JSON parse error — the field is a JSON object, not a string.
**Why it happens:** Jira Cloud v3 returns ADF (Atlassian Document Format) as a structured JSON object: `{"type":"doc","version":1,"content":[...]}`.
**How to avoid:** Declare the description field as `Option<serde_json::Value>` in the response struct. Call `to_markdown()` only after successful JSON deserialization.
**Warning signs:** `serde_json` deserialization error mentioning "expected string, found object" for the description field.
[VERIFIED: docs.rs/jc-adf/0.2.0, Atlassian REST v3 docs]

### Pitfall 3: Linear `description` field is Markdown, not ADF
**What goes wrong:** Applying jc-adf to Linear descriptions corrupts the text.
**Why it happens:** Linear stores descriptions as Markdown natively — not ADF. ADF conversion is only needed for Jira Cloud v3. Jira Server v2 also returns description as plain string (not ADF).
**How to avoid:** Only call `jc_adf::from_adf::to_markdown()` in `jira_cloud.rs`. Linear and Jira Server use `description: Option<String>` directly.
[ASSUMED — Linear returning Markdown is widely documented but not verified via live API call in this session]

### Pitfall 4: Azure DevOps org_url format variations
**What goes wrong:** Users may provide `https://dev.azure.com/myorg`, `https://myorg.visualstudio.com`, or `https://myorg.visualstudio.com/` — inconsistent trailing slashes and subdomain formats.
**How to avoid:** Apply `normalize_instance_url()` to strip trailing slashes. Construct API URLs by appending `/{project}/_apis/wit/wiql?api-version=7.1` to the normalized org_url. Both `dev.azure.com/{org}` and `{org}.visualstudio.com` formats are valid Azure DevOps endpoints.
[CITED: learn.microsoft.com/rest/api/azure/devops basics page]

### Pitfall 5: Azure DevOps `System.Description` is HTML, not Markdown
**What goes wrong:** `System.Description` in AzDO work items returns HTML markup (e.g., `<p>Fix this</p>`). Storing it as-is creates noisy task bodies.
**Why it happens:** AzDO stores work item descriptions as HTML in its internal representation.
**How to avoid:** Either strip HTML tags (basic regex is sufficient for v1.6 — store as plain text losing formatting) or accept the HTML as-is. The `RemoteIssue.body` field is `Option<String>` — for v1.6, plain text extraction is acceptable. Phase 55/56 can improve this.
**Recommendation (Claude's discretion):** Use a simple HTML-strip approach or store as-is for v1.6; do not add a full HTML parser dependency.
[ASSUMED — AzDO HTML description behavior is well-documented but not tested in this session]

### Pitfall 6: WIQL returns IDs but `url` field points to API, not UI
**What goes wrong:** The `url` field in WIQL response is an API URL (`https://dev.azure.com/org/_apis/wit/workItems/42`), not a browser URL. The `RemoteIssue.url` should be the human-navigable URL.
**How to avoid:** Construct the browser URL from `org_url` + `project` + work item ID: `{org_url}/{project}/_workitems/edit/{id}`.
[CITED: Azure DevOps REST docs — workItems response shape]

### Pitfall 7: Jira Cloud `myself` validation returns `displayName`, not `accountId`
**What goes wrong:** The `validate_and_store` functions return a display name string (username). The `GET /rest/api/3/myself` endpoint returns `displayName` (not `email` or `login`).
**How to avoid:** Deserialize `displayName` from the `myself` response — use this as the returned display name.
[ASSUMED — Jira Cloud myself endpoint fields based on API pattern; not tested live]

### Pitfall 8: Linear issues query without pagination may silently cap at default limit
**What goes wrong:** Linear GraphQL applies a default page size (likely 50) if `first:` is not specified.
**How to avoid:** Always specify `first: 250` (or the provider's max) in the issues query to request the largest single page. For v1.6, single-page fetch is acceptable per the discretion decision.
[ASSUMED — Linear default pagination behavior; not verified empirically]

---

## Code Examples

### Linear — viewer validation query
```rust
// Source: api.linear.app/graphql confirmed as live endpoint (verified: HTTP 401 with auth error)
// Field names: confirmed from linear/linear GitHub SDK source (_generated_documents.ts)
const VIEWER_QUERY: &str = "{ viewer { id name } }";

#[derive(serde::Serialize)]
struct GraphqlRequest<'a> {
    query: &'a str,
    #[serde(skip_serializing_if = "serde_json::Value::is_null")]
    variables: serde_json::Value,
}

#[derive(serde::Deserialize)]
struct ViewerResponseData {
    viewer: ViewerUser,
}

#[derive(serde::Deserialize)]
struct ViewerUser {
    id: String,
    name: String,
}
```

### Linear — issues query (with optional team filter)
```rust
// Fields: identifier (e.g. "ENG-42"), title, description (Markdown), url, updatedAt, labels{nodes{name}}, team{id}
// Source: linear/linear GitHub SDK (confirmed field names)
const ISSUES_QUERY: &str = r#"
query IssuesFetch($teamId: ID, $first: Int) {
  issues(filter: {
    team: { id: { eq: $teamId } }
  }, first: $first) {
    nodes {
      identifier
      title
      description
      url
      updatedAt
      labels { nodes { name } }
    }
  }
}"#;
```
Note: When `team_id = None`, omit the filter argument entirely (send a different query string without the filter). GraphQL does not accept `null` as a skip signal for filter conditions.

### Linear — teams query
```rust
// Source: linear/linear GitHub SDK (confirmed team fields: id, name, key)
const TEAMS_QUERY: &str = "{ teams { nodes { id name key } } }";

#[derive(serde::Deserialize)]
struct TeamsResponseData {
    teams: TeamsConnection,
}

#[derive(serde::Deserialize)]
struct TeamsConnection {
    nodes: Vec<LinearTeam>,
}
```

### Jira Cloud — JQL search
```rust
// Endpoint: GET {site_url}/rest/api/3/search
// Auth: Basic base64(email:api_token)
// Fields requested via `fields` param or default
// Source: Atlassian developer docs (MEDIUM confidence — page truncated but endpoint confirmed)
let url = format!("{}/rest/api/3/search", normalized_site_url);
let params = [
    ("jql", format!("project = {} AND statusCategory != Done ORDER BY updated DESC", project_key)),
    ("maxResults", "100".to_string()),
    ("fields", "summary,description,labels,status,issuetype,updated,self".to_string()),
];
```

### Jira Server — JQL search
```rust
// Endpoint: GET {base_url}/rest/api/2/search
// Auth: Bearer {token}
// Description is plain text string in v2 (not ADF)
// Source: Atlassian server REST API docs (MEDIUM confidence)
let url = format!("{}/rest/api/2/search", normalized_base_url);
```

### Azure DevOps — WIQL + batch
```rust
// Step 1: WIQL
// Endpoint: POST {org_url}/{project}/_apis/wit/wiql?api-version=7.1
// Auth: Basic base64(:pat)  — empty username
// Source: learn.microsoft.com REST 7.1 WIQL docs (CITED, HIGH confidence)

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

// Step 2: Batch fetch
// Endpoint: POST {org_url}/{project}/_apis/wit/workitemsbatch?api-version=7.1
// Body: { "ids": [...], "fields": ["System.Id", "System.Title", "System.Description",
//          "System.WorkItemType", "System.State", "System.ChangedDate", "System.Tags"] }
// Source: learn.microsoft.com REST 7.1 workitemsbatch docs (CITED, HIGH confidence)

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
    url: String,
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

### jc-adf usage
```rust
// Source: docs.rs/jc-adf/0.2.0/jc_adf/from_adf/fn.to_markdown.html (CITED, HIGH confidence)
// Signature: pub fn to_markdown(doc: &serde_json::Value) -> String
// Never errors — always returns a String

fn convert_adf_body(adf: Option<serde_json::Value>) -> Option<String> {
    adf.map(|v| jc_adf::from_adf::to_markdown(&v))
}
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| graphql_client reqwest feature | Drop reqwest feature; manual serde | Phase 54 (this phase) | Removes reqwest 0.12 from build |
| OAuth for Linear/Jira (spec) | PAT/API key auth | Phase 53 pivot | AUTH-03, AUTH-04 requirements text is stale — actual implementation is PAT |

**Deprecated/outdated:**
- `graphql_client::reqwest::post_graphql()` helper: incompatible with reqwest 0.13; do not use.
- REQUIREMENTS.md AUTH-03/AUTH-04 OAuth references: stale per Phase 53 pivot decision; implementation uses PAT.

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Linear `description` field returns Markdown (not ADF) | Pitfall 3, Code Examples | If Linear uses a custom format, body text could be garbled — but Phase 55/56 rendering would still work (markdown is safe to display) |
| A2 | Jira Cloud `/rest/api/3/myself` returns `displayName` field | Pitfall 7 | Display name returned from `validate_and_store` would be wrong field — need to use correct field name |
| A3 | `System.Description` in AzDO work items is HTML | Pitfall 5 | If it returns Markdown or plain text, no stripping needed — safe to not strip for v1.6 |
| A4 | Linear issues `first: 250` is within complexity budget | Pitfall 8 | If Linear rejects the query for complexity, must reduce fields or first count — need empirical test |
| A5 | Jira Server v2 description is plain text string (not ADF) | Code Examples | If Jira Server v8+ also returns ADF, body text would be raw JSON — need jc-adf in jira_server.rs too |
| A6 | AzDO `System.Tags` is semicolon-separated string | Code Examples | If delimiter differs, label splitting logic would need adjustment |

---

## Open Questions (RESOLVED)

1. **Linear complexity budget for issues query with 250 items**
   - What we know: Linear applies a complexity cost per query; budget is not published. The viewer and teams queries are tiny. The issues query with labels is moderate complexity.
   - What's unclear: Whether `first: 250` with labels causes a complexity budget error.
   - RESOLVED: Use `first: 100` (same as Phase 53 REST providers). Plans use `first: 100` in ISSUES_QUERY_ALL. If Linear returns a complexity error, it surfaces as user-facing message — no special v1.6 handling needed.

2. **Jira Cloud `myself` response field for display name**
   - What we know: The `/rest/api/3/myself` endpoint returns account info.
   - What's unclear: Exact field name — `displayName`, `emailAddress`, or `name`.
   - RESOLVED: Deserialize with both `displayName: Option<String>` and `emailAddress: Option<String>`, prefer `displayName`, fall back to `emailAddress`. Plan 02 implements this fallback explicitly.

3. **jc-adf version compatibility with Jira Cloud ADF spec**
   - What we know: `jc-adf 0.2.0` handles common ADF nodes with a lossless escape hatch for unknown types.
   - What's unclear: Whether specific Jira-generated ADF node types (media, mentions, inline-cards) produce readable fallback output.
   - RESOLVED: D-07 fallback applies — if conversion produces unreadable text for exotic nodes, the lossless escape hatch preserves them as fenced code blocks. Plan 02 uses `Option::map` so missing ADF → None body. Acceptable for v1.6.

---

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| cargo / rustc | Rust compilation | ✓ | (workspace) | — |
| jc-adf crate | Jira Cloud ADF conversion | ✓ (on crates.io) | 0.2.0 | — (must add to Cargo.toml) |
| graphql_client | Linear GraphQL response types | ✓ (in Cargo.lock) | 0.16.0 | — |
| Linear API endpoint | `save_linear_credentials` test | ✓ (HTTP 401 confirmed) | — | — |
| Azure DevOps API | `save_azure_devops_credentials` | ✓ (dev.azure.com reachable) | 7.1 | — |

[VERIFIED: Linear API — HTTP 401 with auth error confirmed, endpoint is live]
[VERIFIED: Azure DevOps — redirect to auth page confirmed, endpoint is live]

---

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Rust built-in (`#[cfg(test)]`) |
| Config file | none |
| Quick run command | `cargo test -p maestro 2>&1` |
| Full suite command | `cargo test -p maestro 2>&1` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| AUTH-03 | Linear PAT validates via viewer query, returns display name | unit | `cargo test -p maestro linear -- --nocapture` | ❌ Wave 0 |
| AUTH-04 | Jira Cloud email+token validates via myself endpoint | unit | `cargo test -p maestro jira_cloud -- --nocapture` | ❌ Wave 0 |
| PROV-03 | Linear issues response deserialization, external_id format | unit | `cargo test -p maestro linear -- --nocapture` | ❌ Wave 0 |
| PROV-04 | Jira Cloud issues response deserialization, ADF conversion | unit | `cargo test -p maestro jira_cloud -- --nocapture` | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** `cargo check -p maestro`
- **Per wave merge:** `cargo test -p maestro`
- **Phase gate:** All unit tests green before `/gsd-verify-work`

### Wave 0 Gaps
- [ ] `src-tauri/src/ticketing/linear.rs` — covers AUTH-03, PROV-03
- [ ] `src-tauri/src/ticketing/jira_cloud.rs` — covers AUTH-04, PROV-04
- [ ] `src-tauri/src/ticketing/jira_server.rs` — covers Jira Server PAT auth
- [ ] `src-tauri/src/ticketing/azure_devops.rs` — covers AzDO D-01/D-02

Each file gets an inline `#[cfg(test)]` block with tests for:
1. Response struct deserialization from fixture JSON
2. `external_id` format correctness
3. URL normalization (where applicable)
4. ADF body extraction (jira_cloud only)
5. WIQL ID extraction + batch URL construction (azure_devops only)

---

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes | PAT stored in OS keychain via `TokenManager` — already implemented |
| V3 Session Management | no | No sessions — stateless token-per-request |
| V4 Access Control | no | Project-scoped tokens; access control at IPC layer |
| V5 Input Validation | yes | `normalize_instance_url()` sanitizes URLs; reqwest enforces HTTPS for cloud providers |
| V6 Cryptography | no | No new cryptography; token storage uses existing keychain/file path |

### Known Threat Patterns for This Stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Credential logging | Information Disclosure | Per CLAUDE.md — no `tracing::` / `log::` calls; tokens never in error strings (use `"bad credentials"` not the token value) |
| SSRF via user-supplied base URL (Jira Server, AzDO org_url) | Tampering | `normalize_instance_url()` enforces https scheme; reqwest follows redirects safely; no internal network targets in scope |
| Token exposure in error messages | Information Disclosure | Errors use `"<Provider>: bad credentials"` pattern from Phase 53 — never echo token value |

---

## Sources

### Primary (HIGH confidence)
- `graphql_client-0.16.0/Cargo.toml.orig` — reqwest version constraint `>=0.11, <=0.12` [VERIFIED: cargo cache]
- `graphql_client-0.16.0/src/lib.rs` — `Response<T>`, `QueryBody<V>`, `Error` types available with no feature gate [VERIFIED: cargo cache]
- `/home/m306213/workspace/maestro/Cargo.lock` — both reqwest 0.12.28 and 0.13.3 present [VERIFIED: file read]
- `docs.rs/jc-adf/0.2.0/jc_adf/from_adf/fn.to_markdown.html` — `pub fn to_markdown(doc: &Value) -> String` [CITED]
- `learn.microsoft.com/rest/api/azure/devops/wit/wiql/query-by-wiql` — WIQL POST endpoint, response shape [CITED]
- `learn.microsoft.com/rest/api/azure/devops/wit/work-items/get-work-items-batch` — batch fetch endpoint, max 200 IDs, `fields` array [CITED]
- `learn.microsoft.com/azure/devops/organizations/accounts/use-personal-access-tokens` — AzDO PAT Basic auth: `base64(:pat)` [CITED]
- `confluence.atlassian.com/enterprise/using-personal-access-tokens` — Jira Server Bearer token auth: `Authorization: Bearer <token>` [CITED]
- `developer.atlassian.com/cloud/jira/platform/basic-auth-for-rest-apis` — Jira Cloud Basic auth: `base64(email:api_token)` [CITED]
- Linear API endpoint `api.linear.app/graphql` [VERIFIED: live HTTP probe returned 401 with auth error message]

### Secondary (MEDIUM confidence)
- `raw.githubusercontent.com/linear/linear` SDK generated documents — issue field names (identifier, title, description, url, updatedAt, labels, team) [CITED: indirect via WebFetch]
- Atlassian developer REST v3 search endpoint `/rest/api/3/search` with `jql`, `fields`, `maxResults` parameters [CITED: developer.atlassian.com, partial — page truncated]
- Atlassian server REST API examples `/rest/api/2/search` [CITED: developer.atlassian.com examples page]

### Tertiary (LOW confidence)
- Linear `description` field returns Markdown — standard claim, not verified via live query in this session [ASSUMED: A1]
- AzDO `System.Description` returns HTML — industry common knowledge, not verified [ASSUMED: A3]
- Jira Server v2 description is plain text — version-based assumption [ASSUMED: A5]

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — verified from Cargo.toml/Cargo.lock and official docs
- Architecture: HIGH — Phase 53 reference pattern fully verified from codebase
- Pitfalls: HIGH (dependency) / MEDIUM (API shapes) — reqwest conflict verified; API response shapes from official docs
- jc-adf API: HIGH — verified from docs.rs
- Azure DevOps API: HIGH — verified from Microsoft Learn official docs
- Linear API fields: MEDIUM — SDK source indirect verification
- Jira API fields: MEDIUM — official docs pages, partially truncated

**Research date:** 2026-05-21
**Valid until:** 2026-06-21 (stable APIs; jc-adf is small crate unlikely to change)
