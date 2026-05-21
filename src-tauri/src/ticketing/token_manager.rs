use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

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
    // Outer Mutex needed: AppState is Arc<AppState> (no &mut self), so HashMap insertion
    // requires interior mutability.
    tokens: Mutex<HashMap<i32, Arc<Mutex<Option<StoredToken>>>>>,
    keyring_warned: AtomicBool,
}

fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

impl TokenManager {
    pub fn new() -> Self {
        TokenManager {
            tokens: Mutex::new(HashMap::new()),
            keyring_warned: AtomicBool::new(false),
        }
    }

    fn get_or_create_lock(&self, project_id: i32) -> Arc<Mutex<Option<StoredToken>>> {
        let mut map = self.tokens.lock().expect("token map lock poisoned");
        map.entry(project_id)
            .or_insert_with(|| Arc::new(Mutex::new(None)))
            .clone()
    }

    fn emit_keyring_warning_once(&self, app_handle: &AppHandle) {
        if !self.keyring_warned.load(Ordering::Relaxed) {
            self.keyring_warned.store(true, Ordering::Relaxed);
            app_handle.emit("ticketing:keyring-unavailable", ()).ok();
        }
    }

    pub fn get_token(
        &self,
        project_id: i32,
        app_data_dir: &std::path::Path,
        app_handle: &AppHandle,
    ) -> Result<Option<StoredToken>, String> {
        let project_lock = self.get_or_create_lock(project_id);
        let mut cached = project_lock.lock().expect("per-project token lock poisoned");

        if let Some(ref token) = *cached {
            if let Some(exp) = token.expires_at {
                if exp > 0 && exp - now_unix() >= 60 {
                    return Ok(Some(token.clone()));
                }
                // Expired, nearly expired, or zero/invalid expiry — evict
            } else {
                return Ok(Some(token.clone()));
            }
            // Fall through to keychain read after evicting the stale cache entry
            *cached = None;
        }

        match crate::ticketing::keychain::KeychainStore::get_token(project_id, app_data_dir) {
            Ok(crate::ticketing::keychain::KeychainOutcome::FileFallback(result)) => {
                self.emit_keyring_warning_once(app_handle);
                if let Some(token) = result {
                    *cached = Some(token.clone());
                    Ok(Some(token))
                } else {
                    Ok(None)
                }
            }
            Ok(crate::ticketing::keychain::KeychainOutcome::Keychain(result)) => {
                if let Some(token) = result {
                    *cached = Some(token.clone());
                    Ok(Some(token))
                } else {
                    Ok(None)
                }
            }
            Err(e) => Err(e),
        }
    }

    pub fn store_token(
        &self,
        project_id: i32,
        token: StoredToken,
        app_data_dir: &std::path::Path,
        app_handle: &AppHandle,
    ) -> Result<(), String> {
        let project_lock = self.get_or_create_lock(project_id);
        let mut cached = project_lock.lock().expect("per-project token lock poisoned");

        match crate::ticketing::keychain::KeychainStore::store_token(
            project_id,
            &token,
            app_data_dir,
        ) {
            Ok(crate::ticketing::keychain::KeychainOutcome::FileFallback(())) => {
                self.emit_keyring_warning_once(app_handle);
            }
            Ok(crate::ticketing::keychain::KeychainOutcome::Keychain(())) => {}
            Err(e) => return Err(e),
        }

        *cached = Some(token);
        Ok(())
    }

    pub fn delete_token(
        &self,
        project_id: i32,
        app_data_dir: &std::path::Path,
        app_handle: &AppHandle,
    ) -> Result<(), String> {
        let project_lock = self.get_or_create_lock(project_id);
        let mut cached = project_lock.lock().expect("per-project token lock poisoned");

        match crate::ticketing::keychain::KeychainStore::delete_token(project_id, app_data_dir) {
            Ok(crate::ticketing::keychain::KeychainOutcome::FileFallback(())) => {
                self.emit_keyring_warning_once(app_handle);
            }
            Ok(crate::ticketing::keychain::KeychainOutcome::Keychain(())) => {}
            Err(e) => return Err(e),
        }

        *cached = None;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
        let guard = project_lock.lock().unwrap();

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
        drop(guard);
        handle.join().unwrap();

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
