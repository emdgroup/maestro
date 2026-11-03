use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::helpers::send_diag;

const REGISTRY_JSON: &str = include_str!("../assets/registry.json");

// The ACP agent registry's schema, as the bundled registry and `custom-agents.json` are written.

// --- CDN registry types — used by maestro-server for agent discovery ---

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AcpRegistry {
    pub version: String,
    pub agents: Vec<AgentRegistryEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AgentRegistryEntry {
    pub id: String,
    pub name: String,
    /// Absent in hand-written `custom-agents.json` entries; the CDN registry always sets it.
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub description: Option<String>,
    pub distribution: AgentDistribution,
    #[serde(default)]
    pub repository: Option<String>,
    #[serde(default)]
    pub authors: Option<Vec<String>>,
    #[serde(default)]
    pub license: Option<String>,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub website: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct AgentDistribution {
    #[serde(default)]
    pub npx: Option<NpxDistribution>,
    #[serde(default)]
    pub binary: Option<HashMap<String, BinaryTarget>>,
    #[serde(default)]
    pub uvx: Option<UvxDistribution>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NpxDistribution {
    pub package: String,
    #[serde(default)]
    pub args: Option<Vec<String>>,
    #[serde(default)]
    pub env: Option<HashMap<String, String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BinaryTarget {
    /// Where the CDN registry says the binary can be downloaded. Maestro never fetches it — it
    /// spawns what is already on the host — so a hand-written entry can leave it out.
    #[serde(default)]
    pub archive: Option<String>,
    pub cmd: String,
    #[serde(default)]
    pub args: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct UvxDistribution {
    pub package: String,
    #[serde(default)]
    pub args: Option<Vec<String>>,
}

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

/// Exactly one of these blocks survives `cfg`, and it is then the function's tail expression — so
/// none of them may use `return`, or `clippy::needless_return` fails the build on that platform.
/// CI only runs Linux, which is why the Linux arm was the one already written this way.
fn current_platform_key() -> &'static str {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        "darwin-aarch64"
    }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        "darwin-x86_64"
    }
    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    {
        "linux-aarch64"
    }
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        "linux-x86_64"
    }
    #[cfg(all(target_os = "windows", target_arch = "aarch64"))]
    {
        "windows-aarch64"
    }
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    {
        "windows-x86_64"
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
        ""
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
    Ok(maestro_protocol::paths::maestro_home()?.join("custom-agents.json"))
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
    use super::{AgentDistribution, AgentRegistryEntry, NpxDistribution};

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
            added[0]
                .spawn_env
                .get("ANTHROPIC_BASE_URL")
                .map(String::as_str),
            Some("http://x")
        );
        assert_eq!(
            agents.iter().filter(|agent| agent.id == collision).count(),
            1,
            "custom entry shadowed the bundled agent it collided with"
        );

        super::merge_custom_agents(&mut agents, &[]);
        assert_eq!(
            agents
                .iter()
                .map(|agent| agent.id.clone())
                .collect::<Vec<_>>(),
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
        raw_cmd.rsplit(['/', '\\']).next().unwrap_or(raw_cmd)
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

    #[derive(serde::Deserialize)]
    struct CustomAgentsFile {
        agents: Vec<AgentRegistryEntry>,
    }

    /// The `maestro-custom-agents` skill teaches the user's agent to hand-write
    /// `~/.maestro/custom-agents.json`, so its examples are the only specification of that file
    /// anyone reads. A registry schema change that leaves them behind produces entries
    /// maestro-server silently drops, on the user's machine, with nothing pointing back here.
    #[test]
    fn the_custom_agents_skill_documents_entries_that_still_parse() {
        // The app bundles the skill; this crate is the one that parses what it teaches.
        let skill = include_str!("../../../src-tauri/assets/skills/maestro-custom-agents/SKILL.md");

        let examples: Vec<&str> = skill
            .split("```json")
            .skip(1)
            .filter_map(|rest| rest.split("```").next())
            .collect();
        assert_eq!(examples.len(), 2, "expected the schema and Ollama examples");

        for example in examples {
            let parsed: CustomAgentsFile = serde_json::from_str(example)
                .unwrap_or_else(|error| panic!("example does not parse: {error}\n{example}"));
            for entry in &parsed.agents {
                assert!(!entry.id.is_empty());
                assert!(
                    entry.distribution.npx.is_some()
                        || entry.distribution.uvx.is_some()
                        || entry.distribution.binary.is_some(),
                    "example agent {:?} has no launch method",
                    entry.id
                );
            }
        }
    }
}
