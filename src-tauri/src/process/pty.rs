use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::sync::Arc;
use tokio::sync::Mutex;

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

    // Build the command to spawn
    let mut cmd = CommandBuilder::new(&command);
    for arg in args {
        cmd.arg(arg);
    }
    cmd.cwd(working_dir);

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

    println!(
        "[PTY] Spawned process for task {} with command: {} in PTY",
        task_id, command
    );

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
