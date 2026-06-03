use rusqlite::{Connection, params};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::sync::atomic::AtomicBool;
use std::collections::HashMap;
use zeroize::Zeroizing;
use tauri::AppHandle;
use crate::project::lock as project_lock;

use crate::acp::{AcpProcess, ConnectionServer, AgentCacheMap, PooledSession, RestorableSession, ConnectionKey};
use crate::acp::registry::AgentDiscoveryCacheEntry;
use crate::core::schema::{initialize_schema};
use crate::execution::PtySession;
use crate::connectivity::ssh::{RemoteSshSession, SshPtyHandle};
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

    // WAL mode allows concurrent readers from multiple instances without SQLITE_BUSY.
    // busy_timeout retries writes for 5s instead of failing immediately.
    // execute_batch is used here because PRAGMA journal_mode returns a result row
    // which causes execute() to fail with "query returned rows".
    conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;")
        .map_err(|e| format!("Failed to configure database pragmas: {}", e))?;

    // Initialize schema
    initialize_schema(&conn)
        .map_err(|e| format!("Failed to initialize schema: {}", e))?;

    Ok(conn)
}

pub struct SshState {
    pub sessions: Arc<tokio::sync::Mutex<HashMap<i32, RemoteSshSession>>>,
    pub passwords: Arc<tokio::sync::Mutex<HashMap<i32, Zeroizing<String>>>>,
    pub pty_sessions: tokio::sync::Mutex<HashMap<i32, SshPtyHandle>>,
}

impl SshState {
    pub async fn get_session(&self, connection_id: i32) -> Option<RemoteSshSession> {
        self.sessions.lock().await.get(&connection_id).cloned()
    }

    pub async fn set_session(&self, connection_id: i32, session: RemoteSshSession) {
        self.sessions.lock().await.insert(connection_id, session);
    }

    pub async fn remove_session(&self, connection_id: i32) {
        self.sessions.lock().await.remove(&connection_id);
    }

    pub async fn get_password(&self, connection_id: i32) -> Option<Zeroizing<String>> {
        self.passwords.lock().await.get(&connection_id).cloned()
    }

    pub async fn set_password(&self, connection_id: i32, password: String) {
        self.passwords.lock().await.insert(connection_id, Zeroizing::new(password));
    }
}

pub struct AcpState {
    /// Live ACP sessions keyed by session key (monotonic counter).
    /// No inner Arc/Mutex needed — only IPC commands write to stdin (under outer lock)
    /// and the reader task owns stdout independently.
    pub sessions: tokio::sync::Mutex<HashMap<i32, AcpProcess>>,
    /// Per-connection agent discovery cache (5-minute TTL).
    pub discovery_cache: tokio::sync::Mutex<HashMap<ConnectionKey, AgentDiscoveryCacheEntry>>,
    /// One long-lived maestro-server process per connection.
    /// All sessions for a connection share this process instead of spawning their own.
    pub connection_servers: tokio::sync::Mutex<HashMap<ConnectionKey, ConnectionServer>>,
    /// Agent-level models/modes/capabilities cache. Populated from PreInitialize warm
    /// session and updated on every SpawnOk/SessionLoadOk. Keyed by (project_id, agent_id).
    pub agent_cache: tokio::sync::Mutex<AgentCacheMap>,
    /// Pre-warmed session pool. Keyed by (project_id, agent_id).
    /// A pooled session is a fully-spawned AcpProcess hidden from the active sessions list
    /// until a user creates a session for the same agent — at which point it is claimed
    /// instantly and the pool is replenished in the background.
    pub session_pool: tokio::sync::Mutex<HashMap<(i32, String), PooledSession>>,
    /// Per-connection deploy serialization locks. Prevents concurrent ensure_remote_server
    /// calls (from prefetch_agent_discovery and preflight_connection racing) for the same
    /// connection from running SFTP uploads simultaneously.
    pub deploy_locks: tokio::sync::Mutex<HashMap<i32, Arc<tokio::sync::Mutex<()>>>>,
    /// Sessions captured at connection server death, awaiting restore after SSH reconnects.
    /// Keyed by connection_id. Consumed by restore_acp_sessions on successful reconnect,
    /// or finalized as ended on permanent failure.
    pub restorable_sessions: tokio::sync::Mutex<HashMap<i32, Vec<RestorableSession>>>,
}

pub struct PtyState {
    pub sessions: tokio::sync::Mutex<HashMap<i32, Arc<tokio::sync::Mutex<PtySession>>>>,
    /// Per-session cancel flag for local PTY attach reader tasks.
    /// When detach_terminal is called, the flag is set to true, causing
    /// the spawn_blocking reader to exit cleanly before a new attach starts.
    pub attach_cancel: tokio::sync::Mutex<HashMap<i32, Arc<AtomicBool>>>,
    /// In-memory metadata for active PTY sessions, keyed by session key.
    pub session_meta: tokio::sync::Mutex<HashMap<i32, crate::models::worktree::PtySessionMeta>>,
    /// Monotonic counter for assigning session keys.
    pub session_counter: std::sync::atomic::AtomicI32,
}

pub struct AppState {
    pub db: Mutex<Connection>,
    pub app_handle: AppHandle,
    pub ssh: SshState,
    pub acp: AcpState,
    pub pty: PtyState,
    /// App data directory used for project lock files.
    pub app_data_dir: PathBuf,
    /// Active project lock: the project ID and the open File whose flock holds the lock.
    /// Dropping the File releases the lock (including on crash/kill-9).
    pub active_project_lock: Mutex<Option<(i32, std::fs::File)>>,
    /// Mutex-guarded token storage for ticketing provider tokens.
    /// Per-project locks prevent concurrent refresh races (AUTH-06).
    pub token_manager: crate::integration::TokenManager,
}

impl AppState {
    pub fn new(db: Connection, app_handle: AppHandle, app_data_dir: PathBuf) -> Self {
        AppState {
            db: Mutex::new(db),
            app_handle,
            ssh: SshState {
                sessions: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
                passwords: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
                pty_sessions: tokio::sync::Mutex::new(HashMap::new()),
            },
            acp: AcpState {
                sessions: tokio::sync::Mutex::new(HashMap::new()),
                discovery_cache: tokio::sync::Mutex::new(HashMap::new()),
                connection_servers: tokio::sync::Mutex::new(HashMap::new()),
                agent_cache: tokio::sync::Mutex::new(HashMap::new()),
                session_pool: tokio::sync::Mutex::new(HashMap::new()),
                deploy_locks: tokio::sync::Mutex::new(HashMap::new()),
                restorable_sessions: tokio::sync::Mutex::new(HashMap::new()),
            },
            pty: PtyState {
                sessions: tokio::sync::Mutex::new(HashMap::new()),
                attach_cancel: tokio::sync::Mutex::new(HashMap::new()),
                session_meta: tokio::sync::Mutex::new(HashMap::new()),
                session_counter: std::sync::atomic::AtomicI32::new(1),
            },
            app_data_dir,
            active_project_lock: Mutex::new(None),
            token_manager: crate::integration::TokenManager::new(),
        }
    }

    /// Acquire a project lock for this instance, releasing any previous lock first.
    /// Returns an error string if the project is locked by another live instance.
    pub fn acquire_project_lock(&self, project_id: i32) -> Result<(), String> {
        let mut current = self
            .active_project_lock
            .lock()
            .map_err(|e| format!("Lock state error: {}", e))?;

        // Already holding this project's lock — nothing to do
        if let Some((current_id, _)) = current.as_ref() {
            if *current_id == project_id {
                return Ok(());
            }
        }

        // Release previous lock by dropping the File handle
        *current = None;

        let file = project_lock::acquire_project_lock(&self.app_data_dir, project_id)?;
        *current = Some((project_id, file));
        Ok(())
    }

    /// Release the active project lock held by this instance.
    pub fn release_active_project_lock(&self) {
        if let Ok(mut current) = self.active_project_lock.lock() {
            *current = None;
        }
    }
}

/// Get a GitConnection for a project (local, SSH, or WSL).
pub async fn get_git_connection(
    project: &Project,
    app_state: &AppState,
) -> Result<GitConnection, String> {
    if project.is_remote() {
        let conn_id = project.connection_id
            .ok_or("Remote project has no connection_id")?;
        let ssh_session = app_state.ssh.get_session(conn_id).await
            .ok_or("SSH session not initialized for remote project")?;

        Ok(GitConnection::Remote {
            ssh: Arc::new(ssh_session),
            remote_path: project.path.clone(),
        })
    } else if project.is_wsl() {
        let wsl_id = project.wsl_connection_id
            .ok_or("WSL project has no wsl_connection_id")?;
        let distro = {
            let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
            conn.query_row(
                "SELECT distro_name FROM wsl_connections WHERE id = ?",
                [wsl_id],
                |row| row.get::<_, String>(0),
            ).map_err(|e| format!("WSL connection {} not found: {}", wsl_id, e))?
        };
        Ok(GitConnection::Wsl {
            distro,
            path: project.path.clone(),
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
            "SELECT id, name, path, created_at, updated_at, last_opened, connection_id, wsl_connection_id FROM projects WHERE id = ?",
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
