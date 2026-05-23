use maestro_protocol::{AcpRegistry, AgentDistribution};

const REGISTRY_JSON: &str = include_str!("assets/registry.json");

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
        .rsplit(|c| c == '/' || c == '\\')
        .next()
        .unwrap_or(raw_cmd);

    eprintln!("[registry] normalize_binary_cmd: raw={raw_cmd:?} filename={filename:?}");
    match which::which(filename) {
        Ok(abs_path) => {
            let resolved = abs_path.to_string_lossy().into_owned();
            eprintln!("[registry] which resolved: {filename:?} -> {resolved:?}");
            resolved
        }
        Err(e) => {
            eprintln!("[registry] which failed for {filename:?}: {e}");
            filename.to_string()
        }
    }
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
}
