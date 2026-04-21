---
phase: 41
slug: acp-agent-selection-discovery-system
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-04-17
---

# Phase 41 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | cargo test (Rust unit tests) |
| **Config file** | src-tauri/Cargo.toml / Cargo.toml (workspace) |
| **Quick run command** | `cargo test -p maestro-protocol` |
| **Full suite command** | `cargo build -p maestro-protocol -p maestro-server && cargo test -p maestro-protocol` |
| **Estimated runtime** | ~30 seconds |

---

## Sampling Rate

- **After every task commit:** Run `cargo test -p maestro-protocol`
- **After every plan wave:** Run `cargo build -p maestro-protocol -p maestro-server && cargo test -p maestro-protocol`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 60 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 41-01-01 | 01 | 1 | Workspace setup | build | `cargo check` | ❌ W0 | ⬜ pending |
| 41-01-02 | 01 | 1 | maestro-protocol types | unit | `cargo test -p maestro-protocol` | ❌ W0 | ⬜ pending |
| 41-02-01 | 02 | 2 | acp module compiles | build | `cargo check -p maestro` | ❌ W0 | ⬜ pending |
| 41-03-01 | 03 | 2 | maestro-server binary | build | `cargo build -p maestro-server` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] Root `Cargo.toml` workspace file — enables `cargo check` / `cargo build -p` commands
- [ ] `maestro-protocol/Cargo.toml` — crate manifest with serde + serde_json deps
- [ ] `maestro-server/Cargo.toml` — binary crate manifest

*Wave 0 establishes workspace; subsequent waves add source and tests.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Protocol roundtrip correctness | Wire protocol fidelity | Requires review of serialized JSON shape | `cargo test -p maestro-protocol` prints serialized output; review JSON structure |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 60s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
