use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;
use tauri::Emitter;

use super::session::{RemoteSshSession, SshConnectionState, ReconnectingPayload};
use crate::connectivity::ssh::error::is_transient_error;

/// Clean up all SSH PTY sessions associated with a given connection_id.
async fn cleanup_pty_sessions_for_connection(
    app_state: &Arc<crate::core::AppState>,
    _connection_id: i32,
) {
    let mut log_ids_to_cleanup: Vec<i32> = Vec::new();

    {
        let sessions = app_state.ssh.pty_sessions.lock().await;
        for (log_id, handle) in sessions.iter() {
            log_ids_to_cleanup.push(*log_id);
            handle.process_ended.store(true, Ordering::Release);
            handle.notify.notify_one();
        }
    }

    if log_ids_to_cleanup.is_empty() {
        return;
    }

    {
        let mut sessions = app_state.ssh.pty_sessions.lock().await;
        for log_id in &log_ids_to_cleanup {
            sessions.remove(log_id);
        }
    }

    {
        let mut meta = app_state.pty.session_meta.lock().await;
        for log_id in &log_ids_to_cleanup {
            meta.remove(log_id);
        }
    }

    app_state.app_handle.emit("sessions-changed", ()).ok();
}

/// Spawn a background heartbeat task for an SSH connection.
///
/// Probes the connection every 5 seconds. On failure: emits `ssh-connection-lost`,
/// cleans up PTY sessions, attempts reconnection with exponential backoff, and
/// emits `ssh-reconnected` on success or `ssh-connection-failed` after exhaustion.
pub fn spawn_heartbeat_task(
    session: RemoteSshSession,
    app_handle: tauri::AppHandle,
    connection_id: i32,
    app_state: Arc<crate::core::AppState>,
) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(5));
        interval.tick().await;

        loop {
            interval.tick().await;

            {
                let sessions = app_state.ssh.sessions.lock().await;
                if !sessions.contains_key(&connection_id) {
                    break;
                }
            }

            let state = session.get_state().await;
            if state == SshConnectionState::Disconnected {
                break;
            }

            let probe = tokio::time::timeout(
                Duration::from_secs(8),
                session.execute_command("true"),
            ).await;
            match probe {
                Ok(Ok(_)) => {
                    session.reconnect_attempts.store(0, Ordering::SeqCst);
                }
                Ok(Err(ref e)) if !is_transient_error(e) => {
                    break;
                }
                _ => {
                    let _ = app_handle.emit("ssh-connection-lost", connection_id);
                    cleanup_pty_sessions_for_connection(&app_state, connection_id).await;
                    *session.state.lock().await = SshConnectionState::Reconnecting;

                    let max_attempts: usize = 5;
                    const RETRY_DELAYS_SECS: [u64; 5] = [3, 6, 12, 24, 45];
                    let mut reconnected = false;

                    for attempt in 1..=max_attempts {
                        let _ = app_handle.emit("ssh-reconnecting", ReconnectingPayload {
                            connection_id,
                            attempt,
                            max_attempts,
                        });

                        let delay = Duration::from_secs(RETRY_DELAYS_SECS[attempt - 1]);
                        tokio::time::sleep(delay).await;

                        {
                            let sessions = app_state.ssh.sessions.lock().await;
                            if !sessions.contains_key(&connection_id) {
                                return;
                            }
                        }

                        let password = session.session_password.lock().await.as_ref().map(|p| p.to_string());
                        match session.connect(password).await {
                            Ok(()) => {
                                let _ = app_handle.emit("ssh-reconnected", connection_id);
                                reconnected = true;

                                let restore_state = Arc::clone(&app_state);
                                let restore_handle = app_handle.clone();
                                tokio::spawn(async move {
                                    if let Err(_) = crate::acp::restore_acp_sessions(connection_id, &restore_state).await {
                                        let remaining: Vec<crate::acp::RestorableSession> = restore_state
                                            .acp
                                            .restorable_sessions
                                            .lock()
                                            .await
                                            .remove(&connection_id)
                                            .unwrap_or_default();
                                        for s in remaining {
                                            let _ = restore_state.app_handle.emit(
                                                &format!("acp://session-ended/{}", s.log_id), ()
                                            );
                                        }
                                        restore_state.app_handle.emit("sessions-changed", ()).ok();
                                    }
                                    let _ = restore_handle.emit("acp-sessions-restored", connection_id);
                                });

                                break;
                            }
                            Err(_) => {}
                        }
                    }

                    if !reconnected {
                        let remaining: Vec<crate::acp::RestorableSession> = app_state
                            .acp
                            .restorable_sessions
                            .lock()
                            .await
                            .remove(&connection_id)
                            .unwrap_or_default();
                        let had_restorable = !remaining.is_empty();
                        for s in remaining {
                            let _ = app_handle.emit(&format!("acp://session-ended/{}", s.log_id), ());
                        }
                        if had_restorable {
                            app_state.app_handle.emit("sessions-changed", ()).ok();
                        }
                        let _ = app_handle.emit("ssh-connection-failed", connection_id);
                        *session.state.lock().await = SshConnectionState::Disconnected;
                        break;
                    }
                }
            }
        }
    });
}
