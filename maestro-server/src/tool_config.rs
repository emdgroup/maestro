use std::collections::BTreeMap;
use std::path::PathBuf;

use fs2::FileExt;
use serde::{Deserialize, Serialize};

#[derive(Default, Deserialize, Serialize)]
struct ToolConfig {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    tools: BTreeMap<String, String>,
}

pub(crate) fn home_dir() -> Result<PathBuf, String> {
    #[cfg(windows)]
    let home = std::env::var_os("USERPROFILE");
    #[cfg(not(windows))]
    let home = std::env::var_os("HOME");
    home.map(PathBuf::from)
        .ok_or_else(|| "Could not determine the target user's home directory".to_string())
}

fn config_path() -> Result<PathBuf, String> {
    Ok(home_dir()?.join(".maestro").join("tools.json"))
}

fn read() -> Result<ToolConfig, String> {
    let path = config_path()?;
    match std::fs::read_to_string(&path) {
        Ok(contents) => serde_json::from_str(&contents)
            .map_err(|error| format!("Invalid {}: {error}", path.display())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(ToolConfig::default()),
        Err(error) => Err(format!("Failed to read {}: {error}", path.display())),
    }
}

pub(crate) fn get(tool: &str) -> Result<Option<String>, String> {
    Ok(read()?.tools.get(tool).cloned())
}

pub(crate) fn set(tool: &str, value: Option<String>) -> Result<(), String> {
    let path = config_path()?;
    let parent = path
        .parent()
        .ok_or_else(|| "Invalid tool config path".to_string())?;
    std::fs::create_dir_all(parent)
        .map_err(|error| format!("Failed to create {}: {error}", parent.display()))?;
    let lock_path = parent.join("tools.lock");
    let lock = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(false)
        .open(&lock_path)
        .map_err(|error| format!("Failed to open {}: {error}", lock_path.display()))?;
    lock.lock_exclusive()
        .map_err(|error| format!("Failed to lock {}: {error}", lock_path.display()))?;

    let mut config = read()?;
    match value {
        Some(value) => {
            config.tools.insert(tool.to_string(), value);
        }
        None => {
            config.tools.remove(tool);
        }
    }
    config.version = 1;

    let temporary = path.with_extension(format!("json.tmp.{}", std::process::id()));
    let contents = serde_json::to_vec_pretty(&config)
        .map_err(|error| format!("Failed to serialize tool configuration: {error}"))?;
    std::fs::write(&temporary, contents)
        .map_err(|error| format!("Failed to write {}: {error}", temporary.display()))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&temporary, std::fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("Failed to secure {}: {error}", temporary.display()))?;
    }

    std::fs::rename(&temporary, &path)
        .map_err(|error| format!("Failed to replace {}: {error}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_config_is_empty() {
        let config = ToolConfig::default();
        assert!(config.tools.is_empty());
    }
}
