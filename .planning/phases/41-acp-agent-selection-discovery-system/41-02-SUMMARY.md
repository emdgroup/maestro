---
phase: 41-acp-agent-selection-discovery-system
plan: 02
subsystem: backend
tags: [rust, acp, tauri, client-trait, registry, session, transport]

# Dependency graph
requires:
  - 41-01 (maestro-protocol crate, Cargo workspace)
provides:
  - src-tauri/src/acp/ module with 5 files
  - MaestroAcpClient implementing ACP Client trait (stub methods, no panics)
  - AcpSession and SessionState for desktop-side session tracking
  - AgentInfo and AcpRegistry matching registry.json schema
  - Transport re-exports from maestro-protocol
affects: [41-03, 42]

# Tech tracking
tech-stack:
  added:
    - agent-client-protocol = "0.10.4" (ACP SDK with Client trait)
    - async-trait = "0.1" (required by ACP Client trait implementation)
    - maestro-protocol = { path = "../maestro-protocol" } (local wire protocol crate)
  patterns:
    - ACP Client trait with #[async_trait::async_trait(?Send)] — ?Send is mandatory (Rc<T> impls use Rc, not Arc)
    - Stub pattern: required methods return Err(acp::Error::method_not_found()); notification returns Ok(())
    - Registry types: serde flatten with Option<> fields for optional JSON schema fields

key-files:
  created:
    - src-tauri/src/acp/mod.rs
    - src-tauri/src/acp/client.rs
    - src-tauri/src/acp/session.rs
    - src-tauri/src/acp/registry.rs
    - src-tauri/src/acp/transport.rs
  modified:
    - src-tauri/Cargo.toml (3 deps added)
    - src-tauri/src/lib.rs (pub mod acp; added)

key-decisions:
  - "ACP Client trait is #[async_trait::async_trait(?Send)] — NOT Send-bounded; verified from SDK source before writing impl"
  - "request_permission and session_notification are the only REQUIRED methods in Client trait v0.10.4; all others have default Err(method_not_found()) impls"
  - "session_notification returns Ok(()) (it is a notification, no response) while request_permission returns Err(method_not_found()) (Phase 42 wires permission dialogs)"
  - "transport.rs re-exports all 13 maestro-protocol public symbols for convenient import in Phase 42"

# Metrics
duration: 2min
completed: 2026-04-17
---

# Phase 41 Plan 02: ACP Client Module for Tauri Desktop App Summary

**MaestroAcpClient stub implementing ACP Client trait with session/registry/transport types — cargo check -p maestro exits 0**

## Performance

- **Duration:** 2 min
- **Started:** 2026-04-17T17:20:43Z
- **Completed:** 2026-04-17T17:22:37Z
- **Tasks:** 2 (2/2)
- **Files modified:** 7

## Accomplishments

- Added `agent-client-protocol = "0.10.4"`, `async-trait = "0.1"`, and `maestro-protocol = { path = "../maestro-protocol" }` to `src-tauri/Cargo.toml`
- Added `pub mod acp;` to `src-tauri/src/lib.rs` alongside existing module declarations
- Created 5-file `src-tauri/src/acp/` module:
  - `mod.rs`: module root with sub-module declarations and pub re-exports
  - `client.rs`: `MaestroAcpClient` implementing ACP `Client` trait with `#[async_trait::async_trait(?Send)]`; required methods stubbed (no `todo!()`)
  - `session.rs`: `AcpSession` and `SessionState` enum for desktop-side session tracking
  - `registry.rs`: `AcpRegistry`, `AgentInfo`, `AgentDistribution`, `NpxDistribution`, `BinaryTarget`, `UvxDistribution` matching registry JSON schema
  - `transport.rs`: convenience re-exports of all 13 `maestro-protocol` public symbols
- `cargo check -p maestro` passes cleanly

## Task Commits

1. **Task 1: Add ACP deps to Cargo.toml, wire mod acp in lib.rs** — `a7329b4` (chore)
2. **Task 2: Create ACP module with client/session/registry/transport files** — `510112f` (feat)

## Files Created/Modified

- `src-tauri/Cargo.toml` — 3 dependencies added after `which = "8.0.2"`
- `src-tauri/src/lib.rs` — `pub mod acp;` added after `pub mod websocket;`
- `src-tauri/src/acp/mod.rs` — module root with 4 sub-modules and 4 pub re-exports
- `src-tauri/src/acp/client.rs` — `MaestroAcpClient` with `impl Client` (2 required methods stubbed)
- `src-tauri/src/acp/session.rs` — `AcpSession` struct + `SessionState` enum (6 variants)
- `src-tauri/src/acp/registry.rs` — 6 structs matching ACP registry JSON schema
- `src-tauri/src/acp/transport.rs` — 13 pub re-exports from maestro-protocol

## Decisions Made

- Inspected actual ACP SDK source (`~/.cargo/registry/src/.../agent-client-protocol-0.10.4/src/client.rs`) before writing the `impl` block to get exact method signatures. Found that `request_permission` and `session_notification` are the only two required methods; all others have default `Err(Error::method_not_found())` impls — so only those two need explicit method bodies.
- Used `#[async_trait::async_trait(?Send)]` matching the trait definition exactly (`?Send` annotation is significant — the SDK uses `Rc<T>` impls, not `Arc<T>` only).
- Stubbed `request_permission` with `Err(acp::Error::method_not_found())` — T-41-03 mitigated (no filesystem access possible in Phase 41).
- `session_notification` returns `Ok(())` per plan spec (notification, no response needed).

## Deviations from Plan

None — plan executed exactly as written. The ACP Client trait v0.10.4 API exactly matched the interfaces documented in the PLAN.md.

## Threat Surface Scan

| Flag | File | Description |
|------|------|-------------|
| No new threats | — | All Client methods return Err(method_not_found()) or Ok(()) — no new trust boundaries introduced in Phase 41 stubs |

T-41-03 (Elevation of Privilege via `read_text_file`) is mitigated: `MaestroAcpClient` inherits the default impl which returns `Err(Error::method_not_found())`, preventing any filesystem access.

## Self-Check: PASSED

- [x] `src-tauri/src/acp/mod.rs` exists
- [x] `src-tauri/src/acp/client.rs` exists
- [x] `src-tauri/src/acp/session.rs` exists
- [x] `src-tauri/src/acp/registry.rs` exists
- [x] `src-tauri/src/acp/transport.rs` exists
- [x] Commit `a7329b4` exists (Task 1)
- [x] Commit `510112f` exists (Task 2)
- [x] `cargo check -p maestro` exits 0

---
*Phase: 41-acp-agent-selection-discovery-system*
*Completed: 2026-04-17*
