use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use acp::schema::v1::{
    ClientCapabilities, CloseSessionRequest, CreateTerminalRequest, CreateTerminalResponse,
    DeleteSessionRequest, EnvVariable, Implementation, InitializeRequest, KillTerminalRequest,
    KillTerminalResponse, ListSessionsRequest, LoadSessionRequest, McpServer, McpServerStdio,
    NewSessionRequest, ReleaseTerminalRequest, ReleaseTerminalResponse, RequestPermissionRequest,
    RequestPermissionResponse, SessionNotification, TerminalExitStatus, TerminalOutputRequest,
    TerminalOutputResponse, WaitForTerminalExitRequest, WaitForTerminalExitResponse,
};
use acp::schema::ProtocolVersion;
use agent_client_protocol as acp;
use agent_client_protocol_schema::v1::{
    AuthCapabilities, AuthMethod, ElicitationCapabilities, ElicitationFormCapabilities,
};
use maestro_protocol::{
    AuthMethodInfo, ErrorResponse, MaestroRpcMessage, PromptCapabilitiesInfo, ServerResponse,
    SessionListEntry, SessionModeState as ProtocolSessionModeState,
    SessionModelState as ProtocolSessionModelState, AUTH_REQUIRED_ERROR, SESSION_LOAD_FAILED_ERROR,
};
use tokio::sync::{mpsc, oneshot, Mutex};
use tokio_util::compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt};

use super::command_loop::{
    convert_acp_modes, extract_prompt_capabilities, models_from_config_options,
    modes_from_config_options, run_command_loop, serialize_config_options,
};
use super::handlers::{configure_acp_builder, ConnectionHandlers};
use crate::agent;
use crate::mcp_config::McpTransportSupport;
use crate::send_response;
use crate::sessions::{
    ActiveSession, AgentCapabilities, AgentConnection, AgentConnectionHandle, SessionCommand,
    SharedSessionState,
};

pub(crate) struct SpawnResult {
    pub(crate) session: ActiveSession,
    pub(crate) models: Option<ProtocolSessionModelState>,
    pub(crate) modes: Option<ProtocolSessionModeState>,
    pub(crate) prompt_capabilities: PromptCapabilitiesInfo,
    pub(crate) supports_session_list: bool,
    pub(crate) supports_session_load: bool,
    pub(crate) supports_session_close: bool,
    pub(crate) supports_session_delete: bool,
    pub(crate) acp_session_id: String,
    pub(crate) config_options: Option<Vec<serde_json::Value>>,
}

/// Load `.mcp.json` for `cwd` and report what was dropped and why.
///
/// Shared by `session/new` and `session/load` so a resumed session sees the same servers as a
/// fresh one — an agent that reconnects its MCP servers on load would otherwise lose them.
async fn mcp_servers_for(
    cwd: &str,
    support: McpTransportSupport,
    maestro_session_id: &str,
) -> Vec<McpServer> {
    let loaded = crate::mcp_config::load_mcp_servers(cwd, support).await;
    for reason in &loaded.skipped {
        crate::send_diag("warn", format!("[mcp] skipped {reason}"));
    }
    if !loaded.servers.is_empty() {
        crate::send_diag(
            "info",
            format!(
                "[mcp] forwarding {} server(s) from {}",
                loaded.servers.len(),
                crate::mcp_config::MCP_CONFIG_FILE
            ),
        );
    }
    let mut servers = loaded.servers;
    if let Some(server) = maestro_mcp_server(maestro_session_id) {
        servers.push(server);
    }
    servers
}

/// Maestro's own MCP server, as a stdio entry pointing back at this binary.
///
/// Stdio rather than http: it is the ACP v1 baseline every agent must support, so this needs no
/// capability gate and no listening HTTP server. Port, token and session travel as environment
/// variables on the entry itself, so the shim guesses nothing and inherits nothing.
///
/// Absent when the gateway failed to bind — the session still works, without canvas and task
/// tools, which beats refusing to start it.
fn maestro_mcp_server(maestro_session_id: &str) -> Option<McpServer> {
    let Some((port, token)) = crate::mcp_gateway::gateway_address() else {
        crate::send_diag(
            "warn",
            "[mcp] no gateway, so this session gets no canvas or task tools",
        );
        return None;
    };
    let executable = match std::env::current_exe() {
        Ok(path) => path,
        Err(e) => {
            crate::send_diag("warn", format!("[mcp] cannot locate maestro-server: {e}"));
            return None;
        }
    };
    crate::send_diag(
        "info",
        format!(
            "[mcp] forwarding {} (stdio)",
            maestro_protocol::MCP_SERVER_NAME
        ),
    );
    Some(McpServer::Stdio(
        McpServerStdio::new(maestro_protocol::MCP_SERVER_NAME, executable)
            .args(vec!["mcp".to_string()])
            .env(vec![
                EnvVariable::new(maestro_protocol::MCP_GATEWAY_PORT_ENV, port.to_string()),
                EnvVariable::new(maestro_protocol::MCP_GATEWAY_TOKEN_ENV, token.clone()),
                EnvVariable::new(
                    maestro_protocol::MCP_GATEWAY_SESSION_ENV,
                    maestro_session_id.to_string(),
                ),
            ]),
    ))
}

/// Resolve the project's extra workspace roots and report what was dropped and why.
async fn additional_directories_for(raw: &[String], supported: bool) -> Vec<std::path::PathBuf> {
    let home = crate::workspace_roots::home_dir();
    let (dirs, skipped) =
        crate::workspace_roots::resolve_additional_directories(raw, supported, home.as_deref());
    for reason in &skipped {
        crate::send_diag("warn", format!("[roots] skipped {reason}"));
    }
    if !dirs.is_empty() {
        crate::send_diag(
            "info",
            format!("[roots] {} additional workspace root(s)", dirs.len()),
        );
    }
    dirs
}

/// Cap on `next_cursor` follow-ups, so a misbehaving agent cannot loop forever.
const SESSION_LIST_MAX_PAGES: usize = 20;

/// Compares strings rather than the filesystem: the paths of deleted worktrees must still match.
fn path_is_within(root: &str, candidate: &std::path::Path) -> bool {
    fn normalize(s: &str) -> String {
        let s = s.replace('\\', "/");
        let trimmed = s.trim_end_matches('/');
        let trimmed = if trimmed.is_empty() { &s } else { trimmed };
        if cfg!(windows) {
            trimmed.to_lowercase()
        } else {
            trimmed.to_string()
        }
    }
    let root = normalize(root);
    let candidate = normalize(&candidate.to_string_lossy());
    if !candidate.starts_with(&root) {
        return false;
    }
    // `…/maestro` must not swallow `…/maestro-server`.
    matches!(candidate[root.len()..].chars().next(), None | Some('/'))
}

/// List sessions using an already-initialized connection (fast path for `SessionList`).
///
/// `cwd` is filtered here, not forwarded: the agent resolves it against a live `git worktree
/// list`, which hides every session whose worktree Maestro has since deleted.
pub(crate) async fn session_list_on_connection(
    conn: &AgentConnectionHandle,
    cwd: &str,
    cursor: Option<String>,
) -> Result<(Vec<SessionListEntry>, Option<String>), String> {
    let cx = conn.connection.clone();
    let mut entries: Vec<SessionListEntry> = Vec::new();
    let mut cursor = cursor;
    for _ in 0..SESSION_LIST_MAX_PAGES {
        let mut req = ListSessionsRequest::new();
        if let Some(c) = cursor {
            req = req.cursor(c);
        }
        let resp = cx
            .send_request(req)
            .block_task()
            .await
            .map_err(|e| format!("session/list failed: {}", e))?;
        entries.extend(
            resp.sessions
                .into_iter()
                .filter(|s| path_is_within(cwd, &s.cwd))
                .map(|s| SessionListEntry {
                    session_id: s.session_id.to_string(),
                    title: s.title,
                    updated_at: s.updated_at,
                }),
        );
        cursor = resp.next_cursor;
        if cursor.is_none() {
            break;
        }
    }

    // An agent that only lists when given a `cwd` keeps working as it did before.
    if entries.is_empty() {
        let resp = cx
            .send_request(ListSessionsRequest::new().cwd(std::path::PathBuf::from(cwd)))
            .block_task()
            .await
            .map_err(|e| format!("session/list failed: {}", e))?;
        entries = resp
            .sessions
            .into_iter()
            .map(|s| SessionListEntry {
                session_id: s.session_id.to_string(),
                title: s.title,
                updated_at: s.updated_at,
            })
            .collect();
    }

    // Entries now come from several project directories and nothing downstream orders them.
    entries.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok((entries, None))
}

/// Close a session using an already-initialized connection (fast path for `SessionClose`).
pub(crate) async fn session_close_on_connection(
    conn: &AgentConnectionHandle,
    session_id: String,
) -> Result<(), String> {
    let cx = conn.connection.clone();
    cx.send_request(CloseSessionRequest::new(session_id))
        .block_task()
        .await
        .map_err(|e| format!("session/close failed: {}", e))?;
    Ok(())
}

/// Delete a session from history using an already-initialized connection (fast path for `SessionDelete`).
pub(crate) async fn session_delete_on_connection(
    conn: &AgentConnectionHandle,
    session_id: String,
) -> Result<(), String> {
    let cx = conn.connection.clone();
    cx.send_request(DeleteSessionRequest::new(session_id))
        .block_task()
        .await
        .map_err(|e| format!("session/delete failed: {}", e))?;
    Ok(())
}

/// Create a new session on an already-initialized agent connection (fast path).
///
/// Sends `session/new` on the existing connection instead of spawning a fresh agent process.
/// Registers the session route in the agent's router so shared handlers dispatch correctly.
/// Returns `Ok(SpawnResult)` on success.
/// Returns `Err(message)` on failure; the error response has already been sent to stdout.
/// The caller must NOT evict the agent connection when the message is `AUTH_REQUIRED_ERROR`.
pub(crate) async fn create_session_on_connection(
    conn: &AgentConnectionHandle,
    maestro_session_id: String,
    cwd: &str,
    additional_directories: &[String],
    stdout: crate::ClientOut,
) -> Result<SpawnResult, String> {
    let cx = conn.connection.clone();
    crate::send_diag(
        "info",
        format!("[session] session/new maestro_id={maestro_session_id}"),
    );
    let mcp_servers =
        mcp_servers_for(cwd, conn.capabilities.mcp_transports, &maestro_session_id).await;
    let roots = additional_directories_for(
        additional_directories,
        conn.capabilities.supports_additional_directories,
    )
    .await;
    let session_response = match cx
        .send_request(
            NewSessionRequest::new(std::path::PathBuf::from(cwd))
                .mcp_servers(mcp_servers)
                .additional_directories(roots),
        )
        .block_task()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            let message = if e.code == acp::schema::v1::ErrorCode::AuthRequired {
                AUTH_REQUIRED_ERROR.to_string()
            } else {
                format!("ACP new_session failed: {}", e)
            };
            let _ = send_response(
                &stdout,
                &MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
                    message: message.clone(),
                    session_id: None,
                })),
            )
            .await;
            return Err(message);
        }
    };

    let models = session_response
        .config_options
        .as_deref()
        .and_then(models_from_config_options);
    let modes = session_response
        .config_options
        .as_deref()
        .and_then(modes_from_config_options)
        .or_else(|| convert_acp_modes(session_response.modes.as_ref()));
    let config_options = session_response
        .config_options
        .as_deref()
        .map(serialize_config_options);
    let session_id = session_response.session_id.clone();
    let acp_session_id_str = session_id.to_string();

    let (cmd_tx, cmd_rx) = mpsc::channel::<SessionCommand>(16);
    let pending_permissions: crate::sessions::PendingPermissions =
        Arc::new(Mutex::new(HashMap::new()));
    let pending_elicitations: crate::sessions::PendingElicitations =
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
    let prompt_capabilities =
        conn.capabilities
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
    let supports_session_delete = conn.capabilities.supports_session_delete;

    let router = Arc::clone(&conn.router);
    let turn_active = Arc::new(AtomicBool::new(false));
    let task = tokio::spawn(run_command_loop(
        cmd_rx,
        cx,
        session_id,
        so,
        sid,
        Some(Arc::clone(&router)),
        Arc::clone(&turn_active),
    ));

    Ok(SpawnResult {
        session: ActiveSession {
            cmd_tx,
            pending_permissions,
            pending_elicitations,
            task,
            cleanup: Some(crate::sessions::SessionCleanup {
                acp_session_id: acp_session_id_str.clone(),
                router,
            }),
            agent_id: String::new(),
            cwd: String::new(),
            additional_directories: Vec::new(),
            host_meta: None,
            turn_active,
            idle_marked: false,
        },
        models,
        modes,
        prompt_capabilities,
        supports_session_list,
        supports_session_load,
        supports_session_close,
        supports_session_delete,
        acp_session_id: acp_session_id_str,
        config_options,
    })
}

/// Load an existing session on an already-initialized `AgentConnection` (fast path for SessionLoad).
///
/// Sends `session/load` on the existing connection instead of spawning a fresh agent process.
/// Registers the session route in the agent's router so shared handlers dispatch correctly.
/// Ok(Some) = success; Ok(None) = ACP-level error (connection still alive, error already sent);
/// Err(()) = transport failure (connection dead, error already sent).
pub(crate) async fn load_session_on_connection(
    conn: &AgentConnectionHandle,
    maestro_session_id: String,
    resume_session_id: String,
    cwd: &str,
    additional_directories: &[String],
    stdout: crate::ClientOut,
) -> Result<
    Option<(
        ActiveSession,
        Option<ProtocolSessionModelState>,
        Option<ProtocolSessionModeState>,
        PromptCapabilitiesInfo,
        Option<Vec<serde_json::Value>>,
    )>,
    (),
> {
    let cx = conn.connection.clone();

    let (cmd_tx, cmd_rx) = mpsc::channel::<SessionCommand>(16);
    let pending_permissions: crate::sessions::PendingPermissions =
        Arc::new(Mutex::new(HashMap::new()));
    let pending_elicitations: crate::sessions::PendingElicitations =
        Arc::new(Mutex::new(HashMap::new()));
    let session_state = Arc::new(SharedSessionState {
        pending_permissions: Arc::clone(&pending_permissions),
        pending_elicitations: Arc::clone(&pending_elicitations),
    });

    // Register the route before sending the request so that history notifications
    // emitted during session/load are routed correctly instead of being dropped.
    conn.router
        .register(
            resume_session_id.clone(),
            maestro_session_id.clone(),
            session_state,
        )
        .await;

    let load_req =
        LoadSessionRequest::new(resume_session_id.clone(), std::path::PathBuf::from(cwd))
            .mcp_servers(
                mcp_servers_for(cwd, conn.capabilities.mcp_transports, &maestro_session_id).await,
            )
            .additional_directories(
                additional_directories_for(
                    additional_directories,
                    conn.capabilities.supports_additional_directories,
                )
                .await,
            );
    let load_response = match cx.send_request(load_req).block_task().await {
        Ok(r) => r,
        Err(e) => {
            conn.router.unregister(&resume_session_id).await;
            let _ = send_response(
                &stdout,
                &MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
                    message: format!("{}: {}", SESSION_LOAD_FAILED_ERROR, e),
                    session_id: Some(maestro_session_id.clone()),
                })),
            )
            .await;
            // Named ACP error codes mean the agent responded — connection is still alive.
            // Transport failures (channel closed, I/O error) appear as InternalError or Other.
            let connection_alive = matches!(
                e.code,
                acp::schema::v1::ErrorCode::ResourceNotFound
                    | acp::schema::v1::ErrorCode::MethodNotFound
                    | acp::schema::v1::ErrorCode::InvalidParams
                    | acp::schema::v1::ErrorCode::AuthRequired
                    | acp::schema::v1::ErrorCode::ParseError
                    | acp::schema::v1::ErrorCode::InvalidRequest
            );
            return if connection_alive { Ok(None) } else { Err(()) };
        }
    };
    crate::send_diag(
        "info",
        format!(
            "[session] session/load maestro_id={maestro_session_id} resume={resume_session_id}"
        ),
    );

    let models = load_response
        .config_options
        .as_deref()
        .and_then(models_from_config_options);
    let modes = load_response
        .config_options
        .as_deref()
        .and_then(modes_from_config_options)
        .or_else(|| convert_acp_modes(load_response.modes.as_ref()));
    let config_options = load_response
        .config_options
        .as_deref()
        .map(serialize_config_options);
    let session_id = acp::schema::v1::SessionId::new(resume_session_id.clone());

    let prompt_capabilities =
        conn.capabilities
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
    let turn_active = Arc::new(AtomicBool::new(false));
    let task = tokio::spawn(run_command_loop(
        cmd_rx,
        cx,
        session_id,
        so,
        sid,
        Some(Arc::clone(&router)),
        Arc::clone(&turn_active),
    ));

    Ok(Some((
        ActiveSession {
            cmd_tx,
            pending_permissions,
            pending_elicitations,
            task,
            cleanup: Some(crate::sessions::SessionCleanup {
                acp_session_id: resume_session_id,
                router,
            }),
            agent_id: String::new(),
            cwd: String::new(),
            additional_directories: Vec::new(),
            host_meta: None,
            turn_active,
            idle_marked: false,
        },
        models,
        modes,
        prompt_capabilities,
        config_options,
    )))
}

/// Spawn an agent process and run `initialize` only — no session created yet.
/// The returned `AgentConnection` holds a live `ConnectionTo<Agent>` that can
/// serve N sessions via `session/new` calls.
pub(crate) async fn pre_initialize_agent(
    spawn_cmd: &str,
    spawn_args: &[String],
    spawn_env: &HashMap<String, String>,
    cwd: &str,
    stdout: crate::ClientOut,
) -> Option<AgentConnection> {
    let mut child = match agent::spawn_agent_subprocess(spawn_cmd, spawn_args, cwd, spawn_env).await
    {
        Ok(c) => c,
        Err(e) => {
            let _ = send_response(
                &stdout,
                &MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
                    message: e,
                    session_id: None,
                })),
            )
            .await;
            return None;
        }
    };

    let child_stdin = child.stdin.take().expect("child stdin must be piped");
    let child_stdout = child.stdout.take().expect("child stdout must be piped");
    // Drain agent stderr so the subprocess never blocks on a full pipe buffer,
    // and forward each line as a diagnostic for cross-platform debugging.
    if let Some(stderr_pipe) = child.stderr.take() {
        tokio::spawn(async move {
            use tokio::io::{AsyncBufReadExt, BufReader};
            let mut lines = BufReader::new(stderr_pipe).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                crate::send_diag("warn", format!("[agent stderr] {line}"));
            }
        });
    }
    let outgoing = child_stdin.compat_write();
    let incoming = child_stdout.compat();
    let transport = acp::ByteStreams::new(outgoing, incoming);

    let (handlers, router) = ConnectionHandlers::new(Arc::clone(&stdout));
    let terms = Arc::clone(&handlers.terminals);

    // Channels: ready signal carries capabilities + cloned connection handle
    type ReadyPayload = Result<(AgentCapabilities, acp::ConnectionTo<acp::Agent>), String>;
    let (ready_tx, ready_rx) = oneshot::channel::<ReadyPayload>();
    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();

    let connection_task = tokio::spawn(async move {
        let result = configure_acp_builder!(handlers, terms)
            .connect_with(transport, async move |cx: acp::ConnectionTo<acp::Agent>| {
                let init_result = cx
                    .send_request(
                        InitializeRequest::new(ProtocolVersion::V1)
                            .client_info(Implementation::new("maestro-server", "0.1.0"))
                            .client_capabilities(
                                ClientCapabilities::new()
                                    .terminal(true)
                                    .auth(AuthCapabilities::new().terminal(true))
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
                // An agent that cannot speak the version we asked for answers with the latest it
                // supports. Continuing would send v1 requests to, say, a v2-only agent and fail
                // later with unrelated parse errors, so stop here and say why.
                if init_response.protocol_version != ProtocolVersion::V1 {
                    let _ = ready_tx.send(Err(format!(
                        "This agent speaks ACP protocol version {}, but Maestro only supports \
                         version {}. Update Maestro, or use an agent version that supports ACP v{}.",
                        init_response.protocol_version,
                        ProtocolVersion::V1,
                        ProtocolVersion::V1,
                    )));
                    return Ok(());
                }
                let auth_methods: Vec<AuthMethodInfo> = init_response.auth_methods
                    .iter()
                    .filter_map(|m| match m {
                        AuthMethod::Agent(a) => Some(AuthMethodInfo {
                            id: a.id.0.to_string(),
                            name: a.name.clone(),
                            description: a.description.clone(),
                            method_type: "agent".to_string(),
                            args: Vec::new(),
                            terminal_cmd: None,
                        }),
                        AuthMethod::Terminal(t) => {
                            let terminal_cmd = t.meta.as_ref()
                                .and_then(|meta| meta.get("terminal-auth"))
                                .and_then(|ta| ta.get("command"))
                                .and_then(|v| v.as_str())
                                .map(String::from);
                            Some(AuthMethodInfo {
                                id: t.id.0.to_string(),
                                name: t.name.clone(),
                                description: t.description.clone(),
                                method_type: "terminal".to_string(),
                                args: t.args.clone(),
                                terminal_cmd,
                            })
                        },
                        _ => None,
                    })
                    .collect();
                let supports_auth_logout = init_response.agent_capabilities.auth.logout.is_some();
                let caps = AgentCapabilities {
                    prompt_capabilities: Some(extract_prompt_capabilities(&init_response)),
                    supports_session_list: init_response.agent_capabilities.session_capabilities.list.is_some(),
                    supports_session_load: init_response.agent_capabilities.load_session,
                    supports_session_close: init_response.agent_capabilities.session_capabilities.close.is_some(),
                    supports_session_delete: init_response.agent_capabilities.session_capabilities.delete.is_some(),
                    auth_methods,
                    supports_auth_logout,
                    mcp_transports: McpTransportSupport {
                        http: init_response.agent_capabilities.mcp_capabilities.http,
                        sse: init_response.agent_capabilities.mcp_capabilities.sse,
                    },
                    supports_additional_directories: init_response
                        .agent_capabilities
                        .session_capabilities
                        .additional_directories
                        .is_some(),
                };
                crate::send_diag("info", format!(
                    "[agent] initialize ok session_list={} session_load={} session_close={} session_delete={} auth_methods={} auth_logout={} mcp_http={} mcp_sse={}",
                    caps.supports_session_list, caps.supports_session_load, caps.supports_session_close, caps.supports_session_delete,
                    caps.auth_methods.len(), caps.supports_auth_logout,
                    caps.mcp_transports.http, caps.mcp_transports.sse
                ));
                // Send the live connection handle out — caller uses it to create sessions.
                let _ = ready_tx.send(Ok((caps, cx)));
                // Hold the connection open until shutdown is requested or the child exits.
                let _ = shutdown_rx.await;
                Ok(())
            })
            .await;
        let exit_status = child.try_wait().ok().flatten();
        let exit_msg = exit_status
            .map(|s| format!(" exit={s}"))
            .unwrap_or_default();
        if let Err(ref e) = result {
            if acp::is_incoming_transport_closed(e) {
                crate::send_diag(
                    "info",
                    format!("[agent] ACP connection closed (EOF){exit_msg}"),
                );
            } else {
                crate::send_diag(
                    "error",
                    format!("[agent] ACP connection closed with error{exit_msg}: {e}"),
                );
            }
        } else {
            crate::send_diag("info", format!("[agent] ACP connection closed{exit_msg}"));
        }
        drop(child);
    });

    match ready_rx.await {
        Ok(Ok((capabilities, connection))) => Some(AgentConnection::new(
            connection,
            router,
            capabilities,
            shutdown_tx,
            connection_task,
        )),
        Ok(Err(e)) => {
            let _ = send_response(
                &stdout,
                &MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
                    message: e,
                    session_id: None,
                })),
            )
            .await;
            None
        }
        Err(_) => {
            let _ = send_response(
                &stdout,
                &MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
                    message: "ACP pre-initialize connection task exited unexpectedly".to_string(),
                    session_id: None,
                })),
            )
            .await;
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::path_is_within;
    use std::path::Path;

    const ROOT: &str = r"C:\Users\me\maestro";

    #[test]
    fn root_itself_matches() {
        assert!(path_is_within(ROOT, Path::new(r"C:\Users\me\maestro")));
        assert!(path_is_within(ROOT, Path::new(r"C:\Users\me\maestro\")));
    }

    #[test]
    fn worktree_child_matches() {
        assert!(path_is_within(
            ROOT,
            Path::new(r"C:\Users\me\maestro\.maestro\worktrees\session-100")
        ));
    }

    #[test]
    fn sibling_with_shared_prefix_is_rejected() {
        assert!(!path_is_within(
            ROOT,
            Path::new(r"C:\Users\me\maestro-server")
        ));
        assert!(!path_is_within(ROOT, Path::new(r"C:\Users\me\other")));
    }

    #[test]
    fn mixed_separators_match() {
        assert!(path_is_within(
            "C:/Users/me/maestro",
            Path::new(r"C:\Users\me\maestro\src")
        ));
    }

    #[test]
    #[cfg(windows)]
    fn case_differing_drive_letter_matches() {
        assert!(path_is_within(
            ROOT,
            Path::new(r"c:\users\me\Maestro\src-tauri")
        ));
    }
}
