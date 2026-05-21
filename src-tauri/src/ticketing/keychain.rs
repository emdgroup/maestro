use std::path::{Path, PathBuf};

use aes_gcm::{
    Aes256Gcm, Key, Nonce,
    aead::{Aead, AeadCore, KeyInit, OsRng},
};
use keyring::Entry;
use sha2::{Digest, Sha256};

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

fn username(project_id: i32) -> String {
    format!("maestro:{}:ticketing", project_id)
}

pub struct KeychainStore;

impl KeychainStore {
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
        match entry.delete_credential() {
            Ok(()) => Ok(KeychainOutcome::Keychain(())),
            Err(keyring::Error::NoEntry) => Ok(KeychainOutcome::Keychain(())),
            Err(keyring::Error::NoStorageAccess(_)) | Err(keyring::Error::PlatformFailure(_)) => {
                Self::delete_file(project_id, app_data_dir)?;
                Ok(KeychainOutcome::FileFallback(()))
            }
            Err(e) => Err(format!("Failed to delete token: {}", e)),
        }
    }

    fn derive_key(machine_id: &str) -> [u8; 32] {
        let input = format!("{}maestro-token-fallback", machine_id);
        let hash = Sha256::digest(input.as_bytes());
        hash.into()
    }

    fn get_machine_id() -> String {
        machine_uid::get().unwrap_or_else(|_| "maestro-unknown-machine".to_string())
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
        let key_bytes = Self::derive_key(&Self::get_machine_id());
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
        let key_bytes = Self::derive_key(&Self::get_machine_id());
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
