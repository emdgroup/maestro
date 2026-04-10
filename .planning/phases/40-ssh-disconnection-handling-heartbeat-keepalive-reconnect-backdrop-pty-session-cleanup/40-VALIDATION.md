---
phase: 40
slug: ssh-disconnection-handling-heartbeat-keepalive-reconnect-backdrop-pty-session-cleanup
status: draft
nyquist_compliant: true
wave_0_complete: true
created: 2026-04-10
---

# Phase 40 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest (frontend) + cargo test (backend) |
| **Config file** | vitest.config.ts / Cargo.toml |
| **Quick run command** | `pnpm test` |
| **Full suite command** | `pnpm test && cd src-tauri && cargo test` |
| **Estimated runtime** | ~15 seconds |

---

## Sampling Rate

- **After every task commit:** Run `pnpm test`
- **After every plan wave:** Run `pnpm test && cd src-tauri && cargo test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 40-00-01 | 00 | 0 | Wave 0 test stubs | stub | `ls src/components/common/__tests__/DisconnectBackdrop.test.tsx src/utils/hooks/__tests__/useConnectionHealth.test.ts` | N/A | ⬜ pending |
| 40-01-01 | 01 | 1 | keepalive config | unit | `cd src-tauri && cargo test` | ✅ | ⬜ pending |
| 40-01-02 | 01 | 1 | heartbeat task spawn | unit | `cd src-tauri && cargo test` | ✅ | ⬜ pending |
| 40-01-03 | 01 | 1 | ssh-connection-lost event | unit | `cd src-tauri && cargo test` | ✅ | ⬜ pending |
| 40-02-01 | 02 | 2 | PTY session cleanup | unit | `cd src-tauri && cargo test` | ✅ | ⬜ pending |
| 40-03-01 | 03 | 3 | DisconnectBackdrop render | unit | `pnpm test -- --run src/components/common/__tests__/DisconnectBackdrop.test.tsx` | ✅ W0 | ⬜ pending |
| 40-03-02 | 03 | 3 | useConnectionHealth hook | unit | `pnpm test -- --run src/utils/hooks/__tests__/useConnectionHealth.test.ts` | ✅ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [x] `src/components/common/__tests__/DisconnectBackdrop.test.tsx` — stubs for backdrop render/dismiss (Plan 40-00)
- [x] `src/utils/hooks/__tests__/useConnectionHealth.test.ts` — stubs for hook event subscription (Plan 40-00)

*Wave 0 covered by Plan 40-00-PLAN.md (wave: 0, depends_on: []).*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Full reconnect flow (disconnect → backdrop → reconnect) | Phase 40 goal | Requires live SSH server + network disruption | Kill SSH server mid-session; verify backdrop appears, reconnect completes, backdrop dismisses |
| Exponential backoff delay between retries | Reconnect behavior | Requires timing under real conditions | Observe retry intervals in logs during reconnect |

*If none: "All phase behaviors have automated verification."*

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency < 15s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** approved (revision pass)
