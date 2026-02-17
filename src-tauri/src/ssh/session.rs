use ssh2::Session;
use std::io::Read;
use std::net::TcpStream;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex;

use crate::models::SshConfig;
use crate::ssh::error::SshError;
use crate::ssh::PasswordManager;

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
    config: SshConfig,
    state: Arc<Mutex<SshConnectionState>>,
    reconnect_attempts: Arc<AtomicUsize>,
}

impl Clone for RemoteSshSession {
    fn clone(&self) -> Self {
        Self {
            session: self.session.clone(),
            config: self.config.clone(),
            state: self.state.clone(),
            reconnect_attempts: self.reconnect_attempts.clone(),
        }
    }
}

impl RemoteSshSession {
    /// Create a new SSH session with the given configuration
    pub fn new(config: SshConfig) -> Self {
        Self {
            session: Arc::new(Mutex::new(None)),
            config,
            state: Arc::new(Mutex::new(SshConnectionState::Initial)),
            reconnect_attempts: Arc::new(AtomicUsize::new(0)),
        }
    }

    /// Establish SSH connection with authentication
    pub async fn connect(&self) -> Result<(), SshError> {
        let mut state = self.state.lock().await;
        *state = SshConnectionState::Connecting;
        drop(state);

        // Parse host and port from config
        let host = &self.config.host;
        let port = self.config.port;
        let username = &self.config.username;

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
        match &self.config.auth_method {
            crate::models::SshAuthMethod::KeyFile { path } => {
                let key_path = Path::new(path);
                session
                    .userauth_pubkey_file(username, None, key_path, None)
                    .map_err(|e| {
                        SshError::AuthenticationError(format!(
                            "Public key authentication failed: {}",
                            e
                        ))
                    })?;
            }
            crate::models::SshAuthMethod::Agent => {
                session.userauth_agent(username).map_err(|e| {
                    SshError::AuthenticationError(format!("SSH agent authentication failed: {}", e))
                })?;
            }
            crate::models::SshAuthMethod::Password { save_password: _ } => {
                // Retrieve password from OS keyring
                let password = PasswordManager::get_password(host, username).map_err(|e| {
                    SshError::AuthenticationError(format!("Failed to retrieve password: {}", e))
                })?;

                session
                    .userauth_password(username, &password)
                    .map_err(|e| {
                        SshError::AuthenticationError(format!(
                            "Password authentication failed: {}",
                            e
                        ))
                    })?;
            }
            crate::models::SshAuthMethod::PasswordInMemory { password } => {
                // Use password provided in-memory (not persisted to keyring)
                session
                    .userauth_password(username, password)
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

        match state {
            SshConnectionState::Connected => Ok(()),
            SshConnectionState::Initial | SshConnectionState::Disconnected => {
                self.connect().await
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

                let result = self.connect().await;
                if result.is_err() && attempt < 4 {
                    *self.state.lock().await = SshConnectionState::Reconnecting;
                }
                result
            }
        }
    }

    /// Get the SSH config for this session
    pub fn get_config(&self) -> &SshConfig {
        &self.config
    }
}

impl std::fmt::Debug for RemoteSshSession {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RemoteSshSession")
            .field("config", &self.config)
            .field("reconnect_attempts", &self.reconnect_attempts.load(Ordering::SeqCst))
            .finish()
    }
}
