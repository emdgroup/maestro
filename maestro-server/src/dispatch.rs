use std::sync::Arc;

use maestro_protocol::{
    CheckToolsResponse, DiscoveredAgent, ErrorResponse, FileReadResponse, FileSearchResponse,
    InstallSkillsResponse, ListAgentsResponse, PreInitializeResponse, ServerRequest,
    ServerResponse, SpawnResponse, AUTH_REQUIRED_ERROR,
};

use crate::agent;
use crate::auth::{self, AuthTerminals};
use crate::file_ops::{handle_file_read, handle_file_search};
use crate::helpers::{
    ensure_and_get_connection, error_response, evict_if_same_connection, forward_to_session, reply,
    resolve_agent_spawn_params, send_diag, send_response,
};
use crate::session::{self, create_session_on_connection};
use crate::sessions::{ActiveSession, SessionCommand, SessionMap, SharedAgentConnections};
use crate::tool_check::check_tools;

fn server_status(
    live_sessions: usize,
    running_runs: u32,
    autostart: Option<maestro_protocol::AutostartMethod>,
) -> maestro_protocol::ServerStatus {
    maestro_protocol::ServerStatus {
        version: env!("CARGO_PKG_VERSION").to_string(),
        pid: std::process::id(),
        started_at: crate::STARTED_AT.get().cloned().unwrap_or_default(),
        live_sessions: live_sessions as u32,
        running_runs,
        autostart_supported: crate::autostart::supported(),
        autostart,
    }
}

/// The requests a session sent a client and is still waiting on.
pub(crate) async fn pending_requests(
    session: &ActiveSession,
) -> Vec<maestro_protocol::PendingSessionRequest> {
    let mut pending: Vec<maestro_protocol::PendingSessionRequest> = session
        .pending_permissions
        .lock()
        .await
        .values()
        .map(|(request, _tx)| maestro_protocol::PendingSessionRequest::Permission(request.clone()))
        .collect();
    pending.extend(
        session
            .pending_elicitations
            .lock()
            .await
            .values()
            .map(|(request, _tx)| {
                maestro_protocol::PendingSessionRequest::Elicitation(request.clone())
            }),
    );
    pending
}

/// A project's sessions as the session map knows them, for a daemon whose store could not be
/// opened. Nothing dormant is known without the store, but what is running is, and a window that
/// adopts nothing leaves those sessions to run unwatched.
pub(crate) fn running_project_sessions(
    sessions: &SessionMap,
    project_path: &str,
) -> Vec<(maestro_protocol::ProjectSession, Option<String>)> {
    sessions
        .iter()
        .filter_map(|(session_id, session)| {
            let project = session.project.as_ref()?;
            let cleanup = session.cleanup.as_ref()?;
            let row = maestro_protocol::ProjectSession {
                agent_id: session.agent_id.clone(),
                acp_session_id: cleanup.acp_session_id.clone(),
                cwd: session.cwd.clone(),
                meta: project.meta.clone(),
                can_reload: project.can_reload,
                closed: false,
                live: None,
            };
            (crate::project_path::canonical_project_path(&project.project_path) == project_path)
                .then(|| (row, Some(session_id.clone())))
        })
        .collect()
}

/// Whether a session is running under this conversation's key. An entry whose command loop has
/// ended is running nothing and only waits for the host to cancel it.
pub(crate) fn runs_under_key(sessions: &SessionMap, agent_id: &str, acp_session_id: &str) -> bool {
    sessions.values().any(|session| {
        !session.task.is_finished()
            && session.agent_id == agent_id
            && session
                .cleanup
                .as_ref()
                .is_some_and(|cleanup| cleanup.acp_session_id == acp_session_id)
    })
}

/// Close a session already taken out of the map: through its command loop, so the agent keeps a
/// transcript `session/load` can replay, and by aborting it when the loop cannot take the command.
/// Returns the graceful close still running, for a caller that has to know when it is over.
pub(crate) async fn close_session(
    session_id: &str,
    session: ActiveSession,
    agent_connections: &SharedAgentConnections,
    automation_store: Option<&crate::automation_runner::Store>,
    stdout: &crate::ClientOut,
) -> Option<tokio::task::JoinHandle<()>> {
    let session_agent_id = session.agent_id.clone();
    // A run's workspace is settled once its session is closed, whoever closed it. The sweep only
    // closes sessions nobody is attached to, so with a window open this is the only close there is.
    let settle = automation_store.map(|store| {
        let store = Arc::clone(store);
        let stdout = Arc::clone(stdout);
        let session_id = session_id.to_string();
        async move {
            crate::automation_runner::settle_worktree_for_session(&store, &stdout, &session_id)
                .await;
        }
    });
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
        Some(tokio::spawn(async move {
            let timed_out = tokio::time::timeout(std::time::Duration::from_secs(5), session.task)
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
            // After the close has run, never alongside it: the agent holds files open under the
            // workspace until then.
            if let Some(settle) = settle {
                settle.await;
            }
        }))
    } else {
        // Channel full or closed: force abort and clean up manually.
        session.task.abort();
        if let Some(c) = session.cleanup {
            c.router.unregister(&c.acp_session_id).await;
            if c.router.is_empty().await {
                agent_connections.lock().await.remove(&session_agent_id);
            }
        }
        if let Some(settle) = settle {
            tokio::spawn(settle);
        }
        None
    }
}

/// How the project lets go of a session: its row closed, whether or not the session is still in
/// the map, and the session closed when it is. `Cancel`, and a task's newer session superseding it.
pub(crate) async fn cancel_session(
    session_id: &str,
    sessions: &mut SessionMap,
    pending_host_tools: &mut crate::mcp_gateway::PendingHostTools,
    agent_connections: &SharedAgentConnections,
    project_store: Option<&crate::project_store::Store>,
    automation_store: Option<&crate::automation_runner::Store>,
    stdout: &crate::ClientOut,
) -> Option<tokio::task::JoinHandle<()>> {
    crate::mcp_gateway::cancel_session(pending_host_tools, session_id);
    let session = sessions.remove(session_id);
    if let Some(store) = project_store {
        let key = session.as_ref().and_then(|session| {
            session
                .cleanup
                .as_ref()
                .map(|cleanup| (session.agent_id.as_str(), cleanup.acp_session_id.as_str()))
        });
        crate::project_store::report(crate::project_store::close(
            &*store.lock().await,
            session_id,
            key,
            chrono::Utc::now(),
        ));
    }
    match session {
        Some(session) => {
            close_session(
                session_id,
                session,
                agent_connections,
                automation_store,
                stdout,
            )
            .await
        }
        None => None,
    }
}

/// The loop's share of a request answered off it: what the slow part found, and the sink the
/// answer goes out on. Only what touches state the loop owns comes back here.
pub(crate) enum Settle {
    Detected(
        maestro_protocol::DetectInstalledAgentsResponse,
        crate::ClientOut,
    ),
    Ended {
        kind: session::requests::EndKind,
        agent_id: String,
        session_id: String,
        stdout: crate::ClientOut,
    },
    /// A task's session up and prompted, to go into the map.
    TaskStarted(Box<crate::task_runner::Started>),
    /// A read-only stage delivered its plan through a permission request: close its session, and
    /// start the stage that follows, if the task asks for one.
    ArtifactTaken {
        session_id: String,
        next: Option<(String, i32, maestro_protocol::AgentRole)>,
        stdout: crate::ClientOut,
    },
    /// A loop iteration's turn ended: close its session, and say so once it is closed, since the
    /// sealed checks may only reach the disk after.
    LoopSessionClose {
        session_id: String,
        stdout: crate::ClientOut,
        closed: tokio::sync::oneshot::Sender<()>,
    },
}

pub(crate) type SettleTx = tokio::sync::mpsc::UnboundedSender<Settle>;

/// The loop's settle channel, for code that runs inside an agent connection and is handed none.
pub(crate) static SETTLE_TX: std::sync::OnceLock<SettleTx> = std::sync::OnceLock::new();

/// Finish a request whose slow part ran off the loop, and answer it.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn settle(
    settle: Settle,
    sessions: &mut SessionMap,
    agents_with_spawn: &mut Vec<agent::registry::DiscoveredAgentWithSpawn>,
    agent_connections: &SharedAgentConnections,
    project_store: Option<&crate::project_store::Store>,
    automation_store: Option<&crate::automation_runner::Store>,
    pending_host_tools: &mut crate::mcp_gateway::PendingHostTools,
) {
    let (stdout, response) = match settle {
        Settle::TaskStarted(started) => {
            crate::task_runner::adopt(
                *started,
                sessions,
                agent_connections,
                project_store,
                automation_store,
                pending_host_tools,
            )
            .await;
            return;
        }
        Settle::LoopSessionClose {
            session_id,
            stdout,
            closed,
        } => {
            let everyone = crate::client_sink::ClientSink::everyone(&stdout).await;
            let closing = cancel_session(
                &session_id,
                sessions,
                pending_host_tools,
                agent_connections,
                project_store,
                automation_store,
                &everyone,
            )
            .await;
            tokio::spawn(async move {
                if let Some(closing) = closing {
                    let _ = closing.await;
                }
                let _ = closed.send(());
            });
            return;
        }
        Settle::ArtifactTaken {
            session_id,
            next,
            stdout,
        } => {
            let everyone = crate::client_sink::ClientSink::everyone(&stdout).await;
            cancel_session(
                &session_id,
                sessions,
                pending_host_tools,
                agent_connections,
                project_store,
                automation_store,
                &everyone,
            )
            .await;
            if let (Some((project_path, task_id, role)), Some(store), Some(settle_tx)) =
                (next, project_store, SETTLE_TX.get())
            {
                let driver = crate::task_turn::Driver {
                    store: Arc::clone(store),
                    agent_connections: Arc::clone(agent_connections),
                    settle_tx: settle_tx.clone(),
                    stdout,
                    agents: agents_with_spawn.clone(),
                };
                tokio::spawn(async move {
                    Box::pin(crate::task_turn::start_next(
                        driver,
                        &everyone,
                        project_path,
                        task_id,
                        role,
                    ))
                    .await;
                });
            }
            return;
        }
        Settle::Detected(mut response, stdout) => {
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
            (stdout, ServerResponse::DetectInstalledAgentsOk(response))
        }
        Settle::Ended {
            kind,
            agent_id,
            session_id,
            stdout,
        } => {
            let response = session::requests::forget_ended(
                kind,
                &agent_id,
                &session_id,
                sessions,
                project_store,
            )
            .await;
            (stdout, response)
        }
    };
    reply(&stdout, &response).await;
}

/// Answer `response` from a task of its own. For work that is slow and touches nothing the loop
/// owns: a process to spawn or probe, a filesystem to walk, an agent to wait on.
fn answer_off_loop(
    stdout: &crate::ClientOut,
    response: impl std::future::Future<Output = ServerResponse> + Send + 'static,
) {
    let stdout = Arc::clone(stdout);
    tokio::spawn(async move {
        let response = response.await;
        reply(&stdout, &response).await;
    });
}

/// Handle one message from stdin.
///
/// Returns `false` only for `Shutdown`, which ends the main loop. Nothing a reply does can: one
/// that cannot be encoded is answered with an `Error` instead, and a write never fails.
// Each argument is a distinct piece of the main loop's mutable state, borrowed separately
// because the loop's other arms hold some of them at the same time.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn dispatch_message(
    msg: ServerRequest,
    sessions: &mut SessionMap,
    agent_connections: &SharedAgentConnections,
    agents_with_spawn: &mut Vec<agent::registry::DiscoveredAgentWithSpawn>,
    stdout: &crate::ClientOut,
    spawn_result_tx: &tokio::sync::mpsc::Sender<(String, ActiveSession)>,
    settle_tx: &SettleTx,
    auth_terminals: &AuthTerminals,
    pending_host_tools: &mut crate::mcp_gateway::PendingHostTools,
    automation_store: Option<&crate::automation_runner::Store>,
    project_store: Option<&crate::project_store::Store>,
) -> bool {
    match msg {
        ServerRequest::ListAgents(_req) => {
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
            reply(
                stdout,
                &ServerResponse::ListAgentsOk(ListAgentsResponse { agents }),
            )
            .await;
        }

        ServerRequest::ListProjectSessions(req) => {
            let project_path = crate::project_path::canonical_project_path(&req.project_path);
            let listed = match project_store {
                Some(store) => {
                    let conn = store.lock().await;
                    crate::project_store::list(&conn, &project_path, req.include_closed)
                }
                None => Ok(running_project_sessions(sessions, &project_path)),
            };
            let rows = match listed {
                Ok(rows) => rows,
                Err(e) => {
                    reply(stdout, &error_response(e)).await;
                    return true;
                }
            };
            let mut listed = Vec::with_capacity(rows.len());
            for (mut row, session_id) in rows {
                // The map decides, not the row: a routing id the row still holds for a session
                // that is gone must not be offered for adoption.
                if let Some((session_id, session)) =
                    session_id.and_then(|id| sessions.get(&id).map(|session| (id, session)))
                {
                    row.live = Some(maestro_protocol::LiveSessionState {
                        session_id,
                        turn_active: session
                            .turn_active
                            .load(std::sync::atomic::Ordering::SeqCst),
                        pending_requests: pending_requests(session).await,
                    });
                }
                listed.push(row);
            }
            reply(
                stdout,
                &ServerResponse::ListProjectSessionsOk(
                    maestro_protocol::ListProjectSessionsResponse { sessions: listed },
                ),
            )
            .await;
        }

        ServerRequest::Shutdown => {
            send_diag("info", "[server] shutdown requested by the host");
            return false;
        }

        request @ (ServerRequest::ListAutomations(_)
        | ServerRequest::SaveAutomation(_)
        | ServerRequest::DeleteAutomation(_)
        | ServerRequest::RunAutomation(_)
        | ServerRequest::ListAutomationRuns(_)
        | ServerRequest::DeleteAutomationRun(_)
        | ServerRequest::SetRunRetention(_)
        | ServerRequest::GetWebhookSettings
        | ServerRequest::SetWebhookSettings(_)
        | ServerRequest::RollWebhookSecret(_)
        | ServerRequest::ListWebhookDeliveries(_)) => match automation_store {
            Some(store) => {
                let spawner = crate::automation_runner::Spawner {
                    agents_with_spawn,
                    agent_connections,
                    stdout,
                    spawn_result_tx,
                };
                Box::pin(crate::automation_runner::answer(
                    store, request, sessions, spawner,
                ))
                .await
            }
            None => {
                let e = crate::automations::UNAVAILABLE.to_string();
                reply(stdout, &error_response(e)).await
            }
        },

        ServerRequest::GetServerStatus => {
            let running_runs = match automation_store {
                Some(store) => crate::automations::count_running(&*store.lock().await),
                None => 0,
            };
            let status = server_status(sessions.len(), running_runs, crate::autostart::current());
            reply(stdout, &ServerResponse::ServerStatusOk(status)).await;
        }

        ServerRequest::SetAutostart(req) => {
            let live_sessions = sessions.len();
            let running_runs = match automation_store {
                Some(store) => crate::automations::count_running(&*store.lock().await),
                None => 0,
            };
            // systemctl, loginctl and crontab are child processes; none of them belongs on the
            // loop every session's traffic goes through.
            let stdout = Arc::clone(stdout);
            tokio::spawn(async move {
                let set = tokio::task::spawn_blocking(move || crate::autostart::set(req.enabled))
                    .await
                    .unwrap_or_else(|e| Err(format!("autostart task failed: {e}")));
                let response = match set {
                    Ok(method) => ServerResponse::ServerStatusOk(server_status(
                        live_sessions,
                        running_runs,
                        method,
                    )),
                    Err(e) => error_response(e),
                };
                reply(&stdout, &response).await;
            });
        }

        // No store means nothing was recorded, which is an empty answer rather than an error.
        ServerRequest::SessionUsage(req) => {
            let turns = match project_store {
                Some(store) => crate::usage_store::session_turns(
                    &*store.lock().await,
                    &req.agent_id,
                    &req.acp_session_id,
                ),
                None => Ok(Vec::new()),
            };
            let response = match turns {
                Ok(turns) => {
                    ServerResponse::SessionUsageOk(maestro_protocol::SessionUsageResponse { turns })
                }
                Err(e) => error_response(e),
            };
            reply(stdout, &response).await;
        }

        ServerRequest::UsageTurns(req) => {
            let page = match project_store {
                Some(store) => {
                    crate::usage_store::turns_after(&*store.lock().await, req.after_turn_id)
                }
                None => Err("This server has no project store".to_string()),
            };
            let response = match page {
                Ok(page) => ServerResponse::UsageTurnsOk(page),
                Err(e) => error_response(e),
            };
            reply(stdout, &response).await;
        }

        ServerRequest::UsageHours(req) => {
            let page = match project_store {
                Some(store) => {
                    crate::usage_store::hours_after(&*store.lock().await, &req.after_hour)
                }
                None => Err("This server has no project store".to_string()),
            };
            let response = match page {
                Ok(page) => ServerResponse::UsageHoursOk(page),
                Err(e) => error_response(e),
            };
            reply(stdout, &response).await;
        }

        // No store and no project: an expression being typed belongs to nothing yet. This is here
        // rather than in the editor because the daemon is the only thing that parses cron, and it
        // must stay that way while it is also the thing that decides when a run happens.
        ServerRequest::PreviewSchedule(req) => {
            match crate::automations::validate_schedule(&req.cron, &req.timezone) {
                Ok(()) => {
                    let next =
                        crate::automations::next_due(&req.cron, &req.timezone, chrono::Utc::now())
                            .map(|due| due.to_rfc3339());
                    reply(
                        stdout,
                        &ServerResponse::PreviewScheduleOk(
                            maestro_protocol::PreviewScheduleResponse { next },
                        ),
                    )
                    .await;
                }
                Err(e) => reply(stdout, &error_response(e)).await,
            }
        }

        ServerRequest::Spawn(req) => {
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
            let requested_at = chrono::Utc::now();
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
                    &req.agent_id,
                    &req.cwd,
                    &req.additional_directories,
                    None,
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
                result.session.project =
                    req.project_path
                        .map(|project_path| crate::sessions::ProjectBinding {
                            project_path,
                            meta: req.meta,
                            can_reload: result.supports_session_load,
                            requested_at,
                        });
                if send_response(&stdout_task, &ServerResponse::SpawnOk(response))
                    .await
                    .is_ok()
                {
                    let _ = spawn_result_tx.send((req.session_id, result.session)).await;
                }
            });
        }

        ServerRequest::Prompt(req) => {
            if let Some(session) = sessions.get(&req.session_id) {
                // The command loop shows the prompt in the transcript, as it does every prompt.
                let cmd = match req.content {
                    serde_json::Value::Array(blocks) => SessionCommand::PromptStructured(blocks),
                    other => SessionCommand::Prompt(other.as_str().unwrap_or("").to_string()),
                };
                // A user answering a blocked task's agent is what unblocks it.
                if let (Some(store), Some(task)) =
                    (project_store, crate::task_turn::task_of(session))
                {
                    crate::task_turn::window_acted(store, stdout, task, false);
                }
                if session.cmd_tx.send(cmd).await.is_err() {
                    reply(
                        stdout,
                        &error_response(format!("session {} connection closed", req.session_id)),
                    )
                    .await;
                }
            } else {
                reply(
                    stdout,
                    &error_response(format!("unknown session: {}", req.session_id)),
                )
                .await;
            }
        }

        // Boxed and out of line: this function's frame is already most of the main thread's stack.
        request @ (ServerRequest::RerunLoopChecks(_)
        | ServerRequest::ReadLoopNotes(_)
        | ServerRequest::AnswerLoopProposal(_)
        | ServerRequest::OpenAgentGate(_)
        | ServerRequest::PauseLoop(_)
        | ServerRequest::StopLoop(_)
        | ServerRequest::RestartTask(_)) => {
            let (response, pushes) =
                Box::pin(crate::loop_engine::answer(request, project_store, stdout)).await;
            reply(stdout, &response).await;
            for push in pushes {
                crate::helpers::broadcast(stdout, push).await;
            }
        }

        ServerRequest::HostToolResult(result) => {
            if let Some((_, tx)) = pending_host_tools.remove(&result.request_id) {
                let _ = tx.send(result);
            }
        }

        ServerRequest::Cancel(req) => {
            // A window closing a task's session ends the stage it was running. Only here: a newer
            // session superseding it goes through `cancel_session` alone.
            if let (Some(store), Some(task)) = (
                project_store,
                sessions
                    .get(&req.session_id)
                    .and_then(crate::task_turn::task_of),
            ) {
                crate::task_turn::window_acted(store, stdout, task, true);
            }
            cancel_session(
                &req.session_id,
                sessions,
                pending_host_tools,
                agent_connections,
                project_store,
                automation_store,
                stdout,
            )
            .await;
        }

        ServerRequest::InterruptTurn(req) => {
            if let Some(session) = sessions.get(&req.session_id) {
                let _ = session.cmd_tx.send(SessionCommand::CancelTurn).await;
            }
        }

        ServerRequest::PermitResponse(perm_resp) => {
            if let Some(session) = sessions.get(&perm_resp.session_id) {
                if let Some((_request, tx)) = session
                    .pending_permissions
                    .lock()
                    .await
                    .remove(&perm_resp.request_id)
                {
                    let _ = tx.send(perm_resp.option_id);
                }
            }
        }

        ServerRequest::ElicitationResponse(elicit_resp) => {
            if let Some(session) = sessions.get(&elicit_resp.session_id) {
                if let Some((_request, tx)) = session
                    .pending_elicitations
                    .lock()
                    .await
                    .remove(&elicit_resp.request_id)
                {
                    let _ = tx.send(elicit_resp.response);
                }
            }
        }

        ServerRequest::SetModel(set_model_req) => {
            forward_to_session(
                sessions,
                &set_model_req.session_id,
                SessionCommand::SetModel(set_model_req.model_id),
                stdout,
            )
            .await;
        }

        ServerRequest::SetMode(set_mode_req) => {
            forward_to_session(
                sessions,
                &set_mode_req.session_id,
                SessionCommand::SetMode(set_mode_req.mode_id),
                stdout,
            )
            .await;
        }

        ServerRequest::SetConfigOption(req) => {
            forward_to_session(
                sessions,
                &req.session_id,
                SessionCommand::SetConfigOption {
                    config_id: req.config_id,
                    value: req.value,
                },
                stdout,
            )
            .await;
        }

        ServerRequest::FileSearch(req) => {
            answer_off_loop(stdout, async move {
                let result = tokio::task::spawn_blocking(move || handle_file_search(req))
                    .await
                    .unwrap_or_else(|e| Err(format!("spawn_blocking: {}", e)));
                match result {
                    Ok(files) => ServerResponse::FileSearchOk(FileSearchResponse { files }),
                    Err(msg) => ServerResponse::Error(ErrorResponse {
                        message: msg,
                        session_id: None,
                    }),
                }
            });
        }

        ServerRequest::FileRead(req) => {
            answer_off_loop(stdout, async move {
                match handle_file_read(&req).await {
                    Ok(content) => ServerResponse::FileReadOk(FileReadResponse { content }),
                    Err(msg) => ServerResponse::Error(ErrorResponse {
                        message: msg,
                        session_id: None,
                    }),
                }
            });
        }

        ServerRequest::SessionList(req) => {
            return session::requests::list(req, agent_connections, agents_with_spawn, stdout)
                .await;
        }

        ServerRequest::SessionLoad(req) => {
            // An unknown agent makes the load final, so a custom agent added or first read since
            // the last listing must be in the list before that is decided.
            if !agents_with_spawn
                .iter()
                .any(|agent| agent.id == req.agent_id)
            {
                agent::registry::apply_custom_agents(agents_with_spawn);
            }
            return session::requests::load(
                req,
                agent_connections,
                agents_with_spawn,
                spawn_result_tx,
                stdout,
            )
            .await;
        }

        ServerRequest::SessionClose(req) => {
            return session::requests::end(
                session::requests::EndKind::Close,
                req.agent_id,
                req.session_id,
                agent_connections,
                settle_tx,
                stdout,
            )
            .await;
        }

        ServerRequest::SessionDelete(req) => {
            return session::requests::end(
                session::requests::EndKind::Delete,
                req.agent_id,
                req.session_id,
                agent_connections,
                settle_tx,
                stdout,
            )
            .await;
        }

        ServerRequest::Handshake(_) => {
            reply(
                stdout,
                &error_response("unexpected Handshake after initialization".to_string()),
            )
            .await;
        }

        ServerRequest::PreInitialize(req) => {
            let Some((spawn_cmd, spawn_args_owned, spawn_env)) =
                resolve_agent_spawn_params(&req.agent_id, agents_with_spawn, stdout).await
            else {
                return true;
            };
            // Reuse whatever is already connected for this agent rather than spawning a second
            // process and inserting it: the entry holds the shutdown sender, so replacing it killed
            // the agent the live sessions were talking to. A client attaching to a daemon probes
            // capabilities, which is exactly when there are sessions to lose.
            // Offloaded like a spawn: starting the agent process takes seconds.
            let agent_connections = Arc::clone(agent_connections);
            let stdout = Arc::clone(stdout);
            tokio::spawn(async move {
                // `None`: the error was already sent by pre_initialize_agent.
                let Some(handle) = ensure_and_get_connection(
                    &req.agent_id,
                    &agent_connections,
                    &spawn_cmd,
                    &spawn_args_owned,
                    &spawn_env,
                    &req.cwd,
                    &stdout,
                )
                .await
                else {
                    return;
                };
                let response = PreInitializeResponse {
                    agent_id: req.agent_id.clone(),
                    prompt_capabilities: handle.capabilities.prompt_capabilities.clone(),
                    supports_session_list: handle.capabilities.supports_session_list,
                    supports_session_load: handle.capabilities.supports_session_load,
                    supports_session_close: handle.capabilities.supports_session_close,
                    supports_session_delete: handle.capabilities.supports_session_delete,
                    auth_methods: handle.capabilities.auth_methods.clone(),
                    supports_auth_logout: handle.capabilities.supports_auth_logout,
                };
                reply(&stdout, &ServerResponse::PreInitializeOk(response)).await;
            });
        }

        ServerRequest::Authenticate(req) => {
            return auth::authenticate(req, agent_connections, agents_with_spawn, stdout).await;
        }

        ServerRequest::SpawnAuthTerminal(req) => {
            return auth::spawn_auth_terminal(
                req,
                agent_connections,
                agents_with_spawn,
                auth_terminals,
                stdout,
            )
            .await;
        }

        ServerRequest::KillAuthTerminal(req) => {
            auth::kill_auth_terminal(req, auth_terminals).await;
        }

        ServerRequest::AuthTerminalInput(req) => {
            auth::auth_terminal_input(req, auth_terminals).await;
        }

        ServerRequest::Logout(req) => {
            return auth::logout(req, agent_connections, stdout).await;
        }

        // Probing a tool runs it, and installing skills runs the skills CLI.
        ServerRequest::CheckTools(req) => {
            answer_off_loop(stdout, async move {
                let results = check_tools(req.tools).await;
                ServerResponse::CheckToolsOk(CheckToolsResponse { results })
            });
        }

        ServerRequest::InstallSkills(req) => {
            answer_off_loop(stdout, async move {
                match crate::skills::install(req.skills).await {
                    Ok(installed) => {
                        ServerResponse::InstallSkillsOk(InstallSkillsResponse { installed })
                    }
                    Err(message) => ServerResponse::Error(ErrorResponse {
                        message,
                        session_id: None,
                    }),
                }
            });
        }

        ServerRequest::ListMcpServers(req) => {
            let response = match crate::mcp_store::list() {
                Ok(servers) => ServerResponse::ListMcpServersOk(maestro_protocol::McpServerList {
                    servers,
                    project: req
                        .project_path
                        .as_deref()
                        .map(crate::mcp_config::project_servers)
                        .unwrap_or_default(),
                }),
                Err(e) => error_response(e),
            };
            reply(stdout, &response).await;
        }

        ServerRequest::SaveMcpServers(req) => {
            let response = match crate::mcp_store::save(req.servers) {
                Ok(()) => ServerResponse::SaveMcpServersOk,
                Err(e) => error_response(e),
            };
            reply(stdout, &response).await;
        }

        ServerRequest::SetMcpSecrets(req) => {
            crate::mcp_store::set_secrets(req.secrets);
            reply(stdout, &ServerResponse::SetMcpSecretsOk).await;
        }

        ServerRequest::ListSkills(req) => {
            let response = match crate::skills::list(req.project_path.as_deref()) {
                Ok(list) => ServerResponse::ListSkillsOk(list),
                Err(e) => error_response(e),
            };
            reply(stdout, &response).await;
        }

        // Offloaded, like a spawn: starting a server or running the skills CLI takes seconds, and
        // the loop has permission answers and heartbeats to keep serving meanwhile.
        ServerRequest::TestMcpServer(req) => {
            let stdout = Arc::clone(stdout);
            tokio::spawn(async move {
                let result = crate::mcp_store::test(req.server).await;
                reply(&stdout, &ServerResponse::TestMcpServerOk(result)).await;
            });
        }

        ServerRequest::ApplySkill(req) => {
            let stdout = Arc::clone(stdout);
            tokio::spawn(async move {
                let response = match crate::skills::apply(req).await {
                    Ok(()) => ServerResponse::ApplySkillOk,
                    Err(e) => error_response(e),
                };
                reply(&stdout, &response).await;
            });
        }

        ServerRequest::DeleteSkill(req) => {
            let stdout = Arc::clone(stdout);
            tokio::spawn(async move {
                let response = match crate::skills::delete(&req.name).await {
                    Ok(()) => ServerResponse::DeleteSkillOk,
                    Err(e) => error_response(e),
                };
                reply(&stdout, &response).await;
            });
        }

        // The probe scans PATH for every bundled agent, which is slow on Windows. What it finds
        // is applied to the agent list back on the loop, which owns it.
        ServerRequest::DetectInstalledAgents(_req) => {
            let settle_tx = settle_tx.clone();
            let stdout = Arc::clone(stdout);
            tokio::spawn(async move {
                let response = agent::detection::detect_installed_agents().await;
                let _ = settle_tx.send(Settle::Detected(response, stdout));
            });
        }

        ServerRequest::AcquireProjectLock(req) => {
            let path = crate::project_path::canonical_project_path(&req.project_path);
            let resp = stdout.lock().await.acquire_project(path, req.label).await;
            reply(stdout, &ServerResponse::AcquireProjectLockOk(resp)).await;
        }

        ServerRequest::ReleaseProjectLock => {
            stdout.lock().await.release_project().await;
        }

        ServerRequest::HomeSummary(req) => {
            let read = Box::pin(async {
                let mut summaries = crate::home::Summaries::default();
                summaries.requested(&req.project_paths);
                if let Some(store) = project_store {
                    summaries.project_store(&*store.lock().await)?;
                }
                let running_runs = match automation_store {
                    Some(store) => {
                        let conn = store.lock().await;
                        summaries.automations(&conn)?;
                        crate::automations::count_running(&conn)
                    }
                    None => 0,
                };
                summaries.sessions(sessions).await;
                let locks = stdout
                    .lock()
                    .await
                    .list_projects(summaries.lock_query())
                    .await;
                summaries.locks(locks);
                Ok::<_, String>((summaries.into_vec(), running_runs))
            })
            .await;
            let live_sessions = sessions.len();
            let stdout = Arc::clone(stdout);
            // `autostart::current` runs systemctl and crontab, which do not belong on the loop.
            tokio::spawn(async move {
                let response = match read {
                    Ok((projects, running_runs)) => {
                        let autostart = tokio::task::spawn_blocking(crate::autostart::current)
                            .await
                            .unwrap_or(None);
                        ServerResponse::HomeSummaryOk(maestro_protocol::HomeSummaryResponse {
                            status: server_status(live_sessions, running_runs, autostart),
                            projects,
                        })
                    }
                    Err(e) => error_response(e),
                };
                reply(&stdout, &response).await;
            });
        }

        // Answered through the sink, not here: the answer may be ten seconds away.
        ServerRequest::RequestTakeover(req) => {
            let path = crate::project_path::canonical_project_path(&req.project_path);
            stdout.lock().await.start_takeover(path, req.label).await;
        }

        ServerRequest::TakeoverAnswer(answer) => {
            stdout
                .lock()
                .await
                .answer_takeover(answer.request_id, answer.accept)
                .await;
        }

        // The host logs both sides of the heartbeat at trace; echoing it here would either be
        // discarded (this process is spawned with a null stderr on one path) or, if forwarded as
        // a diagnostic, put every ping on the IPC channel.
        ServerRequest::Pong { seq: _ } => {}

        request @ (ServerRequest::HoldTask(_) | ServerRequest::ReleaseTaskHold(_)) => {
            crate::scheduler::hold_changed(&request);
            let response = match crate::pipeline_settings::answer_hold(request) {
                Ok(response) => response,
                Err(e) => error_response(e),
            };
            reply(stdout, &response).await;
        }

        // Fast SQLite, so answered on the loop. The reply goes first, then the pushes to
        // everybody, the requester included: its own refetch rides on them too.
        request @ (ServerRequest::RenameSession(_)
        | ServerRequest::CloseProjectSession(_)
        | ServerRequest::ListTasks(_)
        | ServerRequest::GetTask(_)
        | ServerRequest::CreateTask(_)
        | ServerRequest::UpdateTask(_)
        | ServerRequest::ArchiveTask(_)
        | ServerRequest::CancelTask(_)
        | ServerRequest::DeleteTask(_)
        | ServerRequest::ApplyTaskTransition(_)
        | ServerRequest::EndTaskTurn(_)
        | ServerRequest::CloseRefinement(_)
        | ServerRequest::RequestTaskExecution(_)
        | ServerRequest::ListTasksAwaitingMerge(_)
        | ServerRequest::ListTaskComments(_)
        | ServerRequest::AddTaskComment(_)
        | ServerRequest::ListTaskAttachments(_)
        | ServerRequest::AddTaskAttachment(_)
        | ServerRequest::DeleteTaskAttachment(_)
        | ServerRequest::ListWorktrees(_)
        | ServerRequest::GetWorktree(_)
        | ServerRequest::InsertWorktree(_)
        | ServerRequest::UpdateWorktree(_)
        | ServerRequest::DeleteWorktrees(_)
        | ServerRequest::SaveTaskReview(_)
        | ServerRequest::ClearTaskReview(_)
        | ServerRequest::ListLoopChecks(_)
        | ServerRequest::SetLoopChecks(_)
        | ServerRequest::TickLoopCheck(_)
        | ServerRequest::ListLoopIterations(_)
        | ServerRequest::ListPrompts(_)
        | ServerRequest::GetPrompt(_)
        | ServerRequest::CreatePrompt(_)
        | ServerRequest::UpdatePrompt(_)
        | ServerRequest::SetPromptFavorite(_)
        | ServerRequest::DeletePrompt(_)
        | ServerRequest::BeginImport(_)
        | ServerRequest::ImportChunk(_)
        | ServerRequest::CommitImport(_)
        | ServerRequest::GetCapacity
        | ServerRequest::SetCapacity(_)
        | ServerRequest::GetAutoMode(_)
        | ServerRequest::SetAutoMode(_)
        | ServerRequest::GetLoopWaitCap(_)
        | ServerRequest::SetLoopWaitCap(_)
        | ServerRequest::StartTask(_)) => {
            let Some(store) = project_store else {
                let e = crate::project_store::UNAVAILABLE.to_string();
                reply(stdout, &error_response(e)).await;
                return true;
            };
            if let ServerRequest::StartTask(req) = request {
                let launcher = crate::task_runner::Launcher {
                    store: Arc::clone(store),
                    agent_connections: Arc::clone(agent_connections),
                    settle_tx: settle_tx.clone(),
                    reply: Arc::clone(stdout),
                };
                Box::pin(crate::task_runner::answer_start(
                    launcher,
                    req,
                    sessions,
                    agents_with_spawn,
                ))
                .await;
                return true;
            }
            match Box::pin(crate::project_store::answer(store, request, sessions)).await {
                Ok((response, pushes)) => {
                    reply(stdout, &response).await;
                    for push in pushes {
                        crate::helpers::broadcast(stdout, push).await;
                    }
                }
                Err(e) => reply(stdout, &error_response(e)).await,
            }
        }
    }

    true
}
