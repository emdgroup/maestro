# Investigation: ACP Agent Discovery Slow Over SSH

## Context

Remote ACP operations (agent discovery, session info) have multi-second delay vs instantaneous local. Other SSH operations (file ops, commands) are fast — not a connection issue. The bottleneck is in the ACP communication architecture.

## Root Causes Found

### 1. `one_shot_rpc_remote` spawns a NEW process per call (PRIMARY)

**File:** `src-tauri/src/acp/rpc.rs:140-193`

Every remote `ListAgents` call:
1. Opens fresh SSH exec channel (roundtrip)
2. Starts brand new `maestro-server` process on remote
3. Server performs `load_registry()` — hits CDN with 5s timeout if cache expired
4. Protocol handshake (2 message roundtrips over SSH)
5. Sends request, reads response
6. Drops everything

Local equivalent: pipes to local subprocess — sub-millisecond.

### 2. CDN fetch on every fresh server process (`registry.rs:149-175`)

`load_registry()` runs on every `maestro-server` startup. If remote's `~/.cache/maestro/registry.json` doesn't exist or is >24h old, blocks up to **5 seconds** on CDN fetch. Since `one_shot_rpc` spawns a fresh process each time, there's no persistent cache benefit.

### 3. Sequential SSH roundtrips in `ensure_remote_server` (`deploy.rs:21-65`)

Even when server is already deployed and up-to-date, 3 sequential SSH commands:
1. `uname -m` (arch check)
2. `maestro-server --protocol-version` (version check)  
3. `echo $HOME` (path resolution)

Each is a full SSH channel open + exec + read. ~100-200ms each = 300-600ms total.

### 4. Double `ensure_remote_server` call (`project_handlers.rs:613` + `acp_handlers.rs:433`)

During project warm-up:
- Line 613: `ensure_remote_server()` to get path for `spawn_remote_project_server()`
- Line 624: `prefetch_agent_discovery()` calls `ensure_remote_server()` AGAIN internally

Redundant 300-600ms.

### 5. Sequential project initialization (`project_handlers.rs:602-643`)

All remote warm-up steps run sequentially:
1. `ensure_remote_server` → 3 roundtrips
2. `spawn_remote_project_server` → channel open + handshake
3. `prefetch_agent_discovery` → ANOTHER `ensure_remote_server` + `one_shot_rpc` (fresh process!)
4. SSH `cat` for settings
5. `pre_initialize_via_project_server` → agent spawn + ACP init

Steps 3 and 4 could run in parallel. Step 3 should use existing project server.

## Proposed Fixes (Priority Order)

### Fix A: Route `ListAgents` through existing project server

Instead of `one_shot_rpc_remote` (spawns fresh process), send `ListAgents` through the already-running project server channel. The project server keeps registry cached in memory after first load.

**Files to modify:**
- `src-tauri/src/ipc/acp_handlers.rs` — `prefetch_agent_discovery` remote path
- `maestro-server/src/main.rs` — ensure `ListAgents` handler works on existing server (it already does)

**Impact:** Eliminates process startup + CDN fetch + handshake for discovery when project server is running. Reduces from ~3-8s to ~100ms.

### Fix B: Combine `ensure_remote_server` SSH commands

Merge `uname -m`, version check, and `echo $HOME` into single SSH exec:

```bash
echo "$(uname -m)|$(~/.maestro/bin/maestro-server --protocol-version 2>/dev/null || echo MISSING)|$HOME"
```

Parse the pipe-delimited output.

**File:** `src-tauri/src/acp/deploy.rs:21-65`

**Impact:** 3 roundtrips → 1 roundtrip. Saves ~200-400ms.

### Fix C: Cache `ensure_remote_server` result

Store the resolved path + version check result per connection_id with short TTL (60s). Eliminates redundant deploy checks during project warm-up.

**Files:**
- `src-tauri/src/acp/deploy.rs` — add caching
- `src-tauri/src/ipc/project_handlers.rs` — pass cached path to `prefetch_agent_discovery`

**Impact:** Eliminates the double-call issue entirely.

### Fix D: Parallelize project warm-up steps

After `spawn_remote_project_server` completes, run discovery + settings read in parallel:

```rust
let (_, settings) = tokio::join!(
    prefetch_agent_discovery(arc, Some(conn_id)),
    ssh.execute_command(&format!("cat {}", settings_path))
);
```

**File:** `src-tauri/src/ipc/project_handlers.rs:620-634`

**Impact:** Saves ~200-500ms during project open.

## Verification

1. Open project with SSH connection
2. Measure time from project open to agent list appearing in UI
3. Compare before/after with `console.time()` around `discover_agents` IPC call
4. Test cold start (no cache) and warm start (cached) paths
5. `cargo test` — ensure no regressions
6. Test edge cases: first deploy, version mismatch, CDN unreachable on remote

## Key Files

| File | Role |
|------|------|
| `src-tauri/src/acp/rpc.rs` | One-shot RPC — the slow path |
| `src-tauri/src/acp/deploy.rs` | Remote server deploy/check |
| `src-tauri/src/ipc/acp_handlers.rs` | Discovery + session handlers |
| `src-tauri/src/ipc/project_handlers.rs` | Project warm-up orchestration |
| `maestro-server/src/registry.rs` | CDN registry fetch + cache |
| `maestro-server/src/main.rs` | Server message dispatch |
