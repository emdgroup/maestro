# Phase 45: Agent Registry Fetch + Caching — Context

**Gathered:** 2026-04-21
**Status:** Ready for planning

<domain>
## Phase Boundary

Tauri backend can fetch the ACP agent registry from the CDN, cache it in AppState with a 5-minute TTL, and resolve a concrete launch command for any agent in the registry.

Pure Rust backend — no UI, no schema changes, no SSH. Three IPC commands exposed to frontend with TypeScript bindings.

Out of scope: Agent Selector UI (Phase 46), dual-mode dispatch (Phase 49), remote ACP (v2).

</domain>

<decisions>
## Implementation Decisions

### Distribution Priority

Resolution order when an agent has multiple distributions:
1. `npx` — preferred; Node.js is present on dev machines; most agents (including claude-acp) are npm packages
2. `binary` — fallback if no npx; use compile-time target selection (`cfg(target_os)` / `cfg(target_arch)`) to pick the correct binary key
3. `uvx` — last resort

If no compatible distribution is found, return an error for that agent's `resolve_agent_launch_command` call.

Binary target key selection: compile-time via Rust cfg macros — no runtime OS/arch detection. Simple and deterministic.

### CDN Failure Behavior

- **Cache exists (even expired):** Return stale registry with a staleness flag — `RegistryResponse { agents: Vec<AgentInfo>, cached: bool, stale: bool }`. Phase 46 can show a subtle "cached" indicator.
- **No cache, CDN unreachable:** Return `Err(...)` — propagate to frontend. Frontend shows error state. Honest — we have nothing.
- Force-refresh (REGISTRY-02): separate boolean param on `fetch_agent_registry` IPC — `force_refresh: bool`. When true, bypass TTL check and re-fetch.

### TypeScript Bindings

- `AgentInfo`, `AgentDistribution`, `NpxDistribution`, `BinaryTarget`, `UvxDistribution` all get `#[derive(TS)]` + `#[ts(export)]`
- `RegistryResponse` (response wrapper) also gets `#[derive(TS)]`
- Resolved launch command type: `ResolvedLaunchCommand { cmd: String, args: Vec<String> }` — also `#[derive(TS)]`
- Run `pnpm tauri:gen` at end of phase — Phase 46 gets typed access immediately

### IPC Surface

Three IPC commands:

1. `fetch_agent_registry(force_refresh: bool)` → `Result<RegistryResponse, String>`
   - Returns full `Vec<AgentInfo>` (name, description, icon, id — everything Phase 46 needs to render)
   - Respects 5-min TTL; force_refresh bypasses it
   - On network error with stale cache: return stale with flag

2. `resolve_agent_launch_command(agent_id: String)` → `Result<ResolvedLaunchCommand, String>`
   - Looks up agent in cached registry by id
   - Resolves distribution using priority: npx → binary → uvx
   - Returns `{ cmd: String, args: Vec<String> }` ready for use in SpawnRequest

3. No separate "list agents" — `fetch_agent_registry` returns the full list.

### AppState Extension

Add to AppState:
```rust
pub agent_registry_cache: tokio::sync::Mutex<Option<RegistryCacheEntry>>
```

Where `RegistryCacheEntry = { registry: AcpRegistry, fetched_at: std::time::Instant }`.

5-minute TTL checked by comparing `Instant::now() - fetched_at > Duration::from_secs(300)`.

### Claude's Discretion

- Exact Rust module layout within `acp/registry.rs` (IPC handler location: likely `ipc/acp_handlers.rs` or new `ipc/registry_handlers.rs`)
- reqwest client lifecycle: shared client in AppState vs per-request
- Error message strings for missing distributions, CDN failures

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### ACP Registry
- `https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json` — Live registry; fetch and inspect the actual JSON schema before implementing deserialization
- `.planning/requirements.md` §REGISTRY-01, REGISTRY-02, REGISTRY-03 — Acceptance criteria for this phase

### Existing Code (read before modifying)
- `src-tauri/src/acp/registry.rs` — Existing `AcpRegistry`, `AgentInfo`, `AgentDistribution` types; Phase 45 extends these with `#[derive(TS)]` and adds cache + IPC
- `src-tauri/src/db/connection.rs` — `AppState` struct; add `agent_registry_cache` field here
- `src-tauri/src/ipc/acp_handlers.rs` — Existing ACP IPC commands; registry handlers go here or in a new `registry_handlers.rs`
- `src-tauri/src/lib.rs` — `collect_commands!` macro; new IPC commands must be registered here
- `src-tauri/Cargo.toml` — `reqwest = { version = "0.13", default-features = true, features = ["json"] }` already present

### Type Generation
- `CLAUDE.md` §Type Generation Workflow — Steps for adding `#[derive(TS)]` and regenerating bindings

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `reqwest` v0.13 with `json` feature: already in `src-tauri/Cargo.toml` — no new dependency needed
- `acp/registry.rs`: `AcpRegistry`, `AgentInfo`, `AgentDistribution`, `NpxDistribution`, `BinaryTarget`, `UvxDistribution` types all exist — extend with derives, don't rewrite
- `ipc/acp_handlers.rs`: existing ACP IPC module — cleanest place to add `fetch_agent_registry` and `resolve_agent_launch_command`

### Established Patterns
- AppState fields use `tokio::sync::Mutex<HashMap<...>>` for async session maps; registry cache follows same pattern with `Mutex<Option<RegistryCacheEntry>>`
- IPC commands return `Result<T, String>` — errors serialized as strings for Tauri
- No Rust logging (`println!`, `tracing::`, etc.) — errors surface via IPC return values only
- `collect_commands!` in `lib.rs` registers all IPC handlers — new commands added there

### Integration Points
- `AppState` in `db/connection.rs` — add `agent_registry_cache` field + initialize to `None` in `AppState::new()`
- `lib.rs` `collect_commands!` — register `fetch_agent_registry` and `resolve_agent_launch_command`
- `src/types/bindings.ts` — generated output; Phase 46 imports `AgentInfo`, `RegistryResponse`, `ResolvedLaunchCommand` from here

</code_context>

<specifics>
## Specific Ideas

- `RegistryResponse` should include `{ agents: Vec<AgentInfo>, cached: bool, stale: bool }` — gives Phase 46 enough context to show cache status without extra IPC calls
- `ResolvedLaunchCommand { cmd: String, args: Vec<String> }` maps cleanly to what `spawn_acp_session` needs to build its subprocess command
- Binary target key format in the live registry: check actual JSON before assuming key names (may be "linux-x86_64", "x86_64-unknown-linux-gnu", or other format)

</specifics>

<deferred>
## Deferred Ideas

- Remote ACP registry deployment (SFTP upload, version check) — v2 REMOTE-01/02/03
- Registry UI with filtering by capability/language — v2 REGUI-01
- Per-task default agent assignment on Kanban — v2 REGUI-02
- Registry persistence across app restarts (write to SQLite or .maestro/ file) — currently in-memory only; could be useful but out of scope

</deferred>

---

*Phase: 45-agent-registry-fetch-caching*
*Context gathered: 2026-04-21*
