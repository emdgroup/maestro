---
phase: 45-agent-registry-fetch-caching
plan: "02"
subsystem: backend-ipc
tags: [acp, registry, ipc, typescript-bindings]
dependency_graph:
  requires: [45-01]
  provides: [fetch_agent_registry IPC, resolve_agent_launch_command IPC, TypeScript registry types]
  affects: [src/types/bindings.ts, src-tauri/src/ipc/acp_handlers.rs, src-tauri/src/lib.rs]
tech_stack:
  added: []
  patterns: [tauri-specta IPC registration, specta type export]
key_files:
  created: []
  modified:
    - src-tauri/src/ipc/acp_handlers.rs
    - src-tauri/src/lib.rs
    - src/types/bindings.ts
decisions:
  - "fetch_agent_registry delegates entirely to acp::registry::fetch_or_return_cached — handler is a thin IPC boundary with no logic"
  - "resolve_agent_launch_command holds cache lock only during the lookup — no await across the guard"
  - "AcpRegistry not in bindings.ts: tauri-specta only exports types reachable from registered IPC command signatures; RegistryResponse is the IPC boundary type"
metrics:
  duration: 0.067h
  completed: "2026-04-21"
  tasks: 2
  files: 3
---

# Phase 45 Plan 02: IPC Command Wiring + TypeScript Bindings Summary

Two new Tauri IPC commands registered — `fetch_agent_registry` (TTL-cached CDN fetch) and `resolve_agent_launch_command` (in-memory lookup + distribution resolution) — with TypeScript bindings regenerated to expose 7 new types.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Add IPC commands to acp_handlers.rs and register in lib.rs | e3fb29e | acp_handlers.rs, lib.rs |
| 2 | Regenerate TypeScript bindings and verify full test suite | 987c1e1 | bindings.ts |

## Verification Results

- `cargo check`: passes (0 errors, 0 warnings beyond workspace profile note)
- `cargo test`: 24/24 tests pass (7 registry tests + 6 acp_handlers tests + 11 others)
- `pnpm tauri:gen`: TypeScript bindings generated successfully
- `pnpm build`: frontend compiles with new bindings (exit 0)

### TypeScript Bindings Verification

| Type | Present | Fields |
|------|---------|--------|
| `RegistryResponse` | Yes | `agents: AgentInfo[]`, `cached: boolean`, `stale: boolean` |
| `ResolvedLaunchCommand` | Yes | `cmd: string`, `args: string[]` |
| `AgentInfo` | Yes | `id`, `name`, `version`, `description?`, `repository?`, `authors?`, `license?`, `icon?`, `website?`, `distribution` |
| `AgentDistribution` | Yes | `npx?`, `binary?`, `uvx?` |
| `NpxDistribution` | Yes | `package: string`, `args?: string[] \| null`, `env?: Partial<...> \| null` |
| `BinaryTarget` | Yes | `archive: string`, `cmd: string`, `args?: string[] \| null` |
| `UvxDistribution` | Yes | `package: string`, `args?: string[] \| null` |

Commands object entries:
- `fetchAgentRegistry(forceRefresh: boolean)` — present
- `resolveAgentLaunchCommand(agentId: string)` — present

## Deviations from Plan

None — plan executed exactly as written.

## Threat Surface Scan

No new network endpoints or auth paths introduced beyond what Plan 01 already established. Both commands are read-only (fetch registry data, resolve a launch command string). The `agent_id` exact-match lookup in `resolve_agent_launch_command` has no shell interpolation or path traversal — mitigates T-45-05 as planned.

## Self-Check: PASSED

Files created/modified:
- `src-tauri/src/ipc/acp_handlers.rs` — FOUND (contains `fetch_agent_registry` and `resolve_agent_launch_command`)
- `src-tauri/src/lib.rs` — FOUND (contains both new IPC registrations)
- `src/types/bindings.ts` — FOUND (contains `RegistryResponse`, `ResolvedLaunchCommand`, `fetchAgentRegistry`, `resolveAgentLaunchCommand`)

Commits:
- e3fb29e — FOUND
- 987c1e1 — FOUND
