# Fix: Duplicate ListAgents/DetectInstalledAgents during SSH preflight

## Context

During SSH connection, the backend receives `ListAgents` and `DetectInstalledAgents` messages **twice** because two independent code paths race to call `fetch_and_filter_agents` for the same connection:

1. **Path A** — `finalize_ssh_connection` (ssh_handlers.rs:43-44) spawns `tokio::spawn(prefetch_agent_discovery(...))` as fire-and-forget background task immediately after SSH auth succeeds.
2. **Path B** — Frontend `onConnectionSuccess` callback fires `handleConnectionClick` → `startPreflight` → `preflight_connection` IPC → `fetch_and_filter_agents` (acp_handlers.rs:771).

Both paths execute near-simultaneously. The `prefetch_agent_discovery` cache guard (line 904-910) only prevents work if the cache is already populated — but in a race, both proceed before either populates it.

## Fix

**Remove the background `prefetch_agent_discovery` spawn from `finalize_ssh_connection`.**

Every SSH connection success path in the frontend leads to `handleConnectionClick` → `startPreflight` → `preflight_connection`, which already does the same work (plus tool checks). The background prefetch is always redundant in current architecture.

## Changes

**File: `src-tauri/src/ipc/ssh_handlers.rs`**

Remove lines 40-45:
```rust
// Fire-and-forget: check maestro-server + agent availability in background.
// Results are cached in AppState so the New Session dialog reads them instantly.
let state_clone = Arc::clone(app_state);
tokio::spawn(async move {
    super::acp_handlers::prefetch_agent_discovery(state_clone, crate::acp::ConnectionKey::Ssh { id: connection_id }, None).await;
});
```

## Verification

1. `cargo check` in `src-tauri/` — ensure no compile errors
2. `cargo test` in `src-tauri/` — ensure no broken tests
3. Manual: connect to SSH host, observe maestro-server only receives 1x ListAgents + 1x DetectInstalledAgents (can verify via debug logging or message tracing)
4. Confirm preflight still works correctly (agents discovered, tools checked)
