use serde::{Deserialize, Serialize};
use std::process::Stdio;
use tokio::io::{AsyncReadExt, BufReader};
use tokio::process::Command;
use ts_rs::TS;

/// Result of process execution with captured output and exit status
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ProcessOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
    pub success: bool,
}

/// Spawn a Node.js sidecar process to execute an agent CLI command
///
/// # Arguments
/// * `working_dir` - Working directory for the spawned process
/// * `sidecar_path` - Path to the Node.js sidecar script
/// * `task_id` - Task ID to pass to the sidecar
///
/// # Returns
/// ProcessOutput containing stdout, stderr, exit code, and success status
///
/// # Behavior
/// - Uses tokio::process::Command for non-blocking async execution
/// - Sets kill_on_drop(true) to ensure proper cleanup
/// - Pipes stdout and stderr for capture
/// - Waits for process completion and captures exit code
pub async fn spawn_agent_cli(
    working_dir: &str,
    sidecar_path: &str,
    task_id: i32,
) -> Result<ProcessOutput, String> {
    let mut cmd = Command::new("node");
    cmd.arg(sidecar_path)
        .arg("run-agent")
        .arg(task_id.to_string())
        .current_dir(working_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let mut child = cmd.spawn().map_err(|e| format!("Failed to spawn: {}", e))?;

    let stdout = child.stdout.take().ok_or("Failed to capture stdout")?;
    let stderr = child.stderr.take().ok_or("Failed to capture stderr")?;

    let mut stdout_reader = BufReader::new(stdout);
    let mut stderr_reader = BufReader::new(stderr);

    let mut stdout_buf = String::new();
    let mut stderr_buf = String::new();

    // Read both streams concurrently (non-blocking)
    let stdout_fut = stdout_reader.read_to_string(&mut stdout_buf);
    let stderr_fut = stderr_reader.read_to_string(&mut stderr_buf);

    let _ = tokio::join!(stdout_fut, stderr_fut);

    let status = child.wait().await.map_err(|e| e.to_string())?;
    let exit_code = status.code().unwrap_or(-1);
    let success = status.success();

    Ok(ProcessOutput {
        stdout: stdout_buf,
        stderr: stderr_buf,
        exit_code,
        success,
    })
}
