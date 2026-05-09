use std::path::PathBuf;
use std::time::Duration;

use maestro_protocol::{AcpRegistry, AgentDistribution};

const REGISTRY_URL: &str =
    "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";
const CACHE_MAX_AGE: Duration = Duration::from_secs(24 * 60 * 60);
const BACKUP_REGISTRY_JSON: &str = include_str!("assets/backup_registry.json");

#[derive(Clone)]
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

fn cache_file_path() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    let home = std::env::var("USERPROFILE").ok();
    #[cfg(not(target_os = "windows"))]
    let home = std::env::var("HOME").ok();

    let home = home?;
    let mut path = PathBuf::from(home);

    #[cfg(target_os = "macos")]
    {
        path.push("Library");
        path.push("Caches");
    }
    #[cfg(target_os = "windows")]
    {
        path.push("AppData");
        path.push("Local");
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        if let Ok(xdg) = std::env::var("XDG_CACHE_HOME") {
            path = PathBuf::from(xdg);
        } else {
            path.push(".cache");
        }
    }

    path.push("maestro");
    path.push("registry.json");
    Some(path)
}

fn read_cached_registry(path: &std::path::Path) -> Option<(AcpRegistry, bool)> {
    let metadata = std::fs::metadata(path).ok()?;
    let modified = metadata.modified().ok()?;
    let age = modified.elapsed().ok()?;
    let fresh = age < CACHE_MAX_AGE;
    let content = std::fs::read_to_string(path).ok()?;
    let registry: AcpRegistry = serde_json::from_str(&content).ok()?;
    Some((registry, fresh))
}

fn write_cache_file(path: &std::path::Path, registry: &AcpRegistry) {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(json) = serde_json::to_string_pretty(registry) {
        let _ = std::fs::write(path, json);
    }
}

fn fetch_from_cdn() -> Result<AcpRegistry, String> {
    let config = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(5)))
        .build();
    let agent = ureq::Agent::new_with_config(config);
    agent
        .get(REGISTRY_URL)
        .call()
        .map_err(|e| format!("Registry CDN unreachable: {e}"))?
        .body_mut()
        .read_json::<AcpRegistry>()
        .map_err(|e| format!("Registry JSON parse failed: {e}"))
}

pub fn parse_backup_registry() -> AcpRegistry {
    serde_json::from_str(BACKUP_REGISTRY_JSON).unwrap_or_else(|_| AcpRegistry {
        version: "0.0.0".to_string(),
        agents: Vec::new(),
    })
}

pub fn load_registry() -> AcpRegistry {
    let cache_path = cache_file_path();
    let stale_cache = if let Some(ref path) = cache_path {
        match read_cached_registry(path) {
            Some((registry, true)) => return registry,
            Some((registry, false)) => Some(registry),
            None => None,
        }
    } else {
        None
    };

    match fetch_from_cdn() {
        Ok(registry) => {
            if let Some(ref path) = cache_path {
                write_cache_file(path, &registry);
            }
            registry
        }
        Err(_) => {
            if let Some(registry) = stale_cache {
                return registry;
            }
            parse_backup_registry()
        }
    }
}

pub async fn discover_agents(registry: &AcpRegistry) -> Vec<DiscoveredAgentWithSpawn> {
    let mut result = Vec::new();
    for entry in &registry.agents {
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
    result
}
