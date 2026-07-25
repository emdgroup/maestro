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
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(raw_cmd);
    which::which(filename)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| filename.to_string())
}

/// `(spawn_cmd, spawn_args, spawn_env, spawn_deps)`
type ResolvedSpawn = (String, Vec<String>, std::collections::HashMap<String, String>, Vec<String>);

/// spawn_deps lists the tool(s) required to launch this agent (e.g. ["npx"] or ["uvx"]).
/// Binary agents have no external dep so spawn_deps is empty.
fn resolve_spawn(dist: &AgentDistribution) -> Option<ResolvedSpawn> {
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
    result
}

#[cfg(test)]
mod tests {
    

    // Test filename extraction only; which resolution depends on PATH in the test environment.
    fn extract_filename(raw_cmd: &str) -> &str {
        raw_cmd
            .rsplit(['/', '\\'])
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

    /// The bundled registry is the only source of agent definitions, and `load_registry`
    /// falls back to an empty list rather than failing when it cannot be parsed — so a
    /// malformed file would surface as "no agents available" with nothing reporting why.
    /// This is also what makes the scheduled registry-update workflow a real check: a CDN
    /// payload that no longer matches `AcpRegistry` fails here instead of shipping.
    #[test]
    fn bundled_registry_parses_and_is_populated() {
        let registry = super::load_registry();

        assert!(
            !registry.agents.is_empty(),
            "bundled registry.json did not parse into any agents"
        );
        assert!(
            !registry.version.is_empty() && registry.version != "0.0.0",
            "registry version looks like the parse-failure fallback: {:?}",
            registry.version
        );

        for entry in &registry.agents {
            assert!(!entry.id.is_empty(), "agent entry has an empty id");
            assert!(!entry.name.is_empty(), "agent {:?} has an empty name", entry.id);
        }
    }

    /// Every bundled agent should yield a launch command on at least one platform. An entry
    /// that resolves nowhere is dead weight in the picker.
    #[test]
    fn bundled_registry_agents_are_launchable() {
        let registry = super::load_registry();
        let launchable = super::discover_agents(&registry);

        assert!(
            !launchable.is_empty(),
            "no agent in the bundled registry resolves to a spawn command on this platform"
        );
        for agent in &launchable {
            assert!(
                !agent.spawn_cmd.is_empty(),
                "agent {:?} resolved to an empty spawn command",
                agent.id
            );
        }
    }
}
