use std::sync::Arc;

use maestro_protocol::{
    AUTH_REQUIRED_ERROR, AuthTerminalExitResponse, CheckToolsResponse, DiscoveredAgent,
    ErrorResponse, FileReadResponse, FileSearchResponse, ListAgentsResponse, MaestroRpcMessage,
    PreInitializeResponse, ServerRequest, ServerResponse, SessionListOkResponse,
    SessionLoadOkResponse, SessionUpdate, SpawnResponse,
};
use tokio::sync::Mutex;

use crate::agent;
use crate::file_ops::{handle_file_read, handle_file_search};
use crate::helpers::{
    ensure_and_get_connection, forward_to_session, resolve_agent_spawn_params, send_diag,
    send_response,
};
use crate::session::{
    create_session_on_connection, load_session_on_connection, pre_initialize_agent,
    session_close_on_connection, session_delete_on_connection, session_list_on_connection,
};
use crate::sessions::{
    ActiveSession, AgentConnectionHandle, SessionCommand, SessionMap, SharedAgentConnections,
};
use crate::tool_check::check_tools;

pub(crate) struct AuthTerminalState {
    pub kill_tx: tokio::sync::oneshot::Sender<()>,
    pub input_tx: tokio::sync::mpsc::Sender<Vec<u8>>,
}

/// Handle one message from stdin.
///
/// Returns `true`  → the main loop should continue.
/// Returns `false` → stdout is broken; the main loop should break.
pub(crate) async fn dispatch_message(
    msg: MaestroRpcMessage,
    sessions: &mut SessionMap,
    agent_connections: &SharedAgentConnections,
    agents_with_spawn: &mut Vec<agent::registry::DiscoveredAgentWithSpawn>,
    stdout: &Arc<Mutex<tokio::io::Stdout>>,
    spawn_result_tx: &tokio::sync::mpsc::Sender<(String, ActiveSession)>,
    auth_terminals: &Arc<tokio::sync::Mutex<std::collections::HashMap<String, AuthTerminalState>>>,
) -> bool {
    // If stdout is broken we return false so the main loop breaks.
    macro_rules! send_or_return {
        ($e:expr) => {
            if ($e).is_err() {
                return false;
            }
        };
    }

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
            send_or_return!(send_response(
                stdout,
                &MaestroRpcMessage::Response(ServerResponse::ListAgentsOk(
                    ListAgentsResponse { agents },
                )),
            )
            .await);
        }

        MaestroRpcMessage::Request(ServerRequest::Spawn(req)) => {
            send_diag(
                "info",
                format!(
                    "[spawn] Spawn agent_id={:?} session_id={:?} cwd={:?}",
                    req.agent_id, req.session_id, req.cwd
                ),
            );
            // Resolve spawn params inline (fast: in-memory list search) so the task
            // doesn't need to borrow agents_with_spawn.
            let Some((cmd, args, env)) =
                resolve_agent_spawn_params(&req.agent_id, agents_with_spawn, stdout).await
            else {
                return true;
            };
            let stdout_task = Arc::clone(stdout);
            let agent_connections_task = Arc::clone(agent_connections);
            let spawn_result_tx = spawn_result_tx.clone();
            // Offload the blocking ACP operations to a separate task so the main loop
            // stays responsive to PermitResponse and other messages.
            tokio::spawn(async move {
                let conn_handle = ensure_and_get_connection(
                    &req.agent_id,
                    &agent_connections_task,
                    &cmd,
                    &args,
                    &env,
                    &req.cwd,
                    &stdout_task,
                )
                .await;
                let conn_handle = match conn_handle {
                    Some(h) => h,
                    None => return,
                };
                let result = create_session_on_connection(
                    &conn_handle,
                    req.session_id.clone(),
                    &req.cwd,
                    Arc::clone(&stdout_task),
                )
                .await;
                let mut result = match result {
                    Err(msg) => {
                        // Keep connection alive for auth_required so Authenticate can follow.
                        // Evict on any other failure (broken connection, protocol error, etc.).
                        if msg != AUTH_REQUIRED_ERROR {
                            let mut connections = agent_connections_task.lock().await;
                            if connections
                                .get(&req.agent_id)
                                .map(|c| Arc::ptr_eq(&c.router, &conn_handle.router))
                                .unwrap_or(false)
                            {
                                connections.remove(&req.agent_id);
                            }
                        }
                        return;
                    }
                    Ok(r) => r,
                };
                let response = SpawnResponse {
                    session_id: req.session_id.clone(),
                    acp_session_id: Some(result.acp_session_id),
                    models: result.models,
                    modes: result.modes,
                    prompt_capabilities: Some(result.prompt_capabilities),
                    supports_session_list: result.supports_session_list,
                    supports_session_load: result.supports_session_load,
                    supports_session_close: result.supports_session_close,
                    supports_session_delete: result.supports_session_delete,
                    config_options: result.config_options,
                };
                result.session.agent_id = req.agent_id;
                result.session.cwd = req.cwd;
                if send_response(
                    &stdout_task,
                    &MaestroRpcMessage::Response(ServerResponse::SpawnOk(response)),
                )
                .await
                .is_ok()
                {
                    let _ = spawn_result_tx.send((req.session_id, result.session)).await;
                }
            });
        }

        MaestroRpcMessage::Request(ServerRequest::Prompt(req)) => {
            if let Some(session) = sessions.get(&req.session_id) {
                let sent_at = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as u64;
                send_or_return!(send_response(
                    stdout,
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
                    serde_json::Value::Array(blocks) => SessionCommand::PromptStructured(blocks),
                    other => SessionCommand::Prompt(other.as_str().unwrap_or("").to_string()),
                };
                if session.cmd_tx.send(cmd).await.is_err() {
                    send_or_return!(send_response(
                        stdout,
                        &MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
                            message: format!("session {} connection closed", req.session_id),
                            session_id: None,
                        })),
                    )
                    .await);
                }
            } else {
                send_or_return!(send_response(
                    stdout,
                    &MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
                        message: format!("unknown session: {}", req.session_id),
                        session_id: None,
                    })),
                )
                .await);
            }
        }

        MaestroRpcMessage::Request(ServerRequest::Cancel(req)) => {
            if let Some(session) = sessions.remove(&req.session_id) {
                let session_agent_id = session.agent_id.clone();
                if session.cmd_tx.try_send(SessionCommand::CloseSession).is_ok() {
                    // Graceful close: command loop sends CloseSessionRequest to agent.
                    // Watchdog force-aborts after 5s if the loop stalls.
                    let abort_handle = session.task.abort_handle();
                    let cleanup = session.cleanup;
                    let agent_connections_cancel = Arc::clone(agent_connections);
                    tokio::spawn(async move {
                        let timed_out = tokio::time::timeout(
                            std::time::Duration::from_secs(5),
                            session.task,
                        )
                        .await
                        .is_err();
                        if timed_out {
                            abort_handle.abort();
                        }
                        if let Some(c) = cleanup {
                            if timed_out {
                                c.router.unregister(&c.acp_session_id).await;
                            }
                            if c.router.is_empty().await {
                                agent_connections_cancel
                                    .lock()
                                    .await
                                    .remove(&session_agent_id);
                            }
                        }
                    });
                } else {
                    // Channel full or closed — force abort and clean up manually.
                    session.task.abort();
                    if let Some(c) = session.cleanup {
                        c.router.unregister(&c.acp_session_id).await;
                        if c.router.is_empty().await {
                            agent_connections.lock().await.remove(&session_agent_id);
                        }
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
            send_or_return!(
                forward_to_session(
                    sessions,
                    &set_model_req.session_id,
                    SessionCommand::SetModel(set_model_req.model_id),
                    stdout,
                )
                .await
            );
        }

        MaestroRpcMessage::Request(ServerRequest::SetMode(set_mode_req)) => {
            send_or_return!(
                forward_to_session(
                    sessions,
                    &set_mode_req.session_id,
                    SessionCommand::SetMode(set_mode_req.mode_id),
                    stdout,
                )
                .await
            );
        }

        MaestroRpcMessage::Request(ServerRequest::SetConfigOption(req)) => {
            send_or_return!(
                forward_to_session(
                    sessions,
                    &req.session_id,
                    SessionCommand::SetConfigOption {
                        config_id: req.config_id,
                        value: req.value,
                    },
                    stdout,
                )
                .await
            );
        }

        MaestroRpcMessage::Request(ServerRequest::FileSearch(req)) => {
            let result = tokio::task::spawn_blocking(move || handle_file_search(req))
                .await
                .unwrap_or_else(|e| Err(format!("spawn_blocking: {}", e)));
            let response = match result {
                Ok(files) => MaestroRpcMessage::Response(ServerResponse::FileSearchOk(
                    FileSearchResponse { files },
                )),
                Err(msg) => MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
                    message: msg,
                    session_id: None,
                })),
            };
            send_or_return!(send_response(stdout, &response).await);
        }

        MaestroRpcMessage::Request(ServerRequest::FileRead(req)) => {
            let result = handle_file_read(&req).await;
            let response = match result {
                Ok(content) => MaestroRpcMessage::Response(ServerResponse::FileReadOk(
                    FileReadResponse { content },
                )),
                Err(msg) => MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
                    message: msg,
                    session_id: None,
                })),
            };
            send_or_return!(send_response(stdout, &response).await);
        }

        MaestroRpcMessage::Request(ServerRequest::SessionList(req)) => {
            let conn_handle = agent_connections
                .lock()
                .await
                .get(&req.agent_id)
                .map(AgentConnectionHandle::from);
            let Some(conn_handle) = conn_handle else {
                send_or_return!(send_response(
                    stdout,
                    &MaestroRpcMessage::Response(ServerResponse::SessionListOk(
                        SessionListOkResponse { sessions: vec![], next_cursor: None, supports_session_delete: false },
                    )),
                )
                .await);
                return true;
            };
            let supports_session_delete = conn_handle.capabilities.supports_session_delete;
            let list_result =
                session_list_on_connection(&conn_handle, &req.cwd, req.cursor).await;
            if list_result.is_err() {
                let mut connections = agent_connections.lock().await;
                if connections
                    .get(&req.agent_id)
                    .map(|c| Arc::ptr_eq(&c.router, &conn_handle.router))
                    .unwrap_or(false)
                {
                    connections.remove(&req.agent_id);
                }
            }
            match list_result {
                Ok((sessions_list, next_cursor)) => {
                    send_or_return!(send_response(
                        stdout,
                        &MaestroRpcMessage::Response(ServerResponse::SessionListOk(
                            SessionListOkResponse { sessions: sessions_list, next_cursor, supports_session_delete },
                        )),
                    )
                    .await);
                }
                Err(e) => {
                    send_or_return!(send_response(
                        stdout,
                        &MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
                            message: e,
                            session_id: None,
                        })),
                    )
                    .await);
                }
            }
        }

        MaestroRpcMessage::Request(ServerRequest::SessionLoad(req)) => {
            let Some((cmd, args, env)) =
                resolve_agent_spawn_params(&req.agent_id, agents_with_spawn, stdout).await
            else {
                return true;
            };
            let stdout_task = Arc::clone(stdout);
            let agent_connections_task = Arc::clone(agent_connections);
            let spawn_result_tx = spawn_result_tx.clone();
            tokio::spawn(async move {
                let conn_handle = ensure_and_get_connection(
                    &req.agent_id,
                    &agent_connections_task,
                    &cmd,
                    &args,
                    &env,
                    &req.cwd,
                    &stdout_task,
                )
                .await;
                let conn_handle = match conn_handle {
                    Some(h) => h,
                    None => return,
                };
                let result = load_session_on_connection(
                    &conn_handle,
                    req.session_id.clone(),
                    req.resume_session_id.clone(),
                    &req.cwd,
                    Arc::clone(&stdout_task),
                )
                .await;
                match result {
                    Err(()) => {
                        let mut connections = agent_connections_task.lock().await;
                        if connections
                            .get(&req.agent_id)
                            .map(|c| Arc::ptr_eq(&c.router, &conn_handle.router))
                            .unwrap_or(false)
                        {
                            connections.remove(&req.agent_id);
                        }
                    }
                    Ok(None) => {}
                    Ok(Some((mut session, models, modes, prompt_caps, config_options))) => {
                        session.agent_id = req.agent_id;
                        session.cwd = req.cwd;
                        let session_id = req.session_id.clone();
                        if send_response(
                            &stdout_task,
                            &MaestroRpcMessage::Response(ServerResponse::SessionLoadOk(
                                SessionLoadOkResponse {
                                    session_id: req.session_id,
                                    models,
                                    modes,
                                    prompt_capabilities: Some(prompt_caps),
                                    config_options,
                                },
                            )),
                        )
                        .await
                        .is_ok()
                        {
                            let _ = spawn_result_tx.send((session_id, session)).await;
                        }
                    }
                }
            });
        }

        MaestroRpcMessage::Request(ServerRequest::SessionClose(req)) => {
            let conn_handle = agent_connections
                .lock()
                .await
                .get(&req.agent_id)
                .map(AgentConnectionHandle::from);
            let close_result = match conn_handle {
                Some(ref handle) => {
                    session_close_on_connection(handle, req.session_id.clone()).await
                }
                None => Err(format!(
                    "no connection found for agent {} with session {}",
                    req.agent_id, req.session_id
                )),
            };
            if let (Some(ref handle), Err(_)) = (&conn_handle, &close_result) {
                let mut connections = agent_connections.lock().await;
                if connections
                    .get(&req.agent_id)
                    .map(|c| Arc::ptr_eq(&c.router, &handle.router))
                    .unwrap_or(false)
                {
                    connections.remove(&req.agent_id);
                }
            }
            match close_result {
                Ok(()) => {
                    send_or_return!(send_response(
                        stdout,
                        &MaestroRpcMessage::Response(ServerResponse::SessionCloseOk),
                    )
                    .await);
                }
                Err(e) => {
                    send_or_return!(send_response(
                        stdout,
                        &MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
                            message: e,
                            session_id: None,
                        })),
                    )
                    .await);
                }
            }
        }

        MaestroRpcMessage::Request(ServerRequest::SessionDelete(req)) => {
            let conn_handle = agent_connections
                .lock()
                .await
                .get(&req.agent_id)
                .map(AgentConnectionHandle::from);
            let delete_result = match conn_handle {
                Some(ref handle) => {
                    session_delete_on_connection(handle, req.session_id.clone()).await
                }
                None => Err(format!(
                    "no connection found for agent {} with session {}",
                    req.agent_id, req.session_id
                )),
            };
            if let (Some(ref handle), Err(_)) = (&conn_handle, &delete_result) {
                let mut connections = agent_connections.lock().await;
                if connections
                    .get(&req.agent_id)
                    .map(|c| Arc::ptr_eq(&c.router, &handle.router))
                    .unwrap_or(false)
                {
                    connections.remove(&req.agent_id);
                }
            }
            match delete_result {
                Ok(()) => {
                    send_or_return!(send_response(
                        stdout,
                        &MaestroRpcMessage::Response(ServerResponse::SessionDeleteOk),
                    )
                    .await);
                }
                Err(e) => {
                    send_or_return!(send_response(
                        stdout,
                        &MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
                            message: e,
                            session_id: None,
                        })),
                    )
                    .await);
                }
            }
        }

        MaestroRpcMessage::Request(ServerRequest::Handshake(_)) => {
            send_or_return!(send_response(
                stdout,
                &MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
                    message: "unexpected Handshake after initialization".to_string(),
                    session_id: None,
                })),
            )
            .await);
        }

        MaestroRpcMessage::Request(ServerRequest::PreInitialize(req)) => {
            let Some((spawn_cmd, spawn_args_owned, spawn_env)) =
                resolve_agent_spawn_params(&req.agent_id, agents_with_spawn, stdout).await
            else {
                return true;
            };
            match pre_initialize_agent(
                &spawn_cmd,
                &spawn_args_owned,
                &spawn_env,
                &req.cwd,
                Arc::clone(stdout),
            )
            .await
            {
                Some(conn) => {
                    let response = PreInitializeResponse {
                        agent_id: req.agent_id.clone(),
                        prompt_capabilities: conn.capabilities.prompt_capabilities.clone(),
                        supports_session_list: conn.capabilities.supports_session_list,
                        supports_session_load: conn.capabilities.supports_session_load,
                        supports_session_close: conn.capabilities.supports_session_close,
                        supports_session_delete: conn.capabilities.supports_session_delete,
                        auth_methods: conn.capabilities.auth_methods.clone(),
                        supports_auth_logout: conn.capabilities.supports_auth_logout,
                    };
                    agent_connections.lock().await.insert(req.agent_id, conn);
                    send_or_return!(send_response(
                        stdout,
                        &MaestroRpcMessage::Response(ServerResponse::PreInitializeOk(response)),
                    )
                    .await);
                }
                None => {
                    // Error already sent by pre_initialize_agent
                }
            }
        }

        MaestroRpcMessage::Request(ServerRequest::Authenticate(req)) => {
            let (conn_opt, auth_methods) = {
                let conns = agent_connections.lock().await;
                match conns.get(&req.agent_id) {
                    Some(c) => (Some(c.connection.clone()), c.capabilities.auth_methods.clone()),
                    None => (None, Vec::new()),
                }
            };
            let Some(conn) = conn_opt else {
                send_or_return!(send_response(
                    stdout,
                    &MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
                        message: format!("agent '{}' not found", req.agent_id),
                        session_id: None,
                    })),
                )
                .await);
                return true;
            };
            let method = auth_methods.into_iter().find(|m| m.id == req.method_id);
            if method.as_ref().map(|m| m.method_type.as_str()) == Some("terminal") {
                let method = method.unwrap();
                // Resolve spawn_cmd synchronously (fast in-memory lookup) before offloading,
                // since agents_with_spawn cannot be moved into the task.
                let (spawn_cmd, spawn_args) = if let Some(cmd) = method.terminal_cmd {
                    (cmd, Vec::new())
                } else {
                    let Some((cmd, args, _)) =
                        resolve_agent_spawn_params(&req.agent_id, agents_with_spawn, stdout).await
                    else {
                        return true;
                    };
                    (cmd, args)
                };
                let stdout_task = Arc::clone(stdout);
                // Offload so the dispatch loop stays responsive during the 300s auth window.
                tokio::spawn(async move {
                    let mut child_cmd = tokio::process::Command::new(&spawn_cmd);
                    child_cmd
                        .args(&spawn_args)
                        .args(&method.args)
                        .stdin(std::process::Stdio::null())
                        .stdout(std::process::Stdio::piped())
                        .stderr(std::process::Stdio::piped());
                    if req.force_no_browser {
                        child_cmd.env("NO_BROWSER", "1");
                    }
                    let mut child = match child_cmd.spawn() {
                        Ok(c) => c,
                        Err(e) => {
                            send_response(
                                &stdout_task,
                                &MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
                                    message: format!("failed to spawn auth command: {}", e),
                                    session_id: None,
                                })),
                            )
                            .await
                            .ok();
                            return;
                        }
                    };
                    if let Some(out) = child.stdout.take() {
                        tokio::spawn(async move {
                            use tokio::io::{AsyncBufReadExt, BufReader};
                            let mut lines = BufReader::new(out).lines();
                            while let Ok(Some(line)) = lines.next_line().await {
                                send_diag("info", line);
                            }
                        });
                    }
                    if let Some(err) = child.stderr.take() {
                        tokio::spawn(async move {
                            use tokio::io::{AsyncBufReadExt, BufReader};
                            let mut lines = BufReader::new(err).lines();
                            while let Ok(Some(line)) = lines.next_line().await {
                                send_diag("warn", line);
                            }
                        });
                    }
                    let result = tokio::time::timeout(
                        std::time::Duration::from_secs(300),
                        child.wait(),
                    )
                    .await;
                    let response = match result {
                        Ok(Ok(status)) if status.success() => {
                            MaestroRpcMessage::Response(ServerResponse::AuthenticateOk)
                        }
                        Ok(Ok(status)) => MaestroRpcMessage::Response(ServerResponse::Error(
                            ErrorResponse {
                                message: format!("auth command exited with {:?}", status.code()),
                                session_id: None,
                            },
                        )),
                        Ok(Err(e)) => MaestroRpcMessage::Response(ServerResponse::Error(
                            ErrorResponse {
                                message: format!("auth command error: {}", e),
                                session_id: None,
                            },
                        )),
                        Err(_) => {
                            child.kill().await.ok();
                            MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
                                message: "authentication timed out".to_string(),
                                session_id: None,
                            }))
                        }
                    };
                    send_response(&stdout_task, &response).await.ok();
                });
            } else {
                use agent_client_protocol_schema::v1::{AuthMethodId, AuthenticateRequest};
                let stdout_task = Arc::clone(stdout);
                // Offload so the dispatch loop stays responsive during the 300s auth window.
                tokio::spawn(async move {
                    let result = tokio::time::timeout(
                        std::time::Duration::from_secs(300),
                        conn.send_request(AuthenticateRequest::new(AuthMethodId::new(
                            req.method_id.as_str(),
                        )))
                        .block_task(),
                    )
                    .await;
                    let response = match result {
                        Ok(Ok(_)) => MaestroRpcMessage::Response(ServerResponse::AuthenticateOk),
                        Ok(Err(e)) => {
                            MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
                                message: format!("authenticate failed: {}", e),
                                session_id: None,
                            }))
                        }
                        Err(_) => MaestroRpcMessage::Response(ServerResponse::Error(
                            ErrorResponse {
                                message: "authentication timed out".to_string(),
                                session_id: None,
                            },
                        )),
                    };
                    send_response(&stdout_task, &response).await.ok();
                });
            }
        }

        MaestroRpcMessage::Request(ServerRequest::SpawnAuthTerminal(req)) => {
            let auth_methods = {
                let conns = agent_connections.lock().await;
                conns.get(&req.agent_id).map(|c| c.capabilities.auth_methods.clone()).unwrap_or_default()
            };
            let method = auth_methods.into_iter().find(|m| m.id == req.method_id);
            let Some(method) = method else {
                send_or_return!(send_response(
                    stdout,
                    &MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
                        message: format!("auth method '{}' not found for agent '{}'", req.method_id, req.agent_id),
                        session_id: None,
                    })),
                )
                .await);
                return true;
            };
            let (spawn_cmd, spawn_args) = if let Some(cmd) = method.terminal_cmd {
                (cmd, Vec::new())
            } else {
                let Some((cmd, args, _)) =
                    resolve_agent_spawn_params(&req.agent_id, agents_with_spawn, stdout).await
                else {
                    return true;
                };
                (cmd, args)
            };
            let all_args: Vec<String> = spawn_args.into_iter().chain(method.args.into_iter()).collect();
            let stdout_task = Arc::clone(stdout);
            let auth_terminals_task = Arc::clone(auth_terminals);
            let terminal_id = req.terminal_id.clone();
            let session_id = req.session_id.clone();
            let agent_id = req.agent_id.clone();
            tokio::spawn(async move {
                use std::process::Stdio;
                use tokio::io::AsyncWriteExt;
                let mut child_cmd = tokio::process::Command::new(&spawn_cmd);
                child_cmd
                    .args(&all_args)
                    .stdin(Stdio::piped())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped())
                    .env("NO_BROWSER", "1")
                    .env("TERM", "xterm-256color");
                let mut child = match child_cmd.spawn() {
                    Ok(c) => c,
                    Err(e) => {
                        send_response(
                            &stdout_task,
                            &MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
                                message: format!("failed to spawn auth terminal: {}", e),
                                session_id: None,
                            })),
                        )
                        .await
                        .ok();
                        return;
                    }
                };
                let child_stdin = child.stdin.take();
                let child_stdout = child.stdout.take().expect("stdout piped");
                let child_stderr = child.stderr.take().expect("stderr piped");

                let (kill_tx, kill_rx) = tokio::sync::oneshot::channel::<()>();
                let (input_tx, mut input_rx) = tokio::sync::mpsc::channel::<Vec<u8>>(32);
                auth_terminals_task.lock().await.insert(terminal_id.clone(), AuthTerminalState { kill_tx, input_tx });

                // Forward stdout chunks as TerminalOutput
                let stdout_fwd = Arc::clone(&stdout_task);
                let tid_out = terminal_id.clone();
                let sid_out = session_id.clone();
                tokio::spawn(async move {
                    use tokio::io::AsyncReadExt;
                    let mut reader = child_stdout;
                    let mut buf = [0u8; 4096];
                    loop {
                        match reader.read(&mut buf).await {
                            Ok(0) | Err(_) => break,
                            Ok(n) => {
                                send_response(
                                    &stdout_fwd,
                                    &MaestroRpcMessage::Response(ServerResponse::TerminalOutput(
                                        maestro_protocol::TerminalOutput {
                                            session_id: sid_out.clone(),
                                            terminal_id: tid_out.clone(),
                                            bytes: buf[..n].to_vec(),
                                        },
                                    )),
                                )
                                .await
                                .ok();
                            }
                        }
                    }
                });

                // Forward stderr chunks as TerminalOutput
                let stdout_fwd2 = Arc::clone(&stdout_task);
                let tid_err = terminal_id.clone();
                let sid_err = session_id.clone();
                tokio::spawn(async move {
                    use tokio::io::AsyncReadExt;
                    let mut reader = child_stderr;
                    let mut buf = [0u8; 4096];
                    loop {
                        match reader.read(&mut buf).await {
                            Ok(0) | Err(_) => break,
                            Ok(n) => {
                                send_response(
                                    &stdout_fwd2,
                                    &MaestroRpcMessage::Response(ServerResponse::TerminalOutput(
                                        maestro_protocol::TerminalOutput {
                                            session_id: sid_err.clone(),
                                            terminal_id: tid_err.clone(),
                                            bytes: buf[..n].to_vec(),
                                        },
                                    )),
                                )
                                .await
                                .ok();
                            }
                        }
                    }
                });

                // Relay stdin input to child
                if let Some(mut stdin_pipe) = child_stdin {
                    tokio::spawn(async move {
                        while let Some(data) = input_rx.recv().await {
                            if stdin_pipe.write_all(&data).await.is_err() {
                                break;
                            }
                        }
                    });
                }

                // Wait for child exit or kill signal
                let exit_code = tokio::select! {
                    _ = kill_rx => {
                        child.kill().await.ok();
                        None
                    }
                    status = child.wait() => {
                        status.ok().and_then(|s| s.code())
                    }
                };
                auth_terminals_task.lock().await.remove(&terminal_id);
                send_response(
                    &stdout_task,
                    &MaestroRpcMessage::Response(ServerResponse::AuthTerminalExit(AuthTerminalExitResponse {
                        terminal_id,
                        agent_id,
                        exit_code,
                    })),
                )
                .await
                .ok();
            });
        }

        MaestroRpcMessage::Request(ServerRequest::KillAuthTerminal(req)) => {
            if let Some(state) = auth_terminals.lock().await.remove(&req.terminal_id) {
                let _ = state.kill_tx.send(());
            }
        }

        MaestroRpcMessage::Request(ServerRequest::AuthTerminalInput(req)) => {
            let tx = auth_terminals.lock().await
                .get(&req.terminal_id)
                .map(|s| s.input_tx.clone());
            if let Some(tx) = tx {
                tx.send(req.data).await.ok();
            }
        }

        MaestroRpcMessage::Request(ServerRequest::Logout(req)) => {
            let conn_handle = {
                let conns = agent_connections.lock().await;
                conns.get(&req.agent_id).map(|c| c.connection.clone())
            };
            match conn_handle {
                None => {
                    send_or_return!(send_response(
                        stdout,
                        &MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
                            message: format!("agent '{}' not found", req.agent_id),
                            session_id: None,
                        })),
                    )
                    .await);
                }
                Some(conn) => {
                    use agent_client_protocol_schema::v1::LogoutRequest;
                    let stdout_task = Arc::clone(stdout);
                    // Offload so the dispatch loop stays responsive during logout.
                    tokio::spawn(async move {
                        let response =
                            match conn.send_request(LogoutRequest::new()).block_task().await {
                                Ok(_) => MaestroRpcMessage::Response(ServerResponse::LogoutOk),
                                Err(e) => {
                                    MaestroRpcMessage::Response(ServerResponse::Error(
                                        ErrorResponse {
                                            message: format!("logout failed: {}", e),
                                            session_id: None,
                                        },
                                    ))
                                }
                            };
                        send_response(&stdout_task, &response).await.ok();
                    });
                }
            }
        }

        MaestroRpcMessage::Request(ServerRequest::CheckTools(req)) => {
            let results = check_tools(req.tools).await;
            send_or_return!(send_response(
                stdout,
                &MaestroRpcMessage::Response(ServerResponse::CheckToolsOk(CheckToolsResponse {
                    results,
                })),
            )
            .await);
        }

        MaestroRpcMessage::Request(ServerRequest::DetectInstalledAgents(_req)) => {
            let response = agent::detection::detect_installed_agents().await;

            // Override spawn_cmd with the path found by detection (handles platform quirks
            // where the registry cmd uses a relative archive path like ./opencode.exe).
            // Only applies to binary distributions — npx/uvx agents use binary_path as a
            // detection signal only, not as the spawn command.
            for info in &response.agents {
                if let Some(ref path) = info.binary_path {
                    if let Some(agent) = agents_with_spawn.iter_mut().find(|a| a.id == info.agent_id) {
                        if agent.spawn_deps.is_empty() {
                            agent.spawn_cmd = path.clone();
                        }
                    }
                }
            }

            send_or_return!(send_response(
                stdout,
                &MaestroRpcMessage::Response(ServerResponse::DetectInstalledAgentsOk(response)),
            )
            .await);
        }

        MaestroRpcMessage::Request(ServerRequest::DetectProjectAgents(req)) => {
            let response = agent::detection::detect_project_agents(&req.cwd).await;
            send_or_return!(send_response(
                stdout,
                &MaestroRpcMessage::Response(ServerResponse::DetectProjectAgentsOk(response)),
            )
            .await);
        }

        MaestroRpcMessage::Request(ServerRequest::Pong { seq }) => {
            eprintln!("[heartbeat] pong ack seq={seq}");
        }

        MaestroRpcMessage::Response(_) => {}
    }

    true
}
