# Phase 52: Token Management - Pattern Map

**Mapped:** 2026-05-21
**Files analyzed:** 5 (3 new, 2 modified)
**Analogs found:** 5 / 5

---

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `src-tauri/src/ticketing/keychain.rs` | service | CRUD | `src-tauri/src/ssh/password_manager.rs` | exact |
| `src-tauri/src/ticketing/token_manager.rs` | service | CRUD | `src-tauri/src/db/connection.rs` (SshState / PtyState) | role-match |
| `src-tauri/src/ticketing/mod.rs` | config | — | `src-tauri/src/ssh/mod.rs` | exact |
| `src-tauri/src/db/connection.rs` (AppState field) | model | — | existing `active_project_lock` field addition | exact |
| `src-tauri/src/lib.rs` (mod + pub use) | config | — | existing `pub mod ssh` + `pub use` lines | exact |

---

## Pattern Assignments

### `src-tauri/src/ticketing/keychain.rs` (service, CRUD)

**Analog:** `src-tauri/src/ssh/password_manager.rs` (read in full, 73 lines)

This file is a direct structural clone of `password_manager.rs`. Every function maps 1:1.

**Imports pattern** (analog lines 1-2 — adapt service name constant):
```rust
use keyring::Entry;
use zeroize::Zeroizing;
```

**Core CRUD pattern** (analog lines 4-42):

The analog uses a unit struct with `impl` methods. Phase 52 follows the same shape. Function mapping:

| `password_manager.rs` function | `keychain.rs` equivalent | Key difference |
|---|---|---|
| `store_password(host, username, password)` | `store_token(project_id, token_json)` | service fixed to `"maestro.ticketing"`, username is `format!("maestro:{}:ticketing", project_id)` |
| `get_password(host, username) -> Zeroizing<String>` | `get_token(project_id) -> Zeroizing<String>` | same keyring key derivation |
| `delete_password(host, username)` | `delete_token(project_id)` | same |

**Keyring key construction** (analog lines 9-11 — change service/username format per D-02):
```rust
// password_manager.rs constructs:
let service_name = format!("maestro.ssh.{}", host);
let entry = Entry::new(&service_name, username)
    .map_err(|e| format!("Keyring error: {}", e))?;

// keychain.rs constructs (D-02):
const SERVICE: &str = "maestro.ticketing";
let username = format!("maestro:{}:ticketing", project_id);
let entry = Entry::new(SERVICE, &username)
    .map_err(|e| format!("Keyring error: {}", e))?;
```

**Error handling pattern** (analog lines 11-15 — identical `.map_err` style):
```rust
entry
    .set_password(&token_json)
    .map_err(|e| format!("Failed to save token: {}", e))?;
Ok(())
```

**Return type for get** (analog lines 26-28):
```rust
Ok(Zeroizing::new(password))
// Phase 52: return Zeroizing<String> wrapping the JSON string
Ok(Zeroizing::new(token_json))
```

**Delete credential** (analog lines 37-39):
```rust
entry
    .delete_credential()
    .map_err(|e| format!("Failed to delete token: {}", e))?;
Ok(())
```

**Anti-pattern to avoid:** Do NOT use `unwrap()` anywhere. The analog has zero `unwrap()` calls — every keyring error is mapped to a `String` via `.map_err(|e| format!(...))`.

**Linux/WSL fallback addition (no analog — new code):**
The fallback path is unique to this module. When `entry.get_password()` / `set_password()` / `delete_credential()` returns a `keyring::Error::NoStorageAccess` or `keyring::Error::PlatformFailure`, the function falls back to the AES-256-GCM encrypted file path. The RESEARCH.md §2 provides the full encrypt/decrypt snippets to use verbatim. Key derivation is in RESEARCH.md §4.

---

### `src-tauri/src/ticketing/token_manager.rs` (service, CRUD)

**Analog:** `src-tauri/src/db/connection.rs` — `SshState` struct (lines 58-84) and `PtyState` struct (lines 114-124)

**Struct shape pattern** (analog `SshState` lines 58-62 — use `std::sync::Mutex` not tokio per D-06 and RESEARCH.md §6):
```rust
// SshState uses tokio::sync::Mutex (wrong for TokenManager — held across await)
// PtyState uses tokio::sync::Mutex for async sessions (also wrong)
// AppState.db uses std::sync::Mutex (CORRECT model for TokenManager)
pub struct TokenManager {
    tokens: HashMap<i32, Arc<std::sync::Mutex<Option<StoredToken>>>>,
    keyring_warned: std::sync::atomic::AtomicBool,
}
```

**Constructor pattern** (analog `AppState::new()` lines 140-167 — initialize with empty HashMap):
```rust
impl TokenManager {
    pub fn new() -> Self {
        TokenManager {
            tokens: HashMap::new(),
            keyring_warned: std::sync::atomic::AtomicBool::new(false),
        }
    }
}
```

**Per-project lock acquisition** (analog `SshState::get_session()` lines 65-67 — adapt to std Mutex):
```rust
// SshState (tokio, async):
pub async fn get_session(&self, connection_id: i32) -> Option<RemoteSshSession> {
    self.sessions.lock().await.get(&connection_id).cloned()
}

// TokenManager (std, sync — note: .lock() not .lock().await):
pub fn get_or_create_lock(&self, project_id: i32) -> Arc<std::sync::Mutex<Option<StoredToken>>> {
    // Must take &mut self or use interior mutability for the HashMap insert
}
```

Note: `HashMap` insert requires `&mut self`. Either use `RwLock<HashMap<...>>` for the outer map, or accept `&mut self` on initialization. Simplest: make `tokens` a `std::sync::Mutex<HashMap<i32, Arc<std::sync::Mutex<Option<StoredToken>>>>>`. This matches `AppState.db: Mutex<Connection>` (analog line 127).

**`StoredToken` shape** (from D-01 — no codebase analog, new struct):
```rust
use serde::{Deserialize, Serialize};
use zeroize::Zeroize;

#[derive(Serialize, Deserialize, Zeroize)]
pub struct StoredToken {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_at: Option<i64>,
    pub provider: String,
}
```

Note: `zeroize = { version = "1.8", features = ["derive"] }` must be in Cargo.toml before using `#[derive(Zeroize)]`.

**Event emission for keyring warning** (D-05 — analog from `src-tauri/src/ipc/review_handlers.rs` line 157 and `src-tauri/src/ssh/sftp.rs` line 81):
```rust
// Simple unit-payload emit (review_handlers.rs pattern):
app_state.app_handle.emit("tasks-changed", ()).ok();

// Phase 52 equivalent — emit once, check AtomicBool first:
use std::sync::atomic::Ordering;
if !self.keyring_warned.load(Ordering::Relaxed) {
    self.keyring_warned.store(true, Ordering::Relaxed);
    app_handle.emit("ticketing:keyring-unavailable", ()).ok();
}
```

**Critical:** `emit` requires `use tauri::Emitter;` — this trait import is mandatory (visible in `src-tauri/src/ssh/sftp.rs` line 6). Without it, `.emit()` does not compile.

**AppHandle availability:** `TokenManager` does not own `AppHandle`. The `app_handle` is passed in as `&AppHandle` at the call site (same as `sftp.rs` where `app_handle: &AppHandle` is a function parameter, line 35). Do NOT store `AppHandle` in `TokenManager` — pass it at call site.

---

### `src-tauri/src/ticketing/mod.rs` (config)

**Analog:** `src-tauri/src/ssh/mod.rs` (7 lines, read in full)

**Pattern** (analog lines 1-8 — direct structural copy):
```rust
// ssh/mod.rs:
pub mod error;
pub mod password_manager;
pub mod session;
pub mod sftp;

pub use error::{is_permanent_error, is_transient_error, SshError};
pub use password_manager::PasswordManager;
// ...

// ticketing/mod.rs (Phase 52):
pub mod keychain;
pub mod token_manager;

pub use keychain::KeychainStore;
pub use token_manager::{TokenManager, StoredToken};
```

Export only what other modules need. Phase 52 has no IPC surface (D-09), so exports are consumed by future Phase 53+ IPC handlers.

---

### `src-tauri/src/db/connection.rs` — AppState field addition

**Analog:** The `active_project_lock` field (line 136) is the most recent field addition — it required no constructor argument, just a value inline in `AppState::new()`.

**Struct field addition** (analog lines 133-136):
```rust
// Existing last field (analog):
pub active_project_lock: Mutex<Option<(i32, std::fs::File)>>,

// Add after it (Phase 52):
pub token_manager: crate::ticketing::TokenManager,
```

**Constructor addition** (analog lines 165):
```rust
// Existing (analog):
active_project_lock: Mutex::new(None),

// Add (Phase 52):
token_manager: crate::ticketing::TokenManager::new(),
```

**Import addition** in `connection.rs` — no new imports needed if using `crate::ticketing::TokenManager` qualified path. Alternatively add to the use block at top of file: `use crate::ticketing::TokenManager;`.

---

### `src-tauri/src/lib.rs` — module registration

**Analog:** Existing `pub mod ssh` (line 6) and `pub use db::{...}` (line 13) pattern.

**Module declaration** (analog lines 1-11):
```rust
// Add alongside existing module declarations:
pub mod ticketing;
```

**Re-export** (analog line 13 — extend the pub use from db or add new pub use):
```rust
// The ticketing module types are accessed via crate::ticketing:: in connection.rs
// No additional pub use needed at lib.rs level for Phase 52 (no IPC commands to register)
// Future phases that add IPC commands will add to collect_commands![...] (lines 22-127)
```

---

## Shared Patterns

### Error Handling (all new Rust files)

**Source:** `src-tauri/src/ssh/password_manager.rs` lines 8-15 and `src-tauri/src/db/connection.rs` lines 29-55

All internal functions return `Result<T, String>`. Error messages use `format!("Descriptive prefix: {}", e)` — never bare `e.to_string()` alone.

```rust
// Standard pattern throughout the codebase:
.map_err(|e| format!("Keyring error: {}", e))?
.map_err(|e| format!("Failed to save token: {}", e))?
```

**Apply to:** `keychain.rs`, `token_manager.rs`

### No Logging

**Source:** CLAUDE.md — "No `tracing::`, or `log::` calls in Rust code."

**Apply to:** All new Rust files. Errors surface via `Result<T, String>` return values or Tauri events. No `println!`, `eprintln!`, `log::`, or `tracing::` calls.

### Zeroize for Sensitive Data

**Source:** `src-tauri/src/ssh/password_manager.rs` line 2 + lines 28, 61 (`Zeroizing::new(...)`)
**Source:** `src-tauri/src/db/connection.rs` line 6, 83 (`Zeroizing<String>` in SshState.passwords)

```rust
use zeroize::Zeroizing;

// Wrap secret return values:
Ok(Zeroizing::new(secret_string))

// For StoredToken struct fields — use #[derive(Zeroize)] once features = ["derive"] added:
use zeroize::Zeroize;
#[derive(Zeroize)]
pub struct StoredToken { ... }
```

**Apply to:** `keychain.rs` (get_token return type), `token_manager.rs` (StoredToken derive)

### Tauri Event Emission

**Source:** `src-tauri/src/ipc/review_handlers.rs` line 157, `src-tauri/src/ssh/sftp.rs` line 6

```rust
// Required trait import — without this, .emit() does not compile:
use tauri::Emitter;

// Unit payload (most common pattern in this codebase):
app_handle.emit("event-name", ()).ok();

// Typed payload (sftp pattern):
let _ = app_handle.emit("event-name", payload_struct);
```

Two styles for discarding the error: `.ok()` (used in IPC handlers) and `let _ =` (used in sftp/acp). Both are acceptable for fire-and-forget events. For the `ticketing:keyring-unavailable` event, use `.ok()` to match the majority pattern.

**Apply to:** `token_manager.rs` (keyring-unavailable warning, D-05)

---

## No Analog Found

All Phase 52 files have analogs. The following sub-patterns within the files have no existing codebase analog (use RESEARCH.md snippets directly):

| Sub-pattern | Location | Reason |
|---|---|---|
| AES-256-GCM encrypt/decrypt | `keychain.rs` fallback path | No encrypted file I/O exists in codebase |
| Machine ID sourcing via `machine_uid` | `keychain.rs` fallback path | No `machine-uid` crate usage exists yet |
| SHA-256 key derivation | `keychain.rs` fallback path | No `sha2` crate usage in application code |
| `keyring::Error` variant matching for fallback trigger | `keychain.rs` | No conditional keyring fallback exists |

For all four, use the verified snippets in RESEARCH.md §2, §3, §4 verbatim.

---

## Copy-Paste Starting Points

### `src-tauri/src/ticketing/keychain.rs` — import block

```rust
use std::path::{Path, PathBuf};

use aes_gcm::{
    aead::{Aead, AeadCore, KeyInit, OsRng},
    Aes256Gcm, Key, Nonce,
};
use keyring::Entry;
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;
```

### `src-tauri/src/ticketing/token_manager.rs` — import block

```rust
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use zeroize::Zeroize;
```

### `src-tauri/src/ticketing/mod.rs` — full file (tiny)

```rust
pub mod keychain;
pub mod token_manager;

pub use keychain::KeychainStore;
pub use token_manager::{TokenManager, StoredToken};
```

### `src-tauri/src/lib.rs` — single line addition (after `pub mod wsl;`)

```rust
pub mod ticketing;
```

### `src-tauri/src/db/connection.rs` — AppState struct addition

```rust
// In AppState struct, after active_project_lock:
pub token_manager: crate::ticketing::TokenManager,

// In AppState::new(), after active_project_lock: Mutex::new(None):
token_manager: crate::ticketing::TokenManager::new(),
```

### `src-tauri/Cargo.toml` — dependency changes

```toml
# Change existing line:
zeroize = { version = "1.8", features = ["derive"] }

# Add new lines (alphabetical order within [dependencies]):
aes-gcm = "0.10"
machine-uid = "0.6"
sha2 = { version = "0.10", default-features = false, features = ["std"] }
```

---

## Metadata

**Analog search scope:** `src-tauri/src/ssh/`, `src-tauri/src/db/`, `src-tauri/src/ipc/`, `src-tauri/src/lib.rs`, `src-tauri/src/project_lock.rs`
**Files read:** `password_manager.rs`, `connection.rs`, `mod.rs` (ssh), `mod.rs` (db), `lib.rs`, `project_lock.rs`, `ticketing_handlers.rs`, `sftp.rs`, `sftp_handlers.rs`, `error.rs` (ssh)
**Pattern extraction date:** 2026-05-21
