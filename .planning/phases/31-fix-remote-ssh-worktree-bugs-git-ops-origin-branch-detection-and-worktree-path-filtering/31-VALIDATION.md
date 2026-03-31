---
phase: 31
slug: fix-remote-ssh-worktree-bugs-git-ops-origin-branch-detection-and-worktree-path-filtering
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-30
---

# Phase 31 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest (frontend) / cargo test (Rust backend) |
| **Config file** | `vitest.config.ts` / `src-tauri/Cargo.toml` |
| **Quick run command** | `pnpm test` |
| **Full suite command** | `pnpm test && cd src-tauri && cargo test` |
| **Estimated runtime** | ~30 seconds |

---

## Sampling Rate

- **After every task commit:** Run `pnpm build` (TypeScript compilation check)
- **After every plan wave:** Run `pnpm test && cd src-tauri && cargo test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 60 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 31-01-01 | 01 | 1 | SSH session lookup | unit | `cd src-tauri && cargo test` | ✅ | ⬜ pending |
| 31-01-02 | 01 | 1 | Remote worktree create | unit | `cd src-tauri && cargo test` | ✅ | ⬜ pending |
| 31-01-03 | 01 | 1 | Current branch detection | unit | `cd src-tauri && cargo test` | ✅ | ⬜ pending |
| 31-01-04 | 01 | 1 | Branch list filtering | unit | `cd src-tauri && cargo test` | ✅ | ⬜ pending |
| 31-01-05 | 01 | 1 | Worktree list SSH dispatch | unit | `cd src-tauri && cargo test` | ✅ | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

*Existing infrastructure covers all phase requirements — Rust unit tests already present in src-tauri.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| SSH worktree create end-to-end | Bug 2 fix | Requires live SSH server | Connect SSH project, open WorktreesView, click New Worktree, verify worktree appears |
| Origin branch dropdown populates correctly | Bug 3+4 fix | Requires live SSH server | Open New Worktree dialog, verify branch dropdown shows clean branch names without `*` or `remotes/origin/` prefixes |
| Worktrees view renders SSH project worktrees | Bug 5 fix | Requires live SSH server | Connect SSH project, navigate to WorktreesView, verify worktree list loads |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 60s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
