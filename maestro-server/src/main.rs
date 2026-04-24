//! Maestro Remote Server
//!
//! Headless binary that runs on remote SSH hosts. Receives MaestroRpcMessage
//! commands from the local Maestro desktop app over stdin/stdout (piped through
//! SSH exec channel), spawns ACP agents as local subprocesses, and forwards
//! structured session updates back.
//!
//! Architecture: Adapted from Zed's remote_server (GPL-3.0).

mod agent;
mod registry;
mod sessions;

#[cfg(test)]
mod tests;

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use agent_client_protocol as acp;

use acp::schema::{
    ClientCapabilities, CreateTerminalRequest, CreateTerminalResponse, Implementation,
    InitializeRequest, KillTerminalRequest, KillTerminalResponse, PermissionOptionKind,
    ProtocolVersion, ReleaseTerminalRequest, ReleaseTerminalResponse, RequestPermissionOutcome,
    RequestPermissionRequest, RequestPermissionResponse, SelectedPermissionOutcome,
    SessionNotification, TerminalExitStatus, TerminalId, TerminalOutputRequest,
    TerminalOutputResponse, WaitForTerminalExitRequest, WaitForTerminalExitResponse,
};
use maestro_protocol::{
    read_message, DiscoveredAgent, ErrorResponse, ListAgentsResponse, MaestroRpcMessage,
    PermissionRequest as MaestroPermissionRequest, ServerRequest, ServerResponse,
    SessionUpdate, SpawnResponse, TerminalOutput,
};
use tokio::io::AsyncWriteExt;
use tokio::sync::{mpsc, oneshot, Mutex, Notify};
use tokio_util::compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt};

use sessions::{ActiveSession, SessionCommand, SessionMap, TerminalExitInfo, TerminalHandle};

/// Send a MaestroRpcMessage to stdout, flushing after every write.
async fn send_response(
    stdout: &Arc<Mutex<tokio::io::Stdout>>,
    msg: &MaestroRpcMessage,
) -> Result<(), Box<dyn std::error::Error>> {
    let mut buf: Vec<u8> = Vec::new();
    maestro_protocol::write_message(&mut buf, msg).await?;
    let mut out = stdout.lock().await;
    out.write_all(&buf).await?;
    out.flush().await?;
    Ok(())
}

/// Truncate `buf` from the beginning to at most `limit` bytes, on a UTF-8 char boundary.
fn truncate_buf(buf: &mut String, limit: usize) {
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

/// Refresh the agent cache if stale or empty. Returns true if caller should `continue`
/// (discovery failed and an error response has already been sent).
async fn ensure_agent_cache(
    cache: &mut Option<(std::time::Instant, Vec<registry::DiscoveredAgentWithSpawn>)>,
    ttl: std::time::Duration,
    stdout: &Arc<Mutex<tokio::io::Stdout>>,
) -> bool {
    let needs_refresh = cache
        .as_ref()
        .map(|(ts, _)| ts.elapsed() > ttl)
        .unwrap_or(true);
    if !needs_refresh {
        return false;
    }
    match registry::discover_agents().await {
        Ok(agents) => {
            *cache = Some((std::time::Instant::now(), agents));
            false
        }
        Err(e) => {
            let _ = send_response(
                stdout,
                &MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
                    message: format!("Agent discovery failed: {}", e),
                })),
            )
            .await;
            true
        }
    }
}

/// Spawn the ACP connection task for one agent session.
///
/// Returns an `ActiveSession` on success (session initialized, ready for prompts).
/// On failure, sends an Error response to stdout and returns None.
async fn spawn_acp_session(
    spawn_cmd: &str,
    spawn_args: &[String],
    spawn_env: &HashMap<String, String>,
    cwd: &str,
    maestro_session_id: String,
    stdout: Arc<Mutex<tokio::io::Stdout>>,
) -> Option<ActiveSession> {
    // 1. Spawn agent subprocess
    let mut child =
        match agent::spawn_agent_subprocess(spawn_cmd, spawn_args, cwd, spawn_env).await {
            Ok(c) => c,
            Err(e) => {
                let _ = send_response(
                    &stdout,
                    &MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
                        message: e,
                    })),
                )
                .await;
                return None;
            }
        };

    // 2. Bridge subprocess stdio via compat() for ByteStreams
    let child_stdin = child.stdin.take().expect("child stdin must be piped");
    let child_stdout = child.stdout.take().expect("child stdout must be piped");
    let outgoing = child_stdin.compat_write();
    let incoming = child_stdout.compat();
    let transport = acp::ByteStreams::new(outgoing, incoming);

    // 3. Shared state for callbacks (Arc for Send + Sync)
    let pending_permissions: Arc<Mutex<HashMap<String, oneshot::Sender<bool>>>> =
        Arc::new(Mutex::new(HashMap::new()));
    let terminals: Arc<Mutex<HashMap<String, TerminalHandle>>> =
        Arc::new(Mutex::new(HashMap::new()));
    let terminal_counter = Arc::new(AtomicU64::new(0));

    // 4. Channels: commands into the connection task, readiness signal out
    let (cmd_tx, mut cmd_rx) = mpsc::channel::<SessionCommand>(16);
    let (ready_tx, ready_rx) = oneshot::channel::<Result<(), String>>();

    // 5. Clone state for builder callbacks
    let pp = Arc::clone(&pending_permissions);
    let terms = Arc::clone(&terminals);
    let tc = Arc::clone(&terminal_counter);
    let so = Arc::clone(&stdout);
    let sid = maestro_session_id.clone();
    let cwd_owned = cwd.to_string();

    // 6. Spawn ACP connection as background task
    let task = tokio::spawn(async move {
        let _result = acp::Client
            .builder()
            .name("maestro-server")
            // --- Permission handler ---
            .on_receive_request(
                {
                    let pp = Arc::clone(&pp);
                    let so = Arc::clone(&so);
                    let sid = sid.clone();
                    move |request: RequestPermissionRequest, responder: acp::Responder<RequestPermissionResponse>, _cx: acp::ConnectionTo<acp::Agent>| {
                        let pp = pp.clone();
                        let so = so.clone();
                        let sid = sid.clone();
                        async move {

                            let request_id = request.tool_call.tool_call_id.to_string();

                            let (tx, rx) = oneshot::channel::<bool>();
                            pp.lock().await.insert(request_id.clone(), tx);

                            let payload = serde_json::to_value(&request).map_err(|e| {
                                acp::Error::new(-32603, e.to_string())
                            })?;
                            let msg = MaestroRpcMessage::Response(
                                ServerResponse::PermissionRequest(MaestroPermissionRequest {
                                    session_id: sid,
                                    request_id,
                                    payload,
                                }),
                            );
                            send_response(&so, &msg).await.map_err(|e| {
                                acp::Error::new(-32603, e.to_string())
                            })?;

                            let allowed = rx.await.map_err(|_| {
                                acp::Error::new(-32603, "permission channel closed")
                            })?;

                            let outcome = if allowed {
                                let opt = request.options.iter().find(|o| {
                                    matches!(
                                        o.kind,
                                        PermissionOptionKind::AllowOnce
                                            | PermissionOptionKind::AllowAlways
                                    )
                                });
                                match opt {
                                    Some(o) => RequestPermissionOutcome::Selected(
                                        SelectedPermissionOutcome::new(o.option_id.clone()),
                                    ),
                                    None => RequestPermissionOutcome::Cancelled,
                                }
                            } else {
                                RequestPermissionOutcome::Cancelled
                            };
                            responder.respond(RequestPermissionResponse::new(outcome))
                        }
                    }
                },
                acp::on_receive_request!(),
            )
            // --- Session notification handler ---
            .on_receive_notification(
                {
                    let so = Arc::clone(&so);
                    let sid = sid.clone();
                    move |notification: SessionNotification, _cx: acp::ConnectionTo<acp::Agent>| {
                        let so = so.clone();
                        let sid = sid.clone();
                        async move {
                            let payload = serde_json::to_value(&notification).map_err(|e| {
                                acp::Error::new(-32603, e.to_string())
                            })?;
                            let msg = MaestroRpcMessage::Response(
                                ServerResponse::SessionUpdate(SessionUpdate {
                                    session_id: sid,
                                    payload,
                                }),
                            );
                            send_response(&so, &msg).await.map_err(|e| {
                                acp::Error::new(-32603, e.to_string())
                            })?;
                            Ok(())
                        }
                    }
                },
                acp::on_receive_notification!(),
            )
            // --- create_terminal handler ---
            .on_receive_request(
                {
                    let terms = Arc::clone(&terms);
                    let tc = Arc::clone(&tc);
                    let so = Arc::clone(&so);
                    let sid = sid.clone();
                    move |request: CreateTerminalRequest, responder: acp::Responder<CreateTerminalResponse>, _cx: acp::ConnectionTo<acp::Agent>| {
                        let terms = terms.clone();
                        let tc = tc.clone();
                        let so = so.clone();
                        let sid = sid.clone();
                        async move {

                            let resp = handle_create_terminal(request, terms, tc, so, sid).await?;
                            responder.respond(resp)
                        }
                    }
                },
                acp::on_receive_request!(),
            )
            // --- terminal_output handler ---
            .on_receive_request(
                {
                    let terms = Arc::clone(&terms);
                    move |request: TerminalOutputRequest, responder: acp::Responder<TerminalOutputResponse>, _cx: acp::ConnectionTo<acp::Agent>| {
                        let terms = terms.clone();
                        async move {

                            let terminal_id_str = request.terminal_id.to_string();
                            let terminals = terms.lock().await;
                            let handle = terminals.get(&terminal_id_str).ok_or_else(|| {
                                acp::Error::new(-32603, "unknown terminal")
                            })?;

                            let output = handle.output_buf.lock().await.clone();
                            let truncated = handle
                                .output_byte_limit
                                .map(|limit| output.len() >= limit as usize)
                                .unwrap_or(false);

                            let exit_status =
                                handle.exit_status.lock().await.as_ref().map(|info| {
                                    TerminalExitStatus::new()
                                        .exit_code(info.exit_code)
                                        .signal(info.signal.clone())
                                });

                            responder.respond(
                                TerminalOutputResponse::new(output, truncated)
                                    .exit_status(exit_status),
                            )
                        }
                    }
                },
                acp::on_receive_request!(),
            )
            // --- release_terminal handler ---
            .on_receive_request(
                {
                    let terms = Arc::clone(&terms);
                    move |request: ReleaseTerminalRequest, responder: acp::Responder<ReleaseTerminalResponse>, _cx: acp::ConnectionTo<acp::Agent>| {
                        let terms = terms.clone();
                        async move {

                            let terminal_id_str = request.terminal_id.to_string();
                            terms.lock().await.remove(&terminal_id_str);
                            responder.respond(ReleaseTerminalResponse::new())
                        }
                    }
                },
                acp::on_receive_request!(),
            )
            // --- wait_for_terminal_exit handler ---
            .on_receive_request(
                {
                    let terms = Arc::clone(&terms);
                    move |request: WaitForTerminalExitRequest, responder: acp::Responder<WaitForTerminalExitResponse>, _cx: acp::ConnectionTo<acp::Agent>| {
                        let terms = terms.clone();
                        async move {

                            let terminal_id_str = request.terminal_id.to_string();
                            loop {
                                let (exit_status_arc, exit_notify_arc) = {
                                    let terminals = terms.lock().await;
                                    if let Some(handle) = terminals.get(&terminal_id_str) {
                                        (
                                            Arc::clone(&handle.exit_status),
                                            Arc::clone(&handle.exit_notify),
                                        )
                                    } else {
                                        return responder.respond(
                                            WaitForTerminalExitResponse::new(
                                                TerminalExitStatus::new(),
                                            ),
                                        );
                                    }
                                };

                                {
                                    let info = exit_status_arc.lock().await;
                                    if let Some(exit_info) = info.as_ref() {
                                        let status = TerminalExitStatus::new()
                                            .exit_code(exit_info.exit_code)
                                            .signal(exit_info.signal.clone());
                                        return responder.respond(
                                            WaitForTerminalExitResponse::new(status),
                                        );
                                    }
                                }

                                exit_notify_arc.notified().await;
                            }
                        }
                    }
                },
                acp::on_receive_request!(),
            )
            // --- kill_terminal handler ---
            .on_receive_request(
                {
                    let terms = Arc::clone(&terms);
                    move |request: KillTerminalRequest, responder: acp::Responder<KillTerminalResponse>, _cx: acp::ConnectionTo<acp::Agent>| {
                        let terms = terms.clone();
                        async move {

                            let terminal_id_str = request.terminal_id.to_string();
                            let mut terminals = terms.lock().await;
                            if let Some(handle) = terminals.get_mut(&terminal_id_str) {
                                if let Some(tx) = handle.kill_tx.lock().await.take() {
                                    let _ = tx.send(());
                                }
                            }
                            responder.respond(KillTerminalResponse::new())
                        }
                    }
                },
                acp::on_receive_request!(),
            )
            // --- catch-all: handle unregistered request methods (e.g. session/elicitation) ---
            .on_receive_request(
                {
                    move |request: acp::UntypedMessage, responder: acp::Responder<serde_json::Value>, _cx: acp::ConnectionTo<acp::Agent>| {
                        async move {
                            if request.method() == "elicitation/create" {
                                responder.respond(serde_json::json!({
                                    "action": { "action": "decline" }
                                }))
                            } else {
                                responder.respond_with_error(
                                    acp::Error::method_not_found().data(request.method().to_string())
                                )
                            }
                        }
                    }
                },
                acp::on_receive_request!(),
            )
            // --- Connect and run ---
            .connect_with(transport, async move |cx: acp::ConnectionTo<acp::Agent>| {
                // Initialize ACP connection
                let init_result = cx
                    .send_request(
                        InitializeRequest::new(ProtocolVersion::V1)
                            .client_info(Implementation::new("maestro-server", "0.1.0"))
                            .client_capabilities(ClientCapabilities::new().terminal(true)),
                    )
                    .block_task()
                    .await;
                if let Err(e) = init_result {
                    let _ = ready_tx.send(Err(format!("ACP initialize failed: {}", e)));
                    return Ok(());
                }

                // Create ACP session
                let session_req = acp::schema::NewSessionRequest::new(
                    std::path::PathBuf::from(&cwd_owned),
                );
                let session_result = cx
                    .build_session_from(session_req)
                    .block_task()
                    .start_session()
                    .await;
                let mut session: acp::ActiveSession<'_, _> = match session_result {
                    Ok(s) => s,
                    Err(e) => {
                        let _ = ready_tx.send(Err(format!("ACP new_session failed: {}", e)));
                        return Ok(());
                    }
                };

                // Signal readiness
                let _ = ready_tx.send(Ok(()));

                // Process commands from the stdin event loop
                while let Some(cmd) = cmd_rx.recv().await {
                    match cmd {
                        SessionCommand::Prompt(content) => {
                            if let Err(_e) = session.send_prompt(&content) {
                                // Prompt send failed — session may be dead.
                                // The connection task will exit on its own.
                                break;
                            }
                        }
                    }
                }

                Ok(())
            })
            .await;

        // Connection ended — child killed by kill_on_drop
        drop(child);
    });

    // Wait for the connection task to signal readiness
    match ready_rx.await {
        Ok(Ok(())) => Some(ActiveSession {
            cmd_tx,
            pending_permissions,
            task,
        }),
        Ok(Err(e)) => {
            let _ = send_response(
                &stdout,
                &MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse { message: e })),
            )
            .await;
            None
        }
        Err(_) => {
            let _ = send_response(
                &stdout,
                &MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
                    message: "ACP connection task exited unexpectedly".to_string(),
                })),
            )
            .await;
            None
        }
    }
}

/// Handle create_terminal request: spawn subprocess, set up background reader.
async fn handle_create_terminal(
    args: CreateTerminalRequest,
    terminals: Arc<Mutex<HashMap<String, TerminalHandle>>>,
    terminal_counter: Arc<AtomicU64>,
    stdout: Arc<Mutex<tokio::io::Stdout>>,
    maestro_session_id: String,
) -> acp::Result<CreateTerminalResponse> {
    // T-42-01: Validate cwd exists before spawning
    if let Some(ref cwd) = args.cwd {
        for component in cwd.components() {
            if component == std::path::Component::ParentDir {
                return Err(acp::Error::new(
                    -32603,
                    format!("cwd contains '..' component: {}", cwd.display()),
                ));
            }
        }
        match tokio::fs::metadata(cwd).await {
            Ok(meta) if meta.is_dir() => {}
            Ok(_) => {
                return Err(acp::Error::new(
                    -32603,
                    format!("cwd is not a directory: {}", cwd.display()),
                ));
            }
            Err(e) => {
                return Err(acp::Error::new(
                    -32603,
                    format!("cwd does not exist: {}: {}", cwd.display(), e),
                ));
            }
        }
    }

    let terminal_id = format!("term-{}", terminal_counter.fetch_add(1, Ordering::Relaxed) + 1);

    // T-42-02: Use Command::new(program).args(args) — never shell strings
    let mut cmd = tokio::process::Command::new(&args.command);
    cmd.args(&args.args);
    if let Some(ref cwd) = args.cwd {
        cmd.current_dir(cwd);
    }
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    cmd.kill_on_drop(true);

    let mut child = cmd
        .spawn()
        .map_err(|e| acp::Error::new(-32603, e.to_string()))?;

    let stdout_pipe = child.stdout.take();
    let stderr_pipe = child.stderr.take();

    let output_buf: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
    let exit_status: Arc<Mutex<Option<TerminalExitInfo>>> = Arc::new(Mutex::new(None));
    let exit_notify: Arc<Notify> = Arc::new(Notify::new());
    let (kill_tx, kill_rx) = oneshot::channel::<()>();

    let output_buf_bg = Arc::clone(&output_buf);
    let exit_status_bg = Arc::clone(&exit_status);
    let exit_notify_bg = Arc::clone(&exit_notify);
    let stdout_bg = Arc::clone(&stdout);
    let terminal_id_bg = terminal_id.clone();
    let output_byte_limit = args.output_byte_limit;

    // Background reader task — streams terminal output to stdout
    tokio::spawn(async move {
        use tokio::io::{AsyncBufReadExt, BufReader};

        let (line_tx, mut line_rx) = mpsc::channel::<String>(32);

        if let Some(pipe) = stdout_pipe {
            let tx = line_tx.clone();
            tokio::spawn(async move {
                let mut reader = BufReader::new(pipe).lines();
                while let Ok(Some(line)) = reader.next_line().await {
                    if tx.send(line).await.is_err() {
                        break;
                    }
                }
            });
        }

        if let Some(pipe) = stderr_pipe {
            let tx = line_tx.clone();
            tokio::spawn(async move {
                let mut reader = BufReader::new(pipe).lines();
                while let Ok(Some(line)) = reader.next_line().await {
                    if tx.send(line).await.is_err() {
                        break;
                    }
                }
            });
        }

        drop(line_tx);

        let mut kill_rx = kill_rx;
        let killed = loop {
            tokio::select! {
                biased;
                _ = &mut kill_rx => break true,
                item = line_rx.recv() => {
                    match item {
                        Some(line) => {
                            let chunk = format!("{}\n", line);
                            // T-42-03: Respect output_byte_limit — truncate from beginning
                            {
                                let mut buf = output_buf_bg.lock().await;
                                buf.push_str(&chunk);
                                if let Some(limit) = output_byte_limit {
                                    truncate_buf(&mut buf, limit as usize);
                                }
                            }
                            let msg = MaestroRpcMessage::Response(
                                ServerResponse::TerminalOutput(TerminalOutput {
                                    session_id: maestro_session_id.clone(),
                                    terminal_id: terminal_id_bg.clone(),
                                    bytes: chunk.into_bytes(),
                                }),
                            );
                            let _ = send_response(&stdout_bg, &msg).await;
                        }
                        None => break false,
                    }
                }
            }
        };

        if killed {
            let _ = child.start_kill();
        }

        let exit_info = match child.wait().await {
            Ok(status) => {
                let exit_code = status.code().map(|c| c as u32);
                #[cfg(unix)]
                let signal = {
                    use std::os::unix::process::ExitStatusExt;
                    status.signal().map(|s| format!("SIG{}", s))
                };
                #[cfg(not(unix))]
                let signal: Option<String> = None;
                TerminalExitInfo { exit_code, signal }
            }
            Err(_) => TerminalExitInfo {
                exit_code: None,
                signal: None,
            },
        };

        *exit_status_bg.lock().await = Some(exit_info);
        exit_notify_bg.notify_one();
    });

    let handle = TerminalHandle {
        output_buf,
        output_byte_limit: args.output_byte_limit,
        exit_status,
        exit_notify,
        kill_tx: Mutex::new(Some(kill_tx)),
    };
    terminals.lock().await.insert(terminal_id.clone(), handle);

    Ok(CreateTerminalResponse::new(TerminalId::new(&*terminal_id)))
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let stdout: Arc<Mutex<tokio::io::Stdout>> = Arc::new(Mutex::new(tokio::io::stdout()));
    let mut stdin = tokio::io::stdin();
    let mut sessions: SessionMap = HashMap::new();
    let mut agent_cache: Option<(std::time::Instant, Vec<registry::DiscoveredAgentWithSpawn>)> =
        None;
    const CACHE_TTL: std::time::Duration = std::time::Duration::from_secs(300);

    loop {
        let msg = match read_message(&mut stdin).await {
            Ok(msg) => msg,
            Err(e) => {
                let is_eof = e
                    .downcast_ref::<std::io::Error>()
                    .map(|io_err| io_err.kind() == std::io::ErrorKind::UnexpectedEof)
                    .unwrap_or_else(|| {
                        let s = e.to_string();
                        s.contains("early eof")
                            || s.contains("unexpected eof")
                            || s.contains("UnexpectedEof")
                    });
                if is_eof {
                    break;
                }
                let _ = send_response(
                    &stdout,
                    &MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
                        message: format!("read error: {}", e),
                    })),
                )
                .await;
                continue;
            }
        };

        match msg {
            MaestroRpcMessage::Request(ServerRequest::ListAgents(_req)) => {
                if ensure_agent_cache(&mut agent_cache, CACHE_TTL, &stdout).await {
                    continue;
                }
                let agents: Vec<DiscoveredAgent> = agent_cache
                    .as_ref()
                    .unwrap()
                    .1
                    .iter()
                    .map(|a| DiscoveredAgent {
                        id: a.id.clone(),
                        name: a.name.clone(),
                        icon: a.icon.clone(),
                    })
                    .collect();
                let _ = send_response(
                    &stdout,
                    &MaestroRpcMessage::Response(ServerResponse::ListAgentsOk(
                        ListAgentsResponse { agents },
                    )),
                )
                .await;
            }

            MaestroRpcMessage::Request(ServerRequest::Spawn(req)) => {
                // Look up spawn command from CDN-driven cache
                if ensure_agent_cache(&mut agent_cache, CACHE_TTL, &stdout).await {
                    continue;
                }
                let (spawn_cmd, spawn_args_owned, spawn_env) = match agent_cache
                    .as_ref()
                    .unwrap()
                    .1
                    .iter()
                    .find(|a| a.id == req.agent_id)
                {
                    Some(a) => (a.spawn_cmd.clone(), a.spawn_args.clone(), a.spawn_env.clone()),
                    None => {
                        let _ = send_response(
                            &stdout,
                            &MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
                                message: format!("Unknown agent: {}", req.agent_id),
                            })),
                        )
                        .await;
                        continue;
                    }
                };

                match spawn_acp_session(
                    &spawn_cmd,
                    &spawn_args_owned,
                    &spawn_env,
                    &req.cwd,
                    req.session_id.clone(),
                    Arc::clone(&stdout),
                )
                .await
                {
                    Some(session) => {
                        sessions.insert(req.session_id.clone(), session);
                        let _ = send_response(
                            &stdout,
                            &MaestroRpcMessage::Response(ServerResponse::SpawnOk(SpawnResponse {
                                session_id: req.session_id,
                            })),
                        )
                        .await;
                    }
                    None => {
                        // Error already sent by spawn_acp_session
                    }
                }
            }

            MaestroRpcMessage::Request(ServerRequest::Prompt(req)) => {
                if let Some(session) = sessions.get(&req.session_id) {
                    if session
                        .cmd_tx
                        .send(SessionCommand::Prompt(req.content))
                        .await
                        .is_err()
                    {
                        let _ = send_response(
                            &stdout,
                            &MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
                                message: format!(
                                    "session {} connection closed",
                                    req.session_id
                                ),
                            })),
                        )
                        .await;
                    }
                } else {
                    let _ = send_response(
                        &stdout,
                        &MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
                            message: format!("unknown session: {}", req.session_id),
                        })),
                    )
                    .await;
                }
            }

            MaestroRpcMessage::Request(ServerRequest::Cancel(req)) => {
                // Drop session — cmd_tx drop causes the connection task to exit,
                // which drops child (kill_on_drop)
                if let Some(session) = sessions.remove(&req.session_id) {
                    session.task.abort();
                }
            }

            MaestroRpcMessage::Request(ServerRequest::PermitResponse(perm_resp)) => {
                if let Some(session) = sessions.get(&perm_resp.session_id) {
                    if let Some(tx) = session
                        .pending_permissions
                        .lock()
                        .await
                        .remove(&perm_resp.request_id)
                    {
                        let _ = tx.send(perm_resp.allowed);
                    }
                }
            }

            MaestroRpcMessage::Response(_) => {}
        }
    }

    Ok(())
}
