use std::sync::Arc;
use tauri::{Emitter, State};

use crate::connectivity::ssh::SshWriteOp;
use crate::core::AppState;

/// Send input to a PTY session
///
/// Writes data to the PTY master, which is delivered to the child process stdin.
/// Supports special control sequences:
/// - "\x03" (Ctrl+C) → sends SIGINT signal (interrupt) via PTY layer
/// - "\x1a" (Ctrl+Z) → sends SIGTSTP signal (suspend) via PTY layer
/// - Regular text and newlines → written directly to PTY stdin
///
/// The PTY layer automatically converts control sequences to signals that are
/// delivered to the foreground process group.
///
/// # Arguments
/// * `app_state` - Tauri app state with PTY sessions
/// * `task_id` - Task ID of the PTY session
/// * `input` - Data to send to the PTY (can be control sequences or regular text)
///
/// # Returns
/// `Result<(), String>` - Ok if input sent, Err if session not found or write failed
///
/// # Examples
/// - Regular text: "ls -la\n" → written to stdin
/// - Ctrl+C: "\x03" → converted to SIGINT by PTY layer
/// - Ctrl+Z: "\x1a" → converted to SIGTSTP by PTY layer
#[tauri::command]
#[specta::specta]
pub async fn send_terminal_input(
    app_state: State<'_, Arc<AppState>>,
    task_id: i32,
    input: String,
) -> Result<(), String> {
    // Check remote SSH PTY sessions first
    let ssh_handle = {
        let sessions = app_state.ssh.pty_sessions.lock().await;
        sessions.get(&task_id).cloned()
    };

    if let Some(handle) = ssh_handle {
        handle
            .write_tx
            .send(SshWriteOp::Data(input.into_bytes()))
            .await
            .map_err(|e| format!("Failed to send input to remote PTY: {}", e))?;
        return Ok(());
    }

    let sessions = app_state.pty.sessions.lock().await;
    let session = sessions
        .get(&task_id)
        .ok_or_else(|| format!("No PTY session for task {}", task_id))?
        .clone();
    drop(sessions);

    // Write directly to PTY - the PTY layer handles conversion of control sequences to signals
    let session_lock = session.lock().await;
    session_lock.write_input(input.as_bytes()).await
}

/// Resize a PTY session to new dimensions
///
/// Changes the terminal size and sends SIGWINCH to the PTY process.
/// Used when the frontend terminal is resized.
///
/// # Arguments
/// * `app_state` - Tauri app state with PTY sessions
/// * `task_id` - Task ID of the PTY session
/// * `cols` - New column width
/// * `rows` - New row height
///
/// # Returns
/// `Result<(), String>` - Ok if resized, Err if session not found or resize failed
#[tauri::command]
#[specta::specta]
pub async fn resize_terminal(
    app_state: State<'_, Arc<AppState>>,
    task_id: i32,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    // Check remote SSH PTY sessions first
    let ssh_handle = {
        let sessions = app_state.ssh.pty_sessions.lock().await;
        sessions.get(&task_id).cloned()
    };

    if let Some(handle) = ssh_handle {
        let _ = handle
            .write_tx
            .send(SshWriteOp::Resize(cols as u32, rows as u32))
            .await;
        return Ok(());
    }

    let sessions = app_state.pty.sessions.lock().await;
    let session = sessions
        .get(&task_id)
        .ok_or_else(|| format!("No PTY session for task {}", task_id))?
        .clone();
    drop(sessions);

    let session_lock = session.lock().await;
    session_lock.resize_pty(cols, rows).await
}

/// Detach from a PTY session
///
/// Cancels the active local PTY reader task for the given task_id by setting its
/// AtomicBool cancel flag. This stops the spawn_blocking reader on the next iteration,
/// preventing a stale reader from racing with a new attach_terminal call.
#[tauri::command]
#[specta::specta]
pub async fn detach_terminal(
    app_state: State<'_, Arc<AppState>>,
    task_id: i32,
) -> Result<(), String> {
    let mut cancel_map = app_state.pty.attach_cancel.lock().await;
    if let Some(flag) = cancel_map.remove(&task_id) {
        flag.store(true, std::sync::atomic::Ordering::Relaxed);
    }
    Ok(())
}

/// Close and clean up a PTY session entirely.
///
/// Cancels the attach reader, kills the child process (local) or drops the write channel
/// (remote SSH), removes all session state, and emits `sessions-changed` so the frontend
/// removes it from the list.
#[tauri::command]
#[specta::specta]
pub async fn close_pty_session(
    app_state: State<'_, Arc<AppState>>,
    session_key: i32,
) -> Result<(), String> {
    // Cancel any active attach reader
    {
        let mut cancel_map = app_state.pty.attach_cancel.lock().await;
        if let Some(flag) = cancel_map.remove(&session_key) {
            flag.store(true, std::sync::atomic::Ordering::Relaxed);
        }
    }

    // Remove local PTY session (dropping PtySession kills the child process)
    app_state.pty.sessions.lock().await.remove(&session_key);

    // Remove remote SSH PTY session (dropping SshPtyHandle closes the write channel)
    app_state.ssh.pty_sessions.lock().await.remove(&session_key);

    // Remove session metadata so get_active_sessions no longer lists it
    app_state.pty.session_meta.lock().await.remove(&session_key);

    app_state.app_handle.emit("sessions-changed", ()).ok();
    Ok(())
}
