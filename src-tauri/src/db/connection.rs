use rusqlite::{Connection, params};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::collections::HashMap;

use crate::db::schema::initialize_schema;
use crate::error::AppError;
use crate::process::PtySession;
use crate::ssh::RemoteSshSession;

/// Initialize the SQLite database
///
/// This function:
/// 1. Creates the directory structure if it doesn't exist
/// 2. Opens or creates the SQLite database
/// 3. Enables foreign keys
/// 4. Initializes the schema
///
/// The database is stored at:
/// - Linux: ~/.local/share/gsd-demo/gsd-demo.db
/// - macOS: ~/Library/Application Support/gsd-demo/gsd-demo.db
/// - Windows: %APPDATA%/gsd-demo/gsd-demo.db
pub fn init_db(db_path: PathBuf) -> Result<Connection, AppError> {
    // Create directory if it doesn't exist
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| AppError::IoError(format!("Failed to create app data directory: {}", e)))?;
    }

    // Open or create database
    let conn = Connection::open(&db_path)
        .map_err(|e| AppError::DatabaseError(format!("Failed to open database: {}", e)))?;

    // Enable foreign keys
    conn.execute("PRAGMA foreign_keys = ON;", [])
        .map_err(|e| AppError::DatabaseError(format!("Failed to enable foreign keys: {}", e)))?;

    // Initialize schema
    initialize_schema(&conn)
        .map_err(|e| AppError::DatabaseError(format!("Failed to initialize schema: {}", e)))?;

    Ok(conn)
}

/// Application state containing the database connection, PTY sessions, and SSH sessions
pub struct AppState {
    pub db: Mutex<Connection>,
    pub pty_sessions: tokio::sync::Mutex<HashMap<i32, Arc<tokio::sync::Mutex<PtySession>>>>,
    pub ssh_sessions: Arc<tokio::sync::Mutex<HashMap<i64, RemoteSshSession>>>,
}

impl AppState {
    /// Create a new AppState with a database connection
    pub fn new(db: Connection) -> Self {
        AppState {
            db: Mutex::new(db),
            pty_sessions: tokio::sync::Mutex::new(HashMap::new()),
            ssh_sessions: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
        }
    }

    /// Get an SSH session for a project if it exists
    pub async fn get_ssh_session(&self, project_id: i64) -> Option<RemoteSshSession> {
        self.ssh_sessions.lock().await.get(&project_id).cloned()
    }

    /// Store an SSH session for a project
    pub async fn set_ssh_session(&self, project_id: i64, session: RemoteSshSession) {
        self.ssh_sessions.lock().await.insert(project_id, session);
    }

    /// Remove an SSH session for a project
    pub async fn remove_ssh_session(&self, project_id: i64) {
        self.ssh_sessions.lock().await.remove(&project_id);
    }
}

/// Check if a host key is known for a project, store if new
pub fn check_and_store_host_key(
    conn: &Connection,
    project_id: i64,
    host_fingerprint: &str,
    fingerprint_type: &str,
) -> Result<bool, String> {
    // Query known_hosts for this project and fingerprint
    let existing: Result<String, _> = conn.query_row(
        "SELECT host_fingerprint FROM known_hosts WHERE project_id = ? AND host_fingerprint = ?",
        params![project_id, host_fingerprint],
        |row| row.get(0),
    );

    match existing {
        Ok(_) => {
            // Fingerprint is known, return true
            Ok(true)
        }
        Err(rusqlite::Error::QueryReturnedNoRows) => {
            // New fingerprint, store it
            let now = chrono::Utc::now().to_rfc3339();
            conn.execute(
                "INSERT INTO known_hosts (project_id, host_fingerprint, fingerprint_type, first_seen_at, created_at)
                 VALUES (?, ?, ?, ?, ?)",
                params![project_id, host_fingerprint, fingerprint_type, now, now],
            )
            .map_err(|e| format!("Failed to store host key: {}", e))?;
            Ok(true)
        }
        Err(e) => Err(format!("Database error checking host key: {}", e)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn test_init_db() {
        let test_db_path = PathBuf::from("/tmp/test-gsd-demo.db");

        // Clean up if exists
        let _ = fs::remove_file(&test_db_path);

        // Initialize database
        let result = init_db(test_db_path.clone());
        assert!(result.is_ok());

        // Verify file was created
        assert!(test_db_path.exists());

        // Verify schema version
        if let Ok(conn) = result {
            let version: u32 = conn
                .query_row("PRAGMA user_version", [], |row| row.get(0))
                .unwrap_or(0);
            assert_eq!(version, 1);

            // Verify foreign keys are enabled
            let fk_enabled: u32 = conn
                .query_row("PRAGMA foreign_keys", [], |row| row.get(0))
                .unwrap_or(0);
            assert_eq!(fk_enabled, 1);
        }

        // Clean up
        let _ = fs::remove_file(&test_db_path);
    }
}
