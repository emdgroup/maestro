---
phase: 42
slug: maestro-server-activation
status: draft
nyquist_compliant: true
wave_0_complete: true
created: 2026-04-17
---

# Phase 42 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | cargo test (Rust) |
| **Config file** | `maestro-server/Cargo.toml`, `maestro-protocol/Cargo.toml` |
| **Quick run command** | `cargo test -p maestro-server -p maestro-protocol` |
| **Full suite command** | `cargo test -p maestro-server -p maestro-protocol --all-features` |
| **Estimated runtime** | ~10 seconds |

---

## Sampling Rate

- **After every task commit:** Run `cargo test -p maestro-server -p maestro-protocol`
- **After every plan wave:** Run `cargo test -p maestro-server -p maestro-protocol --all-features`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 42-01-01 | 01 | 1 | SERVER-01/04 | unit | `cargo test -p maestro-protocol roundtrip_permit_response` | Yes (in-file) | ⬜ pending |
| 42-01-02 | 01 | 1 | SERVER-01-04 | compile | `cargo check -p maestro-server` | Yes (client.rs, sessions.rs) | ⬜ pending |
| 42-01-03 | 01 | 1 | SERVER-01-04 | unit | `cargo test -p maestro-server` | Yes (tests.rs — Wave 0) | ⬜ pending |
| 42-02-01 | 02 | 2 | SERVER-01-04 | unit+compile | `cargo test -p maestro-server && cargo test -p maestro-protocol && cargo check --workspace` | Yes (tests.rs + agent.rs + main.rs) | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [x] `maestro-server/src/tests.rs` — 4 unit test stubs for SERVER-01 through SERVER-04 (created in Plan 42-01 Task 3)
- [x] `maestro-protocol/src/lib.rs` — protocol serialization tests (2 new tests added in Plan 42-01 Task 1, extending existing 12)

*Wave 0 test stubs cover protocol-level serialization and data structure behavior. Full async integration testing (live ACP agent subprocess) is documented under Manual-Only Verifications below.*

---

## Test Stubs (Wave 0)

Created in `maestro-server/src/tests.rs` by Plan 42-01 Task 3:

| Test Name | Requirement | What It Verifies |
|-----------|-------------|------------------|
| `test_permit_response_roundtrip` | SERVER-01, SERVER-04 | PermitResponse serde + wire framing roundtrip |
| `test_session_notification_writes_stdout` | SERVER-02 | SessionUpdate response wire framing with JSON payload |
| `test_terminal_output_frame` | SERVER-03 | TerminalOutput response wire framing with binary bytes |
| `test_permission_pause_creates_pending_entry` | SERVER-04 | oneshot channel insert/remove/resolve pattern + PermissionRequest wire format |

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Agent subprocess spawns and sends back real session events | SERVER-01, SERVER-02 | Requires live Claude agent subprocess | Run maestro-server, pipe a SpawnRequest JSON, verify ServerResponse frames on stdout |
| PTY raw output streams in real-time | SERVER-03 | Requires live PTY + agent | Same end-to-end run, watch TerminalOutput frames |
| Permission pause/unblock round-trip | SERVER-04 | Requires live permission trigger | Same run, trigger a file write permission, send PermissionResponse, verify agent unblocks |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency < 15s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** approved (revision pass)
