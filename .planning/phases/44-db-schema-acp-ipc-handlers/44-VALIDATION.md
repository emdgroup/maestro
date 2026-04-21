---
phase: 44
slug: db-schema-acp-ipc-handlers
status: draft
nyquist_compliant: true
wave_0_complete: true
created: 2026-04-20
---

# Phase 44 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | cargo test (Rust) |
| **Config file** | src-tauri/Cargo.toml |
| **Quick run command** | `cd src-tauri && cargo test` |
| **Full suite command** | `cd src-tauri && cargo test && cd .. && pnpm test` |
| **Estimated runtime** | ~30 seconds |

---

## Sampling Rate

- **After every task commit:** Run `cd src-tauri && cargo test`
- **After every plan wave:** Run `cd src-tauri && cargo test && cd .. && pnpm test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 30 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 44-01-00 | 01 | 1 | PERSIST-02, PERSIST-05 | unit (Wave 0) | `cd src-tauri && cargo test test_spawn_acp_session_creates_log test_cancel_acp_session_updates_status` | Created by Task 0 | pending |
| 44-01-01 | 01 | 1 | PERSIST-01 | unit | `cd src-tauri && cargo test test_schema_initialization` | Yes | pending |
| 44-01-02 | 01 | 1 | PERSIST-02, PERSIST-03, PERSIST-04, PERSIST-05 | unit + compile | `cd src-tauri && cargo check && cargo test` | Yes | pending |
| 44-02-01 | 02 | 2 | PERSIST-06 | compile + existing tests | `cd src-tauri && cargo check && cargo test` | Yes | pending |
| 44-02-02 | 02 | 2 | — | build | `pnpm tauri:gen && pnpm build` | Yes | pending |

*Status: pending / green / red / flaky*

---

## Wave 0 Requirements

Plan 44-01 Task 0 creates two behavioral tests as Wave 0 scaffolds:

- `test_spawn_acp_session_creates_log` (PERSIST-02) — in-memory SQLite, executes the same INSERT SQL as `spawn_acp_session`, asserts `execution_mode='acp'` and `agent_id` are written correctly.
- `test_cancel_acp_session_updates_status` (PERSIST-05) — in-memory SQLite, executes the same UPDATE SQL as `cancel_acp_session`, asserts `status='cancelled'` and `completed_at` are set.

Both tests are in `src-tauri/src/ipc/acp_handlers.rs` `#[cfg(test)] mod tests`.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| send_acp_prompt forwards payload to maestro-server stdin | PERSIST-03 | Requires running maestro-server process | Start session, call send_acp_prompt, verify server receives message |
| respond_acp_permission forwards payload | PERSIST-04 | Requires running maestro-server process | Start session with pending permission, call respond_acp_permission, verify forwarded |
| Structured output flush cycle (accumulate, 10s write, final flush) | PERSIST-06 | Requires running maestro-server producing SessionUpdate messages + 10s wait | Start ACP session, let agent produce output, wait >10s, verify structured_output column populated; then cancel session and verify final flush writes remaining updates. The flush SQL uses the same parameterized UPDATE pattern verified by the PERSIST-02/PERSIST-05 unit tests. |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references (PERSIST-02, PERSIST-05)
- [x] No watch-mode flags
- [x] Feedback latency < 30s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
