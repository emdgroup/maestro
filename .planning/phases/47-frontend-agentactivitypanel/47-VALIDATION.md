---
phase: 47
slug: frontend-agentactivitypanel
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-04-22
---

# Phase 47 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest |
| **Config file** | vite.config.ts |
| **Quick run command** | `pnpm test AgentActivity` |
| **Full suite command** | `pnpm test` |
| **Estimated runtime** | ~15 seconds |

---

## Sampling Rate

- **After every task commit:** Run `pnpm test AgentActivity`
- **After every plan wave:** Run `pnpm test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 47-01-01 | 01 | 1 | ACTIVITY-01 | unit | `pnpm test AgentActivityPanel` | ❌ W0 | ⬜ pending |
| 47-01-02 | 01 | 1 | ACTIVITY-01 | unit | `pnpm test useAcpActivity` | ❌ W0 | ⬜ pending |
| 47-02-01 | 02 | 1 | ACTIVITY-02 | unit | `pnpm test AcpTerminalPanel` | ❌ W0 | ⬜ pending |
| 47-03-01 | 03 | 2 | ACTIVITY-03 | unit | `pnpm test AgentActivityPanel` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src/components/execution/__tests__/AgentActivityPanel.test.tsx` — stubs for ACTIVITY-01, ACTIVITY-03
- [ ] `src/components/execution/__tests__/AcpTerminalPanel.test.tsx` — stubs for ACTIVITY-02
- [ ] `src/utils/hooks/__tests__/useAcpActivity.test.ts` — stubs for ACTIVITY-01 hook logic

*Existing vitest infrastructure covers framework requirements.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Real-time structured output renders during live ACP session | ACTIVITY-01 | Requires live ACP agent running | Start ACP session, verify tool call cards and message chunks appear in panel |
| Raw terminal output visible alongside structured panel | ACTIVITY-02 | Requires live PTY output from ACP | Run ACP session, verify xterm panel fills with terminal bytes |
| Completed session replay identical to live view | ACTIVITY-03 | Requires populated DB row | Select a completed session, verify activity panel renders from `structured_output` JSON |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
