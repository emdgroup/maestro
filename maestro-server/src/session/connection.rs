use std::collections::HashMap;
use std::sync::Arc;

use agent_client_protocol as acp;
use acp::schema::{
    ClientCapabilities, CloseSessionRequest, CreateTerminalRequest, CreateTerminalResponse,
    Implementation, InitializeRequest, KillTerminalRequest, KillTerminalResponse,
    ListSessionsRequest, LoadSessionRequest, NewSessionRequest, ProtocolVersion,
    ReleaseTerminalRequest, ReleaseTerminalResponse, RequestPermissionRequest,
    RequestPermissionResponse, SessionNotification, TerminalExitStatus,
    TerminalOutputRequest, TerminalOutputResponse, WaitForTerminalExitRequest,
    WaitForTerminalExitResponse,
};
use agent_client_protocol_schema::{ElicitationCapabilities, ElicitationFormCapabilities};
use maestro_protocol::{
    ErrorResponse, MaestroRpcMessage, PromptCapabilitiesInfo, ServerResponse, SessionListEntry,
    SessionModeState as ProtocolSessionModeState,
    SessionModelState as ProtocolSessionModelState,
};
use tokio::sync::{mpsc, oneshot, Mutex};
use tokio_util::compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt};

use crate::agent;
use crate::send_response;
use crate::sessions::{
    ActiveSession, AgentCapabilities, AgentConnection, SessionCommand, SharedSessionState,
};
use super::command_loop::{
    convert_acp_models, convert_acp_modes, extract_prompt_capabilities,
    models_from_config_options, modes_from_config_options, run_command_loop,
};
use super::handlers::{configure_acp_builder, ConnectionHandlers};
use super::spawn::SpawnResult;

pub(crate) async fn run_session_list(
    spawn_cmd: &str,
    spawn_args: &[String],
    spawn_env: &HashMap<String, String>,
    cwd: &str,
    cursor: Option<String>,
) -> Result<(Vec<SessionListEntry>, Option<String>), String> {
    let mut child = agent::spawn_agent_subprocess(spawn_cmd, spawn_args, cwd, spawn_env).await?;
    let child_stdin = child.stdin.take().expect("child stdin must be piped");
    let child_stdout = child.stdout.take().expect("child stdout must be piped");
    let outgoing = child_stdin.compat_write();
    let incoming = child_stdout.compat();
    let transport = acp::ByteStreams::new(outgoing, incoming);

    let (result_tx, result_rx) = oneshot::channel::<Result<(Vec<SessionListEntry>, Option<String>), String>>();
    let cwd_owned = cwd.to_string();

    tokio::spawn(async move {
        let _result = acp::Client
            .builder()
            .name("maestro-server")
            .on_receive_notification(
                {
                    move |_notification: SessionNotification, _cx: acp::ConnectionTo<acp::Agent>| {
                        async move { Ok(()) }
                    }
                },
                acp::on_receive_notification!(),
            )
            .connect_with(transport, async move |cx: acp::ConnectionTo<acp::Agent>| {
                let init_result = cx
                    .send_request(
                        InitializeRequest::new(ProtocolVersion::V1)
                            .client_info(Implementation::new("maestro-server", "0.1.0")),
                    )
                    .block_task()
                    .await;
                if let Err(e) = init_result {
                    let _ = result_tx.send(Err(format!("ACP initialize failed: {}", e)));
                    return Ok(());
                }

                let mut req = ListSessionsRequest::new().cwd(std::path::PathBuf::from(&cwd_owned));
                if let Some(c) = cursor {
                    req = req.cursor(c);
                }
                let list_result = cx
                    .send_request(req)
                    .block_task()
                    .await;
                match list_result {
                    Ok(resp) => {
                        let entries: Vec<SessionListEntry> = resp.sessions.into_iter().map(|s| {
                            SessionListEntry {
                                session_id: s.session_id.to_string(),
                                title: s.title,
                                updated_at: s.updated_at,
                            }
                        }).collect();
                        let _ = result_tx.send(Ok((entries, resp.next_cursor)));
                    }
                    Err(e) => {
                        let _ = result_tx.send(Err(format!("session/list failed: {}", e)));
                    }
                }
                Ok(())
            })
            .await;
        drop(child);
    });

    result_rx.await.map_err(|_| "session/list connection dropped".to_string())?
}

pub(crate) async fn run_session_close(
    spawn_cmd: &str,
    spawn_args: &[String],
    spawn_env: &HashMap<String, String>,
    cwd: &str,
    session_id: String,
) -> Result<(), String> {
    let mut child = agent::spawn_agent_subprocess(spawn_cmd, spawn_args, cwd, spawn_env).await?;
    let child_stdin = child.stdin.take().expect("child stdin must be piped");
    let child_stdout = child.stdout.take().expect("child stdout must be piped");
    let outgoing = child_stdin.compat_write();
    let incoming = child_stdout.compat();
    let transport = acp::ByteStreams::new(outgoing, incoming);

    let (result_tx, result_rx) = oneshot::channel::<Result<(), String>>();

    tokio::spawn(async move {
        let _result = acp::Client
            .builder()
            .name("maestro-server")
            .on_receive_notification(
                {
                    move |_notification: SessionNotification, _cx: acp::ConnectionTo<acp::Agent>| {
                        async move { Ok(()) }
                    }
                },
                acp::on_receive_notification!(),
            )
            .connect_with(transport, async move |cx: acp::ConnectionTo<acp::Agent>| {
                let init_result = cx
                    .send_request(
                        InitializeRequest::new(ProtocolVersion::V1)
                            .client_info(Implementation::new("maestro-server", "0.1.0")),
                    )
                    .block_task()
                    .await;
                if let Err(e) = init_result {
                    let _ = result_tx.send(Err(format!("ACP initialize failed: {}", e)));
                    return Ok(());
                }

                let close_result = cx
                    .send_request(CloseSessionRequest::new(session_id))
                    .block_task()
                    .await;
                match close_result {
                    Ok(_) => { let _ = result_tx.send(Ok(())); }
                    Err(e) => { let _ = result_tx.send(Err(format!("session/close failed: {}", e))); }
                }
                Ok(())
            })
            .await;
        drop(child);
    });

    result_rx.await.map_err(|_| "session/close connection dropped".to_string())?
}

/// List sessions using an already-initialized connection (fast path for `SessionList`).
pub(crate) async fn session_list_on_connection(
    conn: &AgentConnection,
    cwd: &str,
    cursor: Option<String>,
) -> Result<(Vec<SessionListEntry>, Option<String>), String> {
    let cx = conn.connection.clone();
    let mut req = ListSessionsRequest::new().cwd(std::path::PathBuf::from(cwd));
    if let Some(c) = cursor {
        req = req.cursor(c);
    }
    let resp = cx
        .send_request(req)
        .block_task()
        .await
        .map_err(|e| format!("session/list failed: {}", e))?;
    let entries: Vec<SessionListEntry> = resp
        .sessions
        .into_iter()
        .map(|s| SessionListEntry {
            session_id: s.session_id.to_string(),
            title: s.title,
            updated_at: s.updated_at,
        })
        .collect();
    Ok((entries, resp.next_cursor))
}

/// Close a session using an already-initialized connection (fast path for `SessionClose`).
pub(crate) async fn session_close_on_connection(
    conn: &AgentConnection,
    session_id: String,
) -> Result<(), String> {
    let cx = conn.connection.clone();
    cx.send_request(CloseSessionRequest::new(session_id))
        .block_task()
        .await
        .map_err(|e| format!("session/close failed: {}", e))?;
    Ok(())
}

/// Create a new session on an already-initialized `AgentConnection` (fast path).
///
/// Sends `session/new` on the existing connection instead of spawning a fresh agent process.
/// Registers the session route in the agent's router so shared handlers dispatch correctly.
pub(crate) async fn create_session_on_connection(
    conn: &AgentConnection,
    maestro_session_id: String,
    cwd: &str,
    stdout: Arc<Mutex<tokio::io::Stdout>>,
) -> Option<SpawnResult> {
    let cx = conn.connection.clone();
    let session_response = match cx
        .send_request(NewSessionRequest::new(std::path::PathBuf::from(cwd)))
        .block_task()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            let _ = send_response(
                &stdout,
                &MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
                    message: format!("ACP new_session failed: {}", e),
                })),
            )
            .await;
            return None;
        }
    };

    let models = convert_acp_models(session_response.models.as_ref());
    let modes = convert_acp_modes(session_response.modes.as_ref());
    let session_id = session_response.session_id.clone();
    let acp_session_id_str = session_id.to_string();

    let (cmd_tx, cmd_rx) = mpsc::channel::<SessionCommand>(16);
    let pending_permissions: Arc<Mutex<HashMap<String, oneshot::Sender<Option<String>>>>> =
        Arc::new(Mutex::new(HashMap::new()));
    let pending_elicitations: Arc<Mutex<HashMap<String, oneshot::Sender<serde_json::Value>>>> =
        Arc::new(Mutex::new(HashMap::new()));
    let session_state = Arc::new(SharedSessionState {
        pending_permissions: Arc::clone(&pending_permissions),
        pending_elicitations: Arc::clone(&pending_elicitations),
    });

    conn.router
        .register(
            acp_session_id_str.clone(),
            maestro_session_id.clone(),
            session_state,
        )
        .await;

    let so = Arc::clone(&stdout);
    let sid = maestro_session_id.clone();
    let prompt_capabilities = conn
        .capabilities
        .prompt_capabilities
        .clone()
        .unwrap_or(PromptCapabilitiesInfo {
            embedded_context: false,
            image: false,
            audio: false,
        });
    let supports_session_list = conn.capabilities.supports_session_list;
    let supports_session_load = conn.capabilities.supports_session_load;
    let supports_session_close = conn.capabilities.supports_session_close;

    let router = Arc::clone(&conn.router);
    let task = tokio::spawn(run_command_loop(cmd_rx, cx, session_id, so, sid, Some(Arc::clone(&router))));

    Some(SpawnResult {
        session: ActiveSession {
            cmd_tx,
            pending_permissions,
            pending_elicitations,
            task,
            cleanup: Some(crate::sessions::SessionCleanup {
                acp_session_id: acp_session_id_str.clone(),
                router,
            }),
        },
        models,
        modes,
        prompt_capabilities,
        supports_session_list,
        supports_session_load,
        supports_session_close,
        acp_session_id: acp_session_id_str,
    })
}

/// Load an existing session on an already-initialized `AgentConnection` (fast path for SessionLoad).
///
/// Sends `session/load` on the existing connection instead of spawning a fresh agent process.
/// Registers the session route in the agent's router so shared handlers dispatch correctly.
pub(crate) async fn load_session_on_connection(
    conn: &AgentConnection,
    maestro_session_id: String,
    resume_session_id: String,
    cwd: &str,
    stdout: Arc<Mutex<tokio::io::Stdout>>,
) -> Option<(ActiveSession, Option<ProtocolSessionModelState>, Option<ProtocolSessionModeState>, PromptCapabilitiesInfo)> {
    let cx = conn.connection.clone();

    let (cmd_tx, cmd_rx) = mpsc::channel::<SessionCommand>(16);
    let pending_permissions: Arc<Mutex<HashMap<String, oneshot::Sender<Option<String>>>>> =
        Arc::new(Mutex::new(HashMap::new()));
    let pending_elicitations: Arc<Mutex<HashMap<String, oneshot::Sender<serde_json::Value>>>> =
        Arc::new(Mutex::new(HashMap::new()));
    let session_state = Arc::new(SharedSessionState {
        pending_permissions: Arc::clone(&pending_permissions),
        pending_elicitations: Arc::clone(&pending_elicitations),
    });

    // Register the route before sending the request so that history notifications
    // emitted during session/load are routed correctly instead of being dropped.
    conn.router
        .register(resume_session_id.clone(), maestro_session_id.clone(), session_state)
        .await;

    let load_req = LoadSessionRequest::new(
        resume_session_id.clone(),
        std::path::PathBuf::from(cwd),
    );
    let load_response = match cx.send_request(load_req).block_task().await {
        Ok(r) => r,
        Err(e) => {
            conn.router.unregister(&resume_session_id).await;
            let _ = send_response(
                &stdout,
                &MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
                    message: format!("ACP session/load failed: {}", e),
                })),
            )
            .await;
            return None;
        }
    };

    let models = convert_acp_models(load_response.models.as_ref())
        .or_else(|| load_response.config_options.as_deref().and_then(models_from_config_options));
    let modes = load_response.config_options.as_deref()
        .and_then(modes_from_config_options)
        .or_else(|| convert_acp_modes(load_response.modes.as_ref()));
    let session_id = acp::schema::SessionId::new(resume_session_id.clone());

    let prompt_capabilities = conn
        .capabilities
        .prompt_capabilities
        .clone()
        .unwrap_or(PromptCapabilitiesInfo {
            embedded_context: false,
            image: false,
            audio: false,
        });

    let so = Arc::clone(&stdout);
    let sid = maestro_session_id;
    let router = Arc::clone(&conn.router);
    let task = tokio::spawn(run_command_loop(cmd_rx, cx, session_id, so, sid, Some(Arc::clone(&router))));

    Some((
        ActiveSession {
            cmd_tx,
            pending_permissions,
            pending_elicitations,
            task,
            cleanup: Some(crate::sessions::SessionCleanup {
                acp_session_id: resume_session_id,
                router,
            }),
        },
        models,
        modes,
        prompt_capabilities,
    ))
}

/// Spawn an agent process and run `initialize` only — no session created yet.
/// The returned `AgentConnection` holds a live `ConnectionTo<Agent>` that can
/// serve N sessions via `session/new` calls.
pub(crate) async fn pre_initialize_agent(
    spawn_cmd: &str,
    spawn_args: &[String],
    spawn_env: &HashMap<String, String>,
    cwd: &str,
    stdout: Arc<Mutex<tokio::io::Stdout>>,
) -> Option<AgentConnection> {
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

    let child_stdin = child.stdin.take().expect("child stdin must be piped");
    let child_stdout = child.stdout.take().expect("child stdout must be piped");
    let outgoing = child_stdin.compat_write();
    let incoming = child_stdout.compat();
    let transport = acp::ByteStreams::new(outgoing, incoming);

    let (handlers, router) = ConnectionHandlers::new(Arc::clone(&stdout));
    let terms = Arc::clone(&handlers.terminals);

    // Channels: ready signal carries capabilities + cloned connection handle
    type ReadyPayload = Result<(AgentCapabilities, acp::ConnectionTo<acp::Agent>), String>;
    let (ready_tx, ready_rx) = oneshot::channel::<ReadyPayload>();
    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();

    tokio::spawn(async move {
        let _result = configure_acp_builder!(handlers, terms)
            .connect_with(transport, async move |cx: acp::ConnectionTo<acp::Agent>| {
                let init_result = cx
                    .send_request(
                        InitializeRequest::new(ProtocolVersion::V1)
                            .client_info(Implementation::new("maestro-server", "0.1.0"))
                            .client_capabilities(
                                ClientCapabilities::new()
                                    .terminal(true)
                                    .elicitation(
                                        ElicitationCapabilities::new()
                                            .form(ElicitationFormCapabilities::new()),
                                    ),
                            ),
                    )
                    .block_task()
                    .await;
                let init_response = match init_result {
                    Ok(resp) => resp,
                    Err(e) => {
                        let _ = ready_tx.send(Err(format!("ACP initialize failed: {}", e)));
                        return Ok(());
                    }
                };
                let caps = AgentCapabilities {
                    prompt_capabilities: Some(extract_prompt_capabilities(&init_response)),
                    supports_session_list: init_response.agent_capabilities.session_capabilities.list.is_some(),
                    supports_session_load: init_response.agent_capabilities.load_session,
                    supports_session_close: init_response.agent_capabilities.session_capabilities.list.is_some(),
                };
                // Send the live connection handle out — caller uses it to create sessions.
                let _ = ready_tx.send(Ok((caps, cx)));
                // Hold the connection open until shutdown is requested or the child exits.
                let _ = shutdown_rx.await;
                Ok(())
            })
            .await;

        drop(child);
    });

    match ready_rx.await {
        Ok(Ok((capabilities, connection))) => Some(AgentConnection::new(
            connection,
            router,
            capabilities,
            shutdown_tx,
        )),
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
                    message: "ACP pre-initialize connection task exited unexpectedly".to_string(),
                })),
            )
            .await;
            None
        }
    }
}
