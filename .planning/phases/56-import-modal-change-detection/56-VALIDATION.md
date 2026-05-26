---
phase: 56
slug: import-modal-change-detection
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-05-24
---

# Phase 56 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest (via `vite.config.ts` inline test config) |
| **Config file** | `vite.config.ts` |
| **Quick run command** | `pnpm test ImportTicketsModal` |
| **Full suite command** | `pnpm test` |
| **Estimated runtime** | ~30 seconds (Vitest) + ~10 seconds (cargo test) |

---

## Sampling Rate

- **After every task commit:** Run `pnpm test <relevant pattern>` + `cargo test` in `src-tauri/`
- **After every plan wave:** Run `pnpm test` (full suite) + `cargo test`
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** ~40 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 56-01-01 | 01 | 1 | IMPT-03 | T-56-04 | `import_tasks` duplicate check must be `WHERE external_id = ? AND project_id = ?` | Rust unit | `cargo test import_tasks` | ❌ Wave 0 | ⬜ pending |
| 56-01-02 | 01 | 1 | IMPT-03 | — | `update_task_from_remote` updates title/description/labels/external_updated_at only | Rust unit | `cargo test update_task_from_remote` | ❌ Wave 0 | ⬜ pending |
| 56-01-03 | 01 | 1 | CHNG-02 | — | `dismiss_task_change` sets external_updated_at without modifying task content | Rust unit | `cargo test dismiss_task_change` | ❌ Wave 0 | ⬜ pending |
| 56-02-01 | 02 | 2 | IMPT-01 | — | Button hidden when `ticketingConfig` is null | unit | `pnpm test BacklogView` | ❌ Wave 0 | ⬜ pending |
| 56-02-02 | 02 | 2 | IMPT-02 | — | Modal renders 3 tabs; tab switching changes active tab | unit | `pnpm test ImportTicketsModal` | ❌ Wave 0 | ⬜ pending |
| 56-02-03 | 02 | 2 | IMPT-04 | — | `refetchInterval` is `30_000` when modal open, `false` when closed | unit | `pnpm test useFetchRemoteIssuesQuery` | ❌ Wave 0 | ⬜ pending |
| 56-02-04 | 02 | 2 | IMPT-05 | — | Refresh button triggers `refetch()` call | unit (mock) | `pnpm test ImportTicketsModal` | ❌ Wave 0 | ⬜ pending |
| 56-02-05 | 02 | 2 | IMPT-06 | — | Label filter string hides non-matching rows | unit | `pnpm test ImportTicketsModal` | ❌ Wave 0 | ⬜ pending |
| 56-02-06 | 02 | 2 | CHNG-01 | — | Issue classified as "Changed" when `updated_at > external_updated_at` | unit | `pnpm test ImportTicketsModal` | ❌ Wave 0 | ⬜ pending |
| 56-02-07 | 02 | 2 | CHNG-02 | — | "Update task" calls `updateTaskFromRemote`, "Dismiss" calls `dismissTaskChange` | unit | `pnpm test ImportTicketsModal` | ❌ Wave 0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src/components/kanban/__tests__/ImportTicketsModal.test.tsx` — stubs for IMPT-02, IMPT-04, IMPT-05, IMPT-06, CHNG-01, CHNG-02
- [ ] `src/components/views/__tests__/BacklogView.test.tsx` — stubs for IMPT-01
- [ ] `src-tauri/src/ipc/ticketing_handlers.rs` — `#[cfg(test)] mod tests` stubs for IMPT-03 (import_tasks, update_task_from_remote, dismiss_task_change)

*Existing patterns: `src/components/common/__tests__/DisconnectBackdrop.test.tsx`, `src/components/project-picker/__tests__/ProjectPicker.test.tsx`*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Framer Motion animated tab pill transitions smoothly | IMPT-02 | Animation not testable in jsdom | Open modal, click tabs, verify sliding pill |
| Import button inserts rows visible in Kanban after modal close | IMPT-03 | IPC integration requires live Tauri | Import 2 issues, close modal, check Backlog column |
| AzDo priority mapping (1→Urgent, 2→High, 3→Medium, 4→Low) | IMPT-03 | Requires live AzDo connection | Import AzDo issues, verify priority field |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 40s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
