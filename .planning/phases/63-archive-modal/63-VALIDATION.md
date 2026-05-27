---
phase: 63
slug: archive-modal
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-05-27
---

# Phase 63 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest |
| **Config file** | `vite.config.ts` (test section) |
| **Quick run command** | `pnpm test ArchiveModal` |
| **Full suite command** | `pnpm test` |
| **Estimated runtime** | ~5 seconds |

---

## Sampling Rate

- **After every task commit:** Run `pnpm test ArchiveModal`
- **After every plan wave:** Run `pnpm test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** ~5 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 63-01-01 | 01 | 1 | ARCHIVE-01, ARCHIVE-02, ARCHIVE-03 | T-63-01, T-63-02 | client-side filter only; no server writes | unit | `pnpm test ArchiveModal` | ❌ W0 | ⬜ pending |
| 63-01-02 | 01 | 1 | ARCHIVE-01 | — | N/A | build | `pnpm build` | ✅ | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src/components/kanban/__tests__/ArchiveModal.test.tsx` — stubs for ARCHIVE-01, ARCHIVE-02, ARCHIVE-03

*(Existing test infrastructure — Vitest, happy-dom, `src/test/setup.ts` — covers all framework needs. Only the test file itself is missing.)*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Archive button appears in board action bar | ARCHIVE-01 | Visual placement verification | Open KanbanView in app; confirm Archive button is visible left of New Task button |
| Modal opens and lists archived tasks | ARCHIVE-01 | Requires real task data | Click Archive button; verify modal opens with task rows |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 10s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
