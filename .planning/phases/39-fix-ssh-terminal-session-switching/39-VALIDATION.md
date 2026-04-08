---
phase: 39
slug: fix-ssh-terminal-session-switching
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-04-08
---

# Phase 39 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest (frontend), cargo test (Rust) |
| **Config file** | `vite.config.ts` (Vitest), `src-tauri/Cargo.toml` |
| **Quick run command** | `pnpm test --run` |
| **Full suite command** | `pnpm test --run && cd src-tauri && cargo test` |
| **Estimated runtime** | ~15 seconds |

---

## Sampling Rate

- **After every task commit:** Run `pnpm test --run`
- **After every plan wave:** Run `pnpm test --run && cd src-tauri && cargo test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 39-01-01 | 01 | 1 | SSH history trim | unit | `cd src-tauri && cargo test test_append_to_history` | ❌ W0 | ⬜ pending |
| 39-01-02 | 01 | 1 | SshPtyHandle struct | compile | `cd src-tauri && cargo check` | ✅ | ⬜ pending |
| 39-01-03 | 01 | 1 | attach_terminal live/dead | compile | `cd src-tauri && cargo check` | ✅ | ⬜ pending |
| 39-01-04 | 01 | 1 | DB write on exit | compile | `cd src-tauri && cargo check` | ✅ | ⬜ pending |
| 39-02-01 | 02 | 2 | cancel token detach | compile | `cd src-tauri && cargo check` | ✅ | ⬜ pending |
| 39-02-02 | 02 | 2 | shutdown hook DB flush | compile | `cd src-tauri && cargo check` | ✅ | ⬜ pending |
| 39-03-01 | 03 | 3 | rAF reorder | manual | Open app, switch sessions | ✅ | ⬜ pending |
| 39-03-02 | 03 | 3 | clear-screen guard | manual | Open app, switch sessions | ✅ | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src-tauri/src/ssh/session_tests.rs` (or inline `#[cfg(test)]` in session.rs) — unit tests for `append_to_history` helper: (a) `\x1b[2J` mid-chunk drops prefix, (b) `\x1b[2J` at end of chunk drops entire prior history, (c) byte-cap trim preserves `\r\n` boundary, (d) no clear-screen → append only

*Existing Vitest infrastructure covers frontend changes (Terminal.tsx is hard to unit test — manual verification is the correct gate here).*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Live SSH session switch shows blank → repainted screen | SSH attach | Requires running Tauri app + live SSH connection | Open Agents view, start 2 SSH sessions, switch between them — no stale screen |
| Dead SSH session shows last snapshot on attach | SSH dead session recovery | Requires running Tauri app + SSH session that has exited | Start SSH session, let it finish, switch away and back — last screen appears |
| App close persists SSH history to DB | Shutdown hook | Requires app close + DB inspection | Start SSH session, close app, reopen — attach shows last known state |
| Local PTY no stale output on switch | Cancel token | Requires running Tauri app with local agent | Start 2 local agent sessions, switch rapidly — no old output bleeding |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
