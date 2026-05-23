---
phase: 55
slug: settings-ui
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-05-22
---

# Phase 55 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Rust unit tests (cargo test) + Vitest |
| **Config file** | `src-tauri/Cargo.toml` (Rust) / `vite.config.ts` (Vitest) |
| **Quick run command** | `cargo test -p maestro -- integration && pnpm test --run` |
| **Full suite command** | `cargo test --workspace && pnpm test --run` |
| **Estimated runtime** | ~30 seconds |

---

## Sampling Rate

- **After every task commit:** Run `cargo test -p maestro -- integration && pnpm test --run`
- **After every plan wave:** Run `cargo test --workspace && pnpm test --run`
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** ~30 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 55-01-01 | 01 | 1 | SETT-02 | T-01 | Tokens never returned to frontend; only connection status | unit (Rust) | `cargo test -p maestro -- integration` | ❌ W0 | ⬜ pending |
| 55-01-02 | 01 | 1 | SETT-03 | T-01 | Keyring entry deleted on disconnect; no orphan tokens | unit (Rust) | `cargo test -p maestro -- integration` | ❌ W0 | ⬜ pending |
| 55-01-03 | 01 | 1 | SETT-01 | — | N/A | unit (Rust) | `cargo test -p maestro -- project_config` | ❌ W0 | ⬜ pending |
| 55-02-01 | 02 | 2 | SETT-02 | — | N/A | unit (Vitest) | `pnpm test IntegrationsTab --run` | ❌ W0 | ⬜ pending |
| 55-02-02 | 02 | 2 | SETT-01 | — | N/A | unit (Vitest) | `pnpm test SettingsPage --run` | ❌ W0 | ⬜ pending |
| 55-03-01 | 03 | 3 | SETT-03 | T-02 | Project open blocked until integration fixed or removed | manual | App: open project with missing integration | ❌ N/A | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src-tauri/src/ticketing/keychain.rs` — update tests for new `maestro:integration:<provider>` key format
- [ ] `src-tauri/src/ipc/integration_handlers.rs` — tests for `list_integrations`, `save_integration`, `delete_integration`
- [ ] `src/components/project-picker/IntegrationsTab.tsx` — Vitest test for connected/disconnected/gh-cli states
- [ ] `src/components/common/SettingsPage.tsx` — Vitest test for Ticketing card picker + inline fields

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| D-18: GitHub gh CLI auto-detect | SETT-02 | Requires real gh CLI on PATH | 1. `gh auth login`. 2. Open Integrations tab. 3. GitHub card shows green + "gh cli" badge. 4. × button disabled with tooltip. |
| D-19: Cascade check on project open | SETT-03 | Requires real keyring manipulation + app restart | 1. Connect GitHub. 2. Configure project. 3. Delete keyring entry directly. 4. Reopen project. 5. Modal appears with Fix/Drop options. |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
