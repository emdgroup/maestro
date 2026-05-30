# Plan: Fix provider clone UX (GitHub pre-fill + Bitbucket auth)

## Context

Two issues with the provider repo picker in the Clone Project dialog:
1. **GitHub**: Owner field starts empty even though `display_name` (GitHub username) is available from stored integration
2. **Bitbucket**: `list_bitbucket_repos` always hits `api.bitbucket.org` with Bearer token — fails 401 when user has Server/DC configured (token is for the server instance, not Cloud). Also for Server, should provide a project key dropdown instead of free-text workspace.

---

## Implementation

### Fix 1 — GitHub owner pre-fill

**`src/components/project-picker/ProviderRepoPicker.tsx`**

Pass `display_name` from the integration to `GitHubRepoForm`. The parent `ProviderRepoPicker` already calls `useListIntegrations()` and has access to the selected provider's status.

- Add `defaultOwner?: string` prop to `GitHubRepoForm`
- In parent, find the GitHub integration's `display_name` and pass it down
- Initialize `owner` state with `defaultOwner ?? ""`

### Fix 2 — Expose `instance_url` in IntegrationStatus

**`src-tauri/src/models/integration.rs`** — Add `instance_url: Option<String>` to `IntegrationStatus`

**`src-tauri/src/ipc/integration_handlers.rs`** — Populate from `creds.instance_url` in `list_integrations`

Frontend needs this to know Bitbucket mode (Cloud vs Server) for UI branching.

### Fix 3 — Fix `list_bitbucket_repos` auth branching

**`src-tauri/src/ipc/provider_lookup_handlers.rs`** — Rewrite `list_bitbucket_repos`:

- If `creds.instance_url` is `Some(base_url)` → **Server**:
  - URL: `{base_url}/rest/api/latest/projects/{project_key}/repos?limit=100`
  - Auth: `Bearer {creds.token}`
  - Parse Server response format (`values[].slug`, `values[].links.clone[]`)

- If `creds.instance_url` is `None` → **Cloud**:
  - URL: `https://api.bitbucket.org/2.0/repositories/{workspace}?pagelen=50&sort=-updated_on`
  - Auth: `Basic base64({creds.email}:{creds.token})`
  - Parse Cloud response format (existing logic)

### Fix 4 — Add `list_bitbucket_projects` command (Server only)

**`src-tauri/src/ipc/provider_lookup_handlers.rs`** — New command:

```rust
#[tauri::command]
#[specta::specta]
pub async fn list_bitbucket_projects(
    app_state: State<'_, Arc<AppState>>,
) -> Result<Vec<BitbucketProjectOption>, String>
```

- Hits `{instance_url}/rest/api/latest/projects?limit=100`
- Auth: `Bearer {creds.token}`
- Returns `Vec<BitbucketProjectOption>` with `key` and `name` fields
- Returns error if no `instance_url` (Cloud mode — not applicable)

Add `BitbucketProjectOption` model alongside existing `BitbucketRepoOption`.

Register in `lib.rs` `collect_commands![]`.

### Fix 5 — Frontend: Bitbucket form Cloud/Server branching

**`src/services/provider-lookup.service.ts`** — Add `useListBitbucketProjects` hook

**`src/components/project-picker/ProviderRepoPicker.tsx`** — Rework `BitbucketRepoForm`:

- Accept `instanceUrl?: string | null` prop (from integration status)
- If `instanceUrl` set (Server): show project dropdown (from `useListBitbucketProjects`) → then repo list
- If no `instanceUrl` (Cloud): keep existing free-text workspace → repo list

---

## Files

| File | Change |
|------|--------|
| `src-tauri/src/models/integration.rs` | Add `instance_url` to `IntegrationStatus` |
| `src-tauri/src/ipc/integration_handlers.rs` | Populate `instance_url` in `list_integrations` |
| `src-tauri/src/ipc/provider_lookup_handlers.rs` | Fix `list_bitbucket_repos` auth + add `list_bitbucket_projects` |
| `src-tauri/src/lib.rs` | Register `list_bitbucket_projects` in `collect_commands![]` |
| `src/types/bindings.ts` | Regenerated (new type + command) |
| `src/services/provider-lookup.service.ts` | Add `useListBitbucketProjects` hook |
| `src/components/project-picker/ProviderRepoPicker.tsx` | GitHub pre-fill + Bitbucket form rework |

## Verification

1. `cargo check` — compiles
2. `pnpm tauri:gen` — regenerate bindings
3. `pnpm build` — TypeScript compiles
4. `pnpm test` — tests pass
5. Manual: GitHub clone → owner pre-filled with username
6. Manual: Bitbucket Server clone → project dropdown loads, repos load after selection
