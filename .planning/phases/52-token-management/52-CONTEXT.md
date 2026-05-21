# Phase 52: Token Management - Context

**Gathered:** 2026-05-21
**Status:** Ready for planning

<domain>
## Phase Boundary

Build the OS keychain CRUD layer for OAuth tokens and the mutex-guarded `TokenManager` that prevents concurrent refresh races for GitLab and Jira. No OAuth flows (Phase 53). No provider API calls (Phase 54). No frontend UI (Phase 55). This phase is purely Rust backend infrastructure.

Deliverables:
- `src-tauri/src/ticketing/keychain.rs` — store/get/delete token operations via `keyring`
- `src-tauri/src/ticketing/token_manager.rs` — `TokenManager` with per-project mutexes
- Linux/WSL fallback to encrypted file when keyring unavailable
- `TokenManager` wired into `AppState`

</domain>

<decisions>
## Implementation Decisions

### Token Value Shape (D-01)
- **D-01:** Store a serialized JSON struct in the keyring, not a raw access token string.
  ```rust
  #[derive(Serialize, Deserialize)]
  pub struct StoredToken {
      pub access_token: String,
      pub refresh_token: Option<String>,
      pub expires_at: Option<i64>,  // Unix timestamp seconds
      pub provider: String,          // "jira" | "github" | "gitlab" | "linear"
  }
  ```
  The keyring value is `serde_json::to_string(&StoredToken)`. `expires_at` enables proactive refresh in Phases 53/54 without a separate keyring entry.

### Keyring Key Format (D-02)
- **D-02:** Key format locked from REQUIREMENTS.md AUTH-05: `maestro:{project_id}:ticketing` as the username, with a fixed service name `"maestro.ticketing"`. Follows the `password_manager.rs` pattern (`Entry::new(service, username)`).

### Linux/WSL Fallback (D-03)
- **D-03:** When `keyring` returns `NoStorageAccess` or `PlatformFailure`, fall back to an AES-256-GCM encrypted file at `{appLocalDataDir}/tokens/{project_id}.enc`. Location is Tauri's `app_local_data_dir()` — machine-local, never in the project directory, no gitignore concern.
- **D-04:** Encryption key derived from `sha256(machine-id || "maestro-token-fallback")`. Machine ID sourced via `machine_uid` crate (cross-platform) or `/etc/machine-id` on Linux. Key is never stored on disk — re-derived on each access.
- **D-05:** On first fallback use, emit a Tauri event `ticketing:keyring-unavailable` to trigger a warning toast in the frontend. Emit once per app session (track with a bool in `TokenManager`), not on every token access.

### TokenManager Architecture (D-06)
- **D-06:** `TokenManager` is a single struct held in `AppState` with per-project mutexes:
  ```rust
  pub struct TokenManager {
      tokens: HashMap<i32, Arc<Mutex<Option<StoredToken>>>>,
      keyring_warned: AtomicBool,
  }
  ```
  Per-project `Arc<Mutex<>>` means two different projects can refresh independently without blocking each other. `keyring_warned` tracks whether the fallback warning has been emitted this session.
- **D-07:** `TokenManager::get_token(project_id)` acquires the per-project lock, checks expiry (if `expires_at` is within 60 seconds of now, triggers refresh callback), then releases lock. The refresh callback is a `Box<dyn Fn(...) -> Future>` passed by Phase 53 callers — Phase 52 only builds the mutex scaffolding, not the actual network refresh.
- **D-08:** Mutex guards against the concurrent-refresh race: if two callers hit an expired token simultaneously, the second caller blocks on the per-project lock while the first refreshes. After the first stores the new token and releases the lock, the second reads the already-refreshed token without making another network request.

### IPC Surface (D-09)
- **D-09:** Phase 52 exposes NO Tauri IPC commands. Keychain operations are Rust-internal only. The frontend never calls store/get/delete directly — Phase 55 will use `get_ticketing_config` (already exists from Phase 51) to determine connected state. Token presence inferred from `TicketingConfig.provider` being set.

### Module Location (D-10)
- **D-10:** New module at `src-tauri/src/ticketing/` (new subdirectory). `mod.rs` exports `keychain` and `token_manager` submodules. `AppState` gets a `token_manager: TokenManager` field. Follow flat-file convention: `ticketing/keychain.rs`, `ticketing/token_manager.rs`, `ticketing/mod.rs`.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Existing Keyring Pattern
- `src-tauri/src/ssh/password_manager.rs` — canonical `keyring::Entry::new(service, username)` pattern to follow exactly

### Requirements
- `.planning/REQUIREMENTS.md` §Auth — AUTH-05 (keychain storage), AUTH-06 (mutex-guarded refresh)
- `.planning/ROADMAP.md` §Phase 52 — success criteria (3 criteria, all Rust-internal tests)

### AppState Integration
- `src-tauri/src/db/mod.rs` or `src-tauri/src/lib.rs` — where `AppState` is defined; `TokenManager` field added here

### Cargo Dependencies (already in Cargo.toml from Phase 50)
- `keyring = { version = "3.6.3", features = ["windows-native", "apple-native", "linux-native-sync-persistent"] }`
- `zeroize = "1.8"` — already present, use for token zeroization on drop

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src-tauri/src/ssh/password_manager.rs` — exact keyring pattern: `Entry::new(service, username)`, `.set_password()`, `.get_password()`, `.delete_credential()`. Phase 52 keychain module is a direct analog.
- `zeroize` already a dep — wrap `StoredToken.access_token` and `refresh_token` fields in `Zeroizing<String>` for secure memory clearing on drop.

### Established Patterns
- No `unwrap()` — all keyring errors propagate via `?` or map to `String`
- No `let _ =` on fallible ops — handle keyring errors explicitly
- No Rust logging (`tracing::`, `log::`) — errors surface via IPC return values or Tauri events
- `AppState` uses `Arc<Mutex<>>` for thread-safe access — `TokenManager` fits the same pattern

### Integration Points
- `AppState` (in `src-tauri/src/db/`) gets a new `token_manager: TokenManager` field
- `AppState` is constructed in `lib.rs` — `TokenManager::new()` called there
- Tauri event emission: `app_handle.emit("ticketing:keyring-unavailable", ())` for the warning toast

</code_context>

<specifics>
## Specific Ideas

- `expires_at` stored as Unix timestamp (i64 seconds) — simple integer comparison for expiry check, no datetime parsing overhead
- 60-second refresh buffer: treat token as expired if `expires_at - now() < 60s` — avoids race where token expires mid-request
- `machine_uid` crate or `/etc/machine-id` for encryption key derivation on Linux — check if `machine_uid` is already a dep before adding

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>

---

*Phase: 52-Token Management*
*Context gathered: 2026-05-21*
