---
phase: 61
slug: create-task-modal
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-05-26
---

# Phase 61 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest (via vite.config.ts `test` block) |
| **Config file** | `vite.config.ts` (test.environment: happy-dom, setupFiles: ./src/test/setup.ts) |
| **Quick run command** | `pnpm test CreateTaskModal` |
| **Full suite command** | `pnpm test` |
| **Estimated runtime** | ~15 seconds |

---

## Sampling Rate

- **After every task commit:** Run `pnpm test CreateTaskModal`
- **After every plan wave:** Run `pnpm test`
- **Before `/gsd-verify-work`:** `pnpm test` + `cargo test` must both be green
- **Max feedback latency:** ~15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| Wave 0 setup | 01 | 0 | CREATE-01..04 | — | N/A | unit stub | `pnpm test CreateTaskModal` | ❌ Wave 0 | ⬜ pending |
| agent_id model | 01 | 1 | DATA-01 | — | N/A | build | `pnpm tauri:gen && cargo check` | ✅ | ⬜ pending |
| Schema V19 | 01 | 1 | DATA-01 | — | N/A | unit | `cargo test test_schema_initialization` | ✅ (needs update) | ⬜ pending |
| IPC create_task | 01 | 1 | CREATE-01 | — | title 3-255, description ≥10 | unit | `cargo test` | ✅ | ⬜ pending |
| CreateTaskModal From Branch | 02 | 2 | CREATE-01 | — | N/A | unit | `pnpm test CreateTaskModal` | ❌ Wave 0 | ⬜ pending |
| Branch combobox | 02 | 2 | CREATE-03 | — | N/A | unit | `pnpm test CreateTaskModal` | ❌ Wave 0 | ⬜ pending |
| From Issue tab | 02 | 2 | CREATE-02 | — | N/A | unit | `pnpm test CreateTaskModal` | ❌ Wave 0 | ⬜ pending |
| Create another toggle | 02 | 2 | CREATE-04 | — | N/A | unit | `pnpm test CreateTaskModal` | ❌ Wave 0 | ⬜ pending |
| KanbanView wiring | 02 | 2 | CREATE-01 | — | N/A | manual | open app, click "+ New Task" | N/A | ⬜ pending |
| App.tsx cleanup | 02 | 2 | — | — | N/A | build | `pnpm build` | ✅ | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src/components/kanban/__tests__/CreateTaskModal.test.tsx` — stubs for CREATE-01, CREATE-02, CREATE-03, CREATE-04
- [ ] Update `src-tauri/src/db/schema.rs` schema version assertion from `assert_eq!(version, 18)` to `assert_eq!(version, 19)`

*Existing test infrastructure (Vitest + happy-dom + testing-library) covers all phase requirements — no new framework install needed.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| "+ New Task" button visible in KanbanView action bar | CREATE-01 | Requires running app with real project open | Launch `pnpm tauri:dev`, open a project, verify button appears in action bar |
| Modal opens on button click | CREATE-01 | Visual/interactive | Click button, verify modal renders with From Branch tab active |
| From Issue tab visible only with ticketing provider | CREATE-02 | Requires configured provider in settings | Configure Linear/Jira in Settings, reopen modal, verify second tab appears |
| Issue selection pre-fills title + description | CREATE-02 | Requires live issue data fetch | Pick an issue from dropdown, verify title + description fields update |
| Branch combobox Local/Remote sub-tabs (if backend supports split) | CREATE-03 | Depends on backend branch format | Verify popover shows Local/Remote tabs if branches response contains remote refs |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
