use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::sync::Arc;
use std::collections::VecDeque;
use tokio::sync::Mutex;

/// Circular buffer for storing PTY output history
///
/// Stores the most recent lines of PTY output (up to max_lines).
/// When capacity is reached, oldest lines are dropped.
pub struct CircularBuffer {
    max_lines: usize,
    lines: VecDeque<String>,
}

impl CircularBuffer {
    /// Create a new circular buffer with specified capacity
    ///
    /// # Arguments
    /// * `max_lines` - Maximum number of lines to store
    pub fn new(max_lines: usize) -> Self {
        CircularBuffer {
            max_lines,
            lines: VecDeque::with_capacity(max_lines),
        }
    }

    /// Append a line to the buffer
    ///
    /// If buffer is at capacity, removes the oldest line first.
    pub fn append(&mut self, line: String) {
        if self.lines.len() >= self.max_lines {
            self.lines.pop_front();
        }
        self.lines.push_back(line);
    }

    /// Get all lines as a single string (joined with newlines)
    pub fn get_all(&self) -> String {
        self.lines.iter().cloned().collect::<Vec<_>>().join("\n")
    }

    /// Get number of lines currently in buffer
    pub fn len(&self) -> usize {
        self.lines.len()
    }

    /// Check if buffer is empty
    pub fn is_empty(&self) -> bool {
        self.lines.is_empty()
    }
}

/// Represents a PTY session with a spawned process
///
/// Stores the task ID, PTY master handle, and child process handle
/// for lifecycle management and I/O operations.
pub struct PtySession {
    pub task_id: i32,
    pub master: Arc<Mutex<Box<dyn portable_pty::MasterPty + Send>>>,
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
    let _child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("Failed to spawn command in PTY: {}", e))?;

    println!(
        "[PTY] Spawned process for task {} with command: {} in PTY",
        task_id, command
    );

    Ok(PtySession {
        task_id,
        master: Arc::new(Mutex::new(pair.master)),
    })
}

impl PtySession {
    /// Write input to the PTY
    ///
    /// Sends data to the PTY master, which is delivered to the child process stdin.
    pub async fn write_input(&self, data: &[u8]) -> Result<(), String> {
        let master = self.master.lock().await;

        // Get the writer from the master
        let mut writer = master
            .take_writer()
            .map_err(|e| format!("Failed to get PTY writer: {}", e))?;

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
