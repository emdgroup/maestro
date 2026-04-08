---
phase: 36
slug: redesign-the-diff-pane-in-the-worktrees-view
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-04-01
---

# Phase 36 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest |
| **Config file** | `vite.config.ts` |
| **Quick run command** | `pnpm test --run` |
| **Full suite command** | `pnpm test --run` |
| **Estimated runtime** | ~5 seconds |

---

## Sampling Rate

- **After every task commit:** Run `pnpm test --run`
- **After every plan wave:** Run `pnpm test --run`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 10 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 36-01-01 | 01 | 1 | diff-utils extension | unit | `pnpm test --run src/lib/diff-utils.test.ts` | ❌ W0 | ⬜ pending |
| 36-01-02 | 01 | 1 | WorktreeManager refactor | manual | visual inspection in app | N/A | ⬜ pending |
| 36-01-03 | 01 | 2 | File list selection | manual | visual inspection in app | N/A | ⬜ pending |
| 36-01-04 | 01 | 2 | Per-file header | manual | visual inspection in app | N/A | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src/lib/diff-utils.test.ts` — unit tests for `parseDiffString` with status (M/A/D) and per-file stats

*Existing infrastructure covers all other phase requirements.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| File list renders with correct M/A/D icons | UX | Requires live diff data from git | Open worktree with uncommitted changes, verify file list appears |
| Clicking file in list updates diff body | UX | UI interaction | Click each file in list, confirm diff body changes |
| Auto-select first file on worktree selection | UX | Requires app state | Select a worktree, verify first file is auto-selected without click |
| No uncommitted changes → empty list + message | UX | Requires app state | Select a clean worktree, verify "No uncommitted changes" message |
| DiffTarget toggle removed from UI | UX | Visual regression | Open WorktreesView, confirm no toggle or branch input |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 10s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
