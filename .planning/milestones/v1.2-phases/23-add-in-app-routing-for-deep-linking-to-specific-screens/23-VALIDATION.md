---
phase: 23
slug: add-in-app-routing-for-deep-linking-to-specific-screens
status: draft
nyquist_compliant: true
wave_0_complete: true
created: 2026-03-28
---

# Phase 23 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest |
| **Config file** | vite.config.ts |
| **Quick run command** | `pnpm test --run` |
| **Full suite command** | `pnpm test --run` |
| **Estimated runtime** | ~10 seconds |

---

## Sampling Rate

- **After every task commit:** Run `pnpm test --run`
- **After every plan wave:** Run `pnpm test --run`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 23-01-01 | 01 | 1 | navigation store | unit | `pnpm test --run src/store/navigationStore` | W0 (created by Plan 01 TDD) | ⬜ pending |
| 23-02-01 | 02 | 2 | App.tsx + AppHeader rewire | compile | `pnpm build` | n/a (compile check) | ⬜ pending |
| 23-02-02 | 02 | 2 | KanbanView + usePageRouting deletion | compile | `pnpm build` | n/a (compile check) | ⬜ pending |
| 23-02-03 | 02 | 2 | AgentsView + WorktreesView wiring | compile | `pnpm build` | n/a (compile check) | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [x] `src/store/navigationStore.test.ts` — created by Plan 01 (TDD plan, test-first)

*Plan 02 tasks are component rewiring verified via `pnpm build` (compile-time type checking). No additional test files needed — the navigationStore unit tests in Plan 01 cover the behavioral contract. Component integration is verified by successful compilation against the store's typed API.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Deep link opens correct screen | Core routing | Tauri window navigation requires real app | Launch app, trigger navigate({ taskId: '123' }), verify TaskDetail sheet opens |
| Slide animation direction | UI polish | Requires visual inspection | Click tabs left/right, verify slide direction matches |
| KanbanView subView switching | UI state | Requires DOM context | Click between board/backlog/archive, verify correct view renders |
| Agent highlight on navigate | agentId wiring | Requires running agents | Call navigate({ agentId: '1' }), verify agent is selected |
| Worktree highlight on navigate | worktreeId wiring | Requires active worktrees | Call navigate({ worktreeId: '1' }), verify worktree is highlighted |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency < 15s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** approved
