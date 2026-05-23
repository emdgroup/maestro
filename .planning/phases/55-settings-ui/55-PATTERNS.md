# Phase 55: Settings UI - Pattern Map

**Mapped:** 2026-05-22
**Files analyzed:** 11 new/modified files
**Analogs found:** 11 / 11

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `src-tauri/src/ticketing/keychain.rs` | utility | CRUD | self (modify) | self |
| `src-tauri/src/ipc/integration_handlers.rs` | handler | request-response | `src-tauri/src/ipc/ssh_handlers.rs` | exact |
| `src-tauri/src/ipc/ticketing_handlers.rs` | handler | request-response | self (rewrite) + `ssh_handlers.rs` | self |
| `src-tauri/src/models/integration.rs` | model | transform | `src-tauri/src/models/ticketing.rs` | role-match |
| `src-tauri/src/models/project_config.rs` | model | CRUD | self (extend) | self |
| `src-tauri/src/lib.rs` | config | request-response | self (modify) | self |
| `src/services/integration.service.ts` | service | request-response | `src/services/project.service.ts` | exact |
| `src/components/project-picker/IntegrationsTab.tsx` | component | request-response | `src/components/project-picker/ConnectionList.tsx` | role-match |
| `src/components/project-picker/IntegrationConnectDialog.tsx` | component | request-response | `src/components/project-picker/CreateProjectDialog.tsx` | exact |
| `src/components/project-picker/ProjectPicker.tsx` | component | request-response | self (modify) | self |
| `src/components/common/SettingsPage.tsx` | component | CRUD | self (extend) | self |

---

## Pattern Assignments

### `src-tauri/src/ticketing/keychain.rs` (utility, CRUD — MODIFY)

**Analog:** self

**Current key format** (line 23–25 — to be replaced):
```rust
fn username(project_id: i32) -> String {
    format!("maestro:{}:ticketing", project_id)
}
```

**New key format to replace with:**
```rust
fn integration_key(provider: &str) -> String {
    format!("maestro:integration:{}", provider)
}
```

**File path helper** (line 130 — to be updated):
```rust
// Current (project_id-based):
fn token_file_path(project_id: i32, app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("tokens").join(format!("{}.enc", project_id))
}

// New (provider-based):
fn token_file_path(provider: &str, app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("tokens").join(format!("{}.enc", provider))
}
```

**Existing store/get/delete signatures** (lines 30–91 — rename `project_id: i32` to `provider: &str`, change `username(project_id)` to `integration_key(provider)`, change `write_to_file`/`read_from_file`/`delete_file` calls to pass `provider`).

**Test pattern** (lines 197–250 — keep structure, update to use provider strings instead of i32):
```rust
#[test]
fn test_file_roundtrip() {
    let dir = tempfile::tempdir().expect("tempdir");
    let token = test_token();
    KeychainStore::write_to_file("github", &token, dir.path()).expect("write");
    let result = KeychainStore::read_from_file("github", dir.path()).expect("read");
    // ...
}
```

---

### `src-tauri/src/ipc/integration_handlers.rs` (handler, request-response — NEW)

**Analog:** `src-tauri/src/ipc/ssh_handlers.rs`

**Imports pattern** (ssh_handlers.rs lines 1–9):
```rust
use std::sync::Arc;
use tauri::State;
use crate::db::AppState;
// (no chrono needed — no DB timestamps for integrations)
```

**New imports for integration_handlers.rs:**
```rust
use std::sync::Arc;
use tauri::State;
use crate::db::AppState;
use crate::models::integration::{IntegrationStatus, CredentialSource};
use crate::ticketing::keychain::KeychainStore;
```

**Handler signature pattern** (ssh_handlers.rs lines 51–68 — list handler):
```rust
#[tauri::command]
#[specta::specta]
pub fn get_ssh_connections(
    app_state: State<Arc<AppState>>,
) -> Result<Vec<SshConnection>, String> {
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
    // ...
    Ok(connections)
}
```

**list_integrations — probe all 6 known provider keys (D-03):**
```rust
const KNOWN_PROVIDERS: &[&str] = &[
    "github", "gitlab", "forgejo", "linear", "jira_cloud", "azuredevops",
];

#[tauri::command]
#[specta::specta]
pub async fn list_integrations(
    app_state: State<'_, Arc<AppState>>,
) -> Result<Vec<IntegrationStatus>, String> {
    let mut results = Vec::new();
    for provider in KNOWN_PROVIDERS {
        let status = KeychainStore::get_integration(provider, &app_state.app_data_dir)?;
        results.push(status);
    }
    Ok(results)
}
```

**save_integration handler (no DB, keychain only):**
```rust
#[tauri::command]
#[specta::specta]
pub async fn save_integration(
    app_state: State<'_, Arc<AppState>>,
    provider: String,
    token: String,
    instance_url: Option<String>,
    email: Option<String>,
) -> Result<(), String> {
    // validate provider is known; validate credentials against provider API
    // then store via KeychainStore::store_integration
    KeychainStore::store_integration(&provider, token, instance_url, email, &app_state.app_data_dir)
}
```

**delete_integration handler (mirrors delete_ssh_connection pattern, ssh_handlers.rs lines 356–386):**
```rust
#[tauri::command]
#[specta::specta]
pub async fn delete_integration(
    app_state: State<'_, Arc<AppState>>,
    provider: String,
) -> Result<(), String> {
    KeychainStore::delete_integration(&provider, &app_state.app_data_dir)
}
```

**Error propagation pattern** (ssh_handlers.rs line 22):
```rust
let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
```
All handlers use `map_err(|e| format!("...: {}", e))?` — never `unwrap()`.

---

### `src-tauri/src/ipc/ticketing_handlers.rs` (handler, request-response — REWRITE)

**Analog:** self + `src-tauri/src/ipc/ssh_handlers.rs`

**Project path lookup pattern** (ticketing_handlers.rs lines 15–22 — keep this, it's used in all handlers):
```rust
let path = {
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
    conn.query_row(
        "SELECT path FROM projects WHERE id = ?",
        [project_id],
        |row| row.get::<_, String>(0),
    ).map_err(|_| format!("Project {} not found", project_id))?
};
```

**get_project_ticketing_config (replacing get_ticketing_config):**
```rust
#[tauri::command]
#[specta::specta]
pub async fn get_project_ticketing_config(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
) -> Result<Option<ProjectTicketingConfig>, String> {
    let path = { /* project path lookup */ };
    let config = ProjectConfig::load_from_project(&path).unwrap_or_default();
    Ok(config.ticketing)
}
```

**save_project_ticketing_config (new, replacing per-provider credential saves):**
```rust
#[tauri::command]
#[specta::specta]
pub async fn save_project_ticketing_config(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    ticketing: Option<ProjectTicketingConfig>,
) -> Result<(), String> {
    let path = { /* project path lookup */ };
    let mut config = ProjectConfig::load_from_project(&path).unwrap_or_default();
    config.ticketing = ticketing;
    config.updated_at = now_rfc3339();
    config.save_to_project(&path)
}
```

**fetch_remote_issues (new architecture — read global keychain, not per-project token_manager):**
```rust
// Pattern: load ProjectConfig → get provider + project fields → read global keychain → call provider API
// Mirrors existing fetch_remote_issues (lines 266–334) but uses KeychainStore::get_integration
// instead of app_state.token_manager.get_token(project_id, ...)
```

**Drop all per-provider `validate_and_store` handlers** (`save_github_credentials`, `save_gitlab_credentials`, etc.) — replaced by `save_integration` in integration_handlers.rs + `save_project_ticketing_config`.

---

### `src-tauri/src/models/integration.rs` (model, transform — NEW)

**Analog:** `src-tauri/src/models/ticketing.rs`

**Derive macro pattern** (ticketing.rs lines 8–13):
```rust
use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct SomeModel { ... }
```

**IntegrationStatus type (exported to TS via specta):**
```rust
use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct IntegrationStatus {
    pub provider: String,
    pub connected: bool,
    pub display_name: Option<String>,
    pub source: Option<CredentialSource>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
#[specta(export)]
pub enum CredentialSource {
    Manual,
    GhCli,
}
```

**IntegrationCredentials type (NOT exported to TS — stored as JSON blob in keychain, not serialized over IPC):**
```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IntegrationCredentials {
    pub token: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instance_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    pub connected_at: String,
    pub source: CredentialSource,
}
```

Note: no `#[specta(export)]` on `IntegrationCredentials` — it is only serialized to the keychain JSON blob, never returned over IPC raw. Tokens must never reach the frontend (RESEARCH.md security section).

---

### `src-tauri/src/models/project_config.rs` (model, CRUD — EXTEND)

**Analog:** self

**Current struct** (lines 9–16 — add `ticketing` field):
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

**Extended struct (append `ticketing` field — `#[serde(default)]` on the struct ensures backward compat):**
```rust
#[derive(Debug, Clone, Serialize, Deserialize, Type, Default)]
#[serde(default)]
#[specta(export)]
pub struct ProjectConfig {
    pub default_agent: Option<String>,
    pub default_model: Option<String>,
    pub ticketing: Option<ProjectTicketingConfig>,  // NEW — serde(default) = None
    pub updated_at: String,
}
```

**New ProjectTicketingConfig type (in same file, no separate module needed):**
```rust
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct ProjectTicketingConfig {
    pub provider: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repo: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub team_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_name: Option<String>,
}
```

**`load_from_project` / `save_to_project`** (lines 19–47) — unchanged, they already serialize/deserialize the full struct generically via serde_json.

---

### `src-tauri/src/lib.rs` (config — MODIFY)

**Analog:** self

**Current ticketing handler registration block** (lines 126–140 — replace with new handlers):
```rust
// Current (to be removed/replaced):
// Ticketing config
crate::ipc::get_ticketing_config,
crate::ipc::save_ticketing_config,
// Ticketing providers (Phase 53)
crate::ipc::save_github_credentials,
crate::ipc::save_gitlab_credentials,
crate::ipc::save_forgejo_credentials,
crate::ipc::delete_ticketing_credentials,
crate::ipc::fetch_remote_issues,
// Ticketing providers (Phase 54)
crate::ipc::save_linear_credentials,
crate::ipc::list_linear_teams,
crate::ipc::save_jira_cloud_credentials,
crate::ipc::save_azure_devops_credentials,
```

**New registrations to add (same position, after `crate::ipc::get_wsl_connections`):**
```rust
// Integration management (Phase 55)
crate::ipc::list_integrations,
crate::ipc::save_integration,
crate::ipc::delete_integration,
crate::ipc::test_integration,
// Project ticketing config (Phase 55)
crate::ipc::get_project_ticketing_config,
crate::ipc::save_project_ticketing_config,
crate::ipc::fetch_remote_issues,
```

**ipc/mod.rs — add new module declaration:**
```rust
// Add to ipc/mod.rs:
pub mod integration_handlers;
pub use integration_handlers::*;
```

---

### `src/services/integration.service.ts` (service, request-response — NEW)

**Analog:** `src/services/project.service.ts`

**Query key factory pattern** (project.service.ts lines 17–26):
```typescript
export const integrationQueryKeys = {
  base: ["integrations"] as const,
  list: () => [...integrationQueryKeys.base, "list"] as const,
  projectTicketing: (projectId: number) =>
    [...integrationQueryKeys.base, "ticketing", projectId] as const,
};
```

**useQuery hook pattern** (project.service.ts lines 31–37):
```typescript
export function useListIntegrations() {
  return useQuery({
    queryKey: integrationQueryKeys.list(),
    queryFn: () => api.listIntegrations(),
    staleTime: 30_000,
  });
}
```

**useMutation with invalidation pattern** (project.service.ts lines 126–139):
```typescript
export function useSaveIntegration() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ provider, token, instanceUrl, email }: {
      provider: string;
      token: string;
      instanceUrl?: string | null;
      email?: string | null;
    }) => api.saveIntegration(provider, token, instanceUrl ?? null, email ?? null),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: integrationQueryKeys.list() });
    },
    onError: createErrorToastHandler("Failed to save integration"),
  });
}
```

**Delete mutation pattern** (project.service.ts lines 108–121):
```typescript
export function useDeleteIntegration() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (provider: string) => api.deleteIntegration(provider),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: integrationQueryKeys.list() });
    },
    onError: createErrorToastHandler("Failed to disconnect integration"),
  });
}
```

**Project ticketing config hooks (same file, follow useProjectSettings pattern, project.service.ts lines 64–70):**
```typescript
export function useProjectTicketingConfig(projectId: number) {
  return useQuery({
    queryKey: integrationQueryKeys.projectTicketing(projectId),
    queryFn: () => api.getProjectTicketingConfig(projectId),
    staleTime: Infinity,
  });
}
```

**Imports header pattern** (project.service.ts lines 1–6):
```typescript
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/tauri-utils";
import { createErrorToastHandler } from "@/lib/error-utils";
import type { IntegrationStatus, ProjectTicketingConfig } from "@/types/bindings";
```

---

### `src/components/project-picker/IntegrationsTab.tsx` (component, request-response — NEW)

**Analog:** `src/components/project-picker/ConnectionList.tsx`

**Component structure and header pattern** (ConnectionList.tsx lines 59–100):
```tsx
export function IntegrationsTab() {
  // useListIntegrations() TanStack Query hook

  return (
    <>
      <div className="flex flex-col h-full">
        <div className="flex items-center gap-2 mb-4 pb-2 border-b border-border">
          {/* icon */}
          <h2 className="text-lg font-semibold">Integrations</h2>
        </div>
        <div className="flex-1 overflow-auto mb-4 px-1 py-1 custom-scrollbar">
          {/* 2-col provider grid (D-17) */}
        </div>
      </div>
      {/* IntegrationConnectDialog controlled by useState */}
    </>
  );
}
```

**Provider card item — connected vs not-connected states (D-17):**
```tsx
// Pattern mirrors SshConnectionItem (ConnectionList.tsx lines 12–57):
// - connected: green-tinted card + check icon + × button
// - not connected: normal card + + button (opens connect dialog)
// Key visual pattern from ConnectionList.tsx line 36:
<span className={`absolute -bottom-0.5 -right-0.5 w-1.5 h-1.5 rounded-full ring-1 ring-background ${
  connected ? "bg-emerald-500" : "bg-muted-foreground/40"
}`} />
```

**2-column grid layout (D-17):**
```tsx
<div className="grid grid-cols-2 gap-2">
  {integrations.map((integration) => (
    <ProviderCard key={integration.provider} integration={integration} />
  ))}
</div>
```

**Loading/empty state pattern** (ConnectionList.tsx lines 103–107):
```tsx
{isLoading ? (
  <div className="flex items-center justify-center py-12 text-muted-foreground">Loading...</div>
) : integrations.length === 0 ? (
  <p className="text-sm text-muted-foreground text-center py-8">No integrations available</p>
) : (
  <div className="grid grid-cols-2 gap-2">{ /* cards */ }</div>
)}
```

**gh CLI badge (D-18) — render only when source === "gh_cli":**
```tsx
{integration.source === "GhCli" && (
  <span className="text-xs text-muted-foreground bg-muted rounded px-1">gh cli</span>
)}
```

---

### `src/components/project-picker/IntegrationConnectDialog.tsx` (component, request-response — NEW)

**Analog:** `src/components/project-picker/CreateProjectDialog.tsx`

**Full dialog imports pattern** (CreateProjectDialog.tsx lines 1–18):
```tsx
import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { Label } from "@/ui/label";
import { Loader2 } from "lucide-react";
```

**Props + open/onOpenChange controlled pattern** (CreateProjectDialog.tsx lines 22–26):
```tsx
interface IntegrationConnectDialogProps {
  provider: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}
```

**Mutation call + error display pattern** (CreateProjectDialog.tsx lines 39–58):
```tsx
const { mutateAsync: saveIntegration, isPending } = useSaveIntegration();

const handleSubmit = async () => {
  setError(null);
  try {
    await saveIntegration({ provider, token, instanceUrl, email });
    // reset form and close
    onOpenChange(false);
  } catch (e) {
    setError(e instanceof Error ? e.message : String(e));
  }
};
```

**Error inline display** (CreateProjectDialog.tsx line 118):
```tsx
{error && <p className="text-sm text-destructive">{error}</p>}
```

**Submit button with spinner** (CreateProjectDialog.tsx lines 124–135):
```tsx
<Button onClick={handleSubmit} disabled={isPending || !token.trim()}>
  {isPending ? (
    <>
      <Loader2 className="size-4 animate-spin" />
      Connecting...
    </>
  ) : (
    "Connect"
  )}
</Button>
```

**Per-provider conditional fields:** Render provider-specific fields (e.g., `instance_url` for GitLab/Forgejo, `email` for Jira Cloud) based on the `provider` prop. Always render the token/API key field.

---

### `src/components/project-picker/ProjectPicker.tsx` (component — MODIFY)

**Analog:** self

**Current connections panel structure** (ProjectPicker.tsx lines 26–32 — wrap ConnectionList in Tabs):
```tsx
{/* Current (to be wrapped with Tabs): */}
<div
  className={`absolute inset-0 p-6 transition-transform duration-300 ease-in-out flex flex-col ${
    view === "projects" ? "-translate-x-full invisible" : "translate-x-0"
  }`}
>
  <ConnectionList />
</div>
```

**Tabs component API** (tabs.tsx lines 8–75 — base-ui/react Tabs, NOT radix):
```tsx
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/ui/tabs";

// Wrap ConnectionList replacement:
<div className={`absolute inset-0 p-6 transition-transform ... flex flex-col ${...}`}>
  <Tabs defaultValue="connections" className="flex flex-col h-full">
    <TabsList className="w-full mb-4">
      <TabsTrigger value="connections">Connections</TabsTrigger>
      <TabsTrigger value="integrations">Integrations</TabsTrigger>
    </TabsList>
    <TabsContent value="connections" className="flex-1 overflow-hidden">
      <ConnectionList />
    </TabsContent>
    <TabsContent value="integrations" className="flex-1 overflow-hidden">
      <IntegrationsTab />
    </TabsContent>
  </Tabs>
</div>
```

**Critical:** The slide transition mechanism (`absolute inset-0`, translate classes, `view === "projects"`) must be preserved unchanged. Tabs wrap only the ConnectionList replacement, inside the existing connections panel `<div>`.

Note: The tabs component uses `@base-ui/react/tabs` (not `@radix-ui/react-tabs`). The API differs: use `value` attribute instead of `defaultValue` for controlled mode; `data-active` attribute is set on active tab by base-ui. Import from `@/ui/tabs`.

---

### `src/components/common/SettingsPage.tsx` (component, CRUD — EXTEND)

**Analog:** self

**Card pattern** (SettingsPage.tsx lines 107–111 — add second card below Agent & Model):
```tsx
{/* Agent & Model card — existing, unchanged */}
<div className="bg-card border border-border rounded-lg p-4 space-y-4">
  <h3 className="text-base font-semibold text-foreground flex items-center gap-2">
    <Bot className="w-4 h-4 text-muted-foreground" />
    Agent &amp; Model
  </h3>
  {/* ... existing fields */}
</div>

{/* Ticketing card — NEW, same card container pattern */}
<div className="bg-card border border-border rounded-lg p-4 space-y-4">
  <h3 className="text-base font-semibold text-foreground flex items-center gap-2">
    {/* appropriate icon */}
    Ticketing
  </h3>
  {/* D-15: inline card picker — show only connected integrations as selectable cards */}
  {/* When none configured: show picker cards */}
  {/* When configured: show provider card with owner/repo detail + Change/Remove buttons */}
</div>
```

**Query + mutation wiring pattern** (SettingsPage.tsx lines 39–54):
```tsx
const projectTicketingQuery = useProjectTicketingConfig(projectId);
const saveTicketingMutation = useSaveProjectTicketingConfig();
const { data: integrations } = useListIntegrations();
```

**useEffect to reset form on data load** (SettingsPage.tsx lines 47–54):
```tsx
useEffect(() => {
  if (!projectTicketingQuery.data) return;
  // reset ticketing form state to loaded values
}, [projectTicketingQuery.data]);
```

**forwardRef / useImperativeHandle pattern** (SettingsPage.tsx lines 31–86) — the SettingsPage uses forwardRef exposing `save()` and `resetToDefaults()`. The Ticketing card's save logic must be wired into the same `handleSubmit` flow so the single "Save" button at the bottom of the form saves both cards.

---

## Shared Patterns

### Keychain CRUD (store / get / delete)
**Source:** `src-tauri/src/ticketing/keychain.rs`
**Apply to:** `keychain.rs` (modify), `integration_handlers.rs` (new)
```rust
// Three-outcome handling: Keychain success, FileFallback, Error
match entry.set_password(&json) {
    Ok(()) => Ok(KeychainOutcome::Keychain(())),
    Err(keyring::Error::NoStorageAccess(_)) | Err(keyring::Error::PlatformFailure(_)) => {
        Self::write_to_file(provider, token, app_data_dir)?;
        Ok(KeychainOutcome::FileFallback(()))
    }
    Err(e) => Err(format!("Failed to save token: {}", e)),
}
```

### IPC Handler Error Propagation
**Source:** `src-tauri/src/ipc/ssh_handlers.rs` (lines 21–22, 56–57)
**Apply to:** All Rust handler functions
```rust
// DB lock pattern:
let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
// Query not found:
.map_err(|_| format!("Project {} not found", project_id))?
// HTTP/network errors:
.map_err(|e| format!("Network error: {}", e))?
```

### IPC Handler Registration
**Source:** `src-tauri/src/lib.rs` (lines 24–141) + `src-tauri/src/ipc/mod.rs`
**Apply to:** `lib.rs` (new handler entries), `ipc/mod.rs` (new module line)
```rust
// In ipc/mod.rs — add:
pub mod integration_handlers;
pub use integration_handlers::*;

// In lib.rs — in the collect_commands! block:
crate::ipc::list_integrations,
crate::ipc::save_integration,
// etc.
```

### TanStack Query Hook Structure
**Source:** `src/services/project.service.ts` (lines 1–26, 64–70, 126–139)
**Apply to:** `src/services/integration.service.ts`
```typescript
// Query key factory → useQuery → useMutation with invalidation + createErrorToastHandler
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/tauri-utils";
import { createErrorToastHandler } from "@/lib/error-utils";
```

### Dialog with Inline Error + Spinner Button
**Source:** `src/components/project-picker/CreateProjectDialog.tsx` (lines 39–58, 118, 124–135)
**Apply to:** `IntegrationConnectDialog.tsx`, `IntegrationMissingDialog.tsx`
```tsx
// useState error, try/catch in submit, inline <p className="text-sm text-destructive">
// Loader2 spinner in button when isPending
```

### Stacked Card Layout (Settings Page)
**Source:** `src/components/common/SettingsPage.tsx` (lines 106–216)
**Apply to:** Ticketing card in SettingsPage.tsx
```tsx
<div className="bg-card border border-border rounded-lg p-4 space-y-4">
  <h3 className="text-base font-semibold text-foreground flex items-center gap-2">
    <IconComponent className="w-4 h-4 text-muted-foreground" />
    Card Title
  </h3>
  {/* fields */}
</div>
```

### Model Type Exports (Rust → TypeScript)
**Source:** `src-tauri/src/models/ticketing.rs` (lines 1–13)
**Apply to:** `src-tauri/src/models/integration.rs`, `src-tauri/src/models/project_config.rs`
```rust
use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct ExportedType { ... }
// Run pnpm tauri:gen after any change to exported types
```

---

## No Analog Found

All files have close analogs. No entries.

---

## Metadata

**Analog search scope:** `src-tauri/src/ipc/`, `src-tauri/src/ticketing/`, `src-tauri/src/models/`, `src/services/`, `src/components/project-picker/`, `src/components/common/`, `src/components/ui/`
**Files scanned:** 14 files read directly
**Pattern extraction date:** 2026-05-22
