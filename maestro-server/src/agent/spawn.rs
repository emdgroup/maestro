use crate::command_ext::NoConsoleWindow;
use std::path::Path;

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

    let executable = if Path::new(command).components().count() == 1 {
        crate::tool_check::resolve_tool_path(command).await?
    } else {
        Path::new(command).to_path_buf()
    };

    // Include the launcher directory for sibling runtimes and our directory for canvas validation.
    let mut path_entries = Vec::new();
    if let Ok(server) = std::env::current_exe() {
        if let Some(parent) = server.parent() {
            path_entries.push(parent.to_path_buf());
        }
    }
    if let Some(parent) = executable.parent() {
        path_entries.push(parent.to_path_buf());
    }
    let base_path = env
        .get("PATH")
        .map(String::as_str)
        .map(std::ffi::OsString::from)
        .or_else(|| std::env::var_os("PATH"));
    if let Some(base) = base_path {
        path_entries.extend(std::env::split_paths(&base));
    }
    let child_path = std::env::join_paths(path_entries).ok();

    crate::send_diag(
        "info",
        format!("[spawn] spawning cmd={executable:?} args={args:?} cwd={cwd:?}"),
    );
    #[cfg(windows)]
    let mut cmd = {
        let extension = executable
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        if extension.eq_ignore_ascii_case("cmd") || extension.eq_ignore_ascii_case("bat") {
            let mut cmd = tokio::process::Command::new(
                std::env::var_os("COMSPEC").unwrap_or_else(|| "cmd.exe".into()),
            );
            cmd.arg("/d").arg("/c").arg(&executable);
            cmd
        } else {
            tokio::process::Command::new(&executable)
        }
    };
    #[cfg(not(windows))]
    let mut cmd = tokio::process::Command::new(&executable);
    cmd.args(args).current_dir(cwd_path).envs(env);
    // Marks this agent as running inside Maestro. The `maestro-` skills are installed globally, so
    // they are also in context when the user runs the same agent from a plain terminal, where none
    // of what they describe — canvas surfaces, Mermaid rendering, `validate-canvas` — exists. This
    // is what those skills gate on. Set after `envs()` so a caller cannot clear it.
    cmd.env("MAESTRO_SESSION", "1");
    if let Some(path) = child_path {
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
            crate::send_diag("error", format!("[spawn] FAILED cmd={executable:?}: {e}"));
            format!("failed to spawn agent '{}': {}", command, e)
        })?;
    crate::send_diag("info", format!("[spawn] ok pid={:?}", child.id()));

    Ok(child)
}
