//! ACP session manager: spawns maestro-server as a managed subprocess,
//! tracks sessions in AppState, and streams typed Tauri events from a
//! background reader task.

use std::sync::Arc;
use tokio::io::{AsyncWriteExt, BufReader, BufWriter};
use tokio::process::{Child, ChildStdin};
use tokio::sync::oneshot;
use tokio::time::{interval, Duration};
use tauri::Emitter;
use crate::acp::transport::{
    MaestroRpcMessage, ServerRequest, ServerResponse,
    SpawnRequest, read_message, write_message,
};

/// A live ACP subprocess session.
///
/// Created by `spawn_acp_process` and stored in `AppState.acp_sessions`.
/// The child process handle has `kill_on_drop(true)` so dropping this
/// struct terminates maestro-server automatically.
pub struct AcpProcess {
    /// Child process handle — kill_on_drop(true) ensures cleanup
    pub child: Child,
    /// Write half of piped stdin — used to send SpawnRequest, PromptRequest, PermitResponse
    pub stdin_writer: BufWriter<ChildStdin>,
    /// Cancel signal for the background reader task (send () to stop the reader loop)
    /// Option so it can be `.take()`-ed during cleanup (oneshot::Sender is not Clone)
    pub reader_cancel_tx: Option<oneshot::Sender<()>>,
}

/// Spawn maestro-server as a subprocess for a new ACP session.
///
/// Steps:
/// 1. Resolve the maestro-server binary via PATH (using `which`)
/// 2. Spawn the process with piped stdin/stdout, stderr inherited
/// 3. Send the initial `SpawnRequest` to maestro-server stdin
/// 4. Insert the `AcpProcess` into `app_state.acp_sessions`
/// 5. Start a background reader task that emits Tauri events per response variant
///
/// Returns `Ok(())` on success or an error string describing the failure.
pub async fn spawn_acp_process(
    agent_id: &str,
    cwd: &str,
    log_id: i32,
    session_id: &str,
    app_state: &Arc<crate::db::AppState>,
) -> Result<(), String> {
    use std::process::Stdio;

    // Resolve maestro-server binary on PATH
    let server_path = which::which("maestro-server")
        .map_err(|e| format!("maestro-server not found on PATH: {}", e))?;

    // Spawn the subprocess with piped stdin/stdout; inherit stderr so server
    // diagnostic messages surface in the Tauri process stderr.
    let mut child = tokio::process::Command::new(server_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("Failed to spawn maestro-server: {}", e))?;

    // Take stdin/stdout handles BEFORE storing child into the struct.
    let child_stdin = child.stdin.take().expect("child stdin must be piped");
    let child_stdout = child.stdout.take().expect("child stdout must be piped");

    // Wrap stdin in a BufWriter for efficient writes.
    let mut stdin_writer = BufWriter::new(child_stdin);

    // Send the initial SpawnRequest to maestro-server.
    let spawn_req = MaestroRpcMessage::Request(ServerRequest::Spawn(SpawnRequest {
        agent_id: agent_id.to_string(),
        session_id: session_id.to_string(),
        cwd: cwd.to_string(),
    }));
    write_to_acp_session_raw(&mut stdin_writer, &spawn_req).await?;

    // Create the cancel channel for the background reader task.
    let (cancel_tx, cancel_rx) = oneshot::channel::<()>();

    let acp_process = AcpProcess {
        child,
        stdin_writer,
        reader_cancel_tx: Some(cancel_tx),
    };

    // Insert the session into AppState before starting the reader task so that
    // the session is visible to IPC handlers immediately.
    app_state.acp_sessions.lock().await.insert(log_id, acp_process);

    // Start the background reader task that forwards server responses as Tauri events.
    spawn_reader_task(
        child_stdout,
        log_id,
        app_state.app_handle.clone(),
        Arc::clone(app_state),
        cancel_rx,
    );

    Ok(())
}

/// Background task that reads responses from maestro-server stdout and emits
/// typed Tauri events.  Runs until EOF/error or the cancel channel fires.
///
/// Event naming convention: `acp://<variant>/<log_id>`
/// - `acp://session-update/<log_id>`    — SessionUpdate payload (serde_json::Value)
/// - `acp://terminal-output/<log_id>`  — TerminalOutput bytes (Vec<u8>)
/// - `acp://permission-request/<log_id>` — PermissionRequest struct
/// - `acp://session-error/<log_id>`    — ErrorResponse message (String)
/// - `acp://session-ended/<log_id>`    — EOF or error; session removed from map
fn spawn_reader_task(
    child_stdout: tokio::process::ChildStdout,
    log_id: i32,
    app_handle: tauri::AppHandle,
    app_state: Arc<crate::db::AppState>,
    cancel_rx: oneshot::Receiver<()>,
) {
    tokio::spawn(async move {
        let mut stdout_reader = BufReader::new(child_stdout);
        let mut cancel_rx = cancel_rx;
        let mut flush_interval = interval(Duration::from_secs(10));
        let mut structured_updates: Vec<serde_json::Value> = Vec::new();

        loop {
            tokio::select! {
                biased;

                // Cancel branch: IPC caller requested session teardown
                _ = &mut cancel_rx => break,

                // Periodic flush: write accumulated structured updates to DB
                _ = flush_interval.tick() => {
                    if !structured_updates.is_empty() {
                        let json = serde_json::to_string(&structured_updates)
                            .unwrap_or_default();
                        // Scoped block to drop MutexGuard immediately (never hold across .await)
                        if let Ok(conn) = app_state.db.lock() {
                            let _ = conn.execute(
                                "UPDATE execution_logs SET structured_output = ?1 WHERE id = ?2",
                                rusqlite::params![&json, log_id],
                            );
                        }
                    }
                }

                // Normal read branch: parse the next response from maestro-server
                result = read_message(&mut stdout_reader) => {
                    match result {
                        Ok(MaestroRpcMessage::Response(ServerResponse::SessionUpdate(upd))) => {
                            structured_updates.push(upd.payload.clone());
                            let _ = app_handle.emit(
                                &format!("acp://session-update/{}", log_id),
                                &upd.payload,
                            );
                        }
                        Ok(MaestroRpcMessage::Response(ServerResponse::TerminalOutput(out))) => {
                            let _ = app_handle.emit(
                                &format!("acp://terminal-output/{}", log_id),
                                &out.bytes,
                            );
                        }
                        Ok(MaestroRpcMessage::Response(ServerResponse::PermissionRequest(req))) => {
                            let _ = app_handle.emit(
                                &format!("acp://permission-request/{}", log_id),
                                &req,
                            );
                        }
                        Ok(MaestroRpcMessage::Response(ServerResponse::SpawnOk(_))) => {
                            // Spawn success is implied by this plan returning Ok(()) from
                            // spawn_acp_process; no Tauri event is needed.
                        }
                        Ok(MaestroRpcMessage::Response(ServerResponse::Error(err))) => {
                            let _ = app_handle.emit(
                                &format!("acp://session-error/{}", log_id),
                                &err.message,
                            );
                        }
                        Ok(_) => {
                            // Ignore Request variants arriving on stdout — wrong direction.
                        }
                        Err(_) => {
                            // EOF or parse error means maestro-server exited.
                            break;
                        }
                    }
                }
            }
        }

        // Final flush: write all accumulated updates to DB on session end.
        if !structured_updates.is_empty() {
            let json = serde_json::to_string(&structured_updates)
                .unwrap_or_default();
            if let Ok(conn) = app_state.db.lock() {
                let _ = conn.execute(
                    "UPDATE execution_logs SET structured_output = ?1 WHERE id = ?2",
                    rusqlite::params![&json, log_id],
                );
            }
        }

        // Cleanup: remove session from map so IPC handlers see it as gone.
        app_state.acp_sessions.lock().await.remove(&log_id);

        // Notify the frontend that the session has ended.
        let _ = app_handle.emit(&format!("acp://session-ended/{}", log_id), ());
    });
}

/// Write a message to an active ACP session's stdin by log_id.
///
/// Looks up the session in `app_state.acp_sessions`, writes the message,
/// and flushes the BufWriter.  Returns an error if no session exists for
/// `log_id` or if the write/flush fails.
pub async fn write_to_acp_session(
    app_state: &crate::db::AppState,
    log_id: i32,
    msg: &MaestroRpcMessage,
) -> Result<(), String> {
    let mut sessions = app_state.acp_sessions.lock().await;
    let session = sessions
        .get_mut(&log_id)
        .ok_or_else(|| format!("No ACP session for log_id {}", log_id))?;
    write_to_acp_session_raw(&mut session.stdin_writer, msg).await
}

/// Low-level write + flush to a `BufWriter<ChildStdin>`.
///
/// CRITICAL: BufWriter buffers data internally — `flush()` must be called
/// after every write to ensure maestro-server receives the complete message.
async fn write_to_acp_session_raw(
    stdin_writer: &mut BufWriter<ChildStdin>,
    msg: &MaestroRpcMessage,
) -> Result<(), String> {
    write_message(stdin_writer, msg)
        .await
        .map_err(|e| format!("write failed: {}", e))?;
    stdin_writer
        .flush()
        .await
        .map_err(|e| format!("flush failed: {}", e))?;
    Ok(())
}
