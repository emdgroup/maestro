use crate::models::{Task, Worktree};
use crate::ssh::RemoteSshSession;
use std::sync::Arc;

/// Configuration for agent execution (model, mcp_allowlist, skills)
#[derive(Debug, Clone)]
pub struct ExecutionConfig {
    pub model_override: Option<String>,
    pub mcp_allowlist: Option<Vec<String>>,
    pub skills_override: Option<Vec<String>>,
}

/// Handle to a remote process executing via SSH PTY
#[derive(Debug, Clone)]
pub struct RemoteProcessHandle {
    pub remote_pid: u32,
    pub ssh_session: Arc<RemoteSshSession>,
    pub channel_id: u32,  // SSH channel identifier for stream reading
}

/// Spawn Claude Code CLI on remote machine via SSH PTY
///
/// # Arguments
/// * `ssh` - SSH session to use for remote execution
/// * `remote_path` - Remote worktree path
/// * `worktree` - Worktree metadata
/// * `task` - Task to execute
/// * `config` - Execution configuration (model, mcp, skills)
///
/// # Returns
/// RemoteProcessHandle for future streaming/attachment
pub async fn spawn_remote_agent_execution(
    ssh: &Arc<RemoteSshSession>,
    remote_path: &str,
    worktree: &Worktree,
    task: &Task,
    config: &ExecutionConfig,
) -> Result<RemoteProcessHandle, String> {
    // Ensure SSH connection is active
    if !ssh.is_connected().await {
        return Err("SSH session not connected".to_string());
    }

    // 1. Build Claude Code CLI command
    let cmd = build_claude_code_command(remote_path, task, config);

    // 2. Execute command on remote host (background process)
    //    Use nohup to keep process running after SSH session closes
    let full_cmd = format!("nohup {} > /tmp/claude-code-{}.log 2>&1 & echo $!",
                           cmd, task.id);

    let output = ssh
        .execute_command(&full_cmd)
        .await
        .map_err(|e| format!("Failed to execute remote command: {}", e))?;

    // 3. Parse remote PID from command output
    let remote_pid: u32 = output
        .trim()
        .parse()
        .map_err(|_| format!("Failed to parse remote PID from output: {}", output))?;

    if remote_pid == 0 {
        return Err("Failed to obtain remote process PID".to_string());
    }

    println!(
        "[Remote] Spawned Claude Code on {} with PID {} in worktree {}",
        remote_path, remote_pid, worktree.branch_name
    );

    Ok(RemoteProcessHandle {
        remote_pid,
        ssh_session: ssh.clone(),
        channel_id: 0,  // Placeholder for channel handle
    })
}

/// Stream remote process output via SSH PTY channel
///
/// Reads from SSH channel in a loop and forwards bytes to callback
/// Continues until channel EOF or error
pub async fn stream_remote_output(
    _handle: &RemoteProcessHandle,
    _output_sender: impl Fn(Vec<u8>) + Send + 'static,
) -> Result<(), String> {
    // 1. Read from SSH channel in loop
    //    - Read available bytes from PTY channel
    //    - Send bytes to output_sender callback
    // 2. output_sender forwards to WebSocket broadcaster
    //    - Bytes appear in real-time on frontend xterm.js
    // 3. Continue reading until channel EOF or process exit
    // 4. Handle SSH channel errors gracefully

    // Placeholder implementation
    Ok(())
}

/// Kill remote process (send SIGTERM)
///
/// Executes kill command on remote host
pub async fn kill_remote_process(handle: &RemoteProcessHandle) -> Result<(), String> {
    // Send SIGTERM to remote PID via separate SSH command channel
    let kill_cmd = format!("kill {}", handle.remote_pid);
    handle
        .ssh_session
        .execute_command(&kill_cmd)
        .await
        .map_err(|e| format!("Failed to kill remote process: {}", e))?;

    println!("[Remote] Killed process {} on remote host", handle.remote_pid);
    Ok(())
}

/// Build Claude Code CLI command string
///
/// Constructs command with task details and configuration overrides
fn build_claude_code_command(
    worktree_path: &str,
    task: &Task,
    config: &ExecutionConfig,
) -> String {
    let mut cmd = format!("cd {} && claude-code", worktree_path);

    // Add task details
    let escaped_desc = task.description.replace('"', "\\\"");
    cmd.push_str(&format!(" --task=\"{}\"", escaped_desc));

    if let Some(ref criteria) = task.acceptance_criteria {
        let escaped_criteria = criteria.replace('"', "\\\"");
        cmd.push_str(&format!(" --criteria=\"{}\"", escaped_criteria));
    }

    // Add configuration overrides
    if let Some(ref model) = config.model_override {
        cmd.push_str(&format!(" --model={}", model));
    }

    if let Some(ref allowlist) = config.mcp_allowlist {
        let mcp_str = allowlist.join(",");
        cmd.push_str(&format!(" --mcp-allowlist={}", mcp_str));
    }

    if let Some(ref skills) = config.skills_override {
        let skills_str = skills.join(",");
        cmd.push_str(&format!(" --skills={}", skills_str));
    }

    cmd
}
