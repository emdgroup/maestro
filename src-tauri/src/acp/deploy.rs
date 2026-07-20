use tauri::{AppHandle, Emitter, Manager};

const REMOTE_INSTALL_DIR: &str = ".local/bin";
const REMOTE_BINARY_NAME: &str = "maestro-server";

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

/// Maps a Rust target triple to the friendly GitHub release asset filename.
/// This is the canonical source of truth for asset naming — used both when
/// constructing download URLs and when naming locally-cached binaries.
pub(crate) fn asset_filename(triple: &str) -> String {
    match triple {
        "x86_64-unknown-linux-gnu"  => "maestro-server-linux-x86_64".to_string(),
        "aarch64-unknown-linux-gnu" => "maestro-server-linux-arm64".to_string(),
        "aarch64-apple-darwin"      => "maestro-server-macos-arm64".to_string(),
        "x86_64-pc-windows-msvc"    => "maestro-server-windows-x86_64.exe".to_string(),
        other                       => format!("maestro-server-{}", other),
    }
}

/// Maps uname-reported OS and architecture strings to their Rust target triple.
/// For native Windows remotes (PowerShell/cmd default shell), the OS field is "Windows_NT"
/// (reported by the PowerShell probe). For MSYS2/Git Bash on Windows, uname -s returns a
/// string containing "NT" (e.g. "MINGW64_NT-10.0-19041").
fn triple_for_remote(os: &str, arch: &str) -> Result<&'static str, String> {
    match (os, arch) {
        ("Darwin", "arm64") | ("Darwin", "aarch64") => Ok("aarch64-apple-darwin"),
        ("Darwin", other) => Err(format!("Unsupported macOS architecture: {}", other)),
        (os, "x86_64") if os.contains("NT") => Ok("x86_64-pc-windows-msvc"),
        (os, arch) if os.contains("NT") => Err(format!("Unsupported Windows architecture: {}", arch)),
        (_, "x86_64")                 => Ok("x86_64-unknown-linux-gnu"),
        (_, "aarch64") | (_, "arm64") => Ok("aarch64-unknown-linux-gnu"),
        (_, other)                    => Err(format!("Unsupported remote architecture: {}", other)),
    }
}

/// Maps a uname-reported architecture string to its Rust Linux target triple.
/// Used for container remotes, which are always Linux.
fn linux_triple_for_arch(arch: &str) -> Result<&'static str, String> {
    match arch {
        "x86_64"            => Ok("x86_64-unknown-linux-gnu"),
        "aarch64" | "arm64" => Ok("aarch64-unknown-linux-gnu"),
        other               => Err(format!("Unsupported remote architecture: {}", other)),
    }
}

/// Returns the platform-appropriate binary name for the remote target.
fn remote_binary_name(triple: &str) -> &'static str {
    match triple {
        "x86_64-pc-windows-msvc" => "maestro-server.exe",
        _ => REMOTE_BINARY_NAME,
    }
}

/// Encodes a PowerShell script as a base64 UTF-16LE -EncodedCommand invocation.
/// Avoids all shell-quoting issues regardless of whether the SSH default shell is
/// cmd.exe or PowerShell — base64 contains only alphanumeric characters and +/=.
fn powershell_encoded(script: &str) -> String {
    use base64::Engine;
    let utf16: Vec<u16> = script.encode_utf16().collect();
    let bytes: Vec<u8> = utf16.iter().flat_map(|w| w.to_le_bytes()).collect();
    format!(
        "powershell -EncodedCommand {}",
        base64::engine::general_purpose::STANDARD.encode(&bytes)
    )
}

/// Ensure maestro-server exists on remote with the correct version.
/// Downloads the appropriate binary locally if needed, then deploys via SFTP.
/// Returns the absolute path to use for spawning.
///
/// Uses a two-phase probe: Unix first (uname), then a PowerShell fallback for
/// native Windows remotes (PowerShell or cmd.exe as the SSH default shell).
pub async fn ensure_remote_server(
    ssh: &crate::connectivity::ssh::RemoteSshSession,
    app_handle: &AppHandle,
    connection_id: i32,
) -> Result<DeployResult, String> {
    emit_status(app_handle, connection_id, "checking", None);

    // Phase 1: Unix probe — works on Linux, macOS, and MSYS2/Git Bash on Windows.
    // Try both binary names: uname -s is unknown before the probe succeeds, so we
    // cannot know ahead of time whether the Windows .exe variant is installed.
    let unix_probe = format!(
        "printf '%s|||%s|||%s|||%s' \"$(uname -s)\" \"$(uname -m)\" \
         \"$(~/{dir}/{name} --app-version 2>/dev/null \
            || ~/{dir}/{name}.exe --app-version 2>/dev/null \
            || echo MISSING)\" \
         \"$(echo ~)\"",
        dir = REMOTE_INSTALL_DIR,
        name = REMOTE_BINARY_NAME,
    );

    // Phase 2: Windows PowerShell probe — used when the Unix probe fails entirely
    // (i.e. the SSH default shell is PowerShell or cmd.exe, neither of which has uname).
    // Encoded as base64 UTF-16LE via -EncodedCommand to avoid all shell-quoting issues
    // regardless of whether the outer shell is cmd.exe or PowerShell.
    // $env:PROCESSOR_ARCHITECTURE returns AMD64 (x86-64) or ARM64 on Windows.
    // Backslashes in USERPROFILE are replaced with / so the path is usable as an SFTP path.
    let windows_ps_probe = "\
        $a=$env:PROCESSOR_ARCHITECTURE; \
        $h=($env:USERPROFILE -replace [char]92,[char]47); \
        $p=$env:USERPROFILE+[char]92+'.local'+[char]92+'bin'+[char]92+'maestro-server.exe'; \
        $v=if(Test-Path $p){try{(& $p --app-version 2>$null).Trim()}catch{'MISSING'}}else{'MISSING'}; \
        Write-Output ('Windows_NT|||' + $a + '|||' + $v + '|||' + $h)";

    let (probe_output, is_windows_native) = match ssh.execute_command(&unix_probe).await {
        Ok(output) if output.contains("|||") => (output, false),
        _ => {
            let output = ssh
                .execute_command(&powershell_encoded(windows_ps_probe))
                .await
                .map_err(|e| format!("Remote probe failed: {}", e))?;
            (output, true)
        }
    };

    let parts: Vec<&str> = probe_output.trim().splitn(4, "|||").collect();
    if parts.len() != 4 {
        return Err(format!("Unexpected probe output: {}", probe_output.trim()));
    }
    let (os, arch, remote_version, home) = (
        parts[0].trim(),
        parts[1].trim(),
        parts[2].trim(),
        parts[3].trim(),
    );

    let remote_triple = triple_for_remote(os, arch)?;
    let binary_name = remote_binary_name(remote_triple);
    let local_version = env!("CARGO_PKG_VERSION").to_string();

    if remote_version == local_version {
        let abs_path = format!("{}/{}/{}", home, REMOTE_INSTALL_DIR, binary_name);
        emit_status(app_handle, connection_id, "up-to-date", None);
        return Ok(DeployResult {
            path: abs_path,
            deployed: false,
        });
    }

    emit_status(app_handle, connection_id, "deploying", None);

    let local_binary = ensure_remote_binary_local(app_handle, remote_triple).await?;
    let abs_dir = format!("{}/{}", home, REMOTE_INSTALL_DIR);
    let abs_remote_path = format!("{}/{}", abs_dir, binary_name);

    if is_windows_native {
        ssh.execute_command(&powershell_encoded(&format!(
            "New-Item -ItemType Directory -Force -Path '{}' | Out-Null",
            abs_dir
        )))
        .await
        .map_err(|e| format!("Failed to create remote dir: {}", e))?;

        ssh.execute_command(&powershell_encoded(&format!(
            "if (Test-Path '{}') {{ Remove-Item -Force '{}' }}",
            abs_remote_path, abs_remote_path
        )))
        .await
        .map_err(|e| format!("Failed to remove existing binary: {}", e))?;
    } else {
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
    }

    let transfer_id = format!("deploy-maestro-server-{}", connection_id);
    crate::connectivity::ssh::sftp::upload_file(
        ssh,
        &local_binary,
        &abs_remote_path,
        &transfer_id,
        app_handle,
    )
    .await
    .map_err(|e| format!("SFTP upload failed: {}", e))?;

    if !is_windows_native {
        ssh.execute_command(&format!("chmod +x {}", abs_remote_path))
            .await
            .map_err(|e| format!("chmod failed: {}", e))?;
    }

    emit_status(app_handle, connection_id, "deployed", None);

    Ok(DeployResult {
        path: abs_remote_path,
        deployed: true,
    })
}

/// Ensure maestro-server exists inside a WSL distro with the correct version.
/// Downloads the Linux x86_64 binary locally if needed, then deploys via stdin pipe.
/// Returns the absolute Linux path to the binary.
#[cfg(windows)]
pub async fn ensure_wsl_server(
    distro: &str,
    app_handle: &AppHandle,
) -> Result<DeployResult, String> {
    use tokio::io::AsyncWriteExt;

    use crate::command_ext::NoConsoleWindow;
    let probe_out = tokio::time::timeout(
        std::time::Duration::from_secs(15),
        tokio::process::Command::new("wsl.exe")
            .args([
                "-d", distro, "--",
                "sh", "-c",
                &format!(
                    "printf '%s|||%s' \"$HOME\" \"$($HOME/{}/{} --app-version 2>/dev/null || echo MISSING)\"",
                    REMOTE_INSTALL_DIR, REMOTE_BINARY_NAME
                ),
            ])
            .no_console_window()
            .output(),
    )
    .await
    .map_err(|_| format!("WSL probe timed out for distro {}", distro))?
    .map_err(|e| format!("Failed to probe WSL distro {}: {}", distro, e))?;

    let text = crate::connectivity::wsl::decode_wsl_output_pub(&probe_out.stdout)?;
    let parts: Vec<&str> = text.trim().splitn(2, "|||").collect();
    if parts.len() != 2 {
        return Err(format!("Unexpected WSL probe output: {}", text.trim()));
    }
    let (home, remote_version) = (parts[0].trim(), parts[1].trim());

    let local_version = env!("CARGO_PKG_VERSION").to_string();
    let abs_dir = format!("{}/{}", home, REMOTE_INSTALL_DIR);
    let abs_path = format!("{}/{}", abs_dir, REMOTE_BINARY_NAME);

    if remote_version == local_version {
        return Ok(DeployResult { path: abs_path, deployed: false });
    }

    // WSL on Windows runs x86_64 Linux in all common configurations.
    let local_binary = ensure_remote_binary_local(app_handle, "x86_64-unknown-linux-gnu").await?;
    let binary_bytes = tokio::fs::read(&local_binary)
        .await
        .map_err(|e| format!("Cannot read cached binary: {}", e))?;

    let mut child = tokio::process::Command::new("wsl.exe")
        .args([
            "-d", distro, "--",
            "sh", "-c",
            &format!("mkdir -p '{}' && cat > '{}' && chmod +x '{}'", abs_dir, abs_path, abs_path),
        ])
        .stdin(std::process::Stdio::piped())
        .no_console_window()
        .spawn()
        .map_err(|e| format!("Failed to spawn WSL deploy shell: {}", e))?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(&binary_bytes).await.map_err(|e| format!("Binary pipe write failed: {}", e))?;
    }

    let status = tokio::time::timeout(
        std::time::Duration::from_secs(60),
        child.wait(),
    )
    .await
    .map_err(|_| format!("WSL deploy timed out for distro {}", distro))?
    .map_err(|e| format!("WSL deploy process failed: {}", e))?;
    if !status.success() {
        return Err(format!("WSL deploy exited with status: {}", status));
    }

    Ok(DeployResult { path: abs_path, deployed: true })
}

/// Ensure maestro-server exists inside a container with the correct version.
/// Probes via a single exec, downloads the Linux binary locally if needed, then deploys via stdin pipe.
/// Returns the absolute Linux path to the binary inside the container.
pub async fn ensure_container_server(
    cli: &crate::connectivity::docker::ContainerCli,
    container_name: &str,
    app_handle: &AppHandle,
) -> Result<DeployResult, String> {
    use tokio::io::AsyncWriteExt;

    let probe_out = tokio::time::timeout(
        std::time::Duration::from_secs(15),
        tokio::process::Command::new(cli.binary())
            .args([
                "exec", container_name,
                "sh", "-c",
                &format!(
                    "printf '%s|||%s' \"$HOME\" \"$($HOME/{}/{} --app-version 2>/dev/null || echo MISSING)\"",
                    REMOTE_INSTALL_DIR, REMOTE_BINARY_NAME
                ),
            ])
            .output(),
    )
    .await
    .map_err(|_| format!("Container probe timed out for {}", container_name))?
    .map_err(|e| format!("Failed to probe container {}: {}", container_name, e))?;

    if !probe_out.status.success() {
        return Err(format!(
            "Container probe failed for {}: {}",
            container_name,
            String::from_utf8_lossy(&probe_out.stderr)
        ));
    }

    let text = String::from_utf8_lossy(&probe_out.stdout);
    let parts: Vec<&str> = text.trim().splitn(2, "|||").collect();
    if parts.len() != 2 {
        return Err(format!("Unexpected container probe output: {}", text.trim()));
    }
    let (home, remote_version) = (parts[0].trim(), parts[1].trim());

    let local_version = env!("CARGO_PKG_VERSION").to_string();
    let abs_dir = format!("{}/{}", home, REMOTE_INSTALL_DIR);
    let abs_path = format!("{}/{}", abs_dir, REMOTE_BINARY_NAME);

    if remote_version == local_version {
        return Ok(DeployResult { path: abs_path, deployed: false });
    }

    // Detect the container arch via uname before downloading the right binary.
    let arch_out = tokio::process::Command::new(cli.binary())
        .args(["exec", container_name, "uname", "-m"])
        .output()
        .await
        .map_err(|e| format!("Failed to probe container arch: {}", e))?;
    let arch = String::from_utf8_lossy(&arch_out.stdout).trim().to_string();
    let triple = linux_triple_for_arch(&arch)?;

    let local_binary = ensure_remote_binary_local(app_handle, triple).await?;
    let binary_bytes = tokio::fs::read(&local_binary)
        .await
        .map_err(|e| format!("Cannot read cached binary: {}", e))?;

    let mut child = tokio::process::Command::new(cli.binary())
        .args([
            "exec", "-i", container_name,
            "sh", "-c",
            &format!("mkdir -p '{}' && cat > '{}' && chmod +x '{}'", abs_dir, abs_path, abs_path),
        ])
        .stdin(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn container deploy shell: {}", e))?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(&binary_bytes).await.map_err(|e| format!("Binary pipe write failed: {}", e))?;
    }

    let status = tokio::time::timeout(
        std::time::Duration::from_secs(60),
        child.wait(),
    )
    .await
    .map_err(|_| format!("Container deploy timed out for {}", container_name))?
    .map_err(|e| format!("Container deploy process failed: {}", e))?;
    if !status.success() {
        return Err(format!("Container deploy exited with status: {}", status));
    }

    Ok(DeployResult { path: abs_path, deployed: true })
}

/// Write the bundled canvas catalog to `.maestro/canvas-catalog.json` on a remote host.
/// Uses base64 encoding to safely transfer the JSON over the SSH channel.
pub async fn ensure_remote_catalog(
    ssh: &crate::connectivity::ssh::RemoteSshSession,
    project_path: &str,
) -> Result<(), String> {
    use base64::Engine;
    let encoded = base64::engine::general_purpose::STANDARD.encode(crate::core::project_storage::CANVAS_CATALOG.as_bytes());
    let dest = format!("{}/.maestro/canvas-catalog.json", project_path);
    ssh.execute_command(&format!(
        "printf '%s' '{}' | base64 -d > '{}'",
        encoded, dest
    ))
    .await
    .map_err(|e| format!("Failed to write remote canvas catalog: {}", e))?;
    Ok(())
}

/// Write the bundled canvas catalog to `.maestro/canvas-catalog.json` inside a WSL distro.
#[cfg(windows)]
pub async fn ensure_wsl_catalog(distro: &str, project_path: &str) -> Result<(), String> {
    use base64::Engine;
    let encoded = base64::engine::general_purpose::STANDARD.encode(crate::core::project_storage::CANVAS_CATALOG.as_bytes());
    let dest = format!("{}/.maestro/canvas-catalog.json", project_path);
    let status = tokio::process::Command::new("wsl.exe")
        .args([
            "-d", distro, "--",
            "sh", "-c",
            &format!("printf '%s' '{}' | base64 -d > '{}'", encoded, dest),
        ])
        .status()
        .await
        .map_err(|e| format!("Failed to spawn WSL catalog write: {}", e))?;
    if !status.success() {
        return Err(format!("WSL catalog write exited with status: {}", status));
    }
    Ok(())
}

/// Ensure the native platform maestro-server binary is cached in the app data dir.
/// Downloads from GitHub releases if absent or version-mismatched.
/// Also installs a well-known symlink (Unix) or copy (Windows) at ~/.local/bin/maestro-server
/// so agent subprocesses can resolve it via PATH.
/// Called during preflight for local connections and as fallback in open_local_transport.
pub async fn ensure_local_server(app_handle: &AppHandle) -> Result<std::path::PathBuf, String> {
    let cached = ensure_cached_binary(app_handle, crate::acp::HOST_TRIPLE, Some(0)).await?;
    if let Err(e) = install_local_link(&cached).await {
        eprintln!("Warning: failed to install ~/.local/bin/maestro-server: {}", e);
    }
    Ok(cached)
}

/// Install a well-known entry at ~/.local/bin/maestro-server pointing to the cached binary.
/// On Unix: symlink. On Windows: rename-old + copy + delete-old.
/// Non-fatal — callers log the error and continue.
async fn install_local_link(src: &std::path::Path) -> Result<(), String> {
    let home = {
        #[cfg(windows)]
        let var = "USERPROFILE";
        #[cfg(not(windows))]
        let var = "HOME";
        std::env::var(var)
            .map(std::path::PathBuf::from)
            .map_err(|_| "Cannot resolve home directory".to_string())?
    };
    let bin_dir = home.join(".local").join("bin");
    tokio::fs::create_dir_all(&bin_dir)
        .await
        .map_err(|e| format!("Cannot create ~/.local/bin: {}", e))?;

    #[cfg(unix)]
    {
        let dest = bin_dir.join("maestro-server");
        // Remove stale symlink or file before recreating.
        let _ = tokio::fs::remove_file(&dest).await;
        tokio::fs::symlink(src, &dest)
            .await
            .map_err(|e| format!("Failed to create symlink ~/.local/bin/maestro-server: {}", e))?;
    }

    #[cfg(windows)]
    {
        let dest = bin_dir.join("maestro-server.exe");
        let old = bin_dir.join("maestro-server.exe.old");
        // Rename existing binary aside first so Windows doesn't block overwrite of a running file.
        let _ = tokio::fs::rename(&dest, &old).await;
        tokio::fs::copy(src, &dest)
            .await
            .map_err(|e| format!("Failed to copy maestro-server.exe to ~/.local/bin: {}", e))?;
        // Clean up the old copy; ignore failure — it may still be in use by a running process.
        let _ = tokio::fs::remove_file(&old).await;
    }

    Ok(())
}

/// Ensure the maestro-server binary for the given triple is cached in the app data dir.
/// Downloads from GitHub releases if absent or version-mismatched.
/// Used as the local staging binary before SSH or WSL deployment.
async fn ensure_remote_binary_local(
    app_handle: &AppHandle,
    triple: &str,
) -> Result<std::path::PathBuf, String> {
    ensure_cached_binary(app_handle, triple, None).await
}

/// Core ensure logic: check version of the cached binary for `triple`, download if needed.
/// `emit_connection_id` is `Some(id)` to emit deploy-status events (local preflight),
/// or `None` for silent background downloads (SSH/WSL staging).
async fn ensure_cached_binary(
    app_handle: &AppHandle,
    triple: &str,
    emit_connection_id: Option<i32>,
) -> Result<std::path::PathBuf, String> {
    let dest = cached_binary_path(app_handle, triple)?;
    let local_version = env!("CARGO_PKG_VERSION");

    if let Some(id) = emit_connection_id {
        emit_status(app_handle, id, "checking", None);
    }

    if dest.exists() {
        if let Some(cached_version) = check_cached_version(&dest).await {
            if cached_version == local_version {
                if let Some(id) = emit_connection_id {
                    emit_status(app_handle, id, "up-to-date", None);
                }
                return Ok(dest);
            }
        }
    }

    if let Some(id) = emit_connection_id {
        emit_status(app_handle, id, "deploying", None);
    }
    download_server_binary(triple, &dest).await?;
    if let Some(id) = emit_connection_id {
        emit_status(app_handle, id, "deployed", None);
    }

    Ok(dest)
}

fn cached_binary_path(app_handle: &AppHandle, triple: &str) -> Result<std::path::PathBuf, String> {
    let dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Cannot resolve app data dir: {}", e))?
        .join("bin");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Cannot create server cache dir: {}", e))?;
    Ok(dir.join(asset_filename(triple)))
}

async fn check_cached_version(path: &std::path::Path) -> Option<String> {
    let output = tokio::process::Command::new(path)
        .arg("--app-version")
        .output()
        .await
        .ok()?;
    if output.status.success() {
        Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        None
    }
}

async fn download_server_binary(triple: &str, dest: &std::path::Path) -> Result<(), String> {
    let version = env!("CARGO_PKG_VERSION");
    let filename = asset_filename(triple);
    let url = format!(
        "https://github.com/emdgroup/maestro/releases/download/v{}/{}",
        version, filename
    );

    let response = reqwest::get(&url)
        .await
        .map_err(|e| format!("Download request failed for {}: {}", url, e))?;

    if !response.status().is_success() {
        return Err(format!(
            "Download returned HTTP {} for {}",
            response.status(),
            url
        ));
    }

    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("Download read failed: {}", e))?;

    // Write to a temp path then rename atomically to avoid a partial binary at dest.
    let tmp_path = dest.with_extension("download-tmp");
    tokio::fs::write(&tmp_path, &bytes)
        .await
        .map_err(|e| format!("Failed to write binary to temp file: {}", e))?;
    tokio::fs::rename(&tmp_path, dest)
        .await
        .map_err(|e| format!("Failed to install binary: {}", e))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        tokio::fs::set_permissions(dest, std::fs::Permissions::from_mode(0o755))
            .await
            .map_err(|e| format!("Failed to set executable permission: {}", e))?;
    }

    Ok(())
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
