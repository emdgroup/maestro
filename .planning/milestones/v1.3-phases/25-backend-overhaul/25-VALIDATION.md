---
phase: 25
slug: backend-overhaul
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-29
---

# Phase 25 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | cargo test (Rust unit/integration tests) |
| **Config file** | `src-tauri/Cargo.toml` |
| **Quick run command** | `cd src-tauri && cargo check` |
| **Full suite command** | `cd src-tauri && cargo test && pnpm tauri:gen` |
| **Estimated runtime** | ~60 seconds |

---

## Sampling Rate

- **After every task commit:** Run `cd src-tauri && cargo check`
- **After every plan wave:** Run `cd src-tauri && cargo test && pnpm tauri:gen`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 60 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 25-01-01 | 01 | 1 | REQ-01 | compile | `cd src-tauri && cargo check` | ✅ | ⬜ pending |
| 25-01-02 | 01 | 1 | REQ-02 | compile | `cd src-tauri && cargo check` | ✅ | ⬜ pending |
| 25-02-01 | 02 | 1 | REQ-03, REQ-04 | compile | `cd src-tauri && cargo check` | ✅ | ⬜ pending |
| 25-02-02 | 02 | 1 | REQ-05, REQ-06 | compile | `cd src-tauri && cargo check` | ✅ | ⬜ pending |
| 25-03-01 | 03 | 2 | REQ-07, REQ-08 | compile+test | `cd src-tauri && cargo test` | ✅ | ⬜ pending |
| 25-03-02 | 03 | 2 | REQ-09 | compile | `cd src-tauri && cargo check` | ✅ | ⬜ pending |
| 25-04-01 | 04 | 2 | REQ-10, REQ-11 | compile+test | `cd src-tauri && cargo test` | ✅ | ⬜ pending |
| 25-04-02 | 04 | 2 | REQ-12 | compile+gen | `cd src-tauri && cargo test && pnpm tauri:gen` | ✅ | ⬜ pending |
| 25-05-01 | 05 | 3 | REQ-13, REQ-14, REQ-15 | manual | disk inspection + IPC call | N/A | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- Existing infrastructure covers all phase requirements (cargo test exists, no new test framework needed).

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| `create_worktree` IPC creates real dir at `.maestro/worktrees/task-{id}` | REQ-13 | Filesystem side effect requires disk inspection | Call IPC, run `ls project_root/.maestro/worktrees/` |
| `spawn_agent_execution` creates worktree on-demand and deletes on completion | REQ-14 | Requires live Tauri process + full lifecycle | Start execution for task, verify dir appears then disappears |
| `list_worktrees_with_status` returns non-empty real data | REQ-15 | Requires project with active worktrees | Run with active project, verify non-empty JSON response |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 60s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
