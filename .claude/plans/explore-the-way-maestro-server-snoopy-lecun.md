# Fix: Remote First Spawn 6s Delay for Models/Modes

## Context

Remote project first session shows 6s delay for mode/model dropdowns despite waiting 30s+ after project open. Local is instant. Second remote session is instant. This means `agent_cache` is empty at first spawn time — pre-warm fails silently.

## How It Works (When Working)

1. Project opens → `prime_project_server` fires (fire-and-forget)
2. Pre-warm: spawn shared server → PreInitialize agent → `agent_cache` populated
3. User spawns session → `spawn_acp_session` checks `agent_cache` → emits `acp://session-models` immediately
4. Frontend's `useAcpSessionLifecycle` gets models via `api.getAcpModels()` → instant dropdowns

When cache is empty (pre-warm failed), step 3 has nothing to emit. Frontend waits for SpawnOk (~6s for remote agent startup).

## Root Cause

**`prime_project_server` remote branch runs `prefetch_agent_discovery` which spawns a one-shot maestro-server just to list agents. This is unnecessary for pre-warm and adds 5-15s+ of latency, potentially causing the total chain to exceed the time the user waits.**

The one-shot maestro-server runs `load_registry()` on startup which calls `fetch_from_cdn()` — a **blocking HTTP request with no timeout** (`ureq::get` without `.timeout()`). If the remote machine's CDN cache is stale (>24h) and CDN is slow/unreachable, this can block for 30-120s. The one-shot RPC has a 30s timeout → times out → error propagates → pre-warm aborts.

Even without CDN issues, the one-shot adds unnecessary SSH overhead (channel open, process spawn, handshake, ListAgents response, kill). Meanwhile the local pre-warm path skips all of this — no discovery needed.

Remote pre-warm chain (current):
1. `prefetch_agent_discovery` — ensure_remote_server (2 SSH cmds) + one-shot maestro-server (CDN + ListAgents) = **5-30s**
2. Get `maestro_path` from cache
3. `spawn_remote_project_server` — SSH channel + handshake = 2-5s
4. SSH cat settings.json = 1-2s
5. `pre_initialize_via_remote_project_server` — agent spawn + ACP init + NewSession = 5-15s
Total: **13-52s** (vs local: 3-10s)

## Fix 1 (PRIMARY): Eliminate one-shot in `prime_project_server`

Replace `prefetch_agent_discovery` call with a cache check + direct `ensure_remote_server`. We only need the maestro-server path, NOT the agent list.

**File: `src-tauri/src/ipc/project_handlers.rs` (lines 604-615)**

Before:
```rust
crate::ipc::acp_handlers::prefetch_agent_discovery(Arc::clone(&*app_state), Some(conn_id)).await;
let maestro_path = {
    let cache = app_state.acp.discovery_cache.lock().await;
    cache.get(&Some(conn_id))
        .and_then(|e| e.maestro_server_path.clone())
        .ok_or_else(|| format!("maestro-server path not cached for connection {}...", conn_id))?
};
```

After:
```rust
let maestro_path = {
    let cache = app_state.acp.discovery_cache.lock().await;
    cache.get(&Some(conn_id)).and_then(|e| e.maestro_server_path.clone())
};
let maestro_path = match maestro_path {
    Some(p) => p,
    None => {
        let deploy = crate::acp::deploy::ensure_remote_server(
            &ssh, &app_state.app_handle, conn_id
        ).await?;
        deploy.path
    }
};
```

This:
- Reuses cached path from frontend's `discover_agents` call (if already ran)
- Falls back to `ensure_remote_server` (just 2 SSH commands: `uname -m` + `--protocol-version`)
- Skips the entire one-shot maestro-server process (CDN fetch + ListAgents)
- Saves 5-30s from the pre-warm chain

Note: must move the `ssh` binding BEFORE this block (currently at line 616-617).

## Fix 2: Add CDN timeout in maestro-server

**File: `maestro-server/src/registry.rs` (line 129)**

Before:
```rust
fn fetch_from_cdn() -> Result<AcpRegistry, String> {
    ureq::get(REGISTRY_URL)
        .call()
```

After:
```rust
fn fetch_from_cdn() -> Result<AcpRegistry, String> {
    ureq::get(REGISTRY_URL)
        .timeout(std::time::Duration::from_secs(5))
        .call()
```

Prevents indefinite blocking when CDN is unreachable from remote. 5s is generous for a JSON download.

## Fix 3: Emit `"agent-cache-updated"` event

When `agent_cache` is populated (from pre-warm OR from SpawnOk), emit event so frontend components can react. This helps `useCachedAgentModelsQuery` (used by SpawnSessionDialog and SettingsPage).

**File: `src-tauri/src/acp/manager.rs`** — 3 locations:

1. After `agent_cache.insert()` in `pre_initialize_via_project_server` (line ~1277)
2. After `agent_cache.insert()` in `pre_initialize_via_remote_project_server` (line ~1405)
3. After cache update in `update_agent_cache_from_response` (line ~942)

```rust
app_state.app_handle.emit("agent-cache-updated", serde_json::json!({
    "project_id": project_id,
    "agent_id": agent_id,
})).ok();
```

## Fix 4: Frontend cache query improvements

**File: `src/services/execution.service.ts`** — `useCachedAgentModelsQuery`

- Add `useEffect` listening to `"agent-cache-updated"` event → invalidate matching query
- Reduce `staleTime` from `Infinity` to `5_000` (cheap IPC, just reads HashMap)

```typescript
export function useCachedAgentModelsQuery(projectId: number, agentId: string | null) {
  const queryClient = useQueryClient();

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<{ project_id: number; agent_id: string }>("agent-cache-updated", (event) => {
      if (event.payload.project_id === projectId && event.payload.agent_id === agentId) {
        void queryClient.invalidateQueries({
          queryKey: ["cachedAgentModels", projectId, agentId],
        });
      }
    }).then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, [queryClient, projectId, agentId]);

  return useQuery({
    queryKey: ["cachedAgentModels", projectId, agentId] as const,
    queryFn: () => api.getCachedAgentModels(projectId, agentId!),
    enabled: agentId != null,
    staleTime: 5_000,
    gcTime: Infinity,
  });
}
```

## Files

| File | Change |
|------|--------|
| `src-tauri/src/ipc/project_handlers.rs` | Replace `prefetch_agent_discovery` with cache check + `ensure_remote_server` fallback |
| `maestro-server/src/registry.rs` | Add 5s timeout to `ureq` CDN fetch |
| `src-tauri/src/acp/manager.rs` | Emit `"agent-cache-updated"` in 3 locations |
| `src/services/execution.service.ts` | Event listener + reduce staleTime in `useCachedAgentModelsQuery` |

## Expected Result

| Scenario | Before | After |
|----------|--------|-------|
| Remote first spawn (wait 30s) | 6s delay | **Instant** (pre-warm completes in ~10-20s without one-shot overhead) |
| Remote first spawn (dialog opened early) | 6s delay | **Instant** if pre-warm done; SpawnSessionDialog models appear via event if still running |
| CDN unreachable from remote | Pre-warm hangs 30s+ → fails | Fails fast (5s timeout) → falls back to backup registry |

## Verification

1. `cargo check` — passes
2. `cargo test` — passes
3. `pnpm test --run` — passes
4. **Remote test**: open project → wait 15s → spawn first session → mode/model dropdowns should appear immediately (not 6s)
5. **Remote cold test**: open project → immediately spawn → may still take 6s (pre-warm incomplete) → but second session is instant
