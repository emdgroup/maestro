use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Top-level ACP agent registry response.
/// Source: https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AcpRegistry {
    pub version: String,
    pub agents: Vec<AgentInfo>,
}

/// Metadata for a single ACP-compatible agent.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentInfo {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: Option<String>,
    pub repository: Option<String>,
    pub authors: Option<Vec<String>>,
    pub license: Option<String>,
    pub icon: Option<String>,
    pub website: Option<String>,
    pub distribution: AgentDistribution,
}

/// How an agent can be installed/launched.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AgentDistribution {
    pub npx: Option<NpxDistribution>,
    pub binary: Option<HashMap<String, BinaryTarget>>,
    pub uvx: Option<UvxDistribution>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NpxDistribution {
    pub package: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BinaryTarget {
    pub archive: String,
    pub cmd: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UvxDistribution {
    pub package: String,
}
