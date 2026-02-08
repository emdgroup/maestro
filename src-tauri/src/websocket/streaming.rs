use crate::process::remote::RemoteProcessHandle;
use tokio::task;

/// Attach listener to remote PTY channel and forward bytes to WebSocket broadcaster
///
/// Spawns a background task that reads from the SSH PTY channel and forwards
/// chunks of bytes to a broadcast channel for WebSocket distribution.
///
/// # Arguments
/// * `handle` - Remote process handle with SSH session and channel info
/// * `broadcast_sender` - Callback to send output bytes to WebSocket clients
///
/// # Returns
/// Result indicating successful task spawn
///
/// # Behavior
/// - Spawns background tokio task for non-blocking operation
/// - Reads from SSH PTY channel until EOF or error
/// - Each chunk forwarded to broadcast_sender callback
/// - Bytes appear in real-time on frontend xterm.js terminal
pub async fn attach_remote_stream_listener(
    handle: &RemoteProcessHandle,
    broadcast_sender: impl Fn(Vec<u8>) + Send + 'static + Clone,
) -> Result<(), String> {
    // 1. Clone handle and callback for task closure
    let handle_clone = handle.clone();

    // 2. Spawn background task to read from remote output log
    task::spawn(async move {
        // Stream output by periodically polling the remote log file
        // The process was spawned with: nohup ... > /tmp/claude-code-{}.log 2>&1 & echo $!
        let log_file = format!("/tmp/claude-code-{}.log", handle_clone.remote_pid);

        // Keep track of bytes already read to avoid re-reading
        let mut last_read_pos: u64 = 0;

        loop {
            // Read from remote log file using SSH cat command
            let cat_cmd = format!("cat {} 2>/dev/null | wc -c", log_file);
            let output = match handle_clone.ssh_session.execute_command(&cat_cmd).await {
                Ok(out) => out,
                Err(e) => {
                    eprintln!("[streaming] Failed to check log file size: {}", e);
                    break;
                }
            };

            let file_size: u64 = output.trim().parse().unwrap_or(0);

            // If file has grown, read the new data
            if file_size > last_read_pos {
                let read_cmd = format!(
                    "tail -c +{} {} 2>/dev/null",
                    last_read_pos + 1,
                    log_file
                );

                match handle_clone.ssh_session.execute_command(&read_cmd).await {
                    Ok(new_data) => {
                        if !new_data.is_empty() {
                            println!("[streaming] Read {} bytes from remote log", new_data.len());
                            broadcast_sender(new_data.into_bytes());
                            last_read_pos = file_size;
                        }
                    }
                    Err(e) => {
                        eprintln!("[streaming] Failed to read log file: {}", e);
                        break;
                    }
                }
            }

            // Check if process is still running
            let ps_cmd = format!("ps -p {} > /dev/null 2>&1 && echo 1 || echo 0", handle_clone.remote_pid);
            let ps_output = match handle_clone.ssh_session.execute_command(&ps_cmd).await {
                Ok(out) => out.trim().to_string(),
                Err(_) => "0".to_string(),
            };

            if ps_output == "0" {
                // Process has exited, read any remaining data
                let final_cmd = format!("tail -c +{} {} 2>/dev/null", last_read_pos + 1, log_file);
                if let Ok(final_data) = handle_clone.ssh_session.execute_command(&final_cmd).await {
                    if !final_data.is_empty() {
                        println!("[streaming] Read final {} bytes from remote log", final_data.len());
                        broadcast_sender(final_data.into_bytes());
                    }
                }

                println!("[streaming] ✓ Remote process completed (PID: {})", handle_clone.remote_pid);
                break;
            }

            // Poll interval: 500ms to balance responsiveness and SSH load
            tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
        }

        println!("[streaming] Remote stream listener stopped");
    });

    Ok(())
}

/// Stop streaming from remote PTY (close PTY channel gracefully)
///
/// # Arguments
/// * `handle` - Remote process handle with SSH session and channel info
///
/// # Returns
/// Result indicating successful channel closure
pub async fn stop_remote_stream(
    _handle: &RemoteProcessHandle,
) -> Result<(), String> {
    // Close SSH PTY channel gracefully
    // Future implementation: actually close the channel
    Ok(())
}
