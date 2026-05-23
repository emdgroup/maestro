---
phase: 54
slug: 54-linear-jira-azdo
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-05-21
---

# Phase 54 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Rust built-in (`#[cfg(test)]`) |
| **Config file** | none |
| **Quick run command** | `cargo check -p maestro` |
| **Full suite command** | `cargo test -p maestro 2>&1` |
| **Estimated runtime** | ~30 seconds |

---

## Sampling Rate

- **After every task commit:** Run `cargo check -p maestro`
- **After every wave merge:** Run `cargo test -p maestro`
- **Phase gate:** All unit tests green before `/gsd:verify-work`

---

## Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| AUTH-03 | Linear PAT validates via viewer query, returns display name | unit | `cargo test -p maestro linear -- --nocapture` | ❌ Wave 0 |
| AUTH-04 | Jira Cloud email+token validates via myself endpoint | unit | `cargo test -p maestro jira_cloud -- --nocapture` | ❌ Wave 0 |
| PROV-03 | Linear issues response deserialization, external_id format | unit | `cargo test -p maestro linear -- --nocapture` | ❌ Wave 0 |
| PROV-04 | Jira Cloud issues response deserialization, ADF conversion | unit | `cargo test -p maestro jira_cloud -- --nocapture` | ❌ Wave 0 |

---

## Wave 0 Gaps (tests created as part of implementation)

- [ ] `src-tauri/src/ticketing/linear.rs` — covers AUTH-03, PROV-03
  - Response struct deserialization from fixture JSON
  - `external_id` format: `linear:{identifier}`
  - list_teams deserialization
- [ ] `src-tauri/src/ticketing/jira_cloud.rs` — covers AUTH-04, PROV-04
  - Response struct deserialization from fixture JSON
  - `external_id` format: `jira:{issue_key}`
  - ADF body extraction via jc-adf
- [ ] `src-tauri/src/ticketing/jira_server.rs`
  - Response struct deserialization
  - `external_id` format: `jira:{issue_key}`
  - URL normalization
- [ ] `src-tauri/src/ticketing/azure_devops.rs`
  - WIQL ID extraction from response fixture
  - Batch URL construction
  - `external_id` format: `azuredevops:{id}`
  - `System.Tags` semicolon-split to Vec<String>
