use maestro_protocol::{AcpRegistry, AgentDistribution, AgentRegistryEntry};

use crate::helpers::send_diag;

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
    /// Came from the user's `custom-agents.json` rather than the bundled registry. Detection has
    /// no entry for these, so they are reported as installed on the user's say-so.
    pub custom: bool,
}

fn current_platform_key() -> &'static str {
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
        "linux-x86_64"
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

/// Normalize a registry binary cmd to a PATH-resolvable command.
///
/// Registry JSON uses relative paths like "./opencode" or "./dist-package/cursor-agent"
/// designed for post-archive-extraction. Maestro expects binaries on PATH, so we extract
/// the filename and resolve to an absolute path via `which`.
///
/// An absolute path is taken as written: a `custom-agents.json` entry pointing at a binary
/// outside PATH means that exact file, and stripping it to a filename would either miss it or
/// silently launch a same-named binary from somewhere else.
fn normalize_binary_cmd(raw_cmd: &str) -> String {
    if std::path::Path::new(raw_cmd).is_absolute() {
        return raw_cmd.to_string();
    }
    let filename = raw_cmd.rsplit(['/', '\\']).next().unwrap_or(raw_cmd);
    which::which(filename)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| filename.to_string())
}

/// `(spawn_cmd, spawn_args, spawn_env, spawn_deps)`
type ResolvedSpawn = (
    String,
    Vec<String>,
    std::collections::HashMap<String, String>,
    Vec<String>,
);

/// spawn_deps lists the tool(s) required to launch this agent (e.g. ["npx"] or ["uvx"]).
/// Binary agents have no external dep so spawn_deps is empty.
fn resolve_spawn(dist: &AgentDistribution) -> Option<ResolvedSpawn> {
    if let Some(npx) = &dist.npx {
        let mut args: Vec<String> = vec!["-y".to_string(), "--".to_string(), npx.package.clone()];
        if let Some(extra) = &npx.args {
            args.extend(extra.iter().cloned());
        }
        let env = npx.env.clone().unwrap_or_default();
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
        return Some((
            "uvx".to_string(),
            args,
            Default::default(),
            vec!["uvx".to_string()],
        ));
    }
    None
}

pub fn load_registry() -> AcpRegistry {
    serde_json::from_str(REGISTRY_JSON).unwrap_or_else(|_| AcpRegistry {
        version: "0.0.0".to_string(),
        agents: Vec::new(),
    })
}

fn discover_agent(entry: &AgentRegistryEntry, custom: bool) -> Option<DiscoveredAgentWithSpawn> {
    let (spawn_cmd, spawn_args, spawn_env, spawn_deps) = resolve_spawn(&entry.distribution)?;
    Some(DiscoveredAgentWithSpawn {
        id: entry.id.clone(),
        name: entry.name.clone(),
        icon: entry.icon.clone().unwrap_or_default(),
        spawn_cmd,
        spawn_args,
        spawn_env,
        spawn_deps,
        custom,
    })
}

pub fn discover_agents(registry: &AcpRegistry) -> Vec<DiscoveredAgentWithSpawn> {
    registry
        .agents
        .iter()
        .filter_map(|entry| discover_agent(entry, false))
        .collect()
}

fn custom_agents_path() -> Result<std::path::PathBuf, String> {
    Ok(crate::tool_config::home_dir()?
        .join(".maestro")
        .join("custom-agents.json"))
}

fn read_custom_agents() -> Result<Vec<AgentRegistryEntry>, String> {
    #[derive(serde::Deserialize)]
    struct CustomAgents {
        #[serde(default)]
        agents: Vec<AgentRegistryEntry>,
    }

    let path = custom_agents_path()?;
    match std::fs::read_to_string(&path) {
        Ok(contents) => serde_json::from_str::<CustomAgents>(&contents)
            .map(|file| file.agents)
            .map_err(|error| format!("Invalid {}: {error}", path.display())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(format!("Failed to read {}: {error}", path.display())),
    }
}

/// Re-apply `~/.maestro/custom-agents.json` on top of the bundled agents.
///
/// Read on every agent listing rather than once at startup so an agent the user just added shows
/// up without restarting the app — the file is small and usually absent.
///
/// Custom entries are additive: an id that collides with a bundled agent is rejected rather than
/// shadowing it, so a typo cannot make a working agent disappear.
pub fn apply_custom_agents(agents: &mut Vec<DiscoveredAgentWithSpawn>) {
    match read_custom_agents() {
        Ok(custom) => merge_custom_agents(agents, &custom),
        Err(error) => send_diag("warn", format!("[registry] {error}")),
    }
}

fn merge_custom_agents(agents: &mut Vec<DiscoveredAgentWithSpawn>, custom: &[AgentRegistryEntry]) {
    agents.retain(|agent| !agent.custom);
    for entry in custom {
        if agents.iter().any(|agent| agent.id == entry.id) {
            send_diag(
                "warn",
                format!(
                    "[registry] custom agent {:?} ignored: that id is already a bundled agent",
                    entry.id
                ),
            );
            continue;
        }
        match discover_agent(entry, true) {
            Some(agent) => agents.push(agent),
            None => send_diag(
                "warn",
                format!(
                    "[registry] custom agent {:?} ignored: its distribution has no npx, uvx or {} binary entry",
                    entry.id,
                    current_platform_key()
                ),
            ),
        }
    }
}

#[cfg(test)]
mod tests {
    use maestro_protocol::{AgentDistribution, AgentRegistryEntry, NpxDistribution};

    fn custom_entry(id: &str, name: &str) -> AgentRegistryEntry {
        AgentRegistryEntry {
            id: id.to_string(),
            name: name.to_string(),
            version: String::new(),
            description: None,
            distribution: AgentDistribution {
                npx: Some(NpxDistribution {
                    package: "@zed-industries/claude-code-acp".to_string(),
                    args: None,
                    env: Some(
                        [("ANTHROPIC_BASE_URL".to_string(), "http://x".to_string())]
                            .into_iter()
                            .collect(),
                    ),
                }),
                binary: None,
                uvx: None,
            },
            repository: None,
            authors: None,
            license: None,
            icon: None,
            website: None,
        }
    }

    /// The overlay is re-read on every listing, so merging twice must not duplicate an agent, and
    /// an id colliding with a bundled agent must lose rather than shadow it — a typo there would
    /// otherwise replace a working agent with a broken one.
    #[test]
    fn merging_custom_agents_is_repeatable_and_never_shadows_a_bundled_agent() {
        let mut agents = super::discover_agents(&super::load_registry());
        let bundled_ids: Vec<String> = agents.iter().map(|agent| agent.id.clone()).collect();
        let collision = bundled_ids.first().cloned().expect("a bundled agent");
        let custom = vec![
            custom_entry("ollama-claude-acp", "Claude Code (Ollama)"),
            custom_entry(&collision, "Impostor"),
        ];

        super::merge_custom_agents(&mut agents, &custom);
        super::merge_custom_agents(&mut agents, &custom);

        let added: Vec<&super::DiscoveredAgentWithSpawn> =
            agents.iter().filter(|agent| agent.custom).collect();
        assert_eq!(added.len(), 1, "custom agents duplicated across merges");
        assert_eq!(added[0].id, "ollama-claude-acp");
        assert_eq!(
            added[0].spawn_env.get("ANTHROPIC_BASE_URL").map(String::as_str),
            Some("http://x")
        );
        assert_eq!(
            agents.iter().filter(|agent| agent.id == collision).count(),
            1,
            "custom entry shadowed the bundled agent it collided with"
        );

        super::merge_custom_agents(&mut agents, &[]);
        assert_eq!(
            agents.iter().map(|agent| agent.id.clone()).collect::<Vec<_>>(),
            bundled_ids,
            "removing the file must leave exactly the bundled agents"
        );
    }

    #[test]
    fn absolute_binary_cmd_is_kept_verbatim() {
        #[cfg(windows)]
        let path = r"C:\tools\my-agent.exe";
        #[cfg(not(windows))]
        let path = "/opt/tools/my-agent";
        assert_eq!(super::normalize_binary_cmd(path), path);
    }

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
            assert!(
                !entry.name.is_empty(),
                "agent {:?} has an empty name",
                entry.id
            );
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
