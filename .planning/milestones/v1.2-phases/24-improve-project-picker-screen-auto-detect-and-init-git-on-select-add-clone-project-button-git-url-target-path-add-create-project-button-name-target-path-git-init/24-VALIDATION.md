---
phase: 24
slug: improve-project-picker-screen-auto-detect-and-init-git-on-select-add-clone-project-button-git-url-target-path-add-create-project-button-name-target-path-git-init
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-28
---

# Phase 24 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest (frontend) + cargo test (Rust) |
| **Config file** | `vitest.config.ts` / `src-tauri/Cargo.toml` |
| **Quick run command** | `pnpm test --run` |
| **Full suite command** | `pnpm test --run && cd src-tauri && cargo test` |
| **Estimated runtime** | ~30 seconds |

---

## Sampling Rate

- **After every task commit:** Run `pnpm test --run`
- **After every plan wave:** Run `pnpm test --run && cd src-tauri && cargo test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 30 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 24-01-01 | 01 | 1 | git-init-rust | unit | `cd src-tauri && cargo test git_init` | ❌ W0 | ⬜ pending |
| 24-01-02 | 01 | 1 | git-init-ipc | integration | `cd src-tauri && cargo test` | ❌ W0 | ⬜ pending |
| 24-02-01 | 02 | 1 | clone-rust | unit | `cd src-tauri && cargo test git_clone` | ❌ W0 | ⬜ pending |
| 24-02-02 | 02 | 1 | clone-ipc | integration | `cd src-tauri && cargo test` | ❌ W0 | ⬜ pending |
| 24-03-01 | 03 | 2 | create-project-rust | unit | `cd src-tauri && cargo test create_project` | ❌ W0 | ⬜ pending |
| 24-04-01 | 04 | 2 | footer-buttons | unit | `pnpm test --run ProjectsListLayout` | ❌ W0 | ⬜ pending |
| 24-04-02 | 04 | 2 | clone-dialog | unit | `pnpm test --run ProjectList` | ❌ W0 | ⬜ pending |
| 24-04-03 | 04 | 2 | create-dialog | unit | `pnpm test --run ProjectList` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src-tauri/src/git/mod.rs` tests — stubs for `git_init` and `git_clone`
- [ ] `src/components/project-picker/__tests__/ProjectList.test.tsx` — dialog render stubs
- [ ] `src/components/project-picker/__tests__/ProjectsListLayout.test.tsx` — footer 3-button render

*Existing infrastructure covers test framework setup — vitest and cargo test are already configured.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| `git clone` with real remote URL succeeds | Clone Project flow | Requires network + real git remote | Open Clone dialog, enter `https://github.com/octocat/Hello-World`, pick target dir, click Clone, verify success toast and project appears in list |
| Auto-git-init on non-git folder | FilePicker selection | Requires actual filesystem + git binary | Select a folder without `.git` via Select Existing — verify project is created and `git rev-parse` succeeds in that folder |
| Clone spinner visible during slow clone | UX feedback | Timing-sensitive | Clone a large repo on slow connection, verify spinner shows and dialog stays open |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
