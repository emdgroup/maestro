---
phase: 53-api-key-auth
fixed_at: 2026-05-21T17:50:00Z
review_path: .planning/phases/53-api-key-auth/53-REVIEW.md
iteration: 1
findings_in_scope: 7
fixed: 6
skipped: 1
status: partial
---

# Phase 53: Code Review Fix Report

**Fixed at:** 2026-05-21T17:50:00Z
**Source review:** `.planning/phases/53-api-key-auth/53-REVIEW.md`
**Iteration:** 1

**Summary:**
- Findings in scope: 7 (CR-01, CR-02, CR-03, WR-01, WR-02, WR-03, WR-04)
- Fixed: 6
- Skipped: 1 (WR-01 — requires pagination design decision)

## Fixed Issues

### CR-01: Path injection via unencoded `owner`/`repo` in GitHub and Forgejo URL construction

**Files modified:** `src-tauri/src/ticketing/github.rs`, `src-tauri/src/ticketing/forgejo.rs`
**Commit:** `7e656b2`
**Applied fix:** Wrapped `owner` and `repo` with `urlencoding::encode()` in the `fetch_issues` URL format strings in both `github.rs` and `forgejo.rs`. The `urlencoding` crate was already present in `Cargo.toml`. Note: `validate_and_store` in both files does not embed owner/repo into URL paths (it uses `/user` and `/api/v1/user` endpoints only), so no change was needed there.

---

### CR-02: Token persists on disk when `delete_ticketing_credentials` is called while keyring is available

**Files modified:** `src-tauri/src/ticketing/keychain.rs`
**Commit:** `f31cb1d`
**Applied fix:** Restructured `KeychainStore::delete_token` to capture the keyring result first, then unconditionally call `Self::delete_file` (best-effort via `let _ =`) before matching on the keyring result. This ensures the `.enc` file is always cleaned up regardless of whether the keyring had an entry. Added a comment explaining the rationale.

---

### CR-03: File-fallback encryption key is derived without key stretching — weak against low-entropy machine IDs

**Files modified:** `src-tauri/src/ticketing/keychain.rs`, `src-tauri/Cargo.toml`
**Commit:** `9215329`
**Applied fix:** Two changes:
1. Added security comment to `derive_key` clarifying it uses SHA-256 for defense-in-depth, not brute-force resistance.
2. Replaced `get_machine_id()` (which fell back to the constant `"maestro-unknown-machine"`) with `get_encryption_seed(app_data_dir: &Path)`, which tries `machine_uid::get()` first, then reads or creates a 32-byte random hex secret persisted at `app_data_dir/tokens/maestro-local-secret`. Added `rand = "0.8"` to Cargo.toml dependencies for `rand::rngs::OsRng`. Updated callers in `write_to_file` and `read_from_file` to pass `app_data_dir` to `get_encryption_seed`.

---

### WR-02: `save_ticketing_config` IPC command allows overwriting provider config without token validation

**Files modified:** `src-tauri/src/ipc/ticketing_handlers.rs`
**Commit:** `14e8fc7`
**Applied fix:** Added a best-effort `token_manager.delete_token` call at the start of `save_ticketing_config` when `config.provider` is `Some(...)`. This forces re-validation through the appropriate `save_{provider}_credentials` path on the next `fetch_remote_issues` call. Uses `let _ =` since credential absence is not an error.

---

### WR-03: `get_token` cache does not guard zero/negative expiry values

**Files modified:** `src-tauri/src/ticketing/token_manager.rs`
**Commit:** `ccb035e`
**Applied fix:** Added `exp > 0 &&` guard to the cache expiry check: `if exp > 0 && exp - now_unix() >= 60`. Updated the surrounding comment to note zero/invalid expiry is also treated as expired. The existing `*cached = None` eviction was already in place and continues to handle both expired and zero-expiry cases.

---

### WR-04: `normalize_instance_url` is duplicated verbatim in `gitlab.rs` and `forgejo.rs`

**Files modified:** `src-tauri/src/ticketing/mod.rs`, `src-tauri/src/ticketing/gitlab.rs`, `src-tauri/src/ticketing/forgejo.rs`
**Commit:** `6b7e155`
**Applied fix:** Added `pub(crate) fn normalize_instance_url` to `ticketing/mod.rs`. In `gitlab.rs` and `forgejo.rs`, replaced the local definitions with `use super::normalize_instance_url;`. Tests in both modules use `use super::*` which continues to resolve the function. All 52 tests pass.

---

## Skipped Issues

### WR-01: Inconsistent pagination — GitHub fetches 100 issues, Forgejo caps at 50 with no paging

**File:** `src-tauri/src/ticketing/github.rs:137`, `src-tauri/src/ticketing/forgejo.rs:116`, `src-tauri/src/ticketing/gitlab.rs:139`
**Reason:** This fix requires a deliberate product/design decision: either implement full Link-header pagination (significant complexity, new async loop per provider) or return a structured warning to the caller when results are truncated. Both approaches affect the API surface and UX in ways that should not be decided automatically. The fix suggestion acknowledges this is a "silent data loss bug" but the correct remedy is design-level, not a mechanical patch. Flagged for human review.
**Original issue:** None of the three providers follow pagination links, so issues beyond page 1 (>100 for GitHub/GitLab, >50 for Forgejo) are silently dropped.

---

_Fixed: 2026-05-21T17:50:00Z_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
