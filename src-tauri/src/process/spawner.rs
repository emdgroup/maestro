use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

#[derive(Debug, Clone)]
pub struct ProcessOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
    pub success: bool,
}

/// Spawns an agent CLI process via Node.js sidecar with non-blocking async execution.
///
/// # Arguments
/// * `working_dir` - Working directory for the process
/// * `sidecar_path` - Path to the Node.js sidecar script
/// * `task_id` - Task ID to pass to the sidecar
///
/// # Returns
/// `Result<ProcessOutput, String>` containing stdout, stderr, exit code, and success status
pub async fn spawn_agent_cli(
    working_dir: &str,
    sidecar_path: &str,
    task_id: i32,
) -> Result<ProcessOutput, String> {
    let mut cmd = Command::new("node");
    cmd.current_dir(working_dir)
        .arg(sidecar_path)
        .arg("--task-id")
        .arg(task_id.to_string())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn process: {}", e))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to open stdout".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Failed to open stderr".to_string())?;

    let stdout_reader = BufReader::new(stdout);
    let stderr_reader = BufReader::new(stderr);

    let stdout_handle = tokio::spawn(async move {
        let mut reader = stdout_reader;
        let mut lines = Vec::new();
        let mut line = String::new();
        while let Ok(n) = reader.read_line(&mut line).await {
            if n == 0 {
                break;
            }
            lines.push(line.clone());
            line.clear();
        }
        lines.join("")
    });

    let stderr_handle = tokio::spawn(async move {
        let mut reader = stderr_reader;
        let mut lines = Vec::new();
        let mut line = String::new();
        while let Ok(n) = reader.read_line(&mut line).await {
            if n == 0 {
                break;
            }
            lines.push(line.clone());
            line.clear();
        }
        lines.join("")
    });

    let status = child
        .wait()
        .await
        .map_err(|e| format!("Failed to wait for child process: {}", e))?;

    let stdout_result = stdout_handle
        .await
        .unwrap_or_default();

    let stderr_result = stderr_handle
        .await
        .unwrap_or_default();

    let exit_code = status.code().unwrap_or(-1);
    let success = status.success();

    Ok(ProcessOutput {
        stdout: stdout_result,
        stderr: stderr_result,
        exit_code,
        success,
    })
}
