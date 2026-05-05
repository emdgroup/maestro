//! Maestro Remote Server
//!
//! Headless binary that runs on remote SSH hosts. Receives MaestroRpcMessage
//! commands from the local Maestro desktop app over stdin/stdout (piped through
//! SSH exec channel), spawns ACP agents as local subprocesses, and forwards
//! structured session updates back.
//!
//! Architecture: Adapted from Zed's remote_server (GPL-3.0).

mod agent;
mod file_ops;
mod registry;
mod session_handler;
mod sessions;
mod terminal;

#[cfg(test)]
mod tests;

use std::collections::HashMap;
use std::sync::Arc;

use maestro_protocol::{
    read_message, AcpRegistry, DiscoveredAgent, ErrorResponse, FileReadResponse, FileSearchResponse,
    HandshakeResponse, ListAgentsResponse, MaestroRpcMessage, PROTOCOL_VERSION, ServerRequest,
    ServerResponse, SessionListOkResponse, SessionLoadOkResponse, SessionUpdate, SpawnResponse,
};
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;

use file_ops::{handle_file_read, handle_file_search};
use session_handler::{
    ensure_agent_cache, load_acp_session, run_session_close, run_session_list, spawn_acp_session,
};
use sessions::{SessionCommand, SessionMap};

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

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let stdout: Arc<Mutex<tokio::io::Stdout>> = Arc::new(Mutex::new(tokio::io::stdout()));
    let mut stdin = tokio::io::stdin();
    let mut sessions: SessionMap = HashMap::new();
    let mut agent_cache: Option<(std::time::Instant, Vec<registry::DiscoveredAgentWithSpawn>)> =
        None;
    const CACHE_TTL: std::time::Duration = std::time::Duration::from_secs(300);

    let registry: AcpRegistry = tokio::task::spawn_blocking(registry::load_registry)
        .await
        .unwrap_or_else(|_| registry::parse_backup_registry());

    // Validate the protocol version handshake before entering the main dispatch loop.
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
                let agents_with_spawn =
                    ensure_agent_cache(&mut agent_cache, CACHE_TTL, &registry).await;
                let agents: Vec<DiscoveredAgent> = agents_with_spawn
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
                let agents_with_spawn =
                    ensure_agent_cache(&mut agent_cache, CACHE_TTL, &registry).await;
                let (spawn_cmd, spawn_args_owned, spawn_env) = match agents_with_spawn
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
                    Some(result) => {
                        let response = SpawnResponse {
                            session_id: req.session_id.clone(),
                            acp_session_id: Some(result.acp_session_id),
                            models: result.models,
                            prompt_capabilities: Some(result.prompt_capabilities),
                            supports_session_list: result.supports_session_list,
                            supports_session_load: result.supports_session_load,
                            supports_session_close: result.supports_session_close,
                        };
                        sessions.insert(req.session_id, result.session);
                        let _ = send_response(
                            &stdout,
                            &MaestroRpcMessage::Response(ServerResponse::SpawnOk(response)),
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
                    let sent_at = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis() as u64;
                    let _ = send_response(
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
                    .await;
                    let cmd = match req.content {
                        serde_json::Value::Array(blocks) => {
                            SessionCommand::PromptStructured(blocks)
                        }
                        other => {
                            SessionCommand::Prompt(other.as_str().unwrap_or("").to_string())
                        }
                    };
                    if session.cmd_tx.send(cmd).await.is_err() {
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
                        let _ = send_response(
                            &stdout,
                            &MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
                                message: format!(
                                    "session {} connection closed",
                                    set_model_req.session_id
                                ),
                            })),
                        )
                        .await;
                    }
                } else {
                    let _ = send_response(
                        &stdout,
                        &MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
                            message: format!("unknown session: {}", set_model_req.session_id),
                        })),
                    )
                    .await;
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
                let _ = send_response(&stdout, &response).await;
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
                let _ = send_response(&stdout, &response).await;
            }

            MaestroRpcMessage::Request(ServerRequest::SessionList(req)) => {
                let agents_with_spawn =
                    ensure_agent_cache(&mut agent_cache, CACHE_TTL, &registry).await;
                let (spawn_cmd, spawn_args_owned, spawn_env) = match agents_with_spawn
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
                match run_session_list(&spawn_cmd, &spawn_args_owned, &spawn_env, &req.cwd, req.cursor).await {
                    Ok((sessions_list, next_cursor)) => {
                        let _ = send_response(
                            &stdout,
                            &MaestroRpcMessage::Response(ServerResponse::SessionListOk(
                                SessionListOkResponse { sessions: sessions_list, next_cursor },
                            )),
                        )
                        .await;
                    }
                    Err(e) => {
                        let _ = send_response(
                            &stdout,
                            &MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
                                message: e,
                            })),
                        )
                        .await;
                    }
                }
            }

            MaestroRpcMessage::Request(ServerRequest::SessionLoad(req)) => {
                let agents_with_spawn =
                    ensure_agent_cache(&mut agent_cache, CACHE_TTL, &registry).await;
                let (spawn_cmd, spawn_args_owned, spawn_env) = match agents_with_spawn
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
                match load_acp_session(
                    &spawn_cmd,
                    &spawn_args_owned,
                    &spawn_env,
                    &req.cwd,
                    req.resume_session_id.clone(),
                    req.session_id.clone(),
                    Arc::clone(&stdout),
                )
                .await
                {
                    Some((session, models, prompt_caps)) => {
                        sessions.insert(req.session_id.clone(), session);
                        let _ = send_response(
                            &stdout,
                            &MaestroRpcMessage::Response(ServerResponse::SessionLoadOk(
                                SessionLoadOkResponse {
                                    session_id: req.session_id.clone(),
                                    models,
                                    prompt_capabilities: Some(prompt_caps),
                                },
                            )),
                        )
                        .await;
                    }
                    None => {
                        // Error already sent by load_acp_session
                    }
                }
            }

            MaestroRpcMessage::Request(ServerRequest::SessionClose(req)) => {
                let agents_with_spawn =
                    ensure_agent_cache(&mut agent_cache, CACHE_TTL, &registry).await;
                let (spawn_cmd, spawn_args_owned, spawn_env) = match agents_with_spawn
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
                match run_session_close(&spawn_cmd, &spawn_args_owned, &spawn_env, &req.cwd, req.session_id).await {
                    Ok(()) => {
                        let _ = send_response(
                            &stdout,
                            &MaestroRpcMessage::Response(ServerResponse::SessionCloseOk),
                        )
                        .await;
                    }
                    Err(e) => {
                        let _ = send_response(
                            &stdout,
                            &MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
                                message: e,
                            })),
                        )
                        .await;
                    }
                }
            }

            MaestroRpcMessage::Request(ServerRequest::Handshake(_)) => {
                let _ = send_response(
                    &stdout,
                    &MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
                        message: "unexpected Handshake after initialization".to_string(),
                    })),
                )
                .await;
            }

            MaestroRpcMessage::Response(_) => {}
        }
    }

    Ok(())
}
