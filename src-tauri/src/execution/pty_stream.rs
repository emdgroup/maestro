use std::sync::Arc;
use tauri::State;

use crate::core::AppState;

/// Attach to a PTY session and stream output to frontend
///
/// Opens a Tauri channel and begins streaming PTY output to the frontend.
/// Optionally prepends terminal history from the execution log (if available).
/// The streaming continues until the PTY process ends or the channel is closed.
///
/// # Arguments
/// * `app_state` - Tauri app state with PTY sessions
/// * `task_id` - Task ID to attach to
/// * `output_channel` - Tauri IPC channel for streaming output
/// * `include_history` - If true, prepend terminal_output from execution log to stream
///
/// # Returns
/// `Result<(), String>` - Ok if streaming started, Err if task not found
///
/// # Behavior
/// When `include_history` is true:
/// 1. Fetches the terminal_output from the most recent execution log
/// 2. Sends entire history as initial message to establish context
/// 3. Then continues streaming live PTY output as normal
/// This ensures the frontend sees the full terminal context when attaching.
#[tauri::command]
#[specta::specta]
pub async fn attach_terminal(
    app_state: State<'_, Arc<AppState>>,
    task_id: i32,
    output_channel: tauri::ipc::Channel<String>,
    include_history: Option<bool>,
) -> Result<(), String> {
    // Check remote SSH PTY sessions first
    let ssh_handle = {
        let sessions = app_state.ssh.pty_sessions.lock().await;
        sessions.get(&task_id).cloned()
    };

    if let Some(handle) = ssh_handle {
        let history = Arc::clone(&handle.history);
        let notify = Arc::clone(&handle.notify);
        let process_ended = Arc::clone(&handle.process_ended);
        let total_drained = Arc::clone(&handle.total_drained);
        let clear_screen_count = Arc::clone(&handle.clear_screen_count);
        let _log_id = handle.log_id;
        let _app_state_arc = (*app_state).clone();

        // Cancel any existing SSH reader for this session. Without this, each re-attach
        // spawns a new reader that fights the old one over the single-slot Notify, causing
        // every other keystroke to be consumed by the stale reader and lost to the UI.
        {
            let mut cancel_map = app_state.pty.attach_cancel.lock().await;
            if let Some(old_flag) = cancel_map.remove(&task_id) {
                old_flag.store(true, std::sync::atomic::Ordering::Relaxed);
            }
        }
        // Wake any reader stuck at notify.notified().await so it can see the cancel flag.
        notify.notify_one();

        // Register cancel flag for the new reader.
        let cancel_flag = Arc::new(std::sync::atomic::AtomicBool::new(false));
        {
            let mut cancel_map = app_state.pty.attach_cancel.lock().await;
            cancel_map.insert(task_id, Arc::clone(&cancel_flag));
        }

        tokio::spawn(async move {
            use std::sync::atomic::Ordering;
            let is_dead = process_ended.load(Ordering::Acquire);

            if is_dead {
                // Dead session: replay in-memory history if available.
                let text = {
                    let hist = history.lock().await;
                    if !hist.is_empty() { Some(hist.clone()) } else { None }
                };
                if let Some(text) = text {
                    if !text.is_empty() {
                        let _ = output_channel.send(text);
                    }
                }
                return;
            }

            // Live session: replay full history from pos=0.
            // append_to_history trims to after the last \x1b[2J so replaying from 0
            // gives the minimal data needed to reconstruct the current screen state.
            // SIGWINCH alone is insufficient for shells (only redraws the prompt line).
            let mut pos: usize = 0;
            // Snapshot drain counter so we can detect front-drains on each iteration.
            // Initialising to the *current* value means the initial replay (pos=0) is
            // not perturbed by drains that happened before this attach.
            let mut last_drained: usize = total_drained.load(Ordering::Acquire);
            // Snapshot clear-screen counter. When this advances the history buffer was
            // completely replaced; pos must reset to 0 or it will point mid-sequence into
            // the new buffer, causing partial escape sequences (e.g. `?2026l` without
            // the leading `\x1b[`) to reach the frontend as literal printable characters.
            let mut last_clear_screen: usize = clear_screen_count.load(Ordering::Acquire);

            loop {
                {
                    let hist = history.lock().await;

                    // Clear-screen guard: history was fully replaced (e.g. `clear` cmd sends
                    // \x1b[2J). Must be checked before the drain adjustment because a
                    // clear-screen is not a front-drain — total_drained does not advance.
                    let now_clear = clear_screen_count.load(Ordering::Acquire);
                    if now_clear != last_clear_screen {
                        pos = 0;
                        last_clear_screen = now_clear;
                    }

                    // Adjust pos for any bytes removed from the front of the history buffer
                    // since the last iteration (512 KB cap drain). Without this correction
                    // pos ends up at a wrong — and possibly non-char-boundary — offset,
                    // causing a panic or silently skipping all future output.
                    let now_drained = total_drained.load(Ordering::Acquire);
                    let drain_delta = now_drained.wrapping_sub(last_drained);
                    if drain_delta > 0 {
                        pos = pos.saturating_sub(drain_delta);
                        // Snap to a valid UTF-8 char boundary (walk back ≤3 bytes).
                        while pos > 0 && !hist.is_char_boundary(pos) {
                            pos -= 1;
                        }
                        last_drained = now_drained;
                    }

                    // Fallback bounds guard.
                    if pos > hist.len() {
                        pos = 0;
                    }

                    if pos < hist.len() {
                        let slice = &hist[pos..];
                        if !slice.is_empty() {
                            if output_channel.send(slice.to_string()).is_err() {
                                return;
                            }
                            pos = hist.len();
                        }
                    }
                }
                // Check cancel flag — set when a new attach replaces this reader.
                if cancel_flag.load(Ordering::Relaxed) {
                    return;
                }
                // Check process_ended after draining
                if process_ended.load(Ordering::Acquire) {
                    // Final drain after process ended
                    let hist = history.lock().await;
                    let now_drained = total_drained.load(Ordering::Acquire);
                    let drain_delta = now_drained.wrapping_sub(last_drained);
                    if drain_delta > 0 {
                        pos = pos.saturating_sub(drain_delta);
                        while pos > 0 && !hist.is_char_boundary(pos) {
                            pos -= 1;
                        }
                    }
                    if pos > hist.len() {
                        pos = 0;
                    }
                    if pos < hist.len() {
                        let slice = &hist[pos..];
                        if !slice.is_empty() {
                            let _ = output_channel.send(slice.to_string());
                        }
                    }
                    drop(hist);
                    break;
                }
                notify.notified().await;
                // Re-check cancel immediately after waking — we may have been woken
                // specifically to exit (new attach called notify_one() to wake us).
                if cancel_flag.load(Ordering::Relaxed) {
                    return;
                }
            }
        });
        return Ok(());
    }

    // Get local PTY session from AppState
    let session = {
        let sessions = app_state.pty.sessions.lock().await;
        sessions.get(&task_id).cloned()
    };

    let session = session.ok_or_else(|| format!("No active PTY session for task {}", task_id))?;
    let _ = include_history; // history is in-memory only; no DB fallback

    let _app_state_arc = (*app_state).clone();

    // Cancel any existing reader for this task (handles re-attach without explicit detach)
    {
        let mut cancel_map = app_state.pty.attach_cancel.lock().await;
        if let Some(old_flag) = cancel_map.remove(&task_id) {
            old_flag.store(true, std::sync::atomic::Ordering::Relaxed);
        }
    }

    // Create cancel flag for the new reader task
    let cancel_flag = Arc::new(std::sync::atomic::AtomicBool::new(false));
    {
        let mut cancel_map = app_state.pty.attach_cancel.lock().await;
        cancel_map.insert(task_id, Arc::clone(&cancel_flag));
    }

    // Spawn background task to stream PTY output
    tokio::spawn(async move {
        let (tx, mut rx) = tokio::sync::mpsc::channel::<String>(100);

        // Acquire the PTY reader before entering spawn_blocking — try_clone_reader() needs async locks.
        // Drop guards explicitly so they don't straddle an await point.
        let reader = {
            let session_lock = session.lock().await;
            let master = session_lock.master.lock().await;
            let result = master.try_clone_reader();
            drop(master);
            drop(session_lock);
            match result {
                Ok(r) => r,
                Err(e) => {
                    let _ = output_channel.send(
                        format!("\r\n\x1b[31m[Terminal error: {}]\x1b[0m\r\n", e)
                    );
                    return;
                }
            }
        };

        // Sender runs concurrently with the reader, forwarding output to the frontend in real time.
        // It also accumulates output for DB persistence once the session ends.
        let sender_task = tokio::spawn(async move {
            let mut accumulated = String::new();
            while let Some(output) = rx.recv().await {
                accumulated.push_str(&output);
                if output_channel.send(output).is_err() {
                    break;
                }
            }
            accumulated
        });

        // PTY reader in a blocking thread — std::io::Read::read() is a blocking syscall and
        // must not run on the tokio async thread pool (it would block a worker thread indefinitely).
        let tx_reader = tx.clone();
        let cancel_flag_reader = Arc::clone(&cancel_flag);
        let reader_task = tokio::task::spawn_blocking(move || {
            use std::io::Read;
            let mut reader = reader;
            let mut buf = [0u8; 4096];
            loop {
                if cancel_flag_reader.load(std::sync::atomic::Ordering::Relaxed) {
                    break;
                }
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let output = String::from_utf8_lossy(&buf[..n]).to_string();
                        if tx_reader.blocking_send(output).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        });

        // Wait for the reader to finish (PTY EOF = process exited)
        let _ = reader_task.await;

        // Check exit code while session is still available
        let exit_code: Option<u32> = {
            let sess = session.lock().await;
            let mut child = sess.child.lock().await;
            child.try_wait().ok().flatten().map(|s| s.exit_code())
        };

        // Send exit notification through the mpsc channel so sender_task forwards it to the frontend
        let exit_msg = match exit_code {
            Some(0) => "\r\n\x1b[32m[Process exited]\x1b[0m\r\n".to_string(),
            Some(code) => format!("\r\n\x1b[31m[Process exited with code {}]\x1b[0m\r\n", code),
            None => "\r\n\x1b[33m[Process ended]\x1b[0m\r\n".to_string(),
        };
        let _ = tx.send(exit_msg).await;
        drop(tx); // both senders now dropped — sender_task drains exit_msg then finishes

        // Wait for sender to flush everything including the exit message
        let _ = sender_task.await;
    });

    Ok(())
}
