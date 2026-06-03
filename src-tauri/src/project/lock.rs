use fs2::FileExt;
use std::fs::{self, File, OpenOptions};
use std::path::{Path, PathBuf};

fn lock_file_path(app_data_dir: &Path, project_id: i32) -> PathBuf {
    app_data_dir.join("locks").join(format!("{}.lock", project_id))
}

/// Acquire an exclusive advisory lock on the project lock file.
/// Returns the open File handle — the lock is held as long as this handle is alive.
/// Dropping the File releases the lock automatically (on crash, kill -9, or clean exit).
/// Returns Err with "PROJECT_LOCKED:<id>" if another process holds the lock.
pub fn acquire_project_lock(app_data_dir: &Path, project_id: i32) -> Result<File, String> {
    let lock_path = lock_file_path(app_data_dir, project_id);

    if let Some(parent) = lock_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create locks dir: {}", e))?;
    }

    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(&lock_path)
        .map_err(|e| format!("Failed to open lock file: {}", e))?;

    file.try_lock_exclusive()
        .map_err(|_| format!("PROJECT_LOCKED:{}", project_id))?;

    Ok(file)
}

/// Check if a project is currently locked by another process (non-blocking probe).
/// Returns true if locked, false if available (including non-existent lock file).
pub fn is_project_locked(app_data_dir: &Path, project_id: i32) -> bool {
    let lock_path = lock_file_path(app_data_dir, project_id);

    if !lock_path.exists() {
        return false;
    }

    let file = match OpenOptions::new().write(true).open(&lock_path) {
        Ok(f) => f,
        Err(_) => return false,
    };

    match file.try_lock_exclusive() {
        Ok(()) => {
            // Got the lock — no one else holds it; release immediately
            let _ = file.unlock();
            false
        }
        Err(_) => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::{Arc, Barrier};
    use std::thread;

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    fn tmp_dir() -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = PathBuf::from(format!("/tmp/maestro-lock-test-{}-{}", std::process::id(), n));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn acquire_returns_file_handle() {
        let dir = tmp_dir();
        let file = acquire_project_lock(&dir, 1).unwrap();
        let lock_path = dir.join("locks/1.lock");
        assert!(lock_path.exists());
        drop(file);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn is_locked_false_when_no_lock_file() {
        let dir = tmp_dir();
        assert!(!is_project_locked(&dir, 99));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn is_locked_false_after_handle_dropped() {
        let dir = tmp_dir();
        let file = acquire_project_lock(&dir, 2).unwrap();
        drop(file);
        // Lock released — probe should report unlocked
        assert!(!is_project_locked(&dir, 2));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn is_locked_true_while_held_by_another_thread() {
        let dir = tmp_dir();
        let dir_arc = Arc::new(dir.clone());

        // Barrier to synchronize: thread holds lock, main checks, then thread releases
        let barrier_acquired = Arc::new(Barrier::new(2));
        let barrier_release = Arc::new(Barrier::new(2));

        let dir_clone = Arc::clone(&dir_arc);
        let ba = Arc::clone(&barrier_acquired);
        let br = Arc::clone(&barrier_release);

        let handle = thread::spawn(move || {
            let _file = acquire_project_lock(&dir_clone, 3).unwrap();
            ba.wait(); // signal: lock is held
            br.wait(); // wait: main has checked
        });

        barrier_acquired.wait(); // wait for thread to hold the lock
        assert!(is_project_locked(&dir, 3));
        barrier_release.wait(); // let thread release

        handle.join().unwrap();

        // After thread exits and drops the handle, lock is released
        assert!(!is_project_locked(&dir, 3));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn second_acquire_fails_while_held() {
        let dir = tmp_dir();
        let ba = Arc::new(Barrier::new(2));
        let br = Arc::new(Barrier::new(2));
        let dir_arc = Arc::new(dir.clone());

        let ba2 = Arc::clone(&ba);
        let br2 = Arc::clone(&br);
        let dir2 = Arc::clone(&dir_arc);

        let t = thread::spawn(move || {
            let _file = acquire_project_lock(&dir2, 4).unwrap();
            ba2.wait();
            br2.wait();
        });

        ba.wait();
        let result = acquire_project_lock(&dir, 4);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("PROJECT_LOCKED"));
        br.wait();

        t.join().unwrap();
        let _ = fs::remove_dir_all(&dir);
    }
}
