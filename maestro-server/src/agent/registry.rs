use maestro_protocol::{AcpRegistry, AgentDistribution};

const REGISTRY_JSON: &str = include_str!("../assets/registry.json");

#[derive(Clone)]
pub struct DiscoveredAgentWithSpawn {
    pub id: String,
    pub name: String,
    pub icon: String,
    pub spawn_cmd: String,
    pub spawn_args: Vec<String>,
    pub spawn_env: std::collections::HashMap<String, String>,
    pub spawn_deps: Vec<String>,
}

const CLAUDE_AGENT_ID: &str = "claude-acp";
const OLLAMA_CLAUDE_AGENT_ID: &str = "ollama-claude-acp";

/// Create a Claude ACP profile that targets Ollama's Anthropic-compatible API.
///
/// The underlying ACP adapter remains identical to the regular Claude profile, but Ollama's
/// endpoint and gateway model discovery are supplied to the Claude Agent SDK at launch time.
/// This lets the existing ACP model selector show models exposed by the local Ollama server.
fn ollama_claude_agent(claude: &DiscoveredAgentWithSpawn) -> DiscoveredAgentWithSpawn {
    let mut spawn_env = claude.spawn_env.clone();
    spawn_env.extend([
        ("ANTHROPIC_AUTH_TOKEN".to_string(), "ollama".to_string()),
        ("ANTHROPIC_API_KEY".to_string(), String::new()),
        (
            "ANTHROPIC_BASE_URL".to_string(),
            "http://localhost:11434".to_string(),
        ),
        (
            "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY".to_string(),
            "1".to_string(),
        ),
    ]);

    DiscoveredAgentWithSpawn {
        id: OLLAMA_CLAUDE_AGENT_ID.to_string(),
        name: "Claude Code (Ollama)".to_string(),
        icon: claude.icon.clone(),
        spawn_cmd: claude.spawn_cmd.clone(),
        spawn_args: claude.spawn_args.clone(),
        spawn_env,
        spawn_deps: claude.spawn_deps.clone(),
    }
}

fn current_platform_key() -> &'static str {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    { return "darwin-aarch64"; }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    { return "darwin-x86_64"; }
    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    { return "linux-aarch64"; }
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    { "linux-x86_64"}
    #[cfg(all(target_os = "windows", target_arch = "aarch64"))]
    { return "windows-aarch64"; }
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    { return "windows-x86_64"; }
    #[cfg(not(any(
        all(target_os = "macos", target_arch = "aarch64"),
        all(target_os = "macos", target_arch = "x86_64"),
        all(target_os = "linux", target_arch = "aarch64"),
        all(target_os = "linux", target_arch = "x86_64"),
        all(target_os = "windows", target_arch = "aarch64"),
        all(target_os = "windows", target_arch = "x86_64"),
    )))]
    { return ""; }
}

/// Normalize a registry binary cmd to a PATH-resolvable command.
///
/// Registry JSON uses relative paths like "./opencode" or "./dist-package/cursor-agent"
/// designed for post-archive-extraction. Maestro expects binaries on PATH, so we extract
/// the filename and resolve to an absolute path via `which`.
fn normalize_binary_cmd(raw_cmd: &str) -> String {
    let filename = raw_cmd
        .rsplit(|c| c == '/' || c == '\\')
        .next()
        .unwrap_or(raw_cmd);
    which::which(filename)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| filename.to_string())
}

/// Returns (spawn_cmd, spawn_args, spawn_env, spawn_deps).
/// spawn_deps lists the tool(s) required to launch this agent (e.g. ["npx"] or ["uvx"]).
/// Binary agents have no external dep so spawn_deps is empty.
fn resolve_spawn(dist: &AgentDistribution) -> Option<(String, Vec<String>, std::collections::HashMap<String, String>, Vec<String>)> {
    if let Some(npx) = &dist.npx {
        let mut args: Vec<String> = vec!["-y".to_string(), "--".to_string(), npx.package.clone()];
        if let Some(extra) = &npx.args {
            args.extend(extra.iter().cloned());
        }
        let env = npx.env.clone().unwrap_or_default();
        // On Windows, npx is a .cmd batch file — CreateProcess can't find it without cmd.exe
        #[cfg(windows)]
        {
            let mut cmd_args = vec!["/c".to_string(), "npx".to_string()];
            cmd_args.extend(args);
            return Some(("cmd".to_string(), cmd_args, env, vec!["npx".to_string()]));
        }
        #[cfg(not(windows))]
        return Some(("npx".to_string(), args, env, vec!["npx".to_string()]));
    }
    let key = current_platform_key();
    if !key.is_empty() {
        if let Some(bins) = &dist.binary {
            if let Some(target) = bins.get(key) {
                let mut args: Vec<String> = Vec::new();
                if let Some(extra) = &target.args {
                    args.extend(extra.iter().cloned());
                }
                let cmd = normalize_binary_cmd(&target.cmd);
                return Some((cmd, args, Default::default(), vec![]));
            }
        }
    }
    if let Some(uvx) = &dist.uvx {
        let mut args: Vec<String> = vec![uvx.package.clone()];
        if let Some(extra) = &uvx.args {
            args.extend(extra.iter().cloned());
        }
        // On Windows, uvx is a .cmd batch file — CreateProcess can't find it without cmd.exe
        #[cfg(windows)]
        {
            let mut cmd_args = vec!["/c".to_string(), "uvx".to_string()];
            cmd_args.extend(args);
            return Some(("cmd".to_string(), cmd_args, Default::default(), vec!["uvx".to_string()]));
        }
        #[cfg(not(windows))]
        return Some(("uvx".to_string(), args, Default::default(), vec!["uvx".to_string()]));
    }
    None
}

pub fn load_registry() -> AcpRegistry {
    serde_json::from_str(REGISTRY_JSON).unwrap_or_else(|_| AcpRegistry {
        version: "0.0.0".to_string(),
        agents: Vec::new(),
    })
}

pub fn discover_agents(registry: &AcpRegistry) -> Vec<DiscoveredAgentWithSpawn> {
    let mut result = Vec::new();
    for entry in &registry.agents {
        let Some((spawn_cmd, spawn_args, spawn_env, spawn_deps)) = resolve_spawn(&entry.distribution) else {
            continue;
        };
        result.push(DiscoveredAgentWithSpawn {
            id: entry.id.clone(),
            name: entry.name.clone(),
            icon: entry.icon.clone().unwrap_or_default(),
            spawn_cmd,
            spawn_args,
            spawn_env,
            spawn_deps,
        });
    }

    if let Some(claude) = result.iter().find(|agent| agent.id == CLAUDE_AGENT_ID).cloned() {
        result.push(ollama_claude_agent(&claude));
    }

    result
}

#[cfg(test)]
mod tests {
    use super::*;

    // Test filename extraction only; which resolution depends on PATH in the test environment.
    fn extract_filename(raw_cmd: &str) -> &str {
        raw_cmd
            .rsplit(|c| c == '/' || c == '\\')
            .next()
            .unwrap_or(raw_cmd)
    }

    #[test]
    fn normalize_binary_cmd_extracts_filename() {
        let cases = [
            ("./opencode", "opencode"),
            ("./dist-package/cursor-agent", "cursor-agent"),
            ("./codex-acp", "codex-acp"),
            ("./goose", "goose"),
            ("./opencode.exe", "opencode.exe"),
            ("./goose-package\\goose.exe", "goose.exe"),
            ("./Applications/junie.app/Contents/MacOS/junie", "junie"),
            ("./junie-app/bin/junie", "junie"),
            ("amp-acp.exe", "amp-acp.exe"),
        ];
        for (input, expected) in cases {
            assert_eq!(extract_filename(input), expected, "input: {input:?}");
        }
    }

    #[test]
    fn ollama_claude_profile_uses_ollama_and_preserves_the_acp_adapter() {
        let claude = DiscoveredAgentWithSpawn {
            id: CLAUDE_AGENT_ID.to_string(),
            name: "Claude Agent".to_string(),
            icon: "claude.svg".to_string(),
            spawn_cmd: "npx".to_string(),
            spawn_args: vec!["-y".to_string(), "@agentclientprotocol/claude-agent-acp".to_string()],
            spawn_env: Default::default(),
            spawn_deps: vec!["npx".to_string()],
        };

        let ollama = ollama_claude_agent(&claude);

        assert_eq!(ollama.id, OLLAMA_CLAUDE_AGENT_ID);
        assert_eq!(ollama.name, "Claude Code (Ollama)");
        assert_eq!(ollama.spawn_cmd, claude.spawn_cmd);
        assert_eq!(ollama.spawn_args, claude.spawn_args);
        assert_eq!(ollama.spawn_deps, claude.spawn_deps);
        assert_eq!(ollama.spawn_env.get("ANTHROPIC_AUTH_TOKEN"), Some(&"ollama".to_string()));
        assert_eq!(ollama.spawn_env.get("ANTHROPIC_API_KEY"), Some(&String::new()));
        assert_eq!(ollama.spawn_env.get("ANTHROPIC_BASE_URL"), Some(&"http://localhost:11434".to_string()));
        assert_eq!(
            ollama.spawn_env.get("CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY"),
            Some(&"1".to_string())
        );
    }
}
