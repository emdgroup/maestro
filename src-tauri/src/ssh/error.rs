use serde::{Deserialize, Serialize};
use std::fmt;

/// SSH operation errors distinguishing between transient and permanent failures
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum SshError {
    /// Network timeout, connection reset, or other transient network failures
    ConnectionError(String),
    /// Authentication failed, key not found, or permission denied
    AuthenticationError(String),
    /// File permission denied on remote host
    PermissionError(String),
    /// Command execution failed with specific exit code and stderr
    CommandExecutionError { exit_code: i32, stderr: String },
    /// Host key verification failed or mismatched
    HostKeyError(String),
    /// Unknown or unexpected error
    UnknownError(String),
}

impl fmt::Display for SshError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SshError::ConnectionError(msg) => write!(f, "SSH Connection Error: {}", msg),
            SshError::AuthenticationError(msg) => write!(f, "SSH Authentication Error: {}", msg),
            SshError::PermissionError(msg) => write!(f, "SSH Permission Error: {}", msg),
            SshError::CommandExecutionError { exit_code, stderr } => {
                write!(f, "SSH Command Failed (exit code {}): {}", exit_code, stderr)
            }
            SshError::HostKeyError(msg) => write!(f, "SSH Host Key Error: {}", msg),
            SshError::UnknownError(msg) => write!(f, "SSH Error: {}", msg),
        }
    }
}

impl std::error::Error for SshError {}

/// Check if an SSH error is transient (can be retried)
pub fn is_transient_error(error: &SshError) -> bool {
    matches!(error, SshError::ConnectionError(_))
}

/// Check if an error is permanent (should not be retried)
pub fn is_permanent_error(error: &SshError) -> bool {
    matches!(
        error,
        SshError::AuthenticationError(_)
            | SshError::PermissionError(_)
            | SshError::HostKeyError(_)
    )
}
