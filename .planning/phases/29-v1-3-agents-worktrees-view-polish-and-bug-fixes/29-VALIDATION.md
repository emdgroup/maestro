---
phase: 29
slug: v1-3-agents-worktrees-view-polish-and-bug-fixes
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-30
---

# Phase 29 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest 4.1.2 |
| **Config file** | `vite.config.ts` (inline Vitest config) |
| **Quick run command** | `pnpm test --run` |
| **Full suite command** | `pnpm test` |
| **Estimated runtime** | ~15 seconds |

Rust backend: `cargo test` from `src-tauri/`

---

## Sampling Rate

- **After every task commit:** Run `pnpm test --run`
- **After every plan wave:** Run `pnpm build && pnpm test --run`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 30 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 29-01-01 | 01 | 1 | DiffViewer theme + Tailwind states | build + visual | `pnpm build && pnpm test --run` | ✅ | ⬜ pending |
| 29-01-02 | 01 | 1 | SQL subquery fix | cargo test | `cd src-tauri && cargo test` | ✅ | ⬜ pending |
| 29-02-01 | 02 | 1 | Commit working-tree changes | build + test | `pnpm build && pnpm test --run` | ✅ | ⬜ pending |
| 29-02-02 | 02 | 1 | Resolve stale todo | file check | `ls .planning/todos/done/001-*` | ✅ | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

Existing infrastructure covers all phase requirements — no new test infrastructure needed. 110 tests already passing at research time.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| DiffViewer renders dark theme when app is dark | DiffViewer fix | Theme-switching is runtime-only; no automated test exists | Toggle dark/light mode in app → open WorktreesView diff panel → verify diff view matches theme |
| DiffViewer loading/error states styled correctly | DiffViewer Tailwind fix | Visual inspection only | Trigger loading state (network slow/offline) → verify spinner text is muted, not unstyled |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
