---
phase: 28
slug: zombie-cleanup-on-project-open
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-30
---

# Phase 28 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest + cargo test |
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
| 28-01-01 | 01 | 1 | REQ-34 | unit | `cd src-tauri && cargo test cleanup_zombie` | ❌ W0 | ⬜ pending |
| 28-01-02 | 01 | 1 | REQ-35 | unit | `cd src-tauri && cargo test cleanup_zombie_age_threshold` | ❌ W0 | ⬜ pending |
| 28-01-03 | 01 | 2 | REQ-36 | integration | `pnpm test worktree` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- Existing infrastructure covers all phase requirements (Rust unit tests + Vitest for frontend hook).

*No new test framework installation required.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Zombie worktrees absent from Worktrees view on project open | REQ-36 | Requires Tauri runtime + real git repo with zombie worktrees | 1. Create worktree manually in DB with no task link, age > 10 min. 2. Open project. 3. Verify worktree not shown in WorktreesView. |
| Worktrees < 10 min are not deleted | REQ-35 | Requires time-based scenario with real worktrees | 1. Create worktree with no task link, just created. 2. Open project. 3. Verify worktree still present. |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
