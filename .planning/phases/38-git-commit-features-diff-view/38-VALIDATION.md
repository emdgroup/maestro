---
phase: 38
slug: git-commit-features-diff-view
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-04-02
---

# Phase 38 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest |
| **Config file** | `vite.config.ts` |
| **Quick run command** | `pnpm test -- --run src/utils/helpers/diff-utils.test.ts` |
| **Full suite command** | `pnpm test -- --run` |
| **Estimated runtime** | ~10 seconds |

---

## Sampling Rate

- **After every task commit:** Run `pnpm test -- --run src/utils/helpers/diff-utils.test.ts`
- **After every plan wave:** Run `pnpm test -- --run`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 10 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 38-01-01 | 01 | 1 | hunk-patch-extraction | unit | `pnpm test -- --run src/utils/helpers/diff-utils.test.ts` | ✅ | ⬜ pending |
| 38-01-02 | 01 | 1 | rust-ipc-commands | build | `cd src-tauri && cargo check` | ✅ | ⬜ pending |
| 38-02-01 | 02 | 2 | file-checkbox-state | unit | `pnpm test -- --run` | ✅ | ⬜ pending |
| 38-02-02 | 02 | 2 | commit-area-visibility | unit | `pnpm test -- --run` | ✅ | ⬜ pending |
| 38-03-01 | 03 | 3 | hunk-checkbox-injection | manual | — | ❌ W0 | ⬜ pending |
| 38-03-02 | 03 | 3 | revert-shelve-actions | manual | — | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- Existing infrastructure covers all phase requirements.

*Note: `diff-utils.test.ts` already exists and covers diff parsing. New `extractHunkPatch` / `countHunks` utilities should be added to that file.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Hunk checkbox renders inline with @@ header | hunk-checkbox-injection | @git-diff-view/react extension API — no unit surface | Open diff panel with changes, verify checkbox appears at each @@ line |
| Revert confirmation dialog appears | revert-shelve-actions | UI interaction | Check a file, click Revert, verify AlertDialog appears before any git operation |
| Shelve popover pre-fills wip-{branch}-{date} | revert-shelve-actions | UI interaction | Click Shelve, verify input pre-filled correctly |
| Commit closes panel when no remaining changes | commit-post-action | Git state dependent | Commit all files, verify panel closes and card grid shows updated state |
| Partial commit stays in panel | commit-post-action | Git state dependent | Stage 1 of 2 changed files, commit, verify panel stays open with 1 file remaining |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 10s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
