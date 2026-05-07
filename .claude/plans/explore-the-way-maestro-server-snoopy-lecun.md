# Fix: Agent Cache Not Working + Modes Never Loading

## Context

Changes A-D from previous plan were implemented (ProjectServer, RemoteProjectServer, AgentCache, fast paths). Testing reveals the caching architecture IS in place but has 3 specific bugs preventing it from working at runtime.

**Local behavior:**
- First spawn: models arrive after 3-5s (from SpawnOk), modes NEVER load
- Second+ spawn: models instant (cache works!), modes still never load

**Remote behavior:**
- All spawns: 5-10s for everything — fast path never fires

## Root Causes

### 1. Modes never load (protocol gap — NOT fixable on our side)

Claude Code returns `modes: None` in `NewSessionResponse`. ACP schema: `pub modes: Option<SessionModeState>` with `#[serde(default)]`. Only delivery mechanisms: `NewSessionResponse.modes` or `LoadSessionResponse.modes`. `CurrentModeUpdate` notification only carries `currentModeId`, not available list.

**Conclusion**: Mode selector will remain empty until Claude Code populates this field. No Maestro-side fix.

### 2. Remote fast path never fires (timing race)

`prime_project_server` for remote needs `discovery_cache[Some(conn_id)].maestro_server_path`. Discovery runs asynchronously from frontend (`useAgentDiscoveryQuery`). Priming fires immediately after `openProject` → discovery hasn't populated cache yet → fails silently → `remote_project_servers` never gets entry → every remote spawn uses cold path.

### 3. Cold-path readers never update agent_cache

`spawn_reader_task` (manager.rs:576) and `spawn_remote_reader_task` (manager.rs:596) call `handle_server_message` directly — never call `update_agent_cache_from_response`. Only the shared reader (`handle_shared_server_message`) updates cache. When remote always uses cold path (Issue 2) → cache never populated → no instant subsequent spawns.

---

## Fixes (scoped to making existing implementation work)

### Fix 1: Cold-path readers must update agent_cache

**Problem**: `spawn_reader_task` (manager.rs:576) and `spawn_remote_reader_task` (manager.rs:596) call `handle_server_message` but never call `update_agent_cache_from_response`. Only the shared reader (`handle_shared_server_message`) updates cache. When remote always uses cold path (Fix 2 not yet applied), cache never populates.

**Files**: `src-tauri/src/acp/manager.rs`

**Change**: In both `spawn_reader_task` and `spawn_remote_reader_task`, after calling `handle_server_message`, call `update_agent_cache_from_response` with the same message. Pattern:

```rust
// In the reader loop, after deserializing `msg`:
update_agent_cache_from_response(&msg, project_id, &agent_id, &app_state).await;
handle_server_message(/* existing args */).await;
```

This ensures even cold-path sessions populate the agent_cache, making subsequent spawns instant regardless of which path created the first session.

---

### Fix 2: Remote prime_project_server — run discovery inline

**Problem**: `prime_project_server` (project_handlers.rs:602-628) for remote requires `discovery_cache[Some(conn_id)].maestro_server_path`. Discovery is async from frontend. Priming fires immediately after openProject before discovery completes → fails silently → `remote_project_servers` never gets entry.

**Files**: `src-tauri/src/ipc/project_handlers.rs`, `src-tauri/src/ipc/acp_handlers.rs`

**Change**: Extract the discovery logic from `discover_agents` into a reusable `discover_agents_impl(project_id, connection_id, project_path, app_state)` function. Call it inline at the top of `prime_project_server`'s remote branch before reading `discovery_cache`:

```rust
// In prime_project_server, remote branch:
// Ensure discovery has run (populates maestro_server_path in cache)
discover_agents_impl(project_id, Some(conn_id), &project_path, &app_state).await?;
// Now safe to read discovery_cache
let cache = app_state.acp.discovery_cache.lock().await;
let maestro_path = cache.get(&Some(conn_id))
    .and_then(|e| e.maestro_server_path.as_deref())
    .ok_or("maestro-server path not found after discovery")?;
```

This eliminates the race — priming waits for discovery to complete before attempting to spawn the RemoteProjectServer.

---

### Fix 3: Remove file-based agents_model_cache.json system

**Problem**: `useAgentModelsCacheQuery` and `useRefreshAgentModelsMutation` in `execution.service.ts` use a file-based JSON cache (`get_agent_models_cache` / `refresh_agent_models` IPC commands). This is now replaced by the in-memory `AgentCache`.

**Files**:
- `src/services/execution.service.ts` — remove `useAgentModelsCacheQuery`, `useRefreshAgentModelsMutation`
- `src-tauri/src/ipc/acp_handlers.rs` — remove `get_agent_models_cache`, `refresh_agent_models` IPC commands
- `src-tauri/src/lib.rs` — remove from command registration
- Frontend consumers (SpawnSessionDialog) — switch to reading from `AgentCache` via new IPC `get_cached_agent_models(project_id, agent_id)`

**New IPC**: `get_cached_agent_models(project_id: i32, agent_id: String) -> Option<SessionModelState>` — reads from `app_state.acp.agent_cache`.

---

### Fix 4 (no-op): Modes — protocol limitation

Modes never load because Claude Code returns `modes: None` in `NewSessionResponse`. No `SessionUpdate` variant carries the full mode list. **No code change.** Document as known limitation. Mode selector remains hidden (`modes.length > 0` guard in ComposeBar.tsx:637).

---

## Critical Files

| File | Change |
|------|--------|
| `src-tauri/src/acp/manager.rs` | Fix 1: add `update_agent_cache_from_response` to cold-path readers |
| `src-tauri/src/ipc/project_handlers.rs` | Fix 2: inline discovery before remote prime |
| `src-tauri/src/ipc/acp_handlers.rs` | Fix 2: extract `discover_agents_impl`; Fix 3: remove file cache IPCs, add `get_cached_agent_models` |
| `src/services/execution.service.ts` | Fix 3: remove `useAgentModelsCacheQuery`, `useRefreshAgentModelsMutation` |
| `src-tauri/src/lib.rs` | Fix 3: update command registration |

## Expected Result

| Scenario | Before | After |
|----------|--------|-------|
| Local first spawn | 3-5s for models | 3-5s (unchanged — needs SpawnOk) |
| Local subsequent spawns | 3-5s | **Instant** (cache populated by Fix 1 or shared reader) |
| Remote first spawn | 5-10s | 5-10s (unchanged — needs SpawnOk via new RemoteProjectServer) |
| Remote subsequent spawns | 5-10s | **Instant** (cache populated by Fix 1) |
| Remote fast path | Never fires | **Fires** (Fix 2 eliminates race) |
| Modes | Never load | Never load (protocol gap) |

## Verification

1. `cargo check` — compilation passes
2. `cargo test` — Rust tests pass
3. `pnpm test --run` — frontend tests pass
4. **Local**: spawn → wait 3-5s → models load → spawn again → **instant**
5. **Remote**: open remote project → spawn → confirm fast path fires (no new SSH channel per session) → spawn again → **instant**
6. Verify no `agents_model_cache.json` references remain in codebase
