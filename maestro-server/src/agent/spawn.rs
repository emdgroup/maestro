use std::path::Path;
use crate::command_ext::NoConsoleWindow;

/// Spawn an ACP agent as a child subprocess with piped stdin/stdout/stderr.
///
/// `command` is the program name (e.g., "npx", "claude", "/usr/local/bin/agent-acp").
/// `args` is the argument list (e.g., ["@agentclientprotocol/claude-agent-acp"]).
/// `cwd` is the working directory for the subprocess.
///
/// Returns the child process handle with piped stdin/stdout/stderr.
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

    // Prepend our own directory to PATH so agents can call `maestro-server validate-canvas` etc.
    let path_with_server = std::env::current_exe().ok()
        .and_then(|exe| exe.parent().map(|dir| {
            let base = env.get("PATH")
                .cloned()
                .unwrap_or_else(|| std::env::var("PATH").unwrap_or_default());
            let sep = if cfg!(windows) { ";" } else { ":" };
            format!("{}{}{}", dir.display(), sep, base)
        }));

    crate::send_diag("info", format!("[spawn] spawning cmd={command:?} args={args:?} cwd={cwd:?}"));
    let mut cmd = tokio::process::Command::new(command);
    cmd.args(args)
        .current_dir(cwd_path)
        .envs(env);
    if let Some(path) = path_with_server {
        cmd.env("PATH", path);
    }
    let child = cmd
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .no_console_window()
        .spawn()
        .map_err(|e| {
            crate::send_diag("error", format!("[spawn] FAILED cmd={command:?}: {e}"));
            format!("failed to spawn agent '{}': {}", command, e)
        })?;
    crate::send_diag("info", format!("[spawn] ok pid={:?}", child.id()));

    Ok(child)
}
