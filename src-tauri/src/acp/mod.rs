pub mod client;
pub mod manager;
pub mod session;
pub mod registry;
pub mod transport;

pub use client::MaestroAcpClient;
pub use manager::{AcpProcess, spawn_acp_process, write_to_acp_session};
pub use session::{AcpSession, SessionState};
pub use registry::{AcpRegistry, AgentInfo, RegistryResponse, ResolvedLaunchCommand, RegistryCacheEntry, fetch_or_return_cached, resolve_distribution};
