---
phase: 26
slug: agents-view
status: draft
nyquist_compliant: false
nyquist_rationale: >
  xterm.js components (Terminal, DeadSessionTerminal, AgentMonitor) require canvas/WebGL
  rendering that happy-dom cannot provide. Unit testing these components would require
  heavy mocking of Terminal, FitAddon, ResizeObserver, and channel APIs — producing tests
  that verify mock wiring rather than real behavior. pnpm build (TypeScript compilation)
  is the automated gate; behavioral verification is manual via the running Tauri app.
wave_0_complete: false
created: 2026-03-29
---

# Phase 26 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest |
| **Config file** | `vite.config.ts` |
| **Quick run command** | `pnpm build` |
| **Full suite command** | `pnpm build && pnpm test --run` |
| **Estimated runtime** | ~30 seconds |

---

## Sampling Rate

- **After every task commit:** Run `pnpm build`
- **After every plan wave:** Run `pnpm build && pnpm test --run`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 30 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | Status |
|---------|------|------|-------------|-----------|-------------------|--------|
| 26-01-01 | 01 | 1 | REQ-16, REQ-23, REQ-24 | build | `pnpm build` | pending |
| 26-01-02 | 01 | 1 | REQ-22 | build | `pnpm build` | pending |
| 26-02-01 | 02 | 2 | REQ-17, REQ-18, REQ-19, REQ-20 | build | `pnpm build` | pending |
| 26-02-02 | 02 | 2 | REQ-21 | build | `pnpm build` | pending |

*Status: pending / green / red / flaky*

**Note:** All tasks use `pnpm build` (TypeScript compilation) as the sole automated gate.
Behavioral requirements (refetchInterval polling, filter logic, pendingAgentId conversion,
terminal cleanup lifecycle) are verified manually in the running Tauri app. See rationale
in frontmatter `nyquist_rationale`.

---

## Manual Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Query polls every 2 seconds | REQ-16 | Requires running Tauri backend with real DB | Open Agents view, observe network tab for 2s interval IPC calls |
| Sidebar rows show real execution data | REQ-17 | xterm.js + Tauri IPC required | Start agent, open Agents view, verify three-line rows render |
| List sorted by started_at descending | REQ-18 | Needs real execution data | Create multiple executions, verify newest appears first |
| Filter chips and search narrow list | REQ-19 | DOM interaction with ToggleGroup | Click Running/Done/Failed chips, type in search, verify list filters |
| Clicking Running row shows live terminal | REQ-20 | Requires active PTY session | Start agent, click its row, verify terminal output scrolls live |
| Non-Running row shows DB history + banner | REQ-21 | Requires completed execution with terminal_output | Complete an agent, click its row, verify session ended banner + history |
| Terminal cleanup on unmount | REQ-22 | DOM/WebSocket/PTY lifecycle | Switch between rows rapidly, check DevTools for leaked observers or errors |
| pendingAgentId deep-link selection | REQ-23 | Requires navigation from Kanban view | Click "View Agent" on a task, verify Agents view auto-selects it |
| No IPC calls inside AgentMonitor | REQ-24 | Static analysis | Grep AgentMonitor.tsx for `api.` or `invoke` — must have zero matches |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify (pnpm build)
- [x] nyquist_compliant set to false with rationale documented
- [x] No watch-mode flags
- [x] Feedback latency < 30s
- [ ] All manual verifications passed

**Approval:** pending
