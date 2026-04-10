use rusqlite::{Connection, params};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::sync::atomic::AtomicBool;
use std::collections::HashMap;
use zeroize::Zeroizing;
use tauri::AppHandle;

use crate::db::schema::{initialize_schema};
use crate::process::PtySession;
use crate::ssh::{RemoteSshSession, SshPtyHandle};
use crate::models::{Project, GitConnection};

/// Initialize the SQLite database
///
/// This function:
/// 1. Creates the directory structure if it doesn't exist
/// 2. Opens or creates the SQLite database
/// 3. Enables foreign keys
/// 4. Initializes the schema
///
/// The database is stored at:
/// - Linux: ~/.local/share/maestro/maestro.db
/// - macOS: ~/Library/Application Support/maestro/maestro.db
/// - Windows: %APPDATA%/maestro/maestro.db
pub fn init_db(db_path: PathBuf) -> Result<Connection, String> {
    // Create directory if it doesn't exist
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create app data directory: {}", e))?;
    }

    // Open or create database
    let conn = Connection::open(&db_path)
        .map_err(|e| format!("Failed to open database: {}", e))?;

    // Enable foreign keys
    conn.execute("PRAGMA foreign_keys = ON;", [])
        .map_err(|e| format!("Failed to enable foreign keys: {}", e))?;

    // Initialize schema
    initialize_schema(&conn)
        .map_err(|e| format!("Failed to initialize schema: {}", e))?;

    Ok(conn)
}

/// Application state containing the database connection, PTY sessions, and SSH sessions
pub struct AppState {
    pub db: Mutex<Connection>,
    pub app_handle: AppHandle,
    pub pty_sessions: tokio::sync::Mutex<HashMap<i32, Arc<tokio::sync::Mutex<PtySession>>>>,
    /// Remote interactive PTY sessions keyed by execution log_id
    pub ssh_pty_sessions: tokio::sync::Mutex<HashMap<i32, SshPtyHandle>>,
    pub ssh_sessions: Arc<tokio::sync::Mutex<HashMap<i32, RemoteSshSession>>>,
    pub ssh_passwords: Arc<tokio::sync::Mutex<HashMap<i32, Zeroizing<String>>>>,
    /// Per-session cancel flag for local PTY attach reader tasks.
    /// When detach_terminal is called, the flag is set to true, causing
    /// the spawn_blocking reader to exit cleanly before a new attach starts.
    pub pty_attach_cancel: tokio::sync::Mutex<HashMap<i32, Arc<AtomicBool>>>,
}

impl AppState {
    /// Create a new AppState with a database connection and Tauri app handle
    pub fn new(db: Connection, app_handle: AppHandle) -> Self {
        AppState {
            db: Mutex::new(db),
            app_handle,
            pty_sessions: tokio::sync::Mutex::new(HashMap::new()),
            ssh_pty_sessions: tokio::sync::Mutex::new(HashMap::new()),
            ssh_sessions: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
            ssh_passwords: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
            pty_attach_cancel: tokio::sync::Mutex::new(HashMap::new()),
        }
    }

    /// Get an SSH session for a connection if it exists
    pub async fn get_ssh_session(&self, connection_id: i32) -> Option<RemoteSshSession> {
        self.ssh_sessions.lock().await.get(&connection_id).cloned()
    }

    /// Store an SSH session for a connection
    pub async fn set_ssh_session(&self, connection_id: i32, session: RemoteSshSession) {
        self.ssh_sessions.lock().await.insert(connection_id, session);
    }

    /// Remove an SSH session for a connection
    pub async fn remove_ssh_session(&self, connection_id: i32) {
        self.ssh_sessions.lock().await.remove(&connection_id);
    }

    /// Get an SSH session password for a connection if it exists
    pub async fn get_ssh_password(&self, connection_id: i32) -> Option<Zeroizing<String>> {
        self.ssh_passwords.lock().await.get(&connection_id).cloned()
    }

    /// Store an SSH session password for a connection
    pub async fn set_ssh_password(&self, connection_id: i32, password: String) {
        self.ssh_passwords.lock().await.insert(connection_id, Zeroizing::new(password));
    }
}

/// Get a GitConnection for a project (local or remote via SSH)
///
/// For local projects: returns GitConnection::Local with the project path
/// For remote projects: returns GitConnection::Remote with SSH session and remote path
pub async fn get_git_connection(
    project: &Project,
    app_state: &AppState,
) -> Result<GitConnection, String> {
    if project.is_remote() {
        let conn_id = project.connection_id
            .ok_or("Remote project has no connection_id")?;
        let ssh_session = app_state.get_ssh_session(conn_id).await
            .ok_or("SSH session not initialized for remote project")?;

        Ok(GitConnection::Remote {
            ssh: Arc::new(ssh_session),
            remote_path: project.path.clone(), // For remote projects, path is the remote path
        })
    } else {
        Ok(GitConnection::Local {
            path: project.path.clone(),
        })
    }
}

/// Fetch a project by ID and resolve its GitConnection (local or remote SSH).
///
/// This is the standard pattern used by worktree, execution, and task handlers
/// that need both the Project row and a GitConnection for git operations.
pub async fn get_project_with_git_conn(
    app_state: &AppState,
    project_id: i32,
) -> Result<(Project, GitConnection), String> {
    let project = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        conn.query_row(
            "SELECT id, name, path, created_at, updated_at, last_opened, connection_id FROM projects WHERE id = ?",
            [project_id],
            Project::from_row,
        ).map_err(|e| format!("Project {} not found: {}", project_id, e))?
    };
    let git_conn = get_git_connection(&project, app_state).await?;
    Ok((project, git_conn))
}

/// Check if a host key is known for a project, store if new
pub fn check_and_store_host_key(
    conn: &Connection,
    project_id: i32,
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
        let test_db_path = PathBuf::from("/tmp/test-maestro.db");

        // Clean up if exists
        let _ = fs::remove_file(&test_db_path);

        // Initialize database
        let result = init_db(test_db_path.clone());
        assert!(result.is_ok());

        // Verify file was created
        assert!(test_db_path.exists());

        if let Ok(conn) = result {
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
