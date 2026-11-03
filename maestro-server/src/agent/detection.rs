use std::path::{Path, PathBuf};

use maestro_protocol::{DetectInstalledAgentsResponse, DetectedAgentInfo};

struct AgentDetectionEntry {
    agent_id: &'static str,
    tool_name: &'static str,
    binary: Option<&'static str>,
    /// Relative to $HOME / %USERPROFILE%.
    config_dir: Option<&'static str>,
}

static DETECTION_TABLE: &[AgentDetectionEntry] = &[
    AgentDetectionEntry {
        agent_id: "claude-acp",
        tool_name: "Claude Code",
        binary: Some("claude"),
        config_dir: Some(".claude"),
    },
    AgentDetectionEntry {
        agent_id: "codex-acp",
        tool_name: "Codex",
        binary: Some("codex"),
        config_dir: Some(".codex"),
    },
    AgentDetectionEntry {
        agent_id: "opencode",
        tool_name: "OpenCode",
        binary: Some("opencode"),
        config_dir: None,
    },
    AgentDetectionEntry {
        agent_id: "cursor",
        tool_name: "Cursor",
        binary: Some("cursor-agent"),
        config_dir: Some(".cursor"),
    },
    AgentDetectionEntry {
        agent_id: "gemini",
        tool_name: "Gemini CLI",
        binary: Some("gemini"),
        config_dir: Some(".gemini"),
    },
    AgentDetectionEntry {
        agent_id: "goose",
        tool_name: "Goose",
        binary: Some("goose"),
        config_dir: None,
    },
    AgentDetectionEntry {
        agent_id: "github-copilot-cli",
        tool_name: "GitHub Copilot",
        binary: None,
        config_dir: Some(".config/github-copilot"),
    },
    AgentDetectionEntry {
        agent_id: "cline",
        tool_name: "Cline",
        binary: Some("cline"),
        config_dir: None,
    },
    AgentDetectionEntry {
        agent_id: "auggie",
        tool_name: "Augment Code",
        binary: Some("auggie"),
        config_dir: None,
    },
    AgentDetectionEntry {
        agent_id: "junie",
        tool_name: "Junie",
        binary: Some("junie"),
        config_dir: None,
    },
    AgentDetectionEntry {
        agent_id: "kilo",
        tool_name: "Kilo",
        binary: Some("kilo"),
        config_dir: None,
    },
    AgentDetectionEntry {
        agent_id: "kimi",
        tool_name: "Kimi",
        binary: Some("kimi"),
        config_dir: None,
    },
    AgentDetectionEntry {
        agent_id: "amp-acp",
        tool_name: "Amp",
        binary: Some("amp"),
        config_dir: Some(".amp"),
    },
    AgentDetectionEntry {
        agent_id: "mistral-vibe",
        tool_name: "Mistral Vibe",
        binary: Some("vibe"),
        config_dir: None,
    },
    AgentDetectionEntry {
        agent_id: "qwen-code",
        tool_name: "Qwen Code",
        binary: Some("qwen-code"),
        config_dir: None,
    },
    AgentDetectionEntry {
        agent_id: "crow-cli",
        tool_name: "Crow",
        binary: Some("crow-cli"),
        config_dir: None,
    },
    AgentDetectionEntry {
        agent_id: "stakpak",
        tool_name: "Stakpak",
        binary: Some("stakpak"),
        config_dir: None,
    },
    AgentDetectionEntry {
        agent_id: "corust-agent",
        tool_name: "Corust Agent",
        binary: Some("corust-agent-acp"),
        config_dir: None,
    },
    AgentDetectionEntry {
        agent_id: "autohand",
        tool_name: "Autohand Code",
        binary: Some("autohand"),
        config_dir: None,
    },
    AgentDetectionEntry {
        agent_id: "deepagents",
        tool_name: "DeepAgents",
        binary: Some("deepagents"),
        config_dir: None,
    },
    AgentDetectionEntry {
        agent_id: "factory-droid",
        tool_name: "Factory Droid",
        binary: Some("droid"),
        config_dir: None,
    },
    AgentDetectionEntry {
        agent_id: "fast-agent",
        tool_name: "fast-agent",
        binary: Some("fast-agent-mcp"),
        config_dir: None,
    },
    AgentDetectionEntry {
        agent_id: "nova",
        tool_name: "Nova",
        binary: Some("nova"),
        config_dir: None,
    },
    AgentDetectionEntry {
        agent_id: "pi-acp",
        tool_name: "pi",
        binary: Some("pi"),
        config_dir: None,
    },
    AgentDetectionEntry {
        agent_id: "qoder",
        tool_name: "Qoder CLI",
        binary: Some("qodercli"),
        config_dir: None,
    },
];

/// Returns the set of agent IDs that have their tool installed on this host.
pub async fn detect_installed_agents() -> DetectInstalledAgentsResponse {
    let binaries: Vec<&'static str> = DETECTION_TABLE.iter().filter_map(|e| e.binary).collect();

    // Batch all `which` calls in one shell invocation to minimize fork overhead.
    let binary_results = batch_which(&binaries).await;

    let home = maestro_protocol::paths::home_dir().ok();

    let checks: Vec<_> = DETECTION_TABLE
        .iter()
        .map(|entry| {
            let binary_result = entry
                .binary
                .map(|b| binary_results.get(b).cloned().unwrap_or(None));
            let config_dir = entry
                .config_dir
                .and_then(|d| home.as_ref().map(|h| h.join(d)));
            (entry, binary_result, config_dir)
        })
        .collect();

    let mut agents = Vec::new();
    for (entry, binary_result, config_dir_path) in checks {
        let (detected, binary_found, binary_path, config_dir_found) = if entry.binary.is_some() {
            let (found, path) = match binary_result {
                Some(Some(p)) => (true, Some(p)),
                _ => (false, None),
            };
            (found, found, path, false)
        } else if entry.config_dir.is_some() {
            let found = match config_dir_path {
                Some(path) => tokio::fs::metadata(&path).await.is_ok(),
                None => false,
            };
            (found, false, None, found)
        } else {
            (false, false, None, false)
        };

        if detected {
            agents.push(DetectedAgentInfo {
                agent_id: entry.agent_id.to_string(),
                tool_name: entry.tool_name.to_string(),
                binary_found,
                binary_path,
                config_dir_found,
            });
        }
    }

    let all_checked_ids = DETECTION_TABLE
        .iter()
        .map(|e| e.agent_id.to_string())
        .collect();
    DetectInstalledAgentsResponse {
        agents,
        all_checked_ids,
    }
}

/// Resolve each binary to its absolute path.
/// Checks PATH first, then well-known installation directories.
/// Returns a map of binary name → resolved path (None if not found).
async fn batch_which(
    binaries: &[&'static str],
) -> std::collections::HashMap<&'static str, Option<String>> {
    let mut result = std::collections::HashMap::new();
    if binaries.is_empty() {
        return result;
    }

    let home = maestro_protocol::paths::home_dir().ok();

    let handles: Vec<_> = binaries
        .iter()
        .map(|binary| {
            let binary = *binary;
            let home = home.clone();
            tokio::spawn(async move {
                // Try PATH-based resolution first
                if let Ok(p) = which::which(binary) {
                    return (binary, Some(p.to_string_lossy().to_string()));
                }

                // Fall back to well-known installation directories
                if let Some(ref home) = home {
                    let candidates = extra_binary_candidates(home, binary);
                    for candidate in candidates {
                        if candidate.exists() {
                            return (binary, Some(candidate.to_string_lossy().to_string()));
                        }
                    }
                }

                (binary, None)
            })
        })
        .collect();

    for (binary, path) in futures::future::join_all(handles)
        .await
        .into_iter()
        .flatten()
    {
        result.insert(binary, path);
    }
    result
}

/// Well-known binary install locations not always on PATH.
fn extra_binary_candidates(home: &Path, binary: &str) -> Vec<PathBuf> {
    #[cfg(not(windows))]
    {
        vec![
            home.join(".local/bin").join(binary),
            PathBuf::from("/usr/local/bin").join(binary),
        ]
    }
    #[cfg(windows)]
    {
        let exe = format!("{}.exe", binary);
        let cmd = format!("{}.cmd", binary);
        vec![
            home.join(".local\\bin").join(&exe),
            home.join("AppData\\Local\\Programs").join(&exe),
            home.join("AppData\\Roaming\\npm").join(&cmd),
            home.join("AppData\\Roaming\\npm").join(&exe),
        ]
    }
}
