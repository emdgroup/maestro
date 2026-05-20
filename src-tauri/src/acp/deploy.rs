use tauri::{AppHandle, Emitter, Manager};

const REMOTE_INSTALL_DIR: &str = ".maestro/bin";
const REMOTE_BINARY_NAME: &str = "maestro-server";
const REMOTE_TARGET: &str = "x86_64-unknown-linux-gnu";

#[derive(Clone, serde::Serialize)]
pub struct DeployStatus {
    pub connection_id: i32,
    pub status: String,
    pub message: Option<String>,
}

pub struct DeployResult {
    pub path: String,
    pub deployed: bool,
}

/// Ensure maestro-server exists on remote with the correct protocol version.
/// Deploys via SFTP if missing or outdated. Returns the absolute path to use for spawning.
pub async fn ensure_remote_server(
    ssh: &crate::ssh::RemoteSshSession,
    app_handle: &AppHandle,
    connection_id: i32,
) -> Result<DeployResult, String> {
    emit_status(app_handle, connection_id, "checking", None);

    // Single SSH command combining arch check, version check, and HOME resolution.
    let probe = ssh
        .execute_command(&format!(
            "printf '%s|||%s|||%s' \"$(uname -m)\" \"$($HOME/.{}/{} --protocol-version 2>/dev/null || echo MISSING)\" \"$HOME\"",
            REMOTE_INSTALL_DIR, REMOTE_BINARY_NAME
        ))
        .await
        .map_err(|e| format!("Failed to probe remote host: {}", e))?;

    let parts: Vec<&str> = probe.trim().splitn(3, "|||").collect();
    if parts.len() != 3 {
        return Err(format!("Unexpected probe output: {}", probe.trim()));
    }
    let (arch, remote_version, home) = (parts[0].trim(), parts[1].trim(), parts[2].trim());

    if arch != "x86_64" {
        return Err(format!("Unsupported remote architecture: {}", arch));
    }

    let local_version = maestro_protocol::PROTOCOL_VERSION.to_string();

    if remote_version == local_version {
        let abs_path = format!("{}/{}/{}", home, REMOTE_INSTALL_DIR, REMOTE_BINARY_NAME);
        emit_status(app_handle, connection_id, "up-to-date", None);
        return Ok(DeployResult {
            path: abs_path,
            deployed: false,
        });
    }

    emit_status(app_handle, connection_id, "deploying", None);

    let local_binary = resolve_bundled_linux_binary(app_handle)?;
    let abs_dir = format!("{}/{}", home, REMOTE_INSTALL_DIR);
    let abs_remote_path = format!("{}/{}", abs_dir, REMOTE_BINARY_NAME);

    ssh.execute_command(&format!("mkdir -p {}", abs_dir))
        .await
        .map_err(|e| format!("Failed to create remote dir: {}", e))?;

    // Remove any existing binary before upload. If it's currently running (e.g. an
    // orphaned connection server), Linux's sftp create would return ETXTBSY. Unlinking
    // first lets the kernel keep the inode alive for the running process while freeing
    // the path for the new file.
    ssh.execute_command(&format!("rm -f {}", abs_remote_path))
        .await
        .map_err(|e| format!("Failed to remove existing binary: {}", e))?;

    let transfer_id = format!("deploy-maestro-server-{}", connection_id);
    crate::ssh::sftp::upload_file(ssh, &local_binary, &abs_remote_path, &transfer_id, app_handle)
        .await
        .map_err(|e| format!("SFTP upload failed: {}", e))?;

    ssh.execute_command(&format!("chmod +x {}", abs_remote_path))
        .await
        .map_err(|e| format!("chmod failed: {}", e))?;

    emit_status(app_handle, connection_id, "deployed", None);

    Ok(DeployResult {
        path: abs_remote_path,
        deployed: true,
    })
}

/// Ensure maestro-server exists inside a WSL distro with the correct protocol version.
/// Deploys the bundled Linux x86_64 binary via stdin pipe if missing or outdated.
/// Returns the absolute Linux path to the binary.
#[cfg(windows)]
pub async fn ensure_wsl_server(
    distro: &str,
    app_handle: &AppHandle,
) -> Result<DeployResult, String> {
    use tokio::io::AsyncWriteExt;

    let probe_out = tokio::process::Command::new("wsl.exe")
        .args([
            "-d", distro, "--",
            "sh", "-c",
            &format!(
                "printf '%s|||%s' \"$HOME\" \"$($HOME/{}/{} --protocol-version 2>/dev/null || echo MISSING)\"",
                REMOTE_INSTALL_DIR, REMOTE_BINARY_NAME
            ),
        ])
        .output()
        .await
        .map_err(|e| format!("Failed to probe WSL distro {}: {}", distro, e))?;

    let text = crate::wsl::decode_wsl_output_pub(&probe_out.stdout)?;
    let parts: Vec<&str> = text.trim().splitn(2, "|||").collect();
    if parts.len() != 2 {
        return Err(format!("Unexpected WSL probe output: {}", text.trim()));
    }
    let (home, remote_version) = (parts[0].trim(), parts[1].trim());

    let local_version = maestro_protocol::PROTOCOL_VERSION.to_string();
    let abs_dir = format!("{}/{}", home, REMOTE_INSTALL_DIR);
    let abs_path = format!("{}/{}", abs_dir, REMOTE_BINARY_NAME);

    if remote_version == local_version {
        return Ok(DeployResult { path: abs_path, deployed: false });
    }

    let local_binary = resolve_bundled_linux_binary(app_handle)?;
    let binary_bytes = tokio::fs::read(&local_binary)
        .await
        .map_err(|e| format!("Cannot read bundled binary: {}", e))?;

    let mut child = tokio::process::Command::new("wsl.exe")
        .args([
            "-d", distro, "--",
            "sh", "-c",
            &format!("mkdir -p '{}' && cat > '{}' && chmod +x '{}'", abs_dir, abs_path, abs_path),
        ])
        .stdin(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn WSL deploy shell: {}", e))?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(&binary_bytes).await.map_err(|e| format!("Binary pipe write failed: {}", e))?;
    }

    let status = child.wait().await.map_err(|e| format!("WSL deploy process failed: {}", e))?;
    if !status.success() {
        return Err(format!("WSL deploy exited with status: {}", status));
    }

    Ok(DeployResult { path: abs_path, deployed: true })
}

fn resolve_bundled_linux_binary(app_handle: &AppHandle) -> Result<std::path::PathBuf, String> {
    let resource_dir = app_handle
        .path()
        .resource_dir()
        .map_err(|e| format!("Cannot resolve resource dir: {}", e))?;
    let local_binary = resource_dir
        .join("remote")
        .join(format!("maestro-server-{}", REMOTE_TARGET));
    if !local_binary.exists() {
        return Err(format!("Remote binary not bundled: {}", local_binary.display()));
    }
    Ok(local_binary)
}

fn emit_status(app_handle: &AppHandle, connection_id: i32, status: &str, message: Option<String>) {
    let _ = app_handle.emit(
        "maestro-server://deploy-status",
        DeployStatus {
            connection_id,
            status: status.to_string(),
            message,
        },
    );
}
