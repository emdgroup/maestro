# Phase 53: API Key Auth + API Clients — Pattern Map

**Mapped:** 2026-05-21
**Files analyzed:** 6 (3 new, 3 modified)
**Analogs found:** 6 / 6

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `src-tauri/src/ticketing/github.rs` | service | request-response | `src-tauri/src/ticketing/keychain.rs` | role-match |
| `src-tauri/src/ticketing/gitlab.rs` | service | request-response | `src-tauri/src/ticketing/keychain.rs` | role-match |
| `src-tauri/src/ticketing/forgejo.rs` | service | request-response | `src-tauri/src/ticketing/keychain.rs` | role-match |
| `src-tauri/src/models/ticketing.rs` | model | transform | itself (existing) | exact |
| `src-tauri/src/ticketing/mod.rs` | config | — | itself (existing) | exact |
| `src-tauri/src/ipc/ticketing_handlers.rs` | controller | request-response | itself (existing) | exact |

---

## Pattern Assignments

### `src-tauri/src/ticketing/github.rs` (service, request-response)

**Analog:** `src-tauri/src/ticketing/keychain.rs`

**Imports pattern** — follow this shape; swap in `reqwest` for HTTP calls:
```rust
use crate::ticketing::token_manager::StoredToken;
```

**TokioCommand pattern for `gh auth token`** — from `src-tauri/src/git/mod.rs` lines 6, 19-28:
```rust
use tokio::process::Command as TokioCommand;

// Usage pattern:
let output = TokioCommand::new("gh")
    .args(&["auth", "token"])
    .output()
    .await
    .map_err(|e| format!("Failed to spawn gh: {}", e))?;
if !output.status.success() {
    let stderr = String::from_utf8_lossy(&output.stderr);
    return Err(format!("gh auth token failed: {}", stderr));
}
let token = String::from_utf8_lossy(&output.stdout).trim().to_string();
```

**Error handling style** — every fallible call uses `.map_err(|e| format!("…: {}", e))?`. No `.unwrap()`. No silent `let _ =`. See `keychain.rs` lines 36, 38, 57, 116 for the exact pattern.

**No async on struct methods unless calling `.await`** — `KeychainStore` methods are sync. Provider service functions that call `reqwest` or `TokioCommand` must be `async fn`.

**Return type convention:** `Result<T, String>` — all IPC-facing functions return `String` errors, matching the rest of the codebase.

**`#[cfg(test)]` block structure** — from `keychain.rs` lines 163-240:
```rust
#[cfg(test)]
mod tests {
    use super::*;

    // helper that constructs test fixture (no Result return, use expect())
    fn make_test_input() -> SomeType { ... }

    #[test]
    fn test_happy_path() { ... }

    #[test]
    fn test_missing_returns_none() { ... }

    // For tests requiring network/keychain:
    #[test]
    #[ignore = "requires live GitHub token (run manually)"]
    fn test_live_roundtrip() { ... }
}
```

---

### `src-tauri/src/ticketing/gitlab.rs` (service, request-response)

**Analog:** `src-tauri/src/ticketing/keychain.rs`

Same patterns as `github.rs` above. Differences to note:
- No `gh` CLI — PAT comes from `TokenManager::get_token()` only (no CLI fallback).
- GitLab API base URL comes from `GitLabConfig::host` (self-hosted support), not a constant.
- URL pattern: `https://{host}/api/v4/projects/{project_id}/issues`

---

### `src-tauri/src/ticketing/forgejo.rs` (service, request-response)

**Analog:** `src-tauri/src/ticketing/keychain.rs`

Same patterns as `gitlab.rs`. Forgejo uses the Gitea-compatible API:
- URL pattern: `https://{host}/api/v1/repos/{owner}/{repo}/issues`
- PAT passed as `Authorization: token {pat}` header (not `Bearer`).

---

### `src-tauri/src/models/ticketing.rs` (model, transform)

**Analog:** itself — add new variants to the existing `ProviderConfig` enum.

**Current enum** (lines 18-26 of `src-tauri/src/models/ticketing.rs`):
```rust
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
#[specta(export)]
pub enum ProviderConfig {
    Jira(JiraConfig),
    GitHub(GitHubConfig),
    GitLab(GitLabConfig),
    Linear(LinearConfig),
}
```

**Derive macro set to copy exactly** for any new config struct:
```rust
#[derive(Debug, Clone, Serialize, Deserialize, Type, Default)]
#[serde(default)]
pub struct ForgejoConfig {
    pub host: String,
    pub owner: String,
    pub repo: String,
}
```

**Gotchas:**
- `#[specta(export)]` belongs on the enum and on `TicketingConfig`, NOT on individual structs.
- `#[serde(rename_all = "lowercase")]` on the enum controls how variant names serialize (e.g., `"forgejo"`, `"jiracloud"`). Compound names like `JiraCloud` → `"jiracloud"` under `lowercase`. If `"jira_cloud"` is preferred, switch to `"snake_case"` — but match the existing enum's attribute exactly to avoid inconsistency.
- `Type` from `specta` is required on every struct/enum that appears in a `#[tauri::command]` signature or nested inside one.
- `Default` is needed on config structs to satisfy `#[serde(default)]` on `TicketingConfig`.

---

### `src-tauri/src/ticketing/mod.rs` (config)

**Analog:** itself — append new `pub mod` and `pub use` lines following the existing layout.

**Current content** (lines 1-5 of `src-tauri/src/ticketing/mod.rs`):
```rust
pub mod keychain;
pub mod token_manager;

pub use keychain::KeychainStore;
pub use token_manager::{StoredToken, TokenManager};
```

**Pattern to follow:** add one `pub mod` per new provider file, then `pub use` any public types that handlers will need directly. If `github.rs` etc. expose a single entry-point function (e.g., `test_connection`, `list_issues`) rather than a struct, no `pub use` is needed — callers reference `crate::ticketing::github::list_issues(...)` directly.

---

### `src-tauri/src/ipc/ticketing_handlers.rs` (controller, request-response)

**Analog:** itself — new commands follow the exact boilerplate of `get_ticketing_config` / `save_ticketing_config`.

**IPC command boilerplate** (lines 1-23 of `src-tauri/src/ipc/ticketing_handlers.rs`):
```rust
use std::sync::Arc;
use tauri::State;
use crate::db::AppState;
use crate::models::ticketing::TicketingConfig;

#[tauri::command]
#[specta::specta]
pub async fn get_ticketing_config(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
) -> Result<TicketingConfig, String> {
    let path = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        conn.query_row(
            "SELECT path FROM projects WHERE id = ?",
            [project_id],
            |row| row.get::<_, String>(0),
        ).map_err(|_| format!("Project {} not found", project_id))?
    };
    // ...
}
```

**DB lock pattern** — always use a scoped block `{ let conn = app_state.db.lock()...; ... }` so the `MutexGuard` is dropped before any `.await`. New commands that call async provider functions (reqwest, TokioCommand) must resolve the project path inside a sync block first, then drop the lock before the await.

**`app_handle` pattern** — commands that need to call `TokenManager::get_token` require `app_handle: tauri::AppHandle` as an additional parameter. `AppState` already holds the `TokenManager`; access it via `app_state.token_manager`. Example signature:
```rust
#[tauri::command]
#[specta::specta]
pub async fn test_ticketing_connection(
    app_state: State<'_, Arc<AppState>>,
    app_handle: tauri::AppHandle,
    project_id: i32,
) -> Result<bool, String> {
    let (path, app_data_dir) = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        let path = conn.query_row(
            "SELECT path FROM projects WHERE id = ?",
            [project_id],
            |row| row.get::<_, String>(0),
        ).map_err(|_| format!("Project {} not found", project_id))?;
        let app_data_dir = app_handle.path().app_data_dir()
            .map_err(|e| format!("App data dir error: {}", e))?;
        (path, app_data_dir)
    };
    // await calls go here, lock is already dropped
    crate::ticketing::github::test_connection(&path, &app_data_dir, ...).await
}
```

**Registering new commands in `src-tauri/src/lib.rs`** — append to the list at lines 125-127, matching the `crate::ipc::command_name` form:
```rust
// Ticketing config
crate::ipc::get_ticketing_config,
crate::ipc::save_ticketing_config,
// Ticketing providers (Phase 53)
crate::ipc::test_ticketing_connection,
crate::ipc::list_ticketing_issues,
// ... one line per new command
```

**`ipc/mod.rs`** already has `pub use ticketing_handlers::*;` (line 25) — no change needed there when adding commands to the existing file.

---

## Shared Patterns

### Error Handling (applies to all new files)
**Source:** `src-tauri/src/ticketing/keychain.rs` lines 36-46
```rust
// Every fallible call follows this exact shape — no .unwrap(), no let _ =
.map_err(|e| format!("Descriptive context: {}", e))?
```
For match arms on known error variants (e.g., HTTP 401 vs 404), use explicit `match` with an `Err(e) => Err(format!(...))` fallthrough.

### Mutex / Lock Pattern (applies to all IPC handlers)
**Source:** `src-tauri/src/ipc/ticketing_handlers.rs` lines 13-19
```rust
let path = {
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
    conn.query_row(...).map_err(...)?
};
// conn (MutexGuard) dropped here — safe to .await below
```

### TokenManager Access (applies to github.rs, gitlab.rs, forgejo.rs callers)
**Source:** `src-tauri/src/ticketing/token_manager.rs` lines 53-58
```rust
// Signature to mirror when calling from handlers:
pub fn get_token(
    &self,
    project_id: i32,
    app_data_dir: &std::path::Path,
    app_handle: &AppHandle,
) -> Result<Option<StoredToken>, String>
```
The `TokenManager` lives at `app_state.token_manager`. Provider service functions should accept a `&str` PAT directly (not `&TokenManager`) — the handler resolves the token before calling into the provider module.

### TokioCommand Spawn (applies to github.rs for `gh auth token`)
**Source:** `src-tauri/src/git/mod.rs` lines 6, 19-28
```rust
use tokio::process::Command as TokioCommand;

let output = TokioCommand::new("gh")
    .args(&["auth", "token"])
    .output()
    .await
    .map_err(|e| format!("Failed to spawn gh: {}", e))?;
if !output.status.success() {
    return Err(format!("gh auth token failed: {}",
        String::from_utf8_lossy(&output.stderr)));
}
```

### StoredToken struct (applies wherever tokens are constructed)
**Source:** `src-tauri/src/ticketing/token_manager.rs` lines 9-15
```rust
#[derive(Debug, Clone, Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
pub struct StoredToken {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_at: Option<i64>,
    pub provider: String,  // "github" | "gitlab" | "forgejo"
}
```
PATs have no expiry — set `refresh_token: None, expires_at: None`.

---

## No Analog Found

No files in Phase 53 lack a codebase analog. All patterns are present in the existing `ticketing/` and `ipc/` modules.

---

## Metadata

**Analog search scope:** `src-tauri/src/ticketing/`, `src-tauri/src/ipc/`, `src-tauri/src/models/`, `src-tauri/src/git/`, `src-tauri/src/lib.rs`
**Files scanned:** 7
**Pattern extraction date:** 2026-05-21
