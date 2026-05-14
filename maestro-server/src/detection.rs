use std::path::PathBuf;

use maestro_protocol::{
    DetectInstalledAgentsResponse, DetectProjectAgentsResponse, DetectedAgentInfo, ProjectAgentMarker,
};

struct AgentDetectionEntry {
    agent_id: &'static str,
    tool_name: &'static str,
    binary: Option<&'static str>,
    /// Relative to $HOME / %USERPROFILE%.
    config_dir: Option<&'static str>,
    project_markers: &'static [&'static str],
}

static DETECTION_TABLE: &[AgentDetectionEntry] = &[
    AgentDetectionEntry {
        agent_id: "claude-acp",
        tool_name: "Claude Code",
        binary: Some("claude"),
        config_dir: Some(".claude"),
        project_markers: &[".claude", "CLAUDE.md"],
    },
    AgentDetectionEntry {
        agent_id: "codex-acp",
        tool_name: "Codex",
        binary: Some("codex"),
        config_dir: Some(".codex"),
        project_markers: &[".codex", "AGENTS.md"],
    },
    AgentDetectionEntry {
        agent_id: "opencode",
        tool_name: "OpenCode",
        binary: Some("opencode"),
        config_dir: None,
        project_markers: &[".opencode", "opencode.json"],
    },
    AgentDetectionEntry {
        agent_id: "cursor",
        tool_name: "Cursor",
        binary: Some("cursor-agent"),
        config_dir: Some(".cursor"),
        project_markers: &[".cursor", ".cursorrules"],
    },
    AgentDetectionEntry {
        agent_id: "gemini",
        tool_name: "Gemini CLI",
        binary: Some("gemini"),
        config_dir: Some(".gemini"),
        project_markers: &[".gemini", "GEMINI.md"],
    },
    AgentDetectionEntry {
        agent_id: "goose",
        tool_name: "Goose",
        binary: Some("goose"),
        config_dir: None,
        project_markers: &[".goosehints"],
    },
    AgentDetectionEntry {
        agent_id: "github-copilot-cli",
        tool_name: "GitHub Copilot",
        binary: None,
        config_dir: Some(".config/github-copilot"),
        project_markers: &[".github/copilot-instructions.md"],
    },
    AgentDetectionEntry {
        agent_id: "cline",
        tool_name: "Cline",
        binary: Some("cline"),
        config_dir: None,
        project_markers: &[".clinerules", ".cline"],
    },
    AgentDetectionEntry {
        agent_id: "auggie",
        tool_name: "Augment Code",
        binary: Some("auggie"),
        config_dir: None,
        project_markers: &["augment-guidelines.md"],
    },
    AgentDetectionEntry {
        agent_id: "junie",
        tool_name: "Junie",
        binary: Some("junie"),
        config_dir: None,
        project_markers: &[],
    },
    AgentDetectionEntry {
        agent_id: "kilo",
        tool_name: "Kilo",
        binary: Some("kilo"),
        config_dir: None,
        project_markers: &[],
    },
    AgentDetectionEntry {
        agent_id: "kimi",
        tool_name: "Kimi",
        binary: Some("kimi"),
        config_dir: None,
        project_markers: &[],
    },
    AgentDetectionEntry {
        agent_id: "amp-acp",
        tool_name: "Amp",
        binary: Some("amp"),
        config_dir: Some(".amp"),
        project_markers: &[],
    },
    AgentDetectionEntry {
        agent_id: "mistral-vibe",
        tool_name: "Mistral Vibe",
        binary: Some("vibe"),
        config_dir: None,
        project_markers: &[],
    },
    AgentDetectionEntry {
        agent_id: "qwen-code",
        tool_name: "Qwen Code",
        binary: Some("qwen-code"),
        config_dir: None,
        project_markers: &[],
    },
    AgentDetectionEntry {
        agent_id: "crow-cli",
        tool_name: "Crow",
        binary: Some("crow-cli"),
        config_dir: None,
        project_markers: &[],
    },
    AgentDetectionEntry {
        agent_id: "stakpak",
        tool_name: "Stakpak",
        binary: Some("stakpak"),
        config_dir: None,
        project_markers: &[],
    },
    AgentDetectionEntry {
        agent_id: "corust-agent",
        tool_name: "Corust Agent",
        binary: Some("corust-agent-acp"),
        config_dir: None,
        project_markers: &[],
    },
    AgentDetectionEntry {
        agent_id: "autohand",
        tool_name: "Autohand Code",
        binary: Some("autohand"),
        config_dir: None,
        project_markers: &[],
    },
    AgentDetectionEntry {
        agent_id: "deepagents",
        tool_name: "DeepAgents",
        binary: Some("deepagents"),
        config_dir: None,
        project_markers: &[],
    },
    AgentDetectionEntry {
        agent_id: "factory-droid",
        tool_name: "Factory Droid",
        binary: Some("droid"),
        config_dir: None,
        project_markers: &[],
    },
    AgentDetectionEntry {
        agent_id: "fast-agent",
        tool_name: "fast-agent",
        binary: Some("fast-agent-mcp"),
        config_dir: None,
        project_markers: &[],
    },
    AgentDetectionEntry {
        agent_id: "nova",
        tool_name: "Nova",
        binary: Some("nova"),
        config_dir: None,
        project_markers: &[],
    },
    AgentDetectionEntry {
        agent_id: "pi-acp",
        tool_name: "pi",
        binary: Some("pi"),
        config_dir: None,
        project_markers: &[],
    },
    AgentDetectionEntry {
        agent_id: "qoder",
        tool_name: "Qoder CLI",
        binary: Some("qodercli"),
        config_dir: None,
        project_markers: &[],
    },
];

fn home_dir() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    let key = "USERPROFILE";
    #[cfg(not(target_os = "windows"))]
    let key = "HOME";
    std::env::var(key).ok().map(PathBuf::from)
}

/// Returns the set of agent IDs that have their tool installed on this host.
pub async fn detect_installed_agents() -> DetectInstalledAgentsResponse {
    let binaries: Vec<&'static str> = DETECTION_TABLE
        .iter()
        .filter_map(|e| e.binary)
        .collect();

    // Batch all `which` calls in one shell invocation to minimize fork overhead.
    let binary_results = batch_which(&binaries).await;

    let home = home_dir();

    let checks: Vec<_> = DETECTION_TABLE.iter().map(|entry| {
        let binary_result = entry.binary.map(|b| {
            binary_results.get(b).cloned().unwrap_or(None)
        });
        let config_dir = entry.config_dir.map(|d| {
            home.as_ref().map(|h| h.join(d))
        }).flatten();
        (entry, binary_result, config_dir)
    }).collect();

    let mut agents = Vec::new();
    for (entry, binary_result, config_dir_path) in checks {
        let (detected, binary_found, binary_path, config_dir_found) = if entry.binary.is_some() {
            // Binary defined: only check binary. Config dir is irrelevant even if it exists
            // (leftover config from a past install does not mean the tool is installed).
            let (found, path) = match binary_result {
                Some(Some(p)) => (true, Some(p)),
                _ => (false, None),
            };
            (found, found, path, false)
        } else if entry.config_dir.is_some() {
            // No known binary: fall back to config dir presence.
            let found = match config_dir_path {
                Some(path) => tokio::fs::metadata(&path).await.is_ok(),
                None => false,
            };
            (found, false, None, found)
        } else {
            // No detection criteria: treat as not installed.
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

    let all_checked_ids = DETECTION_TABLE.iter().map(|e| e.agent_id.to_string()).collect();
    DetectInstalledAgentsResponse { agents, all_checked_ids }
}

/// Returns agent IDs with project-level markers found in `cwd`.
pub async fn detect_project_agents(cwd: &str) -> DetectProjectAgentsResponse {
    let cwd_path = PathBuf::from(cwd);
    let mut agents = Vec::new();

    for entry in DETECTION_TABLE {
        if entry.project_markers.is_empty() {
            continue;
        }
        let mut markers_found = Vec::new();
        for marker in entry.project_markers {
            let path = cwd_path.join(marker);
            if tokio::fs::metadata(&path).await.is_ok() {
                markers_found.push(marker.to_string());
            }
        }
        if !markers_found.is_empty() {
            agents.push(ProjectAgentMarker {
                agent_id: entry.agent_id.to_string(),
                markers_found,
            });
        }
    }

    DetectProjectAgentsResponse { agents }
}

/// Run `which <binary>` for each binary in one shell call.
/// Returns a map of binary name → resolved path (None if not found).
async fn batch_which(binaries: &[&'static str]) -> std::collections::HashMap<&'static str, Option<String>> {
    let mut result = std::collections::HashMap::new();
    if binaries.is_empty() {
        return result;
    }

    // Run each `which` concurrently rather than one big shell command,
    // which avoids shell escaping issues and works on Windows too.
    let handles: Vec<_> = binaries
        .iter()
        .map(|binary| {
            let binary = *binary;
            tokio::spawn(async move {
                let output = tokio::process::Command::new("which")
                    .arg(binary)
                    .stdout(std::process::Stdio::piped())
                    .stderr(std::process::Stdio::null())
                    .output()
                    .await;
                let path = output.ok().filter(|o| o.status.success()).and_then(|o| {
                    String::from_utf8(o.stdout).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
                });
                (binary, path)
            })
        })
        .collect();

    for handle in futures::future::join_all(handles).await {
        if let Ok((binary, path)) = handle {
            result.insert(binary, path);
        }
    }
    result
}
