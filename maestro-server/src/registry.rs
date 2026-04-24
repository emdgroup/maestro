use maestro_protocol::{AgentDistribution, AcpRegistry};

const REGISTRY_URL: &str =
    "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";

pub struct DiscoveredAgentWithSpawn {
    pub id: String,
    pub name: String,
    pub icon: String,
    pub spawn_cmd: String,
    pub spawn_args: Vec<String>,
    pub spawn_env: std::collections::HashMap<String, String>,
}

fn current_platform_key() -> &'static str {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    { return "darwin-aarch64"; }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    { return "darwin-x86_64"; }
    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    { return "linux-aarch64"; }
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    { return "linux-x86_64"; }
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

fn resolve_spawn(dist: &AgentDistribution) -> Option<(String, Vec<String>, std::collections::HashMap<String, String>)> {
    if let Some(npx) = &dist.npx {
        let mut args: Vec<String> = vec!["-y".to_string(), "--".to_string(), npx.package.clone()];
        if let Some(extra) = &npx.args {
            args.extend(extra.iter().cloned());
        }
        let env = npx.env.clone().unwrap_or_default();
        return Some(("npx".to_string(), args, env));
    }
    let key = current_platform_key();
    if !key.is_empty() {
        if let Some(bins) = &dist.binary {
            if let Some(target) = bins.get(key) {
                let mut args: Vec<String> = Vec::new();
                if let Some(extra) = &target.args {
                    args.extend(extra.iter().cloned());
                }
                return Some((target.cmd.clone(), args, Default::default()));
            }
        }
    }
    if let Some(uvx) = &dist.uvx {
        let mut args: Vec<String> = vec![uvx.package.clone()];
        if let Some(extra) = &uvx.args {
            args.extend(extra.iter().cloned());
        }
        return Some(("uvx".to_string(), args, Default::default()));
    }
    None
}

fn derive_check_cmd(dist: &AgentDistribution) -> Option<String> {
    if dist.npx.is_some() {
        return Some("npx".to_string());
    }
    let key = current_platform_key();
    if !key.is_empty() {
        if let Some(bins) = &dist.binary {
            if let Some(target) = bins.get(key) {
                return Some(target.cmd.clone());
            }
        }
    }
    if dist.uvx.is_some() {
        return Some("uvx".to_string());
    }
    None
}

async fn check_cmd_available(cmd: &str) -> bool {
    // POSIX `command -v` instead of `which` — `which` is not guaranteed on minimal SSH hosts
    tokio::process::Command::new("sh")
        .args(["-c", &format!("command -v {}", cmd)])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .await
        .map(|s| s.success())
        .unwrap_or(false)
}

pub async fn discover_agents() -> Result<Vec<DiscoveredAgentWithSpawn>, String> {
    let registry: AcpRegistry = reqwest::get(REGISTRY_URL)
        .await
        .map_err(|e| format!("Registry CDN unreachable: {}", e))?
        .error_for_status()
        .map_err(|e| format!("Registry CDN error: {}", e))?
        .json()
        .await
        .map_err(|e| format!("Registry JSON parse failed: {}", e))?;

    let mut result = Vec::new();
    for entry in &registry.agents {
        let Some(check_cmd) = derive_check_cmd(&entry.distribution) else {
            continue;
        };
        if !check_cmd_available(&check_cmd).await {
            continue;
        }
        let Some((spawn_cmd, spawn_args, spawn_env)) = resolve_spawn(&entry.distribution) else {
            continue;
        };
        result.push(DiscoveredAgentWithSpawn {
            id: entry.id.clone(),
            name: entry.name.clone(),
            icon: entry.icon.clone().unwrap_or_default(),
            spawn_cmd,
            spawn_args,
            spawn_env,
        });
    }
    Ok(result)
}
