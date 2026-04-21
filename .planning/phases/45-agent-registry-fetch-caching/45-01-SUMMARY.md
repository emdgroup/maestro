---
phase: 45-agent-registry-fetch-caching
plan: "01"
subsystem: acp-registry
tags: [rust, registry, cache, specta, types]
dependency_graph:
  requires: []
  provides: [RegistryResponse, ResolvedLaunchCommand, RegistryCacheEntry, fetch_or_return_cached, resolve_distribution, AppState.agent_registry_cache]
  affects: [src-tauri/src/acp/registry.rs, src-tauri/src/acp/mod.rs, src-tauri/src/db/connection.rs]
tech_stack:
  added: [reqwest (json), specta::Type derive on registry structs]
  patterns: [stale-on-error cache fallback, lock-drop-before-await, compile-time platform key selection, npx->binary->uvx priority resolution]
key_files:
  created: []
  modified:
    - src-tauri/src/acp/registry.rs
    - src-tauri/src/acp/mod.rs
    - src-tauri/src/db/connection.rs
decisions:
  - "Lock-drop-before-await pattern: RegistryCacheEntry guard released before fetch_registry_from_cdn() to prevent holding tokio::sync::MutexGuard across .await point"
  - "RegistryCacheEntry not exported to TS (no Type derive) — Instant is not serializable; RegistryResponse is the IPC boundary type"
  - "current_binary_target_key() returns empty string on unknown platforms; resolve_distribution treats empty key as no match, falling through to uvx"
  - "test_resolve_binary_unknown_platform uses hardcoded 'plan9-mips64' key to verify the fallthrough regardless of actual platform"
metrics:
  duration: "0.073h"
  completed: "2026-04-21"
  tasks_completed: 1
  files_modified: 3
---

# Phase 45 Plan 01: Agent Registry Fetch/Cache/Resolve Logic Summary

Registry types extended with specta derives and optional CDN fields; CDN fetch with 5-min TTL in-memory cache, stale-on-error fallback, and npx->binary->uvx distribution priority resolver implemented with 7 passing unit tests.

## Tasks Completed

| # | Task | Commit | Files |
|---|------|--------|-------|
| 1 | Extend registry types, add fetch/cache/resolve logic | 98360ad | registry.rs, mod.rs, connection.rs |

## What Was Built

### Extended Types (`src-tauri/src/acp/registry.rs`)

All existing structs (`AcpRegistry`, `AgentInfo`, `AgentDistribution`, `NpxDistribution`, `BinaryTarget`, `UvxDistribution`) updated with `#[derive(... Type)]` and `#[specta(export)]`. All `Option<T>` fields annotated with `#[specta(optional)]`.

New optional fields added to distribution types:
- `NpxDistribution`: `args: Option<Vec<String>>`, `env: Option<HashMap<String, String>>`
- `BinaryTarget`: `args: Option<Vec<String>>`
- `UvxDistribution`: `args: Option<Vec<String>>`

New types added:
- `RegistryCacheEntry { registry: AcpRegistry, fetched_at: Instant }` — internal cache store (not TS-exported)
- `RegistryResponse { agents, cached, stale }` — IPC response with cache status
- `ResolvedLaunchCommand { cmd, args }` — ready-to-spawn command

### Cache Logic (`fetch_or_return_cached`)

- Checks cache under lock, drops guard before network I/O (no MutexGuard held across `.await`)
- Returns `cached=true, stale=false` if data is fresh (within 5 minutes) and `force_refresh=false`
- Fetches from CDN, stores to cache on success
- On CDN failure with stale cache: returns `cached=true, stale=true`
- On CDN failure with no cache: returns `Err`

### Distribution Resolver (`resolve_distribution`)

Priority: npx (preferred) -> binary (current platform key from `current_binary_target_key()`) -> uvx. Returns `None` when no compatible distribution exists.

### AppState Extension (`src-tauri/src/db/connection.rs`)

Added `agent_registry_cache: tokio::sync::Mutex<Option<RegistryCacheEntry>>` field, initialized to `None` in `AppState::new()`.

### Re-exports (`src-tauri/src/acp/mod.rs`)

Updated `pub use registry::` to include `RegistryResponse`, `ResolvedLaunchCommand`, `RegistryCacheEntry`, `fetch_or_return_cached`, `resolve_distribution`.

## Test Results

```
running 7 tests
test acp::registry::tests::test_resolve_no_compatible_distribution ... ok
test acp::registry::tests::test_resolve_binary_unknown_platform ... ok
test acp::registry::tests::test_resolve_npx_priority_over_binary ... ok
test acp::registry::tests::test_resolve_binary_distribution ... ok
test acp::registry::tests::test_resolve_uvx_distribution ... ok
test acp::registry::tests::test_resolve_npx_distribution ... ok
test acp::registry::tests::test_registry_deserialization ... ok

test result: ok. 7 passed; 0 failed
```

Full suite: 24/24 tests pass. `cargo check` clean.

## Deviations from Plan

None — plan executed exactly as written.

## Self-Check: PASSED

- `src-tauri/src/acp/registry.rs`: exists, contains `RegistryResponse`, `ResolvedLaunchCommand`, `RegistryCacheEntry`, `fetch_or_return_cached`, `resolve_distribution`, `REGISTRY_URL`, `current_binary_target_key`
- `src-tauri/src/db/connection.rs`: contains `agent_registry_cache` field and `tokio::sync::Mutex::new(None)` init
- `src-tauri/src/acp/mod.rs`: re-exports `RegistryResponse`, `ResolvedLaunchCommand`, `RegistryCacheEntry`
- Commit `98360ad` exists
- All 7 registry tests pass
- No `println!` or `eprintln!` in registry.rs
