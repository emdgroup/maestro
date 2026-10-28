use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::State;

use crate::connectivity::ssh::history::PtyOutput;
use crate::core::AppState;

/// Attach to a PTY session and stream output to frontend
///
/// Replays the session's history, then streams live output, until the process ends or the
/// channel is closed. Local and remote SSH sessions both keep their output in a `PtyOutput`
/// for their whole life, so a terminal view mounted again after switching sessions gets the
/// screen back rather than starting blank.
///
/// # Arguments
/// * `app_state` - Tauri app state with PTY sessions
/// * `session_id` - Session key to attach to
/// * `output_channel` - Tauri IPC channel for streaming output
/// * `include_history` - Unused; history is always replayed
///
/// # Returns
/// `Result<(), String>` - Ok if streaming started, Err if session not found
#[tauri::command]
#[specta::specta]
pub async fn attach_terminal(
    app_state: State<'_, Arc<AppState>>,
    session_id: String,
    output_channel: tauri::ipc::Channel<String>,
    include_history: Option<bool>,
) -> Result<(), String> {
    let _ = include_history;

    let ssh_output = {
        let sessions = app_state.ssh.pty_sessions.lock().await;
        sessions
            .get(&session_id)
            .map(|handle| handle.output.clone())
    };
    let output = match ssh_output {
        Some(output) => output,
        None => {
            let session = {
                let sessions = app_state.pty.sessions.lock().await;
                sessions.get(&session_id).cloned()
            }
            .ok_or_else(|| format!("No active PTY session {}", session_id))?;
            let output = session.lock().await.output.clone();
            output
        }
    };

    // Cancel any existing reader for this session. Without this, each re-attach spawns a new
    // reader that fights the old one over the single-slot Notify, causing every other keystroke
    // to be consumed by the stale reader and lost to the UI.
    {
        let mut cancel_map = app_state.pty.attach_cancel.lock().await;
        if let Some(old_flag) = cancel_map.remove(&session_id) {
            old_flag.store(true, Ordering::Relaxed);
        }
    }
    // Wake any reader stuck at notify.notified().await so it can see the cancel flag.
    output.notify.notify_one();

    let cancel_flag = Arc::new(AtomicBool::new(false));
    {
        let mut cancel_map = app_state.pty.attach_cancel.lock().await;
        cancel_map.insert(session_id.clone(), Arc::clone(&cancel_flag));
    }

    tokio::spawn(stream_output(output, cancel_flag, output_channel));
    Ok(())
}

async fn stream_output(
    output: PtyOutput,
    cancel_flag: Arc<AtomicBool>,
    output_channel: tauri::ipc::Channel<String>,
) {
    let PtyOutput {
        history,
        notify,
        process_ended,
        total_drained,
        clear_screen_count,
    } = output;

    if process_ended.load(Ordering::Acquire) {
        let text = history.lock().await.clone();
        if !text.is_empty() {
            let _ = output_channel.send(text);
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
                if output_channel.send(hist[pos..].to_string()).is_err() {
                    return;
                }
                pos = hist.len();
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
                let _ = output_channel.send(hist[pos..].to_string());
            }
            return;
        }
        notify.notified().await;
        // Re-check cancel immediately after waking — we may have been woken
        // specifically to exit (new attach called notify_one() to wake us).
        if cancel_flag.load(Ordering::Relaxed) {
            return;
        }
    }
}
