use rusqlite::Connection;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::collections::HashMap;

use crate::db::schema::initialize_schema;
use crate::error::AppError;
use crate::process::PtySession;

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

/// Application state containing the database connection and PTY sessions
pub struct AppState {
    pub db: Mutex<Connection>,
    pub pty_sessions: tokio::sync::Mutex<HashMap<i32, Arc<tokio::sync::Mutex<PtySession>>>>,
}

impl AppState {
    /// Create a new AppState with a database connection
    pub fn new(db: Connection) -> Self {
        AppState {
            db: Mutex::new(db),
            pty_sessions: tokio::sync::Mutex::new(HashMap::new()),
        }
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
