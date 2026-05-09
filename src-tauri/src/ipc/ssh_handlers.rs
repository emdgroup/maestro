use std::sync::Arc;
use tauri::State;
use chrono::Utc;

use crate::models::{ConnectionStatus};
use crate::db::AppState;
use super::project_handlers::remove_projects_by_connection_id;
use crate::ssh::{RemoteSshSession, PasswordManager, spawn_heartbeat_task};
use crate::ssh::session::{SshAuthMethod, SshConnection};

/// Store SSH session in AppState, update DB timestamps, and kick off a background
/// remote-agent availability check so the result is ready before the user opens a dialog.
async fn finalize_ssh_connection(
    app_state: &Arc<AppState>,
    connection_id: i32,
    session: RemoteSshSession,
    auth_method_update: Option<&SshAuthMethod>,
) -> Result<(), String> {
    app_state.ssh.set_session(connection_id, session).await;

    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
    let now = Utc::now().to_rfc3339();

    match auth_method_update {
        Some(method) => {
            conn.execute(
                "UPDATE ssh_connections SET auth_method = ?, last_used_at = ?, updated_at = ? WHERE id = ?",
                rusqlite::params![method, &now, &now, connection_id],
            ).map_err(|e| e.to_string())?;
        }
        None => {
            conn.execute(
                "UPDATE ssh_connections SET last_used_at = ?, updated_at = ? WHERE id = ?",
                rusqlite::params![&now, &now, connection_id],
            ).map_err(|e| e.to_string())?;
        }
    }
    drop(conn);

    // Fire-and-forget: check maestro-server + agent availability in background.
    // Results are cached in AppState so the New Session dialog reads them instantly.
    let state_clone = Arc::clone(app_state);
    tokio::spawn(async move {
        super::acp_handlers::prefetch_agent_discovery(state_clone, Some(connection_id), None).await;
    });

    Ok(())
}

/// Get all saved SSH connections
#[tauri::command]
#[specta::specta]
pub fn get_ssh_connections(
    app_state: State<Arc<AppState>>,
) -> Result<Vec<SshConnection>, String> {
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;

    let mut stmt = conn
        .prepare("SELECT id, connection_string, username, host, port, auth_method, display_name, last_used_at, created_at FROM ssh_connections ORDER BY last_used_at DESC")
        .map_err(|e| e.to_string())?;

    let connections = stmt
        .query_map([], SshConnection::from_row)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(connections)
}

/// Get a specific SSH connection
#[tauri::command]
#[specta::specta]
pub fn get_ssh_connection(
    connection_id: i32,
    app_state: State<Arc<AppState>>,
) -> Result<SshConnection, String> {
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;

    let connection = conn.query_row(
        "SELECT id, connection_string, username, host, port, auth_method, display_name, last_used_at, created_at FROM ssh_connections WHERE id = ?",
        [&connection_id],
        SshConnection::from_row
    ).map_err(|e| e.to_string())?;

    Ok(connection)
}

/// Save a new SSH connection to the database
#[tauri::command]
#[specta::specta]
pub fn save_ssh_connection(
    app_state: State<Arc<AppState>>,
    connection_string: String,
    auth_method: SshAuthMethod,
) -> Result<i32, String> {
    // Parse connection string: user@host:port or user@host
    let parts: Vec<&str> = connection_string.split('@').collect();
    if parts.len() != 2 {
        return Err("Invalid format. Use: user@host:port or user@host".to_string());
    }

    let username = parts[0].to_string();
    let host_part = parts[1];

    // Parse host and port
    let (host, port) = if host_part.contains(':') {
        let host_port: Vec<&str> = host_part.split(':').collect();
        if host_port.len() != 2 {
            return Err("Invalid format. Use: user@host:port or user@host".to_string());
        }
        let port = host_port[1].parse::<u16>()
            .map_err(|_| "Invalid port number".to_string())?;
        (host_port[0].to_string(), port)
    } else {
        (host_part.to_string(), 22)
    };

    if host.is_empty() {
        return Err("Invalid host".to_string());
    }

    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;

    let now = Utc::now().to_rfc3339();

    // Check if connection already exists
    let existing: Option<i32> = conn
        .query_row(
            "SELECT id FROM ssh_connections WHERE connection_string = ?",
            [&connection_string],
            |row| row.get(0),
        )
        .ok();

    if let Some(id) = existing {
        // Update last_used_at
        conn.execute(
            "UPDATE ssh_connections SET last_used_at = ?, updated_at = ? WHERE id = ?",
            rusqlite::params![&now, &now, id],
        )
        .map_err(|e| e.to_string())?;
        return Ok(id);
    }

    // Insert new connection
    conn.execute(
        "INSERT INTO ssh_connections (connection_string, username, host, port, auth_method, last_used_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        rusqlite::params![&connection_string, &username, &host, port, &auth_method, &now, &now, &now],
    )
    .map_err(|e| e.to_string())?;

    let id = conn.last_insert_rowid() as i32;
    Ok(id)
}

/// Attempt to connect to SSH without requiring credentials (uses saved password, agent, or key file)
#[tauri::command]
#[specta::specta]
pub async fn connect_ssh_without_credentials(
    app_state: State<'_, Arc<AppState>>,
    connection_id: i32,
) -> Result<i32, String> {
    // Check if session already exists and is still alive
    if let Some(existing_session) = app_state.ssh.get_session(connection_id).await {
        if existing_session.is_connected().await {
            // Reuse live session — update last_used_at
            let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
            let now = Utc::now().to_rfc3339();
            conn.execute(
                "UPDATE ssh_connections SET last_used_at = ?, updated_at = ? WHERE id = ?",
                rusqlite::params![&now, &now, connection_id],
            )
            .map_err(|e| e.to_string())?;
            return Ok(connection_id);
        }
        // Session is dead — remove it and fall through to fresh auth
        app_state.ssh.remove_session(connection_id).await;
    }

    // No existing session, proceed with fresh authentication
    // Get connection details from database
    let connection = get_ssh_connection(connection_id, app_state.clone())
        .map_err(|e| format!("Connection not found: {}", e))?;

    // Create SSH session and attempt connection
    let session = RemoteSshSession::new(connection);
    session.connect(None).await.map_err(|e| format!("SSH connection failed: {}", e))?;

    finalize_ssh_connection(app_state.inner(), connection_id, session, None).await?;

    if let Some(s) = app_state.ssh.get_session(connection_id).await {
        spawn_heartbeat_task(
            s,
            app_state.app_handle.clone(),
            connection_id,
            Arc::clone(app_state.inner()),
        );
    }

    Ok(connection_id)
}

/// Connect to SSH using a password (fallback when credential-less connection fails)
#[tauri::command]
#[specta::specta]
pub async fn connect_ssh_with_password(
    app_state: State<'_, Arc<AppState>>,
    connection_id: i32,
    password: String,
    save_password: bool,
) -> Result<i32, String> {
    // Get connection details from database
    let mut connection = get_ssh_connection(connection_id, app_state.clone())
        .map_err(|e| format!("Connection not found: {}", e))?;

    // Create SSH config based on password persistence preference
    if save_password {
        // Save password to keyring
        PasswordManager::store_password(&connection.host, &connection.username, password.clone())
            .map_err(|e| format!("Failed to save password: {}", e))?;
    } else {
        app_state.ssh.set_password(connection_id, password.clone()).await;
    };

    connection.auth_method = SshAuthMethod::Password { save_password };

    // Create SSH session and attempt connection
    let session = RemoteSshSession::new(connection.clone());
    session.connect(Some(password)).await.map_err(|e| format!("SSH connection failed: {}", e))?;

    finalize_ssh_connection(app_state.inner(), connection_id, session, Some(&connection.auth_method)).await?;

    if let Some(s) = app_state.ssh.get_session(connection_id).await {
        spawn_heartbeat_task(
            s,
            app_state.app_handle.clone(),
            connection_id,
            Arc::clone(app_state.inner()),
        );
    }

    Ok(connection_id)
}

/// Connect to SSH using the SSH agent
#[tauri::command]
#[specta::specta]
pub async fn connect_ssh_with_agent(
    app_state: State<'_, Arc<AppState>>,
    connection_id: i32,
) -> Result<i32, String> {
    let mut connection = get_ssh_connection(connection_id, app_state.clone())
        .map_err(|e| format!("Connection not found: {}", e))?;

    connection.auth_method = SshAuthMethod::Agent;

    let session = RemoteSshSession::new(connection.clone());
    session.connect(None).await
        .map_err(|e| format!("SSH agent authentication failed: {}", e))?;

    finalize_ssh_connection(app_state.inner(), connection_id, session, Some(&connection.auth_method)).await?;

    if let Some(s) = app_state.ssh.get_session(connection_id).await {
        spawn_heartbeat_task(
            s,
            app_state.app_handle.clone(),
            connection_id,
            Arc::clone(app_state.inner()),
        );
    }

    Ok(connection_id)
}

/// Connect to SSH using a key file (with optional passphrase)
#[tauri::command]
#[specta::specta]
pub async fn connect_ssh_with_key(
    app_state: State<'_, Arc<AppState>>,
    connection_id: i32,
    key_path: String,
    passphrase: Option<String>,
    save_passphrase: bool,
) -> Result<i32, String> {
    let mut connection = get_ssh_connection(connection_id, app_state.clone())
        .map_err(|e| format!("Connection not found: {}", e))?;

    connection.auth_method = SshAuthMethod::KeyFile { path: key_path.clone(), save_passphrase };

    // If no passphrase was provided, try loading it from the OS keyring
    let passphrase = if passphrase.is_none() {
        PasswordManager::get_passphrase(&key_path).ok().map(|p| p.to_string())
    } else {
        passphrase
    };

    let session = RemoteSshSession::new(connection.clone());
    session.connect_with_key(Some(key_path.clone()), passphrase.clone()).await
        .map_err(|e| e.to_string())?;

    // Persist passphrase to OS keyring after successful auth
    if save_passphrase {
        if let Some(ref p) = passphrase {
            PasswordManager::store_passphrase(&key_path, p.clone())
                .map_err(|e| format!("Failed to save passphrase: {}", e))?;
        }
    }

    finalize_ssh_connection(app_state.inner(), connection_id, session, Some(&connection.auth_method)).await?;

    if let Some(s) = app_state.ssh.get_session(connection_id).await {
        spawn_heartbeat_task(
            s,
            app_state.app_handle.clone(),
            connection_id,
            Arc::clone(app_state.inner()),
        );
    }

    Ok(connection_id)
}

/// List directories on remote host
#[tauri::command]
#[specta::specta]
pub async fn list_remote_directories(
    app_state: State<'_, Arc<AppState>>,
    connection_id: i32,
    path: String,
) -> Result<Vec<String>, String> {
    // Get SSH session from AppState
    let session = app_state.ssh.get_session(connection_id)
        .await
        .ok_or("No active SSH session found. Please connect first.")?;

    // Execute ls command to list only subdirectories (including hidden ones)
    // Use ls -1aF to append / to directories and show hidden files, then filter for directories and remove the /
    // Exclude . and .. as they're handled specially in the UI
    let cmd = format!("cd '{}' && ls -1aF 2>/dev/null | grep '/$' | sed 's/\\/$//g' | grep -v '^\\.$' | grep -v '^\\.\\.$' | sort", path);
    let output = session.execute_command(&cmd)
        .await
        .map_err(|e| format!("Failed to list directories: {}", e))?;

    // Parse output into vector of directory names
    let directories: Vec<String> = output
        .lines()
        .filter(|line| !line.is_empty() && line != &"." && line != &"..")
        .map(|line| line.to_string())
        .collect();

    Ok(directories)
}

/// Delete an SSH connection from the database
#[tauri::command]
#[specta::specta]
pub fn delete_ssh_connection(
    app_state: State<Arc<AppState>>,
    connection_id: i32,
) -> Result<(), String> {

    // Get connection details before deleting (for keyring cleanup)
    let SshConnection {host, username, auth_method, ..} = get_ssh_connection(connection_id, app_state.clone())
        .map_err(|e| format!("Connection not found: {}", e))?;

    remove_projects_by_connection_id(app_state.clone(), connection_id)
        .map_err(|e| format!("Could not remove projects: {}", e))?;

    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;

    // Delete from database
    conn.execute(
        "DELETE FROM ssh_connections WHERE id = ?",
        [connection_id],
    )
    .map_err(|e| e.to_string())?;

    // Clean up keyring entries (ignore errors)
    let _ = PasswordManager::delete_password(&host, &username);
    if let SshAuthMethod::KeyFile { path, save_passphrase: true } = auth_method {
        let _ = PasswordManager::delete_passphrase(&path);
    }

    Ok(())
}

/// Remove saved password from OS Keyring
#[tauri::command]
#[specta::specta]
pub fn forget_saved_password(
    app_state: State<Arc<AppState>>,
    connection_id: i32,
) -> Result<(), String> {
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;

    // Get connection details before deleting (for keyring cleanup)
    let (host, username): (String, String) = conn
        .query_row(
            "SELECT host, username FROM ssh_connections WHERE id = ?",
            [connection_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|e| format!("Connection not found: {}", e))?;

    // Optionally delete password from keyring (ignore errors)
    let _ = PasswordManager::delete_password(&host, &username);

    Ok(())
}

/// Rename an SSH connection (set display name)
#[tauri::command]
#[specta::specta]
pub fn rename_ssh_connection(
    app_state: State<Arc<AppState>>,
    connection_id: i32,
    display_name: String,
) -> Result<(), String> {
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;

    let now = chrono::Utc::now().to_rfc3339();

    conn.execute(
        "UPDATE ssh_connections SET display_name = ?, updated_at = ? WHERE id = ?",
        rusqlite::params![&display_name, &now, connection_id],
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}


/// Get the current connection status for a connection
#[tauri::command]
#[specta::specta]
pub async fn get_ssh_connection_status(
    connection_id: i32,
    state: State<'_, Arc<AppState>>,
) -> Result<ConnectionStatus, String> {
    // Active session alive → connected
    if let Some(s) = state.ssh.get_session(connection_id).await {
        if s.is_connected().await {
            return Ok(ConnectionStatus { connection_id, connected: true, disconnected_reason: None });
        }
    }

    // No alive session — probe TCP port to check host reachability
    let connection = get_ssh_connection(connection_id, state.clone())
        .map_err(|e| format!("Connection not found: {}", e))?;

    let addr = format!("{}:{}", connection.host, connection.port);
    let reachable = tokio::time::timeout(
        std::time::Duration::from_secs(3),
        tokio::net::TcpStream::connect(&addr),
    )
    .await
    .map(|r| r.is_ok())
    .unwrap_or(false);

    Ok(ConnectionStatus {
        connection_id,
        connected: reachable,
        disconnected_reason: if !reachable { Some("Host unreachable".into()) } else { None },
    })
}
