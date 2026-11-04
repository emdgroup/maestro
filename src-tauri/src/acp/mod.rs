pub mod attachment_handlers;
pub mod auth_handlers;
pub mod automation_tools;
pub mod canvas_handlers;
pub mod completion;
pub mod connection_server;
pub mod deploy;
pub mod discovery_handlers;
pub mod file_handlers;
pub mod host_tools;
pub mod manager;
pub mod meta_handlers;
pub mod prompt_handlers;
pub mod reader_task;
pub mod registry;
pub mod replay;
pub mod server_control;
pub mod session_handlers;
pub mod session_ops;
pub mod session_types;
pub mod skills;
pub mod transport_setup;
pub mod transport_types;
pub mod usage_handlers;

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

/// Identifies which connection server (or local instance) owns a session or cache entry.
#[derive(
    Debug, Clone, Copy, Hash, Eq, PartialEq, serde::Serialize, serde::Deserialize, specta::Type,
)]
#[serde(tag = "type")]
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
        match self {
            ConnectionKey::Ssh { id } => Some(*id),
            _ => None,
        }
    }

    pub fn wsl_id(&self) -> Option<i32> {
        match self {
            ConnectionKey::Wsl { id } => Some(*id),
            _ => None,
        }
    }

    pub fn docker_id(&self) -> Option<i32> {
        match self {
            ConnectionKey::Docker { id } => Some(*id),
            _ => None,
        }
    }

    /// Identifier for auth terminal ids and event names. Free to change format, unlike
    /// [`Self::storage_id`], which is written to the database.
    pub fn event_id(&self) -> String {
        match self {
            ConnectionKey::Local => "local".to_string(),
            ConnectionKey::Ssh { id } => format!("ssh-{id}"),
            ConnectionKey::Wsl { id } => format!("wsl-{id}"),
            ConnectionKey::Docker { id } => format!("docker-{id}"),
        }
    }

    /// Stable identifier for persisting a value against this connection.
    ///
    /// Separate from the identically-shaped [`Self::event_id`]: that one may change format
    /// freely, this one is written to the database and cannot.
    pub fn storage_id(&self) -> String {
        match self {
            ConnectionKey::Local => "local".to_string(),
            ConnectionKey::Ssh { id } => format!("ssh-{id}"),
            ConnectionKey::Wsl { id } => format!("wsl-{id}"),
            ConnectionKey::Docker { id } => format!("docker-{id}"),
        }
    }

    pub fn is_remote(&self) -> bool {
        matches!(
            self,
            ConnectionKey::Ssh { .. } | ConnectionKey::Wsl { .. } | ConnectionKey::Docker { .. }
        )
    }
}

pub use connection_server::{
    query_list_agents_via_connection_server, spawn_connection_server, stop_resident_servers,
};
pub use registry::{AgentDiscoveryCacheEntry, AgentDiscoveryResult, DiscoveredAgent};
pub use session_ops::{
    load_via_connection_server, restore_acp_sessions, spawn_via_connection_server,
    write_to_acp_session,
};
pub use session_types::{
    AcpProcess, AcpProcessParams, ConnectionServer, PendingRequests, RestorableSession,
    SessionCapabilitiesInfo, SessionRequest, TaskKey, TaskMetadata, TransportTarget,
};
