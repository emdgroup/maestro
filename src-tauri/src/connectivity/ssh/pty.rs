use crate::connectivity::ssh::history::{append_to_history, PtyOutput, SshPtyHandle};
use crate::connectivity::ssh::session::RemoteSshSession;
use russh::ChannelMsg;

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
        session_id: &str,
    ) -> Result<SshPtyHandle, String> {
        if !self.is_connected().await {
            self.reconnect_if_needed()
                .await
                .map_err(|e| e.to_string())?;
        }

        // Open a dedicated SSH channel for this PTY session
        let channel = {
            let guard = self.handle.lock().await;
            let h = guard.as_ref().ok_or("No active SSH session")?;
            h.channel_open_session()
                .await
                .map_err(|e| format!("Failed to open SSH channel: {}", e))?
        };

        let (mut read_half, write_half) = channel.split();

        // Do not wait for server acknowledgements: channel ordering ensures these requests are
        // processed before the first input, while waiting adds two full SSH round trips.
        write_half
            .request_pty(false, "xterm-256color", cols as u32, rows as u32, 0, 0, &[])
            .await
            .map_err(|e| format!("Failed to request PTY: {}", e))?;

        write_half
            .request_shell(false)
            .await
            .map_err(|e| format!("Failed to request remote shell: {}", e))?;

        // Create I/O channels
        let (write_tx, mut write_rx) = tokio::sync::mpsc::channel::<SshWriteOp>(32);

        let output = PtyOutput::default();
        let output_writer = output.clone();

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
        // attach_terminal replays from pos=0 for live sessions.
        tokio::spawn(async move {
            loop {
                match read_half.wait().await {
                    Some(ChannelMsg::Data { data })
                    | Some(ChannelMsg::ExtendedData { data, .. }) => {
                        let text = String::from_utf8_lossy(&data).to_string();
                        let result = {
                            let mut hist = output_writer.history.lock().await;
                            append_to_history(&mut hist, &text)
                        };
                        output_writer.appended(result);
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
                        let result = {
                            let mut hist = output_writer.history.lock().await;
                            append_to_history(&mut hist, &msg)
                        };
                        output_writer.appended(result);
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
            output_writer.end();
        });

        Ok(SshPtyHandle {
            session_id: session_id.to_string(),
            write_tx,
            output,
        })
    }
}
