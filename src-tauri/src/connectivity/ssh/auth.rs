use std::sync::Arc;
use std::time::Duration;
use russh::client::{self, Handle};
use russh::keys::agent::client::AgentClient;
use crate::connectivity::ssh::error::SshError;
use crate::connectivity::ssh::session::SshClientHandler;

/// Expand a leading `~` to the user's home directory
pub(crate) fn expand_tilde(path: &str) -> String {
    if path == "~" || path.starts_with("~/") {
        if let Ok(home) = std::env::var("HOME") {
            return path.replacen('~', &home, 1);
        }
    }
    path.to_string()
}

/// Open a russh connection (TCP + SSH handshake) to the configured host
pub(crate) async fn open_handle(host: &str, port: u16) -> Result<Handle<SshClientHandler>, SshError> {
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
pub(crate) async fn authenticate_via_agent(
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
