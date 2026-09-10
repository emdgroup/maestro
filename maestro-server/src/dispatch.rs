use std::sync::Arc;

use maestro_protocol::{
    CheckToolsResponse, DiscoveredAgent, ErrorResponse, FileReadResponse, FileSearchResponse,
    InstallSkillsResponse, ListAgentsResponse, MaestroRpcMessage, PreInitializeResponse,
    ServerRequest, ServerResponse, SessionUpdate, SpawnResponse, AUTH_REQUIRED_ERROR,
};
use tokio::sync::Mutex;

use crate::agent;
use crate::auth::{self, AuthTerminals};
use crate::file_ops::{handle_file_read, handle_file_search};
use crate::helpers::{
    ensure_and_get_connection, evict_if_same_connection, forward_to_session,
    resolve_agent_spawn_params, send_diag, send_response,
};
use crate::session::{self, create_session_on_connection, pre_initialize_agent};
use crate::sessions::{ActiveSession, SessionCommand, SessionMap, SharedAgentConnections};
use crate::tool_check::check_tools;

fn tool_config_error(tool: String, error: String) -> maestro_protocol::ToolCheckResult {
    maestro_protocol::ToolCheckResult {
        tool,
        available: false,
        version: None,
        configured_path: None,
        resolved_path: None,
        source: maestro_protocol::ToolPathSource::NotFound,
        error: Some(error),
    }
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
    auth_terminals: &AuthTerminals,
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
            agent::registry::apply_custom_agents(agents_with_spawn);
            let agents: Vec<DiscoveredAgent> = agents_with_spawn
                .iter()
                .map(|a| DiscoveredAgent {
                    id: a.id.clone(),
                    name: a.name.clone(),
                    icon: a.icon.clone(),
                    spawn_deps: a.spawn_deps.clone(),
                })
                .collect();
            send_or_return!(
                send_response(
                    stdout,
                    &MaestroRpcMessage::Response(ServerResponse::ListAgentsOk(
                        ListAgentsResponse { agents },
                    )),
                )
                .await
            );
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
                    &req.additional_directories,
                    Arc::clone(&stdout_task),
                )
                .await;
                let mut result = match result {
                    Err(msg) => {
                        // Keep connection alive for auth_required so Authenticate can follow.
                        // Evict on any other failure (broken connection, protocol error, etc.).
                        if msg != AUTH_REQUIRED_ERROR {
                            evict_if_same_connection(
                                &agent_connections_task,
                                &req.agent_id,
                                &conn_handle.router,
                            )
                            .await;
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
                result.session.additional_directories = req.additional_directories;
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
                send_or_return!(
                    send_response(
                        stdout,
                        &MaestroRpcMessage::Response(ServerResponse::SessionUpdate(
                            SessionUpdate {
                                session_id: req.session_id.clone(),
                                payload: serde_json::json!({
                                    "sessionUpdate": "user_message",
                                    "content": req.content,
                                    "sentAt": sent_at,
                                }),
                            }
                        )),
                    )
                    .await
                );
                let cmd = match req.content {
                    serde_json::Value::Array(blocks) => SessionCommand::PromptStructured(blocks),
                    other => SessionCommand::Prompt(other.as_str().unwrap_or("").to_string()),
                };
                if session.cmd_tx.send(cmd).await.is_err() {
                    send_or_return!(
                        send_response(
                            stdout,
                            &MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
                                message: format!("session {} connection closed", req.session_id),
                                session_id: None,
                            })),
                        )
                        .await
                    );
                }
            } else {
                send_or_return!(
                    send_response(
                        stdout,
                        &MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
                            message: format!("unknown session: {}", req.session_id),
                            session_id: None,
                        })),
                    )
                    .await
                );
            }
        }

        MaestroRpcMessage::Request(ServerRequest::Cancel(req)) => {
            if let Some(session) = sessions.remove(&req.session_id) {
                let session_agent_id = session.agent_id.clone();
                if session
                    .cmd_tx
                    .try_send(SessionCommand::CloseSession)
                    .is_ok()
                {
                    // Graceful close: command loop sends CloseSessionRequest to agent.
                    // Watchdog force-aborts after 5s if the loop stalls.
                    let abort_handle = session.task.abort_handle();
                    let cleanup = session.cleanup;
                    let agent_connections_cancel = Arc::clone(agent_connections);
                    tokio::spawn(async move {
                        let timed_out =
                            tokio::time::timeout(std::time::Duration::from_secs(5), session.task)
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
            let response =
                match result {
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
                Ok(content) => {
                    MaestroRpcMessage::Response(ServerResponse::FileReadOk(FileReadResponse {
                        content,
                    }))
                }
                Err(msg) => MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
                    message: msg,
                    session_id: None,
                })),
            };
            send_or_return!(send_response(stdout, &response).await);
        }

        MaestroRpcMessage::Request(ServerRequest::SessionList(req)) => {
            return session::requests::list(req, agent_connections, stdout).await;
        }

        MaestroRpcMessage::Request(ServerRequest::SessionLoad(req)) => {
            return session::requests::load(
                req,
                agent_connections,
                agents_with_spawn,
                spawn_result_tx,
                stdout,
            )
            .await;
        }

        MaestroRpcMessage::Request(ServerRequest::SessionClose(req)) => {
            return session::requests::end(
                session::requests::EndKind::Close,
                req.agent_id,
                req.session_id,
                agent_connections,
                stdout,
            )
            .await;
        }

        MaestroRpcMessage::Request(ServerRequest::SessionDelete(req)) => {
            return session::requests::end(
                session::requests::EndKind::Delete,
                req.agent_id,
                req.session_id,
                agent_connections,
                stdout,
            )
            .await;
        }

        MaestroRpcMessage::Request(ServerRequest::Handshake(_)) => {
            send_or_return!(
                send_response(
                    stdout,
                    &MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
                        message: "unexpected Handshake after initialization".to_string(),
                        session_id: None,
                    })),
                )
                .await
            );
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
                    send_or_return!(
                        send_response(
                            stdout,
                            &MaestroRpcMessage::Response(ServerResponse::PreInitializeOk(response)),
                        )
                        .await
                    );
                }
                None => {
                    // Error already sent by pre_initialize_agent
                }
            }
        }

        MaestroRpcMessage::Request(ServerRequest::Authenticate(req)) => {
            return auth::authenticate(req, agent_connections, agents_with_spawn, stdout).await;
        }

        MaestroRpcMessage::Request(ServerRequest::SpawnAuthTerminal(req)) => {
            return auth::spawn_auth_terminal(
                req,
                agent_connections,
                agents_with_spawn,
                auth_terminals,
                stdout,
            )
            .await;
        }

        MaestroRpcMessage::Request(ServerRequest::KillAuthTerminal(req)) => {
            auth::kill_auth_terminal(req, auth_terminals).await;
        }

        MaestroRpcMessage::Request(ServerRequest::AuthTerminalInput(req)) => {
            auth::auth_terminal_input(req, auth_terminals).await;
        }

        MaestroRpcMessage::Request(ServerRequest::Logout(req)) => {
            return auth::logout(req, agent_connections, stdout).await;
        }

        MaestroRpcMessage::Request(ServerRequest::CheckTools(req)) => {
            let results = check_tools(req.tools).await;
            send_or_return!(
                send_response(
                    stdout,
                    &MaestroRpcMessage::Response(ServerResponse::CheckToolsOk(
                        CheckToolsResponse { results }
                    )),
                )
                .await
            );
        }

        MaestroRpcMessage::Request(ServerRequest::InstallSkills(req)) => {
            let response = match crate::skills::install(req.skills).await {
                Ok(installed) => MaestroRpcMessage::Response(ServerResponse::InstallSkillsOk(
                    InstallSkillsResponse { installed },
                )),
                Err(message) => MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
                    message,
                    session_id: None,
                })),
            };
            send_or_return!(send_response(stdout, &response).await);
        }

        MaestroRpcMessage::Request(ServerRequest::SetToolPath(req)) => {
            let result = if let Some(path) = req.path {
                let tested =
                    crate::tool_check::test_tool_path(req.tool.clone(), path.clone()).await;
                if tested.available {
                    match crate::tool_config::set(&req.tool, Some(path)) {
                        Ok(()) => crate::tool_check::check_tool(req.tool).await,
                        Err(error) => tool_config_error(req.tool, error),
                    }
                } else {
                    tested
                }
            } else {
                match crate::tool_config::set(&req.tool, None) {
                    Ok(()) => crate::tool_check::check_tool(req.tool).await,
                    Err(error) => tool_config_error(req.tool, error),
                }
            };
            send_or_return!(
                send_response(
                    stdout,
                    &MaestroRpcMessage::Response(ServerResponse::SetToolPathOk(result))
                )
                .await
            );
        }

        MaestroRpcMessage::Request(ServerRequest::TestToolPath(req)) => {
            let result = crate::tool_check::test_tool_path(req.tool, req.path).await;
            send_or_return!(
                send_response(
                    stdout,
                    &MaestroRpcMessage::Response(ServerResponse::TestToolPathOk(result))
                )
                .await
            );
        }

        MaestroRpcMessage::Request(ServerRequest::DetectInstalledAgents(_req)) => {
            let mut response = agent::detection::detect_installed_agents().await;

            // The detection table only knows the bundled agents, and the host drops anything it
            // does not report. A custom agent is one the user declared themselves, so take their
            // word for it and let a wrong command fail loudly at spawn rather than vanish here.
            agent::registry::apply_custom_agents(agents_with_spawn);
            for agent in agents_with_spawn.iter().filter(|agent| agent.custom) {
                response.agents.push(maestro_protocol::DetectedAgentInfo {
                    agent_id: agent.id.clone(),
                    tool_name: agent.name.clone(),
                    binary_found: false,
                    binary_path: None,
                    config_dir_found: false,
                });
                response.all_checked_ids.push(agent.id.clone());
            }

            // Override spawn_cmd with the path found by detection (handles platform quirks
            // where the registry cmd uses a relative archive path like ./opencode.exe).
            // Only applies to binary distributions — npx/uvx agents use binary_path as a
            // detection signal only, not as the spawn command.
            for info in &response.agents {
                if let Some(ref path) = info.binary_path {
                    if let Some(agent) =
                        agents_with_spawn.iter_mut().find(|a| a.id == info.agent_id)
                    {
                        if agent.spawn_deps.is_empty() {
                            agent.spawn_cmd = path.clone();
                        }
                    }
                }
            }

            send_or_return!(
                send_response(
                    stdout,
                    &MaestroRpcMessage::Response(ServerResponse::DetectInstalledAgentsOk(response)),
                )
                .await
            );
        }

        MaestroRpcMessage::Request(ServerRequest::DetectProjectAgents(req)) => {
            let response = agent::detection::detect_project_agents(&req.cwd).await;
            send_or_return!(
                send_response(
                    stdout,
                    &MaestroRpcMessage::Response(ServerResponse::DetectProjectAgentsOk(response)),
                )
                .await
            );
        }

        // The host logs both sides of the heartbeat at trace; echoing it here would either be
        // discarded (this process is spawned with a null stderr on one path) or, if forwarded as
        // a diagnostic, put every ping on the IPC channel.
        MaestroRpcMessage::Request(ServerRequest::Pong { seq: _ }) => {}

        MaestroRpcMessage::Response(_) => {}
    }

    true
}
