use crate::ssh::RemoteSshSession;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::HashMap;
use std::time::{Duration, Instant};

const REGISTRY_URL: &str =
    "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";

/// Top-level ACP agent registry response.
/// Source: https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct AcpRegistry {
    pub version: String,
    pub agents: Vec<AgentInfo>,
}

/// Metadata for a single ACP-compatible agent.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct AgentInfo {
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(default)]
    #[specta(optional)]
    pub description: Option<String>,
    #[serde(default)]
    #[specta(optional)]
    pub repository: Option<String>,
    #[serde(default)]
    #[specta(optional)]
    pub authors: Option<Vec<String>>,
    #[serde(default)]
    #[specta(optional)]
    pub license: Option<String>,
    #[serde(default)]
    #[specta(optional)]
    pub icon: Option<String>,
    #[serde(default)]
    #[specta(optional)]
    pub website: Option<String>,
    pub distribution: AgentDistribution,
}

/// How an agent can be installed/launched.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Default)]
#[specta(export)]
pub struct AgentDistribution {
    #[serde(default)]
    #[specta(optional)]
    pub npx: Option<NpxDistribution>,
    #[serde(default)]
    #[specta(optional)]
    pub binary: Option<HashMap<String, BinaryTarget>>,
    #[serde(default)]
    #[specta(optional)]
    pub uvx: Option<UvxDistribution>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct NpxDistribution {
    pub package: String,
    #[serde(default)]
    #[specta(optional)]
    pub args: Option<Vec<String>>,
    #[serde(default)]
    #[specta(optional)]
    pub env: Option<HashMap<String, String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct BinaryTarget {
    pub archive: String,
    pub cmd: String,
    #[serde(default)]
    #[specta(optional)]
    pub args: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct UvxDistribution {
    pub package: String,
    #[serde(default)]
    #[specta(optional)]
    pub args: Option<Vec<String>>,
}

/// Remote availability check result for an SSH-connected project.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct RemoteAgentStatus {
    pub maestro_server_available: bool,
    pub available_agent_ids: Vec<String>,
}

/// Returns the command name to `which` on a remote Linux host for a given agent.
fn resolve_remote_check_command(agent: &AgentInfo) -> Option<String> {
    if let Some(binary_map) = &agent.distribution.binary {
        for (key, target) in binary_map {
            if key.contains("linux") {
                return Some(target.cmd.clone());
            }
        }
    }
    if agent.distribution.npx.is_some() {
        return Some("npx".to_string());
    }
    if agent.distribution.uvx.is_some() {
        return Some("uvx".to_string());
    }
    None
}

/// Returns true if the agent's launch command is available on the remote SSH host.
pub async fn check_agent_on_remote(agent: &AgentInfo, ssh: &RemoteSshSession) -> bool {
    if let Some(cmd) = resolve_remote_check_command(agent) {
        ssh.execute_command(&format!("which {} 2>/dev/null", cmd))
            .await
            .is_ok()
    } else {
        false
    }
}

/// Cache entry for the in-memory registry TTL cache. Internal only — not exported to TS.
pub struct RegistryCacheEntry {
    pub registry: AcpRegistry,
    pub fetched_at: Instant,
}

/// IPC response wrapper giving frontend cache status context.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct RegistryResponse {
    pub agents: Vec<AgentInfo>,
    pub cached: bool,
    pub stale: bool,
}

/// Resolved launch command ready for subprocess spawn.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct ResolvedLaunchCommand {
    pub cmd: String,
    pub args: Vec<String>,
}

async fn fetch_registry_from_cdn() -> Result<AcpRegistry, String> {
    let client = reqwest::Client::new();
    let registry: AcpRegistry = client
        .get(REGISTRY_URL)
        .send()
        .await
        .map_err(|e| format!("Registry CDN unreachable: {}", e))?
        .error_for_status()
        .map_err(|e| format!("Registry CDN returned error: {}", e))?
        .json::<AcpRegistry>()
        .await
        .map_err(|e| format!("Registry JSON parse failed: {}", e))?;
    Ok(registry)
}

/// Fetch the agent registry, using a 5-minute in-memory TTL cache.
///
/// - Returns cached data if fresh (within 5 minutes) and `force_refresh` is false.
/// - Fetches from CDN otherwise, updating the cache on success.
/// - On CDN failure, returns stale cache data if available (stale=true).
/// - On CDN failure with no cache, returns Err.
pub async fn fetch_or_return_cached(
    cache: &tokio::sync::Mutex<Option<RegistryCacheEntry>>,
    force_refresh: bool,
) -> Result<RegistryResponse, String> {
    // Phase 1: Check cache under lock, then drop guard before network I/O
    let cached_snapshot = {
        let guard = cache.lock().await;
        guard.as_ref().map(|entry| {
            let is_fresh =
                !force_refresh && entry.fetched_at.elapsed() < Duration::from_secs(300);
            (entry.registry.clone(), is_fresh)
        })
    };
    // guard is dropped here

    // If cache is fresh, return immediately
    if let Some((registry, true)) = &cached_snapshot {
        return Ok(RegistryResponse {
            agents: registry.agents.clone(),
            cached: true,
            stale: false,
        });
    }

    // Phase 2: Fetch from CDN (no lock held)
    match fetch_registry_from_cdn().await {
        Ok(registry) => {
            // Phase 3: Write new data to cache under lock
            let mut guard = cache.lock().await;
            *guard = Some(RegistryCacheEntry {
                registry: registry.clone(),
                fetched_at: Instant::now(),
            });
            Ok(RegistryResponse {
                agents: registry.agents,
                cached: false,
                stale: false,
            })
        }
        Err(e) => {
            // CDN failed: return stale cache if available, otherwise propagate error
            if let Some((registry, _)) = cached_snapshot {
                Ok(RegistryResponse {
                    agents: registry.agents,
                    cached: true,
                    stale: true,
                })
            } else {
                Err(format!("Failed to fetch registry: {}", e))
            }
        }
    }
}

/// Select the binary target key for the current compile-time platform/arch.
fn current_binary_target_key() -> &'static str {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        return "darwin-aarch64";
    }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        return "darwin-x86_64";
    }
    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    {
        return "linux-aarch64";
    }
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        return "linux-x86_64";
    }
    #[cfg(all(target_os = "windows", target_arch = "aarch64"))]
    {
        return "windows-aarch64";
    }
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    {
        return "windows-x86_64";
    }
    #[cfg(not(any(
        all(target_os = "macos", target_arch = "aarch64"),
        all(target_os = "macos", target_arch = "x86_64"),
        all(target_os = "linux", target_arch = "aarch64"),
        all(target_os = "linux", target_arch = "x86_64"),
        all(target_os = "windows", target_arch = "aarch64"),
        all(target_os = "windows", target_arch = "x86_64"),
    )))]
    {
        return "";
    }
}

/// Resolve the best available launch command for an agent distribution.
///
/// Priority order: npx -> binary (current platform) -> uvx
/// Returns None if no compatible distribution exists.
pub fn resolve_distribution(dist: &AgentDistribution) -> Option<ResolvedLaunchCommand> {
    // 1. npx (preferred)
    if let Some(npx) = &dist.npx {
        let mut args = vec![npx.package.clone()];
        if let Some(extra_args) = &npx.args {
            args.extend(extra_args.iter().cloned());
        }
        return Some(ResolvedLaunchCommand {
            cmd: "npx".to_string(),
            args,
        });
    }
    // 2. binary (compile-time target key)
    if let Some(binary_map) = &dist.binary {
        let key = current_binary_target_key();
        if !key.is_empty() {
            if let Some(target) = binary_map.get(key) {
                let mut args = Vec::new();
                if let Some(extra_args) = &target.args {
                    args.extend(extra_args.iter().cloned());
                }
                return Some(ResolvedLaunchCommand {
                    cmd: target.cmd.clone(),
                    args,
                });
            }
        }
    }
    // 3. uvx (last resort)
    if let Some(uvx) = &dist.uvx {
        let mut args = vec![uvx.package.clone()];
        if let Some(extra_args) = &uvx.args {
            args.extend(extra_args.iter().cloned());
        }
        return Some(ResolvedLaunchCommand {
            cmd: "uvx".to_string(),
            args,
        });
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_registry_deserialization() {
        let json = r#"{
            "version": "1.0.0",
            "agents": [
                {
                    "id": "claude-code",
                    "name": "Claude Code",
                    "version": "1.0.0",
                    "distribution": {
                        "npx": {
                            "package": "@anthropic-ai/claude-code",
                            "args": ["--acp"]
                        }
                    }
                },
                {
                    "id": "my-binary-agent",
                    "name": "Binary Agent",
                    "version": "2.0.0",
                    "distribution": {
                        "binary": {
                            "linux-x86_64": {
                                "archive": "https://example.com/agent-linux-x86_64.tar.gz",
                                "cmd": "/usr/local/bin/agent"
                            }
                        }
                    }
                },
                {
                    "id": "uvx-agent",
                    "name": "Uvx Agent",
                    "version": "0.1.0",
                    "distribution": {
                        "uvx": {
                            "package": "my-uvx-agent"
                        }
                    }
                }
            ]
        }"#;

        let registry: AcpRegistry = serde_json::from_str(json).expect("Failed to deserialize registry");
        assert_eq!(registry.agents.len(), 3);

        // Verify npx agent has args
        let npx_agent = &registry.agents[0];
        assert_eq!(npx_agent.id, "claude-code");
        let npx = npx_agent.distribution.npx.as_ref().expect("npx missing");
        assert_eq!(npx.args, Some(vec!["--acp".to_string()]));
    }

    #[test]
    fn test_resolve_npx_distribution() {
        let dist = AgentDistribution {
            npx: Some(NpxDistribution {
                package: "@anthropic-ai/claude-code".to_string(),
                args: Some(vec!["--acp".to_string()]),
                env: None,
            }),
            binary: None,
            uvx: None,
        };

        let result = resolve_distribution(&dist).expect("Expected Some result");
        assert_eq!(result.cmd, "npx");
        assert_eq!(
            result.args,
            vec!["@anthropic-ai/claude-code".to_string(), "--acp".to_string()]
        );
    }

    #[test]
    fn test_resolve_binary_distribution() {
        let platform_key = current_binary_target_key();
        if platform_key.is_empty() {
            // Skip on unsupported platforms
            return;
        }

        let mut binary_map = HashMap::new();
        binary_map.insert(
            platform_key.to_string(),
            BinaryTarget {
                archive: "https://example.com/agent.tar.gz".to_string(),
                cmd: "/usr/local/bin/my-agent".to_string(),
                args: None,
            },
        );

        let dist = AgentDistribution {
            npx: None,
            binary: Some(binary_map),
            uvx: None,
        };

        let result = resolve_distribution(&dist).expect("Expected Some result");
        assert_eq!(result.cmd, "/usr/local/bin/my-agent");
        assert!(result.args.is_empty());
    }

    #[test]
    fn test_resolve_uvx_distribution() {
        let dist = AgentDistribution {
            npx: None,
            binary: None,
            uvx: Some(UvxDistribution {
                package: "my-uvx-package".to_string(),
                args: None,
            }),
        };

        let result = resolve_distribution(&dist).expect("Expected Some result");
        assert_eq!(result.cmd, "uvx");
        assert_eq!(result.args, vec!["my-uvx-package".to_string()]);
    }

    #[test]
    fn test_resolve_npx_priority_over_binary() {
        let platform_key = current_binary_target_key();
        let mut binary_map = HashMap::new();
        binary_map.insert(
            if platform_key.is_empty() {
                "linux-x86_64".to_string()
            } else {
                platform_key.to_string()
            },
            BinaryTarget {
                archive: "https://example.com/agent.tar.gz".to_string(),
                cmd: "/usr/local/bin/binary-agent".to_string(),
                args: None,
            },
        );

        let dist = AgentDistribution {
            npx: Some(NpxDistribution {
                package: "@org/npx-agent".to_string(),
                args: None,
                env: None,
            }),
            binary: Some(binary_map),
            uvx: None,
        };

        let result = resolve_distribution(&dist).expect("Expected Some result");
        // npx must win over binary
        assert_eq!(result.cmd, "npx");
        assert_eq!(result.args, vec!["@org/npx-agent".to_string()]);
    }

    #[test]
    fn test_resolve_no_compatible_distribution() {
        let dist = AgentDistribution::default();
        let result = resolve_distribution(&dist);
        assert!(result.is_none());
    }

    #[test]
    fn test_resolve_binary_unknown_platform() {
        let mut binary_map = HashMap::new();
        binary_map.insert(
            "plan9-mips64".to_string(),
            BinaryTarget {
                archive: "https://example.com/agent-plan9.tar.gz".to_string(),
                cmd: "/bin/agent".to_string(),
                args: None,
            },
        );

        let dist = AgentDistribution {
            npx: None,
            binary: Some(binary_map),
            uvx: None,
        };

        // The current platform key will not match "plan9-mips64",
        // so resolve_distribution must return None.
        let result = resolve_distribution(&dist);
        assert!(result.is_none());
    }
}
