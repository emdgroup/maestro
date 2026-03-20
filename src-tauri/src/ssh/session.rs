use ssh2::Session;
use std::io::Read;
use std::net::TcpStream;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;
use rusqlite::ToSql;
use rusqlite::Result as SqliteResult;
use rusqlite::types::{FromSql, FromSqlResult, ToSqlOutput, ValueRef};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use specta::Type;
use zeroize::Zeroizing;
use crate::ssh::error::SshError;
use crate::ssh::PasswordManager;

/// Saved SSH connection for quick reconnection
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct SshConnection {
    pub id: i32,
    pub connection_string: String,  // e.g., "user@host:22"
    pub username: String,
    pub host: String,
    pub port: u16,
    pub auth_method: SshAuthMethod,  // Serialized SshAuthMethod
    pub display_name: Option<String>,  // User-friendly name
    pub last_used_at: String,  // ISO 8601
    pub created_at: String,    // ISO 8601
}

/// SSH authentication method configuration
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
#[serde(rename_all = "PascalCase")]
pub enum SshAuthMethod {
    /// Authenticate using a private key file
    #[serde(rename = "KeyFile")]
    KeyFile { path: String },
    /// Authenticate using SSH agent
    #[serde(rename = "Agent")]
    Agent,
    /// Authenticate using password (stored in OS keyring)
    #[serde(rename = "Password")]
    Password { save_password: bool }
}

/// SSH connection state machine
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SshConnectionState {
    Initial,
    Connecting,
    Connected,
    Reconnecting,
    Disconnected,
}

/// Manages a persistent SSH connection for a remote project
pub struct RemoteSshSession {
    session: Arc<Mutex<Option<Session>>>,
    ssh_connection: SshConnection,
    state: Arc<Mutex<SshConnectionState>>,
    reconnect_attempts: Arc<AtomicUsize>,
    session_password: Arc<Mutex<Option<String>>>,
    key_passphrase: Arc<Mutex<Option<String>>>,
}

impl ToSql for SshAuthMethod {
    fn to_sql(&self) -> SqliteResult<ToSqlOutput<'_>> {
        let json = serde_json::to_string(self)
            .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
        Ok(ToSqlOutput::from(json))
    }
}

impl FromSql for SshAuthMethod {
    fn column_result(value: ValueRef<'_>) -> FromSqlResult<Self> {
        let json = value.as_str()?;

        // Provide better error messages when deserialization fails
        if json.is_empty() {
            return Err(rusqlite::types::FromSqlError::Other(
                "SshAuthMethod cannot be deserialized from empty string".into()
            ));
        }

        serde_json::from_str(json).map_err(|e| {
            rusqlite::types::FromSqlError::Other(
                format!("Failed to deserialize SshAuthMethod from JSON: '{}'. Error: {}", json, e).into()
            )
        })
    }
}

impl SshConnection {
    /// Parse an SshConnection from a rusqlite Row
    /// Expects columns in order
    pub fn from_row(row: &rusqlite::Row) -> rusqlite::Result<Self> {
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
    }
}

impl Clone for RemoteSshSession {
    fn clone(&self) -> Self {
        Self {
            session: self.session.clone(),
            ssh_connection: self.ssh_connection.clone(),
            state: self.state.clone(),
            reconnect_attempts: self.reconnect_attempts.clone(),
            session_password: self.session_password.clone(),
            key_passphrase: self.key_passphrase.clone(),
        }
    }
}

/// Expand a leading `~` to the user's home directory
fn expand_tilde(path: &str) -> String {
    if path == "~" || path.starts_with("~/") {
        if let Ok(home) = std::env::var("HOME") {
            return path.replacen('~', &home, 1);
        }
    }
    path.to_string()
}

impl RemoteSshSession {
    /// Create a new SSH session with the given configuration
    pub fn new(ssh_connection: SshConnection) -> Self {
        Self {
            session: Arc::new(Mutex::new(None)),
            ssh_connection,
            state: Arc::new(Mutex::new(SshConnectionState::Initial)),
            reconnect_attempts: Arc::new(AtomicUsize::new(0)),
            session_password: Arc::new(Mutex::new(None)),
            key_passphrase: Arc::new(Mutex::new(None)),
        }
    }

    /// Establish SSH connection with authentication
    pub async fn connect(&self, password: Option<String>) -> Result<(), SshError> {
        let mut state = self.state.lock().await;
        *state = SshConnectionState::Connecting;
        drop(state);

        // Parse host and port from config
        let host = &self.ssh_connection.host;
        let port = &self.ssh_connection.port;
        let username = &self.ssh_connection.username;

        // Create TCP connection with timeout
        let tcp_stream = TcpStream::connect(format!("{}:{}", host, port))
            .map_err(|e| {
                SshError::ConnectionError(format!(
                    "Failed to connect to {}:{}: {}",
                    host, port, e
                ))
            })?;

        // Set TCP connection timeout
        tcp_stream
            .set_read_timeout(Some(Duration::from_secs(10)))
            .map_err(|e| SshError::ConnectionError(format!("Failed to set timeout: {}", e)))?;

        tcp_stream
            .set_write_timeout(Some(Duration::from_secs(10)))
            .map_err(|e| SshError::ConnectionError(format!("Failed to set timeout: {}", e)))?;

        // Create SSH session
        let mut session = Session::new()
            .map_err(|e| SshError::ConnectionError(format!("Failed to create session: {}", e)))?;

        session.set_tcp_stream(tcp_stream);

        // Perform SSH handshake
        session.handshake().map_err(|e| {
            SshError::ConnectionError(format!("SSH handshake failed: {}", e))
        })?;

        // Authenticate based on configured method
        match &self.ssh_connection.auth_method {
            SshAuthMethod::KeyFile { path } => {
                let expanded = expand_tilde(path);
                let stored_passphrase = self.key_passphrase.lock().await.clone();
                println!("Key auth (reconnect): username={}, key_path='{}'", username, expanded);
                if !Path::new(&expanded).exists() {
                    return Err(SshError::AuthenticationError(format!(
                        "Key file not found on reconnect: '{}'", expanded
                    )));
                }
                let normalized = expanded.replace('\\', "/");
                session
                    .userauth_pubkey_file(username, None, Path::new(&normalized), stored_passphrase.as_deref())
                    .map_err(|e| {
                        SshError::AuthenticationError(format!(
                            "Public key authentication failed for '{}' on reconnect: {}",
                            expanded, e
                        ))
                    })?;
            }
            SshAuthMethod::Agent => {
                session.userauth_agent(username).map_err(|e| {
                    SshError::AuthenticationError(format!("SSH agent authentication failed: {}", e))
                })?;
            }
            SshAuthMethod::Password { save_password } => {
                // Retrieve password from OS keyring
                let pwd = if save_password.clone() {
                    PasswordManager::get_password(host, username).map_err(|e| {
                        SshError::AuthenticationError(format!("Failed to retrieve password: {}", e))
                    })?
                } else {
                    let connection_string = format!("{username}@{host}");
                    let mem_password = password.as_ref().cloned().ok_or_else(|| {
                        SshError::AuthenticationError(format!(
                            "No password found for {connection_string}"
                        ))
                    })?;
                    *self.session_password.lock().await = Some(mem_password.clone());
                    Zeroizing::new(mem_password)
                };

                session
                .userauth_password(username, &pwd)
                .map_err(|e| {
                    SshError::AuthenticationError(format!(
                        "Password authentication failed: {}",
                        e
                    ))
                })?;
            }
        }

        // Verify authentication succeeded
        if !session.authenticated() {
            return Err(SshError::AuthenticationError(
                "Authentication failed: SSH server did not grant access".to_string(),
            ));
        }

        // Store session and update state
        *self.session.lock().await = Some(session);
        *self.state.lock().await = SshConnectionState::Connected;
        self.reconnect_attempts.store(0, Ordering::SeqCst);

        Ok(())
    }

    /// Establish SSH connection using an explicit key file path and optional passphrase
    pub async fn connect_with_key(&self, key_path: Option<String>, passphrase: Option<String>) -> Result<(), SshError> {
        let mut state = self.state.lock().await;
        *state = SshConnectionState::Connecting;
        drop(state);

        let host = &self.ssh_connection.host;
        let port = &self.ssh_connection.port;
        let username = &self.ssh_connection.username;

        let tcp_stream = TcpStream::connect(format!("{}:{}", host, port))
            .map_err(|e| SshError::ConnectionError(format!("Failed to connect to {}:{}: {}", host, port, e)))?;

        tcp_stream.set_read_timeout(Some(Duration::from_secs(10)))
            .map_err(|e| SshError::ConnectionError(format!("Failed to set timeout: {}", e)))?;
        tcp_stream.set_write_timeout(Some(Duration::from_secs(10)))
            .map_err(|e| SshError::ConnectionError(format!("Failed to set timeout: {}", e)))?;

        let mut session = Session::new()
            .map_err(|e| SshError::ConnectionError(format!("Failed to create session: {}", e)))?;
        session.set_tcp_stream(tcp_stream);
        session.handshake()
            .map_err(|e| SshError::ConnectionError(format!("SSH handshake failed: {}", e)))?;

        let fallback_path;
        let path: &str = if let Some(ref p) = key_path {
            p.as_str()
        } else if let SshAuthMethod::KeyFile { path } = &self.ssh_connection.auth_method {
            fallback_path = path.clone();
            fallback_path.as_str()
        } else {
            return Err(SshError::AuthenticationError("No key path provided".to_string()));
        };

        let expanded = expand_tilde(path);

        println!("Key auth: username={}, key_path='{}' (original: '{}')", username, expanded, path);

        if !Path::new(&expanded).exists() {
            return Err(SshError::AuthenticationError(format!(
                "Key file not found: '{}'. Check the path and try again.",
                expanded
            )));
        }

        // Read the file to detect format before handing to libssh2
        let key_data = std::fs::read_to_string(&expanded)
            .map_err(|e| SshError::AuthenticationError(format!(
                "Cannot read key file '{}': {}", expanded, e
            )))?;

        // Reject public key files immediately
        if key_data.starts_with("ssh-") || key_data.starts_with("ecdsa-")
            || key_data.contains("BEGIN PUBLIC KEY")
        {
            return Err(SshError::AuthenticationError(
                "This is a public key file (.pub). Please select the matching private key file (no .pub extension).".to_string()
            ));
        }

        // libssh2 compiled without OpenSSL cannot parse OpenSSH-format keys
        // (the format used by default for ed25519, and optionally for RSA/ECDSA).
        // Legacy PEM keys (BEGIN RSA PRIVATE KEY / BEGIN EC PRIVATE KEY) work fine.
        if key_data.contains("BEGIN OPENSSH PRIVATE KEY") {
            return Err(SshError::AuthenticationError(
                "OpenSSH-format keys (ed25519, or RSA/ECDSA generated with newer ssh-keygen) \
                are not supported by the bundled SSH library.\n\n\
                Options:\n\
                1. Use SSH Agent auth — add your key with: ssh-add ~/.ssh/id_ed25519\n\
                2. Generate a legacy RSA key: ssh-keygen -t rsa -b 4096 -m PEM -f ~/.ssh/id_rsa_maestro\n\
                3. Convert an existing RSA/ECDSA key to PEM: ssh-keygen -p -m PEM -f ~/.ssh/id_rsa"
                    .to_string()
            ));
        }

        println!("Key format: PEM, size: {} bytes", key_data.len());

        // Store the passphrase so it can be reused on reconnection
        *self.key_passphrase.lock().await = passphrase.clone();

        // Query which auth methods the server actually supports (best-effort)
        let server_methods = session.auth_methods(username)
            .unwrap_or("(could not query server auth methods)");
        println!("Server supported auth methods: {}", server_methods);

        // Normalize Windows backslashes → forward slashes for libssh2's fopen()
        let normalized = expanded.replace('\\', "/");
        session.userauth_pubkey_file(username, None, Path::new(&normalized), passphrase.as_deref())
            .map_err(|e| SshError::AuthenticationError(format!(
                "Public key authentication failed for '{}': {}. Server accepts: {}",
                expanded, e, server_methods
            )))?;

        if !session.authenticated() {
            return Err(SshError::AuthenticationError(format!(
                "Server did not grant access for '{}'. Server accepts: {}",
                expanded, server_methods
            )));
        }

        *self.session.lock().await = Some(session);
        *self.state.lock().await = SshConnectionState::Connected;
        self.reconnect_attempts.store(0, Ordering::SeqCst);

        Ok(())
    }

    /// Disconnect from the SSH server
    pub async fn disconnect(&self) {
        *self.session.lock().await = None;
        *self.state.lock().await = SshConnectionState::Disconnected;
    }

    /// Check if currently connected
    pub async fn is_connected(&self) -> bool {
        *self.state.lock().await == SshConnectionState::Connected
    }

    /// Get current connection state
    pub async fn get_state(&self) -> SshConnectionState {
        *self.state.lock().await
    }

    /// Execute a command on the remote host
    pub async fn execute_command(&self, cmd: &str) -> Result<String, SshError> {
        // Ensure connection is established, reconnect if needed
        if !self.is_connected().await {
            self.reconnect_if_needed().await?;
        }

        let mut session = self.session.lock().await;
        let session = session.as_mut().ok_or(SshError::ConnectionError(
            "No active SSH session".to_string(),
        ))?;

        // Create channel and execute command
        let mut channel = session
            .channel_session()
            .map_err(|e| SshError::ConnectionError(format!("Failed to create channel: {}", e)))?;

        channel.exec(cmd).map_err(|e| {
            SshError::CommandExecutionError {
                exit_code: -1,
                stderr: format!("Failed to execute command: {}", e),
            }
        })?;

        // Read output
        let mut output = String::new();
        channel.read_to_string(&mut output).map_err(|e| {
            SshError::CommandExecutionError {
                exit_code: -1,
                stderr: format!("Failed to read output: {}", e),
            }
        })?;

        // Check exit status
        let exit_code = channel.exit_status().unwrap_or(-1);
        if exit_code != 0 {
            return Err(SshError::CommandExecutionError {
                exit_code,
                stderr: output,
            });
        }

        Ok(output)
    }

    /// Reconnect if needed with exponential backoff
    async fn reconnect_if_needed(&self) -> Result<(), SshError> {
        let state = *self.state.lock().await;
        let password = self.session_password.lock().await.as_ref().cloned();

        match state {
            SshConnectionState::Connected => Ok(()),
            SshConnectionState::Initial | SshConnectionState::Disconnected => {
                self.connect(password).await
            }
            SshConnectionState::Connecting => {
                // Wait for connection in progress
                let mut attempts = 0;
                while *self.state.lock().await == SshConnectionState::Connecting && attempts < 50 {
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    attempts += 1;
                }
                if self.is_connected().await {
                    Ok(())
                } else {
                    Err(SshError::ConnectionError(
                        "Connection timeout".to_string(),
                    ))
                }
            }
            SshConnectionState::Reconnecting => {
                let attempt = self.reconnect_attempts.load(Ordering::SeqCst);
                if attempt >= 5 {
                    return Err(SshError::ConnectionError(
                        "Max reconnection attempts exceeded".to_string(),
                    ));
                }

                // Exponential backoff: 100ms * 2^attempt
                let delay_ms = 100u64 * 2u64.pow(attempt as u32);
                tokio::time::sleep(Duration::from_millis(delay_ms)).await;

                self.reconnect_attempts.fetch_add(1, Ordering::SeqCst);
                *self.state.lock().await = SshConnectionState::Connecting;

                let result = self.connect(password).await;
                if result.is_err() && attempt < 4 {
                    *self.state.lock().await = SshConnectionState::Reconnecting;
                }
                result
            }
        }
    }
}

impl std::fmt::Debug for RemoteSshSession {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RemoteSshSession")
            .field("ssh_connection", &self.ssh_connection)
            .field("reconnect_attempts", &self.reconnect_attempts.load(Ordering::SeqCst))
            .finish()
    }
}
