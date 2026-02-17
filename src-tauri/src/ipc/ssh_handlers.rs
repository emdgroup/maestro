use std::sync::Arc;
use tauri::State;
use chrono::Utc;

use crate::models::{SshConnection, SshConfig, SshAuthMethod};
use crate::db::AppState;
use crate::ssh::{RemoteSshSession, PasswordManager};

/// Get all saved SSH connections
#[tauri::command]
pub fn get_ssh_connections(
    app_state: State<Arc<AppState>>,
) -> Result<Vec<SshConnection>, String> {
    println!("get_ssh_connections() called via IPC");
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;

    let mut stmt = conn
        .prepare("SELECT id, connection_string, username, host, port, auth_method, display_name, last_used_at, created_at FROM ssh_connections ORDER BY last_used_at DESC")
        .map_err(|e| e.to_string())?;

    let connections = stmt
        .query_map([], |row| {
            Ok(SshConnection {
                id: row.get(0)?,
                connection_string: row.get(1)?,
                username: row.get(2)?,
                host: row.get(3)?,
                port: row.get(4)?,
                auth_method: row.get(5)?,
                display_name: row.get(6)?,
                last_used_at: row.get(7)?,
                created_at: row.get(8)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(connections)
}

/// Save a new SSH connection to the database
#[tauri::command]
pub fn save_ssh_connection(
    app_state: State<Arc<AppState>>,
    connection_string: String,
    username: String,
    host: String,
    port: u16,
    auth_method: String,
) -> Result<i64, String> {
    println!("save_ssh_connection({}) called via IPC", connection_string);
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;

    let now = Utc::now().to_rfc3339();

    // Check if connection already exists
    let existing: Option<i64> = conn
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

    let id = conn.last_insert_rowid();
    println!("Saved SSH connection with id: {}", id);
    Ok(id)
}

/// Attempt to connect to SSH without requiring credentials (uses saved password, agent, or key file)
#[tauri::command]
pub async fn connect_ssh_without_credentials(
    app_state: State<'_, Arc<AppState>>,
    connection_id: i64,
) -> Result<i64, String> {
    println!("connect_ssh_without_credentials(connection_id={}) called via IPC", connection_id);

    // Get connection details from database
    let (username, host, port, auth_method_str) = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        conn.query_row(
            "SELECT username, host, port, auth_method FROM ssh_connections WHERE id = ?",
            [connection_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, u16>(2)?,
                    row.get::<_, String>(3)?,
                ))
            },
        )
        .map_err(|e| format!("Connection not found: {}", e))?
    };

    // Parse auth method
    let auth_method: SshAuthMethod = serde_json::from_str(&auth_method_str)
        .map_err(|e| format!("Failed to parse auth method: {}", e))?;

    // Create SSH config
    let config = SshConfig {
        host: host.clone(),
        port,
        username: username.clone(),
        auth_method,
        remote_path: String::new(), // Not used for connection test
    };

    // Create SSH session and attempt connection
    let session = RemoteSshSession::new(config);
    session.connect().await.map_err(|e| format!("SSH connection failed: {}", e))?;

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
    connection_id: i64,
    password: String,
    save_password: bool,
) -> Result<i64, String> {
    println!("connect_ssh_with_password(connection_id={}, save={}) called via IPC", connection_id, save_password);

    // Get connection details from database
    let (username, host, port) = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        conn.query_row(
            "SELECT username, host, port FROM ssh_connections WHERE id = ?",
            [connection_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, u16>(2)?,
                ))
            },
        )
        .map_err(|e| format!("Connection not found: {}", e))?
    };

    // Create SSH config based on password persistence preference
    let auth_method = if save_password {
        // Save password to keyring
        PasswordManager::store_password(&host, &username, password.clone())
            .map_err(|e| format!("Failed to save password: {}", e))?;
        println!("Password saved to OS keyring for {}@{}", username, host);

        // Use Password auth method (retrieves from keyring on connect)
        SshAuthMethod::Password { save_password: true }
    } else {
        // Don't save to keyring, use in-memory password for this session only
        println!("Using in-memory password (not saved to keyring)");
        SshAuthMethod::PasswordInMemory { password: password.clone() }
    };

    let config = SshConfig {
        host: host.clone(),
        port,
        username: username.clone(),
        auth_method,
        remote_path: String::new(), // Not used for connection test
    };

    // Create SSH session and attempt connection
    let session = RemoteSshSession::new(config);
    session.connect().await.map_err(|e| format!("SSH connection failed: {}", e))?;

    // Store session in AppState
    app_state.set_ssh_session(connection_id, session).await;

    // Update database based on password persistence
    {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        let now = Utc::now().to_rfc3339();

        if save_password {
            // Password saved to keyring - update auth_method to Password in database
            let auth_method_json = serde_json::to_string(&SshAuthMethod::Password { save_password: true })
                .map_err(|e| format!("Failed to serialize auth method: {}", e))?;

            conn.execute(
                "UPDATE ssh_connections SET auth_method = ?, last_used_at = ?, updated_at = ? WHERE id = ?",
                rusqlite::params![&auth_method_json, &now, &now, connection_id],
            )
            .map_err(|e| e.to_string())?;

            println!("Updated database auth_method to Password (saved to keyring)");
        } else {
            // Password NOT saved - reset auth_method to Agent for next restart
            // This ensures password prompt will appear after restart
            let auth_method_json = serde_json::to_string(&SshAuthMethod::Agent)
                .map_err(|e| format!("Failed to serialize auth method: {}", e))?;

            conn.execute(
                "UPDATE ssh_connections SET auth_method = ?, last_used_at = ?, updated_at = ? WHERE id = ?",
                rusqlite::params![&auth_method_json, &now, &now, connection_id],
            )
            .map_err(|e| e.to_string())?;

            println!("Session established for this session only (auth_method reset to Agent)");
        }
    }

    println!("SSH connection established with password for connection_id: {}", connection_id);
    Ok(connection_id)
}

/// List directories on remote host
#[tauri::command]
pub async fn list_remote_directories(
    app_state: State<'_, Arc<AppState>>,
    connection_id: i64,
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
    connection_id: i64,
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

/// Rename an SSH connection (set display name)
#[tauri::command]
pub fn rename_ssh_connection(
    app_state: State<Arc<AppState>>,
    connection_id: i64,
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
