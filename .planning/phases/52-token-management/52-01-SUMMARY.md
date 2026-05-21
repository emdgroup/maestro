---
phase: 52-token-management
plan: 01
subsystem: ticketing
tags: [rust, keychain, aes-gcm, zeroize, tokio, concurrency]

# Dependency graph
requires: [51-data-foundation]
provides:
  - "KeychainStore with OS keychain CRUD and AES-256-GCM encrypted file fallback"
  - "TokenManager with per-project std::sync::Mutex guards and in-memory cache"
  - "token_manager field on AppState"
  - "ticketing:keyring-unavailable Tauri event emitted once per session on fallback"
affects: [53-oauth, 54-api-clients]

# Tech tracking
tech-stack:
  added: [aes-gcm 0.10, machine-uid 0.6, sha2 0.10]
  patterns:
    - "KeychainOutcome<T> enum decouples keychain layer from AppHandle (no event emission in keychain.rs)"
    - "TokenManager uses Mutex<HashMap<i32, Arc<Mutex<Option<StoredToken>>>>> — outer for map mutations, inner per-project for concurrent refresh serialization"
    - "std::sync::Mutex (not tokio) — guards never held across .await, matches AppState.db precedent"
    - "AtomicBool keyring_warned with Ordering::Relaxed for once-per-session event emission"
    - "AES-256-GCM key derived from SHA-256(machine_id + 'maestro-token-fallback') — deterministic, never stored"

key-files:
  created:
    - src-tauri/src/ticketing/mod.rs
    - src-tauri/src/ticketing/keychain.rs
    - src-tauri/src/ticketing/token_manager.rs
  modified:
    - src-tauri/Cargo.toml
    - src-tauri/src/lib.rs
    - src-tauri/src/db/connection.rs

key-decisions:
  - "D-01: KeychainOutcome<T> enum — keychain layer returns tagged result, TokenManager emits event"
  - "D-02: Service key format maestro.ticketing / maestro:{project_id}:ticketing"
  - "D-03: std::sync::Mutex not tokio — guards never held across .await"
  - "D-04: 60-second expiry buffer in get_token — evicts nearly-expired token before Phase 53 refresh races"
  - "D-05: AtomicBool keyring_warned — warning event fires at most once per session"
  - "D-06: File fallback key = SHA-256(machine_id + salt) — obstacle layer, primary is OS keychain"

patterns-established:
  - "TokenManager.get_or_create_lock: outer lock held briefly for HashMap insertion, released before inner lock acquired"
  - "File fallback path: tokens/{project_id}.enc with 12-byte random nonce prepended"
  - "Corrupted/absent file always returns Ok(None) — never propagates IO error as token error"

requirements-completed: [AUTH-05, AUTH-06]

# Metrics
duration: ~2h (including interrupted worktree recovery)
completed: 2026-05-21
---

# Phase 52 Plan 01: Token Management Summary

**OS keychain CRUD with AES-256-GCM encrypted file fallback and mutex-guarded in-memory token cache wired into AppState**

## Performance

- **Duration:** ~2h (including mid-execution interruption and worktree recovery)
- **Completed:** 2026-05-21
- **Tasks:** 5
- **Files created:** 3, modified: 3

## Accomplishments

- `src-tauri/src/ticketing/keychain.rs`: `KeychainStore` with `store_token`, `get_token`, `delete_token` backed by OS keychain (`keyring 3.6.3`); falls back to AES-256-GCM encrypted `{app_data_dir}/tokens/{project_id}.enc` on `NoStorageAccess | PlatformFailure`; 5 unit tests (1 ignored for manual keyring run)
- `src-tauri/src/ticketing/token_manager.rs`: `TokenManager` with per-project `std::sync::Mutex` guards, in-memory cache with 60-second expiry buffer, `ticketing:keyring-unavailable` event emitted once per session via `AtomicBool`; 4 unit tests
- `src-tauri/src/db/connection.rs`: `token_manager: crate::ticketing::TokenManager` field added to `AppState` struct and constructor
- `src-tauri/Cargo.toml`: added `aes-gcm 0.10`, `machine-uid 0.6`, `sha2 0.10`; upgraded `zeroize` to derive feature

## Task Commits

1. **52-01: Cargo deps** — `8652459` (feat)
2. **52-02: Ticketing module skeleton** — `8dd7292` (feat)
3. **52-03: Implement keychain.rs** — `aa7ded9` (feat)
4. **52-04: Implement TokenManager** — `42f031b` (feat)
5. **52-05: Wire into AppState** — `c68048c` (feat)

## Test Results

```
running 10 tests
test ticketing::keychain::tests::test_key_derivation_differs_for_different_ids ... ok
test ticketing::keychain::tests::test_key_derivation_is_deterministic ... ok
test ticketing::keychain::tests::test_keyring_roundtrip ... ignored
test ticketing::keychain::tests::test_file_roundtrip_missing_returns_none ... ok
test ticketing::token_manager::tests::test_get_or_create_lock_different_projects_different_arcs ... ok
test ticketing::keychain::tests::test_file_roundtrip_corrupted_returns_none ... ok
test ticketing::token_manager::tests::test_get_or_create_lock_same_arc ... ok
test ticketing::token_manager::tests::test_now_unix_is_reasonable ... ok
test ticketing::keychain::tests::test_file_roundtrip ... ok
test ticketing::token_manager::tests::test_concurrent_lock_blocks_second_caller ... ok
test result: ok. 9 passed; 1 ignored; 0 failed
```

## Deviations from Plan

### Bug Fixed: Deadlock in test_concurrent_lock_blocks_second_caller

- **Found during:** First test run
- **Issue:** `handle.join()` placed inside the block where `_guard` held the per-project mutex. Spawned thread blocked waiting for lock; main blocked on join; `_guard` never dropped — deadlock.
- **Fix:** Replaced inner `{ }` block with explicit `drop(guard)` before `handle.join()`
- **Files modified:** `src-tauri/src/ticketing/token_manager.rs`

**Total deviations:** 1 bug fix (test logic error, no scope impact)

## Next Phase Readiness

- Phase 53 (OAuth) can call `token_manager.store_token(project_id, token, app_data_dir, app_handle)` after OAuth exchange completes
- Phase 53 can call `token_manager.get_token(project_id, app_data_dir, app_handle)` to retrieve cached or persisted tokens
- The 60-second expiry buffer in `get_token` leaves room for Phase 53 to implement token refresh before using a nearly-expired token
- Frontend can listen for `ticketing:keyring-unavailable` to show a one-time warning about file-based fallback storage

---
*Phase: 52-token-management*
*Completed: 2026-05-21*
