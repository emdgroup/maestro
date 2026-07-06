use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex;
use zeroize::Zeroizing;
use russh::client::{self, Handle};
use russh::ChannelMsg;
use russh::keys::PrivateKeyWithHashAlg;
use crate::connectivity::ssh::error::SshError;
use crate::connectivity::ssh::PasswordManager;
use crate::connectivity::ssh::auth::{authenticate_via_agent, expand_tilde, open_handle};
pub use crate::connectivity::ssh::types::{
    SshAuthMethod, SshConnection, SshConnectionState, ReconnectingPayload,
};
pub use crate::connectivity::ssh::history::SshPtyHandle;
pub use crate::connectivity::ssh::pty::SshWriteOp;

/// russh client handler — accepts all server keys (same behaviour as previous libssh2 code)
pub(crate) struct SshClientHandler;

impl client::Handler for SshClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &russh::keys::PublicKey,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }
}

/// Manages a persistent SSH connection for a remote project
pub struct RemoteSshSession {
    pub(crate) handle: Arc<Mutex<Option<Handle<SshClientHandler>>>>,
    ssh_connection: SshConnection,
    pub(crate) state: Arc<Mutex<SshConnectionState>>,
    pub(crate) reconnect_attempts: Arc<AtomicUsize>,
    pub(crate) session_password: Arc<Mutex<Option<Zeroizing<String>>>>,
    key_passphrase: Arc<Mutex<Option<String>>>,
}

impl Clone for RemoteSshSession {
    fn clone(&self) -> Self {
        Self {
            handle: self.handle.clone(),
            ssh_connection: self.ssh_connection.clone(),
            state: self.state.clone(),
            reconnect_attempts: self.reconnect_attempts.clone(),
            session_password: self.session_password.clone(),
            key_passphrase: self.key_passphrase.clone(),
        }
    }
}

impl RemoteSshSession {
    /// Create a new SSH session with the given configuration
    pub fn new(ssh_connection: SshConnection) -> Self {
        Self {
            handle: Arc::new(Mutex::new(None)),
            ssh_connection,
            state: Arc::new(Mutex::new(SshConnectionState::Initial)),
            reconnect_attempts: Arc::new(AtomicUsize::new(0)),
            session_password: Arc::new(Mutex::new(None)),
            key_passphrase: Arc::new(Mutex::new(None)),
        }
    }

    pub fn connection_id(&self) -> i32 {
        self.ssh_connection.id
    }

    /// Establish SSH connection with authentication
    pub async fn connect(&self, password: Option<String>) -> Result<(), SshError> {
        *self.state.lock().await = SshConnectionState::Connecting;

        let host = &self.ssh_connection.host;
        let port = self.ssh_connection.port;
        let username = self.ssh_connection.username.clone();

        let mut handle = open_handle(host, port).await?;

        let auth_result = match &self.ssh_connection.auth_method {
            SshAuthMethod::Password { save_password } => {
                let pwd: Zeroizing<String> = if *save_password {
                    PasswordManager::get_password(host, &username).map_err(|e| {
                        SshError::AuthenticationError(format!("Failed to retrieve password: {}", e))
                    })?
                } else {
                    let connection_string = format!("{username}@{host}");
                    let mem_password = password.ok_or_else(|| {
                        SshError::AuthenticationError(format!(
                            "No password found for {connection_string}"
                        ))
                    })?;
                    *self.session_password.lock().await = Some(Zeroizing::new(mem_password.clone()));
                    Zeroizing::new(mem_password)
                };

                handle
                    .authenticate_password(&username, pwd.as_str())
                    .await
                    .map_err(|e| SshError::AuthenticationError(format!(
                        "Password authentication failed: {}", e
                    )))?
            }

            SshAuthMethod::KeyFile { path, save_passphrase } => {
                let expanded = expand_tilde(path);
                let mem_passphrase = self.key_passphrase.lock().await.clone();
                let passphrase = if mem_passphrase.is_some() {
                    mem_passphrase
                } else if *save_passphrase {
                    PasswordManager::get_passphrase(&expanded).ok().map(|p| p.to_string())
                } else {
                    None
                };

                if !Path::new(&expanded).exists() {
                    return Err(SshError::AuthenticationError(format!(
                        "Key file not found on reconnect: '{}'", expanded
                    )));
                }

                let key = russh::keys::load_secret_key(Path::new(&expanded), passphrase.as_deref())
                    .map_err(|e| SshError::AuthenticationError(format!(
                        "Failed to load key '{}': {}", expanded, e
                    )))?;

                let hash_alg = handle.best_supported_rsa_hash()
                    .await
                    .map_err(|e| SshError::ConnectionError(format!(
                        "Failed to query RSA hash algorithms: {}", e
                    )))?
                    .flatten();

                handle
                    .authenticate_publickey(
                        &username,
                        PrivateKeyWithHashAlg::new(Arc::new(key), hash_alg),
                    )
                    .await
                    .map_err(|e| SshError::AuthenticationError(format!(
                        "Public key authentication failed for '{}' on reconnect: {}", expanded, e
                    )))?
            }

            SshAuthMethod::Agent => {
                let authenticated = authenticate_via_agent(&mut handle, &username).await?;
                if !authenticated {
                    return Err(SshError::AuthenticationError(
                        "SSH agent: no key was accepted by the server".to_string()
                    ));
                }
                // Return early — already confirmed authenticated
                *self.handle.lock().await = Some(handle);
                *self.state.lock().await = SshConnectionState::Connected;
                self.reconnect_attempts.store(0, Ordering::SeqCst);
                return Ok(());
            }
        };

        if !auth_result.success() {
            return Err(SshError::AuthenticationError(
                "Authentication failed: SSH server did not grant access".to_string(),
            ));
        }

        *self.handle.lock().await = Some(handle);
        *self.state.lock().await = SshConnectionState::Connected;
        self.reconnect_attempts.store(0, Ordering::SeqCst);

        Ok(())
    }

    /// Establish SSH connection using an explicit key file path and optional passphrase.
    /// This is the primary path for interactive key auth from the UI.
    pub async fn connect_with_key(
        &self,
        key_path: Option<String>,
        passphrase: Option<String>,
    ) -> Result<(), SshError> {
        *self.state.lock().await = SshConnectionState::Connecting;

        let host = &self.ssh_connection.host;
        let port = self.ssh_connection.port;
        let username = self.ssh_connection.username.clone();

        let fallback_path;
        let path: &str = if let Some(ref p) = key_path {
            p.as_str()
        } else if let SshAuthMethod::KeyFile { path, .. } = &self.ssh_connection.auth_method {
            fallback_path = path.clone();
            fallback_path.as_str()
        } else {
            return Err(SshError::AuthenticationError("No key path provided".to_string()));
        };

        let expanded = expand_tilde(path);

        if !Path::new(&expanded).exists() {
            return Err(SshError::AuthenticationError(format!(
                "Key file not found: '{}'. Check the path and try again.",
                expanded
            )));
        }

        // Read the file to detect if it is a public key (user error)
        let key_data = std::fs::read_to_string(&expanded)
            .map_err(|e| SshError::AuthenticationError(format!(
                "Cannot read key file '{}': {}", expanded, e
            )))?;

        if key_data.starts_with("ssh-") || key_data.starts_with("ecdsa-")
            || key_data.contains("BEGIN PUBLIC KEY")
        {
            return Err(SshError::AuthenticationError(
                "This is a public key file (.pub). Please select the matching private key file (no .pub extension).".to_string()
            ));
        }

        // Store the passphrase so reconnection can reuse it
        *self.key_passphrase.lock().await = passphrase.clone();

        let mut handle = open_handle(host, port).await?;

        // russh-keys handles all formats natively (OpenSSH ed25519, RSA PEM, ECDSA, …)
        let key = russh::keys::load_secret_key(Path::new(&expanded), passphrase.as_deref())
            .map_err(|e| SshError::AuthenticationError(format!(
                "Failed to load key '{}': {}", expanded, e
            )))?;

        let hash_alg = handle.best_supported_rsa_hash()
            .await
            .map_err(|e| SshError::ConnectionError(format!(
                "Failed to query RSA hash algorithms: {}", e
            )))?
            .flatten();

        let auth_result = handle
            .authenticate_publickey(
                &username,
                PrivateKeyWithHashAlg::new(Arc::new(key), hash_alg),
            )
            .await
            .map_err(|e| SshError::AuthenticationError(format!(
                "Public key authentication failed for '{}': {}", expanded, e
            )))?;

        if !auth_result.success() {
            return Err(SshError::AuthenticationError(format!(
                "Server did not grant access for '{}'", expanded
            )));
        }

        *self.handle.lock().await = Some(handle);
        *self.state.lock().await = SshConnectionState::Connected;
        self.reconnect_attempts.store(0, Ordering::SeqCst);

        Ok(())
    }

    /// Disconnect from the SSH server
    pub async fn disconnect(&self) {
        *self.handle.lock().await = None;
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
        if !self.is_connected().await {
            self.reconnect_if_needed().await?;
        }

        // Open a channel while holding the mutex, then release it.
        // channel_open_session() takes &self so we only need a shared ref.
        // If channel open fails, the underlying connection may have dropped silently
        // (e.g. inactivity timeout on the server). Mark as disconnected and retry once.
        let mut channel = {
            let open_result = {
                let guard = self.handle.lock().await;
                let handle = guard.as_ref().ok_or_else(|| SshError::ConnectionError(
                    "No active SSH session".to_string(),
                ))?;
                handle.channel_open_session().await
            };

            match open_result {
                Ok(ch) => ch,
                Err(_) => {
                    // Connection was silently dropped — reconnect and try once more
                    *self.state.lock().await = SshConnectionState::Disconnected;
                    self.reconnect_if_needed().await?;
                    let guard = self.handle.lock().await;
                    let handle = guard.as_ref().ok_or_else(|| SshError::ConnectionError(
                        "No active SSH session after reconnect".to_string(),
                    ))?;
                    handle
                        .channel_open_session()
                        .await
                        .map_err(|e2| SshError::ConnectionError(format!("Failed to create channel after reconnect: {}", e2)))?
                }
            }
        };

        channel
            .exec(true, cmd.as_bytes())
            .await
            .map_err(|e| SshError::CommandExecutionError {
                exit_code: -1,
                stderr: format!("Failed to execute command: {}", e),
            })?;

        let mut stdout = String::new();
        let mut stderr_buf = String::new();
        let mut exit_code = 0i32;

        loop {
            match channel.wait().await {
                None => break,
                Some(ChannelMsg::Data { ref data }) => {
                    stdout.push_str(&String::from_utf8_lossy(data));
                }
                Some(ChannelMsg::ExtendedData { ref data, ext: 1 }) => {
                    stderr_buf.push_str(&String::from_utf8_lossy(data));
                }
                Some(ChannelMsg::ExitStatus { exit_status }) => {
                    exit_code = exit_status as i32;
                }
                _ => {}
            }
        }

        if exit_code != 0 {
            return Err(SshError::CommandExecutionError {
                exit_code,
                stderr: if stderr_buf.is_empty() { stdout } else { stderr_buf },
            });
        }

        Ok(stdout)
    }

    /// Execute a command on the remote host, piping `stdin_data` to its stdin.
    pub async fn execute_command_with_stdin(&self, cmd: &str, stdin_data: &[u8]) -> Result<String, SshError> {
        if !self.is_connected().await {
            self.reconnect_if_needed().await?;
        }

        let mut channel = {
            let open_result = {
                let guard = self.handle.lock().await;
                let handle = guard.as_ref().ok_or_else(|| SshError::ConnectionError(
                    "No active SSH session".to_string(),
                ))?;
                handle.channel_open_session().await
            };

            match open_result {
                Ok(ch) => ch,
                Err(_) => {
                    *self.state.lock().await = SshConnectionState::Disconnected;
                    self.reconnect_if_needed().await?;
                    let guard = self.handle.lock().await;
                    let handle = guard.as_ref().ok_or_else(|| SshError::ConnectionError(
                        "No active SSH session after reconnect".to_string(),
                    ))?;
                    handle
                        .channel_open_session()
                        .await
                        .map_err(|e| SshError::ConnectionError(format!("Failed to create channel after reconnect: {}", e)))?
                }
            }
        };

        channel
            .exec(true, cmd.as_bytes())
            .await
            .map_err(|e| SshError::CommandExecutionError {
                exit_code: -1,
                stderr: format!("Failed to execute command: {}", e),
            })?;

        channel
            .data(std::io::Cursor::new(stdin_data))
            .await
            .map_err(|e| SshError::CommandExecutionError {
                exit_code: -1,
                stderr: format!("Failed to write stdin: {}", e),
            })?;
        channel
            .eof()
            .await
            .map_err(|e| SshError::CommandExecutionError {
                exit_code: -1,
                stderr: format!("Failed to send EOF: {}", e),
            })?;

        let mut stdout = String::new();
        let mut stderr_buf = String::new();
        let mut exit_code = 0i32;

        loop {
            match channel.wait().await {
                None => break,
                Some(ChannelMsg::Data { ref data }) => {
                    stdout.push_str(&String::from_utf8_lossy(data));
                }
                Some(ChannelMsg::ExtendedData { ref data, ext: 1 }) => {
                    stderr_buf.push_str(&String::from_utf8_lossy(data));
                }
                Some(ChannelMsg::ExitStatus { exit_status }) => {
                    exit_code = exit_status as i32;
                }
                _ => {}
            }
        }

        if exit_code != 0 {
            return Err(SshError::CommandExecutionError {
                exit_code,
                stderr: if stderr_buf.is_empty() { stdout } else { stderr_buf },
            });
        }

        Ok(stdout)
    }

    /// Open an SSH exec channel and execute `cmd`, returning the channel for streaming I/O.
    ///
    /// Unlike `execute_command` (which collects all output), this returns the raw channel so
    /// callers can use split() for concurrent stdin writes and stdout reads (e.g. ACP sessions).
    pub async fn open_exec_channel(&self, cmd: &str) -> Result<russh::Channel<russh::client::Msg>, SshError> {
        if !self.is_connected().await {
            self.reconnect_if_needed().await?;
        }

        let channel = {
            let guard = self.handle.lock().await;
            let handle = guard.as_ref().ok_or_else(|| {
                SshError::ConnectionError("No active SSH session".to_string())
            })?;
            handle.channel_open_session().await.map_err(|e| {
                SshError::ConnectionError(format!("Failed to open SSH channel: {}", e))
            })?
        };

        channel
            .exec(true, cmd.as_bytes())
            .await
            .map_err(|e| SshError::CommandExecutionError {
                exit_code: -1,
                stderr: format!("Failed to exec '{}': {}", cmd, e),
            })?;

        Ok(channel)
    }

    /// Open an SFTP subsystem channel on the current SSH connection.
    ///
    /// Opens a session channel, requests the "sftp" subsystem, and returns a high-level
    /// `SftpSession`. On channel open failure, reconnects once (same pattern as
    /// `execute_command`). The returned session owns the channel — drop it when done.
    pub async fn open_sftp_session(&self) -> Result<russh_sftp::client::SftpSession, SshError> {
        if !self.is_connected().await {
            self.reconnect_if_needed().await?;
        }

        let channel = {
            let open_result = {
                let guard = self.handle.lock().await;
                let handle = guard.as_ref().ok_or_else(|| SshError::ConnectionError(
                    "No active SSH session".to_string(),
                ))?;
                handle.channel_open_session().await
            };

            match open_result {
                Ok(ch) => ch,
                Err(_) => {
                    *self.state.lock().await = SshConnectionState::Disconnected;
                    self.reconnect_if_needed().await?;
                    let guard = self.handle.lock().await;
                    let handle = guard.as_ref().ok_or_else(|| SshError::ConnectionError(
                        "No active SSH session after reconnect".to_string(),
                    ))?;
                    handle
                        .channel_open_session()
                        .await
                        .map_err(|e| SshError::ConnectionError(
                            format!("Failed to create SFTP channel after reconnect: {}", e),
                        ))?
                }
            }
        };

        channel
            .request_subsystem(true, "sftp")
            .await
            .map_err(|e| SshError::ConnectionError(
                format!("Failed to request SFTP subsystem: {}", e),
            ))?;

        russh_sftp::client::SftpSession::new(channel.into_stream())
            .await
            .map_err(|e| SshError::ConnectionError(
                format!("Failed to initialize SFTP session: {}", e),
            ))
    }

    /// Reconnect if needed with exponential backoff.
    /// Holds state lock across check+transition to prevent concurrent reconnection.
    pub(crate) async fn reconnect_if_needed(&self) -> Result<(), SshError> {
        // Hold state lock across check+transition so a concurrent caller sees Connecting and waits
        let mut state = self.state.lock().await;
        let password = self.session_password.lock().await.as_ref().map(|p| p.to_string());

        match *state {
            SshConnectionState::Connected => Ok(()),
            SshConnectionState::Initial | SshConnectionState::Disconnected => {
                *state = SshConnectionState::Connecting;
                drop(state); // Release before async connect
                self.connect(password).await
            }
            SshConnectionState::Connecting => {
                drop(state); // Release lock before waiting
                let mut attempts = 0;
                while *self.state.lock().await == SshConnectionState::Connecting && attempts < 50 {
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    attempts += 1;
                }
                if self.is_connected().await {
                    Ok(())
                } else {
                    Err(SshError::ConnectionError("Connection timeout".to_string()))
                }
            }
            SshConnectionState::Reconnecting => {
                // Heartbeat owns reconnection — wait for it to complete.
                drop(state);
                let mut polls = 0;
                while {
                    let s = *self.state.lock().await;
                    s == SshConnectionState::Reconnecting || s == SshConnectionState::Connecting
                } && polls < 200
                {
                    tokio::time::sleep(Duration::from_millis(500)).await;
                    polls += 1;
                }
                if self.is_connected().await {
                    Ok(())
                } else {
                    Err(SshError::ConnectionError("Reconnection failed".to_string()))
                }
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
