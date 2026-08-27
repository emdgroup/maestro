//! Reading and stopping a remote agent process over SSH.
//!
//! Spawning does not happen here — managed sessions go through ACP and `maestro-server` on every
//! connection type. What is left is what `streaming.rs` needs to attach to a process that is
//! already running: its handle, a log tail, and a kill.

use crate::connectivity::ssh::RemoteSshSession;
use std::sync::Arc;

/// Handle to a remote process executing via SSH PTY
#[derive(Debug, Clone)]
pub struct RemoteProcessHandle {
    pub remote_pid: u32,
    pub ssh_session: Arc<RemoteSshSession>,
    pub channel_id: u32,  // SSH channel identifier for stream reading
}

/// Poll a remote log file and forward new bytes to a callback until the process exits.
///
/// Used by `streaming::attach_remote_stream_listener`.
pub async fn poll_remote_log(
    ssh_session: &Arc<RemoteSshSession>,
    remote_pid: u32,
    output_sender: impl Fn(Vec<u8>),
) {
    let log_file = format!("/tmp/claude-code-{}.log", remote_pid);
    let mut last_read_pos: u64 = 0;

    loop {
        let cat_cmd = format!("cat {} 2>/dev/null | wc -c", log_file);
        let output = match ssh_session.execute_command(&cat_cmd).await {
            Ok(out) => out,
            Err(_e) => {
                break;
            }
        };

        let file_size: u64 = output.trim().parse().unwrap_or(0);

        if file_size > last_read_pos {
            let read_cmd = format!("tail -c +{} {} 2>/dev/null", last_read_pos + 1, log_file);
            match ssh_session.execute_command(&read_cmd).await {
                Ok(new_data) => {
                    if !new_data.is_empty() {
                        output_sender(new_data.into_bytes());
                        last_read_pos = file_size;
                    }
                }
                Err(_e) => {
                    break;
                }
            }
        }

        let ps_cmd = format!("ps -p {} > /dev/null 2>&1 && echo 1 || echo 0", remote_pid);
        let ps_output = match ssh_session.execute_command(&ps_cmd).await {
            Ok(out) => out.trim().to_string(),
            Err(_) => "0".to_string(),
        };

        if ps_output == "0" {
            let final_cmd = format!("tail -c +{} {} 2>/dev/null", last_read_pos + 1, log_file);
            if let Ok(final_data) = ssh_session.execute_command(&final_cmd).await {
                if !final_data.is_empty() {
                    output_sender(final_data.into_bytes());
                }
            }
            break;
        }

        tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
    }
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

    Ok(())
}
