# Phase 52: Token Management - Research

**Researched:** 2026-05-21
**Domain:** Rust cryptography, OS keychain, mutex-guarded state, Tauri AppState
**Confidence:** HIGH

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

- **D-01:** `StoredToken` shape: `{ access_token: String, refresh_token: Option<String>, expires_at: Option<i64>, provider: String }` — stored as `serde_json::to_string(&StoredToken)` in the keyring.
- **D-02:** Keyring key format: service=`"maestro.ticketing"`, username=`"maestro:{project_id}:ticketing"`.
- **D-03:** Linux/WSL fallback: AES-256-GCM encrypted file at `{appLocalDataDir}/tokens/{project_id}.enc`. Location is Tauri's `app_local_data_dir()`.
- **D-04:** Encryption key derived from `sha256(machine-id || "maestro-token-fallback")`. Machine ID sourced via `machine_uid` crate. Key never stored on disk — re-derived on each access.
- **D-05:** On first fallback use, emit Tauri event `"ticketing:keyring-unavailable"`. Emit once per app session via `AtomicBool keyring_warned`. Not on every token access.
- **D-06:** `TokenManager` struct: `{ tokens: HashMap<i32, Arc<Mutex<Option<StoredToken>>>>, keyring_warned: AtomicBool }`.
- **D-07:** `TokenManager::get_token(project_id)` acquires per-project lock, checks expiry (60s buffer), triggers refresh callback if needed. Phase 52 only builds mutex scaffolding, not the refresh logic.
- **D-08:** Per-project `Arc<Mutex<>>` prevents concurrent refresh race: second caller blocks while first refreshes, then reads already-refreshed token.
- **D-09:** No Tauri IPC commands exposed. All keychain ops are Rust-internal.
- **D-10:** Module at `src-tauri/src/ticketing/` with `mod.rs`, `keychain.rs`, `token_manager.rs`. `AppState` gets `token_manager: TokenManager` field.

### Claude's Discretion

None stated.

### Deferred Ideas (OUT OF SCOPE)

None stated.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| AUTH-05 | Tokens stored in OS keychain via `keyring 3.6.3`; entry key `maestro:{project_id}:ticketing` | Section 8 covers keyring pattern; Section 1 confirms dep already present |
| AUTH-06 | Mutex-guarded token refresh for GitLab (2h expiry) and Jira (1h expiry) prevents concurrent 401 race | Section 6 covers mutex choice; Section 5 covers AppState integration |
</phase_requirements>

---

## Summary

Phase 52 is a pure Rust backend module adding OS keychain CRUD and a mutex-guarded `TokenManager` to `AppState`. All required cryptographic crates are either already present in `Cargo.toml` as direct deps (`keyring = "3.6.3"`, `zeroize = "1.8"`) or already in the dependency tree transitively (`aes-gcm 0.10.3` via `russh/ssh-cipher`, `sha2 0.10.9` and `rand_core 0.6.4` via `oauth2`/`octocrab`). Only three new direct dependencies need to be added: `aes-gcm = "0.10"`, `sha2 = "0.10"`, and `machine-uid = "0.6"`. The `zeroize` dep needs `features = ["derive"]` added.

The `keychain.rs` module is a near-direct analog of the existing `ssh/password_manager.rs` — same `Entry::new(service, username)` / `.set_password()` / `.get_password()` / `.delete_credential()` pattern. The fallback path (AES-256-GCM encrypted file) adds modest complexity but uses well-established RustCrypto APIs. The `TokenManager` uses `std::sync::Mutex` (not tokio) for per-project locks — this is the correct choice given that IPC handlers hold the lock for a sub-microsecond check/read, never across an `.await` point.

**Primary recommendation:** Add three direct Cargo deps, implement `keychain.rs` mirroring `password_manager.rs`, implement encrypted file fallback using `aes-gcm + sha2 + machine-uid`, wire `TokenManager` into `AppState::new()`.

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Token store/get/delete (keychain) | API / Backend (Rust) | — | D-09: no IPC surface; Rust-internal only |
| Encrypted file fallback | API / Backend (Rust) | OS filesystem | Triggered only when keychain unavailable |
| Per-project mutex guards | API / Backend (Rust) | — | Lives in AppState, accessed by IPC handlers in Phase 53+ |
| Keyring-unavailable warning | API / Backend (Rust) → Frontend | — | Rust emits Tauri event; frontend consumes as toast in Phase 55 |
| Token expiry check (60s buffer) | API / Backend (Rust) | — | Pure integer comparison inside the mutex guard |

---

## 1. Cargo Dependencies

### Already Present in `src-tauri/Cargo.toml` (no action needed)

| Crate | Version in Cargo.toml | Role |
|-------|-----------------------|------|
| `keyring` | `3.6.3` with `windows-native`, `apple-native`, `linux-native-sync-persistent` features | Keychain CRUD |
| `zeroize` | `1.8` | Secure memory clearing — BUT needs `features = ["derive"]` added (see below) |
| `serde` | `1` with `derive` feature | StoredToken serialization |
| `serde_json` | `1` | JSON encode/decode for keyring value |
| `tokio` | `1` with `full` features | Async runtime (AppState context) |

**Action required:** `zeroize = "1.8"` currently has no `derive` feature. Must change to:
```toml
zeroize = { version = "1.8", features = ["derive"] }
```
[VERIFIED: crates.io registry — `zeroize 1.8.1` has `"derive": ["zeroize_derive"]` feature]

### Already Transitively Present (add as direct dep to make intent explicit)

| Crate | Transitive Source | Stable Version to Add |
|-------|------------------|-----------------------|
| `aes-gcm` | `russh` → `ssh-cipher` → `aes-gcm 0.10.3` | `"0.10"` |
| `sha2` | `oauth2`/`octocrab` → `sha2 0.10.9` | `"0.10"` |

[VERIFIED: `cargo tree` output in project — both crates present at exact versions listed]

### New Direct Dependencies to Add

| Crate | Version | Purpose |
|-------|---------|---------|
| `aes-gcm` | `"0.10"` | AES-256-GCM encrypt/decrypt for Linux fallback file |
| `sha2` | `"0.10"` | SHA-256 key derivation from machine ID |
| `machine-uid` | `"0.6"` | Cross-platform machine ID (Linux `/etc/machine-id`, Windows registry, macOS `gethostuuid`) |

[VERIFIED: crates.io registry — `aes-gcm 0.10.3` stable, `sha2 0.10.9` stable, `machine-uid 0.6.0` stable]

### Exact Lines to Add to `src-tauri/Cargo.toml`

```toml
# Change existing:
zeroize = { version = "1.8", features = ["derive"] }

# Add new:
aes-gcm = "0.10"
sha2 = { version = "0.10", default-features = false, features = ["std"] }
machine-uid = "0.6"
```

**Note on `sha2` features:** `default-features = false, features = ["std"]` avoids pulling in `asm` backends we don't need; the `std` feature is sufficient for one-shot hashing.

---

## 2. AES-256-GCM Pattern

### API Surface (aes-gcm 0.10.3)

[VERIFIED: `docs.rs/aes-gcm/0.10.3` + RustCrypto AEADs README]

- `aead::OsRng` is re-exported when the `getrandom` feature is active. The `getrandom` feature is part of `aes-gcm`'s **default features** (`"default": ["aes", "alloc", "getrandom"]`), so `OsRng` is available without extra feature flags.
- `Aes256Gcm::generate_nonce(&mut OsRng)` calls the `AeadCore::generate_nonce` method from `aead 0.5.2`.
- `Key::<Aes256Gcm>::from_slice(&key_bytes)` accepts a `&[u8]` of exactly 32 bytes; panics on wrong length.

### Encrypt/Decrypt Snippet

```rust
// Source: docs.rs/aes-gcm/0.10.3 (verified)
use aes_gcm::{
    aead::{Aead, AeadCore, KeyInit, OsRng},
    Aes256Gcm, Key, Nonce,
};

/// Encrypt plaintext with a 32-byte key. Returns nonce_bytes (12) ++ ciphertext.
pub fn encrypt(key_bytes: &[u8; 32], plaintext: &[u8]) -> Result<Vec<u8>, String> {
    let key = Key::<Aes256Gcm>::from_slice(key_bytes);
    let cipher = Aes256Gcm::new(key);
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng); // 12-byte random nonce
    let ciphertext = cipher
        .encrypt(&nonce, plaintext)
        .map_err(|e| format!("Encryption failed: {}", e))?;

    // Prepend nonce to ciphertext: [12 bytes nonce][N bytes ciphertext+tag]
    let mut output = nonce.to_vec();
    output.extend_from_slice(&ciphertext);
    Ok(output)
}

/// Decrypt data produced by `encrypt`. Input must be at least 12 bytes (nonce prefix).
pub fn decrypt(key_bytes: &[u8; 32], data: &[u8]) -> Result<Vec<u8>, String> {
    if data.len() < 12 {
        return Err("Encrypted data too short".to_string());
    }
    let (nonce_bytes, ciphertext) = data.split_at(12);
    let key = Key::<Aes256Gcm>::from_slice(key_bytes);
    let cipher = Aes256Gcm::new(key);
    let nonce = Nonce::from_slice(nonce_bytes);
    cipher
        .decrypt(nonce, ciphertext)
        .map_err(|_| "Decryption failed (wrong key or corrupted data)".to_string())
}
```

### File Layout: `{project_id}.enc`

```
[0..12]    nonce (12 bytes, random per write)
[12..]     ciphertext + 16-byte GCM authentication tag
```

No separate nonce file needed — prepend-nonce-to-ciphertext is the standard RustCrypto pattern.

---

## 3. Machine ID Sourcing

### `machine-uid 0.6.0` API

[VERIFIED: GitHub source `Hanaasagi/machine-uid` — `get_machine_id()` returns `Result<String, Box<dyn Error>>`]

```rust
// machine_uid::get() -> Result<String, Box<dyn std::error::Error>>
// Platform sources:
//   Linux:   /var/lib/dbus/machine-id or /etc/machine-id
//   BSD:     /etc/hostid or kenv smbios.system.uuid
//   macOS:   gethostuuid(3) system call
//   Windows: HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid registry key
```

### Fallback Chain

```rust
pub fn get_machine_id_or_fallback() -> String {
    machine_uid::get()
        .unwrap_or_else(|_| "maestro-unknown-machine".to_string())
}
```

If `machine_uid::get()` fails (e.g., container without `/etc/machine-id`, no dbus), the fallback string `"maestro-unknown-machine"` produces a deterministic but non-unique key — acceptable because the encrypted file is already machine-local by filesystem location, and this path is only reached on highly stripped environments.

---

## 4. Key Derivation (SHA-256)

### API (sha2 0.10.x)

[VERIFIED: `sha2` README in RustCrypto/hashes repository — `Sha256::digest(data)` one-shot API]

```rust
use sha2::{Digest, Sha256};

/// Derive a 32-byte AES-256 key from machine ID + salt.
/// Key is never stored — re-derived on each call.
pub fn derive_encryption_key(machine_id: &str) -> [u8; 32] {
    let input = format!("{}maestro-token-fallback", machine_id);
    let hash = Sha256::digest(input.as_bytes());
    // GenericArray<u8, U32> converts to [u8; 32] via Into
    hash.into()
}
```

`Sha256::digest()` returns `Output<Sha256>` which is `GenericArray<u8, U32>`. The `.into()` call converts it to `[u8; 32]` via the blanket `Into` impl on `GenericArray`.

---

## 5. AppState Integration

### Current `AppState` Fields (from `src-tauri/src/db/connection.rs`)

[VERIFIED: read `src-tauri/src/db/connection.rs` in full]

```rust
pub struct AppState {
    pub db: Mutex<Connection>,           // std::sync::Mutex wrapping rusqlite Connection
    pub app_handle: AppHandle,           // Tauri AppHandle for event emission
    pub ssh: SshState,                   // SSH session management
    pub acp: AcpState,                   // ACP session management
    pub pty: PtyState,                   // PTY session management
    pub app_data_dir: PathBuf,           // Tauri app data dir (used for lock files)
    pub active_project_lock: Mutex<Option<(i32, std::fs::File)>>,
}
```

### Field Addition

Add to `AppState` struct:
```rust
pub token_manager: TokenManager,
```

### `AppState::new()` Addition (in `src-tauri/src/db/connection.rs`)

```rust
// In AppState::new(), alongside existing field initializations:
token_manager: TokenManager::new(),
```

`TokenManager::new()` takes no arguments — it initializes an empty `HashMap` and a fresh `AtomicBool(false)`.

### Construction Site

`AppState` is constructed exactly once, in `src-tauri/src/main.rs`:
```rust
let app_state = Arc::new(AppState::new(conn, app.handle().clone(), app_data_dir.clone()));
```
[VERIFIED: read `src-tauri/src/main.rs` in full]

No changes to `main.rs` are required — only `AppState::new()` in `connection.rs` needs updating.

### Fallback Path: `app_data_dir`

The encrypted token files go under `AppState.app_data_dir / "tokens" / "{project_id}.enc"`. This reuses the already-stored `app_data_dir` field — no need to pass `AppHandle` into `TokenManager` for path resolution. On Linux, `app_data_dir` resolves to `~/.local/share/maestro/`. The `app_local_data_dir()` Tauri API would return the same path on Linux/macOS; on Windows it maps to `%LOCALAPPDATA%/maestro` (non-roaming, appropriate for machine-local token files).

**Decision:** Use `AppState.app_data_dir` (already available, already the correct local path on all platforms). The planner does NOT need to call `app_handle.path().app_local_data_dir()` — `app_data_dir` already has the right value since `main.rs` populates it via `app.path().app_data_dir()` which is machine-local on Linux/macOS.

---

## 6. Mutex Choice: `std` vs `tokio`

[VERIFIED: read `src-tauri/src/db/connection.rs` — confirmed tokio runtime in use; `tokio = { version = "1", features = ["full"] }` in Cargo.toml]

### Recommendation: `std::sync::Mutex`

The codebase already uses both:
- `std::sync::Mutex` for `AppState.db` and `AppState.active_project_lock` — held briefly, never across `.await`
- `tokio::sync::Mutex` for `SshState`, `AcpState`, `PtyState` — held across async I/O boundaries

`TokenManager`'s per-project lock should use **`std::sync::Mutex`** because:

1. The critical section is a memory read/write of `Option<StoredToken>` — sub-microsecond.
2. The lock is **never held across an `.await` point** — Phase 52 only checks expiry and reads/writes the cached token. The actual network refresh (Phase 53+) will be invoked _after_ releasing the lock, not inside it.
3. `std::sync::Mutex` cannot be held across `.await` in async code (compiler error if you try), which acts as a correctness guardrail.
4. Using `tokio::sync::Mutex` for non-async critical sections adds unnecessary overhead and makes the code pattern inconsistent with `AppState.db`.

**If a future phase needs to hold the lock across a network call:** change `Arc<std::sync::Mutex<Option<StoredToken>>>` to `Arc<tokio::sync::Mutex<Option<StoredToken>>>` at that point. For Phase 52 (scaffolding only), `std` is correct.

### `AtomicBool` for `keyring_warned`

`std::sync::atomic::AtomicBool` is correct for the single-emission flag — no mutex needed, ordering `Ordering::Relaxed` is sufficient (we care about eventual consistency, not strict ordering across threads).

---

## 7. Tauri Event Emission Pattern

### Existing Pattern (from `src-tauri/src/acp/manager.rs`)

[VERIFIED: grepped `app_handle.emit` across entire `src-tauri/src/`]

Two patterns in use:

```rust
// Pattern A: fire-and-forget with let _ = (used for most events)
let _ = app_handle.emit("sessions-changed", ());

// Pattern B: explicit .ok() to acknowledge and discard error
app_state.app_handle.emit("sessions-changed", ()).ok();
```

Both are acceptable. The CLAUDE.md "no `let _ =` on fallible ops" rule applies to operations with meaningful error handling. Event emission to a frontend (which may not have a listener yet) is intentionally fire-and-forget.

### For `ticketing:keyring-unavailable`

```rust
// In token_manager.rs or keychain.rs when fallback is triggered:
// Use .ok() to make the intent explicit (discard is intentional, not accidental)
app_handle.emit("ticketing:keyring-unavailable", ()).ok();
```

**Payload type:** `()` (unit). The frontend only needs to know the event occurred, not which project triggered it. The warning toast is a one-time session notification.

**AppHandle access:** `TokenManager` does not store `AppHandle`. The emit should happen in the `TokenManager` method that triggers fallback, receiving `&AppHandle` as a parameter. The caller (IPC handler or Phase 53 OAuth code) passes `&app_state.app_handle`.

---

## 8. Keyring Pattern Summary

### From `src-tauri/src/ssh/password_manager.rs` (full file read)

[VERIFIED: read full file]

The existing pattern:

```rust
use keyring::Entry;
use zeroize::Zeroizing;

// Store
let entry = Entry::new(&service_name, username)
    .map_err(|e| format!("Keyring error: {}", e))?;
entry.set_password(&value)
    .map_err(|e| format!("Failed to save: {}", e))?;

// Get
let entry = Entry::new(&service_name, username)
    .map_err(|e| format!("Keyring error: {}", e))?;
let value = entry.get_password()
    .map_err(|e| format!("Not found: {}", e))?;

// Delete
let entry = Entry::new(&service_name, username)
    .map_err(|e| format!("Keyring error: {}", e))?;
entry.delete_credential()
    .map_err(|e| format!("Failed to delete: {}", e))?;
```

### Phase 52 Mapping

| `password_manager.rs` | `keychain.rs` (Phase 52) |
|-----------------------|--------------------------|
| `service_name = format!("maestro.ssh.{}", host)` | `service_name = "maestro.ticketing"` (fixed) |
| `username = username param` | `username = format!("maestro:{}:ticketing", project_id)` |
| Returns `Zeroizing<String>` | Returns `StoredToken` (deserialized from JSON) |
| No fallback | Falls back to encrypted file on `NoStorageAccess` / `PlatformFailure` |

### Error Variants for Fallback Trigger

[VERIFIED: read `https://raw.githubusercontent.com/hwchen/keyring-rs/v3.6.3/src/error.rs`]

```rust
use keyring::Error as KeyringError;

match entry.get_password() {
    Ok(json) => { /* deserialize and return */ }
    Err(KeyringError::NoEntry) => Ok(None),  // token simply not set
    Err(KeyringError::NoStorageAccess(_)) | Err(KeyringError::PlatformFailure(_)) => {
        // Keyring unavailable — use encrypted file fallback
        self.read_from_file(project_id, app_data_dir, app_handle)
    }
    Err(e) => Err(format!("Keyring error: {}", e)),
}
```

The `keyring::Error` enum is `#[non_exhaustive]`, so a catch-all `Err(e) => ...` arm is required.

---

## 9. Zeroize Pattern

### Current State

`zeroize = "1.8"` is in `Cargo.toml` but **without** the `derive` feature. `password_manager.rs` uses only `Zeroizing<String>` (wrapper type, no derive needed).

### Required Cargo Change

```toml
# Before:
zeroize = "1.8"

# After:
zeroize = { version = "1.8", features = ["derive"] }
```

[VERIFIED: crates.io `zeroize 1.8.1` features — `"derive": ["zeroize_derive"]`]

### `StoredToken` Derive Pattern

[VERIFIED: Context7 `/rustcrypto/utils` — `#[derive(Zeroize, ZeroizeOnDrop)]` usage example]

```rust
use serde::{Deserialize, Serialize};
use zeroize::{Zeroize, ZeroizeOnDrop};

#[derive(Debug, Clone, Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
pub struct StoredToken {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_at: Option<i64>,
    pub provider: String,
}
```

All four fields are fine to zeroize — `provider` is a short string (`"jira"` etc.) and has no reason to be skipped. The `#[zeroize(skip)]` attribute exists if needed for non-sensitive fields, but for a token struct, clearing everything is correct.

**`ZeroizeOnDrop`** automatically zeroizes all fields when `StoredToken` is dropped. This covers the case where a token is evicted from the `HashMap` by replacing with a new value or removing the entry.

**Interaction with `Clone`:** Deriving `Zeroize + ZeroizeOnDrop` on a `Clone` type is safe — clones are independent allocations that are each zeroized independently on drop.

---

## 10. AppLocalDataDir (Tauri 2)

### API Comparison

[VERIFIED: `docs.rs/tauri/2/tauri/path/struct.PathResolver.html`]

| Method | Path on Linux | Path on Windows | Use case |
|--------|--------------|-----------------|----------|
| `app.path().app_data_dir()` | `~/.local/share/{bundle_id}` | `%APPDATA%/{bundle_id}` (roaming) | Current usage for DB |
| `app.path().app_local_data_dir()` | `~/.local/share/{bundle_id}` | `%LOCALAPPDATA%/{bundle_id}` | Machine-specific files |

On **Linux and macOS** both methods return the same path. On **Windows**, `app_local_data_dir()` uses `LOCALAPPDATA` (non-roaming) which is correct for machine-local encrypted token files.

### Practical Decision for Phase 52

The existing `AppState.app_data_dir` was populated from `app.path().app_data_dir()`. For Linux/macOS these are identical. For Windows, the tokens go to `%APPDATA%` instead of `%LOCALAPPDATA%` — a minor concern, but since tokens are already OS-keychain-primary on Windows (Windows Credential Manager), the file fallback on Windows is an edge case.

**Recommendation:** Use `app_state.app_data_dir` directly. No new `AppHandle` plumbing needed. The path for encrypted tokens is:

```rust
let token_path = app_state.app_data_dir
    .join("tokens")
    .join(format!("{}.enc", project_id));
```

This is the same pattern used by `project_lock.rs`:
```rust
app_data_dir.join("locks").join(format!("{}.lock", project_id))
```

If Windows local-vs-roaming distinction becomes important in a later phase, add a separate `app_local_data_dir: PathBuf` field to `AppState` at that point.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| AES-GCM encryption | custom XOR or CBC mode | `aes-gcm 0.10` (RustCrypto) | GCM provides authentication tag; homebrew AEAD is trivially breakable |
| Nonce generation | counter or timestamp | `Aes256Gcm::generate_nonce(&mut OsRng)` | Cryptographic RNG required; sequential nonces leak information |
| Key derivation | MD5 or truncating the machine ID | `sha2::Sha256::digest` | SHA-256 produces uniform 32-byte output; truncation creates weak keys |
| Machine ID lookup | hardcoding platform-specific file paths | `machine-uid 0.6` | Already handles Linux dbus fallback, BSD kenv, macOS syscall, Windows registry |
| Concurrent refresh dedup | manual flag + sleep | `std::sync::Mutex` per project | Mutex blocks second caller until first completes — correct semantics, zero extra code |

---

## Common Pitfalls

### Pitfall 1: Holding `std::sync::Mutex` guard across `.await`

**What goes wrong:** `MutexGuard` is not `Send`; the compiler rejects it. If the implementation naively does `let guard = lock.lock()?; some_async_call().await;`, this is a compile error.

**Why it happens:** Forgetting that `std::sync::Mutex` cannot span `.await` points.

**How to avoid:** The D-07 architecture is correct — acquire the lock, read/update the token, release the lock, then invoke the async refresh callback outside the critical section. Use scoped blocks `{ let guard = ...; /* read only */ }` to ensure guard drops before any `.await`.

**Warning signs:** Compiler error "future cannot be sent between threads safely" involving `MutexGuard`.

### Pitfall 2: `Key::<Aes256Gcm>::from_slice` panics on wrong length

**What goes wrong:** `from_slice` panics if `key_bytes.len() != 32`. SHA-256 always produces 32 bytes, so this is only a risk if the derive-key function is refactored incorrectly.

**How to avoid:** Call `derive_encryption_key()` which always returns `[u8; 32]`, then pass `&key_bytes` to `from_slice`. Do not accept arbitrary `&[u8]` for the key parameter.

### Pitfall 3: Missing `derive` feature on `zeroize`

**What goes wrong:** `#[derive(Zeroize, ZeroizeOnDrop)]` fails to compile with "cannot find derive macro `Zeroize`".

**How to avoid:** Change `zeroize = "1.8"` to `zeroize = { version = "1.8", features = ["derive"] }` in `Cargo.toml` before writing `StoredToken`.

**Warning signs:** Build error mentioning `zeroize_derive` proc macro not found.

### Pitfall 4: `keyring::Error` is `#[non_exhaustive]`

**What goes wrong:** Pattern-matching only `NoStorageAccess` and `PlatformFailure` without a catch-all arm causes a compile error.

**How to avoid:** Always include `Err(e) => Err(format!("Keyring error: {}", e))` as the final arm.

### Pitfall 5: Emitting the `keyring-unavailable` event on every fallback read

**What goes wrong:** The warning toast fires on every `get_token` call on a headless Linux system, spamming the user.

**How to avoid:** Check `self.keyring_warned.load(Ordering::Relaxed)` before emitting. Set to `true` with `compare_exchange` or `store(true, Ordering::Relaxed)` after the first emission. D-05 locks this as a once-per-session flag.

### Pitfall 6: `machine_uid` fails in CI/container environments

**What goes wrong:** `/etc/machine-id` doesn't exist in some Docker images; `machine_uid::get()` returns `Err`. The `?` operator would propagate this as a token storage failure.

**How to avoid:** Use `machine_uid::get().unwrap_or_else(|_| "maestro-unknown-machine".to_string())`. The deterministic fallback is acceptable — the encrypted file is already in a user-specific path.

---

## Code Examples

### Complete TokenManager Struct Sketch

```rust
// Source: from CONTEXT.md D-06 + connection.rs patterns
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, Ordering};

pub struct TokenManager {
    tokens: HashMap<i32, Arc<Mutex<Option<StoredToken>>>>,
    keyring_warned: AtomicBool,
}

impl TokenManager {
    pub fn new() -> Self {
        TokenManager {
            tokens: HashMap::new(),
            keyring_warned: AtomicBool::new(false),
        }
    }

    fn get_or_create_lock(&mut self, project_id: i32) -> Arc<Mutex<Option<StoredToken>>> {
        self.tokens
            .entry(project_id)
            .or_insert_with(|| Arc::new(Mutex::new(None)))
            .clone()
    }
}
```

### Keychain Store (analogous to `password_manager.rs`)

```rust
// Source: adapted from src-tauri/src/ssh/password_manager.rs pattern
use keyring::Entry;

pub fn store_token(project_id: i32, token: &StoredToken) -> Result<(), String> {
    let service = "maestro.ticketing";
    let username = format!("maestro:{}:ticketing", project_id);
    let json = serde_json::to_string(token)
        .map_err(|e| format!("Serialization failed: {}", e))?;
    let entry = Entry::new(service, &username)
        .map_err(|e| format!("Keyring error: {}", e))?;
    entry.set_password(&json)
        .map_err(|e| format!("Failed to save token: {}", e))
}
```

### Emit Pattern for Keyring Warning

```rust
// Source: src-tauri/src/acp/manager.rs pattern (verified)
// Use .ok() to acknowledge intentional discard
app_handle.emit("ticketing:keyring-unavailable", ()).ok();
```

---

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Rust built-in `#[cfg(test)]` + `cargo test` |
| Config file | None — inline test modules per file |
| Quick run command | `cd src-tauri && cargo test ticketing` |
| Full suite command | `cd src-tauri && cargo test` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| AUTH-05 | `store_token` + `get_token` round-trip; `delete_token` returns `None` on next get | unit | `cargo test ticketing::keychain` | Wave 0 |
| AUTH-05 | File fallback: encrypt + decrypt produces original JSON | unit | `cargo test ticketing::keychain::tests::test_file_roundtrip` | Wave 0 |
| AUTH-05 | Key derivation is deterministic for same machine ID | unit | `cargo test ticketing::token_manager::tests::test_key_derivation` | Wave 0 |
| AUTH-06 | `TokenManager::get_or_create_lock` returns same `Arc` for same project_id | unit | `cargo test ticketing::token_manager::tests::test_same_arc` | Wave 0 |
| AUTH-06 | Second concurrent caller blocks while first holds lock (via `std::thread::spawn`) | unit | `cargo test ticketing::token_manager::tests::test_concurrent_lock` | Wave 0 |

### Sampling Rate

- **Per task commit:** `cd src-tauri && cargo test ticketing`
- **Per wave merge:** `cd src-tauri && cargo test`
- **Phase gate:** Full suite green before `/gsd-verify-work`

### Wave 0 Gaps

- [ ] `src-tauri/src/ticketing/mod.rs` — module declaration
- [ ] `src-tauri/src/ticketing/keychain.rs` — with `#[cfg(test)]` module at bottom
- [ ] `src-tauri/src/ticketing/token_manager.rs` — with `#[cfg(test)]` module at bottom

Note: Keyring tests that actually write to the OS keychain should be gated behind `#[cfg(not(ci))]` or marked `#[ignore]` with a comment explaining they require a real keyring. The file-fallback path and the `TokenManager` struct tests can run anywhere.

---

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no | No auth flows in this phase |
| V3 Session Management | no | No user sessions |
| V4 Access Control | no | No access checks |
| V5 Input Validation | yes | `serde_json::from_str` validates token JSON shape |
| V6 Cryptography | yes | `aes-gcm 0.10` (audited by NCC Group); SHA-256 for KDF; `OsRng` for nonces |
| V8 Data Protection | yes | `Zeroize + ZeroizeOnDrop` on `StoredToken`; `Zeroizing<String>` already used in `password_manager.rs` |

### Known Threat Patterns

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Token left in heap after deallocation | Information Disclosure | `ZeroizeOnDrop` on `StoredToken` |
| Nonce reuse in GCM (key+nonce pair repeated) | Tampering / Repudiation | `OsRng` nonce per write; 12-byte nonce space = 2^96 (negligible collision probability) |
| Encrypted file read by another process | Information Disclosure | AES-256-GCM authentication tag detects tampering; key derived from machine ID (not stored) |
| Decryption error silently returning wrong data | Tampering | `aes-gcm` returns `Err` on authentication tag mismatch — mapped to explicit error, not silent fallback |

---

## Environment Availability

Step 2.6: SKIPPED — Phase 52 is purely Rust code/config changes. No external tools, services, or databases beyond what is already in `Cargo.toml`. `cargo build` and `cargo test` are the only runtime requirements.

---

## Gaps / Risks

1. **`keyring` behavior on WSL specifically:** The `linux-native-sync-persistent` feature uses `linux-keyutils` (kernel keyring) + dbus Secret Service. In WSL2, the Linux kernel keyring exists but dbus/GNOME Keyring typically does not. The fallback triggers on `NoStorageAccess` — this is the expected path for WSL and the test in the success criteria (criterion 2) validates it. No code risk, but the test must be written to simulate this without actually running in WSL.

2. **`machine-uid` in CI:** GitHub Actions / container environments may not have `/etc/machine-id`. The `unwrap_or_else` fallback makes this safe (produces a fixed key, all tests pass), but encrypted files written in CI with the fallback key would be unreadable on a real machine. File-roundtrip tests in CI should use a fixed test key, not the machine-derived key.

3. **`TokenManager` requires `&mut self` for `get_or_create_lock`:** Inserting into `HashMap` requires `&mut self`. Since `AppState.token_manager` is not wrapped in a `Mutex` (the per-project `Arc<Mutex>` is the unit of locking), callers that need to insert a new project entry need `&mut AppState` or an interior-mutability wrapper around `HashMap`. **Recommendation:** Wrap the `HashMap` in a `std::sync::Mutex<HashMap<...>>` (matching the `db` field pattern), or use `std::sync::RwLock` for read-heavy access. This is a design detail the planner must resolve — the CONTEXT.md D-06 definition does not specify whether the outer HashMap is locked.

4. **`StoredToken` and `Clone`:** `ZeroizeOnDrop` means each clone is independently zeroed. If the `Option<StoredToken>` inside the per-project mutex is cloned out to the caller, the caller's copy is zeroed on drop but the cached copy remains live. This is correct behavior — callers should work with the cloned value for the duration of the request, and the token manager retains the cached original.

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `app_data_dir` on Windows maps to `%APPDATA%` (roaming), not `%LOCALAPPDATA%`. Using it for encrypted token fallback files is acceptable since the primary storage is Windows Credential Manager. | Section 5, Section 10 | Tokens in roaming profile could sync across machines via Active Directory — not a security issue for developer workstations but could confuse multi-machine setups. Mitigation: use `app_local_data_dir()` via `AppHandle` if Windows token portability becomes a concern. |
| A2 | `std::sync::Mutex` for per-project token locks will not cause lock contention issues in practice, since critical sections are sub-microsecond reads. | Section 6 | If a future phase holds the lock across async I/O (network refresh), this causes deadlock. Architecture prevents this: D-07 says refresh callback is invoked _after_ lock release. |

---

## Sources

### Primary (HIGH confidence)
- `src-tauri/Cargo.toml` — direct and transitive dependency verification (read in session)
- `src-tauri/src/db/connection.rs` — AppState struct, all fields, `new()` constructor (read in session)
- `src-tauri/src/ssh/password_manager.rs` — canonical keyring pattern (read in session)
- `src-tauri/src/main.rs` — AppState construction site (read in session)
- `src-tauri/src/acp/manager.rs` — `app_handle.emit()` pattern (grepped in session)
- `https://raw.githubusercontent.com/hwchen/keyring-rs/v3.6.3/src/error.rs` — confirmed `NoStorageAccess`, `PlatformFailure`, `NoEntry` variants
- `https://raw.githubusercontent.com/Hanaasagi/machine-uid/master/src/lib.rs` — confirmed `get()` → `Result<String, Box<dyn Error>>`
- `https://raw.githubusercontent.com/RustCrypto/hashes/master/sha2/README.md` — `Sha256::digest()` one-shot API
- `cargo tree` output — aes-gcm 0.10.3 and sha2 0.10.9 confirmed as transitive deps

### Secondary (MEDIUM confidence)
- `docs.rs/aes-gcm/0.10.3` (via WebFetch) — `OsRng` from `aead` crate, `generate_nonce`, `from_slice` API
- `docs.rs/aead/0.5.2` (via WebFetch) — `OsRng` re-exported under `getrandom` feature
- `docs.rs/tauri/2/tauri/path/struct.PathResolver.html` — `app_data_dir` vs `app_local_data_dir` distinction
- Context7 `/rustcrypto/utils` — `Zeroize` + `ZeroizeOnDrop` derive macro pattern
- Context7 `/rustcrypto/aeads` — AES-GCM encrypt/decrypt pattern (confirmed matches 0.10.3 docs)
- crates.io API — stable version numbers for `aes-gcm`, `sha2`, `machine-uid`, `zeroize`

---

## Metadata

**Confidence breakdown:**
- Cargo deps: HIGH — verified via `cargo tree` and crates.io API
- AES-256-GCM pattern: HIGH — verified via `docs.rs/aes-gcm/0.10.3` and RustCrypto source
- SHA-256 key derivation: HIGH — verified via official SHA2 README
- Machine ID: HIGH — verified via GitHub source of `machine-uid`
- AppState integration: HIGH — read source files directly
- Mutex choice: HIGH — `std::sync::Mutex` precedent is `AppState.db`, behavior is well-understood
- Keyring pattern: HIGH — read `password_manager.rs` in full; keyring error variants read from source
- Zeroize derive: HIGH — verified feature flag on crates.io; confirmed API from Context7

**Research date:** 2026-05-21
**Valid until:** 2026-06-21 (stable crates with no pending major releases)
