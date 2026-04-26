# ACP Refactor: CDN → maestro-server, Unified Local/Remote

## Goal

maestro-server becomes sole authority for agent discovery and spawn — both local and remote SSH.
CDN registry moves from Tauri desktop INTO maestro-server.
Hardcoded `KNOWN_AGENTS` replaced by CDN-driven discovery.
Tauri becomes thin client: same code path for local and remote.

## Execution Order

1. `maestro-protocol/src/lib.rs` — add CDN registry types
2. `maestro-server/Cargo.toml` — add reqwest dep
3. `maestro-server/src/registry.rs` — NEW file (CDN fetch + discovery)
4. `maestro-server/src/main.rs` — replace KNOWN_AGENTS with registry module
5. `cargo test -p maestro-protocol && cargo test -p maestro-server`
6. `src-tauri/src/acp/client.rs` — DELETE file
7. `src-tauri/src/acp/session.rs` — DELETE file
8. `src-tauri/src/acp/registry.rs` — REWRITE (35 lines)
9. `src-tauri/src/acp/mod.rs` — update re-exports
10. `src-tauri/src/db/connection.rs` — replace 2 cache fields → 1
11. `src-tauri/src/ipc/acp_handlers.rs` — delete 2 IPC handlers, rewrite discovery
12. `src-tauri/src/lib.rs` — remove 2 registrations, rename 1
13. `src-tauri/src/ipc/ssh_handlers.rs` — update prefetch call
14. `cargo check -p maestro`
15. `pnpm tauri:gen` — regenerate bindings
16. `src/services/execution.service.ts` — replace 2 hooks → 1
17. `src/views/AgentsView.tsx` — unified hook, no branching
18. `src/components/execution/__tests__/AgentSelectorDialog.test.tsx` — update mocks
19. `pnpm build && pnpm test`

---

## Step 1: maestro-protocol/src/lib.rs

Add CDN registry types after the existing imports. Insert after line 2 (`use tokio::io::...`):

```rust
use std::collections::HashMap;
```

Insert after line 133 (after `read_message` function, before `#[cfg(test)]`):

```rust
// --- CDN registry types — used by maestro-server for agent discovery ---

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AcpRegistry {
    pub version: String,
    pub agents: Vec<AgentRegistryEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AgentRegistryEntry {
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub description: Option<String>,
    pub distribution: AgentDistribution,
    // Display fields skipped (icon, website, etc.) — server only needs id/name/distribution
    #[serde(default)]
    pub repository: Option<String>,
    #[serde(default)]
    pub authors: Option<Vec<String>>,
    #[serde(default)]
    pub license: Option<String>,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub website: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct AgentDistribution {
    #[serde(default)]
    pub npx: Option<NpxDistribution>,
    #[serde(default)]
    pub binary: Option<HashMap<String, BinaryTarget>>,
    #[serde(default)]
    pub uvx: Option<UvxDistribution>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NpxDistribution {
    pub package: String,
    #[serde(default)]
    pub args: Option<Vec<String>>,
    #[serde(default)]
    pub env: Option<HashMap<String, String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BinaryTarget {
    pub archive: String,
    pub cmd: String,
    #[serde(default)]
    pub args: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct UvxDistribution {
    pub package: String,
    #[serde(default)]
    pub args: Option<Vec<String>>,
}
```

---

## Step 2: maestro-server/Cargo.toml

Add after `serde_json = "1"`:
```toml
reqwest = { version = "0.12", default-features = false, features = ["json", "rustls-tls"] }
```

---

## Step 3: maestro-server/src/registry.rs (NEW FILE)

```rust
//! CDN-driven agent discovery for maestro-server.
//!
//! Fetches the ACP registry from CDN, resolves platform-appropriate spawn commands,
//! and checks which agents are actually available on this host (via `which`).

use maestro_protocol::{AgentDistribution, AcpRegistry};

const REGISTRY_URL: &str =
    "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";

/// An agent that is both in the CDN registry and available on this host.
pub struct DiscoveredAgentWithSpawn {
    pub id: String,
    pub name: String,
    pub spawn_cmd: String,
    pub spawn_args: Vec<String>,
}

/// Compile-time platform key matching CDN binary target keys.
fn current_platform_key() -> &'static str {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    { return "darwin-aarch64"; }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    { return "darwin-x86_64"; }
    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    { return "linux-aarch64"; }
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    { return "linux-x86_64"; }
    #[cfg(all(target_os = "windows", target_arch = "aarch64"))]
    { return "windows-aarch64"; }
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    { return "windows-x86_64"; }
    #[cfg(not(any(
        all(target_os = "macos", target_arch = "aarch64"),
        all(target_os = "macos", target_arch = "x86_64"),
        all(target_os = "linux", target_arch = "aarch64"),
        all(target_os = "linux", target_arch = "x86_64"),
        all(target_os = "windows", target_arch = "aarch64"),
        all(target_os = "windows", target_arch = "x86_64"),
    )))]
    { return ""; }
}

/// Resolve the spawn command for a distribution (npx gets -y -- prefix for auto-install).
/// Priority: npx > binary (current platform) > uvx
fn resolve_spawn(dist: &AgentDistribution) -> Option<(String, Vec<String>)> {
    if let Some(npx) = &dist.npx {
        let mut args = vec!["-y".to_string(), "--".to_string(), npx.package.clone()];
        if let Some(extra) = &npx.args {
            args.extend(extra.iter().cloned());
        }
        return Some(("npx".to_string(), args));
    }
    let key = current_platform_key();
    if !key.is_empty() {
        if let Some(bins) = &dist.binary {
            if let Some(target) = bins.get(key) {
                let mut args = Vec::new();
                if let Some(extra) = &target.args {
                    args.extend(extra.iter().cloned());
                }
                return Some((target.cmd.clone(), args));
            }
        }
    }
    if let Some(uvx) = &dist.uvx {
        let mut args = vec![uvx.package.clone()];
        if let Some(extra) = &uvx.args {
            args.extend(extra.iter().cloned());
        }
        return Some(("uvx".to_string(), args));
    }
    None
}

/// Determine what command to check with `which` to know if this agent can run.
/// npx agents: check `npx` (auto-installs the package on spawn)
/// binary agents: check the binary cmd itself
/// uvx agents: check `uvx` (auto-installs)
fn derive_check_cmd(dist: &AgentDistribution) -> Option<String> {
    if dist.npx.is_some() {
        return Some("npx".to_string());
    }
    let key = current_platform_key();
    if !key.is_empty() {
        if let Some(bins) = &dist.binary {
            if let Some(target) = bins.get(key) {
                return Some(target.cmd.clone());
            }
        }
    }
    if dist.uvx.is_some() {
        return Some("uvx".to_string());
    }
    None
}

async fn check_cmd_available(cmd: &str) -> bool {
    tokio::process::Command::new("which")
        .arg(cmd)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .await
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Fetch CDN registry, check what's available on this host, return agents with spawn commands.
pub async fn discover_agents() -> Result<Vec<DiscoveredAgentWithSpawn>, String> {
    let registry: AcpRegistry = reqwest::get(REGISTRY_URL)
        .await
        .map_err(|e| format!("Registry CDN unreachable: {}", e))?
        .error_for_status()
        .map_err(|e| format!("Registry CDN error: {}", e))?
        .json()
        .await
        .map_err(|e| format!("Registry JSON parse failed: {}", e))?;

    let mut result = Vec::new();
    for entry in &registry.agents {
        let Some(check_cmd) = derive_check_cmd(&entry.distribution) else {
            continue;
        };
        if !check_cmd_available(&check_cmd).await {
            continue;
        }
        let Some((spawn_cmd, spawn_args)) = resolve_spawn(&entry.distribution) else {
            continue;
        };
        result.push(DiscoveredAgentWithSpawn {
            id: entry.id.clone(),
            name: entry.name.clone(),
            spawn_cmd,
            spawn_args,
        });
    }
    Ok(result)
}
```

---

## Step 4: maestro-server/src/main.rs

Add `mod registry;` at top with other mod declarations (after `mod sessions;`).

**Delete** the `KnownAgent` struct (lines 27-35) and `KNOWN_AGENTS` constant (lines 37-57).

**Add** cache variable in `main()` after `let mut client_refs`:
```rust
// In-process cache: (fetched_at, agents). 5-min TTL avoids re-fetching CDN per Spawn.
let mut agent_cache: Option<(std::time::Instant, Vec<registry::DiscoveredAgentWithSpawn>)> = None;
const CACHE_TTL: std::time::Duration = std::time::Duration::from_secs(300);
```

**Add** helper closure (or inline fn) for cache-or-fetch. In practice, inline the logic at each call site since Rust closures can't be async easily.

**Replace** the `ListAgents` handler (currently lines 108-133) with:
```rust
MaestroRpcMessage::Request(ServerRequest::ListAgents(_req)) => {
    // Refresh cache if stale
    let needs_refresh = agent_cache.as_ref()
        .map(|(ts, _)| ts.elapsed() > CACHE_TTL)
        .unwrap_or(true);
    if needs_refresh {
        match registry::discover_agents().await {
            Ok(agents) => { agent_cache = Some((std::time::Instant::now(), agents)); }
            Err(e) => {
                let _ = send_response(
                    &stdout,
                    &MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
                        message: format!("Agent discovery failed: {}", e),
                    })),
                ).await;
                continue;
            }
        }
    }
    let agents: Vec<DiscoveredAgent> = agent_cache.as_ref().unwrap().1.iter()
        .map(|a| DiscoveredAgent { id: a.id.clone(), name: a.name.clone() })
        .collect();
    let _ = send_response(
        &stdout,
        &MaestroRpcMessage::Response(ServerResponse::ListAgentsOk(
            ListAgentsResponse { agents },
        )),
    ).await;
}
```

**Replace** the `Spawn` handler lookup (currently lines 136-156 — the KNOWN_AGENTS lookup + Error) with:
```rust
MaestroRpcMessage::Request(ServerRequest::Spawn(req)) => {
    // Refresh cache if stale
    let needs_refresh = agent_cache.as_ref()
        .map(|(ts, _)| ts.elapsed() > CACHE_TTL)
        .unwrap_or(true);
    if needs_refresh {
        match registry::discover_agents().await {
            Ok(agents) => { agent_cache = Some((std::time::Instant::now(), agents)); }
            Err(e) => {
                let _ = send_response(
                    &stdout,
                    &MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
                        message: format!("Agent discovery failed: {}", e),
                    })),
                ).await;
                continue;
            }
        }
    }
    let (spawn_cmd, spawn_args_owned) = match agent_cache.as_ref().unwrap().1.iter()
        .find(|a| a.id == req.agent_id)
    {
        Some(a) => (a.spawn_cmd.clone(), a.spawn_args.clone()),
        None => {
            let _ = send_response(
                &stdout,
                &MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
                    message: format!("Unknown agent: {}", req.agent_id),
                })),
            ).await;
            continue;
        }
    };
    // ... rest of spawn handler (child spawn, ACP init, etc.) unchanged
    // Replace `k.spawn_cmd` → `spawn_cmd`, `k.spawn_args.iter().map(|s| s.to_string()).collect()` → `spawn_args_owned`
```

The rest of the Spawn handler body (ACP subprocess bridging, initialize, new_session, SpawnOk) is **unchanged**.

Also update the import in main.rs — remove `KnownAgent`-related imports, no new ones needed since `registry` is a local module.

---

## Step 5: Verify Rust builds

```bash
cargo test -p maestro-protocol
cargo test -p maestro-server
```

Fix any compile errors before proceeding.

---

## Step 6 & 7: Delete dead Tauri files

```bash
rm src-tauri/src/acp/client.rs
rm src-tauri/src/acp/session.rs
```

---

## Step 8: src-tauri/src/acp/registry.rs (REWRITE)

Replace entire file with:

```rust
use serde::{Deserialize, Serialize};
use specta::Type;
use std::time::Instant;

/// Agent discovered by maestro-server's CDN registry check.
/// Returned by the `discover_agents` IPC command for both local and remote connections.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct DiscoveredAgent {
    pub id: String,
    pub name: String,
}

/// Unified discovery result returned to the frontend via IPC.
/// Works for both local (`connection_id = None`) and remote (`connection_id = Some(id)`).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct AgentDiscoveryResult {
    pub maestro_server_available: bool,
    pub agents: Vec<DiscoveredAgent>,
    #[serde(default)]
    #[specta(optional)]
    pub error: Option<String>,
}

/// Internal cache entry — not exported to TS.
/// Holds the IPC result plus the resolved maestro-server path (needed at spawn time for remote).
pub struct AgentDiscoveryCacheEntry {
    pub result: AgentDiscoveryResult,
    /// Absolute path to maestro-server binary on the target host.
    /// For remote: resolved via SSH `which maestro-server` at connect time.
    /// For local: None (spawn_acp_process resolves via `which::which` at spawn time).
    pub maestro_server_path: Option<String>,
    pub fetched_at: Instant,
}
```

---

## Step 9: src-tauri/src/acp/mod.rs (REWRITE)

Replace entire file with:

```rust
pub mod manager;
pub mod registry;
pub mod transport;

pub use manager::{AcpProcess, AcpTransportWriter, spawn_acp_process, spawn_acp_process_remote, write_to_acp_session};
pub use registry::{DiscoveredAgent, AgentDiscoveryResult, AgentDiscoveryCacheEntry};
```

---

## Step 10: src-tauri/src/db/connection.rs

**Replace** import line 10:
```rust
// OLD:
use crate::acp::registry::{RegistryCacheEntry, RemoteAgentStatus};
// NEW:
use crate::acp::registry::AgentDiscoveryCacheEntry;
```

**Replace** lines 68-70 (the two old cache fields):
```rust
// OLD:
    /// In-memory cache for the ACP agent registry with 5-minute TTL.
    pub agent_registry_cache: tokio::sync::Mutex<Option<RegistryCacheEntry>>,
    /// Per-connection cache of remote agent availability checks with 5-minute TTL.
    pub remote_agent_status: tokio::sync::Mutex<HashMap<i32, (std::time::Instant, RemoteAgentStatus)>>,
// NEW:
    /// Per-connection agent discovery cache (5-minute TTL).
    /// Key: None = local maestro-server, Some(id) = remote SSH connection.
    pub agent_discovery_cache: tokio::sync::Mutex<HashMap<Option<i32>, AgentDiscoveryCacheEntry>>,
```

**Replace** lines 85-86 (AppState::new initializers):
```rust
// OLD:
            agent_registry_cache: tokio::sync::Mutex::new(None),
            remote_agent_status: tokio::sync::Mutex::new(HashMap::new()),
// NEW:
            agent_discovery_cache: tokio::sync::Mutex::new(HashMap::new()),
```

---

## Step 11: src-tauri/src/ipc/acp_handlers.rs (MAJOR REWRITE)

### 11a. Replace imports (lines 14-19)

```rust
// OLD:
use crate::acp::registry::{DiscoveredAgent, RegistryResponse, ResolvedLaunchCommand, RemoteAgentStatus};
use crate::acp::transport::{
    MaestroRpcMessage, ServerRequest,
    PromptRequest, CancelRequest, PermissionResponse,
};
// NEW:
use crate::acp::registry::{DiscoveredAgent, AgentDiscoveryResult, AgentDiscoveryCacheEntry};
use crate::acp::transport::{
    MaestroRpcMessage, ServerRequest, ServerResponse,
    PromptRequest, CancelRequest, PermissionResponse,
    ListAgentsRequest, ListAgentsResponse, write_message,
};
```

### 11b. Update spawn_acp_session (lines 60-69)

Replace the `maestro_path` lookup block:
```rust
// OLD (lines 61-69):
        let maestro_path = {
            let cache = app_state.remote_agent_status.lock().await;
            cache.get(&conn_id)
                .and_then(|(_, s)| s.maestro_server_path.clone())
                .ok_or_else(|| format!(
                    "maestro-server path not cached for connection {}. Reconnect to refresh.",
                    conn_id
                ))?
        };
// NEW:
        let maestro_path = {
            let cache = app_state.agent_discovery_cache.lock().await;
            cache.get(&Some(conn_id))
                .and_then(|e| e.maestro_server_path.clone())
                .ok_or_else(|| format!(
                    "maestro-server path not cached for connection {}. Reconnect to refresh.",
                    conn_id
                ))?
        };
```

### 11c. Delete fetch_agent_registry (lines 228-238)

Delete entire function including doc comment.

### 11d. Delete resolve_agent_launch_command (lines 240-271)

Delete entire function including doc comment.

### 11e. Replace prefetch_remote_agent_status (lines 273-303)

Replace entire function with:
```rust
/// Run agent discovery and store result in the AppState cache.
/// Fire-and-forget safe: returns silently on errors (result stored with error field set).
/// Called at SSH connect time (connection_id = Some) and on-demand from `discover_agents` IPC.
/// For local discovery (connection_id = None), called on first `discover_agents` query.
pub async fn prefetch_agent_discovery(app_state: Arc<AppState>, connection_id: Option<i32>) {
    match connection_id {
        Some(conn_id) => {
            let Some(ssh) = app_state.get_ssh_session(conn_id).await else {
                return;
            };
            let maestro_path = ssh
                .execute_command("which maestro-server 2>/dev/null")
                .await
                .ok()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());
            let maestro_server_available = maestro_path.is_some();
            let (agents, error) = match &maestro_path {
                Some(path) => match query_list_agents_remote(&ssh, path).await {
                    Ok(a) => (a, None),
                    Err(e) => (Vec::new(), Some(e)),
                },
                None => (Vec::new(), None),
            };
            let entry = AgentDiscoveryCacheEntry {
                result: AgentDiscoveryResult { maestro_server_available, agents, error },
                maestro_server_path: maestro_path,
                fetched_at: std::time::Instant::now(),
            };
            app_state.agent_discovery_cache.lock().await.insert(Some(conn_id), entry);
        }
        None => {
            let maestro_path = which::which("maestro-server").ok()
                .map(|p| p.to_string_lossy().to_string());
            let maestro_server_available = maestro_path.is_some();
            let (agents, error) = if maestro_server_available {
                match query_list_agents_local().await {
                    Ok(a) => (a, None),
                    Err(e) => (Vec::new(), Some(e)),
                }
            } else {
                (Vec::new(), None)
            };
            let entry = AgentDiscoveryCacheEntry {
                result: AgentDiscoveryResult { maestro_server_available, agents, error },
                maestro_server_path: None, // local spawn resolves via which at spawn time
                fetched_at: std::time::Instant::now(),
            };
            app_state.agent_discovery_cache.lock().await.insert(None, entry);
        }
    }
}
```

### 11f. Add query_list_agents_local (new function, after prefetch_agent_discovery)

```rust
/// Spawn a one-shot local maestro-server, send ListAgents, read response.
async fn query_list_agents_local() -> Result<Vec<DiscoveredAgent>, String> {
    use tokio::io::AsyncWriteExt;

    let server_path = which::which("maestro-server")
        .map_err(|e| format!("maestro-server not found: {}", e))?;

    let mut child = tokio::process::Command::new(server_path)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("Failed to spawn local maestro-server: {}", e))?;

    let mut stdin = child.stdin.take().expect("stdin piped");
    let mut stdout = child.stdout.take().expect("stdout piped");

    let msg = MaestroRpcMessage::Request(ServerRequest::ListAgents(ListAgentsRequest {}));
    let mut writer = tokio::io::BufWriter::new(&mut stdin);
    write_message(&mut writer, &msg)
        .await
        .map_err(|e| format!("ListAgents local write failed: {}", e))?;
    writer.flush().await.map_err(|e| format!("flush failed: {}", e))?;
    drop(writer);
    drop(stdin); // close stdin → server sees EOF after sending response

    let mut buf = Vec::<u8>::new();
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(15),
        async {
            use tokio::io::AsyncReadExt;
            let mut tmp = [0u8; 4096];
            loop {
                let n = stdout.read(&mut tmp).await
                    .map_err(|e| format!("read error: {}", e))?;
                if n == 0 {
                    break;
                }
                buf.extend_from_slice(&tmp[..n]);
                if let Some(rpc_msg) = crate::acp::manager::try_parse_acp_frame(&mut buf) {
                    return Ok::<_, String>(Some(rpc_msg));
                }
            }
            Ok(None)
        },
    )
    .await
    .map_err(|_| "ListAgents local timed out after 15s".to_string())??;

    match result {
        Some(MaestroRpcMessage::Response(ServerResponse::ListAgentsOk(resp))) => {
            Ok(resp.agents.into_iter().map(|a| DiscoveredAgent { id: a.id, name: a.name }).collect())
        }
        Some(MaestroRpcMessage::Response(ServerResponse::Error(e))) => Err(e.message),
        _ => Err("No valid ListAgentsOk response from local maestro-server".to_string()),
    }
}
```

### 11g. Rename query_list_agents → query_list_agents_remote (lines 307-361)

Change function name only. Body unchanged.

### 11h. Replace check_remote_agents → discover_agents (lines 363-396)

Replace entire function including doc comment with:
```rust
/// Discover available ACP agents via maestro-server.
/// Works for both local (connection_id = None) and remote SSH (connection_id = Some(id)).
/// Returns cached result if within 5-minute TTL; otherwise re-runs discovery.
#[tauri::command]
#[specta::specta]
pub async fn discover_agents(
    app_state: State<'_, Arc<AppState>>,
    connection_id: Option<i32>,
) -> Result<AgentDiscoveryResult, String> {
    // Return cached result if fresh
    {
        let cache = app_state.agent_discovery_cache.lock().await;
        if let Some(entry) = cache.get(&connection_id) {
            if entry.fetched_at.elapsed() < Duration::from_secs(300) {
                return Ok(entry.result.clone());
            }
        }
    }

    let arc = Arc::clone(app_state.inner());
    prefetch_agent_discovery(arc, connection_id).await;

    app_state.agent_discovery_cache.lock().await
        .get(&connection_id)
        .map(|e| e.result.clone())
        .ok_or_else(|| match connection_id {
            None => "Local agent discovery failed — is maestro-server installed?".to_string(),
            Some(id) => format!("No active SSH session for connection_id {}. Connect first.", id),
        })
}
```

Also update the internal call in `prefetch_agent_discovery` — the old `query_list_agents` calls must use `query_list_agents_remote` now.

---

## Step 12: src-tauri/src/lib.rs (lines 93-101)

```rust
// OLD:
            // ACP session management (Phase 44) + registry (Phase 45)
            crate::ipc::spawn_acp_session,
            crate::ipc::send_acp_prompt,
            crate::ipc::respond_acp_permission,
            crate::ipc::cancel_acp_session,
            crate::ipc::fetch_agent_registry,
            crate::ipc::resolve_agent_launch_command,
            crate::ipc::check_remote_agents,
            crate::ipc::get_structured_output
// NEW:
            // ACP session management + unified agent discovery
            crate::ipc::spawn_acp_session,
            crate::ipc::send_acp_prompt,
            crate::ipc::respond_acp_permission,
            crate::ipc::cancel_acp_session,
            crate::ipc::discover_agents,
            crate::ipc::get_structured_output
```

---

## Step 13: src-tauri/src/ipc/ssh_handlers.rs (line 44)

```rust
// OLD:
        super::acp_handlers::prefetch_remote_agent_status(state_clone, connection_id).await;
// NEW:
        super::acp_handlers::prefetch_agent_discovery(state_clone, Some(connection_id)).await;
```

---

## Step 14: cargo check

```bash
cargo check -p maestro
```

Fix any remaining compile errors. Common issues:
- Missing `which` crate import in acp_handlers.rs: add `use which;` or use full path `which::which(...)`
- `AgentDiscoveryResult` must derive `Clone` (it does, per the struct definition above)
- `ServerResponse` import now needed in acp_handlers.rs (added in step 11a)

---

## Step 15: Regenerate bindings

```bash
pnpm tauri:gen
```

Expected changes to `src/types/bindings.ts`:
- REMOVED: `fetchAgentRegistry`, `resolveAgentLaunchCommand`, `checkRemoteAgents`
- REMOVED types: `AcpRegistry`, `AgentInfo`, `AgentDistribution`, `NpxDistribution`, `BinaryTarget`, `UvxDistribution`, `RegistryResponse`, `ResolvedLaunchCommand`, `RemoteAgentStatus`, `RegistryCacheEntry`
- ADDED: `discoverAgents(connectionId: number | null): Promise<AgentDiscoveryResult>`
- ADDED type: `AgentDiscoveryResult { maestro_server_available: boolean; agents: DiscoveredAgent[]; error: string | null }`
- KEPT: `DiscoveredAgent { id: string; name: string }`

---

## Step 16: src/services/execution.service.ts

**Delete** lines 220-263 (registryQueryKeys, useAgentRegistryQuery, remoteAgentKeys, useRemoteAgentStatusQuery).

**Add** after line 219 (before useSpawnAcpSessionMutation):
```typescript
/**
 * Unified agent discovery hook — works for both local and remote connections.
 * connectionId = null → local maestro-server
 * connectionId = number → remote SSH connection
 * 5-minute staleTime mirrors backend TTL.
 */
export function useAgentDiscoveryQuery(
  connectionId: number | null,
  enabled: boolean = true,
) {
  return useQuery({
    queryKey: ["agentDiscovery", connectionId],
    queryFn: () => api.discoverAgents(connectionId),
    enabled,
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
  });
}
```

---

## Step 17: src/views/AgentsView.tsx

**Replace** imports (lines 6-12):
```typescript
// DELETE:
import {
  useExecutionsWithTaskInfoQuery,
  useSpawnInteractiveExecutionMutation,
  useSpawnAcpSessionMutation,
  useDeleteExecutionMutation,
  useAgentRegistryQuery,
  useRemoteAgentStatusQuery,
} from "@/services/execution.service";
// ADD:
import {
  useExecutionsWithTaskInfoQuery,
  useSpawnInteractiveExecutionMutation,
  useSpawnAcpSessionMutation,
  useDeleteExecutionMutation,
  useAgentDiscoveryQuery,
} from "@/services/execution.service";
```

**Replace** lines 53-65 (two hooks + derived values):
```typescript
// DELETE:
  const { data: registry } = useAgentRegistryQuery(showSpawnDialog);
  // Check remote availability eagerly on mount so results are ready when dialog opens
  const { data: remoteStatus, isLoading: remoteStatusLoading } = useRemoteAgentStatusQuery(connectionId ?? null);
  ...
  const isRemote = !!connectionId;
  const agents = registry?.agents ?? [];
  // Remote: use agents discovered by maestro-server directly (no CDN cross-reference needed)
  const visibleAgents = isRemote
    ? (remoteStatus?.agents ?? [])
    : agents;

// ADD:
  // Unified discovery: local (connectionId=null) or remote (connectionId=number)
  // Eagerly prefetch for remote on mount; for local only when dialog opens
  const { data: discovery, isLoading: discoveryLoading } = useAgentDiscoveryQuery(
    connectionId ?? null,
    showSpawnDialog || !!connectionId,
  );
  const visibleAgents = discovery?.agents ?? [];
```

**Replace** lines 211-225 (the remote-specific disabled items in Select):
```tsx
// DELETE:
                  {isRemote && remoteStatusLoading && (
                    <SelectItem value="_loading" disabled>Checking remote agents...</SelectItem>
                  )}
                  {isRemote && !remoteStatusLoading && !remoteStatus?.maestro_server_available && (
                    <SelectItem value="_no_server" disabled>
                      maestro-server not found on remote host
                    </SelectItem>
                  )}
// ADD:
                  {discoveryLoading && (
                    <SelectItem value="_loading" disabled>Checking available agents...</SelectItem>
                  )}
                  {!discoveryLoading && !discovery?.maestro_server_available && (
                    <SelectItem value="_no_server" disabled>
                      maestro-server not found
                    </SelectItem>
                  )}
                  {!discoveryLoading && discovery?.error && (
                    <SelectItem value="_error" disabled>
                      Discovery error: {discovery.error}
                    </SelectItem>
                  )}
```

---

## Step 18: src/components/execution/__tests__/AgentSelectorDialog.test.tsx

**Replace** mock (lines 13-20):
```typescript
// OLD:
vi.mock("@/services/execution.service", () => ({
  useAgentRegistryQuery: vi.fn(),
  useRemoteAgentStatusQuery: vi.fn(),
  useSpawnAcpSessionMutation: vi.fn(),
  useSpawnInteractiveExecutionMutation: vi.fn(),
  useDeleteExecutionMutation: vi.fn(),
  useExecutionsWithTaskInfoQuery: vi.fn(),
}));
// NEW:
vi.mock("@/services/execution.service", () => ({
  useAgentDiscoveryQuery: vi.fn(),
  useSpawnAcpSessionMutation: vi.fn(),
  useSpawnInteractiveExecutionMutation: vi.fn(),
  useDeleteExecutionMutation: vi.fn(),
  useExecutionsWithTaskInfoQuery: vi.fn(),
}));
```

**Replace** imports (lines 31-38):
```typescript
// OLD:
import {
  useAgentRegistryQuery,
  useRemoteAgentStatusQuery,
  useSpawnAcpSessionMutation,
  ...
} from "@/services/execution.service";
// NEW:
import {
  useAgentDiscoveryQuery,
  useSpawnAcpSessionMutation,
  ...
} from "@/services/execution.service";
```

**Replace** mockAgents type (lines 43-56):
```typescript
// OLD:
import type { AgentInfo, WorktreeWithStatus } from "@/types/bindings";
const mockAgents: AgentInfo[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    version: "1.0.0",
    description: "AI coding agent",
    distribution: {} as AgentInfo["distribution"],
    repository: null,
    authors: null,
    license: null,
    icon: null,
    website: null,
  },
];
// NEW:
import type { DiscoveredAgent, WorktreeWithStatus } from "@/types/bindings";
const mockAgents: DiscoveredAgent[] = [
  { id: "claude-code", name: "Claude Code" },
];
```

**Replace** beforeEach mock returns (lines 88-94):
```typescript
// OLD:
  (useAgentRegistryQuery as ReturnType<typeof vi.fn>).mockReturnValue({ data: { agents: mockAgents, cached: false, stale: false }, isLoading: false });
  (useRemoteAgentStatusQuery as ReturnType<typeof vi.fn>).mockReturnValue({ data: undefined, isLoading: false });
// NEW:
  (useAgentDiscoveryQuery as ReturnType<typeof vi.fn>).mockReturnValue({
    data: { maestro_server_available: true, agents: mockAgents, error: null },
    isLoading: false,
  });
```

**Replace** assertion in test (line 116):
```typescript
// OLD:
    expect(useAgentRegistryQuery).toHaveBeenCalledWith(true);
// NEW:
    expect(useAgentDiscoveryQuery).toHaveBeenCalled();
```

---

## Step 19: Build + Test

```bash
pnpm build
pnpm test
```

---

## Verification

1. `cargo test -p maestro-protocol` — new types roundtrip
2. `cargo test -p maestro-server` — CDN-based discovery compiles (integration tests still pass)
3. `cargo check -p maestro` — Tauri compiles clean
4. `pnpm build` — frontend builds
5. `pnpm test` — AgentSelectorDialog test passes with new mocks

**Manual local:** Open Agents view → New Session → agents from local maestro-server (CDN-driven) appear in type dropdown.

**Manual remote:** SSH connect → New Session → agents from remote maestro-server appear. If CDN unreachable on remote, error shown in dropdown.

**Offline local:** If CDN unreachable, ListAgents returns Error → `discovery.error` set → shown in dropdown as disabled item.

## Notes

- `which` crate already in maestro Tauri workspace (`which::which` used in `manager.rs`). No new dep needed in Tauri.
- `reqwest` already in maestro Tauri workspace (`settings_handlers.rs` uses it). But maestro-server is a separate binary — it needs its own reqwest dep in `maestro-server/Cargo.toml`.
- Two `DiscoveredAgent` types coexist: one in `maestro-protocol` (no specta), one in Tauri's `registry.rs` (with specta for TS export). The `query_list_agents_remote` and `query_list_agents_local` functions map between them. This is intentional.
- The `agent-client-protocol` crate version in maestro-server is `0.10.4`. The `reqwest 0.12` dep must use `rustls-tls` since the server targets Linux SSH hosts (no native OpenSSL guarantee).
