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
    which::which(command).map_err(|_| format!("Command '{}' not found in known locations or PATH — ensure it is installed", command))
}

/// Represents a PTY session with a spawned process
///
/// Stores the task ID, PTY master handle, writer, and child process handle
/// for lifecycle management and I/O operations.
pub struct PtySession {
    pub task_id: i32,
    pub master: Arc<Mutex<Box<dyn portable_pty::MasterPty + Send>>>,
    writer: Arc<Mutex<Box<dyn std::io::Write + Send>>>,
    pub child: Arc<Mutex<Box<dyn portable_pty::Child + Send>>>,
}

/// Spawn an agent CLI process in a pseudo-terminal (PTY)
///
/// Creates a PTY pair, spawns the command in the slave end, and returns
/// a PtySession for management and I/O.
///
/// # Arguments
/// * `task_id` - Task ID for tracking
/// * `command` - Command to execute (e.g., "node")
/// * `args` - Command arguments
/// * `working_dir` - Working directory for the process
///
/// # Returns
/// `Result<PtySession, String>` containing the PTY session or error
pub async fn spawn_agent_cli_pty(
    task_id: i32,
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

    Ok(PtySession {
        task_id,
        master: Arc::new(Mutex::new(pair.master)),
        writer: Arc::new(Mutex::new(writer)),
        child: Arc::new(Mutex::new(child)),
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
