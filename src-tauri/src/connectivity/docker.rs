use crate::command_ext::NoConsoleWindow;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::Path;

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

    /// Resolved with the `which` crate rather than the `which` command: Windows has no such
    /// command, so spawning it failed for every candidate and `detect` reported that no
    /// container CLI existed. The crate also applies PATHEXT, which is what actually matches
    /// `docker` against the `docker.exe` Docker Desktop puts on PATH.
    pub fn detect() -> Result<Self, String> {
        for cli in [Self::Docker, Self::Podman, Self::Nerdctl] {
            if which::which(cli.binary()).is_ok() {
                return Ok(cli);
            }
        }
        Err("No container CLI found (tried docker, podman, nerdctl)".to_string())
    }
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
        .no_console_window()
        .output()
        .map_err(|e| format!("Failed to run {} ps: {}", cli.binary(), e))?;

    if !output.status.success() {
        return Err(format!("{} ps failed: {}", cli.binary(), String::from_utf8_lossy(&output.stderr)));
    }

    Ok(parse_container_list(&String::from_utf8_lossy(&output.stdout)))
}

/// Run a command inside a container through its exec channel, so it costs a message rather than a
/// `<cli> exec` start. Falls back to a cold spawn when no channel is available.
pub(crate) async fn run(
    cli: &ContainerCli,
    container_name: &str,
    program: &str,
    args: &[&str],
) -> Result<crate::connectivity::exec_channel::CommandOutput, String> {
    crate::connectivity::exec_channel::run(
        &crate::connectivity::exec_channel::ExecTarget::Docker { cli: *cli, container: container_name },
        None,
        program,
        args,
    )
    .await
}

pub async fn get_home_dir(cli: &ContainerCli, container_name: &str) -> Result<String, String> {
    let output = run(cli, container_name, "sh", &["-c", "echo $HOME"]).await?;
    if !output.success() {
        return Err(output.stderr_string());
    }
    Ok(output.stdout_string().trim().to_string())
}

pub async fn read_file_binary(cli: &ContainerCli, container_name: &str, path: &str) -> Result<String, String> {
    let output = run(cli, container_name, "base64", &[path]).await?;
    if !output.success() {
        return Err(output.stderr_string());
    }
    Ok(output.stdout_string())
}

/// `<cli> cp` in whichever direction the caller names.
///
/// Runs on the host rather than through [`run`]: `cp` is implemented by the CLI itself, and the
/// container has no view of the host path on the other end of it.
async fn copy(cli: &ContainerCli, from: &str, to: &str) -> Result<(), String> {
    let output = tokio::process::Command::new(cli.binary())
        .args(["cp", from, to])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .no_console_window()
        .output()
        .await
        .map_err(|e| format!("Failed to run {} cp: {e}", cli.binary()))?;

    if !output.status.success() {
        return Err(format!(
            "{} cp failed: {}",
            cli.binary(),
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(())
}

/// Copy a host file into a container. The destination's directory must already exist.
pub async fn copy_into(
    cli: &ContainerCli,
    container_name: &str,
    host_path: &Path,
    dest: &str,
) -> Result<(), String> {
    let source = host_path.to_str().ok_or("Source path is not valid UTF-8")?;
    copy(cli, source, &format!("{container_name}:{dest}")).await
}

/// Copy a file out of a container onto the host.
///
/// The destination's parent is created first — `cp` will not create it, and this mirrors what
/// [`crate::connectivity::ssh::sftp::download_file`] does for the equivalent SSH path.
pub async fn copy_from(
    cli: &ContainerCli,
    container_name: &str,
    src: &str,
    host_path: &Path,
) -> Result<(), String> {
    if let Some(parent) = host_path.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(|e| {
            format!("Cannot create local directory '{}': {e}", parent.display())
        })?;
    }
    let dest = host_path.to_str().ok_or("Destination path is not valid UTF-8")?;
    copy(cli, &format!("{container_name}:{src}"), dest).await
}

pub async fn list_directories(cli: &ContainerCli, container_name: &str, path: &str) -> Result<Vec<String>, String> {
    let script = format!("ls -1aF {} 2>/dev/null", crate::git::remote::shell_quote(path));
    let output = run(cli, container_name, "sh", &["-c", &script]).await?;
    if !output.success() {
        return Err(output.stderr_string());
    }
    Ok(output.stdout_string().lines().map(|l| l.to_string()).collect())
}
