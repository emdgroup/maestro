use crate::process::remote::RemoteProcessHandle;

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
    let ssh = handle.ssh_session.clone();
    let pid = handle.remote_pid;
    tokio::task::spawn(async move {
        crate::process::remote::poll_remote_log(&ssh, pid, broadcast_sender).await;
    });
    Ok(())
}

/// Stop streaming from remote PTY by killing the remote process.
///
/// Kills the remote process, which causes the background polling loop in
/// attach_remote_stream_listener to detect EOF and stop naturally.
///
/// # Arguments
/// * `handle` - Remote process handle with SSH session and channel info
///
/// # Returns
/// Result indicating successful process termination
pub async fn stop_remote_stream(
    handle: &RemoteProcessHandle,
) -> Result<(), String> {
    // Kill the remote process — the poll loop in attach_remote_stream_listener
    // will detect the process exit and stop naturally.
    crate::process::remote::kill_remote_process(handle).await
}
