#![cfg_attr(all(not(debug_assertions), target_os = "windows"), windows_subsystem = "windows")]
//! Maestro Remote Server
//!
//! Headless binary that runs on remote SSH hosts. Receives MaestroRpcMessage
//! commands from the local Maestro desktop app over stdin/stdout (piped through
//! SSH exec channel), spawns ACP agents as local subprocesses, and forwards
//! structured session updates back.
//!
//! Architecture: Adapted from Zed's remote_server (GPL-3.0).

mod agent;
mod command_ext;
mod file_ops;
mod session;
mod sessions;
mod terminal;

#[cfg(test)]
mod tests;

use std::collections::HashMap;
use std::sync::Arc;

use maestro_protocol::{
    read_message, AcpRegistry, CheckToolsResponse, DiscoveredAgent, ErrorResponse,
    FileReadResponse, FileSearchResponse, HandshakeResponse, ListAgentsResponse,
    MaestroRpcMessage, PreInitializeResponse, PROTOCOL_VERSION, ServerRequest, ServerResponse,
    SessionListOkResponse, SessionLoadOkResponse, SessionUpdate, SpawnResponse, ToolCheckResult,
};
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;

use file_ops::{handle_file_read, handle_file_search};
use session::{
    create_session_on_connection, load_acp_session, load_session_on_connection,
    pre_initialize_agent, run_session_close, run_session_list, session_close_on_connection,
    session_list_on_connection, spawn_acp_session,
};
use sessions::{AgentConnectionMap, SessionCommand, SessionMap};

async fn resolve_agent_spawn_params(
    agent_id: &str,
    agents: &[agent::registry::DiscoveredAgentWithSpawn],
    stdout: &Arc<Mutex<tokio::io::Stdout>>,
) -> Option<(String, Vec<String>, std::collections::HashMap<String, String>)> {
    eprintln!("[main] resolve_agent_spawn_params: agent_id={agent_id:?}");
    match agents.iter().find(|a| a.id == agent_id) {
        Some(a) => {
            eprintln!("[main] resolved: cmd={:?} args={:?}", a.spawn_cmd, a.spawn_args);
            Some((a.spawn_cmd.clone(), a.spawn_args.clone(), a.spawn_env.clone()))
        }
        None => {
            eprintln!("[main] agent not found: {agent_id:?}");
            let _ = send_response(
                stdout,
                &MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
                    message: format!("Unknown agent: {}", agent_id),
                })),
            )
            .await;
            None
        }
    }
}

/// Send a MaestroRpcMessage to stdout, flushing after every write.
pub(crate) async fn send_response(
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

fn main() {
    if std::env::args().any(|a| a == "--protocol-version") {
        println!("{}", PROTOCOL_VERSION);
        return;
    }
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("Failed to build tokio runtime")
        .block_on(async_main())
        .expect("maestro-server fatal error");
}

async fn async_main() -> Result<(), Box<dyn std::error::Error>> {
    let stdout: Arc<Mutex<tokio::io::Stdout>> = Arc::new(Mutex::new(tokio::io::stdout()));
    let mut stdin = tokio::io::stdin();
    let mut sessions: SessionMap = HashMap::new();
    let mut agent_connections: AgentConnectionMap = HashMap::new();

    let registry: AcpRegistry = tokio::task::spawn_blocking(agent::load_registry)
        .await
        .unwrap_or_else(|_| agent::load_registry());

    // Validate the protocol version handshake before entering the main dispatch loop.
    // Agent discovery (which::which PATH scanning) runs AFTER handshake so the client
    // does not time out waiting on slow PATH scans on Windows.
    let first_msg = match read_message(&mut stdin).await {
        Ok(msg) => msg,
        Err(_) => return Ok(()),
    };
    match first_msg {
        MaestroRpcMessage::Request(ServerRequest::Handshake(req)) => {
            if req.protocol_version != PROTOCOL_VERSION {
                let _ = send_response(
                    &stdout,
                    &MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
                        message: format!(
                            "protocol version mismatch: server={}, client={}",
                            PROTOCOL_VERSION, req.protocol_version
                        ),
                    })),
                )
                .await;
                return Ok(());
            }
            let _ = send_response(
                &stdout,
                &MaestroRpcMessage::Response(ServerResponse::HandshakeOk(HandshakeResponse {
                    protocol_version: PROTOCOL_VERSION,
                })),
            )
            .await;
        }
        _ => {
            let _ = send_response(
                &stdout,
                &MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
                    message: "expected Handshake as first message".to_string(),
                })),
            )
            .await;
            return Ok(());
        }
    }

    let agents_with_spawn: Vec<agent::registry::DiscoveredAgentWithSpawn> = agent::discover_agents(&registry);

    // Break the loop if stdout write fails — server can't communicate, no point continuing.
    macro_rules! send_or_break {
        ($e:expr) => {
            if ($e).is_err() {
                break;
            }
        };
    }

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
                send_or_break!(send_response(
                    &stdout,
                    &MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
                        message: format!("read error: {}", e),
                    })),
                )
                .await);
                continue;
            }
        };

        match msg {
            MaestroRpcMessage::Request(ServerRequest::ListAgents(_req)) => {
                let agents: Vec<DiscoveredAgent> = agents_with_spawn
                    .iter()
                    .map(|a| DiscoveredAgent {
                        id: a.id.clone(),
                        name: a.name.clone(),
                        icon: a.icon.clone(),
                        spawn_deps: a.spawn_deps.clone(),
                    })
                    .collect();
                send_or_break!(send_response(
                    &stdout,
                    &MaestroRpcMessage::Response(ServerResponse::ListAgentsOk(
                        ListAgentsResponse { agents },
                    )),
                )
                .await);
            }

            MaestroRpcMessage::Request(ServerRequest::Spawn(req)) => {
                eprintln!("[main] Spawn request: agent_id={:?} session_id={:?} cwd={:?}", req.agent_id, req.session_id, req.cwd);
                let used_fast_path = agent_connections.contains_key(&req.agent_id);
                eprintln!("[main] fast_path={used_fast_path}");
                let result = if used_fast_path {
                    let conn = agent_connections.get(&req.agent_id).unwrap();
                    create_session_on_connection(
                        conn,
                        req.session_id.clone(),
                        &req.cwd,
                        Arc::clone(&stdout),
                    )
                    .await
                } else {
                    let Some((spawn_cmd, spawn_args_owned, spawn_env)) =
                        resolve_agent_spawn_params(&req.agent_id, &agents_with_spawn, &stdout).await
                    else { continue; };
                    spawn_acp_session(
                        &spawn_cmd,
                        &spawn_args_owned,
                        &spawn_env,
                        &req.cwd,
                        req.session_id.clone(),
                        Arc::clone(&stdout),
                    )
                    .await
                };

                if used_fast_path && result.is_none() {
                    agent_connections.remove(&req.agent_id);
                }

                if let Some(result) = result {
                    let response = SpawnResponse {
                        session_id: req.session_id.clone(),
                        acp_session_id: Some(result.acp_session_id),
                        models: result.models,
                        modes: result.modes,
                        prompt_capabilities: Some(result.prompt_capabilities),
                        supports_session_list: result.supports_session_list,
                        supports_session_load: result.supports_session_load,
                        supports_session_close: result.supports_session_close,
                    };
                    sessions.insert(req.session_id, result.session);
                    send_or_break!(send_response(
                        &stdout,
                        &MaestroRpcMessage::Response(ServerResponse::SpawnOk(response)),
                    )
                    .await);
                }
                // None: error already sent by spawn function
            }

            MaestroRpcMessage::Request(ServerRequest::Prompt(req)) => {
                if let Some(session) = sessions.get(&req.session_id) {
                    let sent_at = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis() as u64;
                    send_or_break!(send_response(
                        &stdout,
                        &MaestroRpcMessage::Response(ServerResponse::SessionUpdate(SessionUpdate {
                            session_id: req.session_id.clone(),
                            payload: serde_json::json!({
                                "sessionUpdate": "user_message",
                                "content": req.content,
                                "sentAt": sent_at,
                            }),
                        })),
                    )
                    .await);
                    let cmd = match req.content {
                        serde_json::Value::Array(blocks) => {
                            SessionCommand::PromptStructured(blocks)
                        }
                        other => {
                            SessionCommand::Prompt(other.as_str().unwrap_or("").to_string())
                        }
                    };
                    if session.cmd_tx.send(cmd).await.is_err() {
                        send_or_break!(send_response(
                            &stdout,
                            &MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
                                message: format!(
                                    "session {} connection closed",
                                    req.session_id
                                ),
                            })),
                        )
                        .await);
                    }
                } else {
                    send_or_break!(send_response(
                        &stdout,
                        &MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
                            message: format!("unknown session: {}", req.session_id),
                        })),
                    )
                    .await);
                }
            }

            MaestroRpcMessage::Request(ServerRequest::Cancel(req)) => {
                if let Some(session) = sessions.remove(&req.session_id) {
                    if session.cmd_tx.try_send(SessionCommand::CloseSession).is_ok() {
                        // Graceful close: command loop sends CloseSessionRequest to agent.
                        // Watchdog force-aborts after 5s if the loop stalls.
                        let abort_handle = session.task.abort_handle();
                        let cleanup = session.cleanup;
                        tokio::spawn(async move {
                            let timed_out = tokio::time::timeout(
                                std::time::Duration::from_secs(5),
                                session.task,
                            )
                            .await
                            .is_err();
                            if timed_out {
                                abort_handle.abort();
                                if let Some(c) = cleanup {
                                    c.router.unregister(&c.acp_session_id).await;
                                }
                            }
                        });
                    } else {
                        // Channel full or closed — force abort and clean up manually.
                        session.task.abort();
                        if let Some(c) = session.cleanup {
                            c.router.unregister(&c.acp_session_id).await;
                        }
                    }
                }
            }

            MaestroRpcMessage::Request(ServerRequest::InterruptTurn(req)) => {
                if let Some(session) = sessions.get(&req.session_id) {
                    let _ = session.cmd_tx.send(SessionCommand::CancelTurn).await;
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
                        let _ = tx.send(perm_resp.option_id);
                    }
                }
            }

            MaestroRpcMessage::Request(ServerRequest::ElicitationResponse(elicit_resp)) => {
                if let Some(session) = sessions.get(&elicit_resp.session_id) {
                    if let Some(tx) = session
                        .pending_elicitations
                        .lock()
                        .await
                        .remove(&elicit_resp.request_id)
                    {
                        let _ = tx.send(elicit_resp.response);
                    }
                }
            }

            MaestroRpcMessage::Request(ServerRequest::SetModel(set_model_req)) => {
                if let Some(session) = sessions.get(&set_model_req.session_id) {
                    if session
                        .cmd_tx
                        .send(SessionCommand::SetModel(set_model_req.model_id))
                        .await
                        .is_err()
                    {
                        send_or_break!(send_response(
                            &stdout,
                            &MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
                                message: format!(
                                    "session {} connection closed",
                                    set_model_req.session_id
                                ),
                            })),
                        )
                        .await);
                    }
                } else {
                    send_or_break!(send_response(
                        &stdout,
                        &MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
                            message: format!("unknown session: {}", set_model_req.session_id),
                        })),
                    )
                    .await);
                }
            }

            MaestroRpcMessage::Request(ServerRequest::SetMode(set_mode_req)) => {
                if let Some(session) = sessions.get(&set_mode_req.session_id) {
                    if session
                        .cmd_tx
                        .send(SessionCommand::SetMode(set_mode_req.mode_id))
                        .await
                        .is_err()
                    {
                        send_or_break!(send_response(
                            &stdout,
                            &MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
                                message: format!(
                                    "session {} connection closed",
                                    set_mode_req.session_id
                                ),
                            })),
                        )
                        .await);
                    }
                } else {
                    send_or_break!(send_response(
                        &stdout,
                        &MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
                            message: format!("unknown session: {}", set_mode_req.session_id),
                        })),
                    )
                    .await);
                }
            }

            MaestroRpcMessage::Request(ServerRequest::SetConfigOption(req)) => {
                if let Some(session) = sessions.get(&req.session_id) {
                    if session
                        .cmd_tx
                        .send(SessionCommand::SetConfigOption {
                            config_id: req.config_id,
                            value: req.value,
                        })
                        .await
                        .is_err()
                    {
                        send_or_break!(send_response(
                            &stdout,
                            &MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
                                message: format!("session {} connection closed", req.session_id),
                            })),
                        )
                        .await);
                    }
                } else {
                    send_or_break!(send_response(
                        &stdout,
                        &MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
                            message: format!("unknown session: {}", req.session_id),
                        })),
                    )
                    .await);
                }
            }

            MaestroRpcMessage::Request(ServerRequest::FileSearch(req)) => {
                let result = tokio::task::spawn_blocking(move || handle_file_search(req))
                    .await
                    .unwrap_or_else(|e| Err(format!("spawn_blocking: {}", e)));
                let response = match result {
                    Ok(files) => MaestroRpcMessage::Response(ServerResponse::FileSearchOk(
                        FileSearchResponse { files },
                    )),
                    Err(msg) => MaestroRpcMessage::Response(ServerResponse::Error(
                        ErrorResponse { message: msg },
                    )),
                };
                send_or_break!(send_response(&stdout, &response).await);
            }

            MaestroRpcMessage::Request(ServerRequest::FileRead(req)) => {
                let result = handle_file_read(&req).await;
                let response = match result {
                    Ok(content) => MaestroRpcMessage::Response(ServerResponse::FileReadOk(
                        FileReadResponse { content },
                    )),
                    Err(msg) => MaestroRpcMessage::Response(ServerResponse::Error(
                        ErrorResponse { message: msg },
                    )),
                };
                send_or_break!(send_response(&stdout, &response).await);
            }

            MaestroRpcMessage::Request(ServerRequest::SessionList(req)) => {
                let used_fast_path = agent_connections.contains_key(&req.agent_id);
                let list_result = if used_fast_path {
                    let conn = agent_connections.get(&req.agent_id).unwrap();
                    session_list_on_connection(conn, &req.cwd, req.cursor).await
                } else {
                    let Some((spawn_cmd, spawn_args_owned, spawn_env)) =
                        resolve_agent_spawn_params(&req.agent_id, &agents_with_spawn, &stdout).await
                    else { continue; };
                    run_session_list(&spawn_cmd, &spawn_args_owned, &spawn_env, &req.cwd, req.cursor).await
                };
                if used_fast_path && list_result.is_err() {
                    agent_connections.remove(&req.agent_id);
                }
                match list_result {
                    Ok((sessions_list, next_cursor)) => {
                        send_or_break!(send_response(
                            &stdout,
                            &MaestroRpcMessage::Response(ServerResponse::SessionListOk(
                                SessionListOkResponse { sessions: sessions_list, next_cursor },
                            )),
                        )
                        .await);
                    }
                    Err(e) => {
                        send_or_break!(send_response(
                            &stdout,
                            &MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
                                message: e,
                            })),
                        )
                        .await);
                    }
                }
            }

            MaestroRpcMessage::Request(ServerRequest::SessionLoad(req)) => {
                let used_fast_path = agent_connections.contains_key(&req.agent_id);
                let result = if used_fast_path {
                    let conn = agent_connections.get(&req.agent_id).unwrap();
                    load_session_on_connection(
                        conn,
                        req.session_id.clone(),
                        req.resume_session_id.clone(),
                        &req.cwd,
                        Arc::clone(&stdout),
                    )
                    .await
                } else {
                    let Some((spawn_cmd, spawn_args_owned, spawn_env)) =
                        resolve_agent_spawn_params(&req.agent_id, &agents_with_spawn, &stdout).await
                    else { continue; };
                    load_acp_session(
                        &spawn_cmd,
                        &spawn_args_owned,
                        &spawn_env,
                        &req.cwd,
                        req.resume_session_id.clone(),
                        req.session_id.clone(),
                        Arc::clone(&stdout),
                    )
                    .await
                };

                if used_fast_path && result.is_none() {
                    agent_connections.remove(&req.agent_id);
                }

                if let Some((session, models, modes, prompt_caps)) = result {
                    sessions.insert(req.session_id.clone(), session);
                    send_or_break!(send_response(
                        &stdout,
                        &MaestroRpcMessage::Response(ServerResponse::SessionLoadOk(
                            SessionLoadOkResponse {
                                session_id: req.session_id.clone(),
                                models,
                                modes,
                                prompt_capabilities: Some(prompt_caps),
                            },
                        )),
                    )
                    .await);
                }
            }

            MaestroRpcMessage::Request(ServerRequest::SessionClose(req)) => {
                let used_fast_path = agent_connections.contains_key(&req.agent_id);
                let close_result = if used_fast_path {
                    let conn = agent_connections.get(&req.agent_id).unwrap();
                    session_close_on_connection(conn, req.session_id).await
                } else {
                    let Some((spawn_cmd, spawn_args_owned, spawn_env)) =
                        resolve_agent_spawn_params(&req.agent_id, &agents_with_spawn, &stdout).await
                    else { continue; };
                    run_session_close(&spawn_cmd, &spawn_args_owned, &spawn_env, &req.cwd, req.session_id).await
                };
                if used_fast_path && close_result.is_err() {
                    agent_connections.remove(&req.agent_id);
                }
                match close_result {
                    Ok(()) => {
                        send_or_break!(send_response(
                            &stdout,
                            &MaestroRpcMessage::Response(ServerResponse::SessionCloseOk),
                        )
                        .await);
                    }
                    Err(e) => {
                        send_or_break!(send_response(
                            &stdout,
                            &MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
                                message: e,
                            })),
                        )
                        .await);
                    }
                }
            }

            MaestroRpcMessage::Request(ServerRequest::Handshake(_)) => {
                send_or_break!(send_response(
                    &stdout,
                    &MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
                        message: "unexpected Handshake after initialization".to_string(),
                    })),
                )
                .await);
            }

            MaestroRpcMessage::Request(ServerRequest::PreInitialize(req)) => {
                let Some((spawn_cmd, spawn_args_owned, spawn_env)) =
                    resolve_agent_spawn_params(&req.agent_id, &agents_with_spawn, &stdout).await
                else { continue; };
                match pre_initialize_agent(
                    &spawn_cmd,
                    &spawn_args_owned,
                    &spawn_env,
                    &req.cwd,
                    Arc::clone(&stdout),
                )
                .await
                {
                    Some(conn) => {
                        // Create a warm session to obtain models/modes immediately.
                        let warm_result = create_session_on_connection(
                            &conn,
                            "prewarmed".to_string(),
                            &req.cwd,
                            Arc::clone(&stdout),
                        )
                        .await;
                        let (models, modes) = match &warm_result {
                            Some(r) => (r.models.clone(), r.modes.clone()),
                            None => (None, None),
                        };
                        if let Some(result) = warm_result {
                            sessions.insert("prewarmed".to_string(), result.session);
                        }

                        let response = PreInitializeResponse {
                            agent_id: req.agent_id.clone(),
                            prompt_capabilities: conn.capabilities.prompt_capabilities.clone(),
                            supports_session_list: conn.capabilities.supports_session_list,
                            supports_session_load: conn.capabilities.supports_session_load,
                            supports_session_close: conn.capabilities.supports_session_close,
                            models,
                            modes,
                        };
                        agent_connections.insert(req.agent_id, conn);
                        send_or_break!(send_response(
                            &stdout,
                            &MaestroRpcMessage::Response(ServerResponse::PreInitializeOk(
                                response,
                            )),
                        )
                        .await);
                    }
                    None => {
                        // Error already sent by pre_initialize_agent
                    }
                }
            }

            MaestroRpcMessage::Request(ServerRequest::CheckTools(req)) => {
                let results = check_tools(req.tools).await;
                send_or_break!(send_response(
                    &stdout,
                    &MaestroRpcMessage::Response(ServerResponse::CheckToolsOk(
                        CheckToolsResponse { results },
                    )),
                )
                .await);
            }

            MaestroRpcMessage::Request(ServerRequest::DetectInstalledAgents(_req)) => {
                let response = agent::detection::detect_installed_agents().await;
                send_or_break!(send_response(
                    &stdout,
                    &MaestroRpcMessage::Response(ServerResponse::DetectInstalledAgentsOk(
                        response,
                    )),
                )
                .await);
            }

            MaestroRpcMessage::Request(ServerRequest::DetectProjectAgents(req)) => {
                let response = agent::detection::detect_project_agents(&req.cwd).await;
                send_or_break!(send_response(
                    &stdout,
                    &MaestroRpcMessage::Response(ServerResponse::DetectProjectAgentsOk(
                        response,
                    )),
                )
                .await);
            }

            MaestroRpcMessage::Response(_) => {}
        }
    }

    // Abort all active session tasks so agent child processes are killed promptly.
    for (_id, session) in sessions.drain() {
        session.task.abort();
        if let Some(c) = session.cleanup {
            c.router.unregister(&c.acp_session_id).await;
        }
    }

    Ok(())
}

async fn probe_tool(tool: &str) -> (bool, Option<String>) {
    // On Windows, tools like npx/uvx are .cmd batch files — CreateProcess won't find them
    // without going through cmd.exe. Check exit code too since cmd.exe always launches.
    #[cfg(windows)]
    let result = {
        use crate::command_ext::NoConsoleWindow;
        tokio::process::Command::new("cmd")
            .args(["/c", tool, "--version"])
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .no_console_window()
            .output()
            .await
    };
    #[cfg(not(windows))]
    let result = tokio::process::Command::new(tool)
        .arg("--version")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .output()
        .await;

    match result {
        Err(_) => (false, None),
        Ok(out) => {
            #[cfg(windows)]
            if !out.status.success() {
                return (false, None);
            }
            let raw = if out.stdout.is_empty() { out.stderr } else { out.stdout };
            let ver = String::from_utf8(raw)
                .ok()
                .map(|s| s.lines().next().unwrap_or("").trim().to_string())
                .filter(|s| !s.is_empty());
            (true, ver)
        }
    }
}

async fn check_tools(tools: Vec<String>) -> Vec<ToolCheckResult> {
    let handles: Vec<_> = tools
        .into_iter()
        .map(|tool| {
            tokio::spawn(async move {
                let (available, version) = probe_tool(&tool).await;
                ToolCheckResult { tool, available, version }
            })
        })
        .collect();

    futures::future::join_all(handles)
        .await
        .into_iter()
        .filter_map(Result::ok)
        .collect()
}
