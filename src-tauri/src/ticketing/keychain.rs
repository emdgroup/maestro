use std::path::{Path, PathBuf};

use aes_gcm::{
    Aes256Gcm, Key, Nonce,
    aead::{Aead, AeadCore, KeyInit, OsRng},
};
use keyring::Entry;
use sha2::{Digest, Sha256};

use crate::models::integration::IntegrationCredentials;
use crate::ticketing::token_manager::StoredToken;

/// Signals which storage backend served the operation.
/// Used by TokenManager to emit the keyring-unavailable warning exactly once.
pub enum KeychainOutcome<T> {
    /// Operation used the OS keychain.
    Keychain(T),
    /// Operation used the encrypted file fallback (keyring was unavailable).
    FileFallback(T),
}

const SERVICE: &str = "maestro.ticketing";

fn integration_key(provider: &str) -> String {
    format!("maestro:integration:{}", provider)
}

fn username(project_id: i32) -> String {
    format!("maestro:{}:ticketing", project_id)
}

pub struct KeychainStore;

impl KeychainStore {
    // ── New provider-keyed API (Phase 55) ────────────────────────────────────

    pub fn store_integration(
        provider: &str,
        creds: &IntegrationCredentials,
        app_data_dir: &Path,
    ) -> Result<KeychainOutcome<()>, String> {
        let json = serde_json::to_string(creds)
            .map_err(|e| format!("Serialization failed: {}", e))?;
        let entry = Entry::new(SERVICE, &integration_key(provider))
            .map_err(|e| format!("Keyring error: {}", e))?;
        match entry.set_password(&json) {
            Ok(()) => Ok(KeychainOutcome::Keychain(())),
            Err(keyring::Error::NoStorageAccess(_)) | Err(keyring::Error::PlatformFailure(_)) => {
                Self::write_integration_to_file(provider, creds, app_data_dir)?;
                Ok(KeychainOutcome::FileFallback(()))
            }
            Err(e) => Err(format!("Failed to save integration: {}", e)),
        }
    }

    pub fn get_integration(
        provider: &str,
        app_data_dir: &Path,
    ) -> Result<KeychainOutcome<Option<IntegrationCredentials>>, String> {
        let entry = Entry::new(SERVICE, &integration_key(provider))
            .map_err(|e| format!("Keyring error: {}", e))?;
        match entry.get_password() {
            Ok(json) => {
                let creds = serde_json::from_str::<IntegrationCredentials>(&json)
                    .map_err(|e| format!("Integration deserialization failed: {}", e))?;
                Ok(KeychainOutcome::Keychain(Some(creds)))
            }
            Err(keyring::Error::NoEntry) => Ok(KeychainOutcome::Keychain(None)),
            Err(keyring::Error::NoStorageAccess(_)) | Err(keyring::Error::PlatformFailure(_)) => {
                let result = Self::read_integration_from_file(provider, app_data_dir)?;
                Ok(KeychainOutcome::FileFallback(result))
            }
            Err(e) => Err(format!("Keyring error: {}", e)),
        }
    }

    pub fn delete_integration(
        provider: &str,
        app_data_dir: &Path,
    ) -> Result<KeychainOutcome<()>, String> {
        let entry = Entry::new(SERVICE, &integration_key(provider))
            .map_err(|e| format!("Keyring error: {}", e))?;
        let keyring_result = entry.delete_credential();
        // Always attempt to clean up the file fallback too, regardless of whether
        // the keyring had an entry — a token may have been written to the file
        // fallback on a previous run where the keyring was unavailable, and later
        // the keyring became accessible again.
        let _ = Self::delete_integration_file(provider, app_data_dir);
        match keyring_result {
            Ok(()) => Ok(KeychainOutcome::Keychain(())),
            Err(keyring::Error::NoEntry) => Ok(KeychainOutcome::Keychain(())),
            Err(keyring::Error::NoStorageAccess(_)) | Err(keyring::Error::PlatformFailure(_)) => {
                Ok(KeychainOutcome::FileFallback(()))
            }
            Err(e) => Err(format!("Failed to delete integration: {}", e)),
        }
    }

    fn integration_file_path(provider: &str, app_data_dir: &Path) -> PathBuf {
        app_data_dir.join("tokens").join(format!("{}.enc", provider))
    }

    fn write_integration_to_file(
        provider: &str,
        creds: &IntegrationCredentials,
        app_data_dir: &Path,
    ) -> Result<(), String> {
        std::fs::create_dir_all(app_data_dir.join("tokens"))
            .map_err(|e| format!("Failed to create tokens directory: {}", e))?;
        let plaintext = serde_json::to_vec(creds)
            .map_err(|e| format!("Serialization failed: {}", e))?;
        let key_bytes = Self::derive_key(&Self::get_encryption_seed(app_data_dir));
        let key = Key::<Aes256Gcm>::from_slice(&key_bytes);
        let cipher = Aes256Gcm::new(key);
        let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
        let ciphertext = cipher
            .encrypt(&nonce, plaintext.as_slice())
            .map_err(|e| format!("Encryption failed: {}", e))?;
        let mut output = nonce.to_vec();
        output.extend_from_slice(&ciphertext);
        std::fs::write(Self::integration_file_path(provider, app_data_dir), &output)
            .map_err(|e| format!("Failed to write integration file: {}", e))?;
        Ok(())
    }

    fn read_integration_from_file(
        provider: &str,
        app_data_dir: &Path,
    ) -> Result<Option<IntegrationCredentials>, String> {
        let path = Self::integration_file_path(provider, app_data_dir);
        if !path.exists() {
            return Ok(None);
        }
        let data = match std::fs::read(&path) {
            Ok(bytes) => bytes,
            Err(_) => return Ok(None),
        };
        if data.len() < 12 {
            return Ok(None);
        }
        let key_bytes = Self::derive_key(&Self::get_encryption_seed(app_data_dir));
        let (nonce_bytes, ciphertext) = data.split_at(12);
        let key = Key::<Aes256Gcm>::from_slice(&key_bytes);
        let cipher = Aes256Gcm::new(key);
        let nonce = Nonce::from_slice(nonce_bytes);
        let plaintext = match cipher.decrypt(nonce, ciphertext) {
            Ok(p) => p,
            Err(_) => return Ok(None),
        };
        serde_json::from_slice::<IntegrationCredentials>(&plaintext)
            .map(Some)
            .map_err(|e| format!("Integration deserialization failed: {}", e))
    }

    fn delete_integration_file(provider: &str, app_data_dir: &Path) -> Result<(), String> {
        let path = Self::integration_file_path(provider, app_data_dir);
        if !path.exists() {
            return Ok(());
        }
        std::fs::remove_file(&path)
            .map_err(|e| format!("Failed to delete integration file: {}", e))
    }

    // ── Legacy project-id-keyed API (Phase 52/53/54 compatibility) ───────────

    pub fn store_token(
        project_id: i32,
        token: &StoredToken,
        app_data_dir: &Path,
    ) -> Result<KeychainOutcome<()>, String> {
        let json = serde_json::to_string(token)
            .map_err(|e| format!("Serialization failed: {}", e))?;
        let entry = Entry::new(SERVICE, &username(project_id))
            .map_err(|e| format!("Keyring error: {}", e))?;
        match entry.set_password(&json) {
            Ok(()) => Ok(KeychainOutcome::Keychain(())),
            Err(keyring::Error::NoStorageAccess(_)) | Err(keyring::Error::PlatformFailure(_)) => {
                Self::write_to_file(project_id, token, app_data_dir)?;
                Ok(KeychainOutcome::FileFallback(()))
            }
            Err(e) => Err(format!("Failed to save token: {}", e)),
        }
    }

    pub fn get_token(
        project_id: i32,
        app_data_dir: &Path,
    ) -> Result<KeychainOutcome<Option<StoredToken>>, String> {
        let entry = Entry::new(SERVICE, &username(project_id))
            .map_err(|e| format!("Keyring error: {}", e))?;
        match entry.get_password() {
            Ok(json) => {
                let token = serde_json::from_str::<StoredToken>(&json)
                    .map_err(|e| format!("Token deserialization failed: {}", e))?;
                Ok(KeychainOutcome::Keychain(Some(token)))
            }
            Err(keyring::Error::NoEntry) => Ok(KeychainOutcome::Keychain(None)),
            Err(keyring::Error::NoStorageAccess(_)) | Err(keyring::Error::PlatformFailure(_)) => {
                let result = Self::read_from_file(project_id, app_data_dir)?;
                Ok(KeychainOutcome::FileFallback(result))
            }
            Err(e) => Err(format!("Keyring error: {}", e)),
        }
    }

    pub fn delete_token(
        project_id: i32,
        app_data_dir: &Path,
    ) -> Result<KeychainOutcome<()>, String> {
        let entry = Entry::new(SERVICE, &username(project_id))
            .map_err(|e| format!("Keyring error: {}", e))?;
        let keyring_result = entry.delete_credential();
        // Always attempt to clean up the file fallback too, regardless of whether
        // the keyring had an entry — a token may have been written to the file
        // fallback on a previous run where the keyring was unavailable, and later
        // the keyring became accessible again. Without this, the stale .enc file
        // would persist even after a successful "delete credentials" operation.
        let _ = Self::delete_file(project_id, app_data_dir);
        match keyring_result {
            Ok(()) => Ok(KeychainOutcome::Keychain(())),
            Err(keyring::Error::NoEntry) => Ok(KeychainOutcome::Keychain(())),
            Err(keyring::Error::NoStorageAccess(_)) | Err(keyring::Error::PlatformFailure(_)) => {
                Ok(KeychainOutcome::FileFallback(()))
            }
            Err(e) => Err(format!("Failed to delete token: {}", e)),
        }
    }

    // ── Shared cryptographic helpers ─────────────────────────────────────────

    // Key derivation uses SHA-256 (not a KDF). This provides defense-in-depth
    // against naive file access but not against targeted brute force. The file
    // fallback is used only when the OS keychain is unavailable.
    fn derive_key(seed: &str) -> [u8; 32] {
        let input = format!("{}maestro-token-fallback", seed);
        let hash = Sha256::digest(input.as_bytes());
        hash.into()
    }

    /// Returns the machine ID if available, otherwise reads or creates a persistent
    /// random local secret in app_data_dir. The random secret is generated once and
    /// stored so that encrypted files remain decryptable across restarts.
    fn get_encryption_seed(app_data_dir: &Path) -> String {
        if let Ok(id) = machine_uid::get() {
            return id;
        }
        let secret_path = app_data_dir.join("tokens").join("maestro-local-secret");
        if let Ok(existing) = std::fs::read_to_string(&secret_path) {
            let trimmed = existing.trim().to_string();
            if !trimmed.is_empty() {
                return trimmed;
            }
        }
        use rand::RngCore;
        let mut buf = [0u8; 32];
        rand::rngs::OsRng.fill_bytes(&mut buf);
        let hex: String = buf.iter().map(|b| format!("{:02x}", b)).collect();
        // Best-effort persist — if this fails, a new secret will be generated next
        // time, making existing encrypted files unreadable. This is acceptable: the
        // file fallback is last-resort when neither machine_uid nor keyring work.
        if let Some(parent) = secret_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(&secret_path, &hex);
        hex
    }

    fn token_file_path(project_id: i32, app_data_dir: &Path) -> PathBuf {
        app_data_dir.join("tokens").join(format!("{}.enc", project_id))
    }

    fn write_to_file(
        project_id: i32,
        token: &StoredToken,
        app_data_dir: &Path,
    ) -> Result<(), String> {
        std::fs::create_dir_all(app_data_dir.join("tokens"))
            .map_err(|e| format!("Failed to create tokens directory: {}", e))?;
        let plaintext = serde_json::to_vec(token)
            .map_err(|e| format!("Serialization failed: {}", e))?;
        let key_bytes = Self::derive_key(&Self::get_encryption_seed(app_data_dir));
        let key = Key::<Aes256Gcm>::from_slice(&key_bytes);
        let cipher = Aes256Gcm::new(key);
        let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
        let ciphertext = cipher
            .encrypt(&nonce, plaintext.as_slice())
            .map_err(|e| format!("Encryption failed: {}", e))?;
        let mut output = nonce.to_vec();
        output.extend_from_slice(&ciphertext);
        std::fs::write(Self::token_file_path(project_id, app_data_dir), &output)
            .map_err(|e| format!("Failed to write token file: {}", e))?;
        Ok(())
    }

    fn read_from_file(
        project_id: i32,
        app_data_dir: &Path,
    ) -> Result<Option<StoredToken>, String> {
        let path = Self::token_file_path(project_id, app_data_dir);
        if !path.exists() {
            return Ok(None);
        }
        let data = match std::fs::read(&path) {
            Ok(bytes) => bytes,
            Err(_) => return Ok(None),
        };
        if data.len() < 12 {
            return Ok(None);
        }
        let key_bytes = Self::derive_key(&Self::get_encryption_seed(app_data_dir));
        let (nonce_bytes, ciphertext) = data.split_at(12);
        let key = Key::<Aes256Gcm>::from_slice(&key_bytes);
        let cipher = Aes256Gcm::new(key);
        let nonce = Nonce::from_slice(nonce_bytes);
        let plaintext = match cipher.decrypt(nonce, ciphertext) {
            Ok(p) => p,
            Err(_) => return Ok(None),
        };
        serde_json::from_slice::<StoredToken>(&plaintext)
            .map(Some)
            .map_err(|e| format!("Token deserialization failed: {}", e))
    }

    fn delete_file(project_id: i32, app_data_dir: &Path) -> Result<(), String> {
        let path = Self::token_file_path(project_id, app_data_dir);
        if !path.exists() {
            return Ok(());
        }
        std::fs::remove_file(&path)
            .map_err(|e| format!("Failed to delete token file: {}", e))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::integration::CredentialSource;

    fn test_token() -> StoredToken {
        StoredToken {
            access_token: "test_access".to_string(),
            refresh_token: Some("test_refresh".to_string()),
            expires_at: Some(9999999999),
            provider: "github".to_string(),
        }
    }

    fn test_credentials(provider: &str) -> IntegrationCredentials {
        IntegrationCredentials {
            token: "test_token".to_string(),
            instance_url: None,
            email: None,
            display_name: Some(format!("{}_user", provider)),
            connected_at: "2026-01-01T00:00:00Z".to_string(),
            source: CredentialSource::Manual,
        }
    }

    #[test]
    fn test_integration_file_roundtrip() {
        let dir = tempfile::tempdir().expect("tempdir");
        let creds = test_credentials("github");
        KeychainStore::write_integration_to_file("github", &creds, dir.path()).expect("write");
        let result = KeychainStore::read_integration_from_file("github", dir.path()).expect("read");
        let retrieved = result.expect("creds present");
        assert_eq!(retrieved.token, "test_token");
        assert_eq!(retrieved.display_name.as_deref(), Some("github_user"));
    }

    #[test]
    fn test_integration_file_roundtrip_linear() {
        let dir = tempfile::tempdir().expect("tempdir");
        let creds = test_credentials("linear");
        KeychainStore::write_integration_to_file("linear", &creds, dir.path()).expect("write");
        let result = KeychainStore::read_integration_from_file("linear", dir.path()).expect("read");
        let retrieved = result.expect("creds present");
        assert_eq!(retrieved.token, "test_token");
        assert_eq!(retrieved.display_name.as_deref(), Some("linear_user"));
    }

    #[test]
    fn test_integration_file_roundtrip_missing_returns_none() {
        let dir = tempfile::tempdir().expect("tempdir");
        let result = KeychainStore::read_integration_from_file("github", dir.path()).expect("no error on absent");
        assert!(result.is_none());
    }

    #[test]
    fn test_integration_file_roundtrip_corrupted_returns_none() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::create_dir_all(dir.path().join("tokens")).unwrap();
        std::fs::write(dir.path().join("tokens/github.enc"), b"corrupted_data_not_encrypted").unwrap();
        let result = KeychainStore::read_integration_from_file("github", dir.path()).expect("no error on corrupted");
        assert!(result.is_none());
    }

    #[test]
    fn test_integration_key_format() {
        assert_eq!(integration_key("github"), "maestro:integration:github");
        assert_eq!(integration_key("linear"), "maestro:integration:linear");
        assert_eq!(integration_key("jira_cloud"), "maestro:integration:jira_cloud");
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
