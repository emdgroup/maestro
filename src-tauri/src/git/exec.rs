use crate::command_ext::NoConsoleWindow;
use crate::models::GitConnection;
use tokio::process::Command as TokioCommand;
use super::remote;

pub(super) async fn run_docker_git(container_name: &str, path: &str, args: &[&str], ignore_exit_code: bool) -> Result<String, String> {
    let cli = crate::connectivity::docker::ContainerCli::detect()
        .unwrap_or(crate::connectivity::docker::ContainerCli::Docker);
    let mut cmd_args = vec!["exec", "-i", container_name, "git", "-C", path];
    cmd_args.extend_from_slice(args);
    let output = TokioCommand::new(cli.binary())
        .args(&cmd_args)
        .output()
        .await
        .map_err(|e| format!("Failed to run {} exec git: {}", cli.binary(), e))?;
    if !ignore_exit_code && !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Docker git error: {}", stderr));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

async fn run_docker_git_with_stdin(container_name: &str, path: &str, args: &[&str], stdin_data: &[u8]) -> Result<String, String> {
    use std::process::Stdio;
    use tokio::io::AsyncWriteExt;
    let cli = crate::connectivity::docker::ContainerCli::detect()
        .unwrap_or(crate::connectivity::docker::ContainerCli::Docker);
    let mut cmd_args = vec!["exec", "-i", container_name, "git", "-C", path];
    cmd_args.extend_from_slice(args);
    let mut child = TokioCommand::new(cli.binary())
        .args(&cmd_args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to run {} exec git: {}", cli.binary(), e))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(stdin_data).await.map_err(|e| format!("Failed to write git stdin: {}", e))?;
    }
    let output = child.wait_with_output().await.map_err(|e| format!("Failed to wait for docker git: {}", e))?;
    if !output.status.success() {
        return Err(format!("Docker git error: {}", String::from_utf8_lossy(&output.stderr)));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

pub(super) async fn run_wsl_git(distro: &str, path: &str, args: &[&str], ignore_exit_code: bool) -> Result<String, String> {
    // Disable SSL verification so git operations against internal servers with
    // self-signed certs work. WSL has a separate cert store from Windows.
    let mut cmd_args = vec!["-d", distro, "--", "git", "-c", "http.sslVerify=false", "-C", path];
    cmd_args.extend_from_slice(args);
    let output = TokioCommand::new("wsl.exe")
        .args(&cmd_args)
        .no_console_window()
        .output()
        .await
        .map_err(|e| format!("Failed to spawn wsl.exe for git: {}", e))?;
    if !ignore_exit_code && !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("WSL git error: {}", stderr));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

async fn run_wsl_git_with_stdin(distro: &str, path: &str, args: &[&str], stdin_data: &[u8]) -> Result<String, String> {
    use std::process::Stdio;
    use tokio::io::AsyncWriteExt;
    let mut cmd_args = vec!["-d", distro, "--", "git", "-c", "http.sslVerify=false", "-C", path];
    cmd_args.extend_from_slice(args);
    let mut child = TokioCommand::new("wsl.exe")
        .args(&cmd_args)
        .no_console_window()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn wsl.exe for git: {}", e))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(stdin_data).await.map_err(|e| format!("Failed to write git stdin: {}", e))?;
    }
    let output = child.wait_with_output().await.map_err(|e| format!("Failed to wait for wsl.exe git: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("WSL git error: {}", stderr));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Run a git command in a directory, piping `stdin_data` to git's stdin.
/// Used for commands like `git apply` that read patch content from stdin.
pub async fn run_git_in_dir_with_stdin(
    conn: &GitConnection,
    abs_path: &str,
    args: &[&str],
    stdin_data: &[u8],
) -> Result<String, String> {
    match conn {
        GitConnection::Local { .. } => {
            use std::process::Stdio;
            use tokio::io::AsyncWriteExt;
            let mut child = TokioCommand::new("git")
                .args(args)
                .current_dir(abs_path)
                .no_console_window()
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .map_err(|e| format!("git failed: {}", e))?;
            if let Some(mut stdin) = child.stdin.take() {
                stdin.write_all(stdin_data).await.map_err(|e| format!("Failed to write git stdin: {}", e))?;
            }
            let output = child.wait_with_output().await.map_err(|e| format!("git failed: {}", e))?;
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                return Err(format!("git error: {}", stderr));
            }
            Ok(String::from_utf8_lossy(&output.stdout).to_string())
        }
        GitConnection::Remote { ssh, .. } => {
            let git_args: Vec<String> = args.iter().map(|a| remote::shell_quote(a)).collect();
            let cmd = format!("cd {} && git {}", remote::shell_quote(abs_path), git_args.join(" "));
            ssh.execute_command_with_stdin(&cmd, stdin_data)
                .await
                .map_err(|e| format!("Remote git error: {:?}", e))
        }
        GitConnection::Wsl { distro, .. } => {
            run_wsl_git_with_stdin(distro, abs_path, args, stdin_data).await
        }
        GitConnection::Docker { container_name, .. } => {
            run_docker_git_with_stdin(container_name, abs_path, args, stdin_data).await
        }
    }
}

async fn run_git_in_dir_inner(
    conn: &GitConnection,
    abs_path: &str,
    args: &[&str],
    ignore_exit_code: bool,
) -> Result<String, String> {
    match conn {
        GitConnection::Local { .. } => {
            let output = TokioCommand::new("git")
                .args(args)
                .current_dir(abs_path)
                .no_console_window()
                .output()
                .await
                .map_err(|e| format!("git failed: {}", e))?;
            if !ignore_exit_code && !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                return Err(format!("git error: {}", stderr));
            }
            Ok(String::from_utf8_lossy(&output.stdout).to_string())
        }
        GitConnection::Remote { ssh, .. } => {
            let git_args: Vec<String> = args.iter().map(|a| remote::shell_quote(a)).collect();
            let git_cmd = git_args.join(" ");
            let cmd = if ignore_exit_code {
                format!("cd {} && git {} || true", remote::shell_quote(abs_path), git_cmd)
            } else {
                format!("cd {} && git {}", remote::shell_quote(abs_path), git_cmd)
            };
            ssh.execute_command(&cmd)
                .await
                .map_err(|e| format!("Remote git error: {:?}", e))
        }
        GitConnection::Wsl { distro, .. } => {
            run_wsl_git(distro, abs_path, args, ignore_exit_code).await
        }
        GitConnection::Docker { container_name, .. } => {
            run_docker_git(container_name, abs_path, args, ignore_exit_code).await
        }
    }
}

/// Public dispatcher: routes git operations to local OR remote based on GitConnection type
///
/// For local projects: Uses tokio::process::Command to run git CLI directly
/// For remote projects: Executes git commands via SSH
/// For WSL projects: Executes git commands via wsl.exe
pub async fn run_git_in_dir(
    conn: &GitConnection,
    abs_path: &str,
    args: &[&str],
) -> Result<String, String> {
    run_git_in_dir_inner(conn, abs_path, args, false).await
}

/// Like `run_git_in_dir` but tolerates non-zero exit codes (returns stdout anyway).
pub async fn run_git_in_dir_lossy(
    conn: &GitConnection,
    abs_path: &str,
    args: &[&str],
) -> Result<String, String> {
    run_git_in_dir_inner(conn, abs_path, args, true).await
}
