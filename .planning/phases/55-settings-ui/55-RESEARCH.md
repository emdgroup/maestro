# Phase 55: Settings UI - Research

**Researched:** 2026-05-22
**Domain:** Tauri IPC + React UI (keychain integration refactor, settings UI, connection screen tabs)
**Confidence:** HIGH

## Summary

Phase 55 refactors Phase 54's project-scoped ticketing system into a two-level architecture: global integrations (credentials in OS keychain, keyed by provider) and project-level ticketing configuration (provider choice + project-specific fields stored in `.maestro/settings.json`). The UI adds a tabbed view to the pre-project connection screen (Connections / Integrations tabs) and a new "Ticketing" card to the project settings page.

The existing code provides strong foundational patterns: `KeychainStore` already handles keyring + file-fallback, `SettingsPage.tsx` demonstrates stacked card layout with react-hook-form, `ConnectionList.tsx` shows the pre-project card list pattern, and shadcn/ui `Tabs`, `Dialog`, `Select` components are all installed. The main work is: (1) rewrite keychain key format from project-scoped to provider-scoped, (2) rewrite IPC handlers from per-project credential CRUD to global integration CRUD + project config extension, (3) build two new UI components (IntegrationsTab, TicketingCard), (4) add D-19 cascade check to project opening flow.

**Primary recommendation:** Follow the SSH connections pattern exactly — global resource management via IPC handlers that operate without project context, with projects referencing integrations by provider name in their `.maestro/settings.json`.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- D-01: No SQLite table for integrations. All connection info stored as JSON blob in OS keyring per provider.
- D-02: Keyring key format: `maestro:integration:<provider>` (e.g. `maestro:integration:github`, `maestro:integration:jira_cloud`). JSON blob contains token + any provider-global metadata (instance_url, email, etc.).
- D-03: Discovery: UI calls a handler that probes all 7 known provider keys in keyring, returns which are connected (no DB scan needed).
- D-04: Project-specific ticketing config stored in `.maestro/settings.json` (extends existing `ProjectConfig` struct). Contains: which provider to use + project-specific fields only.
- D-05: Phase 54's per-project handlers will be rewritten to this new split model.
- D-06: GitHub — Global: PAT. Project: owner, repo.
- D-07: GitLab — Global: instance_url, PAT. Project: project_path (or project_id).
- D-08: Forgejo — Global: instance_url, PAT. Project: owner, repo.
- D-09: Linear — Global: API key. Project: team_id.
- D-10: Jira Cloud — Global: site_url, email, API token. Project: project_key.
- D-11: Jira Server — DROPPED (removed in Phase 54, Atlassian EOL).
- D-12: Azure DevOps — Global: org_url, PAT. Project: project name.
- D-13: Project settings page uses stacked cards layout. New "Ticketing" card below "Agent & Model" card.
- D-14: Integrations management lives in a separate location (global), NOT in project settings.
- D-15: Inline card picker + inline fields for project ticketing config.
- D-16: Tabbed view on pre-project connection screen (Connections/Integrations tabs).
- D-17: 2-column grid showing all 7 providers with +/x buttons.
- D-18: GitHub gh CLI auto-detect on Integrations tab load.
- D-19: Interrupt project opening if integration is missing/invalid.

### Claude's Discretion
- Schema migration approach (destructive v16->v17 is acceptable per project conventions)
- Internal code organization (new files vs extending existing)
- Test connection implementation details

### Deferred Ideas (OUT OF SCOPE)
- Code repository integrations (same global pattern, different config) -- future phase
- OAuth flows -- explicitly dropped in Phase 53, PAT only
- Import modal + change detection -- Phase 56
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| SETT-01 | Project settings has Ticketing section with provider picker | D-13 + D-15: Stacked card layout with inline picker from connected integrations. SettingsPage.tsx pattern for card + react-hook-form. |
| SETT-02 | Connect button triggers flow, shows connected status | D-16/D-17: Integrations tab on connection screen. Dialog with provider-specific fields. Connected state shows green card + checkmark. |
| SETT-03 | Disconnect button clears token from keychain and config | D-17: x button on connected card. D-19: cascade check on project open. Handler calls KeychainStore::delete with new key format. |
</phase_requirements>

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Credential storage (tokens) | Rust backend (keyring) | -- | Secrets must never touch frontend; OS keychain accessed via Rust `keyring` crate |
| Integration discovery (list connected) | Rust backend | Frontend (cache) | Probes keyring entries; result cached via TanStack Query |
| Project ticketing config (CRUD) | Rust backend | Frontend (form state) | Serializes to `.maestro/settings.json` via Rust handlers |
| Integrations tab UI | Frontend (React) | -- | Stateless presentation; data from TanStack Query hooks |
| Ticketing card UI (project settings) | Frontend (React) | -- | Form state via react-hook-form, mutations via TanStack Query |
| Integration validation (test connection) | Rust backend | -- | Makes HTTP requests to provider APIs for credential validation |
| Cascade check (D-19) | Rust backend | Frontend (modal) | Backend checks validity on project open; frontend shows prompt |

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| keyring | 3.6.3 | OS keychain CRUD | Already installed, features configured for all platforms [VERIFIED: Cargo.toml] |
| aes-gcm | 0.10 | File-fallback encryption | Already in use for file fallback when keyring unavailable [VERIFIED: Cargo.toml] |
| react-hook-form | ^7.76.0 | Form state management | Already used in SettingsPage.tsx [VERIFIED: package.json] |
| @tanstack/react-query | (installed) | Server state + mutations | Project-wide pattern for all IPC [VERIFIED: project.service.ts] |
| shadcn/ui (Tabs, Dialog, Select) | (installed) | UI primitives | All three components already present in src/components/ui/ [VERIFIED: Glob] |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| tauri-specta | (installed) | TypeScript binding generation | After modifying any Rust #[tauri::command] signatures |
| specta + ts-rs | (installed) | Rust -> TS type export | After modifying any Rust models with #[specta(export)] |
| serde_json | (installed) | JSON blob serialization for keyring | Serialize IntegrationCredentials to JSON string for keyring storage |
| which | 8.0.2 | gh CLI detection | Used in github.rs for `try_gh_cli_token()` [VERIFIED: Cargo.toml] |
| lucide-react | (installed) | Icons | Provider icons, +/x buttons, check marks |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Keyring JSON blob (D-01) | SQLite table for integrations | SQLite is simpler to query but credentials in DB file are less secure than OS keychain. Decision D-01 locks keyring-only. |
| Separate `ticketing.json` (Phase 54) | Extend `settings.json` (D-04) | Single config file reduces complexity; avoids orphaned config files. D-04 locks this. |

**Installation:** No new dependencies needed. All required packages are already installed. [VERIFIED: Cargo.toml, package.json]

## Architecture Patterns

### System Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ FRONTEND (React)                                                             │
│                                                                              │
│  ProjectPicker (pre-project)           SettingsPage (in-project)             │
│  ┌────────────────────────┐            ┌──────────────────────────┐         │
│  │ Tabs                   │            │ Stacked Cards             │         │
│  │ ├─ Connections (exist) │            │ ├─ Agent & Model (exist) │         │
│  │ └─ Integrations (NEW)  │            │ └─ Ticketing (NEW)       │         │
│  │    ├─ 2-col grid       │            │    ├─ Provider picker    │         │
│  │    ├─ + dialog         │            │    └─ Project fields     │         │
│  │    └─ × disconnect     │            └──────────────────────────┘         │
│  └────────────────────────┘                                                  │
│                                                                              │
│  TanStack Query hooks ──────────────── api.* (Proxy) ──────────────────────│
└──────────────────────────────────────────────────────────────────────────────┘
                              │ invoke()
                              ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│ RUST BACKEND (Tauri)                                                         │
│                                                                              │
│  ipc/integration_handlers.rs (NEW)     ipc/ticketing_handlers.rs (REWRITE)  │
│  ├─ list_integrations()                ├─ get_project_ticketing_config()     │
│  ├─ save_integration(provider, creds)  ├─ save_project_ticketing_config()   │
│  ├─ delete_integration(provider)       ├─ fetch_remote_issues(project_id)   │
│  └─ test_integration(provider)         └─ validate_project_integration()    │
│          │                                        │                          │
│          ▼                                        ▼                          │
│  ticketing/keychain.rs (MODIFY)        models/project_config.rs (EXTEND)    │
│  Key: maestro:integration:<provider>   ProjectConfig { ticketing: Option<> } │
│  Value: JSON { token, metadata... }    .maestro/settings.json                │
│          │                                                                   │
│          ▼                                                                   │
│  OS Keychain (macOS Keychain / Windows Credential Manager / Linux Secret)    │
│  OR: Encrypted file fallback (~/.local/share/maestro/tokens/<provider>.enc)  │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Data Flow: fetch_remote_issues (NEW architecture)

```
1. Frontend calls api.fetchRemoteIssues(projectId)
2. Rust handler reads project path from DB
3. Loads ProjectConfig from .maestro/settings.json
4. Extracts ticketing.provider (e.g., "github") and project fields (owner, repo)
5. Reads global keyring: Entry::new("maestro.ticketing", "maestro:integration:github")
6. Deserializes JSON blob → gets token
7. Calls provider-specific fetch_issues(token, project_fields...)
8. Returns Vec<RemoteIssue>
```

### Recommended Project Structure

```
src-tauri/src/
├── ipc/
│   ├── integration_handlers.rs  # NEW: global integration CRUD
│   └── ticketing_handlers.rs    # REWRITTEN: project ticketing config + fetch
├── ticketing/
│   ├── keychain.rs              # MODIFIED: new key format, provider-keyed
│   ├── token_manager.rs         # MODIFIED: provider-keyed instead of project_id-keyed
│   ├── github.rs                # MODIFIED: remove validate_and_store coupling
│   ├── gitlab.rs                # MODIFIED: same
│   ├── forgejo.rs               # MODIFIED: same
│   ├── linear.rs                # MODIFIED: same
│   ├── jira_cloud.rs            # MODIFIED: same
│   └── azure_devops.rs          # MODIFIED: same
├── models/
│   ├── project_config.rs        # EXTENDED: add ticketing field
│   ├── ticketing.rs             # MODIFIED: new IntegrationCredentials type
│   └── integration.rs           # NEW: IntegrationStatus, ProviderType enum

src/
├── services/
│   └── ticketing.service.ts     # NEW: TanStack Query hooks for integrations + project config
├── components/
│   ├── project-picker/
│   │   └── IntegrationsTab.tsx  # NEW: 2-column grid with provider cards
│   └── common/
│       ├── SettingsPage.tsx      # EXTENDED: add Ticketing card
│       └── IntegrationConnectDialog.tsx  # NEW: per-provider credential dialog
```

### Pattern 1: Global Integration CRUD (Keyring-backed)

**What:** Integration credentials stored as JSON blob in OS keyring, one entry per provider.
**When to use:** For all integration management operations (list, save, delete, test).

```rust
// Source: existing keychain.rs pattern + D-02 key format
const SERVICE: &str = "maestro.ticketing";

fn integration_key(provider: &str) -> String {
    format!("maestro:integration:{}", provider)
}

/// Stored as JSON blob in keyring value
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IntegrationCredentials {
    pub token: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instance_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    pub connected_at: String,
    pub source: CredentialSource, // "manual" | "gh_cli"
}

pub fn save_integration(provider: &str, creds: &IntegrationCredentials, app_data_dir: &Path) -> Result<KeychainOutcome<()>, String> {
    let json = serde_json::to_string(creds).map_err(|e| format!("Serialization: {}", e))?;
    let entry = Entry::new(SERVICE, &integration_key(provider)).map_err(|e| format!("Keyring: {}", e))?;
    // ... same fallback pattern as existing KeychainStore::store_token
}
```

### Pattern 2: Integration Discovery (D-03)

**What:** Probe all 7 known provider keys in keyring to build connected/disconnected status list.
**When to use:** On Integrations tab mount; returns without needing DB.

```rust
// Source: D-03 requirement
const KNOWN_PROVIDERS: &[&str] = &[
    "github", "gitlab", "forgejo", "linear", "jira_cloud", "azuredevops"
];

#[tauri::command]
#[specta::specta]
pub async fn list_integrations(
    app_state: State<'_, Arc<AppState>>,
) -> Result<Vec<IntegrationStatus>, String> {
    let mut results = Vec::new();
    for provider in KNOWN_PROVIDERS {
        let entry = Entry::new(SERVICE, &integration_key(provider));
        let status = match entry {
            Ok(e) => match e.get_password() {
                Ok(json) => {
                    let creds: IntegrationCredentials = serde_json::from_str(&json)
                        .map_err(|_| "corrupt".to_string())?;
                    IntegrationStatus { provider: provider.to_string(), connected: true, display_name: creds.display_name, source: Some(creds.source) }
                }
                Err(keyring::Error::NoEntry) => IntegrationStatus { provider: provider.to_string(), connected: false, display_name: None, source: None },
                Err(_) => // file fallback probe...
            },
            Err(_) => IntegrationStatus { provider: provider.to_string(), connected: false, display_name: None, source: None },
        };
        results.push(status);
    }
    Ok(results)
}
```

### Pattern 3: Extended ProjectConfig (D-04)

**What:** `ProjectConfig` struct extended with optional ticketing fields.
**When to use:** For project-level ticketing configuration.

```rust
// Source: models/project_config.rs + D-04
#[derive(Debug, Clone, Serialize, Deserialize, Type, Default)]
#[serde(default)]
#[specta(export)]
pub struct ProjectConfig {
    pub default_agent: Option<String>,
    pub default_model: Option<String>,
    pub ticketing: Option<ProjectTicketingConfig>,  // NEW
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct ProjectTicketingConfig {
    pub provider: String,  // e.g., "github", "linear"
    // Project-specific fields (only the subset relevant to selected provider)
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

### Pattern 4: Tabbed Connection Screen (D-16)

**What:** Add Tabs component to ProjectPicker wrapping ConnectionList + new IntegrationsTab.
**When to use:** Modifying the pre-project connection screen.

```tsx
// Source: existing ProjectPicker.tsx + shadcn Tabs + D-16
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/ui/tabs";

// Inside the existing card container:
<Tabs defaultValue="connections" className="flex flex-col h-full">
  <TabsList className="grid w-full grid-cols-2">
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
```

### Anti-Patterns to Avoid
- **Storing credentials in SQLite:** Violates D-01. Credentials belong in OS keychain only.
- **Project-scoped keyring keys:** Phase 54 used `maestro:{project_id}:ticketing`. Phase 55 uses `maestro:integration:{provider}` (global).
- **Calling invoke() directly from components:** Use TanStack Query hooks via service layer.
- **Multiple config files:** D-04 says extend `settings.json`, not create separate `ticketing.json`.
- **Mixing global and project state:** Integration credentials are global; project config only stores which provider + project-specific fields.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Keychain access | Custom FFI to OS APIs | `keyring 3.6.3` crate | Handles macOS/Windows/Linux differences, credential manager nuances |
| Encrypted file fallback | Custom encryption | Existing `KeychainStore` file fallback (aes-gcm) | Already battle-tested with nonce + key derivation |
| Form state management | Manual useState per field | react-hook-form + Controller | Validation, dirty tracking, submit handling already solved |
| Server state caching | Manual fetch/cache logic | TanStack Query | Automatic invalidation, deduplication, stale-while-revalidate |
| UI component primitives | Custom tabs/dialogs | shadcn/ui Tabs + Dialog | Already installed, themed, accessible |
| TypeScript type generation | Manual type definitions | `pnpm tauri:gen` (ts-rs + specta) | Single source of truth from Rust types |

**Key insight:** The codebase already has every building block needed. This phase is wiring existing patterns in a new configuration, not introducing new libraries.

## Common Pitfalls

### Pitfall 1: Stale Phase 54 keyring entries after migration
**What goes wrong:** Old `maestro:{project_id}:ticketing` entries remain in keyring after Phase 55 deploys, consuming space and causing confusion.
**Why it happens:** Keyring entries are global OS state; schema migration only affects SQLite.
**How to avoid:** Add a one-time cleanup that iterates known project IDs and deletes old-format entries. Or accept they become orphaned (acceptable for dev tool).
**Warning signs:** Unit tests pass but manual testing shows duplicate credentials.

### Pitfall 2: File fallback key format mismatch
**What goes wrong:** File fallback uses project_id-based filenames (`{id}.enc`). Changing to provider-based keys means new filenames (`github.enc`).
**Why it happens:** KeychainStore::token_file_path currently uses project_id.
**How to avoid:** Update file_path to use provider name. Old `.enc` files become orphaned (acceptable).
**Warning signs:** File fallback reads return None when they should find a token.

### Pitfall 3: gh CLI token freshness
**What goes wrong:** GitHub's gh CLI integration (D-18) auto-detects on tab load. Token may expire, but integration shows as "connected".
**Why it happens:** gh CLI tokens rotate; the probe is a point-in-time check.
**How to avoid:** For gh CLI source, always re-probe on `list_integrations` (never cache the token; always call `gh auth token` fresh). Store source=`"gh_cli"` to signal this behavior.
**Warning signs:** GitHub shows connected but fetch_remote_issues returns 401.

### Pitfall 4: Race between integration deletion and active project
**What goes wrong:** User disconnects GitHub integration while a project using it is open. Next `fetch_remote_issues` fails with unclear error.
**Why it happens:** D-19 only checks on project open, not during runtime.
**How to avoid:** `fetch_remote_issues` should return a specific "integration_missing" error code that the frontend can handle gracefully (show "Reconnect" prompt rather than generic error).
**Warning signs:** Cryptic "No stored credentials found" error in UI.

### Pitfall 5: ProjectConfig backward compatibility
**What goes wrong:** Adding `ticketing` field to `ProjectConfig` breaks deserialization of existing `settings.json` files that don't have this field.
**Why it happens:** Strict JSON deserialization fails on unknown/missing fields.
**How to avoid:** Already safe -- `#[serde(default)]` on `ProjectConfig` means missing fields deserialize to None/default. Verify with a test.
**Warning signs:** Project settings load fails with "missing field ticketing" error.

### Pitfall 6: Tabbed view disrupts existing ConnectionList flow
**What goes wrong:** ConnectionList currently occupies the full card. Adding tabs changes the height/overflow behavior and breaks the slide transition to projects view.
**Why it happens:** The `ProjectPicker.tsx` uses `absolute inset-0` positioning with translate transitions between connections and projects views.
**How to avoid:** The Tabs component must wrap only the connections-view panel content, not replace the entire transition mechanism. OR restructure to keep the same slide transition but with tabs inside the connections panel.
**Warning signs:** Visual glitch when sliding from connections to projects, or tabs appearing in the projects view.

## Code Examples

### Verified: Existing SettingsPage card pattern

```tsx
// Source: src/components/common/SettingsPage.tsx lines 107-111
<div className="bg-card border border-border rounded-lg p-4 space-y-4">
  <h3 className="text-base font-semibold text-foreground flex items-center gap-2">
    <Bot className="w-4 h-4 text-muted-foreground" />
    Agent &amp; Model
  </h3>
  {/* Form fields */}
</div>
```

### Verified: IPC handler registration in lib.rs

```rust
// Source: src-tauri/src/lib.rs lines 127-139
// Ticketing config
crate::ipc::get_ticketing_config,
crate::ipc::save_ticketing_config,
// Ticketing providers (Phase 53)
crate::ipc::save_github_credentials,
// ... etc
// New handlers must be added here after crate::ipc::save_azure_devops_credentials
```

### Verified: TanStack Query hook pattern for mutations

```typescript
// Source: src/services/project.service.ts useUpdateProjectSettings pattern
export function useUpdateProjectSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, config }: { projectId: number; config: ProjectConfigRequest }) =>
      api.updateProjectSettings(projectId, config),
    onSuccess: (_data, { projectId }) => {
      void queryClient.invalidateQueries({
        queryKey: projectQueryKeys.settingsDetail(projectId),
      });
    },
    onError: createErrorToastHandler("Failed to update project settings"),
  });
}
```

### Verified: Dialog usage pattern

```tsx
// Source: src/components/project-picker/CreateProjectDialog.tsx
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/ui/dialog";
// open/onOpenChange controlled externally
```

### Verified: Keyring Entry::new pattern

```rust
// Source: src-tauri/src/ticketing/keychain.rs
const SERVICE: &str = "maestro.ticketing";
let entry = Entry::new(SERVICE, &username(project_id))  // Changes to: &integration_key(provider)
    .map_err(|e| format!("Keyring error: {}", e))?;
```

## State of the Art

| Old Approach (Phase 54) | New Approach (Phase 55) | Impact |
|--------------------------|-------------------------|--------|
| `maestro:{project_id}:ticketing` keyring key | `maestro:integration:{provider}` key | One token per provider, shared across all projects |
| `TicketingConfig` in `.maestro/ticketing.json` | `ProjectConfig.ticketing` in `.maestro/settings.json` | Single config file per project |
| `save_github_credentials(project_id, ...)` | `save_integration("github", creds)` + `save_project_ticketing_config(project_id, ...)` | Two-step: connect integration globally, then configure per-project |
| `TokenManager` keyed by project_id | Integration credentials keyed by provider string | Simpler: 7 possible keys vs unlimited project_ids |
| No integration management UI | Integrations tab on connection screen | Global management before project selection |

**Deprecated/outdated:**
- `TicketingConfig` struct (replaced by `ProjectConfig.ticketing` field)
- `ticketing.json` file (replaced by extending `settings.json`)
- Per-project credential save handlers (replaced by global integration save)
- `TokenManager` project_id-based cache (replaced by provider-based lookup)

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Schema migration to v17 is acceptable (destructive) | Architecture Patterns | LOW - project conventions confirm destructive migration is fine, but schema changes may not actually be needed since D-01 says no SQLite table for integrations |
| A2 | `ProjectConfig` with `#[serde(default)]` handles missing `ticketing` field gracefully | Pitfalls | LOW - serde default behavior is well-documented, but worth a unit test |
| A3 | The existing `validate_and_store` functions in provider modules can be split into `validate_credentials` (no storage) + separate storage | Architecture | LOW - functions are straightforward to refactor |

## Open Questions (RESOLVED)

1. **Schema migration: Is v16->v17 actually needed?**
   - What we know: D-01 says no SQLite table for integrations. The existing schema has no ticketing tables.
   - What's unclear: Do we need any schema change at all? The only change is to `ProjectConfig` (file-based) and keyring (OS-level). The schema version bump may be unnecessary.
   - Recommendation: Skip schema migration unless a DB table change is identified during planning. If needed later, bump to v17.
   - **RESOLVED: No schema migration needed.** D-01 uses keyring only; `ProjectConfig` extension uses `#[serde(default)]` (file-based, no DB). Plans do not bump schema version.

2. **TokenManager refactor scope**
   - What we know: `TokenManager` currently caches tokens by `project_id` and handles concurrent refresh via per-project Mutex locks.
   - What's unclear: Should `TokenManager` be rewritten to cache by provider? Or should it be bypassed entirely since integrations are global (simpler: just read keyring directly each time)?
   - Recommendation: For global integrations, direct keyring reads are sufficient (no caching needed -- tokens don't expire for PAT-based providers). `TokenManager` can be simplified or removed. For `fetch_remote_issues`, read keyring -> get token -> call API. No cache layer needed.
   - **RESOLVED: TokenManager bypassed entirely.** Plan 01 rewrites `fetch_remote_issues` to read keyring directly per call. No caching layer needed for PAT-based tokens.

3. **Cleanup of old Phase 54 keyring entries**
   - What we know: Existing dev environments may have `maestro:{id}:ticketing` entries.
   - What's unclear: Should Phase 55 actively clean these up, or leave them orphaned?
   - Recommendation: Leave orphaned (dev tool, no production data). Document in code comment.
   - **RESOLVED: Leave orphaned.** Dev tool, no production data at risk. Code comment added to document the old format.

4. **D-19 implementation timing**
   - What we know: Interrupt project opening if integration missing/invalid.
   - What's unclear: Does the check happen in `open_project` handler (Rust-side), or in the frontend after `open_project` returns (before rendering main UI)?
   - Recommendation: Frontend-side check. After `open_project` succeeds, frontend reads project config, checks if ticketing is configured, if so probes the integration status. If missing, shows modal before loading main UI. This avoids complicating the Rust `open_project` handler.
   - **RESOLVED: Frontend-side check.** Plan 03 implements the cascade check in MainLayout using `useListIntegrations` + `useProjectTicketingConfig` hooks, showing `IntegrationMissingDialog` as a blocking modal overlay.

## Environment Availability

Step 2.6: SKIPPED (no external dependencies identified). All tools are already installed in the project: keyring crate, shadcn/ui components, react-hook-form, TanStack Query, tauri-specta. The `gh` CLI availability is runtime-detected (D-18) and gracefully degrades.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Rust unit tests (cargo test) + Vitest (frontend) |
| Config file | `src-tauri/Cargo.toml` (Rust) / `vite.config.ts` (Vitest) |
| Quick run command | `cargo test -p maestro -- ticketing` |
| Full suite command | `cargo test --workspace && pnpm test` |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| SETT-01 | Project settings ticketing card renders and saves config | unit (Vitest) | `pnpm test SettingsPage` | Needs update |
| SETT-02 | Connect integration stores credentials in keyring | unit (Rust) | `cargo test -p maestro -- integration` | Wave 0 |
| SETT-03 | Disconnect clears keyring entry and removes from discovery | unit (Rust) | `cargo test -p maestro -- integration` | Wave 0 |

### Sampling Rate
- **Per task commit:** `cargo test -p maestro && pnpm test --run`
- **Per wave merge:** `cargo test --workspace && pnpm test --run`
- **Phase gate:** Full suite green before `/gsd-verify-work`

### Wave 0 Gaps
- [ ] `src-tauri/src/ticketing/keychain.rs` -- update tests for new provider-keyed format
- [ ] New tests for `list_integrations`, `save_integration`, `delete_integration` handlers
- [ ] Vitest test for IntegrationsTab component (connected/disconnected states)
- [ ] Vitest test for TicketingCard in SettingsPage (picker + project fields)

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | Yes | OS keychain for credential storage (keyring crate); never in SQLite/localStorage |
| V3 Session Management | No | N/A (stateless PAT tokens, no session concept) |
| V4 Access Control | No | N/A (single-user desktop app) |
| V5 Input Validation | Yes | Validate provider-specific fields (URLs, project keys) before storing |
| V6 Cryptography | Yes | AES-256-GCM file fallback (existing); never hand-roll; keyring crate handles OS-level crypto |

### Known Threat Patterns for Tauri + Keychain

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Token exposure via IPC | Information Disclosure | Never return raw tokens to frontend; only return connection status |
| Malicious provider URL (SSRF) | Tampering | Validate URLs against known provider domains before HTTP requests |
| Keychain access from malicious process | Information Disclosure | OS-level protection (macOS Keychain access control, Windows Credential Guard) |
| File fallback key weakness | Information Disclosure | AES-256-GCM with machine-UID derived key (existing pattern) |
| gh CLI token interception | Information Disclosure | Token only used in-process, never exposed to frontend |

## Sources

### Primary (HIGH confidence)
- Codebase inspection: `src-tauri/src/ticketing/keychain.rs` -- existing keychain pattern with file fallback
- Codebase inspection: `src-tauri/src/ipc/ticketing_handlers.rs` -- current handler signatures (to be rewritten)
- Codebase inspection: `src-tauri/src/models/project_config.rs` -- ProjectConfig struct and persistence
- Codebase inspection: `src-tauri/src/ipc/ssh_handlers.rs` -- global resource CRUD pattern model
- Codebase inspection: `src/components/common/SettingsPage.tsx` -- stacked card + react-hook-form pattern
- Codebase inspection: `src/components/project-picker/ProjectPicker.tsx` -- connection screen structure
- Codebase inspection: `src-tauri/src/lib.rs` -- IPC command registration pattern
- Codebase inspection: `Cargo.toml` -- keyring 3.6.3, aes-gcm 0.10, which 8.0.2 versions confirmed

### Secondary (MEDIUM confidence)
- `keyring` crate API: `Entry::new(service, username)` pattern observed in existing code [VERIFIED: keychain.rs]
- shadcn/ui Tabs component available [VERIFIED: Glob found `src/components/ui/tabs.tsx`]
- react-hook-form ^7.76.0 [VERIFIED: package.json]

### Tertiary (LOW confidence)
- None. All claims verified against codebase.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - all dependencies already installed and in use
- Architecture: HIGH - clear precedent patterns (SSH handlers, SettingsPage, KeychainStore)
- Pitfalls: HIGH - identified from direct code analysis of existing implementation

**Research date:** 2026-05-22
**Valid until:** 2026-06-22 (stable; patterns unlikely to change)
