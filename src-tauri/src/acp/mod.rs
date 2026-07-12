pub mod deploy;
pub mod manager;
pub mod registry;
pub mod resolve;
pub mod transport;
pub mod session_handlers;
pub mod prompt_handlers;
pub mod discovery_handlers;
pub mod file_handlers;
pub mod meta_handlers;
pub mod attachment_handlers;
pub mod canvas;
pub mod transport_types;
pub mod session_types;
pub mod transport_setup;
pub mod reader_task;
pub mod connection_server;
pub mod session_ops;

/// Compile-time Rust target triple for the currently running platform.
/// Used to select and cache the correct maestro-server binary.
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
pub(crate) const HOST_TRIPLE: &str = "x86_64-unknown-linux-gnu";
#[cfg(all(target_os = "linux", target_arch = "aarch64"))]
pub(crate) const HOST_TRIPLE: &str = "aarch64-unknown-linux-gnu";
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
pub(crate) const HOST_TRIPLE: &str = "aarch64-apple-darwin";
#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
pub(crate) const HOST_TRIPLE: &str = "x86_64-pc-windows-msvc";

pub(crate) fn session_id_for(log_id: i32) -> String {
    format!("session-{}", log_id)
}

/// Identifies which connection server (or local instance) owns a session or cache entry.
#[derive(Debug, Clone, Copy, Hash, Eq, PartialEq, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(tag = "type")]
#[specta(export)]
pub enum ConnectionKey {
    #[serde(rename = "local")]
    Local,
    #[serde(rename = "ssh")]
    Ssh { id: i32 },
    #[serde(rename = "wsl")]
    Wsl { id: i32 },
    #[serde(rename = "docker")]
    Docker { id: i32 },
}

impl ConnectionKey {
    pub fn from_ids(ssh_id: Option<i32>, wsl_id: Option<i32>) -> Self {
        if let Some(id) = wsl_id {
            ConnectionKey::Wsl { id }
        } else if let Some(id) = ssh_id {
            ConnectionKey::Ssh { id }
        } else {
            ConnectionKey::Local
        }
    }

    pub fn from_all_ids(ssh_id: Option<i32>, wsl_id: Option<i32>, docker_id: Option<i32>) -> Self {
        if let Some(id) = docker_id {
            ConnectionKey::Docker { id }
        } else if let Some(id) = wsl_id {
            ConnectionKey::Wsl { id }
        } else if let Some(id) = ssh_id {
            ConnectionKey::Ssh { id }
        } else {
            ConnectionKey::Local
        }
    }

    pub fn ssh_id(&self) -> Option<i32> {
        match self { ConnectionKey::Ssh { id } => Some(*id), _ => None }
    }

    pub fn wsl_id(&self) -> Option<i32> {
        match self { ConnectionKey::Wsl { id } => Some(*id), _ => None }
    }

    pub fn docker_id(&self) -> Option<i32> {
        match self { ConnectionKey::Docker { id } => Some(*id), _ => None }
    }

    pub fn is_remote(&self) -> bool {
        matches!(self, ConnectionKey::Ssh { .. } | ConnectionKey::Wsl { .. } | ConnectionKey::Docker { .. })
    }
}



pub use session_types::{
    AcpProcess, AcpProcessParams, SessionRequest, AcpTransportWriter,
    SessionCapabilitiesInfo, ConnectionServer, PendingChannels, TaskMetadata,
    TransportTarget, RestorableSession,
};
pub use session_ops::{
    spawn_acp_session_cold, load_acp_session_cold, write_to_acp_session,
    restore_acp_sessions, resolve_remote_context,
    try_spawn_via_connection_server, try_session_load_via_connection_server,
};
pub use connection_server::{
    spawn_connection_server, pre_initialize_via_connection_server,
    query_session_list_via_server, query_session_close_via_server,
    query_check_tools_via_server, query_list_agents_via_connection_server,
};
pub use registry::{DiscoveredAgent, AgentDiscoveryResult, AgentDiscoveryCacheEntry};
