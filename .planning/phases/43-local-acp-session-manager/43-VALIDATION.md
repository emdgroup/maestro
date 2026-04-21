---
phase: 43
slug: local-acp-session-manager
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-04-20
---

# Phase 43 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | cargo test (Rust unit tests) |
| **Config file** | src-tauri/Cargo.toml |
| **Quick run command** | `cd src-tauri && cargo test` |
| **Full suite command** | `cd src-tauri && cargo test && cd .. && pnpm test` |
| **Estimated runtime** | ~30 seconds |

---

## Sampling Rate

- **After every task commit:** Run `cd src-tauri && cargo check`
- **After every plan wave:** Run `cd src-tauri && cargo test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 30 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 43-01-01 | 01 | 1 | SESSION-01 | compile | `cd src-tauri && cargo check` | ✅ | ⬜ pending |
| 43-01-02 | 01 | 1 | SESSION-01 | compile | `cd src-tauri && cargo check` | ✅ | ⬜ pending |
| 43-01-03 | 01 | 2 | SESSION-02 | compile | `cd src-tauri && cargo check` | ✅ | ⬜ pending |
| 43-01-04 | 01 | 2 | SESSION-02 | compile | `cd src-tauri && cargo check` | ✅ | ⬜ pending |
| 43-01-05 | 01 | 3 | SESSION-03 | compile | `cd src-tauri && cargo check` | ✅ | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

*Existing infrastructure covers all phase requirements — cargo test already present.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| maestro-server spawns and IPC command returns log_id | SESSION-01 | Requires running Tauri app | Launch app, call `start_acp_session` IPC, verify log_id returned |
| Tauri events emitted with correct format | SESSION-02 | Requires running frontend listener | Listen for `acp://session-update/{log_id}`, verify payload shape |
| Session cleanup on process exit | SESSION-03 | Requires process lifecycle | Kill maestro-server subprocess, verify acp_sessions map cleaned |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
