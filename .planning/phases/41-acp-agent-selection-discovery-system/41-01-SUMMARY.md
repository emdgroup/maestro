---
phase: 41-acp-agent-selection-discovery-system
plan: 01
subsystem: infra
tags: [rust, cargo, workspace, serde, tokio, wire-protocol]

# Dependency graph
requires: []
provides:
  - Cargo workspace root with three members (src-tauri, maestro-server, maestro-protocol)
  - maestro-protocol crate with complete wire protocol types and framing
  - Cargo.lock at workspace root
affects: [41-02, 41-03, maestro-server, maestro-protocol]

# Tech tracking
tech-stack:
  added:
    - maestro-protocol (new crate; serde 1, serde_json 1, tokio 1 io-util+macros+rt)
    - maestro-server (placeholder crate; depends on maestro-protocol)
  patterns:
    - Internally-tagged serde enums: `#[serde(tag = "direction")]` on MaestroRpcMessage disambiguates Request vs Response
    - Internally-tagged inner enums: `#[serde(tag = "type")]` on ServerRequest and ServerResponse for variant dispatch
    - Length-prefixed framing: 4-byte LE u32 length prefix + JSON body; MAX_MESSAGE_SIZE guard before allocation

key-files:
  created:
    - Cargo.toml (workspace root)
    - maestro-protocol/Cargo.toml
    - maestro-protocol/src/lib.rs
    - maestro-server/Cargo.toml
    - maestro-server/src/main.rs
  modified:
    - Cargo.lock (moved from src-tauri/ to repo root)

key-decisions:
  - "[Phase 41-01]: Use #[serde(tag = \"direction\")] on MaestroRpcMessage to distinguish Request/Response without serde untagged ambiguity pitfall"
  - "[Phase 41-01]: 16 MB MAX_MESSAGE_SIZE guard in read_message before body buffer allocation — T-41-01 DoS mitigation"
  - "[Phase 41-01]: maestro-server placeholder (fn main() {}) created in this plan so cargo check --workspace passes; Plan 03 overwrites with real implementation"
  - "[Phase 41-01]: tokio features io-util+macros+rt added to maestro-protocol so #[tokio::test] works without requiring full tokio feature set"

patterns-established:
  - "Wire protocol serde: internally-tagged direction+type double-tagging for unambiguous JSON round-trips"
  - "Length-prefixed framing: write_message/read_message over AsyncWrite/AsyncRead with DoS size guard"

requirements-completed: []

# Metrics
duration: 4min
completed: 2026-04-17
---

# Phase 41 Plan 01: Cargo Workspace and maestro-protocol Wire Protocol Crate Summary

**Cargo workspace with three members, maestro-protocol crate defining 10 wire protocol types, length-prefixed JSON framing, and 12 passing roundtrip/security tests**

## Performance

- **Duration:** 4 min
- **Started:** 2026-04-17T17:13:28Z
- **Completed:** 2026-04-17T17:18:42Z
- **Tasks:** 1 (1/1)
- **Files modified:** 6

## Accomplishments

- Root `Cargo.toml` workspace with `src-tauri`, `maestro-server`, and `maestro-protocol` members using resolver "2"
- `maestro-protocol` crate exports `MaestroRpcMessage`, `ServerRequest`, `ServerResponse`, and 8 payload structs with fully typed serde serialization
- `write_message`/`read_message` async framing functions with 16 MB DoS guard (T-41-01 mitigated)
- All 12 tests pass: 9 JSON roundtrip tests, 1 TCP framing test, 1 oversized-rejection test, 1 direction-disambiguation test
- `src-tauri/Cargo.lock` moved to repo root; `cargo check --workspace` exits 0

## Task Commits

1. **Task 1: Create Cargo workspace root, move Cargo.lock, scaffold maestro-protocol crate** - `c64e308` (feat)

**Plan metadata:** (docs commit follows)

## Files Created/Modified

- `Cargo.toml` - Workspace root with `[workspace]` and three members
- `Cargo.lock` - Moved from `src-tauri/Cargo.lock` to workspace root
- `maestro-protocol/Cargo.toml` - Protocol crate manifest with serde + serde_json + tokio io-util
- `maestro-protocol/src/lib.rs` - All 10 types, framing functions, 12 tests
- `maestro-server/Cargo.toml` - Placeholder manifest depending on maestro-protocol
- `maestro-server/src/main.rs` - Placeholder `fn main() {}` (Plan 03 overwrites)

## Decisions Made

- Used `#[serde(tag = "direction", rename_all = "snake_case")]` on the top-level `MaestroRpcMessage` enum to distinguish `request` vs `response` at the JSON level, avoiding `#[serde(untagged)]` ambiguity (RESEARCH.md Pitfall 4)
- Added `tokio` features `io-util + macros + rt` to `maestro-protocol/Cargo.toml` so `#[tokio::test]` works in the crate's own tests without pulling in the full tokio feature set
- Created a minimal `maestro-server` placeholder so `cargo check --workspace` succeeds now; Plan 03 overwrites `main.rs` with the real server implementation

## Deviations from Plan

None - plan executed exactly as written. All files were already created correctly; tests pass, workspace check passes.

## Issues Encountered

None. The workspace files were already scaffolded correctly. Tests passed on first run.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- `maestro-protocol` types are ready for Plans 02 and 03 to consume
- Plan 02 (desktop-side ACP client) can import `MaestroRpcMessage`, `write_message`, `read_message` from `maestro-protocol`
- Plan 03 (maestro-server) can depend on `maestro-protocol = { path = "../maestro-protocol" }` and overwrite the placeholder `main.rs`
- No blockers

---
*Phase: 41-acp-agent-selection-discovery-system*
*Completed: 2026-04-17*
