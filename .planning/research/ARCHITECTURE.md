# Architecture Research: v1.6 Ticketing Integration

**Domain:** OAuth ticketing integration into existing Tauri 2 desktop app
**Researched:** 2026-05-20
**Confidence:** HIGH — based on direct codebase inspection + Context7 docs for tauri-plugin-oauth + keyring-rs

---

## Standard Architecture

### System Overview

```
┌──────────────────────────────────────────────────────────────────┐
│                     Frontend (React + TypeScript)                 │
├──────────────────────────────────────────────────────────────────┤
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────────────┐  │
│  │ BacklogView  │  │ SettingsPage │  │ ticketing.service.ts   │  │
│  │ (import btn) │  │ (OAuth UI)   │  │ (TanStack Query hooks) │  │
│  └──────┬───────┘  └──────┬───────┘  └──────────┬─────────────┘  │
│         │                 │                      │               │
│  ┌──────▼─────────────────▼──────────────────────▼─────────────┐  │
│  │              ImportIssuesModal (new Dialog)                  │  │
│  └──────────────────────────────┬───────────────────────────────┘  │
├─────────────────────────────────│────────────────────────────────┤
│                         IPC Layer (invoke)                        │
├─────────────────────────────────│────────────────────────────────┤
│                     Backend (Rust / Tauri 2)                      │
│  ┌──────────────────────────────▼───────────────────────────────┐  │
│  │           ipc/ticketing_handlers.rs (new file)               │  │
│  │  start_oauth_flow | exchange_oauth_code | get_ticketing_config│  │
│  │  save_ticketing_config | list_provider_issues | import_issues │  │
│  └──────────┬──────────────────────────┬────────────────────────┘  │
│             │                          │                          │
│  ┌──────────▼──────────┐  ┌────────────▼──────────────────────┐  │
│  │  ticketing/ (new)   │  │  models/ticketing.rs (new)        │  │
│  │  mod.rs             │  │  TicketingConfig, ProviderConfig,  │  │
│  │  providers/         │  │  RemoteIssue, ImportedTask         │  │
│  │    github.rs        │  └───────────────────────────────────┘  │
│  │    gitlab.rs        │                                         │
│  │    linear.rs        │                                         │
│  │    jira.rs          │                                         │
│  │  oauth.rs           │                                         │
│  │  keychain.rs        │                                         │
│  └──────────┬──────────┘                                         │
│             │                                                     │
│  ┌──────────▼──────────────────────────────────────────────────┐  │
│  │  Storage Layer                                               │  │
│  │  .maestro/ticketing.json  (TicketingConfig — no secrets)    │  │
│  │  OS keychain via keyring  (OAuth tokens — secrets)          │  │
│  │  SQLite tasks table       (imported tasks + new columns)    │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                                                                   │
│  tauri-plugin-oauth (localhost redirect server — ephemeral)       │
└──────────────────────────────────────────────────────────────────┘
```

### Component Responsibilities

| Component | Responsibility | File |
|-----------|----------------|------|
| `ticketing_handlers.rs` | IPC command entry points — thin, delegate to `ticketing/` module | NEW `src-tauri/src/ipc/ticketing_handlers.rs` |
| `ticketing/mod.rs` | Re-exports, `ProviderClient` trait | NEW `src-tauri/src/ticketing/mod.rs` |
| `ticketing/oauth.rs` | OAuth state machine: generate PKCE, start server, exchange code | NEW `src-tauri/src/ticketing/oauth.rs` |
| `ticketing/keychain.rs` | Read/write/delete tokens from OS keychain via `keyring` | NEW `src-tauri/src/ticketing/keychain.rs` |
| `ticketing/providers/github.rs` | GitHub-specific auth URLs, API calls, issue-to-task mapping | NEW |
| `ticketing/providers/gitlab.rs` | GitLab (cloud + self-hosted), API calls, issue-to-task mapping | NEW |
| `ticketing/providers/linear.rs` | Linear API (GraphQL), issue-to-task mapping | NEW |
| `ticketing/providers/jira.rs` | Jira Cloud (OAuth 2.0 + API), issue-to-task mapping | NEW |
| `models/ticketing.rs` | `TicketingConfig`, `RemoteIssue`, `ImportResult` types with ts-rs | NEW `src-tauri/src/models/ticketing.rs` |
| `.maestro/ticketing.json` | Non-sensitive provider config: provider name, repo/project slug, base URL for self-hosted GitLab | NEW per-project file |
| `ticketing.service.ts` | TanStack Query hooks wrapping IPC commands | NEW `src/services/ticketing.service.ts` |
| `ImportIssuesModal.tsx` | Issue browser modal: Available/Imported/Changed states, checkbox multi-select | NEW `src/components/kanban/ImportIssuesModal.tsx` |
| `OAuthConnectSection.tsx` | Connect/disconnect button in SettingsPage | NEW `src/components/common/OAuthConnectSection.tsx` |

---

## Recommended Project Structure

### Rust Backend

```
src-tauri/src/
├── ticketing/                    # NEW module
│   ├── mod.rs                    # ProviderClient trait, re-exports
│   ├── oauth.rs                  # OAuth PKCE state machine
│   ├── keychain.rs               # keyring wrappers (get/set/delete token)
│   └── providers/
│       ├── mod.rs                # enum ProviderKind + dispatch
│       ├── github.rs             # GitHub Issues REST v3
│       ├── gitlab.rs             # GitLab Issues REST v4 (cloud + self-hosted)
│       ├── linear.rs             # Linear GraphQL API
│       └── jira.rs               # Jira Cloud OAuth 2.0 + REST
├── ipc/
│   ├── ticketing_handlers.rs     # NEW IPC commands
│   └── mod.rs                    # MODIFIED: add ticketing_handlers pub use
├── models/
│   ├── ticketing.rs              # NEW data types with ts-rs derive
│   └── mod.rs                    # MODIFIED: add ticketing module
└── lib.rs                        # MODIFIED: register new IPC commands
```

### Frontend

```
src/
├── services/
│   └── ticketing.service.ts      # NEW TanStack Query hooks
├── components/
│   ├── kanban/
│   │   └── ImportIssuesModal.tsx # NEW issue browser modal
│   └── common/
│       └── OAuthConnectSection.tsx # NEW OAuth connect UI for SettingsPage
└── views/
    └── KanbanView.tsx            # No change — BacklogView owns the button
```

---

## Architectural Patterns

### Pattern 1: TicketingConfig in .maestro/ticketing.json (follows ProjectConfig pattern)

**What:** A serde struct with `#[serde(default)]` that mirrors `ProjectConfig`'s load/save pattern. Stores non-sensitive config only: which provider is active, owner/repo slug, base URL for self-hosted GitLab, and any non-secret provider settings. OAuth tokens go to OS keychain only.

**When to use:** Any per-project config that is safe to commit to git (no secrets).

**Trade-offs:** File must be gracefully absent (new project has no `ticketing.json`). The same fallback pattern used by `load_project_config` applies: detect "No such file" error and return `Default::default()`.

**Example:**
```rust
// src-tauri/src/models/ticketing.rs
#[derive(Debug, Clone, Serialize, Deserialize, Type, Default)]
#[serde(default)]
#[specta(export)]
pub struct TicketingConfig {
    pub provider: Option<ProviderKind>,
    pub owner: Option<String>,       // GitHub owner / GitLab group / Jira cloud name
    pub repo: Option<String>,        // repo slug / project key / team id
    pub base_url: Option<String>,    // self-hosted GitLab only
    pub updated_at: String,
}

impl TicketingConfig {
    pub fn load_from_project(project_path: &str) -> Result<Self, String> {
        let path = Path::new(project_path).join(".maestro").join("ticketing.json");
        let content = fs::read_to_string(&path).map_err(|e| format!("...: {}", e))?;
        serde_json::from_str(&content).map_err(|e| format!("Invalid JSON in ticketing.json: {}", e))
    }

    pub fn save_to_project(&self, project_path: &str) -> Result<(), String> {
        let dir = Path::new(project_path).join(".maestro");
        fs::create_dir_all(&dir).map_err(|e| format!("...: {}", e))?;
        let json = serde_json::to_string_pretty(self).map_err(|e| format!("...: {}", e))?;
        fs::write(dir.join("ticketing.json"), json).map_err(|e| format!("...: {}", e))
    }
}
```

The `db/project_storage.rs` module gets two wrappers following its existing pattern:
```rust
pub fn load_ticketing_config(project_path: &str) -> Result<TicketingConfig, String> {
    match TicketingConfig::load_from_project(project_path) {
        Ok(config) => Ok(config),
        Err(e) if e.contains("No such file") || e.contains("not found") => {
            Ok(TicketingConfig::default())
        }
        Err(e) => Err(e),
    }
}

pub fn save_ticketing_config(config: &TicketingConfig, project_path: &str) -> Result<(), String> {
    config.save_to_project(project_path)
}
```

### Pattern 2: OAuth State Machine in ticketing/oauth.rs

**What:** The OAuth flow is a three-step async state machine. The state machine lives entirely in Rust — the frontend only initiates and receives the result via a Tauri event. This keeps PKCE code verifier, state nonce, and port allocation in Rust, which cannot be inspected from WebView.

**When to use:** Any browser-based OAuth flow in a Tauri app.

**Trade-offs:** The closure-captures approach means the PKCE state lives as long as the OAuth server is alive (until redirect fires or user cancels). If the user starts two OAuth flows in quick succession, the second server's closure overwrites the first in memory — this is fine because each closure captures its own verifier independently.

**Flow:**
```
Frontend: invoke("start_oauth_flow", { project_id })
    Rust: load project_path from DB
    Rust: load TicketingConfig from .maestro/ticketing.json (get provider)
    Rust: generate PKCE code_verifier + code_challenge + state_nonce
    Rust: start_with_config(callback_closure) via tauri-plugin-oauth
    Rust: open auth URL in browser via tauri_plugin_opener::open_url
    Rust: return OAuthFlowStarted { port } to frontend (frontend just shows spinner)

[Browser OAuth dance happens out-of-band]

tauri-plugin-oauth callback fires with redirect URL containing code + state
    Rust: validate state_nonce matches captured value
    Rust: POST to provider token endpoint via reqwest (exchange code for tokens)
    Rust: keychain::store_token(provider_str, project_id, access_token)
    Rust: window.emit("ticketing:connected", ())
    Rust: cancel(port)

Frontend: listen("ticketing:connected")
    Invalidate ticketing connection + config queries
    OAuthConnectSection shows "Connected" state
```

**Example (condensed):**
```rust
// src-tauri/src/ticketing/oauth.rs
use tauri_plugin_oauth::{start_with_config, cancel, OauthConfig};

pub async fn start_oauth_flow(
    window: tauri::Window,
    project_id: i32,
    provider: ProviderKind,
    config: TicketingConfig,
) -> Result<OAuthFlowStarted, String> {
    let code_verifier = generate_pkce_verifier();
    let code_challenge = derive_pkce_challenge(&code_verifier);
    let state_nonce = generate_nonce();

    let oauth_config = OauthConfig {
        ports: None, // random available port
        response: Some(SUCCESS_HTML.into()),
    };

    let window_clone = window.clone();
    let provider_clone = provider.clone();

    let port = start_with_config(oauth_config, move |url| {
        let parsed = match url::Url::parse(&url) {
            Ok(u) => u,
            Err(_) => {
                let _ = window_clone.emit("ticketing:error", "Invalid redirect URL");
                return;
            }
        };
        let received_state = parsed.query_pairs()
            .find(|(k, _)| k == "state")
            .map(|(_, v)| v.into_owned());
        if received_state.as_deref() != Some(&state_nonce) {
            let _ = window_clone.emit("ticketing:error", "OAuth state mismatch (CSRF)");
            return;
        }
        let code = parsed.query_pairs()
            .find(|(k, _)| k == "code")
            .map(|(_, v)| v.into_owned());
        if let Some(auth_code) = code {
            let window_inner = window_clone.clone();
            let verifier = code_verifier.clone();
            tauri::async_runtime::spawn(async move {
                match provider_clone.exchange_code(&auth_code, &verifier, port).await {
                    Ok(tokens) => {
                        match keychain::store_token(provider_clone.name(), project_id, &tokens.access_token) {
                            Ok(()) => { let _ = window_inner.emit("ticketing:connected", ()); }
                            Err(e) => { let _ = window_inner.emit("ticketing:error", e); }
                        }
                    }
                    Err(e) => { let _ = window_inner.emit("ticketing:error", e); }
                }
                let _ = cancel(port);
            });
        }
    })
    .map_err(|e| format!("Failed to start OAuth server: {}", e))?;

    let auth_url = provider.build_auth_url(port, &code_challenge, &state_nonce)?;
    tauri_plugin_opener::open_url(&auth_url, None::<&str>)
        .map_err(|e| format!("Failed to open browser: {}", e))?;
    Ok(OAuthFlowStarted { port })
}
```

### Pattern 3: keychain.rs — Keyring Wrappers

**What:** Thin wrappers over the `keyring` crate (already in Cargo.toml at v3.6.3). Tokens are keyed by `(service="maestro-ticketing", user="{provider}-{project_id}")`. This naming allows one Maestro install to have different tokens per project and per provider simultaneously.

**Trade-offs:** On Linux, `keyring` v3 uses `libsecret` (GNOME Keyring) or `kwallet` (KDE). Headless Linux (no keyring daemon) will fail with a clear error message. This is acceptable for a desktop app.

```rust
// src-tauri/src/ticketing/keychain.rs
use keyring::Entry;

const KEYRING_SERVICE: &str = "maestro-ticketing";

fn entry_name(provider: &str, project_id: i32) -> String {
    format!("{}-{}", provider, project_id)
}

pub fn store_token(provider: &str, project_id: i32, token: &str) -> Result<(), String> {
    let entry = Entry::new(KEYRING_SERVICE, &entry_name(provider, project_id))
        .map_err(|e| format!("Keychain entry creation failed: {}", e))?;
    entry.set_password(token)
        .map_err(|e| format!("Keychain write failed: {}", e))
}

pub fn load_token(provider: &str, project_id: i32) -> Result<Option<String>, String> {
    let entry = Entry::new(KEYRING_SERVICE, &entry_name(provider, project_id))
        .map_err(|e| format!("Keychain entry creation failed: {}", e))?;
    match entry.get_password() {
        Ok(token) => Ok(Some(token)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("Keychain read failed: {}", e)),
    }
}

pub fn delete_token(provider: &str, project_id: i32) -> Result<(), String> {
    let entry = Entry::new(KEYRING_SERVICE, &entry_name(provider, project_id))
        .map_err(|e| format!("Keychain entry creation failed: {}", e))?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()), // already absent — not an error
        Err(e) => Err(format!("Keychain delete failed: {}", e)),
    }
}
```

### Pattern 4: ProviderClient Trait

**What:** A single async trait that all four providers implement. IPC handlers dispatch through provider enum variants and call the trait methods. This keeps IPC handler code uniform regardless of provider-specific auth and API shapes.

**Trade-offs:** Rust async traits currently require either `async_trait` crate (adds boxing) or the nightly `async fn in trait` feature. Use `async_trait` for stable Rust.

```rust
// src-tauri/src/ticketing/mod.rs
use async_trait::async_trait;

#[async_trait]
pub trait ProviderClient {
    fn name(&self) -> &'static str;
    fn build_auth_url(&self, port: u16, code_challenge: &str, state: &str) -> Result<String, String>;
    async fn exchange_code(&self, code: &str, code_verifier: &str, port: u16) -> Result<OAuthTokens, String>;
    async fn list_issues(&self, token: &str, config: &TicketingConfig) -> Result<Vec<RemoteIssue>, String>;
}
```

**RemoteIssue** — the normalized type that all providers map into:
```rust
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct RemoteIssue {
    pub external_id: String,        // provider-unique ID (e.g. "#123", "PROJ-42")
    pub title: String,
    pub description: Option<String>,
    pub url: String,                // web URL (becomes external_url on task)
    pub labels: Vec<String>,
    pub updated_at: String,         // ISO 8601 — used for change detection
}
```

### Pattern 5: IPC Command Registration (follows existing pattern exactly)

**What:** New commands go in `ipc/ticketing_handlers.rs`, exported via `ipc/mod.rs`, registered in `lib.rs` via `collect_commands![]`. Identical to `acp_handlers.rs`, `task_handlers.rs` pattern.

**New IPC commands (7 total):**

| Command | Sync/Async | Purpose |
|---------|------------|---------|
| `get_ticketing_config` | async | Load config from `.maestro/ticketing.json` |
| `save_ticketing_config` | async | Save provider + repo settings to `.maestro/ticketing.json` |
| `start_oauth_flow` | async | Start localhost OAuth server, open browser, emit event on completion |
| `disconnect_ticketing` | async | Delete token from OS keychain |
| `check_ticketing_connection` | async | Return `true` if token exists in keychain |
| `list_provider_issues` | async | Fetch open issues from provider API using stored token |
| `import_issues` | async | Upsert selected issues as Backlog tasks, emit `tasks-changed` |

**Removed commands (from `settings_handlers.rs`):**
- `sync_github_issues` — replaced by `import_issues`
- `sync_jira_issues` — replaced by `import_issues`
- `save_import_config` — replaced by `save_ticketing_config`

---

## Data Flow

### OAuth Connection Flow

```
User clicks "Connect to GitHub" in SettingsPage > OAuthConnectSection
    ↓
invoke("start_oauth_flow", { projectId })
    ↓
ticketing_handlers::start_oauth_flow
    → load project path from DB
    → load TicketingConfig from .maestro/ticketing.json (get provider + config)
    → ticketing::oauth::start_oauth_flow(window, project_id, provider, config)
        → generate PKCE verifier + challenge + state nonce (all in Rust)
        → start_with_config(config, move |url| { ... }) via tauri-plugin-oauth
        → build provider auth URL with redirect_uri=http://127.0.0.1:{port}
        → open URL in browser via tauri_plugin_opener
    → return OAuthFlowStarted { port } — frontend shows spinner
    ↓
[Browser OAuth dance]
    ↓
tauri-plugin-oauth callback fires (inside the move closure)
    → validate state nonce
    → POST to provider token endpoint via reqwest
    → keychain::store_token(provider.name(), project_id, access_token)
    → window.emit("ticketing:connected", ())
    → cancel(port)
    ↓
Frontend: listen("ticketing:connected")
    → invalidate ticketing:connection + ticketing:config queries
    → OAuthConnectSection re-renders showing "Connected" state + disconnect button
```

### Issue Import Flow

```
User clicks "Import Issues" button in Backlog action bar
    ↓
ImportIssuesModal opens
    → useTicketingIssuesQuery fires (enabled=true)
    → invoke("list_provider_issues", { projectId })
    ↓
ticketing_handlers::list_provider_issues
    → load project path from DB
    → load TicketingConfig from .maestro/ticketing.json
    → keychain::load_token(provider.name(), project_id)
    → provider.list_issues(token, config) → Vec<RemoteIssue>
    ↓
Return Vec<RemoteIssue> to frontend
    ↓
Frontend classifies into three buckets using cached useTasksQuery data:
    Available:  remote issue external_id NOT in existing tasks
    Imported:   task.is_imported=true AND remote.updated_at <= task.external_updated_at
    Changed:    task.is_imported=true AND remote.updated_at > task.external_updated_at
    ↓
User checks boxes → clicks "Import Selected"
    → invoke("import_issues", { projectId, externalIds: [...] })
    ↓
ticketing_handlers::import_issues
    → for each external_id: SELECT task WHERE external_id=? AND project_id=?
        If absent: INSERT (status='Backlog', is_imported=1, import_source, external_url, external_updated_at)
        If present: UPDATE (name, description, external_url, external_updated_at)
    → app_state.app_handle.emit("tasks-changed", ())
    ↓
Frontend: tasks-changed event
    → useTasksQuery auto-invalidates → Backlog refreshes
    → ImportIssuesModal re-classifies issues (now show as Imported)
```

### Change Detection Data Model

The `tasks` table needs two new columns (schema version bump to 16):

```sql
-- Added in SCHEMA_V16
ALTER TABLE tasks ADD COLUMN external_url TEXT;
ALTER TABLE tasks ADD COLUMN external_updated_at TEXT;
```

The `Task` struct in `models/task.rs` and `TASK_SELECT` constant both need updating to add:
```rust
pub external_url: Option<String>,
pub external_updated_at: Option<String>,
```

Change detection comparison is done in the frontend (no extra IPC call):
- At import: backend writes `external_updated_at = remote_issue.updated_at`
- At modal open: frontend compares `RemoteIssue.updated_at > Task.external_updated_at` (string comparison works for ISO 8601)
- Issues where comparison is true → "Changed" tab

---

## Integration Points

### New vs Modified: Explicit Breakdown

| File | Status | What Changes |
|------|--------|--------------|
| `src-tauri/src/ticketing/` (whole dir) | NEW | Entire module: mod.rs, oauth.rs, keychain.rs, providers/*.rs |
| `src-tauri/src/ipc/ticketing_handlers.rs` | NEW | 7 IPC commands |
| `src-tauri/src/models/ticketing.rs` | NEW | TicketingConfig, RemoteIssue, ImportResult, OAuthFlowStarted, ProviderKind |
| `src-tauri/src/ipc/mod.rs` | MODIFIED | Add `pub use ticketing_handlers::*;` |
| `src-tauri/src/models/mod.rs` | MODIFIED | Add `pub mod ticketing;` and re-export key types |
| `src-tauri/src/lib.rs` | MODIFIED | Register 7 new commands; remove 3 old commands from collect_commands![] |
| `src-tauri/src/db/schema.rs` | MODIFIED | Bump to v16; add `external_url`, `external_updated_at` columns to tasks table |
| `src-tauri/src/models/task.rs` | MODIFIED | Add `external_url: Option<String>`, `external_updated_at: Option<String>` to Task struct and TASK_SELECT |
| `src-tauri/src/db/project_storage.rs` | MODIFIED | Add `load_ticketing_config` and `save_ticketing_config` wrappers |
| `src-tauri/src/main.rs` | MODIFIED | Add `.plugin(tauri_plugin_oauth::init())` |
| `src-tauri/src/ipc/settings_handlers.rs` | MODIFIED | Remove `sync_github_issues`, `sync_jira_issues`, `save_import_config` |
| `src-tauri/Cargo.toml` | MODIFIED | Add `tauri-plugin-oauth = "2"`, `url = "2"`, `async-trait = "0.1"` |
| `src/services/ticketing.service.ts` | NEW | TanStack Query hooks for all 7 commands + OAuth event listeners |
| `src/components/kanban/ImportIssuesModal.tsx` | NEW | Issue browser with tabs + checkbox multi-select |
| `src/components/common/OAuthConnectSection.tsx` | NEW | Connect/disconnect UI with OAuth event listener |
| `src/components/common/SettingsPage.tsx` | MODIFIED | Add OAuthConnectSection below existing agent settings |
| `src/components/views/BacklogView.tsx` | MODIFIED | Add "Import Issues" button visible when provider is configured |
| `src/types/bindings.ts` | REGENERATED | After `pnpm tauri:gen` following any model change |

### tauri-plugin-oauth Integration

**Cargo.toml addition:**
```toml
tauri-plugin-oauth = "2"
```

**main.rs addition:**
```rust
.plugin(tauri_plugin_oauth::init())
```

The plugin provides only the `start_with_config` and `cancel` Rust API — it registers no IPC commands itself. The localhost server uses a TCP socket, not a URL opener.

**Critical implementation detail:** `start_with_config` takes a `move` closure. The PKCE `code_verifier` and `state_nonce` must be captured into that closure — they cannot be stored in `AppState` and retrieved later. This means no shared mutable state is needed for the OAuth flow.

**`tauri::Window` vs `tauri::AppHandle`:** The OAuth callback closure needs a `Window` to emit events (not `AppHandle`). The IPC command handler receives `window: tauri::Window` as a parameter. This is the standard Tauri 2 pattern.

**No additional capability permissions** are needed in `tauri.conf.json` for the plugin.

### keyring crate (already installed at v3.6.3)

No new Cargo dependency — `keyring` is already in `Cargo.toml`. The `windows-native` feature is already enabled. The API used (`Entry::new`, `set_password`, `get_password`, `delete_credential`) is stable across v3.x.

`keyring::Error::NoEntry` is the correct variant to check for "no token stored yet" — treat it as `Ok(None)`, not as an error.

### Frontend TanStack Query Integration

**Query key factory** (follows the factory pattern used by all existing services):

```typescript
export const ticketingQueryKeys = {
  base: ["ticketing"] as const,
  config: (projectId: number) => [...ticketingQueryKeys.base, "config", projectId] as const,
  connection: (projectId: number) => [...ticketingQueryKeys.base, "connection", projectId] as const,
  issues: (projectId: number) => [...ticketingQueryKeys.base, "issues", projectId] as const,
};
```

**OAuth event listener in OAuthConnectSection** (one-shot event, not a query):
```typescript
useEffect(() => {
  let unlisten: (() => void) | undefined;
  listen("ticketing:connected", () => {
    void queryClient.invalidateQueries({ queryKey: ticketingQueryKeys.connection(projectId) });
    void queryClient.invalidateQueries({ queryKey: ticketingQueryKeys.config(projectId) });
    toast.success("Connected successfully");
  }).then((fn) => { unlisten = fn; });
  return () => { unlisten?.(); };
}, [projectId, queryClient]);
```

**Issue list query** — `enabled` prop controls whether to fetch:
```typescript
export function useTicketingIssuesQuery(projectId: number, modalOpen: boolean) {
  return useQuery({
    queryKey: ticketingQueryKeys.issues(projectId),
    queryFn: () => api.listProviderIssues(projectId),
    enabled: modalOpen,
    staleTime: 0,
    refetchInterval: modalOpen ? 5 * 60 * 1000 : false, // 5-min refresh while open
  });
}
```

**Import mutation** — `tasks-changed` event already wired in `useTasksQuery`; only need to invalidate issues query:
```typescript
export function useImportIssuesMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, externalIds }: { projectId: number; externalIds: string[] }) =>
      api.importIssues(projectId, externalIds),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ticketingQueryKeys.issues });
      // tasks-changed event from backend triggers useTasksQuery invalidation automatically
    },
    onError: createErrorToastHandler("Failed to import issues"),
  });
}
```

### ImportIssuesModal Integration

**Mount point:** Triggered from button in `BacklogView.tsx` header, alongside the existing "Add Task" button. Button is conditionally rendered — only shown when `ticketingConfigQuery.data?.provider` is not null.

**Modal state (local `useState`, not Zustand):** `selectedIds: Set<string>` for checkbox state. No global store needed — this is transient selection state.

**Issue classification** uses data already in React Query cache:
- `useTasksQuery` data (already fetched for Backlog) provides `Task[]` with `external_id` and `external_updated_at`
- `useTicketingIssuesQuery` data provides `RemoteIssue[]`
- Classification is a pure derivation in the component — no extra IPC call

**Three-tab layout:**
```
[Available (n)] [Imported (n)] [Changed (n)]
┌──────────────────────────────────────────┐
│ ☐  Issue title                  #123     │
│    label1  label2                        │
│ ☐  Another issue                #456     │
│    no labels                             │
└──────────────────────────────────────────┘
[Import Selected (2)]  [Refresh]  [Close]
```

Shadcn/ui `Dialog` + `Tabs` + `Checkbox` components (already installed). No new UI library needed.

---

## Anti-Patterns

### Anti-Pattern 1: Storing Tokens in ticketing.json or SQLite

**What people do:** Serializing `access_token` into the JSON config file or a SQLite column for convenience.

**Why it's wrong:** `.maestro/ticketing.json` lives in the project directory — developers often commit `.maestro/` files or share them. SQLite is in the Tauri app data dir but readable by any process on the system. Both leak credentials at rest.

**Do this instead:** `keyring::Entry::set_password` stores to OS keychain (macOS Keychain, Windows Credential Manager, Linux Secret Service). Only accessible to the authenticated user.

### Anti-Pattern 2: Token Exchange in the Frontend

**What people do:** Passing PKCE verifier or client_secret to frontend JS so it can POST to the token endpoint.

**Why it's wrong:** JS in WebView is inspectable. PKCE verifier in JS memory is readable by any extension with WebView access. Many providers also block non-browser token endpoint requests via CORS.

**Do this instead:** The `start_with_config` callback closure owns the `code_verifier` via `move`. Exchange happens via `reqwest` in the Rust closure. Frontend receives only `"ticketing:connected"` — never the token.

### Anti-Pattern 3: Adding OAuthPendingState to AppState

**What people do:** Adding a `Mutex<Option<OAuthPendingState>>` to `AppState` to pass PKCE state between the IPC command and the OAuth callback.

**Why it's wrong:** The callback closure captures PKCE state via `move` at spawn time. No cross-async-boundary sharing is needed. Adding to `AppState` introduces unnecessary locking and the risk of stale state leakage if a second OAuth flow starts before the first completes.

**Do this instead:** Move `code_verifier` and `state_nonce` directly into the `start_with_config` closure. The closure owns these values for the server lifetime.

### Anti-Pattern 4: Monolithic ticketing_handlers.rs

**What people do:** Putting provider-specific HTTP logic, OAuth state, and IPC commands all in one file.

**Why it's wrong:** Already bad at 2 providers (see `settings_handlers.rs` at 220 lines with interleaved GitHub and Jira logic). With 4 providers it becomes unmaintainable. The IPC handlers become the only place to find bugs in HTTP request building.

**Do this instead:** IPC handlers are thin dispatchers — typically 10-20 lines each. All provider logic in `ticketing/providers/*.rs`. OAuth machinery in `ticketing/oauth.rs`. Keychain operations in `ticketing/keychain.rs`.

### Anti-Pattern 5: Auto-Syncing Issues on Project Open

**What people do:** Fetching all provider issues at project-open time, replicating the old `sync_*` pattern.

**Why it's wrong:** Hits external APIs on every project open. Slows startup. Makes project open fail if network is unavailable. Users may not want to import anything.

**Do this instead:** Fetch only when the import modal opens via `enabled: modalOpen` in TanStack Query. Auto-refresh while modal is open via `refetchInterval`. Keep project open free of external API calls.

---

## Build Order (Phase Dependencies)

Each phase can only start after the previous compiles and `pnpm tauri:gen` is run at the boundary between Rust changes and frontend consumption.

### Phase 1: Data Foundation
1. Update `db/schema.rs`: bump to v16, add `external_url` + `external_updated_at` to tasks table
2. Update `models/task.rs`: add both fields to `Task` struct and `TASK_SELECT` constant
3. Create `models/ticketing.rs`: `TicketingConfig`, `RemoteIssue`, `ImportResult`, `OAuthFlowStarted`, `ProviderKind`
4. Update `models/mod.rs`: add `pub mod ticketing;` and re-export new types

**Why first:** Everything downstream depends on these types compiling.

### Phase 2: Storage Layer
5. Update `db/project_storage.rs`: add `load_ticketing_config` and `save_ticketing_config` wrappers
6. Create `ticketing/keychain.rs`: `store_token`, `load_token`, `delete_token`

**Why second:** IPC handlers and providers depend on storage. Both are independently unit-testable at this phase.

### Phase 3: Provider Clients
7. Create `ticketing/mod.rs`: `ProviderClient` trait definition
8. Implement `ticketing/providers/github.rs` first (simplest OAuth, REST, most common)
9. Implement `ticketing/providers/jira.rs`
10. Implement `ticketing/providers/gitlab.rs`
11. Implement `ticketing/providers/linear.rs` (GraphQL, implement last — different query shape)

**Why third:** Providers depend on `RemoteIssue` (Phase 1) and the trait definition. Implement GitHub first to validate the trait design before committing to it for all four providers.

### Phase 4: OAuth State Machine
12. Add `tauri-plugin-oauth = "2"` and `url = "2"` to `Cargo.toml`
13. Create `ticketing/oauth.rs`: `start_oauth_flow` function
14. Modify `main.rs`: add `.plugin(tauri_plugin_oauth::init())`

**Why fourth:** OAuth depends on providers (`build_auth_url`, `exchange_code`).

### Phase 5: IPC Commands + Bindings Regeneration
15. Create `ipc/ticketing_handlers.rs`: all 7 commands
16. Update `ipc/mod.rs`: `pub use ticketing_handlers::*;`
17. Remove `sync_github_issues`, `sync_jira_issues`, `save_import_config` from `settings_handlers.rs`
18. Register new commands and deregister old ones in `lib.rs`
19. Run `pnpm tauri:gen` to regenerate `src/types/bindings.ts`

**Why fifth:** IPC layer depends on all lower layers. Bindings regeneration is the boundary between Rust and frontend work.

### Phase 6: Frontend Services + Settings UI
20. Create `src/services/ticketing.service.ts`: all query/mutation hooks
21. Create `src/components/common/OAuthConnectSection.tsx`
22. Modify `src/components/common/SettingsPage.tsx`: add provider config form + OAuthConnectSection

**Why sixth:** Depends on generated bindings from Phase 5.

### Phase 7: Import Modal
23. Create `src/components/kanban/ImportIssuesModal.tsx`
24. Modify `src/components/views/BacklogView.tsx`: add "Import Issues" button + modal open state

**Why last:** Depends on all frontend services (Phase 6). The modal is the user-facing culmination of all preceding work.

---

## Scaling Considerations

This is a desktop app — traditional horizontal scaling does not apply. Relevant per-project considerations:

| Concern | Approach |
|---------|----------|
| Large issue lists (500+) | Pass query/filter params to provider API (GitHub `labels`, Jira JQL, GitLab `milestone_id`). Pagination handled per-provider in `list_issues`. Return all open issues; let frontend filter by label/text. |
| Token expiry | On 401 from `list_provider_issues`, clear keychain and return error string "token-expired". Frontend shows "Reconnect" button instead of issue list. |
| Self-hosted GitLab | `base_url` in `TicketingConfig` overrides `https://gitlab.com` in all GitLab API calls. Validated (must be HTTPS) at `save_ticketing_config`. |
| Multiple projects with different providers | Keychain key includes `project_id`. `TicketingConfig` is per-project file. No coupling between projects. |
| Refresh token storage | Store comma-separated `access_token,refresh_token` in a single keychain entry, or use a second entry with `{provider}-{project_id}-refresh`. Second entry is cleaner. |

---

## Sources

- Direct codebase inspection: `models/project_config.rs`, `models/project_state.rs`, `db/project_storage.rs`, `db/schema.rs`, `db/connection.rs`, `models/task.rs`, `ipc/settings_handlers.rs`, `ipc/task_handlers.rs`, `main.rs`, `Cargo.toml`, `src/services/task.service.ts`, `src/services/worktree.service.ts`, `src/components/views/BacklogView.tsx`
- Context7: `/fabianlars/tauri-plugin-oauth` — HIGH confidence, verified API: `start_with_config`, `cancel`, `OauthConfig`
- Context7: `/open-source-cooperative/keyring-rs` — HIGH confidence, verified API: `Entry::new`, `set_password`, `get_password`, `delete_credential`, `Error::NoEntry`
- Schema version: confirmed v15 in `db/schema.rs` — v16 is the next available slot

---

*Architecture research for: Maestro v1.6 OAuth Ticketing Integration*
*Researched: 2026-05-20*
