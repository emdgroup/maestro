use crate::connectivity::ssh::RemoteSshSession;
use std::sync::Arc;
use serde::{Deserialize, Serialize};
use specta::Type;

/// Represents the connection context for git operations
/// Routes operations to either local, remote (SSH), WSL, or Docker execution
#[derive(Clone)]
pub enum GitConnection {
    Local {
        path: String,
    },
    Remote {
        ssh: Arc<RemoteSshSession>,
        remote_path: String,
    },
    /// WSL distro: git runs via `wsl.exe -d <distro> -- git -C <path> ...`
    Wsl {
        distro: String,
        path: String,
    },
    /// Container: git runs via `<cli> exec -i <container_name> git -C <path> ...`
    Docker {
        container_name: String,
        path: String,
    },
}

impl GitConnection {
    /// Check if this is a remote SSH connection
    pub fn is_remote(&self) -> bool {
        matches!(self, GitConnection::Remote { .. })
    }

    /// Get the project path (local, remote, WSL-native, or container-native)
    pub fn path(&self) -> &str {
        match self {
            GitConnection::Local { path } => path,
            GitConnection::Remote { remote_path, .. } => remote_path,
            GitConnection::Wsl { path, .. } => path,
            GitConnection::Docker { path, .. } => path,
        }
    }

    /// Get the SSH session if this is a remote connection
    pub fn ssh_session(&self) -> Option<Arc<RemoteSshSession>> {
        match self {
            GitConnection::Remote { ssh, .. } => Some(ssh.clone()),
            _ => None,
        }
    }
}

/// Represents the status of a remote SSH connection for a project
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct ConnectionStatus {
    pub connection_id: i32,
    pub connected: bool,
    pub disconnected_reason: Option<String>,
}
