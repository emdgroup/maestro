# Phase 45: Agent Registry Fetch + Caching — Research

**Researched:** 2026-04-21
**Domain:** Rust backend — HTTP fetch, in-memory caching, type extension, Tauri IPC
**Confidence:** HIGH

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Distribution Priority (resolution order):**
1. `npx` — preferred; Node.js is present on dev machines; most agents are npm packages
2. `binary` — fallback if no npx; use compile-time target selection (`cfg(target_os)` / `cfg(target_arch)`) to pick the correct binary key
3. `uvx` — last resort

If no compatible distribution found: return `Err(...)` for that agent's `resolve_agent_launch_command` call.

Binary target key selection: compile-time via Rust cfg macros — no runtime OS/arch detection. Simple and deterministic.

**CDN Failure Behavior:**
- Cache exists (even expired): return stale registry with staleness flag — `RegistryResponse { agents: Vec<AgentInfo>, cached: bool, stale: bool }`
- No cache, CDN unreachable: return `Err(...)` — propagate to frontend
- Force-refresh: separate `force_refresh: bool` param on `fetch_agent_registry` IPC

**TypeScript Bindings:**
- `AgentInfo`, `AgentDistribution`, `NpxDistribution`, `BinaryTarget`, `UvxDistribution` all get `#[derive(TS)]` + `#[ts(export)]`
- `RegistryResponse` and `ResolvedLaunchCommand { cmd: String, args: Vec<String> }` also get `#[derive(TS)]`
- Run `pnpm tauri:gen` at end of phase

**IPC Surface (three commands):**
1. `fetch_agent_registry(force_refresh: bool)` → `Result<RegistryResponse, String>`
2. `resolve_agent_launch_command(agent_id: String)` → `Result<ResolvedLaunchCommand, String>`
3. No separate "list agents" — `fetch_agent_registry` returns the full list

**AppState Extension:**
```rust
pub agent_registry_cache: tokio::sync::Mutex<Option<RegistryCacheEntry>>
```
Where `RegistryCacheEntry = { registry: AcpRegistry, fetched_at: std::time::Instant }`.
5-minute TTL via `Instant::now() - fetched_at > Duration::from_secs(300)`.

### Claude's Discretion
- Exact Rust module layout within `acp/registry.rs` (IPC handler location: likely `ipc/acp_handlers.rs` or new `ipc/registry_handlers.rs`)
- reqwest client lifecycle: shared client in AppState vs per-request
- Error message strings for missing distributions, CDN failures

### Deferred Ideas (OUT OF SCOPE)
- Remote ACP registry deployment (SFTP upload, version check) — v2 REMOTE-01/02/03
- Registry UI with filtering by capability/language — v2 REGUI-01
- Per-task default agent assignment on Kanban — v2 REGUI-02
- Registry persistence across app restarts (SQLite or .maestro/ file)

</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| REGISTRY-01 | User can fetch list of available ACP agents from CDN registry (`https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json`) | Live registry fetched and schema verified; reqwest 0.13 already in Cargo.toml; `AcpRegistry`/`AgentInfo` types already exist in `acp/registry.rs` |
| REGISTRY-02 | Registry cached in AppState with 5-min TTL; user can force refresh via IPC | `tokio::sync::Mutex<Option<RegistryCacheEntry>>` pattern matches existing AppState session maps; `std::time::Instant` for TTL; `force_refresh: bool` param pattern consistent with IPC conventions |
| REGISTRY-03 | Agent launch command resolved from `AgentInfo.distribution` (npx package / binary target / uvx package) for use in SpawnRequest | Live registry confirms binary keys format; cfg(target_os/arch) pattern already used in `filesystem_handlers.rs`; `ResolvedLaunchCommand { cmd, args }` maps to subprocess spawn |

</phase_requirements>

---

## Summary

Phase 45 is a self-contained Rust backend phase: fetch the ACP agent registry from CDN, cache it in AppState with a 5-minute TTL, and resolve concrete launch commands from agent distribution metadata. No UI, no schema changes, no new dependencies — everything needed is already present.

The live registry at `https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json` was fetched and inspected during research. The existing `acp/registry.rs` types (`AcpRegistry`, `AgentInfo`, `AgentDistribution`, `NpxDistribution`, `BinaryTarget`, `UvxDistribution`) correctly model the registry structure, but are **missing optional fields** (`args`, `env`) that appear in live agent entries. These fields must be added with `#[serde(default)]` to avoid deserialization failures if the CDN returns them.

The project already uses `reqwest` v0.13 with the `json` feature in two IPC handlers (`sync_github_issues`, `sync_jira_issues`). Those handlers use a per-request `reqwest::Client::new()` pattern. For the registry fetch, a shared `reqwest::Client` stored in AppState is preferable because `Client` reuses connection pools and is designed to be reused across requests — though given fetch frequency (every 5 min at most), per-request is also acceptable.

**Primary recommendation:** Add `agent_registry_cache: tokio::sync::Mutex<Option<RegistryCacheEntry>>` to AppState, place all registry logic in `acp/registry.rs` (data + fetch + resolve functions), and expose IPC commands in `ipc/acp_handlers.rs` following the existing Phase 44 pattern.

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| CDN fetch + deserialization | API / Backend (Rust) | — | Network I/O; reqwest is a Rust library; frontend cannot call external URLs directly in Tauri without IPC |
| Registry cache management (TTL, stale flag) | API / Backend (Rust) | — | AppState is the Rust runtime state container; cache must survive across IPC calls without frontend involvement |
| Binary target key selection | API / Backend (Rust) | — | `cfg(target_os/arch)` is a compile-time Rust mechanism; cannot be done in TypeScript |
| Launch command resolution | API / Backend (Rust) | — | Distribution priority logic belongs with the data; `ResolvedLaunchCommand` is consumed by `spawn_acp_session` which is also Rust |
| TypeScript type exposure | Type generation pipeline | — | `tauri-specta` / `ts-rs` generates `bindings.ts` from Rust derives; frontend imports generated types |

---

## Standard Stack

### Core (all already in Cargo.toml)

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `reqwest` | 0.13 | HTTP GET to CDN | Already present with `json` feature; async, ergonomic `.json::<T>()` deserialisation |
| `serde` + `serde_json` | 1.x | JSON deserialization of registry | Already in use everywhere; `#[serde(default)]` handles optional registry fields |
| `tokio::sync::Mutex` | (tokio 1.x) | Async-safe cache guard in AppState | Matches all other session maps in AppState (same pattern as `acp_sessions`) |
| `std::time::Instant` | stdlib | TTL measurement | No dep needed; `Instant::now() - fetched_at` returns `Duration` |
| `tauri-specta` + `ts-rs` | rc.20 / current | TypeScript binding generation | Project-wide type generation mechanism; already wired in `lib.rs` |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `specta` | 2.0.0-rc.20 | Drives `#[derive(TS)]` + export | Required on every new model type exposed to frontend |
| `chrono` | 0.4 | Timestamp strings if needed | Already present; not needed for TTL (use `Instant`) |

**No new dependencies required.** `reqwest`, `serde`, `tokio`, `specta`, `tauri-specta` are all in `Cargo.toml`. [VERIFIED: Cargo.toml read directly]

---

## Architecture Patterns

### System Architecture Diagram

```
Frontend (TypeScript)
       │
       │  invoke("fetch_agent_registry", { force_refresh })
       │  invoke("resolve_agent_launch_command", { agent_id })
       ▼
IPC Layer (ipc/acp_handlers.rs)
       │
       │  fetch_agent_registry  ───────────────────────────────────┐
       │                                                            │
       ▼                                                            ▼
acp/registry.rs (logic)                               CDN (reqwest GET)
  fetch_or_return_cached()                    https://cdn.agentclientprotocol.com
  resolve_launch_command()                         /registry/v1/latest/registry.json
       │                                                            │
       │  read/write                             AcpRegistry (JSON) │
       ▼                                                            │
AppState.agent_registry_cache                                       │
  Mutex<Option<RegistryCacheEntry>>  ◄───────────────────────────────
  { registry: AcpRegistry,
    fetched_at: Instant }
       │
       │  (on resolve_agent_launch_command)
       ▼
  AgentDistribution priority walk
  npx → binary(cfg key) → uvx
       │
       ▼
  ResolvedLaunchCommand { cmd, args }
       │
       ▼  (returned to frontend; consumed by Phase 46/49 spawn flow)
```

### Recommended Module Layout

```
src-tauri/src/
├── acp/
│   ├── registry.rs      # AcpRegistry, AgentInfo, AgentDistribution types + fetch + resolve logic
│   ├── mod.rs           # add pub use registry::{RegistryResponse, ResolvedLaunchCommand, RegistryCacheEntry}
│   └── ...              # existing modules unchanged
├── db/
│   └── connection.rs    # add agent_registry_cache field to AppState + initialize to None
├── ipc/
│   └── acp_handlers.rs  # add fetch_agent_registry + resolve_agent_launch_command IPC commands
└── lib.rs               # register new commands in collect_commands!
```

### Pattern 1: Async Cache Check with Stale-on-Error

The locked decision requires returning stale data (with `stale: true`) when CDN fails but cache exists. The pattern:

```rust
// Source: project conventions (matches acp_sessions pattern in AppState)
pub async fn fetch_or_return_cached(
    cache: &tokio::sync::Mutex<Option<RegistryCacheEntry>>,
    force_refresh: bool,
) -> Result<RegistryResponse, String> {
    let mut guard = cache.lock().await;

    // Check if cache is valid (exists and not expired)
    let is_fresh = guard.as_ref().map_or(false, |entry| {
        !force_refresh && entry.fetched_at.elapsed() < Duration::from_secs(300)
    });

    if is_fresh {
        let entry = guard.as_ref().unwrap();
        return Ok(RegistryResponse {
            agents: entry.registry.agents.clone(),
            cached: true,
            stale: false,
        });
    }

    // Attempt CDN fetch
    match fetch_registry_from_cdn().await {
        Ok(registry) => {
            *guard = Some(RegistryCacheEntry {
                registry: registry.clone(),
                fetched_at: std::time::Instant::now(),
            });
            Ok(RegistryResponse { agents: registry.agents, cached: false, stale: false })
        }
        Err(e) => {
            // CDN unreachable: return stale if available, else propagate error
            if let Some(entry) = guard.as_ref() {
                Ok(RegistryResponse {
                    agents: entry.registry.agents.clone(),
                    cached: true,
                    stale: true,
                })
            } else {
                Err(format!("Failed to fetch registry: {}", e))
            }
        }
    }
}
```
[ASSUMED: pattern based on locked CONTEXT.md decisions + codebase conventions]

### Pattern 2: Compile-Time Binary Target Key Selection

Live registry uses these binary target key names: `darwin-aarch64`, `darwin-x86_64`, `linux-aarch64`, `linux-x86_64`, `windows-aarch64`, `windows-x86_64`. [VERIFIED: live registry fetch]

```rust
// Source: pattern derived from filesystem_handlers.rs cfg usage [VERIFIED: file read]
fn current_binary_target_key() -> &'static str {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    { "darwin-aarch64" }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    { "darwin-x86_64" }
    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    { "linux-aarch64" }
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    { "linux-x86_64" }
    #[cfg(all(target_os = "windows", target_arch = "aarch64"))]
    { "windows-aarch64" }
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    { "windows-x86_64" }
    // Fallback for unknown targets — binary resolution will return None
    #[cfg(not(any(
        all(target_os = "macos", target_arch = "aarch64"),
        all(target_os = "macos", target_arch = "x86_64"),
        all(target_os = "linux", target_arch = "aarch64"),
        all(target_os = "linux", target_arch = "x86_64"),
        all(target_os = "windows", target_arch = "aarch64"),
        all(target_os = "windows", target_arch = "x86_64"),
    )))]
    { "" }
}
```

### Pattern 3: Distribution Resolution (Priority Walk)

```rust
// Source: CONTEXT.md locked decision + live registry schema [VERIFIED]
fn resolve_distribution(dist: &AgentDistribution) -> Option<ResolvedLaunchCommand> {
    // 1. npx (preferred)
    if let Some(npx) = &dist.npx {
        let mut args = npx.args.clone().unwrap_or_default();
        args.insert(0, npx.package.clone());
        return Some(ResolvedLaunchCommand { cmd: "npx".to_string(), args });
    }
    // 2. binary (compile-time target key)
    if let Some(binary_map) = &dist.binary {
        let key = current_binary_target_key();
        if !key.is_empty() {
            if let Some(target) = binary_map.get(key) {
                let args = target.args.clone().unwrap_or_default();
                return Some(ResolvedLaunchCommand { cmd: target.cmd.clone(), args });
            }
        }
    }
    // 3. uvx (last resort)
    if let Some(uvx) = &dist.uvx {
        let mut args = uvx.args.clone().unwrap_or_default();
        args.insert(0, uvx.package.clone());
        return Some(ResolvedLaunchCommand { cmd: "uvx".to_string(), args });
    }
    None
}
```

### Pattern 4: IPC Command Registration

New commands must be added to `collect_commands!` in `lib.rs`:

```rust
// Source: lib.rs pattern [VERIFIED: file read]
// ACP registry (Phase 45)
crate::ipc::fetch_agent_registry,
crate::ipc::resolve_agent_launch_command,
```

### Anti-Patterns to Avoid

- **Holding the cache lock across the network fetch:** Lock, check cache, drop guard, fetch, re-lock to write. Holding the lock during an async HTTP call would block all other IPC commands that need the cache. The pattern above acquires the lock once, checks, and only re-acquires after the fetch completes.
- **Using `std::time::SystemTime` for TTL:** `Instant` is monotonic and cannot go backward; `SystemTime` can on system clock adjustments. [ASSUMED: standard Rust guidance]
- **`println!` in Rust code:** CLAUDE.md strictly forbids all Rust logging (`println!`, `eprintln!`, `tracing::`, `log::`) — errors surface via `Result<T, String>` IPC returns only. [VERIFIED: CLAUDE.md + STATE.md]
- **`unwrap()` in IPC handlers:** All handlers use `map_err(|e| format!(...))` + `?`. [VERIFIED: acp_handlers.rs pattern]

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| HTTP GET with JSON body | Custom HTTP client | `reqwest::Client::new().get(url).send().await?.json::<T>().await?` | TLS, redirect, timeout, connection pool all handled |
| JSON deserialization | Manual field parsing | `#[derive(Deserialize)]` + `.json::<AcpRegistry>()` | serde handles optional fields, arrays, nested objects |
| TypeScript type generation | Manual type sync | `#[derive(TS)]` + `#[ts(export)]` + `pnpm tauri:gen` | tauri-specta generates exact types from Rust structs |
| Async mutex for AppState field | Custom lock | `tokio::sync::Mutex<Option<RegistryCacheEntry>>` | Matches all existing session map fields in AppState |

---

## Critical Schema Finding: Live Registry Has Extra Fields

**This is the most important discovery from this research.**

The live registry JSON includes optional fields on `NpxDistribution`, `BinaryTarget`, and `UvxDistribution` that are NOT currently in the `acp/registry.rs` structs. If not added, `serde_json` will silently ignore unknown fields by default (since `#[serde(deny_unknown_fields)]` is not set), so deserialization will NOT fail — but the `args` and `env` data will be lost, meaning launch commands will be missing required arguments.

| Distribution Type | Current Fields | Live Registry Additional Fields | Action Required |
|---|---|---|---|
| `NpxDistribution` | `package: String` | `args: Vec<String>` (optional), `env: HashMap<String, String>` (optional) | Add `args` + `env` with `#[serde(default)]` |
| `BinaryTarget` | `archive: String`, `cmd: String` | `args: Vec<String>` (optional) | Add `args` with `#[serde(default)]` |
| `UvxDistribution` | `package: String` | `args: Vec<String>` (optional) | Add `args` with `#[serde(default)]` |

[VERIFIED: live registry fetched at `https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json` on 2026-04-21]

Without these `args` fields, calling `resolve_agent_launch_command` for claude-code (which passes `--acp` as an arg) would return a command without the required `--acp` flag, causing the subprocess to fail at runtime. This must be fixed in the same wave that extends the types with `#[derive(TS)]`.

---

## Common Pitfalls

### Pitfall 1: Lock Held Across Await Point

**What goes wrong:** Acquiring `tokio::sync::Mutex` guard before an `.await` point holds the lock during the entire network round-trip. Other IPC commands that need the cache (e.g., `resolve_agent_launch_command`) will block indefinitely.

**Why it happens:** Natural to write "lock, check, fetch if needed, write, return" as a single locked block.

**How to avoid:** Pattern is: lock → read snapshot → drop guard → (conditional fetch) → lock again → write. The code example in Pattern 1 above follows this.

**Warning signs:** `MutexGuard` variable lives across an `await` point — Rust's async checker will usually warn about this (cannot be held across await in async context).

### Pitfall 2: Missing `args` Field on NpxDistribution

**What goes wrong:** `resolve_agent_launch_command("claude-code")` returns `{ cmd: "npx", args: ["@anthropic-ai/claude-code"] }` instead of the correct `{ cmd: "npx", args: ["@anthropic-ai/claude-code", "--acp"] }`. The spawned process fails to start in ACP mode.

**Why it happens:** `NpxDistribution` in `acp/registry.rs` currently only has `package: String`, missing the `args` field from the live registry.

**How to avoid:** Add `args: Option<Vec<String>>` with `#[serde(default)]` to `NpxDistribution`, `BinaryTarget`, and `UvxDistribution` before implementing resolution logic.

**Warning signs:** Subprocess exits immediately with usage error after spawn.

### Pitfall 3: Binary Target Key Mismatch

**What goes wrong:** The live registry uses keys like `linux-x86_64` but code constructs `x86_64-unknown-linux-gnu` (Rust target triple format), causing every binary lookup to fail.

**Why it happens:** Assuming the key format without checking the live registry.

**How to avoid:** Use the verified key format from the live registry: `{os}-{arch}` where os is `darwin`/`linux`/`windows` and arch is `x86_64`/`aarch64`. [VERIFIED: live registry]

**Warning signs:** `resolve_agent_launch_command` always falls through to `uvx` fallback, even when binary targets are listed.

### Pitfall 4: reqwest Client Lifecycle

**What goes wrong:** Creating a new `reqwest::Client::new()` per request is acceptable for infrequent calls but wastes DNS lookups and TLS handshake overhead if called in quick succession.

**Why it happens:** Existing pattern in `settings_handlers.rs` uses per-request client because those IPC commands are user-triggered and infrequent.

**How to avoid:** For registry fetch, per-request is fine given the 5-min TTL. If a shared client is desired, add `reqwest_client: reqwest::Client` to AppState — `reqwest::Client` is `Clone` and designed for sharing. CONTEXT.md marks this as Claude's discretion.

**Warning signs:** Not a correctness issue — a minor performance preference.

### Pitfall 5: Force-Refresh Bypasses Only TTL, Not Stale-on-Error Path

**What goes wrong:** When `force_refresh: true` and the CDN is unreachable, should the handler still return stale data? If yes — this is correct behavior (best-effort). If no — returns Err even though cache exists.

**Why it happens:** The stale-on-error logic needs to be separate from the TTL bypass logic.

**How to avoid:** The stale-on-error path (return stale when CDN fails) should trigger regardless of `force_refresh`. The `force_refresh` flag only bypasses the TTL freshness check, not the CDN-failure fallback.

**Warning signs:** `force_refresh: true` with unreachable CDN returns `Err` instead of stale data.

---

## Code Examples

### AppState Extension

```rust
// Source: db/connection.rs existing pattern [VERIFIED: file read]
// Add to AppState struct:
pub agent_registry_cache: tokio::sync::Mutex<Option<RegistryCacheEntry>>,

// Add to AppState::new():
agent_registry_cache: tokio::sync::Mutex::new(None),
```

### New Type Definitions in acp/registry.rs

```rust
// Source: CONTEXT.md locked decisions + live registry schema [VERIFIED]
use specta::Type;
use ts_rs::TS;

/// Cache entry for the in-memory registry TTL cache.
/// Not exported to TypeScript — internal use only.
pub struct RegistryCacheEntry {
    pub registry: AcpRegistry,
    pub fetched_at: std::time::Instant,
}

/// IPC response wrapper — gives Phase 46 cache status context.
#[derive(Debug, Clone, Serialize, Deserialize, TS, Type)]
#[ts(export)]
pub struct RegistryResponse {
    pub agents: Vec<AgentInfo>,
    pub cached: bool,
    pub stale: bool,
}

/// Resolved launch command — passed directly to SpawnRequest subprocess args.
#[derive(Debug, Clone, Serialize, Deserialize, TS, Type)]
#[ts(export)]
pub struct ResolvedLaunchCommand {
    pub cmd: String,
    pub args: Vec<String>,
}
```

### Extended Distribution Types (Wave 0 change)

```rust
// Source: live registry schema [VERIFIED: fetch 2026-04-21]
#[derive(Debug, Clone, Serialize, Deserialize, TS, Type)]
#[ts(export)]
pub struct NpxDistribution {
    pub package: String,
    #[serde(default)]
    pub args: Option<Vec<String>>,
    #[serde(default)]
    pub env: Option<std::collections::HashMap<String, String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, Type)]
#[ts(export)]
pub struct BinaryTarget {
    pub archive: String,
    pub cmd: String,
    #[serde(default)]
    pub args: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, Type)]
#[ts(export)]
pub struct UvxDistribution {
    pub package: String,
    #[serde(default)]
    pub args: Option<Vec<String>>,
}
```

### reqwest Fetch Pattern

```rust
// Source: reqwest 0.13 docs [CITED: docs.rs/reqwest/0.13.2] + settings_handlers.rs pattern [VERIFIED]
const REGISTRY_URL: &str =
    "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";

pub async fn fetch_registry_from_cdn() -> Result<AcpRegistry, String> {
    let client = reqwest::Client::new();
    let registry: AcpRegistry = client
        .get(REGISTRY_URL)
        .send()
        .await
        .map_err(|e| format!("Registry CDN unreachable: {}", e))?
        .error_for_status()
        .map_err(|e| format!("Registry CDN returned error: {}", e))?
        .json::<AcpRegistry>()
        .await
        .map_err(|e| format!("Registry JSON parse failed: {}", e))?;
    Ok(registry)
}
```

### IPC Command Skeleton (acp_handlers.rs)

```rust
// Source: acp_handlers.rs existing IPC pattern [VERIFIED: file read]
#[tauri::command]
#[specta::specta]
pub async fn fetch_agent_registry(
    app_state: State<'_, Arc<AppState>>,
    force_refresh: bool,
) -> Result<RegistryResponse, String> {
    crate::acp::registry::fetch_or_return_cached(
        &app_state.agent_registry_cache,
        force_refresh,
    ).await
}

#[tauri::command]
#[specta::specta]
pub async fn resolve_agent_launch_command(
    app_state: State<'_, Arc<AppState>>,
    agent_id: String,
) -> Result<ResolvedLaunchCommand, String> {
    let guard = app_state.agent_registry_cache.lock().await;
    let entry = guard.as_ref()
        .ok_or_else(|| "Registry not loaded — call fetch_agent_registry first".to_string())?;
    let agent = entry.registry.agents.iter()
        .find(|a| a.id == agent_id)
        .ok_or_else(|| format!("Agent '{}' not found in registry", agent_id))?;
    crate::acp::registry::resolve_distribution(&agent.distribution)
        .ok_or_else(|| format!("No compatible distribution found for agent '{}'", agent_id))
}
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Per-request `reqwest::Client::new()` (sync) | Async `reqwest::Client` with connection pooling | reqwest 0.11+ | Connection reuse; for registry fetch (infrequent), per-request is acceptable |
| Manual JSON parsing | `serde_json` + `#[derive(Deserialize)]` | Pre-project | Robust, handles unknown fields gracefully |
| Runtime OS detection | `cfg(target_os)` compile-time macros | Rust stable | Zero runtime overhead; deterministic |

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Lock-drop-fetch-relock pattern is required to avoid holding Mutex across await | Common Pitfalls / Pattern 1 | If wrong (Rust allows it for tokio Mutex), code still correct but pattern unnecessarily complex — low risk |
| A2 | `#[serde(default)]` on `Option<Vec<String>>` fields silently ignores missing keys rather than failing | Code Examples | If wrong, registry deserialization would fail for agents lacking `args` — test with `cargo test` |
| A3 | Per-request `reqwest::Client::new()` is acceptable for the 5-min-TTL cache pattern | Architecture Patterns | If performance concern, switch to shared client in AppState — trivial change |

---

## Open Questions (RESOLVED)

1. **Should `resolve_agent_launch_command` auto-fetch the registry if cache is empty?**
   - What we know: The locked decision says it "looks up agent in cached registry" — implies registry must already be populated.
   - What's unclear: Should it transparently trigger a fetch on cache miss, or return a clear error telling the caller to call `fetch_agent_registry` first?
   - RESOLVED: Return a descriptive `Err("Registry not loaded — call fetch_agent_registry first")`. Phase 46 will call `fetch_agent_registry` as part of modal open; the resolver will always have a populated cache by the time it's called from Phase 49.

2. **Should `RegistryCacheEntry` be defined in `acp/registry.rs` or `db/connection.rs`?**
   - What we know: `connection.rs` owns AppState; `registry.rs` owns registry types.
   - RESOLVED: Define `RegistryCacheEntry` in `acp/registry.rs` (it's a registry concept), import it into `connection.rs` for the AppState field. This keeps registry logic in one file.

3. **`NpxDistribution.env` field — should it be passed to the subprocess?**
   - What we know: Phase 45 scope is only to resolve the `cmd` + `args`. Subprocess env injection is Phase 49 concern.
   - RESOLVED: Capture `env` in the type (so it roundtrips via TS bindings and Phase 49 can use it) but do not include it in `ResolvedLaunchCommand` in Phase 45. Add a `// TODO Phase 49: pass env to subprocess` comment.

---

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| `reqwest` crate | CDN fetch | ✓ | 0.13 (in Cargo.toml) | — |
| `tokio` | Async runtime | ✓ | 1.x (in Cargo.toml) | — |
| `serde_json` | JSON deserialization | ✓ | 1.x (in Cargo.toml) | — |
| CDN endpoint | Registry fetch in production | ✓ | Live (verified 2026-04-21) | Stale cache fallback |
| `pnpm tauri:gen` | TypeScript bindings | ✓ | Available on dev machine | — |

[VERIFIED: Cargo.toml read directly; CDN URL fetched successfully]

---

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Rust built-in `#[test]` (no external framework) |
| Config file | none — `cargo test` discovers `#[test]` attributes |
| Quick run command | `cd src-tauri && cargo test -- registry 2>&1` |
| Full suite command | `cd src-tauri && cargo test 2>&1` |

[VERIFIED: 17 existing tests pass via `cargo test -- --list`]

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| REGISTRY-01 | `fetch_agent_registry` returns `RegistryResponse` with agent list | unit (mock CDN) | `cargo test -- test_fetch_registry` | ❌ Wave 0 |
| REGISTRY-01 | `AcpRegistry` deserializes live registry JSON correctly | unit (static JSON fixture) | `cargo test -- test_registry_deserialization` | ❌ Wave 0 |
| REGISTRY-02 | Second call within 5 min returns `cached: true, stale: false` | unit | `cargo test -- test_registry_cache_hit` | ❌ Wave 0 |
| REGISTRY-02 | `force_refresh: true` bypasses TTL | unit | `cargo test -- test_registry_force_refresh` | ❌ Wave 0 |
| REGISTRY-02 | CDN failure with warm cache returns `stale: true` | unit | `cargo test -- test_registry_stale_on_cdn_failure` | ❌ Wave 0 |
| REGISTRY-03 | npx distribution resolves to `{ cmd: "npx", args: [package, ...] }` | unit | `cargo test -- test_resolve_npx` | ❌ Wave 0 |
| REGISTRY-03 | binary distribution resolves correct platform key | unit | `cargo test -- test_resolve_binary` | ❌ Wave 0 |
| REGISTRY-03 | uvx distribution resolves as last resort | unit | `cargo test -- test_resolve_uvx` | ❌ Wave 0 |
| REGISTRY-03 | agent with no compatible distribution returns `Err` | unit | `cargo test -- test_resolve_no_distribution` | ❌ Wave 0 |

### Sampling Rate

- **Per task commit:** `cd src-tauri && cargo test -- registry 2>&1`
- **Per wave merge:** `cd src-tauri && cargo test 2>&1`
- **Phase gate:** Full suite green + `pnpm tauri:gen` succeeds before `/gsd-verify-work`

### Wave 0 Gaps

- [ ] `src-tauri/src/acp/registry.rs` — extend with new types + add `#[cfg(test)] mod tests { ... }` block
- [ ] Test helper: static JSON fixture string representing a minimal valid `AcpRegistry` with npx/binary/uvx agents

---

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no | Registry is public CDN, no auth |
| V3 Session Management | no | No session involved |
| V4 Access Control | no | Registry is read-only public data |
| V5 Input Validation | yes | `agent_id` param on `resolve_agent_launch_command` — looked up in registry (no shell interpolation) |
| V6 Cryptography | no | No crypto in this phase |

### Known Threat Patterns

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Registry CDN compromise (malicious cmd/args) | Tampering | Phase 45 scope: resolve and return. Command execution (and thus injection risk) is in Phase 49 spawn flow — validation belongs there. Return `ResolvedLaunchCommand` as data, not executed. |
| `agent_id` injection via IPC | Tampering | Looked up in registry map by exact string match — no shell exec in this phase, no SQL in this phase. Safe. |
| CDN response too large / malformed JSON | DoS | `reqwest` has default body size limits; `serde` rejects malformed JSON. No explicit size guard needed for this phase. [ASSUMED] |

---

## Sources

### Primary (HIGH confidence)
- [VERIFIED: live CDN fetch] `https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json` — actual registry JSON schema, binary key format confirmed
- [VERIFIED: file read] `src-tauri/src/acp/registry.rs` — existing type definitions
- [VERIFIED: file read] `src-tauri/src/db/connection.rs` — AppState struct and `tokio::sync::Mutex` pattern
- [VERIFIED: file read] `src-tauri/src/ipc/acp_handlers.rs` — IPC command pattern
- [VERIFIED: file read] `src-tauri/src/lib.rs` — `collect_commands!` registration
- [VERIFIED: file read] `src-tauri/src/ipc/settings_handlers.rs` — existing reqwest per-request pattern
- [VERIFIED: file read] `src-tauri/src/ipc/filesystem_handlers.rs` — `cfg(target_os)` usage pattern
- [VERIFIED: file read] `src-tauri/Cargo.toml` — dependency versions confirmed

### Secondary (MEDIUM confidence)
- [CITED: docs.rs/reqwest/0.13.2] reqwest async GET + `.json::<T>()` + `.error_for_status()` API

### Tertiary (LOW confidence)
- None

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all dependencies verified in Cargo.toml; no new deps needed
- Architecture: HIGH — existing AppState pattern, existing IPC pattern, live registry schema verified
- Pitfalls: HIGH (lock-across-await, missing args field) / MEDIUM (reqwest client lifecycle)
- Test coverage: HIGH — test names and commands derived from locked requirement behaviors

**Research date:** 2026-04-21
**Valid until:** 2026-05-21 (CDN registry schema may evolve; re-verify if > 30 days)
