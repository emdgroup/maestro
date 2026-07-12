use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type)]
#[specta(export)]
pub enum ContainerCli {
    Docker,
    Podman,
    Nerdctl,
}

impl ContainerCli {
    pub fn binary(&self) -> &'static str {
        match self {
            Self::Docker => "docker",
            Self::Podman => "podman",
            Self::Nerdctl => "nerdctl",
        }
    }

    pub fn detect() -> Result<Self, String> {
        for cli in [Self::Docker, Self::Podman, Self::Nerdctl] {
            if which_exists(cli.binary()) {
                return Ok(cli);
            }
        }
        Err("No container CLI found (tried docker, podman, nerdctl)".to_string())
    }
}

fn which_exists(binary: &str) -> bool {
    std::process::Command::new("which")
        .arg(binary)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct DockerConnection {
    pub id: i32,
    pub container_name: String,
    pub image_name: Option<String>,
    pub display_name: Option<String>,
    pub last_used_at: String,
    pub created_at: String,
}

impl DockerConnection {
    pub fn from_row(row: &rusqlite::Row) -> rusqlite::Result<Self> {
        Ok(DockerConnection {
            id: row.get(0)?,
            container_name: row.get(1)?,
            image_name: row.get(2)?,
            display_name: row.get(3)?,
            last_used_at: row.get(4)?,
            created_at: row.get(5)?,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub enum DockerContainerState {
    Running,
    Stopped,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct DockerContainer {
    pub id: String,
    pub name: String,
    pub image: String,
    pub state: DockerContainerState,
}

/// Parse container list output from `<cli> ps --all --format json`.
/// Docker emits NDJSON (one JSON object per line); Podman/nerdctl emit a JSON array.
fn parse_container_list(output: &str) -> Vec<DockerContainer> {
    let trimmed = output.trim();
    if trimmed.is_empty() {
        return vec![];
    }

    // Try JSON array first (Podman/nerdctl)
    if let Ok(items) = serde_json::from_str::<Vec<serde_json::Value>>(trimmed) {
        return items.iter().filter_map(parse_container_entry).collect();
    }

    // Fall back to NDJSON (Docker)
    trimmed.lines()
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
        .filter_map(|v| parse_container_entry(&v))
        .collect()
}

fn parse_container_entry(v: &serde_json::Value) -> Option<DockerContainer> {
    // Docker uses "ID", podman/nerdctl use "ID" or "Names"
    let id = v.get("ID").or_else(|| v.get("Id"))
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();

    let name = v.get("Names").or_else(|| v.get("Name"))
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .trim_start_matches('/')
        .to_string();

    let image = v.get("Image").or_else(|| v.get("image"))
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();

    let status_str = v.get("State").or_else(|| v.get("Status"))
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_lowercase();

    let state = if status_str.starts_with("running") || status_str == "up" {
        DockerContainerState::Running
    } else {
        DockerContainerState::Stopped
    };

    if id.is_empty() && name.is_empty() {
        return None;
    }

    Some(DockerContainer { id, name, image, state })
}

pub fn list_containers(cli: &ContainerCli) -> Result<Vec<DockerContainer>, String> {
    let output = std::process::Command::new(cli.binary())
        .args(["ps", "--all", "--format", "json"])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .output()
        .map_err(|e| format!("Failed to run {} ps: {}", cli.binary(), e))?;

    if !output.status.success() {
        return Err(format!("{} ps failed: {}", cli.binary(), String::from_utf8_lossy(&output.stderr)));
    }

    Ok(parse_container_list(&String::from_utf8_lossy(&output.stdout)))
}

pub fn get_home_dir(cli: &ContainerCli, container_name: &str) -> Result<String, String> {
    let output = std::process::Command::new(cli.binary())
        .args(["exec", container_name, "sh", "-c", "echo $HOME"])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .output()
        .map_err(|e| format!("Failed to exec: {}", e))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

pub fn read_file(cli: &ContainerCli, container_name: &str, path: &str) -> Result<String, String> {
    let output = std::process::Command::new(cli.binary())
        .args(["exec", container_name, "sh", "-c", &format!("head -c 524288 {}", crate::git::remote::shell_quote(path))])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .output()
        .map_err(|e| format!("Failed to exec: {}", e))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

pub fn read_file_binary(cli: &ContainerCli, container_name: &str, path: &str) -> Result<String, String> {
    let output = std::process::Command::new(cli.binary())
        .args(["exec", container_name, "base64", path])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .output()
        .map_err(|e| format!("Failed to exec: {}", e))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

pub fn list_directories(cli: &ContainerCli, container_name: &str, path: &str) -> Result<Vec<String>, String> {
    let script = format!("ls -1aF {} 2>/dev/null", crate::git::remote::shell_quote(path));
    let output = std::process::Command::new(cli.binary())
        .args(["exec", container_name, "sh", "-c", &script])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .output()
        .map_err(|e| format!("Failed to exec: {}", e))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }
    let entries: Vec<String> = String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(|l| l.to_string())
        .collect();
    Ok(entries)
}
