#[derive(Debug, Clone)]
pub struct ProcessOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
    pub success: bool,
    pub remote_pid: Option<u32>,  // PID of remote process (for SSH execution)
    pub is_remote: bool,           // Flag indicating remote execution
}
