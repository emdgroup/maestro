pub mod client;
pub mod manager;
pub mod session;
pub mod registry;
pub mod transport;

pub use client::MaestroAcpClient;
pub use manager::{AcpProcess, AcpTransportWriter, spawn_acp_process, spawn_acp_process_remote, write_to_acp_session};
pub use session::{AcpSession, SessionState};
pub use registry::{AcpRegistry, AgentInfo, RegistryResponse, ResolvedLaunchCommand, RegistryCacheEntry, RemoteAgentStatus, fetch_or_return_cached, resolve_distribution, resolve_spawn_command, extract_underlying_binary};
