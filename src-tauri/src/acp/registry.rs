use serde::{Deserialize, Serialize};
use specta::Type;
use std::time::Instant;

/// Agent discovered by maestro-server's CDN registry check.
/// Returned by the `discover_agents` IPC command for both local and remote connections.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct DiscoveredAgent {
    pub id: String,
    pub name: String,
    pub icon: String,
    #[serde(default)]
    pub spawn_deps: Vec<String>,
}

/// Unified discovery result returned to the frontend via IPC.
/// Works for both local (`connection_id = None`) and remote (`connection_id = Some(id)`).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct AgentDiscoveryResult {
    pub maestro_server_available: bool,
    pub agents: Vec<DiscoveredAgent>,
    #[serde(default)]
    #[specta(optional)]
    pub error: Option<String>,
}

/// Result of detecting which agent tools are installed on the host.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct DetectedAgent {
    pub agent_id: String,
    pub tool_name: String,
    pub binary_found: bool,
    pub config_dir_found: bool,
}

/// Project-level agent detection: which agent tools have config markers in the project dir.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct ProjectAgentMatch {
    pub agent_id: String,
    pub markers_found: Vec<String>,
}

/// Internal cache entry — not exported to TS.
pub struct AgentDiscoveryCacheEntry {
    pub result: AgentDiscoveryResult,
    /// Absolute path to maestro-server binary on the target host.
    /// For remote: resolved via SSH `which maestro-server` at connect time.
    /// For local: None (spawn_acp_process resolves via `which::which` at spawn time).
    pub maestro_server_path: Option<String>,
    pub fetched_at: Instant,
}
