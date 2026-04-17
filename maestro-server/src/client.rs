use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::time::Duration;

use agent_client_protocol::{
    CreateTerminalRequest, CreateTerminalResponse, KillTerminalRequest, KillTerminalResponse,
    ReleaseTerminalRequest, ReleaseTerminalResponse, RequestPermissionRequest,
    RequestPermissionResponse, SessionNotification, TerminalExitStatus, TerminalId,
    TerminalOutputRequest, TerminalOutputResponse, WaitForTerminalExitRequest,
    WaitForTerminalExitResponse,
};
use maestro_protocol::{
    MaestroRpcMessage, ServerResponse, SessionUpdate, PermissionRequest, TerminalOutput,
};
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tokio::sync::oneshot;
use std::process::Stdio;

use crate::sessions::{TerminalExitInfo, TerminalHandle};

/// Client implementation that bridges ACP agent callbacks to Maestro protocol messages.
///
/// All fields use Rc (not Arc) because MaestroServerClient runs inside a LocalSet
/// with the ?Send async_trait bound — thread-safety is not required.
pub struct MaestroServerClient {
    /// Shared stdout writer for sending ServerResponse frames to the Tauri host
    pub stdout: Rc<tokio::sync::Mutex<tokio::io::Stdout>>,
    /// Pending permission requests: request_id -> oneshot sender for PermitResponse dispatch
    pub pending_permissions: Rc<RefCell<HashMap<String, oneshot::Sender<RequestPermissionResponse>>>>,
    /// Managed terminals shared with the ActiveSession
    pub terminals: Rc<RefCell<HashMap<String, TerminalHandle>>>,
    /// Maestro session ID for tagging outgoing frames
    pub maestro_session_id: String,
    /// Monotonic terminal ID counter
    pub terminal_counter: Rc<RefCell<u64>>,
}

impl MaestroServerClient {
    pub fn new(
        stdout: Rc<tokio::sync::Mutex<tokio::io::Stdout>>,
        maestro_session_id: String,
        terminals: Rc<RefCell<HashMap<String, TerminalHandle>>>,
    ) -> Self {
        Self {
            stdout,
            pending_permissions: Rc::new(RefCell::new(HashMap::new())),
            terminals,
            maestro_session_id,
            terminal_counter: Rc::new(RefCell::new(0)),
        }
    }
}

/// Send a MaestroRpcMessage to stdout, flushing after every write.
pub async fn send_response(
    stdout: &Rc<tokio::sync::Mutex<tokio::io::Stdout>>,
    msg: &MaestroRpcMessage,
) -> std::result::Result<(), Box<dyn std::error::Error>> {
    let mut buf: Vec<u8> = Vec::new();
    maestro_protocol::write_message(&mut buf, msg).await?;
    let mut out = stdout.lock().await;
    out.write_all(&buf).await?;
    out.flush().await?;
    Ok(())
}

#[async_trait::async_trait(?Send)]
impl agent_client_protocol::Client for MaestroServerClient {
    /// SERVER-02: Forward ACP SessionNotification as a ServerResponse::SessionUpdate frame.
    async fn session_notification(&self, args: SessionNotification) -> agent_client_protocol::Result<()> {
        let payload = serde_json::to_value(&args).map_err(|e| {
            agent_client_protocol::Error::new(-32603, e.to_string())
        })?;
        let msg = MaestroRpcMessage::Response(ServerResponse::SessionUpdate(SessionUpdate {
            session_id: self.maestro_session_id.clone(),
            payload,
        }));
        send_response(&self.stdout, &msg).await.map_err(|e| {
            agent_client_protocol::Error::new(-32603, e.to_string())
        })?;
        Ok(())
    }

    /// SERVER-04: Block on a oneshot channel until the Tauri host sends a PermitResponse.
    ///
    /// Writes a PermissionRequest frame to stdout, inserts a oneshot sender into the
    /// pending_permissions map, then awaits the receiver. The stdin dispatch loop
    /// resolves the channel when a PermitResponse arrives.
    async fn request_permission(&self, args: RequestPermissionRequest) -> agent_client_protocol::Result<RequestPermissionResponse> {
        let request_id = args.tool_call.tool_call_id.to_string();

        let (tx, rx) = oneshot::channel::<RequestPermissionResponse>();
        self.pending_permissions.borrow_mut().insert(request_id.clone(), tx);

        let payload = serde_json::to_value(&args).map_err(|e| {
            agent_client_protocol::Error::new(-32603, e.to_string())
        })?;
        let msg = MaestroRpcMessage::Response(ServerResponse::PermissionRequest(PermissionRequest {
            session_id: self.maestro_session_id.clone(),
            request_id,
            payload,
        }));
        send_response(&self.stdout, &msg).await.map_err(|e| {
            agent_client_protocol::Error::new(-32603, e.to_string())
        })?;

        // Await the PermitResponse dispatched by the stdin loop
        rx.await.map_err(|_| {
            agent_client_protocol::Error::new(-32603, "permission channel closed")
        })
    }

    /// SERVER-03: Spawn a subprocess, accumulate its output, and push TerminalOutput frames.
    ///
    /// Validates the working directory (T-42-01), spawns using args not a shell string (T-42-02),
    /// and respects output_byte_limit (T-42-03).
    async fn create_terminal(&self, args: CreateTerminalRequest) -> agent_client_protocol::Result<CreateTerminalResponse> {
        // T-42-01: Validate cwd exists before spawning
        if let Some(ref cwd) = args.cwd {
            // Reject paths containing ".." components
            for component in cwd.components() {
                if component == std::path::Component::ParentDir {
                    return Err(agent_client_protocol::Error::new(-32603, format!("cwd contains '..' component: {}", cwd.display())));
                }
            }
            match tokio::fs::metadata(cwd).await {
                Ok(meta) if meta.is_dir() => {}
                Ok(_) => {
                    return Err(agent_client_protocol::Error::new(-32603, format!("cwd is not a directory: {}", cwd.display())));
                }
                Err(e) => {
                    return Err(agent_client_protocol::Error::new(-32603, format!("cwd does not exist: {}: {}", cwd.display(), e)));
                }
            }
        }

        // Generate terminal ID
        let terminal_id = {
            let mut counter = self.terminal_counter.borrow_mut();
            *counter += 1;
            format!("term-{}", *counter)
        };

        // T-42-02: Use Command::new(program).args(args) — never shell strings
        let mut cmd = Command::new(&args.command);
        cmd.args(&args.args);
        if let Some(ref cwd) = args.cwd {
            cmd.current_dir(cwd);
        }
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());
        cmd.kill_on_drop(true);

        let mut child = cmd.spawn().map_err(|e| {
            agent_client_protocol::Error::new(-32603, e.to_string())
        })?;

        let stdout_pipe = child.stdout.take();
        let stderr_pipe = child.stderr.take();

        let output_buf: Rc<RefCell<String>> = Rc::new(RefCell::new(String::new()));
        let exit_status: Rc<RefCell<Option<TerminalExitInfo>>> = Rc::new(RefCell::new(None));
        let (kill_tx, kill_rx) = oneshot::channel::<()>();

        // Clone references for the background reader task
        let output_buf_bg = output_buf.clone();
        let exit_status_bg = exit_status.clone();
        let stdout_bg = self.stdout.clone();
        let maestro_session_id_bg = self.maestro_session_id.clone();
        let terminal_id_bg = terminal_id.clone();
        let output_byte_limit = args.output_byte_limit;

        tokio::task::spawn_local(async move {
            use tokio::io::{AsyncBufReadExt, BufReader};

            let mut kill_rx = kill_rx;

            // Combine stdout and stderr into a single merged stream by reading both
            // We'll use a select approach reading stdout first, then switch to stderr after
            if let Some(pipe) = stdout_pipe {
                let mut reader = BufReader::new(pipe).lines();
                loop {
                    tokio::select! {
                        biased;
                        _ = &mut kill_rx => break,
                        line = reader.next_line() => {
                            match line {
                                Ok(Some(line)) => {
                                    let chunk = format!("{}\n", line);
                                    // T-42-03: Respect output_byte_limit — truncate from beginning
                                    {
                                        let mut buf = output_buf_bg.borrow_mut();
                                        buf.push_str(&chunk);
                                        if let Some(limit) = output_byte_limit {
                                            let limit = limit as usize;
                                            if buf.len() > limit {
                                                // Truncate from beginning at a char boundary
                                                let excess = buf.len() - limit;
                                                let safe_pos = buf
                                                    .char_indices()
                                                    .map(|(i, _)| i)
                                                    .find(|&i| i >= excess)
                                                    .unwrap_or(buf.len());
                                                *buf = buf[safe_pos..].to_string();
                                            }
                                        }
                                    }
                                    // Write TerminalOutput frame
                                    let msg = MaestroRpcMessage::Response(ServerResponse::TerminalOutput(TerminalOutput {
                                        session_id: maestro_session_id_bg.clone(),
                                        terminal_id: terminal_id_bg.clone(),
                                        bytes: chunk.into_bytes(),
                                    }));
                                    let _ = send_response(&stdout_bg, &msg).await;
                                }
                                Ok(None) => break, // EOF
                                Err(_) => break,
                            }
                        }
                    }
                }
            }

            // Read stderr separately (best effort)
            if let Some(pipe) = stderr_pipe {
                let mut reader = BufReader::new(pipe).lines();
                while let Ok(Some(line)) = reader.next_line().await {
                    let chunk = format!("{}\n", line);
                    {
                        let mut buf = output_buf_bg.borrow_mut();
                        buf.push_str(&chunk);
                        if let Some(limit) = output_byte_limit {
                            let limit = limit as usize;
                            if buf.len() > limit {
                                let excess = buf.len() - limit;
                                let safe_pos = buf
                                    .char_indices()
                                    .map(|(i, _)| i)
                                    .find(|&i| i >= excess)
                                    .unwrap_or(buf.len());
                                *buf = buf[safe_pos..].to_string();
                            }
                        }
                    }
                    let msg = MaestroRpcMessage::Response(ServerResponse::TerminalOutput(TerminalOutput {
                        session_id: maestro_session_id_bg.clone(),
                        terminal_id: terminal_id_bg.clone(),
                        bytes: chunk.into_bytes(),
                    }));
                    let _ = send_response(&stdout_bg, &msg).await;
                }
            }

            // Record exit status
            *exit_status_bg.borrow_mut() = Some(TerminalExitInfo {
                exit_code: None,
                signal: None,
            });
        });

        let handle = TerminalHandle {
            output_buf,
            output_byte_limit: args.output_byte_limit,
            exit_status,
            kill_tx: Some(kill_tx),
        };
        self.terminals.borrow_mut().insert(terminal_id.clone(), handle);

        Ok(CreateTerminalResponse::new(TerminalId::new(&*terminal_id)))
    }

    async fn terminal_output(&self, args: TerminalOutputRequest) -> agent_client_protocol::Result<TerminalOutputResponse> {
        let terminal_id_str = args.terminal_id.to_string();
        let terminals = self.terminals.borrow();
        let handle = terminals.get(&terminal_id_str).ok_or_else(|| {
            agent_client_protocol::Error::new(-32603, "unknown terminal")
        })?;

        let output = handle.output_buf.borrow().clone();
        let truncated = handle.output_byte_limit
            .map(|limit| output.len() >= limit as usize)
            .unwrap_or(false);

        let exit_status = handle.exit_status.borrow().as_ref().map(|info| {
            TerminalExitStatus::new()
                .exit_code(info.exit_code)
                .signal(info.signal.clone())
        });

        Ok(TerminalOutputResponse::new(output, truncated)
            .exit_status(exit_status))
    }

    async fn release_terminal(&self, args: ReleaseTerminalRequest) -> agent_client_protocol::Result<ReleaseTerminalResponse> {
        let terminal_id_str = args.terminal_id.to_string();
        // Remove and drop the handle (kill_tx drop kills background reader; child killed by kill_on_drop)
        self.terminals.borrow_mut().remove(&terminal_id_str);
        Ok(ReleaseTerminalResponse::new())
    }

    async fn kill_terminal(&self, args: KillTerminalRequest) -> agent_client_protocol::Result<KillTerminalResponse> {
        let terminal_id_str = args.terminal_id.to_string();
        let mut terminals = self.terminals.borrow_mut();
        if let Some(handle) = terminals.get_mut(&terminal_id_str) {
            // Take kill_tx and send on it to signal the background reader to stop
            if let Some(tx) = handle.kill_tx.take() {
                let _ = tx.send(());
            }
        }
        Ok(KillTerminalResponse::new())
    }

    async fn wait_for_terminal_exit(&self, args: WaitForTerminalExitRequest) -> agent_client_protocol::Result<WaitForTerminalExitResponse> {
        let terminal_id_str = args.terminal_id.to_string();

        // Poll until exit_status is set
        loop {
            let maybe_info = {
                let terminals = self.terminals.borrow();
                if let Some(handle) = terminals.get(&terminal_id_str) {
                    handle.exit_status.borrow().as_ref().map(|info| {
                        (info.exit_code, info.signal.clone())
                    })
                } else {
                    // Terminal not found — treat as exited with no info
                    Some((None, None))
                }
            };

            if let Some((exit_code, signal)) = maybe_info {
                let status = TerminalExitStatus::new()
                    .exit_code(exit_code)
                    .signal(signal);
                return Ok(WaitForTerminalExitResponse::new(status));
            }

            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }
}
