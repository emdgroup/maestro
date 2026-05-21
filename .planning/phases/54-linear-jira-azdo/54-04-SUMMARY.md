---
phase: 54-linear-jira-azdo
plan: "04"
subsystem: ticketing-ipc
tags: [rust, ipc, tauri-specta, typescript-bindings, ticketing, linear, jira-cloud, azure-devops]
dependency_graph:
  requires: ["54-01", "54-02", "54-03"]
  provides: ["IPC handlers for Linear, Jira Cloud, Azure DevOps", "TypeScript bindings with LinearTeam"]
  affects: ["src-tauri/src/ipc/ticketing_handlers.rs", "src-tauri/src/lib.rs", "src/types/bindings.ts"]
tech_stack:
  added: []
  patterns:
    - "Scoped Mutex lock block before .await in IPC handlers (deadlock safety)"
    - "Exhaustive match on ProviderConfig enum — all 7 variants, no catch-all"
key_files:
  created: []
  modified:
    - src-tauri/src/ipc/ticketing_handlers.rs
    - src-tauri/src/lib.rs
    - src/types/bindings.ts
decisions:
  - "Jira Server save_* handler omitted (provider dropped per EOL scope change); Jiraserver match arm returns explicit not-supported error instead of _ catch-all"
  - "mod.rs already had pub mod linear; pub mod jira_cloud; pub mod azure_devops; from prior work — no change needed"
metrics:
  duration: "~8 minutes"
  completed: "2026-05-21T21:31:00Z"
  tasks_completed: 2
  files_modified: 3
---

# Phase 54 Plan 04: Ticketing IPC Wiring Summary

Wire all Phase 54 provider modules into the IPC layer: 4 new IPC commands (save_linear_credentials, list_linear_teams, save_jira_cloud_credentials, save_azure_devops_credentials), exhaustive fetch_remote_issues match with Jiraserver not-supported error, and regenerated TypeScript bindings with LinearTeam.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Wire modules and IPC handlers | fcf798d | ticketing_handlers.rs, lib.rs |
| 2 | Regenerate TypeScript bindings | 733b312 | src/types/bindings.ts |

## What Was Built

### Task 1: IPC Handler Wiring

Added 4 new `#[tauri::command]` functions to `ticketing_handlers.rs`:

- **`save_linear_credentials`** — scoped lock → `linear::validate_and_store`
- **`list_linear_teams`** — token_manager lookup → `linear::list_teams`
- **`save_jira_cloud_credentials`** — scoped lock → `jira_cloud::validate_and_store`
- **`save_azure_devops_credentials`** — scoped lock → `azure_devops::validate_and_store`

Replaced `_ => Err("Provider not yet supported in this phase")` catch-all in `fetch_remote_issues` with 4 explicit arms covering all remaining ProviderConfig variants:
- `Linear(cfg)` → `linear::fetch_issues`
- `Jiracloud(cfg)` → `jira_cloud::fetch_issues`
- `Jiraserver(_cfg)` → explicit "not supported" error (Jira Server dropped per EOL)
- `Azuredevops(cfg)` → `azure_devops::fetch_issues`

Registered all 4 commands in `lib.rs` `collect_commands!` macro under `// Ticketing providers (Phase 54)`.

### Task 2: TypeScript Bindings

Ran `pnpm tauri:gen` (cargo test generate_typescript_bindings). Generated types include:
- `LinearTeam` struct (id, name, key)
- All 4 new IPC command function signatures

## Verification

```
cargo check -p maestro  → 0 errors, 1 warning (pre-existing)
cargo test -p maestro   → 70 passed, 0 failed
pnpm tauri:gen          → test result: ok. 1 passed
grep LinearTeam bindings.ts → 1 hit
grep save_azure_devops_credentials bindings.ts → 1 hit
grep "Provider not yet supported" ticketing_handlers.rs → 0 hits
```

## Deviations from Plan

### Scope Adjustment (per objective scope change)

**1. [Scope Change - Jira Server dropped] No save_jira_server_credentials handler added**
- **Found during:** Pre-execution context review
- **Issue:** Plan 04 frontmatter specifies 5 IPC commands including `save_jira_server_credentials`, but objective scope change dropped Jira Server support per EOL
- **Fix:** Implemented 4 commands only; Jiraserver match arm returns explicit "not supported" error rather than a catch-all `_`
- **Files modified:** ticketing_handlers.rs
- **Commit:** fcf798d

**2. [No-op] mod.rs already had all needed module declarations**
- **Found during:** Task 1 file read
- **Issue:** mod.rs already declared `pub mod linear;`, `pub mod jira_cloud;`, `pub mod azure_devops;` from prior work in this phase
- **Fix:** No changes to mod.rs required

## Known Stubs

None — all IPC handlers delegate to fully-implemented provider modules from Plans 01-03.

## Threat Flags

None — threat model items T-54-11 and T-54-12 are fully mitigated:
- T-54-11: `list_linear_teams` uses `token_manager.get_token(project_id, ...)` — project-scoped via keyring key format
- T-54-12: `fetch_remote_issues` match is now exhaustive (all 7 ProviderConfig variants have explicit arms, no catch-all)
