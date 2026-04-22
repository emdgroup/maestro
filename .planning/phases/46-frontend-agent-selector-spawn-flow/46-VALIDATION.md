---
phase: 46
slug: frontend-agent-selector-spawn-flow
status: draft
nyquist_compliant: true
wave_0_complete: true
created: 2026-04-21
---

# Phase 46 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest |
| **Config file** | `vite.config.ts` |
| **Quick run command** | `pnpm test AgentSelectorDialog AgentMonitor` |
| **Full suite command** | `pnpm test` |
| **Estimated runtime** | ~15 seconds |

---

## Sampling Rate

- **After every task commit:** Run `pnpm test AgentSelectorDialog AgentMonitor`
- **After every plan wave:** Run `pnpm test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 20 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 46-01-00 | 01 | 1 | SPAWN-01, SPAWN-02 | scaffold | `test -f src/components/execution/__tests__/AgentSelectorDialog.test.tsx` | Wave 0 task | pending |
| 46-01-01 | 01 | 1 | SPAWN-01 | build | `pnpm build` | n/a | pending |
| 46-01-02 | 01 | 1 | SPAWN-01, SPAWN-02 | unit | `pnpm test AgentSelectorDialog` | Created by 46-01-00 | pending |
| 46-02-00 | 02 | 2 | SPAWN-03 | scaffold | `test -f src/components/execution/__tests__/AgentMonitor.test.tsx` | Wave 0 task | pending |
| 46-02-01 | 02 | 2 | SPAWN-01, SPAWN-02 | build | `pnpm build` | n/a | pending |
| 46-02-02 | 02 | 2 | SPAWN-03 | unit | `pnpm test AgentMonitor` | Created by 46-02-00 | pending |

*Status: pending / green / red / flaky*

---

## Wave 0 Requirements

- [x] `src/components/execution/__tests__/AgentSelectorDialog.test.tsx` — created by Plan 01 Task 0 (covers SPAWN-01, SPAWN-02)
- [x] `src/components/execution/__tests__/AgentMonitor.test.tsx` — created by Plan 02 Task 0 (covers SPAWN-03)

*Wave 0 tasks are embedded in plans as Task 0 entries. Test stubs are created before implementation tasks.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Modal opens from spawn button | SPAWN-01 | Integration with live Tauri IPC | Click spawn button, verify modal appears with agent list |
| ACP session appears in sidebar after spawn | SPAWN-02 | Requires live Tauri + backend | Spawn agent, verify session row appears with ACP badge |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency < 20s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** approved (revision pass)
