# Phase 51: Data Foundation - Pattern Map

**Mapped:** 2026-05-20
**Files analyzed:** 7 (3 new, 2 modified, 2 deleted frontend files)
**Analogs found:** 6 / 7

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `src-tauri/src/models/ticketing.rs` | model | CRUD | `src-tauri/src/models/project_config.rs` | exact |
| `src-tauri/src/ipc/ticketing_handlers.rs` | controller | request-response | `src-tauri/src/ipc/project_handlers.rs` (lines 503–578) | exact |
| `src-tauri/src/db/schema.rs` | config | batch | `src-tauri/src/db/schema.rs` (self) | self-modify |
| `src-tauri/src/lib.rs` | config | request-response | `src-tauri/src/lib.rs` (self) | self-modify |
| `src-tauri/src/ipc/mod.rs` | config | — | `src-tauri/src/ipc/mod.rs` (self) | self-modify |
| `src-tauri/src/models/mod.rs` | config | — | `src-tauri/src/models/mod.rs` (self) | self-modify |
| `src/App.tsx` (modify) | component | request-response | `src/App.tsx` (self) | self-modify |

---

## Pattern Assignments

### `src-tauri/src/models/ticketing.rs` (model, CRUD)

**Analog:** `src-tauri/src/models/project_config.rs`

**Imports pattern** (lines 1–6):
```rust
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json;
use std::fs;
use std::path::Path;
use specta::Type;
```

**Core struct pattern** (lines 9–16):
```rust
#[derive(Debug, Clone, Serialize, Deserialize, Type, Default)]
#[serde(default)]
#[specta(export)]
pub struct ProjectConfig {
    pub default_agent: Option<String>,
    pub default_model: Option<String>,
    pub updated_at: String,
}
```
Apply this directly: `TicketingConfig` must have `#[derive(Debug, Clone, Serialize, Deserialize, Type, Default)]`, `#[serde(default)]`, and `#[specta(export)]`. The `ProviderConfig` enum (D-04) uses externally-tagged serde (Rust default for enums), so no `#[serde(tag)]` annotation is needed — the variant name becomes the JSON key.

Per D-07, the provider-config sub-structs (`JiraConfig`, `GitHubConfig`, `GitLabConfig`, `LinearConfig`) do NOT need `#[specta(export)]` individually unless consumed separately by the frontend — only `TicketingConfig` needs it.

**load_from_project / save_to_project pattern** (lines 19–48):
```rust
impl ProjectConfig {
    pub fn load_from_project(project_path: &str) -> Result<Self, String> {
        let config_path = Path::new(project_path)
            .join(".maestro")
            .join("settings.json");

        let content = fs::read_to_string(&config_path).map_err(|e| {
            format!("Failed to read {}: {}", config_path.display(), e)
        })?;

        serde_json::from_str(&content).map_err(|e| {
            format!("Invalid JSON in settings.json: {}", e)
        })
    }

    pub fn save_to_project(&self, project_path: &str) -> Result<(), String> {
        let maestro_dir = Path::new(project_path).join(".maestro");
        fs::create_dir_all(&maestro_dir).map_err(|e| {
            format!("Failed to create .maestro directory: {}", e)
        })?;

        let config_path = maestro_dir.join("settings.json");
        let json = serde_json::to_string_pretty(&self).map_err(|e| {
            format!("Serialization failed: {}", e)
        })?;

        fs::write(&config_path, json).map_err(|e| {
            format!("Failed to write settings.json: {}", e)
        })
    }
}
```
For `TicketingConfig`, replace `"settings.json"` with `"ticketing.json"` and update error message strings accordingly.

**Utility function pattern** (lines 51–54):
```rust
pub fn now_rfc3339() -> String {
    Utc::now().to_rfc3339()
}
```
Re-use `now_rfc3339()` from `project_config.rs` (already in scope via `models` module) rather than duplicating it in `ticketing.rs`.

**Note on `ProviderConfig` serde tagging** (from D-04):
The required JSON shape is `{ "provider": { "jira": { ... } } }`, which is serde's default external tagging. Do NOT add any `#[serde(tag = ...)]` attribute. Apply `#[serde(rename_all = "lowercase")]` to the enum to map variant names to lowercase discriminator keys.

---

### `src-tauri/src/ipc/ticketing_handlers.rs` (controller, request-response)

**Analog:** `src-tauri/src/ipc/project_handlers.rs` — specifically the `get_project_settings` and `update_project_settings` pair (lines 503–578), which load/save a `.maestro/` JSON file by project ID.

**Imports pattern** (from project_handlers.rs lines 1–11):
```rust
use std::sync::Arc;
use tauri::State;
use chrono::Utc;
use crate::db::AppState;
```
For `ticketing_handlers.rs` these are the only imports needed. No `rusqlite`, no `reqwest` — this handler only does file I/O via the model's own methods.

**Core handler pattern** — `get_project_settings` (lines 505–536):
```rust
#[tauri::command]
#[specta::specta]
pub async fn get_project_settings(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
) -> Result<crate::models::ProjectConfigResponse, String> {
    let (path, connection_id) = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        conn.query_row(
            "SELECT path, connection_id FROM projects WHERE id = ?",
            [project_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<i32>>(1)?)),
        ).map_err(|_| format!("Project {} not found", project_id))?
    };

    let config = if let Some(_conn_id) = connection_id {
        // SSH path: read via session
        ...
    } else {
        crate::models::ProjectConfig::load_from_project(&path).unwrap_or_default()
    };

    Ok(...)
}
```
For `get_ticketing_config`: same DB lookup pattern to get `(path, connection_id)`. For Phase 51 scope, implement only the local path (`connection_id.is_none()`) case using `TicketingConfig::load_from_project(&path).unwrap_or_default()`. Return `TicketingConfig` directly (no wrapper DTO needed — `#[specta(export)]` on the struct handles TS generation).

**Core handler pattern** — `update_project_settings` (lines 539–578):
```rust
#[tauri::command]
#[specta::specta]
pub async fn update_project_settings(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    settings: crate::models::ProjectConfigRequest,
) -> Result<(), String> {
    let (path, connection_id) = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        conn.query_row(
            "SELECT path, connection_id FROM projects WHERE id = ?",
            [project_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<i32>>(1)?)),
        ).map_err(|_| format!("Project {} not found", project_id))?
    };

    let config = crate::models::ProjectConfig {
        default_agent: settings.default_agent,
        default_model: settings.default_model,
        updated_at: Utc::now().to_rfc3339(),
    };

    if let Some(_conn_id) = connection_id {
        // SSH path ...
    } else {
        config.save_to_project(&path)?;
    }

    Ok(())
}
```
For `save_ticketing_config`: accept `TicketingConfig` directly as the `config` parameter (it already carries `updated_at`). Stamp `updated_at = Utc::now().to_rfc3339()` server-side before saving (ignore any `updated_at` passed by caller). For Phase 51, implement local path only; SSH path is not in scope.

**Error handling pattern** — consistent with all handlers:
```rust
app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?
conn.query_row(...).map_err(|_| format!("Project {} not found", project_id))?
```
All errors mapped to `String` via `.map_err(|e| format!("...{}", e))` — no custom error types.

---

### `src-tauri/src/db/schema.rs` (config, batch) — MODIFY

**Self-modification.** The pattern for a version bump is entirely self-contained.

**Version constant pattern** (lines 3–4):
```rust
pub const SCHEMA_VERSION: u32 = 15;

pub const SCHEMA_V15: &str = r#"...schema SQL..."#;
```
For V16: add `pub const SCHEMA_VERSION: u32 = 16;` (replacing 15), add `pub const SCHEMA_V16: &str = r#"...same SQL as V15..."#;` (identical content — no new tables in this phase), update the `conn.execute_batch(SCHEMA_V15)?;` call to `conn.execute_batch(SCHEMA_V16)?;`, and update the test assertion `assert_eq!(version, 15);` to `assert_eq!(version, 16);`.

The drop list in the destructive migration block (lines 177–192) requires no changes — no new tables are added in Phase 51.

---

### `src-tauri/src/lib.rs` (config) — MODIFY

**Command registration pattern** (lines 22–127):
```rust
pub fn create_builder() -> Builder<tauri::Wry> {
    Builder::<tauri::Wry>::new()
        .commands(collect_commands![
            crate::ipc::get_settings,
            crate::ipc::save_settings,
            crate::ipc::sync_github_issues,   // REMOVE
            crate::ipc::sync_jira_issues,     // REMOVE
            crate::ipc::save_import_config,   // REMOVE
            ...
        ])
}
```
Add `crate::ipc::get_ticketing_config` and `crate::ipc::save_ticketing_config` near the `get_settings`/`save_settings` pair. Remove the three legacy entries. Also remove `SyncResult` and related types from the `pub use models::` re-export on line 14.

**Module declaration pattern** (lines 1–17):
No new top-level module is needed — `ticketing.rs` lives inside `models/` which is already declared.

---

### `src-tauri/src/ipc/mod.rs` (config) — MODIFY

**Module declaration and re-export pattern** (lines 1–23):
```rust
pub mod settings_handlers;
// ...
pub use settings_handlers::*;
```
Add `pub mod ticketing_handlers;` and `pub use ticketing_handlers::*;` following this same pattern.

---

### `src-tauri/src/models/mod.rs` (config) — MODIFY

**Module declaration and re-export pattern** (lines 1–21):
```rust
pub mod sync;
// ...
pub use sync::{SyncResult, GitHubIssue, JiraIssue, JiraSearchResponse, JiraFields};
```
Remove `pub mod sync;` and its `pub use sync::...` line entirely (D-16). Add `pub mod ticketing;` and `pub use ticketing::TicketingConfig;` (plus any provider config types the IPC handler needs to reference by name).

---

### `src/App.tsx` (component) — MODIFY

**Lazy import pattern** (lines 44–53):
```typescript
// Lazy load modals for code splitting (performance optimization)
const TaskModal = lazy(() =>
  import("@/components/kanban/TaskModal").then((m) => ({ default: m.TaskModal })),
);
const TaskDetail = lazy(() =>
  import("@/components/task/TaskDetail").then((m) => ({ default: m.TaskDetail })),
);
const ImportSettings = lazy(() =>               // REMOVE lines 51-53
  import("@/components/task/ImportSettings").then((m) => ({ default: m.ImportSettings })),
);
```
Remove lines 51–53 (the `ImportSettings` lazy import). Also remove line 57 (`useState(false)` for `showImportSettings`), line 141 (`setShowImportSettings(false)`), and lines 285–287 (the `<ImportSettings .../>` JSX). Remove the `lazy` import from the React import on line 1 only if no other lazy() calls remain (they do — keep it).

---

## Shared Patterns

### File I/O load/save pattern
**Source:** `src-tauri/src/models/project_config.rs` lines 19–48
**Apply to:** `models/ticketing.rs` (copy verbatim, replace filename strings)
```rust
pub fn load_from_project(project_path: &str) -> Result<Self, String> {
    let config_path = Path::new(project_path).join(".maestro").join("ticketing.json");
    let content = fs::read_to_string(&config_path).map_err(|e| {
        format!("Failed to read {}: {}", config_path.display(), e)
    })?;
    serde_json::from_str(&content).map_err(|e| format!("Invalid JSON in ticketing.json: {}", e))
}

pub fn save_to_project(&self, project_path: &str) -> Result<(), String> {
    let maestro_dir = Path::new(project_path).join(".maestro");
    fs::create_dir_all(&maestro_dir).map_err(|e| {
        format!("Failed to create .maestro directory: {}", e)
    })?;
    let config_path = maestro_dir.join("ticketing.json");
    let json = serde_json::to_string_pretty(&self).map_err(|e| format!("Serialization failed: {}", e))?;
    fs::write(&config_path, json).map_err(|e| format!("Failed to write ticketing.json: {}", e))
}
```

### DB project-path lookup pattern
**Source:** `src-tauri/src/ipc/project_handlers.rs` lines 510–516
**Apply to:** `ipc/ticketing_handlers.rs` (both `get_ticketing_config` and `save_ticketing_config`)
```rust
let (path, connection_id) = {
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
    conn.query_row(
        "SELECT path, connection_id FROM projects WHERE id = ?",
        [project_id],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<i32>>(1)?)),
    ).map_err(|_| format!("Project {} not found", project_id))?
};
```

### IPC command attribute pattern
**Source:** `src-tauri/src/ipc/settings_handlers.rs` lines 10–11
**Apply to:** All new commands in `ticketing_handlers.rs`
```rust
#[tauri::command]
#[specta::specta]
pub fn get_settings(...) -> Result<AppSettings, String> {
```

### Error mapping pattern
**Source:** Any IPC handler
**Apply to:** All new Rust functions
```rust
.map_err(|e| format!("Lock failed: {}", e))?
.map_err(|e| e.to_string())?
.map_err(|e| format!("Descriptive context: {}", e))?
```
Never use `.unwrap()`. Never use `let _ =` on fallible operations.

---

## No Analog Found

| File | Role | Data Flow | Reason |
|------|------|-----------|--------|
| `src-tauri/src/models/ticketing.rs` (enum portion) | model | — | No existing externally-tagged provider enum in codebase; use D-04 spec directly |

The enum shape itself (`ProviderConfig` with `Jira`, `GitHub`, `GitLab`, `Linear` variants) has no direct analog — derive the structure entirely from D-04 in CONTEXT.md. The surrounding `TicketingConfig` struct and load/save methods are fully covered by the `project_config.rs` analog.

---

## Metadata

**Analog search scope:** `src-tauri/src/models/`, `src-tauri/src/ipc/`, `src-tauri/src/db/`, `src/App.tsx`
**Files scanned:** 9 source files read in full
**Pattern extraction date:** 2026-05-20
