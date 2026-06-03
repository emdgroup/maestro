use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;
use rusqlite::ToSql;
use rusqlite::Result as SqliteResult;
use rusqlite::types::{FromSql, FromSqlResult, ToSqlOutput, ValueRef};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use specta::Type;
use zeroize::Zeroizing;
use russh::client::{self, Handle};
use russh::keys::agent::client::AgentClient;
use russh::ChannelMsg;
use russh::keys::PrivateKeyWithHashAlg;
use crate::connectivity::ssh::error::SshError;
use crate::connectivity::ssh::PasswordManager;

/// Operation sent to the SSH PTY writer task
pub enum SshWriteOp {
    Data(Vec<u8>),
    Resize(u32, u32),
}

/// Append a chunk to the SSH session history buffer with clear-screen trimming.
///
/// If the chunk contains `\x1b[2J` (ANSI clear-screen), all content before and
/// including the LAST occurrence is dropped — respecting the semantic meaning of
/// clear-screen. A 512 KB byte-cap fallback trims from the front to the nearest
/// `\r\n` boundary to prevent unbounded growth.
///
/// Returns `(drained_bytes, was_clear_screen)`:
/// - `drained_bytes`: bytes removed from the **front** of the buffer by the 512 KB cap
///   path (0 for clear-screen replacement and no-op appends). Callers add this to a
///   monotonic `total_drained` counter so readers can adjust their byte positions.
/// - `was_clear_screen`: true when the history buffer was completely replaced due to a
///   `\x1b[2J` sequence. Readers must reset their byte position to 0 when this is true,
///   regardless of whether the new history length is larger than the old position — the
///   old position is meaningless in the new (completely different) buffer.
fn append_to_history(history: &mut String, chunk: &str) -> (usize, bool) {
    if let Some(pos) = chunk.rfind("\x1b[2J") {
        // Clear-screen: replace buffer entirely — not a front-drain.
        // Prepend \x1b[H (cursor home) so readers always start at the top-left corner
        // when replaying. The real `clear` command sends \x1b[H\x1b[2J but we trim
        // everything before the last \x1b[2J, losing the \x1b[H. Restoring it here
        // prevents new output from appearing at the old cursor position after a clear.
        history.clear();
        history.push_str("\x1b[H");
        history.push_str(&chunk[pos..]);
        (0, true)
    } else {
        history.push_str(chunk);
        const MAX_BYTES: usize = 512 * 1024;
        if history.len() > MAX_BYTES {
            let trim_to = history.len() - MAX_BYTES;
            // Round up to a valid char boundary
            let trim_to = (trim_to..history.len())
                .find(|&i| history.is_char_boundary(i))
                .unwrap_or(trim_to);
            if let Some(nl) = history[trim_to..].find("\r\n") {
                let actual = trim_to + nl + 2;
                history.drain(..actual);
                (actual, false)
            } else {
                history.drain(..trim_to);
                (trim_to, false)
            }
        } else {
            (0, false)
        }
    }
}

/// Handle to a remote interactive SSH PTY session.
///
/// `write_tx` sends input bytes or resize events to the remote PTY.
/// `history` buffers session output as a trimmed String (ANSI clear-screen aware, 512 KB cap).
/// `notify` fires whenever a new chunk is appended to `history`.
/// `process_ended` is set true when the remote process exits or the channel closes.
/// `total_drained` is the cumulative bytes ever removed from the **front** of `history` by the
/// 512 KB cap (not by clear-screen replacements). Readers subtract the delta from their byte
/// position on each iteration to stay correctly positioned after a drain.
/// `clear_screen_count` increments each time `append_to_history` completely replaces the buffer
/// due to a `\x1b[2J` sequence. Readers reset their byte position to 0 when this counter
/// advances — the old position is meaningless in the newly-replaced buffer, and failing to
/// reset causes partial escape sequences (e.g. `?2026l` without the leading `\x1b[`) to be
/// sent to the frontend as literal printable characters.
#[derive(Clone)]
pub struct SshPtyHandle {
    pub log_id: i32,
    pub write_tx: tokio::sync::mpsc::Sender<SshWriteOp>,
    pub history: Arc<tokio::sync::Mutex<String>>,
    pub notify: Arc<tokio::sync::Notify>,
    pub process_ended: Arc<AtomicBool>,
    pub total_drained: Arc<AtomicUsize>,
    pub clear_screen_count: Arc<AtomicUsize>,
}

/// russh client handler — accepts all server keys (same behaviour as previous libssh2 code)
struct SshClientHandler;

impl client::Handler for SshClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &russh::keys::PublicKey,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }
}

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
    KeyFile { path: String, save_passphrase: bool },
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

/// Payload for ssh-reconnecting Tauri events
#[derive(Clone, Serialize)]
pub struct ReconnectingPayload {
    pub connection_id: i32,
    pub attempt: usize,
    pub max_attempts: usize,
}

/// Manages a persistent SSH connection for a remote project
pub struct RemoteSshSession {
    handle: Arc<Mutex<Option<Handle<SshClientHandler>>>>,
    ssh_connection: SshConnection,
    pub(crate) state: Arc<Mutex<SshConnectionState>>,
    pub(crate) reconnect_attempts: Arc<AtomicUsize>,
    pub(crate) session_password: Arc<Mutex<Option<Zeroizing<String>>>>,
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
            handle: self.handle.clone(),
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

/// Open a russh connection (TCP + SSH handshake) to the configured host
async fn open_handle(host: &str, port: u16) -> Result<Handle<SshClientHandler>, SshError> {
    let config = Arc::new(client::Config {
        inactivity_timeout: Some(Duration::from_secs(300)),
        keepalive_interval: Some(Duration::from_secs(30)),
        keepalive_max: 3,
        ..Default::default()
    });
    let addr = format!("{}:{}", host, port);
    tokio::time::timeout(
        Duration::from_secs(10),
        client::connect(config, addr.as_str(), SshClientHandler),
    )
    .await
    .map_err(|_| SshError::ConnectionError(format!(
        "Connection to {}:{} timed out", host, port
    )))?
    .map_err(|e| SshError::ConnectionError(format!(
        "Failed to connect to {}:{}: {}", host, port, e
    )))
}

/// Authenticate via SSH agent (platform-specific)
async fn authenticate_via_agent(
    handle: &mut Handle<SshClientHandler>,
    username: &str,
) -> Result<bool, SshError> {
    #[cfg(unix)]
    {
        let mut agent = AgentClient::connect_env()
            .await
            .map_err(|e| SshError::AuthenticationError(
                format!("SSH agent connect failed: {}", e)
            ))?;
        let identities = agent.request_identities()
            .await
            .map_err(|e| SshError::AuthenticationError(
                format!("Failed to list agent keys: {}", e)
            ))?;
        for pubkey in &identities {
            let result = handle
                .authenticate_publickey_with(username, pubkey.public_key().into_owned(), None, &mut agent)
                .await
                .map_err(|e| SshError::AuthenticationError(
                    format!("Agent authentication failed: {:?}", e)
                ))?;
            if result.success() {
                return Ok(true);
            }
        }
        Ok(false)
    }

    #[cfg(windows)]
    {
        // Connect to the Windows OpenSSH agent via its named pipe
        let pipe = tokio::net::windows::named_pipe::ClientOptions::new()
            .open(r"\\.\pipe\openssh-ssh-agent")
            .map_err(|e| SshError::AuthenticationError(
                format!("Failed to connect to Windows SSH agent pipe: {}", e)
            ))?;
        let mut agent = AgentClient::connect(pipe);
        let identities = agent.request_identities()
            .await
            .map_err(|e| SshError::AuthenticationError(
                format!("Failed to list agent keys: {}", e)
            ))?;
        for pubkey in &identities {
            let result = handle
                .authenticate_publickey_with(username, pubkey.public_key().into_owned(), None, &mut agent)
                .await
                .map_err(|e| SshError::AuthenticationError(
                    format!("Agent authentication failed: {:?}", e)
                ))?;
            if result.success() {
                return Ok(true);
            }
        }
        Ok(false)
    }

    #[cfg(not(any(unix, windows)))]
    {
        Err(SshError::AuthenticationError(
            "SSH agent authentication is not supported on this platform".to_string()
        ))
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
    async fn reconnect_if_needed(&self) -> Result<(), SshError> {
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

    /// Open an interactive SSH PTY session on the remote machine.
    ///
    /// Allocates a PTY with `TERM=xterm-256color`, then issues a `request_shell` so the
    /// SSH server starts the user's configured login shell (zsh, bash, fish, etc.).
    /// Returns an `SshPtyHandle` for streaming I/O between the local xterm and the remote shell.
    pub async fn spawn_remote_pty(
        &self,
        cols: u16,
        rows: u16,
        log_id: i32,
    ) -> Result<SshPtyHandle, String> {
        if !self.is_connected().await {
            self.reconnect_if_needed().await.map_err(|e| e.to_string())?;
        }

        // Open a dedicated SSH channel for this PTY session
        let channel = {
            let guard = self.handle.lock().await;
            let h = guard
                .as_ref()
                .ok_or("No active SSH session")?;
            h.channel_open_session()
                .await
                .map_err(|e| format!("Failed to open SSH channel: {}", e))?
        };

        let (mut read_half, write_half) = channel.split();

        // Allocate a PTY — this sets TERM=xterm-256color on the remote side
        write_half
            .request_pty(true, "xterm-256color", cols as u32, rows as u32, 0, 0, &[])
            .await
            .map_err(|e| format!("Failed to request PTY: {}", e))?;

        // Request the user's configured login shell via SSH request_shell
        write_half
            .request_shell(true)
            .await
            .map_err(|e| format!("Failed to request remote shell: {}", e))?;

        // Create I/O channels
        let (write_tx, mut write_rx) = tokio::sync::mpsc::channel::<SshWriteOp>(32);

        // History buffer: accumulates session output with ANSI clear-screen trimming and 512 KB cap.
        // attach_terminal replays from pos=0 for live sessions and reads the DB for dead sessions.
        let history: Arc<tokio::sync::Mutex<String>> = Arc::new(tokio::sync::Mutex::new(String::new()));
        let notify: Arc<tokio::sync::Notify> = Arc::new(tokio::sync::Notify::new());
        let process_ended: Arc<AtomicBool> = Arc::new(AtomicBool::new(false));
        // Cumulative front-drain counter: incremented only by the 512 KB cap path, never by
        // clear-screen replacements. Readers use this to adjust their byte positions after a drain.
        let total_drained: Arc<AtomicUsize> = Arc::new(AtomicUsize::new(0));
        // Clear-screen replacement counter: incremented each time the history buffer is fully
        // replaced due to a \x1b[2J sequence. Readers reset pos=0 when this counter advances,
        // preventing partial escape sequences from being sent as literal printable characters.
        let clear_screen_count: Arc<AtomicUsize> = Arc::new(AtomicUsize::new(0));

        let history_writer = Arc::clone(&history);
        let notify_writer = Arc::clone(&notify);
        let ended_writer = Arc::clone(&process_ended);
        let total_drained_writer = Arc::clone(&total_drained);
        let clear_screen_count_writer = Arc::clone(&clear_screen_count);

        // Writer task: owns write_half, processes data and resize ops sequentially.
        // make_writer() clones the internal sender, leaving write_half available for window_change.
        tokio::spawn(async move {
            use tokio::io::AsyncWriteExt;
            let mut writer = write_half.make_writer();
            while let Some(op) = write_rx.recv().await {
                match op {
                    SshWriteOp::Data(bytes) => {
                        if writer.write_all(&bytes).await.is_err() {
                            break;
                        }
                    }
                    SshWriteOp::Resize(cols, rows) => {
                        let _ = write_half.window_change(cols, rows, 0, 0).await;
                    }
                }
            }
        });

        // Reader task: appends output to history and notifies waiters.
        // attach_terminal replays from pos=0 for live sessions; dead sessions recover from DB.
        tokio::spawn(async move {
            loop {
                match read_half.wait().await {
                    Some(ChannelMsg::Data { data }) => {
                        let text = String::from_utf8_lossy(&data).to_string();
                        let (drained, was_clear_screen) = {
                            let mut hist = history_writer.lock().await;
                            append_to_history(&mut hist, &text)
                        };
                        if was_clear_screen {
                            clear_screen_count_writer.fetch_add(1, Ordering::Release);
                        } else if drained > 0 {
                            total_drained_writer.fetch_add(drained, Ordering::Release);
                        }
                        notify_writer.notify_one();
                    }
                    Some(ChannelMsg::ExtendedData { data, .. }) => {
                        let text = String::from_utf8_lossy(&data).to_string();
                        let (drained, was_clear_screen) = {
                            let mut hist = history_writer.lock().await;
                            append_to_history(&mut hist, &text)
                        };
                        if was_clear_screen {
                            clear_screen_count_writer.fetch_add(1, Ordering::Release);
                        } else if drained > 0 {
                            total_drained_writer.fetch_add(drained, Ordering::Release);
                        }
                        notify_writer.notify_one();
                    }
                    Some(ChannelMsg::ExitStatus { exit_status }) => {
                        let msg = if exit_status == 0 {
                            "\r\n\x1b[32m[Process exited]\x1b[0m\r\n".to_string()
                        } else {
                            format!(
                                "\r\n\x1b[31m[Process exited with code {}]\x1b[0m\r\n",
                                exit_status
                            )
                        };
                        {
                            let mut hist = history_writer.lock().await;
                            // Exit message is short — clear-screen/drain return values not needed here
                            append_to_history(&mut hist, &msg);
                        }
                        notify_writer.notify_one();
                        break;
                    }
                    Some(ChannelMsg::Eof) => {
                        break;
                    }
                    Some(ChannelMsg::Close) => {
                        break;
                    }
                    None => {
                        break;
                    }
                    Some(_other) => {
                        // Unhandled message type — ignored
                    }
                }
            }
            ended_writer.store(true, Ordering::Release);
            notify_writer.notify_one();
        });

        Ok(SshPtyHandle { log_id, write_tx, history, notify, process_ended, total_drained, clear_screen_count })
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

#[cfg(test)]
mod tests {
    use super::append_to_history;

    #[test]
    fn test_append_to_history_clear_screen_mid_chunk() {
        let mut hist = String::from("old content");
        append_to_history(&mut hist, "prefix\x1b[2Jfresh");
        assert_eq!(hist, "\x1b[H\x1b[2Jfresh");
    }

    #[test]
    fn test_append_to_history_clear_screen_at_end() {
        let mut hist = String::from("old content");
        append_to_history(&mut hist, "some\x1b[2J");
        assert_eq!(hist, "\x1b[H\x1b[2J");
    }

    #[test]
    fn test_append_to_history_no_clear_under_cap() {
        let mut hist = String::from("hello ");
        append_to_history(&mut hist, "world");
        assert_eq!(hist, "hello world");
    }

    #[test]
    fn test_append_to_history_byte_cap_trim() {
        let mut hist = String::new();
        // Fill with lines totaling > 512 KB
        for i in 0..60000 {
            hist.push_str(&format!("line {}\r\n", i));
        }
        let before_len = hist.len();
        assert!(before_len > 512 * 1024);
        append_to_history(&mut hist, "final chunk");
        assert!(hist.len() <= 512 * 1024 + 20); // some tolerance for the final chunk
        assert!(hist.ends_with("final chunk"));
        // Should have trimmed at a \r\n boundary
        assert!(!hist.starts_with("line 0\r\n"));
    }

    #[test]
    fn test_append_to_history_utf8_boundary_safety() {
        let mut hist = String::new();
        // Fill near cap with multi-byte chars (each e-acute is 2 bytes)
        let repeated = "\u{00e9}".repeat(256 * 1024); // 512 KB of 2-byte chars
        hist.push_str(&repeated);
        // Append more to trigger trim
        append_to_history(&mut hist, &"\u{00e9}".repeat(1024));
        // Should not panic — that's the test
        assert!(hist.len() <= 512 * 1024 + 4096);
    }

    #[test]
    fn test_append_to_history_multiple_clear_screens() {
        let mut hist = String::from("old");
        append_to_history(&mut hist, "a\x1b[2Jb\x1b[2Jc");
        // rfind picks the LAST \x1b[2J; \x1b[H is prepended for correct cursor home on replay
        assert_eq!(hist, "\x1b[H\x1b[2Jc");
    }
}
