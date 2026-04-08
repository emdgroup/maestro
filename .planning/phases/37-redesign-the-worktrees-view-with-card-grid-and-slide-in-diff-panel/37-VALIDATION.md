---
phase: 37
slug: redesign-the-worktrees-view-with-card-grid-and-slide-in-diff-panel
status: draft
nyquist_compliant: true
wave_0_complete: true
created: 2026-04-01
---

# Phase 37 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest (via vite.config.ts `test` block) |
| **Config file** | `vite.config.ts` (inline test config) |
| **Quick run command** | `pnpm test --reporter=verbose` |
| **Full suite command** | `pnpm test` |
| **Estimated runtime** | ~10 seconds |

---

## Sampling Rate

- **After every task commit:** Run `pnpm test --reporter=verbose`
- **After every plan wave:** Run `pnpm test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| Schema migration | 01 | 1 | base_branch column | Rust unit | `cargo test test_schema_initialization` | yes | pending |
| WorktreeWithStatus model | 01 | 1 | base_branch + ahead_behind fields | Rust unit + TS build | `cargo check && pnpm build` | yes | pending |
| IPC handlers | 01 | 1 | persist base_branch, compute ahead/behind | Rust check + bindings | `cargo check && pnpm tauri:gen` | yes | pending |
| WorktreeCard | 02 | 2 | card renders branch_name, diff_stat, created_at, ahead/behind | TS build | `pnpm build` | yes | pending |
| WorktreeCardGrid + slide | 02 | 2 | selectedWorktreeId drives slide CSS class | TS build | `pnpm build` | yes | pending |
| WorktreeDiffPanel | 03 | 3 | renders FileTree + DiffViewer | TS build | `pnpm build` | yes | pending |

*Status: pending / green / red / flaky*

---

## Wave 0 Requirements

Existing infrastructure covers all phase requirements:

- `cargo test test_schema_initialization` covers schema migration (Plan 01)
- `cargo check` covers Rust model and IPC handler compilation (Plan 01)
- `pnpm build` (TypeScript strict mode) catches type errors across all frontend components (Plans 02-03)
- Existing `src/utils/helpers/diff-utils.test.ts` covers `parseDiffStat`
- Existing `src/store/navigationStore.test.ts` covers deep-link mechanics

The grouping logic (`base_branch ?? branch_name` Map grouping in WorktreesView) is a ~10-line `useMemo` inline in the view component. Extracting it to a separate utility solely for unit testing would be over-engineering given that `pnpm build` with strict TypeScript ensures type correctness, and the logic is trivial (Map insertion + fallback). If the grouping logic grows in complexity, extraction can be revisited.

No dedicated Wave 0 test files needed.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| CSS slide transition | Full-screen slide left on card click | CSS transform not testable in happy-dom | Click a worktree card; verify cards grid slides out left, diff panel slides in from right over ~300ms |
| Deep-link -> slide-in | pendingWorktreeId triggers slide-in | Integration across store + view | Trigger deep-link to a worktree; verify diff panel opens automatically |
| Collapse/expand all groups | Action bar toggle collapses all groups | UI interaction | Click expand/collapse all button; verify all groups toggle correctly |
| Ahead/behind indicator display | up-N down-N shown on card | Visual only | Create worktree with commits ahead/behind remote; verify indicator appears |
| Delete card hover action | Trash icon appears on card hover | CSS hover state | Hover over a card; verify trash icon appears top-right |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency < 15s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** approved
