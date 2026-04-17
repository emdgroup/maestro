---
phase: 41-acp-agent-selection-discovery-system
plan: 03
subsystem: infra
tags: [rust, cargo, tokio, acp, maestro-server, binary-crate]

# Dependency graph
requires:
  - phase: 41-01
    provides: "maestro-protocol crate with MaestroRpcMessage types and length-prefixed framing"
provides:
  - maestro-server binary crate with real Cargo.toml (agent-client-protocol 0.10.4, tokio-util compat, futures, async-trait)
  - main.rs with tokio current_thread runtime + LocalSet skeleton ready for Phase 42 ACP wiring
  - ELF binary at target/debug/maestro-server
affects: [42-acp-agent-spawning, maestro-server]

# Tech tracking
tech-stack:
  added:
    - agent-client-protocol 0.10.4 (ACP Rust SDK, added to maestro-server)
    - tokio-util 0.7 with compat feature (tokio::io <-> futures::io bridge, explicit dep in maestro-server)
    - futures 0.3 (AsyncRead/AsyncWrite traits used by ACP SDK, explicit dep in maestro-server)
    - async-trait 0.1 (required for Client trait impl, explicit dep in maestro-server)
  patterns:
    - "tokio current_thread + LocalSet: required runtime flavor for !Send ACP Client futures in maestro-server"
    - "tokio-util compat explicit dep: even though futures are transitive, compat feature bridge must be explicit for Phase 42 stdio wiring"

key-files:
  created: []
  modified:
    - maestro-server/Cargo.toml
    - maestro-server/src/main.rs

key-decisions:
  - "[Phase 41-03]: Use tokio current_thread flavor + LocalSet in maestro-server main so Phase 42 can use spawn_local for !Send ACP Client futures"
  - "[Phase 41-03]: Add tokio-util with compat feature explicitly (not just transitively) so Phase 42 can use TokioAsyncReadCompatExt/TokioAsyncWriteCompatExt to bridge tokio::process stdio to futures::io traits required by ClientSideConnection::new()"
  - "[Phase 41-03]: futures crate added as explicit dep (already transitive via ACP SDK) for documentation clarity and to guard against transitive dep removal"

patterns-established:
  - "maestro-server runtime: #[tokio::main(flavor = \"current_thread\")] + LocalSet::run_until — all ACP client work must run in this context"

requirements-completed: []

# Metrics
duration: 2min
completed: 2026-04-17
---

# Phase 41 Plan 03: maestro-server Binary Crate Skeleton Summary

**maestro-server binary crate with real Cargo.toml (agent-client-protocol 0.10.4, tokio-util compat, futures) and current_thread+LocalSet main.rs skeleton; cargo build -p maestro-server exits 0**

## Performance

- **Duration:** 2 min
- **Started:** 2026-04-17T17:24:23Z
- **Completed:** 2026-04-17T17:26:05Z
- **Tasks:** 1 (1/1)
- **Files modified:** 2 (+ Cargo.lock updated)

## Accomplishments

- Overwrote placeholder `maestro-server/Cargo.toml` with full dependency set: `agent-client-protocol 0.10.4`, `tokio full`, `tokio-util 0.7 compat`, `serde_json 1`, `async-trait 0.1`, `futures 0.3`, with `description` and `license = "GPL-3.0-only"` fields
- Overwrote placeholder `maestro-server/src/main.rs` with real skeleton: `#[tokio::main(flavor = "current_thread")]` + `LocalSet::new().run_until(...)` + compile-time `MaestroRpcMessage` import check; no `todo!()` panics
- `cargo build -p maestro-server` exits 0; ELF binary produced at `target/debug/maestro-server`
- `cargo check --workspace` exits 0

## Task Commits

1. **Task 1: Write real maestro-server Cargo.toml and main.rs** - `ce30542` (feat)

**Plan metadata:** (docs commit follows)

## Files Created/Modified

- `maestro-server/Cargo.toml` - Full dependency manifest with ACP SDK, tokio-util compat, futures, description, license
- `maestro-server/src/main.rs` - tokio current_thread runtime with LocalSet skeleton and inline Phase 42 roadmap comments
- `Cargo.lock` - Updated with new resolved deps (agent-client-protocol, tokio-util compat, futures, async-trait, etc.)

## Decisions Made

- Used `tokio current_thread` flavor so the entire `maestro-server` process runs in a single-threaded context, making `spawn_local` available for `!Send` ACP `Client` futures (Phase 42 requirement)
- Added `tokio-util` and `futures` as explicit (not just transitive) deps so Phase 42 authors have a clear, stable dep surface when wiring `tokio::process::Command` stdio via `TokioAsyncReadCompatExt`
- `async-trait` made explicit even though it is transitive — macro proc-macro crates can have visibility issues in some resolver configurations

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None. Build succeeded on first run with all new dependencies resolved cleanly.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- `maestro-server` binary crate is fully ready for Phase 42 activation
- Phase 42 will replace the `let _: Option<MaestroRpcMessage> = None;` placeholder with real stdin reader + ACP agent spawning via `ClientSideConnection::new()`
- All required deps are present and locked: `agent-client-protocol 0.10.4`, `tokio-util compat`, `futures`, `async-trait`
- No blockers

---
*Phase: 41-acp-agent-selection-discovery-system*
*Completed: 2026-04-17*
