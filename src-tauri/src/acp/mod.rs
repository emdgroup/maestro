pub mod deploy;
pub mod manager;
pub mod registry;
pub mod resolve;
pub mod transport;

/// Identifies which connection server (or local instance) owns a session or cache entry.
#[derive(Debug, Clone, Copy, Hash, Eq, PartialEq)]
pub enum ConnectionKey {
    Local,
    Ssh(i32),
    Wsl(i32),
}

impl ConnectionKey {
    pub fn from_ids(ssh_id: Option<i32>, wsl_id: Option<i32>) -> Self {
        if let Some(wsl) = wsl_id {
            ConnectionKey::Wsl(wsl)
        } else if let Some(ssh) = ssh_id {
            ConnectionKey::Ssh(ssh)
        } else {
            ConnectionKey::Local
        }
    }

    /// Returns the SSH connection_id if this is an SSH connection.
    pub fn ssh_id(&self) -> Option<i32> {
        match self { ConnectionKey::Ssh(id) => Some(*id), _ => None }
    }

    /// Returns the WSL connection_id if this is a WSL connection.
    pub fn wsl_id(&self) -> Option<i32> {
        match self { ConnectionKey::Wsl(id) => Some(*id), _ => None }
    }

    /// Returns true if this connection key represents a remote (SSH or WSL) connection.
    pub fn is_remote(&self) -> bool {
        matches!(self, ConnectionKey::Ssh(_) | ConnectionKey::Wsl(_))
    }
}

pub use manager::{AcpProcess, AcpProcessParams, SessionRequest, AcpTransportWriter,
    SessionCapabilitiesInfo, CatalogOption, CatalogOptionValue, CatalogCommand,
    ConnectionServer, PendingChannels, TaskMetadata, AgentCache, AgentCacheMap,
    TransportTarget, PooledSession, RestorableSession,
    spawn_acp_session_cold, load_acp_session_cold, write_to_acp_session,
    spawn_connection_server, pre_initialize_via_connection_server,
    try_spawn_via_connection_server, query_session_list_via_server,
    query_session_close_via_server, query_check_tools_via_server,
    query_list_agents_via_connection_server,
    resolve_remote_context, try_session_load_via_connection_server, restore_acp_sessions};
pub use registry::{DiscoveredAgent, AgentDiscoveryResult, AgentDiscoveryCacheEntry};
