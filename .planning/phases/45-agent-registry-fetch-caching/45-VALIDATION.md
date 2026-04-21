---
phase: 45
slug: agent-registry-fetch-caching
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-04-21
---

# Phase 45 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | cargo test (Rust unit tests) |
| **Config file** | src-tauri/Cargo.toml |
| **Quick run command** | `cd src-tauri && cargo test registry` |
| **Full suite command** | `cd src-tauri && cargo test` |
| **Estimated runtime** | ~30 seconds |

---

## Sampling Rate

- **After every task commit:** Run `cd src-tauri && cargo test registry`
- **After every plan wave:** Run `cd src-tauri && cargo test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 60 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 45-01-01 | 01 | 0 | REGISTRY-01 | unit | `cd src-tauri && cargo test registry::tests::test_fetch_returns_agents` | ❌ W0 | ⬜ pending |
| 45-01-02 | 01 | 1 | REGISTRY-02 | unit | `cd src-tauri && cargo test registry::tests::test_cache_hit_no_network` | ❌ W0 | ⬜ pending |
| 45-01-03 | 01 | 1 | REGISTRY-02 | unit | `cd src-tauri && cargo test registry::tests::test_force_refresh_bypasses_cache` | ❌ W0 | ⬜ pending |
| 45-01-04 | 01 | 2 | REGISTRY-03 | unit | `cd src-tauri && cargo test registry::tests::test_resolve_npx_command` | ❌ W0 | ⬜ pending |
| 45-01-05 | 01 | 2 | REGISTRY-03 | unit | `cd src-tauri && cargo test registry::tests::test_resolve_binary_command` | ❌ W0 | ⬜ pending |
| 45-01-06 | 01 | 2 | REGISTRY-03 | unit | `cd src-tauri && cargo test registry::tests::test_resolve_uvx_command` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src-tauri/src/acp/registry.rs` — extend with new types (`RegistryCacheEntry`, `RegistryResponse`, `ResolvedLaunchCommand`), add `#[cfg(test)] mod tests { ... }` block with test stubs for REGISTRY-01, REGISTRY-02, REGISTRY-03, and implement fetch/cache/resolve logic

*All test stubs must compile and fail (red) before Wave 1 implementation begins.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| CDN stale fallback on network error | REGISTRY-01 | Requires network fault injection; no mock framework in place | Disconnect network mid-test, call fetch_agent_registry, verify cached data returned |
| IPC integration from frontend | REGISTRY-01 | Tauri IPC requires full app runtime | Run `pnpm tauri:dev`, open devtools, call invoke("fetch_agent_registry", {}) |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 60s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
