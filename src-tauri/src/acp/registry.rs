use serde::{Deserialize, Serialize};
use specta::Type;
use std::time::Instant;

/// Agent discovered by maestro-server's CDN registry check.
/// Returned by the `discover_agents` IPC command for both local and remote connections.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
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
pub struct AgentDiscoveryResult {
    pub maestro_server_available: bool,
    pub agents: Vec<DiscoveredAgent>,
    #[serde(default)]
    #[specta(optional)]
    pub error: Option<String>,
}

/// Internal cache entry — not exported to TS.
pub struct AgentDiscoveryCacheEntry {
    pub result: AgentDiscoveryResult,
    /// Absolute path to maestro-server binary on the target host.
    /// For remote: resolved via SSH `which maestro-server` at connect time.
    /// For local: None (spawn_acp_process resolves via `which::which` at spawn time).
    pub maestro_server_path: Option<String>,
    /// When `result` was discovered. `None` for an entry that only records where a deploy put
    /// the server: its empty `result` is a placeholder, not an answer, so it never counts as fresh.
    pub fetched_at: Option<Instant>,
}

impl AgentDiscoveryCacheEntry {
    /// Whether `result` is a discovery younger than `max_age`.
    pub fn is_fresh(&self, max_age: std::time::Duration) -> bool {
        self.fetched_at.is_some_and(|at| at.elapsed() < max_age)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn entry(fetched_at: Option<Instant>) -> AgentDiscoveryCacheEntry {
        AgentDiscoveryCacheEntry {
            result: AgentDiscoveryResult {
                maestro_server_available: true,
                agents: Vec::new(),
                error: None,
            },
            maestro_server_path: Some("/home/me/.maestro/bin/maestro-server".into()),
            fetched_at,
        }
    }

    /// A deploy records the server path before any discovery ran; serving that entry's empty
    /// agent list as an answer hid every installed agent for five minutes.
    #[test]
    fn a_path_only_entry_is_never_fresh() {
        assert!(!entry(None).is_fresh(Duration::from_secs(300)));
    }

    #[test]
    fn a_discovery_is_fresh_until_it_ages_out() {
        assert!(entry(Some(Instant::now())).is_fresh(Duration::from_secs(300)));
        assert!(!entry(Some(Instant::now())).is_fresh(Duration::ZERO));
    }
}
