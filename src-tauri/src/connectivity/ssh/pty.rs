use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use russh::ChannelMsg;
use crate::connectivity::ssh::history::{append_to_history, SshPtyHandle};
use crate::connectivity::ssh::session::RemoteSshSession;

/// Operation sent to the SSH PTY writer task
pub enum SshWriteOp {
    Data(Vec<u8>),
    Resize(u32, u32),
}

impl RemoteSshSession {
    /// Open an interactive SSH PTY session on the remote machine.
    ///
    /// Allocates a PTY with `TERM=xterm-256color`, then issues a `request_shell` so the
    /// SSH server starts the user's configured login shell (zsh, bash, fish, etc.).
    /// Returns an `SshPtyHandle` for streaming I/O between the local xterm and the remote shell.
    pub async fn spawn_remote_pty(
        &self,
        cols: u16,
        rows: u16,
        log_id: i32,
    ) -> Result<SshPtyHandle, String> {
        if !self.is_connected().await {
            self.reconnect_if_needed().await.map_err(|e| e.to_string())?;
        }

        // Open a dedicated SSH channel for this PTY session
        let channel = {
            let guard = self.handle.lock().await;
            let h = guard
                .as_ref()
                .ok_or("No active SSH session")?;
            h.channel_open_session()
                .await
                .map_err(|e| format!("Failed to open SSH channel: {}", e))?
        };

        let (mut read_half, write_half) = channel.split();

        // Allocate a PTY — this sets TERM=xterm-256color on the remote side
        write_half
            .request_pty(true, "xterm-256color", cols as u32, rows as u32, 0, 0, &[])
            .await
            .map_err(|e| format!("Failed to request PTY: {}", e))?;

        // Request the user's configured login shell via SSH request_shell
        write_half
            .request_shell(true)
            .await
            .map_err(|e| format!("Failed to request remote shell: {}", e))?;

        // Create I/O channels
        let (write_tx, mut write_rx) = tokio::sync::mpsc::channel::<SshWriteOp>(32);

        // History buffer: accumulates session output with ANSI clear-screen trimming and 512 KB cap.
        // attach_terminal replays from pos=0 for live sessions and reads the DB for dead sessions.
        let history: Arc<tokio::sync::Mutex<String>> = Arc::new(tokio::sync::Mutex::new(String::new()));
        let notify: Arc<tokio::sync::Notify> = Arc::new(tokio::sync::Notify::new());
        let process_ended: Arc<AtomicBool> = Arc::new(AtomicBool::new(false));
        // Cumulative front-drain counter: incremented only by the 512 KB cap path, never by
        // clear-screen replacements. Readers use this to adjust their byte positions after a drain.
        let total_drained: Arc<AtomicUsize> = Arc::new(AtomicUsize::new(0));
        // Clear-screen replacement counter: incremented each time the history buffer is fully
        // replaced due to a \x1b[2J sequence. Readers reset pos=0 when this counter advances,
        // preventing partial escape sequences from being sent as literal printable characters.
        let clear_screen_count: Arc<AtomicUsize> = Arc::new(AtomicUsize::new(0));

        let history_writer = Arc::clone(&history);
        let notify_writer = Arc::clone(&notify);
        let ended_writer = Arc::clone(&process_ended);
        let total_drained_writer = Arc::clone(&total_drained);
        let clear_screen_count_writer = Arc::clone(&clear_screen_count);

        // Writer task: owns write_half, processes data and resize ops sequentially.
        // make_writer() clones the internal sender, leaving write_half available for window_change.
        tokio::spawn(async move {
            use tokio::io::AsyncWriteExt;
            let mut writer = write_half.make_writer();
            while let Some(op) = write_rx.recv().await {
                match op {
                    SshWriteOp::Data(bytes) => {
                        if writer.write_all(&bytes).await.is_err() {
                            break;
                        }
                    }
                    SshWriteOp::Resize(cols, rows) => {
                        let _ = write_half.window_change(cols, rows, 0, 0).await;
                    }
                }
            }
        });

        // Reader task: appends output to history and notifies waiters.
        // attach_terminal replays from pos=0 for live sessions; dead sessions recover from DB.
        tokio::spawn(async move {
            loop {
                match read_half.wait().await {
                    Some(ChannelMsg::Data { data }) => {
                        let text = String::from_utf8_lossy(&data).to_string();
                        let (drained, was_clear_screen) = {
                            let mut hist = history_writer.lock().await;
                            append_to_history(&mut hist, &text)
                        };
                        if was_clear_screen {
                            clear_screen_count_writer.fetch_add(1, Ordering::Release);
                        } else if drained > 0 {
                            total_drained_writer.fetch_add(drained, Ordering::Release);
                        }
                        notify_writer.notify_one();
                    }
                    Some(ChannelMsg::ExtendedData { data, .. }) => {
                        let text = String::from_utf8_lossy(&data).to_string();
                        let (drained, was_clear_screen) = {
                            let mut hist = history_writer.lock().await;
                            append_to_history(&mut hist, &text)
                        };
                        if was_clear_screen {
                            clear_screen_count_writer.fetch_add(1, Ordering::Release);
                        } else if drained > 0 {
                            total_drained_writer.fetch_add(drained, Ordering::Release);
                        }
                        notify_writer.notify_one();
                    }
                    Some(ChannelMsg::ExitStatus { exit_status }) => {
                        let msg = if exit_status == 0 {
                            "\r\n\x1b[32m[Process exited]\x1b[0m\r\n".to_string()
                        } else {
                            format!(
                                "\r\n\x1b[31m[Process exited with code {}]\x1b[0m\r\n",
                                exit_status
                            )
                        };
                        {
                            let mut hist = history_writer.lock().await;
                            // Exit message is short — clear-screen/drain return values not needed here
                            append_to_history(&mut hist, &msg);
                        }
                        notify_writer.notify_one();
                        break;
                    }
                    Some(ChannelMsg::Eof) => {
                        break;
                    }
                    Some(ChannelMsg::Close) => {
                        break;
                    }
                    None => {
                        break;
                    }
                    Some(_other) => {
                        // Unhandled message type — ignored
                    }
                }
            }
            ended_writer.store(true, Ordering::Release);
            notify_writer.notify_one();
        });

        Ok(SshPtyHandle { log_id, write_tx, history, notify, process_ended, total_drained, clear_screen_count })
    }
}
