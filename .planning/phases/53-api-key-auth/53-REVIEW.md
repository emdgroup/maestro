---
phase: 53-api-key-auth
reviewed: 2026-05-21T00:00:00Z
depth: standard
files_reviewed: 9
files_reviewed_list:
  - src-tauri/src/models/ticketing.rs
  - src-tauri/src/ticketing/mod.rs
  - src-tauri/src/ticketing/github.rs
  - src-tauri/src/ticketing/gitlab.rs
  - src-tauri/src/ticketing/forgejo.rs
  - src-tauri/src/ipc/ticketing_handlers.rs
  - src-tauri/src/lib.rs
  - src-tauri/src/models/mod.rs
  - src/types/bindings.ts
findings:
  critical: 3
  warning: 4
  info: 2
  total: 9
status: issues_found
---

# Phase 53: Code Review Report

**Reviewed:** 2026-05-21
**Depth:** standard
**Files Reviewed:** 9 (plus supporting `token_manager.rs` and `keychain.rs` read for cross-file analysis)
**Status:** issues_found

## Summary

Phase 53 adds PAT-based authentication for GitHub, GitLab, and Forgejo ticketing providers. The overall structure is sound: tokens are zeroized in memory, error messages do not include token values, and the keychain fallback path uses AES-256-GCM correctly. However, three blockers were found:

1. `owner` and `repo` values from user input are interpolated directly into GitHub/Forgejo API URLs without percent-encoding, allowing path injection that can redirect requests to arbitrary repository endpoints.
2. The `delete_ticketing_credentials` handler only deletes from whichever storage backend is currently accessible, but never attempts to clean both. If credentials were written to the file fallback and the keyring becomes available again at delete time, `delete_credential` returns `NoEntry`, the file is never removed, and the token persists on disk.
3. The file-fallback encryption key is derived solely from the machine ID using a single SHA-256 pass with a hard-coded suffix. This is not key stretching — a short or predictable machine ID produces a weak key with no protection against brute force.

---

## Critical Issues

### CR-01: Path injection via unencoded `owner`/`repo` in GitHub and Forgejo URL construction

**File:** `src-tauri/src/ticketing/github.rs:136-139`, `src-tauri/src/ticketing/forgejo.rs:115-117`

**Issue:** `owner` and `repo` are user-supplied strings interpolated directly into the API URL path with `format!()`. Neither value is percent-encoded. A value like `owner = "real-owner/../../other-org"` produces a URL that resolves to a different repository path than intended. For Forgejo this is especially exploitable since the instance URL is also user-controlled — a crafted `owner` or `repo` could make the request traverse to an arbitrary path on the target server. GitHub's CDN would likely reject path traversal, but the principle is the same: user input must not be raw-interpolated into URL paths.

```rust
// github.rs:136-139 — current (vulnerable)
let url = format!(
    "https://api.github.com/repos/{}/{}/issues?state=open&per_page=100",
    owner, repo
);

// Fix: percent-encode each path segment
let url = format!(
    "https://api.github.com/repos/{}/{}/issues?state=open&per_page=100",
    urlencoding::encode(owner),
    urlencoding::encode(repo),
);
```

Apply the same fix in `forgejo.rs:115-117` for `owner` and `repo`. The `validate_and_store` paths in both files (`github.rs:137` and `forgejo.rs:55`) also embed these values in URLs and need the same treatment.

---

### CR-02: Token persists on disk when `delete_ticketing_credentials` is called while keyring is available

**File:** `src-tauri/src/ticketing/keychain.rs:70-84`

**Issue:** `delete_token` tries the OS keyring first. If the keyring is available and returns `NoEntry` (token was never stored there, because it was originally written to the file fallback), the function returns `Ok(KeychainOutcome::Keychain(()))` and **never deletes the file**. This means:

- User stores credentials on a headless machine → keyring fails → file fallback used → `.enc` file written.
- User runs the app on a different day where a system keyring daemon has started → `delete_credential` returns `NoEntry` → `delete_file` is never called → `.enc` file remains.
- The user believes credentials are gone; they are not.

The fix is to always attempt file deletion in addition to (or instead of fallback from) keyring deletion:

```rust
pub fn delete_token(
    project_id: i32,
    app_data_dir: &Path,
) -> Result<KeychainOutcome<()>, String> {
    let entry = Entry::new(SERVICE, &username(project_id))
        .map_err(|e| format!("Keyring error: {}", e))?;

    let keyring_result = entry.delete_credential();

    // Always attempt to clean up the file fallback too, regardless of
    // whether the keyring had an entry, to prevent stale .enc files.
    Self::delete_file(project_id, app_data_dir)?;

    match keyring_result {
        Ok(()) => Ok(KeychainOutcome::Keychain(())),
        Err(keyring::Error::NoEntry) => Ok(KeychainOutcome::Keychain(())),
        Err(keyring::Error::NoStorageAccess(_)) | Err(keyring::Error::PlatformFailure(_)) => {
            Ok(KeychainOutcome::FileFallback(()))
        }
        Err(e) => Err(format!("Failed to delete token: {}", e)),
    }
}
```

---

### CR-03: File-fallback encryption key is derived without key stretching — weak against low-entropy machine IDs

**File:** `src-tauri/src/ticketing/keychain.rs:87-90`

**Issue:** The AES-256-GCM key is derived as `SHA256(machine_id || "maestro-token-fallback")`. SHA-256 is a fast hash — it is not a key derivation function. On platforms where `machine_uid::get()` returns a short, low-entropy, or predictable identifier (e.g., a simple UUID stored in a world-readable file, or the fallback constant `"maestro-unknown-machine"`), an attacker with access to the `.enc` file can brute-force the key in seconds using a GPU. The fallback constant `"maestro-unknown-machine"` is a known value, so any machine where `machine_uid` fails produces a file that is trivially decryptable.

```rust
// Current — fast hash, no stretching
fn derive_key(machine_id: &str) -> [u8; 32] {
    let input = format!("{}maestro-token-fallback", machine_id);
    let hash = Sha256::digest(input.as_bytes());
    hash.into()
}

// Fix: use Argon2 or PBKDF2 with a per-file random salt
// (salt stored in the first 16 bytes of the .enc file alongside the nonce)
// Or at minimum, document clearly that this path provides weak protection
// and is only a defense-in-depth measure against naive file access.
```

At minimum, this needs a code comment clearly marking the security boundary, and the `"maestro-unknown-machine"` fallback should instead generate and persist a random local secret rather than using a constant.

---

## Warnings

### WR-01: Inconsistent pagination — GitHub fetches 100 issues, Forgejo caps at 50 with no paging for either

**File:** `src-tauri/src/ticketing/github.rs:137`, `src-tauri/src/ticketing/forgejo.rs:116`, `src-tauri/src/ticketing/gitlab.rs:139`

**Issue:** GitHub and GitLab use `per_page=100` (the API maximum), while Forgejo uses `limit=50`. More importantly, none of the three providers follow pagination links (`Link: <...>; rel="next"` headers). For any project with more than 100 open GitHub/GitLab issues or 50 Forgejo issues, issues beyond the first page are silently dropped. Users will see an incomplete list with no indication that data is missing. This is a silent data loss bug, not a performance issue.

**Fix:** Either follow pagination (parse `Link` response header, loop until no `next` relation), or add a response header check and return an error/warning to the caller when the response is truncated (i.e., when `issues.len() == per_page`).

---

### WR-02: `save_ticketing_config` IPC command allows overwriting provider config without token validation

**File:** `src-tauri/src/ipc/ticketing_handlers.rs:27-49`

**Issue:** `save_ticketing_config` writes arbitrary `TicketingConfig` (including a `ProviderConfig`) directly to disk without any credential validation. A caller can set the provider to `Gitlab` with any `instance_url` and `project_id` without a token being verified. A subsequent `fetch_remote_issues` call would then use whatever token is stored in the token manager for that project, against the new (unvalidated) provider config. This creates an SSRF-adjacent risk: the stored token is sent to whatever `instance_url` the caller writes, as long as they can call this IPC command.

The dedicated `save_github_credentials` / `save_gitlab_credentials` / `save_forgejo_credentials` handlers validate tokens before saving config — but `save_ticketing_config` bypasses that. If `save_ticketing_config` is intended to be a raw config write (for the currently unimplemented providers), the function should at minimum reject writes that set a `ProviderConfig` variant for which a stored token already exists, or it should clear the stored token when the provider changes.

**Fix:**
```rust
// At the start of save_ticketing_config, if config.provider is changing,
// delete the stored token to force re-validation.
if config.provider.is_some() {
    // Clear any stale credential so the next fetch_remote_issues
    // is forced through a validate_and_store path.
    app_state.token_manager.delete_token(
        project_id,
        &app_state.app_data_dir,
        &app_state.app_handle,
    ).ok();  // best-effort; not fatal if no token stored
}
```

---

### WR-03: `get_token` cache does not distinguish between "expired" and "no expiry" correctly — clock skew can cause premature eviction

**File:** `src-tauri/src/ticketing/token_manager.rs:62-72`

**Issue:** The cache check is:
```rust
if exp - now_unix() >= 60 {
    return Ok(Some(token.clone()));
}
```
PATs for GitHub, GitLab, and Forgejo do not expire (`expires_at` is `None`), so this path is never triggered for them. However, the code reaches the `None` branch correctly and returns the cached token. The issue is subtler: if `now_unix()` returns a value greater than `exp` (already expired), `exp - now_unix()` underflows on unsigned arithmetic — but here both are `i64`, so it wraps to a large negative number that is less than 60, correctly evicting. This specific case is fine.

The real problem: if `exp` is `Some(0)` (e.g., from a corrupt or default-constructed token), `0 - now_unix()` is a large negative number. The token is evicted immediately and every subsequent call re-reads from the keychain. This is a correctness issue, not just a performance issue, because it produces an infinite keychain-read loop for any caller that holds the cached lock and is unlucky enough to get a zero-expiry token stored.

**Fix:** Guard against zero/negative expiry values:
```rust
if let Some(exp) = token.expires_at {
    if exp > 0 && exp - now_unix() >= 60 {
        return Ok(Some(token.clone()));
    }
    // expired or invalid — evict
    *cached = None;
} else {
    return Ok(Some(token.clone()));
}
```

---

### WR-04: `normalize_instance_url` is duplicated verbatim in `gitlab.rs` and `forgejo.rs`

**File:** `src-tauri/src/ticketing/gitlab.rs:27-36`, `src-tauri/src/ticketing/forgejo.rs:25-34`

**Issue:** Both files contain an identical `pub fn normalize_instance_url` with identical logic. This is not just cosmetic: if a bug is found (e.g., missing trim of leading whitespace, or a new scheme to handle), it must be fixed in two places. There is no test that proves the two copies remain in sync. The `ticketing/mod.rs` is the natural home for a shared helper.

**Fix:** Move to `src-tauri/src/ticketing/mod.rs` as a `pub(super)` or `pub` function, and replace both module-level copies with `use crate::ticketing::normalize_instance_url;` or `super::normalize_instance_url(...)`.

---

## Info

### IN-01: `TicketingConfig::updated_at` defaults to empty string, which is not a valid RFC 3339 timestamp

**File:** `src-tauri/src/models/ticketing.rs:8-14`

**Issue:** `TicketingConfig` derives `Default`, which sets `updated_at` to `String::default()` (empty string). `load_from_project` falls back to `unwrap_or_default()` on parse error, producing a `TicketingConfig` with `updated_at = ""`. This empty string passes through the IPC boundary to the frontend as a `TicketingConfig` with `updated_at: ""`, which is inconsistent with every other `updated_at` field in the codebase that contains RFC 3339 strings. Any frontend code that tries to parse this as a date will silently produce `Invalid Date`.

**Fix:** Change the default to `now_rfc3339()`, or make `updated_at: Option<String>` so the absence is typed.

---

### IN-02: `save_ticketing_config` IPC command is exposed but has no callers that validate credentials — it is an unconstrained raw-write path

**File:** `src-tauri/src/ipc/ticketing_handlers.rs:27-49`, `src-tauri/src/lib.rs:127-128`

**Issue:** `save_ticketing_config` is registered in `create_builder()` and will appear in the generated TypeScript bindings. It accepts a raw `TicketingConfig` struct with no validation. The intent of Phase 53 is that provider config is saved only via `save_github_credentials`, `save_gitlab_credentials`, and `save_forgejo_credentials` (which validate the token). `save_ticketing_config` bypasses that entirely and is potentially callable from any frontend component that imports `commands.saveTicketingConfig`. If this command is only intended for clearing the config (setting `provider: null`), it should be narrowed or renamed. If it is intended to remain a raw write path, its security implications compound WR-02 above.

**Fix:** Either restrict to `provider: null` writes only (for "disconnect provider" use case), or remove from the registered command list until a specific need arises.

---

_Reviewed: 2026-05-21_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
