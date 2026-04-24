use std::path::Path;

/// Spawn an ACP agent as a child subprocess with piped stdin/stdout.
///
/// `command` is the program name (e.g., "npx", "claude", "/usr/local/bin/agent-acp").
/// `args` is the argument list (e.g., ["@agentclientprotocol/claude-agent-acp"]).
/// `cwd` is the working directory for the subprocess.
///
/// Returns the child process handle with piped stdin/stdout.
/// The child is `kill_on_drop(true)` so dropping it kills the subprocess.
pub async fn spawn_agent_subprocess(
    command: &str,
    args: &[String],
    cwd: &str,
    env: &std::collections::HashMap<String, String>,
) -> Result<tokio::process::Child, String> {
    // Reject path traversal via Component::ParentDir (T-42-01)
    // Using Path::components() avoids false positives from substring match (e.g. /my..project)
    let cwd_path = Path::new(cwd);
    for component in cwd_path.components() {
        if component == std::path::Component::ParentDir {
            return Err(format!("cwd contains '..' component: {}", cwd));
        }
    }

    // Validate cwd exists on disk (T-42-01)
    if tokio::fs::metadata(cwd_path).await.is_err() {
        return Err(format!("cwd does not exist: {}", cwd));
    }

    let child = tokio::process::Command::new(command)
        .args(args)
        .current_dir(cwd_path)
        .envs(env)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::inherit()) // agent stderr goes to maestro-server stderr
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("failed to spawn agent '{}': {}", command, e))?;

    Ok(child)
}
