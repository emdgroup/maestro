# Phase 52: Token Management — PLAN.md

## Overview

Pure Rust backend module. Adds OS keychain CRUD (`ticketing/keychain.rs`), a mutex-guarded `TokenManager` (`ticketing/token_manager.rs`), and wires `TokenManager` into `AppState`. No IPC commands. No frontend code. Linux/WSL environments that lack a keyring fall back to AES-256-GCM encrypted files under `{app_data_dir}/tokens/`. Concurrent refresh races are prevented by per-project `std::sync::Mutex` guards.

Implements: AUTH-05, AUTH-06.

---

## Tasks

---

### 52-01: Add Cargo dependencies

**Files:** `src-tauri/Cargo.toml`

**Implement:**

1. Open `src-tauri/Cargo.toml`.
2. Find the existing line `zeroize = "1.8"` and replace it with:
   ```toml
   zeroize = { version = "1.8", features = ["derive"] }
   ```
3. Add the following three new lines in the `[dependencies]` section (insert in alphabetical order alongside existing deps):
   ```toml
   aes-gcm = "0.10"
   machine-uid = "0.6"
   sha2 = { version = "0.10", default-features = false, features = ["std"] }
   ```
   - `aes-gcm` and `sha2` are already transitive deps (via `russh` and `oauth2` respectively); adding them as direct deps makes the intent explicit.
   - `machine-uid 0.6` is new — provides cross-platform machine ID (`/etc/machine-id` on Linux, registry on Windows, `gethostuuid` on macOS).
   - `sha2` uses `default-features = false, features = ["std"]` to avoid pulling in the `asm` backend; one-shot hashing only needs `std`.
4. Check whether `tempfile` is already in `[dev-dependencies]`. If it is not present, add a `[dev-dependencies]` section (or extend the existing one) with:
   ```toml
   tempfile = "3"
   ```
   This is required for the `#[cfg(test)]` modules added in tasks 52-03 and 52-04.

**Success:** `cd src-tauri && cargo check` exits 0 with no errors related to the new deps.

---

### 52-02: Create ticketing module skeleton

**Files:**
- `src-tauri/src/ticketing/mod.rs` (create)
- `src-tauri/src/ticketing/keychain.rs` (create)
- `src-tauri/src/ticketing/token_manager.rs` (create)
- `src-tauri/src/lib.rs` (modify)

**Implement:**

1. Create directory `src-tauri/src/ticketing/` if it does not exist.

2. Create `src-tauri/src/ticketing/mod.rs` with this exact content:
   ```rust
   pub mod keychain;
   pub mod token_manager;

   pub use keychain::KeychainStore;
   pub use token_manager::{StoredToken, TokenManager};
   ```

3. Create `src-tauri/src/ticketing/keychain.rs` as a stub that compiles:
   ```rust
   use std::path::Path;

   use aes_gcm::{
       Aes256Gcm, Key, Nonce,
       aead::{Aead, AeadCore, KeyInit, OsRng},
   };
   use keyring::Entry;
   use sha2::{Digest, Sha256};

   use crate::ticketing::token_manager::StoredToken;

   pub struct KeychainStore;
   ```
   Leave the impl body empty for now — it will be filled in task 52-03. The `Zeroizing` import is not needed in `keychain.rs` because it returns `StoredToken` directly (no `Zeroizing<String>` wrapper needed at the keychain level — `StoredToken` itself derives `ZeroizeOnDrop`).

4. Create `src-tauri/src/ticketing/token_manager.rs` as a stub that compiles:
   ```rust
   use std::collections::HashMap;
   use std::sync::{Arc, Mutex};
   use std::sync::atomic::{AtomicBool, Ordering};

   use serde::{Deserialize, Serialize};
   use tauri::{AppHandle, Emitter};
   use zeroize::{Zeroize, ZeroizeOnDrop};

   #[derive(Debug, Clone, Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
   pub struct StoredToken {
       pub access_token: String,
       pub refresh_token: Option<String>,
       pub expires_at: Option<i64>,
       pub provider: String,
   }

   pub struct TokenManager {
       tokens: Mutex<HashMap<i32, Arc<Mutex<Option<StoredToken>>>>>,
       keyring_warned: AtomicBool,
   }
   ```
   Leave `impl TokenManager` empty for now — it will be filled in task 52-04.

5. In `src-tauri/src/lib.rs`, add `pub mod ticketing;` after the existing `pub mod wsl;` line (line 11). No additional `pub use` is needed at the `lib.rs` level for this phase — `AppState` in `connection.rs` uses the qualified `crate::ticketing::` path.

**Success:** `cd src-tauri && cargo check` exits 0. The stubs compile even with empty impl bodies.

---

### 52-03: Implement keychain.rs

**Files:** `src-tauri/src/ticketing/keychain.rs`

**Implement:**

The `StoredToken` definition lives in `token_manager.rs` (from task 52-02). `keychain.rs` imports it via `use crate::ticketing::token_manager::StoredToken`. Implement the full `KeychainStore` in `keychain.rs`.

**API contract for `KeychainStore` public methods:**

The three public methods (`store_token`, `get_token`, `delete_token`) each return a tagged result indicating whether the OS keychain or the file fallback was used. This lets `TokenManager` emit the `ticketing:keyring-unavailable` event without the keychain layer needing an `AppHandle`. Define a helper enum at the top of the file:

```rust
/// Signals which storage backend served the operation.
/// Used by TokenManager to emit the keyring-unavailable warning exactly once.
pub enum KeychainOutcome<T> {
    /// Operation used the OS keychain.
    Keychain(T),
    /// Operation used the encrypted file fallback (keyring was unavailable).
    FileFallback(T),
}
```

The three public methods return `Result<KeychainOutcome<...>, String>`:
- `store_token` → `Result<KeychainOutcome<()>, String>`
- `get_token` → `Result<KeychainOutcome<Option<StoredToken>>, String>`
- `delete_token` → `Result<KeychainOutcome<()>, String>`

1. Define the service constant and username helper:
   ```rust
   const SERVICE: &str = "maestro.ticketing";

   fn username(project_id: i32) -> String {
       format!("maestro:{}:ticketing", project_id)
   }
   ```
   This matches the key format from D-02.

2. Implement `store_token(project_id: i32, token: &StoredToken, app_data_dir: &Path) -> Result<KeychainOutcome<()>, String>`:
   - Serialize token to JSON: `serde_json::to_string(token).map_err(|e| format!("Serialization failed: {}", e))?`
   - Construct `Entry::new(SERVICE, &Self::username(project_id)).map_err(|e| format!("Keyring error: {}", e))?`
   - Match on `entry.set_password(&json)`:
     - `Ok(())`: return `Ok(KeychainOutcome::Keychain(()))`.
     - `Err(keyring::Error::NoStorageAccess(_)) | Err(keyring::Error::PlatformFailure(_))`: call `Self::write_to_file(project_id, token, app_data_dir)?` and return `Ok(KeychainOutcome::FileFallback(()))`.
     - `Err(e)`: return `Err(format!("Failed to save token: {}", e))`.
   - `keyring::Error` is `#[non_exhaustive]`, so the catch-all `Err(e) =>` arm is mandatory.

3. Implement `get_token(project_id: i32, app_data_dir: &Path) -> Result<KeychainOutcome<Option<StoredToken>>, String>`:
   - Construct entry and match on `entry.get_password()`:
     - `Ok(json)`: deserialize and return `Ok(KeychainOutcome::Keychain(Some(token)))`.
     - `Err(keyring::Error::NoEntry)`: return `Ok(KeychainOutcome::Keychain(None))` — token simply not set.
     - `Err(keyring::Error::NoStorageAccess(_)) | Err(keyring::Error::PlatformFailure(_))`: call `Self::read_from_file(project_id, app_data_dir)?` and return `Ok(KeychainOutcome::FileFallback(result))`.
     - `Err(e)`: return `Err(format!("Keyring error: {}", e))`.

4. Implement `delete_token(project_id: i32, app_data_dir: &Path) -> Result<KeychainOutcome<()>, String>`:
   - Construct entry and match on `entry.delete_credential()`:
     - `Ok(())`: return `Ok(KeychainOutcome::Keychain(()))`.
     - `Err(keyring::Error::NoEntry)`: return `Ok(KeychainOutcome::Keychain(()))` — already gone is not an error.
     - `Err(keyring::Error::NoStorageAccess(_)) | Err(keyring::Error::PlatformFailure(_))`: call `Self::delete_file(project_id, app_data_dir)?` and return `Ok(KeychainOutcome::FileFallback(()))`.
     - `Err(e)`: return `Err(format!("Failed to delete token: {}", e))`.

5. Implement private helper `derive_key(machine_id: &str) -> [u8; 32]`:
   ```rust
   fn derive_key(machine_id: &str) -> [u8; 32] {
       let input = format!("{}maestro-token-fallback", machine_id);
       let hash = Sha256::digest(input.as_bytes());
       hash.into()
   }
   ```
   `Sha256::digest()` returns `GenericArray<u8, U32>`; `.into()` converts to `[u8; 32]` via the blanket impl.

6. Implement private helper `get_machine_id() -> String`:
   ```rust
   fn get_machine_id() -> String {
       machine_uid::get().unwrap_or_else(|_| "maestro-unknown-machine".to_string())
   }
   ```
   Use `unwrap_or_else` — `/etc/machine-id` may not exist in containers or minimal Linux images. The fallback string is deterministic, making the derived key stable for a given environment even if not unique across machines.

7. Implement private helper `token_file_path(project_id: i32, app_data_dir: &Path) -> std::path::PathBuf`:
   ```rust
   fn token_file_path(project_id: i32, app_data_dir: &Path) -> std::path::PathBuf {
       app_data_dir.join("tokens").join(format!("{}.enc", project_id))
   }
   ```

8. Implement private helper `write_to_file(project_id: i32, token: &StoredToken, app_data_dir: &Path) -> Result<(), String>`:
   - Create the `tokens/` directory if it does not exist:
     `std::fs::create_dir_all(app_data_dir.join("tokens")).map_err(|e| format!("Failed to create tokens directory: {}", e))?`
   - Serialize token to JSON bytes: `let plaintext = serde_json::to_vec(token).map_err(|e| format!("Serialization failed: {}", e))?;`
   - Derive key: `let key_bytes = Self::derive_key(&Self::get_machine_id());`
   - Encrypt (verified snippet from RESEARCH.md §2):
     ```rust
     let key = Key::<Aes256Gcm>::from_slice(&key_bytes);
     let cipher = Aes256Gcm::new(key);
     let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
     let ciphertext = cipher
         .encrypt(&nonce, plaintext.as_slice())
         .map_err(|e| format!("Encryption failed: {}", e))?;
     let mut output = nonce.to_vec();
     output.extend_from_slice(&ciphertext);
     ```
   - Write `output` to `Self::token_file_path(project_id, app_data_dir)`:
     `std::fs::write(Self::token_file_path(project_id, app_data_dir), &output).map_err(|e| format!("Failed to write token file: {}", e))?;`
   - Return `Ok(())`.

9. Implement private helper `read_from_file(project_id: i32, app_data_dir: &Path) -> Result<Option<StoredToken>, String>`:
   - If the file does not exist: return `Ok(None)`.
   - Read bytes from file. If reading fails: return `Ok(None)` (corrupted or inaccessible file is treated as absent, never as an error).
   - If `data.len() < 12`: return `Ok(None)` (malformed file).
   - Derive key.
   - Decrypt (verified snippet from RESEARCH.md §2):
     ```rust
     let (nonce_bytes, ciphertext) = data.split_at(12);
     let key = Key::<Aes256Gcm>::from_slice(&key_bytes);
     let cipher = Aes256Gcm::new(key);
     let nonce = Nonce::from_slice(nonce_bytes);
     let plaintext = match cipher.decrypt(nonce, ciphertext) {
         Ok(p) => p,
         Err(_) => return Ok(None), // wrong key or corrupted — treat as absent
     };
     ```
   - Deserialize: `serde_json::from_slice::<StoredToken>(&plaintext).map(Some).map_err(|e| format!("Token deserialization failed: {}", e))`.

10. Implement private helper `delete_file(project_id: i32, app_data_dir: &Path) -> Result<(), String>`:
    - Get path: `let path = Self::token_file_path(project_id, app_data_dir);`
    - If the file does not exist: return `Ok(())`.
    - `std::fs::remove_file(&path).map_err(|e| format!("Failed to delete token file: {}", e))`.

11. At the bottom of `keychain.rs`, add the test module:
    ```rust
    #[cfg(test)]
    mod tests {
        use super::*;

        fn test_token() -> StoredToken {
            StoredToken {
                access_token: "test_access".to_string(),
                refresh_token: Some("test_refresh".to_string()),
                expires_at: Some(9999999999),
                provider: "github".to_string(),
            }
        }

        #[test]
        fn test_file_roundtrip() {
            let dir = tempfile::tempdir().expect("tempdir");
            let token = test_token();
            KeychainStore::write_to_file(42, &token, dir.path()).expect("write");
            let result = KeychainStore::read_from_file(42, dir.path()).expect("read");
            let retrieved = result.expect("token present");
            assert_eq!(retrieved.access_token, "test_access");
            assert_eq!(retrieved.refresh_token.as_deref(), Some("test_refresh"));
            assert_eq!(retrieved.expires_at, Some(9999999999));
            assert_eq!(retrieved.provider, "github");
        }

        #[test]
        fn test_file_roundtrip_missing_returns_none() {
            let dir = tempfile::tempdir().expect("tempdir");
            let result = KeychainStore::read_from_file(99, dir.path()).expect("no error on absent");
            assert!(result.is_none());
        }

        #[test]
        fn test_file_roundtrip_corrupted_returns_none() {
            let dir = tempfile::tempdir().expect("tempdir");
            std::fs::create_dir_all(dir.path().join("tokens")).unwrap();
            std::fs::write(dir.path().join("tokens/1.enc"), b"corrupted_data_not_encrypted").unwrap();
            let result = KeychainStore::read_from_file(1, dir.path()).expect("no error on corrupted");
            assert!(result.is_none());
        }

        #[test]
        fn test_key_derivation_is_deterministic() {
            let key1 = KeychainStore::derive_key("test-machine-id");
            let key2 = KeychainStore::derive_key("test-machine-id");
            assert_eq!(key1, key2);
        }

        #[test]
        fn test_key_derivation_differs_for_different_ids() {
            let key1 = KeychainStore::derive_key("machine-a");
            let key2 = KeychainStore::derive_key("machine-b");
            assert_ne!(key1, key2);
        }

        // Requires a real OS keychain. Skip in CI.
        // Run manually: cargo test ticketing::keychain::tests::test_keyring_roundtrip -- --ignored
        #[test]
        #[ignore = "requires OS keychain (run manually)"]
        fn test_keyring_roundtrip() {
            let dir = tempfile::tempdir().expect("tempdir");
            let token = test_token();
            KeychainStore::store_token(1001, &token, dir.path()).expect("store");
            let result = KeychainStore::get_token(1001, dir.path()).expect("get");
            let inner = match result {
                KeychainOutcome::Keychain(v) | KeychainOutcome::FileFallback(v) => v,
            };
            let retrieved = inner.expect("token present after store");
            assert_eq!(retrieved.access_token, "test_access");
            KeychainStore::delete_token(1001, dir.path()).expect("delete");
            let after_delete = KeychainStore::get_token(1001, dir.path()).expect("after delete");
            let inner2 = match after_delete {
                KeychainOutcome::Keychain(v) | KeychainOutcome::FileFallback(v) => v,
            };
            assert!(inner2.is_none());
        }
    }
    ```

**Success:** `cd src-tauri && cargo test ticketing::keychain` passes. The file-roundtrip, corrupted-file, and key-derivation tests all run without `#[ignore]`. The keyring test is skipped automatically.

---

### 52-04: Implement TokenManager

**Files:** `src-tauri/src/ticketing/token_manager.rs`

**Implement:**

The `StoredToken` struct is already defined in this file (from task 52-02). Add the full `impl TokenManager` block and the `now_unix` helper.

1. Implement `TokenManager::new() -> Self`:
   ```rust
   impl TokenManager {
       pub fn new() -> Self {
           TokenManager {
               tokens: Mutex::new(HashMap::new()),
               keyring_warned: AtomicBool::new(false),
           }
       }
   ```
   The outer `Mutex<HashMap<...>>` is required because `AppState` is held behind `Arc<AppState>` with no `&mut self` access — interior mutability is needed for HashMap insertion.

2. Implement private helper `get_or_create_lock(&self, project_id: i32) -> Arc<Mutex<Option<StoredToken>>>`:
   ```rust
   fn get_or_create_lock(&self, project_id: i32) -> Arc<Mutex<Option<StoredToken>>> {
       let mut map = self.tokens.lock().expect("token map lock poisoned");
       map.entry(project_id)
           .or_insert_with(|| Arc::new(Mutex::new(None)))
           .clone()
   }
   ```
   `.expect()` is acceptable — a poisoned `std::sync::Mutex` indicates a prior panic in the lock holder, which is a programming error.

3. Add a module-level private helper (outside `impl`):
   ```rust
   fn now_unix() -> i64 {
       std::time::SystemTime::now()
           .duration_since(std::time::UNIX_EPOCH)
           .map(|d| d.as_secs() as i64)
           .unwrap_or(0)
   }
   ```

4. Add a private helper `fn emit_keyring_warning_once(&self, app_handle: &AppHandle)`:
   ```rust
   fn emit_keyring_warning_once(&self, app_handle: &AppHandle) {
       if !self.keyring_warned.load(Ordering::Relaxed) {
           self.keyring_warned.store(true, Ordering::Relaxed);
           app_handle.emit("ticketing:keyring-unavailable", ()).ok();
       }
   }
   ```
   D-05: the event fires at most once per session regardless of how many subsequent fallback operations occur.

5. Implement `get_token(&self, project_id: i32, app_data_dir: &std::path::Path, app_handle: &AppHandle) -> Result<Option<StoredToken>, String>`:
   - Get per-project lock: `let project_lock = self.get_or_create_lock(project_id);`
   - Acquire it: `let mut cached = project_lock.lock().expect("per-project token lock poisoned");`
   - If `cached.is_some()`, check expiry:
     - If `expires_at` is `Some(ts)` and `ts - now_unix() < 60`: clear the cache (`*cached = None`) and fall through to the keychain read. This evicts a nearly-expired token so Phase 53's refresh path can replace it.
     - Otherwise: return `Ok(cached.clone())`.
   - If `cached.is_none()`: call `crate::ticketing::keychain::KeychainStore::get_token(project_id, app_data_dir)`.
     - On `Ok(KeychainOutcome::FileFallback(result))`: call `self.emit_keyring_warning_once(app_handle)`, then process `result`.
     - On `Ok(KeychainOutcome::Keychain(result))`: process `result` directly.
     - On `Err(e)`: return `Err(e)`.
   - If result is `Some(token)`: set `*cached = Some(token.clone())` and return `Ok(Some(token))`.
   - If result is `None`: return `Ok(None)`.
   - The lock guard `cached` is dropped at the end of the function scope — this function is synchronous and the guard is never held across an `.await` point.

6. Implement `store_token(&self, project_id: i32, token: StoredToken, app_data_dir: &std::path::Path, app_handle: &AppHandle) -> Result<(), String>`:
   - Get per-project lock and acquire it.
   - Call `crate::ticketing::keychain::KeychainStore::store_token(project_id, &token, app_data_dir)`.
   - On `Ok(KeychainOutcome::FileFallback(()))`: call `self.emit_keyring_warning_once(app_handle)`.
   - On `Ok(KeychainOutcome::Keychain(()))`: no event.
   - On `Err(e)`: return `Err(e)`.
   - Update cache: `*cached = Some(token)`.
   - Return `Ok(())`.

7. Implement `delete_token(&self, project_id: i32, app_data_dir: &std::path::Path, app_handle: &AppHandle) -> Result<(), String>`:
   - Get per-project lock and acquire it.
   - Call `crate::ticketing::keychain::KeychainStore::delete_token(project_id, app_data_dir)`.
   - On `Ok(KeychainOutcome::FileFallback(()))`: call `self.emit_keyring_warning_once(app_handle)`.
   - On `Ok(KeychainOutcome::Keychain(()))`: no event.
   - On `Err(e)`: return `Err(e)`.
   - Clear cache: `*cached = None`.
   - Return `Ok(())`.

8. At the bottom of `token_manager.rs`, add the test module:
   ```rust
   #[cfg(test)]
   mod tests {
       use super::*;
       use std::sync::atomic::Ordering;

       fn test_token(provider: &str) -> StoredToken {
           StoredToken {
               access_token: "tok".to_string(),
               refresh_token: None,
               expires_at: Some(9999999999),
               provider: provider.to_string(),
           }
       }

       #[test]
       fn test_get_or_create_lock_same_arc() {
           let manager = TokenManager::new();
           let arc1 = manager.get_or_create_lock(1);
           let arc2 = manager.get_or_create_lock(1);
           assert!(Arc::ptr_eq(&arc1, &arc2), "same project_id must return the same Arc");
       }

       #[test]
       fn test_get_or_create_lock_different_projects_different_arcs() {
           let manager = TokenManager::new();
           let arc1 = manager.get_or_create_lock(1);
           let arc2 = manager.get_or_create_lock(2);
           assert!(!Arc::ptr_eq(&arc1, &arc2), "different project_ids must return different Arcs");
       }

       #[test]
       fn test_concurrent_lock_blocks_second_caller() {
           use std::sync::Barrier;
           use std::thread;

           let manager = Arc::new(TokenManager::new());
           let barrier = Arc::new(Barrier::new(2));
           let order = Arc::new(Mutex::new(Vec::<i32>::new()));

           let project_lock = manager.get_or_create_lock(1);
           {
               let _guard = project_lock.lock().unwrap();

               let barrier2 = Arc::clone(&barrier);
               let order2 = Arc::clone(&order);
               let project_lock2 = Arc::clone(&project_lock);

               let handle = thread::spawn(move || {
                   barrier2.wait();
                   let _g = project_lock2.lock().unwrap();
                   order2.lock().unwrap().push(2);
               });

               barrier.wait();
               order.lock().unwrap().push(1);
               // _guard drops here, unblocking the spawned thread
               handle.join().unwrap();
           }

           let seen = order.lock().unwrap().clone();
           assert_eq!(seen, vec![1, 2], "second caller must not proceed before first releases lock");
       }

       #[test]
       fn test_now_unix_is_reasonable() {
           let ts = now_unix();
           // 2020-01-01 in Unix seconds
           assert!(ts > 1_577_836_800, "timestamp must be after 2020-01-01");
       }
   }
   ```

**Success:** `cd src-tauri && cargo test ticketing::token_manager` passes. All four tests run without `#[ignore]`.

---

### 52-05: Wire TokenManager into AppState

**Files:**
- `src-tauri/src/db/connection.rs` (modify)

**Implement:**

1. Open `src-tauri/src/db/connection.rs`.

2. In the `AppState` struct (currently ending at `active_project_lock` on line 136), add the `token_manager` field immediately after `active_project_lock`:
   ```rust
   pub active_project_lock: Mutex<Option<(i32, std::fs::File)>>,
   /// Mutex-guarded token storage for ticketing provider tokens.
   /// Per-project locks prevent concurrent refresh races (AUTH-06).
   pub token_manager: crate::ticketing::TokenManager,
   ```

3. In `AppState::new()` (the struct literal starting at line 141), add the field initialization immediately after `active_project_lock: Mutex::new(None),`:
   ```rust
   active_project_lock: Mutex::new(None),
   token_manager: crate::ticketing::TokenManager::new(),
   ```

4. No import changes are required in `connection.rs` — using the `crate::ticketing::TokenManager` qualified path avoids adding a `use` statement. The `crate::ticketing` module is declared in `lib.rs` (added in task 52-02).

5. No changes to `src-tauri/src/main.rs` are required. `AppState::new()` takes `(conn, app_handle, app_data_dir)` — the new field is initialized inside `new()` with no external arguments.

**Success:** `cd src-tauri && cargo check` exits 0. `cd src-tauri && cargo test` passes — all existing tests plus the ticketing tests from tasks 52-03 and 52-04.

---

## Verification

After all tasks are complete, run the full test suite:

```
cd src-tauri && cargo test
```

All tests must pass. Specifically verify:

| Test | Expected |
|------|----------|
| `ticketing::keychain::tests::test_file_roundtrip` | passes |
| `ticketing::keychain::tests::test_file_roundtrip_missing_returns_none` | passes |
| `ticketing::keychain::tests::test_file_roundtrip_corrupted_returns_none` | passes |
| `ticketing::keychain::tests::test_key_derivation_is_deterministic` | passes |
| `ticketing::keychain::tests::test_key_derivation_differs_for_different_ids` | passes |
| `ticketing::token_manager::tests::test_get_or_create_lock_same_arc` | passes |
| `ticketing::token_manager::tests::test_get_or_create_lock_different_projects_different_arcs` | passes |
| `ticketing::token_manager::tests::test_concurrent_lock_blocks_second_caller` | passes |
| `ticketing::token_manager::tests::test_now_unix_is_reasonable` | passes |
| `ticketing::keychain::tests::test_keyring_roundtrip` | skipped (`#[ignore]`) |

---

## Threat Model

### Trust Boundaries

| Boundary | Description |
|----------|-------------|
| Keychain → memory | Token deserialized from OS keychain or encrypted file into `StoredToken` in heap memory |
| Memory → file | Token serialized to JSON and AES-256-GCM encrypted before writing to `{app_data_dir}/tokens/*.enc` |
| Outer `Mutex<HashMap>` → per-project `Arc<Mutex<Option<StoredToken>>>` | Two-layer locking: outer for map mutations (insert new project), inner for per-project reads/writes |

### STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation |
|-----------|----------|-----------|-------------|------------|
| T-52-01 | Information Disclosure | `StoredToken` heap allocation | mitigate | `#[derive(Zeroize, ZeroizeOnDrop)]` on `StoredToken` — all String fields zeroed on drop; each cloned value zeroed independently |
| T-52-02 | Tampering | `{project_id}.enc` file on disk | mitigate | AES-256-GCM authentication tag detects tampering; `Aes256Gcm::decrypt` returns `Err` on tag mismatch — mapped to `Ok(None)` (treat as absent), never silent wrong data |
| T-52-03 | Information Disclosure | GCM nonce reuse | mitigate | `Aes256Gcm::generate_nonce(&mut OsRng)` produces a cryptographically random 12-byte nonce per write; 2^96 nonce space makes collision negligible |
| T-52-04 | Information Disclosure | Encryption key derivability from machine ID | accept | Key is SHA-256(machine_id + salt), never stored. An attacker with filesystem read access to the `.enc` file also has access to `/etc/machine-id` (same machine), so the encrypted file is an obstacle layer, not a strong vault. Acceptable: primary storage is the OS keychain; file fallback only triggers when keychain is unavailable. |
| T-52-05 | Denial of Service | `std::sync::Mutex` poisoning under panic | accept | `.expect("lock poisoned")` is correct: a poisoned mutex indicates a prior panic in the holder, which is a programming error. Propagating the panic is preferable to silently continuing with undefined state. |
| T-52-06 | Denial of Service | `keyring_warned` event spam under concurrent fallback | mitigate | `AtomicBool` with `Ordering::Relaxed` plus `emit_keyring_warning_once` ensures the event fires at most once per session even if multiple threads hit the fallback path simultaneously; second concurrent call sees the flag already set and skips emission |

---

## Edge Cases

All edge cases from the task description are addressed:

- **Keyring `NoStorageAccess` on WSL without dbus session**: All three public `KeychainStore` methods match on `NoStorageAccess | PlatformFailure` and route to the file fallback, returning `KeychainOutcome::FileFallback`. `TokenManager` emits `ticketing:keyring-unavailable` once per session via `emit_keyring_warning_once`. The file-roundtrip tests verify the fallback path works without any keychain present.

- **Two async Tauri commands call `get_token` for the same project simultaneously**: `get_or_create_lock` returns the same `Arc<Mutex<...>>` for the same `project_id`. The second concurrent caller blocks on `project_lock.lock()` until the first releases it. `test_concurrent_lock_blocks_second_caller` verifies this ordering.

- **`machine-uid` returns error in minimal Linux containers**: `get_machine_id()` uses `.unwrap_or_else(|_| "maestro-unknown-machine".to_string())`. The fallback string is non-empty and produces a valid 32-byte SHA-256 key. `test_key_derivation_is_deterministic` uses a fixed string and confirms deterministic output.

- **Token file `.enc` exists but is corrupted**: `read_from_file` returns `Ok(None)` on any of: file unreadable, `data.len() < 12`, or AES-GCM authentication tag failure. It never panics and never returns corrupted data. `test_file_roundtrip_corrupted_returns_none` verifies this.

- **`tokens/` directory does not exist on first write**: `write_to_file` calls `std::fs::create_dir_all(app_data_dir.join("tokens"))` before writing. `test_file_roundtrip` implicitly verifies this using a fresh `tempfile::tempdir()` that starts with no subdirectories.

---

## Success Criteria (Phase 52 gate)

Matching the ROADMAP.md success criteria:

1. A token can be stored via `ticketing/keychain.rs` using the `maestro:{project_id}:ticketing` key and retrieved in a subsequent call without error; deleting it returns `None` on the next get. *(Verified by `test_file_roundtrip` for the file fallback path; `test_keyring_roundtrip` for the keychain path when run manually on a machine with an OS keychain.)*

2. On Linux/WSL where the system keyring is unavailable, the app falls back to an encrypted file store and a `ticketing:keyring-unavailable` Tauri event is emitted exactly once per session. *(Verified structurally: `test_file_roundtrip` confirms the file fallback path works; `emit_keyring_warning_once` + `AtomicBool` enforces the once-per-session invariant.)*

3. Two concurrent calls attempting to refresh a token for the same project simultaneously result in serialized access — the second caller blocks until the first releases the per-project lock. *(Verified by `test_concurrent_lock_blocks_second_caller`.)*
