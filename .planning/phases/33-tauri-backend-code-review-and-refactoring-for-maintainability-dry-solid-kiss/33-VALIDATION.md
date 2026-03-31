---
phase: 33
slug: tauri-backend-code-review-and-refactoring-for-maintainability-dry-solid-kiss
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-31
---

# Phase 33 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | cargo test |
| **Config file** | src-tauri/Cargo.toml |
| **Quick run command** | `cd src-tauri && cargo check` |
| **Full suite command** | `cd src-tauri && cargo test` |
| **Estimated runtime** | ~30 seconds |

---

## Sampling Rate

- **After every task commit:** Run `cd src-tauri && cargo check`
- **After every plan wave:** Run `cd src-tauri && cargo test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 30 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 33-01-01 | 01 | 1 | DRY-1 | compile | `cd src-tauri && cargo check` | ✅ | ⬜ pending |
| 33-01-02 | 01 | 1 | DRY-2 | compile | `cd src-tauri && cargo check` | ✅ | ⬜ pending |
| 33-01-03 | 01 | 1 | DRY-3 | compile | `cd src-tauri && cargo check` | ✅ | ⬜ pending |
| 33-02-01 | 02 | 2 | SOLID-1 | compile+gen | `cd src-tauri && cargo test generate_typescript_bindings` | ✅ | ⬜ pending |
| 33-02-02 | 02 | 2 | SOLID-2 | compile | `cd src-tauri && cargo check` | ✅ | ⬜ pending |
| 33-03-01 | 03 | 3 | KISS | compile | `cd src-tauri && cargo check` | ✅ | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

Existing infrastructure covers all phase requirements.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| SSH connection still works after finalize_ssh_connection refactor | DRY-3 | Requires live SSH server | Connect to remote project, verify auth succeeds |
| Frontend TypeScript bindings compile after new typed structs | SOLID-1 | Requires full build | Run `pnpm build` and verify no type errors |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
