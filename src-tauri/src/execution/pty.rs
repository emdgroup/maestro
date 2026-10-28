use crate::connectivity::ssh::history::{append_to_history, PtyOutput};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::Mutex;

/// Resolve a command name to an absolute path.
///
/// Checks well-known user-local installation paths before falling back to
/// `which` (PATH-based resolution). Using an absolute path avoids spawning
/// a process by bare name after PATH enrichment, which EDR products flag as
/// a RAT/reverse-shell pattern.
fn resolve_command_path(command: &str) -> Result<PathBuf, String> {
    // Skip resolution if already an absolute path
    let p = PathBuf::from(command);
    if p.is_absolute() {
        return Ok(p);
    }

    #[cfg(not(windows))]
    {
        let home = std::env::var("HOME").unwrap_or_default();
        let candidates = [
            format!("{}/.local/bin/{}", home, command),
            format!("{}/.cargo/bin/{}", home, command),
            "/usr/local/bin/".to_string() + command,
            "/usr/bin/".to_string() + command,
        ];
        for candidate in &candidates {
            let path = PathBuf::from(candidate);
            if path.exists() {
                return Ok(path);
            }
        }
    }

    #[cfg(windows)]
    {
        let profile = std::env::var("USERPROFILE").unwrap_or_default();
        let candidates = [
            format!("{}\\.local\\bin\\{}.exe", profile, command),
            format!("{}\\AppData\\Local\\Programs\\{}.exe", profile, command),
        ];
        for candidate in &candidates {
            let path = PathBuf::from(candidate);
            if path.exists() {
                return Ok(path);
            }
        }
    }

    // Fall back to PATH-based resolution
    which::which(command).map_err(|_| {
        format!(
            "Command '{}' not found in known locations or PATH, ensure it is installed",
            command
        )
    })
}

/// Represents a PTY session with a spawned process
///
/// Stores the task ID, PTY master handle, writer, and child process handle
/// for lifecycle management and I/O operations.
pub struct PtySession {
    pub session_id: String,
    pub master: Arc<Mutex<Box<dyn portable_pty::MasterPty + Send>>>,
    writer: Arc<Mutex<Box<dyn std::io::Write + Send>>>,
    pub child: Arc<Mutex<Box<dyn portable_pty::Child + Send>>>,
    pub output: PtyOutput,
}

/// Spawn a user-controlled shell process in a pseudo-terminal (PTY).
///
/// Creates a PTY pair, spawns the command in the slave end, and returns
/// a PtySession for terminal lifecycle and I/O. Managed AI agents are
/// started through ACP instead of this PTY path.
///
/// The function name is retained for Rust API compatibility; it now spawns
/// the caller-provided shell command, not a managed agent CLI.
///
/// # Arguments
/// * `session_id` - Session key for tracking
/// * `command` - Command to execute (e.g., "node")
/// * `args` - Command arguments
/// * `working_dir` - Working directory for the process
///
/// # Returns
/// `Result<PtySession, String>` containing the PTY session or error
pub async fn spawn_agent_cli_pty(
    session_id: &str,
    command: String,
    args: Vec<String>,
    working_dir: std::path::PathBuf,
) -> Result<PtySession, String> {
    // Get the native PTY system for the current platform
    let pty_system = native_pty_system();

    // Create a PTY pair with standard terminal dimensions
    let pair = pty_system
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Failed to create PTY pair: {}", e))?;

    // Resolve to an absolute path before spawning. Spawning by bare name after
    // PATH enrichment is flagged by EDR products (e.g. SentinelOne) as a RAT/C2
    // pattern. Using a known absolute path eliminates that heuristic signal.
    let resolved = resolve_command_path(&command)?;

    let mut cmd = CommandBuilder::new(&resolved);
    for arg in args {
        cmd.arg(arg);
    }
    cmd.cwd(working_dir);

    // Set TERM so the child process knows it's in an interactive terminal.
    // portable-pty does not set TERM by default (unlike node-pty which sets it via `name`).
    // Without TERM=xterm-256color, many CLI tools (including claude) skip interactive mode.
    cmd.env("TERM", "xterm-256color");

    // Enrich the child's PATH so tools it invokes (npm, cargo, nvm, etc.) are
    // found. This is scoped to the child environment only — the parent process
    // PATH is not modified, which avoids an EDR heuristic for PATH hijacking.
    #[cfg(not(windows))]
    let home_var = "HOME";
    #[cfg(windows)]
    let home_var = "USERPROFILE";

    if let Ok(home) = std::env::var(home_var) {
        let current_path = std::env::var("PATH").unwrap_or_default();

        #[cfg(not(windows))]
        let extra = [
            format!("{}/.local/bin", home),
            format!("{}/.cargo/bin", home),
            "/usr/local/bin".to_string(),
        ];
        #[cfg(windows)]
        let extra = [
            format!("{}\\.local\\bin", home),
            format!("{}\\AppData\\Local\\Programs", home),
        ];

        let mut paths: Vec<String> = extra
            .iter()
            .filter(|p| !current_path.contains(p.as_str()))
            .cloned()
            .collect();
        paths.push(current_path);

        #[cfg(not(windows))]
        cmd.env("PATH", paths.join(":"));
        #[cfg(windows)]
        cmd.env("PATH", paths.join(";"));
    }

    // Spawn the command in the PTY slave end
    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("Failed to spawn command in PTY: {}", e))?;

    // Create the writer once and store it — take_writer() creates an OS fd clone each call
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("Failed to get PTY writer: {}", e))?;

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("Failed to get PTY reader: {}", e))?;

    let child: Arc<Mutex<Box<dyn portable_pty::Child + Send>>> = Arc::new(Mutex::new(child));
    let output = PtyOutput::default();

    // One reader for the session's whole life, so output produced while no terminal view is
    // mounted lands in history for the next attach to replay. std::io::Read is blocking, hence
    // a thread rather than a task.
    std::thread::spawn({
        let output = output.clone();
        let child = Arc::clone(&child);
        move || {
            use std::io::Read;
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let text = String::from_utf8_lossy(&buf[..n]).to_string();
                        let result = append_to_history(&mut output.history.blocking_lock(), &text);
                        output.appended(result);
                    }
                }
            }
            let exit_code = child
                .blocking_lock()
                .try_wait()
                .ok()
                .flatten()
                .map(|s| s.exit_code());
            let exit_msg = match exit_code {
                Some(0) => "\r\n\x1b[32m[Process exited]\x1b[0m\r\n".to_string(),
                Some(code) => format!("\r\n\x1b[31m[Process exited with code {}]\x1b[0m\r\n", code),
                None => "\r\n\x1b[33m[Process ended]\x1b[0m\r\n".to_string(),
            };
            let result = append_to_history(&mut output.history.blocking_lock(), &exit_msg);
            output.appended(result);
            output.end();
        }
    });

    Ok(PtySession {
        session_id: session_id.to_string(),
        master: Arc::new(Mutex::new(pair.master)),
        writer: Arc::new(Mutex::new(writer)),
        child,
        output,
    })
}

impl PtySession {
    /// Write input to the PTY
    ///
    /// Sends data to the PTY master, which is delivered to the child process stdin.
    pub async fn write_input(&self, data: &[u8]) -> Result<(), String> {
        let mut writer = self.writer.lock().await;
        use std::io::Write;
        writer
            .write_all(data)
            .map_err(|e| format!("Failed to write to PTY: {}", e))
    }

    /// Resize the PTY dimensions
    ///
    /// Propagates the new terminal size to the child process via SIGWINCH.
    pub async fn resize_pty(&self, cols: u16, rows: u16) -> Result<(), String> {
        let master = self.master.lock().await;

        master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("Failed to resize PTY: {}", e))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn wait_for(session: &PtySession, needle: &str) {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while !session.output.history.lock().await.contains(needle) {
            assert!(
                std::time::Instant::now() < deadline,
                "history: {:?}",
                session.output.history.lock().await
            );
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    }

    #[tokio::test]
    async fn output_is_kept_with_no_terminal_attached() {
        #[cfg(windows)]
        let shell = "cmd";
        #[cfg(not(windows))]
        let shell = "sh";
        let session = spawn_agent_cli_pty("test", shell.to_string(), vec![], std::env::temp_dir())
            .await
            .expect("spawn");

        // ConPTY asks for the cursor position and renders nothing until it is answered, which
        // is xterm's job when a view is attached.
        #[cfg(windows)]
        {
            wait_for(&session, "\x1b[6n").await;
            session.write_input(b"\x1b[1;1R").await.expect("answer");
        }

        session
            .write_input(b"echo pty-history\r")
            .await
            .expect("write");
        // The command's output line, not the shell's echo of what was typed.
        wait_for(&session, "\r\npty-history").await;
        session.write_input(b"exit\r").await.expect("exit");
    }
}
