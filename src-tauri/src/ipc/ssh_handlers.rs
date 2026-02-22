use std::sync::Arc;
use tauri::State;
use chrono::Utc;

use crate::models::{ConnectionStatus};
use crate::db::AppState;
use crate::ssh::{RemoteSshSession, PasswordManager};
use crate::ssh::session::{SshAuthMethod, SshConnection};

/// Get all saved SSH connections
#[tauri::command]
pub fn get_ssh_connections(
    app_state: State<Arc<AppState>>,
) -> Result<Vec<SshConnection>, String> {
    println!("get_ssh_connections() called via IPC");
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;

    let mut stmt = conn
        .prepare("SELECT * FROM ssh_connections ORDER BY last_used_at DESC")
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
pub fn get_ssh_connection(
    connection_id: i32,
    app_state: State<Arc<AppState>>,
) -> Result<SshConnection, String> {
    println!("get_ssh_connection({}) called via IPC", connection_id);
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;

    let connection = conn.query_row(
        "SELECT * FROM ssh_connections WHERE id = ?",
        [&connection_id],
        SshConnection::from_row
    ).map_err(|e| e.to_string())?;

    Ok(connection)
}

/// Save a new SSH connection to the database
#[tauri::command]
pub fn save_ssh_connection(
    app_state: State<Arc<AppState>>,
    connection_string: String,
    auth_method: SshAuthMethod,
) -> Result<i32, String> {
    println!("save_ssh_connection({}) called via IPC", connection_string);

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

    println!("Host {}, user {}, prot {}", host, username, port);

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

    println!("debug 1");
    // Insert new connection
    conn.execute(
        "INSERT INTO ssh_connections (connection_string, username, host, port, auth_method, last_used_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        rusqlite::params![&connection_string, &username, &host, port, &auth_method, &now, &now, &now],
    )
    .map_err(|e| e.to_string())?;

    let id = conn.last_insert_rowid() as i32;
    println!("Saved SSH connection with id: {}", id);
    Ok(id)
}

/// Attempt to connect to SSH without requiring credentials (uses saved password, agent, or key file)
#[tauri::command]
pub async fn connect_ssh_without_credentials(
    app_state: State<'_, Arc<AppState>>,
    connection_id: i32,
) -> Result<i32, String> {
    println!("connect_ssh_without_credentials(connection_id={}) called via IPC", connection_id);

    // Check if session already exists (e.g., from previous password authentication in same session)
    if let Some(_existing_session) = app_state.get_ssh_session(connection_id).await {
        println!("Reusing existing session for connection_id={} (already authenticated)", connection_id);

        // Update last_used_at since we're reusing the connection
        {
            let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
            let now = Utc::now().to_rfc3339();
            conn.execute(
                "UPDATE ssh_connections SET last_used_at = ?, updated_at = ? WHERE id = ?",
                rusqlite::params![&now, &now, connection_id],
            )
            .map_err(|e| e.to_string())?;
        }

        return Ok(connection_id);
    }

    // No existing session, proceed with fresh authentication
    println!("No existing session found, attempting fresh authentication");

    // Get connection details from database
    let connection = get_ssh_connection(connection_id, app_state.clone())
        .map_err(|e| format!("Connection not found: {}", e))?;

    // Create SSH session and attempt connection
    let session = RemoteSshSession::new(connection);
    session.connect(None).await.map_err(|e| format!("SSH connection failed: {}", e))?;

    // Store session in AppState
    app_state.set_ssh_session(connection_id, session).await;

    // Update last_used_at
    {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        let now = Utc::now().to_rfc3339();
        conn.execute(
            "UPDATE ssh_connections SET last_used_at = ?, updated_at = ? WHERE id = ?",
            rusqlite::params![&now, &now, connection_id],
        )
        .map_err(|e| e.to_string())?;
    }

    println!("SSH connection established for connection_id: {}", connection_id);
    Ok(connection_id)
}

/// Connect to SSH using a password (fallback when credential-less connection fails)
#[tauri::command]
pub async fn connect_ssh_with_password(
    app_state: State<'_, Arc<AppState>>,
    connection_id: i32,
    password: String,
    save_password: bool,
) -> Result<i32, String> {
    println!("connect_ssh_with_password(connection_id={}, save={}) called via IPC", connection_id, save_password);

    // Get connection details from database
    let mut connection = get_ssh_connection(connection_id, app_state.clone())
        .map_err(|e| format!("Connection not found: {}", e))?;

    // Create SSH config based on password persistence preference
    if save_password {
        // Save password to keyring
        PasswordManager::store_password(&connection.host, &connection.username, password.clone())
            .map_err(|e| format!("Failed to save password: {}", e))?;
        println!("Password saved to OS keyring for {}@{}", connection.username, connection.host);
    } else {
        app_state.set_ssh_password(connection_id, password.clone()).await;
    };

    connection.auth_method = SshAuthMethod::Password { save_password };

    // Create SSH session and attempt connection
    let session = RemoteSshSession::new(connection.clone());
    session.connect(Some(password)).await.map_err(|e| format!("SSH connection failed: {}", e))?;

    // Store session in AppState
    app_state.set_ssh_session(connection_id, session).await;

    // Update database based on password persistence
    {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        let now = Utc::now().to_rfc3339();

        conn.execute(
            "UPDATE ssh_connections SET auth_method = ?, last_used_at = ?, updated_at = ? WHERE id = ?",
            rusqlite::params![&connection.auth_method, &now, &now, connection_id],
        )
        .map_err(|e| e.to_string())?;

        println!("Updated database auth_method to Password");
    }

    println!("SSH connection established with password for connection_id: {}", connection_id);
    Ok(connection_id)
}

/// List directories on remote host
#[tauri::command]
pub async fn list_remote_directories(
    app_state: State<'_, Arc<AppState>>,
    connection_id: i32,
    path: String,
) -> Result<Vec<String>, String> {
    println!("list_remote_directories(connection_id={}, path={}) called via IPC", connection_id, path);

    // Get SSH session from AppState
    let session = app_state.get_ssh_session(connection_id)
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

    println!("Found {} subdirectories in {}", directories.len(), path);
    Ok(directories)
}

/// Delete an SSH connection from the database
#[tauri::command]
pub fn delete_ssh_connection(
    app_state: State<Arc<AppState>>,
    connection_id: i32,
) -> Result<(), String> {
    println!("delete_ssh_connection(connection_id={}) called via IPC", connection_id);
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;

    // Get connection details before deleting (for keyring cleanup)
    let (host, username): (String, String) = conn
        .query_row(
            "SELECT host, username FROM ssh_connections WHERE id = ?",
            [connection_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|e| format!("Connection not found: {}", e))?;

    // Delete from database
    conn.execute(
        "DELETE FROM ssh_connections WHERE id = ?",
        [connection_id],
    )
    .map_err(|e| e.to_string())?;

    // Optionally delete password from keyring (ignore errors)
    let _ = PasswordManager::delete_password(&host, &username);

    println!("Deleted SSH connection: {}", connection_id);
    Ok(())
}

/// Remove saved password from OS Keyring
#[tauri::command]
pub fn forget_saved_password(
    app_state: State<Arc<AppState>>,
    connection_id: i32,
) -> Result<(), String> {
    println!("delete_ssh_connection(connection_id={}) called via IPC", connection_id);
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

    println!("Deleted SSH connection: {}", connection_id);
    Ok(())
}

/// Rename an SSH connection (set display name)
#[tauri::command]
pub fn rename_ssh_connection(
    app_state: State<Arc<AppState>>,
    connection_id: i32,
    display_name: String,
) -> Result<(), String> {
    println!("rename_ssh_connection(connection_id={}, display_name={}) called via IPC", connection_id, display_name);
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;

    let now = chrono::Utc::now().to_rfc3339();

    conn.execute(
        "UPDATE ssh_connections SET display_name = ?, updated_at = ? WHERE id = ?",
        rusqlite::params![&display_name, &now, connection_id],
    )
    .map_err(|e| e.to_string())?;

    println!("Renamed SSH connection {} to '{}'", connection_id, display_name);
    Ok(())
}


/// Get the current connection status for a connection
#[tauri::command]
pub async fn get_ssh_connection_status(
    connection_id: i32,
    state: State<'_, Arc<AppState>>,
) -> Result<ConnectionStatus, String> {
    println!("get_ssh_connection_status({}) called", connection_id);

    // Get the SSH session for this project (lazy - may not be connected yet)
    let session = state.get_ssh_session(connection_id).await;

    let connected = if let Some(s) = session {
        s.is_connected().await
    } else {
        false
    };

    Ok(ConnectionStatus {
        connection_id,
        connected,
        disconnected_reason: if !connected {
            Some("Not connected".into())
        } else {
            None
        },
    })
}