---
phase: 62
slug: task-detail-screen
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-05-27
---

# Phase 62 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest |
| **Config file** | `vite.config.ts` |
| **Quick run command** | `pnpm test` |
| **Full suite command** | `pnpm test && pnpm build` |
| **Estimated runtime** | ~15 seconds |

---

## Sampling Rate

- **After every task commit:** Run `pnpm test`
- **After every plan wave:** Run `pnpm test && pnpm build`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 30 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 62-01-01 | 01 | 1 | DETAIL-01 | — | N/A | unit | `pnpm test` | ❌ W0 | ⬜ pending |
| 62-01-02 | 01 | 1 | DETAIL-02 | — | N/A | unit | `pnpm test` | ❌ W0 | ⬜ pending |
| 62-01-03 | 01 | 1 | DETAIL-03 | — | N/A | unit | `pnpm test` | ❌ W0 | ⬜ pending |
| 62-02-01 | 02 | 2 | DETAIL-04 | — | N/A | unit | `pnpm test` | ❌ W0 | ⬜ pending |
| 62-02-02 | 02 | 2 | DETAIL-05 | — | N/A | unit | `pnpm test` | ❌ W0 | ⬜ pending |
| 62-02-03 | 02 | 2 | DETAIL-06 | — | N/A | unit | `pnpm test` | ❌ W0 | ⬜ pending |
| 62-02-04 | 02 | 2 | DETAIL-07 | — | N/A | unit | `pnpm test` | ❌ W0 | ⬜ pending |
| 62-02-05 | 02 | 2 | DETAIL-08 | — | N/A | unit | `pnpm test` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src/components/task/TaskDetailScreen.test.tsx` — stubs for DETAIL-01 through DETAIL-08
- [ ] Existing vitest infrastructure covers all framework needs

*Existing infrastructure covers all phase requirements.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Drag-drop file upload | DETAIL-05 | File drag events require browser interaction | Open app, drag a file onto the task detail attachment area, verify it appears |
| Locked/unlocked visual state | DETAIL-02 | Visual UI state requires browser verification | Open task in non-Backlog status, verify locked banner; interrupt, verify fields unlock |
| Navigation from task card | DETAIL-01 | Full app navigation requires browser | Click task card, verify full-screen route renders |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
