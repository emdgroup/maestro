use std::sync::Arc;

use maestro_protocol::{
    CheckToolsResponse, DiscoveredAgent, ErrorResponse, FileReadResponse, FileSearchResponse,
    InstallSkillsResponse, ListAgentsResponse, MaestroRpcMessage, PreInitializeResponse,
    ServerRequest, ServerResponse, SessionUpdate, SpawnResponse, AUTH_REQUIRED_ERROR,
};

use crate::agent;
use crate::auth::{self, AuthTerminals};
use crate::file_ops::{handle_file_read, handle_file_search};
use crate::helpers::{
    ensure_and_get_connection, error_response, evict_if_same_connection, forward_to_session,
    resolve_agent_spawn_params, send_diag, send_response,
};
use crate::session::{self, create_session_on_connection};
use crate::sessions::{ActiveSession, SessionCommand, SessionMap, SharedAgentConnections};
use crate::tool_check::check_tools;

/// What every automation request answers with when the store could not be opened. Said plainly
/// rather than as an empty list, which would look like a project with no automations.
const NO_AUTOMATION_STORE: &str =
    "The automation store could not be opened, so automations are unavailable on this machine";

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

/// The requests a session sent a client and is still waiting on.
async fn pending_requests(session: &ActiveSession) -> Vec<maestro_protocol::PendingSessionRequest> {
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
            (crate::automations::canonical_project_path(&project.project_path) == project_path)
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
pub(crate) async fn close_session(
    session_id: &str,
    session: ActiveSession,
    agent_connections: &SharedAgentConnections,
    automation_store: Option<&crate::automation_runner::Store>,
    stdout: &crate::ClientOut,
) {
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
        tokio::spawn(async move {
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
        });
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
) {
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
    if let Some(session) = session {
        close_session(
            session_id,
            session,
            agent_connections,
            automation_store,
            stdout,
        )
        .await;
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
            (
                stdout,
                MaestroRpcMessage::Response(ServerResponse::DetectInstalledAgentsOk(response)),
            )
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
    if let Err(e) = send_response(&stdout, &response).await {
        send_diag("warn", format!("[server] could not answer a request: {e}"));
    }
}

/// Answer `response` from a task of its own. For work that is slow and touches nothing the loop
/// owns: a process to spawn or probe, a filesystem to walk, an agent to wait on.
fn answer_off_loop(
    stdout: &crate::ClientOut,
    response: impl std::future::Future<Output = MaestroRpcMessage> + Send + 'static,
) {
    let stdout = Arc::clone(stdout);
    tokio::spawn(async move {
        let response = response.await;
        if let Err(e) = send_response(&stdout, &response).await {
            send_diag("warn", format!("[server] could not answer a request: {e}"));
        }
    });
}

/// Handle one message from stdin.
///
/// Returns `true`  → the main loop should continue.
/// Returns `false` → stdout is broken; the main loop should break.
// Each argument is a distinct piece of the main loop's mutable state, borrowed separately
// because the loop's other arms hold some of them at the same time.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn dispatch_message(
    msg: MaestroRpcMessage,
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

        MaestroRpcMessage::Request(ServerRequest::ListProjectSessions(req)) => {
            let project_path = crate::automations::canonical_project_path(&req.project_path);
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
                    send_or_return!(send_response(stdout, &error_response(e)).await);
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
            send_or_return!(
                send_response(
                    stdout,
                    &MaestroRpcMessage::Response(ServerResponse::ListProjectSessionsOk(
                        maestro_protocol::ListProjectSessionsResponse { sessions: listed },
                    )),
                )
                .await
            );
        }

        MaestroRpcMessage::Request(ServerRequest::RenameSession(req)) => {
            let Some(store) = project_store else {
                send_or_return!(
                    send_response(
                        stdout,
                        &error_response(crate::project_store::UNAVAILABLE.to_string())
                    )
                    .await
                );
                return true;
            };
            let project_path = crate::automations::canonical_project_path(&req.project_path);
            let renamed = {
                let conn = store.lock().await;
                crate::project_store::rename(&conn, &req, &project_path, chrono::Utc::now())
            };
            match renamed {
                Ok(()) => send_or_return!(
                    send_response(
                        stdout,
                        &MaestroRpcMessage::Response(ServerResponse::RenameSessionOk),
                    )
                    .await
                ),
                Err(e) => send_or_return!(send_response(stdout, &error_response(e)).await),
            }
        }

        MaestroRpcMessage::Request(ServerRequest::CloseProjectSession(req)) => {
            let Some(store) = project_store else {
                send_or_return!(
                    send_response(
                        stdout,
                        &error_response(crate::project_store::UNAVAILABLE.to_string())
                    )
                    .await
                );
                return true;
            };
            // A session running under this key was loaded by somebody after the failure that
            // prompted this. Closing its row would hide a running session from every client
            // opening the project, and `Cancel` is how a running one is closed.
            let closed = if runs_under_key(sessions, &req.agent_id, &req.acp_session_id) {
                Ok(())
            } else {
                crate::project_store::close_dormant(
                    &*store.lock().await,
                    &req.agent_id,
                    &req.acp_session_id,
                    chrono::Utc::now(),
                )
            };
            match closed {
                Ok(()) => send_or_return!(
                    send_response(
                        stdout,
                        &MaestroRpcMessage::Response(ServerResponse::CloseProjectSessionOk),
                    )
                    .await
                ),
                Err(e) => send_or_return!(send_response(stdout, &error_response(e)).await),
            }
        }

        MaestroRpcMessage::Request(ServerRequest::Shutdown) => {
            send_diag("info", "[server] shutdown requested by the host");
            return false;
        }

        MaestroRpcMessage::Request(ServerRequest::ListAutomations(req)) => {
            let Some(store) = automation_store else {
                send_or_return!(
                    send_response(stdout, &error_response(NO_AUTOMATION_STORE.to_string())).await
                );
                return true;
            };
            let project_path = crate::automations::canonical_project_path(&req.project_path);
            let listed = {
                let conn = store.lock().await;
                crate::automations::list(&conn, &project_path).and_then(|automations| {
                    Ok((
                        automations,
                        crate::automations::retention(&conn, &project_path)?,
                    ))
                })
            };
            match listed {
                Ok((automations, retention)) => send_or_return!(
                    send_response(
                        stdout,
                        &MaestroRpcMessage::Response(ServerResponse::ListAutomationsOk(
                            maestro_protocol::ListAutomationsResponse {
                                automations,
                                server_timezone: crate::automations::server_timezone(),
                                retention,
                            },
                        )),
                    )
                    .await
                ),
                Err(e) => send_or_return!(send_response(stdout, &error_response(e)).await),
            }
        }

        MaestroRpcMessage::Request(ServerRequest::SaveAutomation(req)) => {
            let Some(store) = automation_store else {
                send_or_return!(
                    send_response(stdout, &error_response(NO_AUTOMATION_STORE.to_string())).await
                );
                return true;
            };
            // Canonicalized here rather than trusted from the client: this is the process on the
            // machine the path exists on, and every later lookup has to agree with this one.
            let project_path = crate::automations::canonical_project_path(&req.project_path);
            let mut automation = req.automation;
            automation.project_path = project_path.clone();
            let saved = {
                let conn = store.lock().await;
                crate::automations::save(&conn, &project_path, &automation)
            };
            match saved {
                Ok(saved) => send_or_return!(
                    send_response(
                        stdout,
                        &MaestroRpcMessage::Response(ServerResponse::SaveAutomationOk(saved)),
                    )
                    .await
                ),
                Err(e) => send_or_return!(send_response(stdout, &error_response(e)).await),
            }
        }

        MaestroRpcMessage::Request(ServerRequest::DeleteAutomation(req)) => {
            let Some(store) = automation_store else {
                send_or_return!(
                    send_response(stdout, &error_response(NO_AUTOMATION_STORE.to_string())).await
                );
                return true;
            };
            let deleted = {
                let conn = store.lock().await;
                crate::automations::delete(&conn, &req.automation_id)
            };
            match deleted {
                Ok(()) => send_or_return!(
                    send_response(
                        stdout,
                        &MaestroRpcMessage::Response(ServerResponse::DeleteAutomationOk),
                    )
                    .await
                ),
                Err(e) => send_or_return!(send_response(stdout, &error_response(e)).await),
            }
        }

        MaestroRpcMessage::Request(ServerRequest::RunAutomation(req)) => {
            let Some(store) = automation_store else {
                send_or_return!(
                    send_response(stdout, &error_response(NO_AUTOMATION_STORE.to_string())).await
                );
                return true;
            };
            // The run is announced by the runner, whether it starts or fails, so there is nothing
            // to answer with here beyond an error the request itself could not get past.
            if let Err(e) = crate::automation_runner::start(
                store,
                &req.automation_id,
                maestro_protocol::RunTrigger::Manual,
                None,
                crate::automation_runner::Spawner {
                    agents_with_spawn,
                    agent_connections,
                    stdout,
                    spawn_result_tx,
                },
            )
            .await
            {
                send_or_return!(send_response(stdout, &error_response(e)).await);
            }
        }

        MaestroRpcMessage::Request(ServerRequest::ListAutomationRuns(req)) => {
            let Some(store) = automation_store else {
                send_or_return!(
                    send_response(stdout, &error_response(NO_AUTOMATION_STORE.to_string())).await
                );
                return true;
            };
            let project_path = crate::automations::canonical_project_path(&req.project_path);
            let listed = {
                let conn = store.lock().await;
                crate::automations::list_runs(&conn, &project_path, req.limit)
            };
            match listed {
                Ok(runs) => send_or_return!(
                    send_response(
                        stdout,
                        &MaestroRpcMessage::Response(ServerResponse::ListAutomationRunsOk(
                            maestro_protocol::ListAutomationRunsResponse { runs },
                        )),
                    )
                    .await
                ),
                Err(e) => send_or_return!(send_response(stdout, &error_response(e)).await),
            }
        }

        MaestroRpcMessage::Request(ServerRequest::DeleteAutomationRun(req)) => {
            let Some(store) = automation_store else {
                send_or_return!(
                    send_response(stdout, &error_response(NO_AUTOMATION_STORE.to_string())).await
                );
                return true;
            };
            let run = {
                let conn = store.lock().await;
                crate::automations::get_run(&conn, &req.run_id)
            };
            // A run still going, or one whose session is still open, has an agent working in its
            // worktree: removing that from under it is not deleting history.
            let deleted = match run {
                Ok(None) => Ok(()),
                Ok(Some(run))
                    if matches!(run.status, maestro_protocol::AutomationRunStatus::Running) =>
                {
                    Err("Stop this run before deleting it".to_string())
                }
                Ok(Some(run))
                    if run
                        .session_id
                        .as_ref()
                        .is_some_and(|session_id| sessions.contains_key(session_id)) =>
                {
                    Err(
                        "This run's session is still open. Close it before deleting the run"
                            .to_string(),
                    )
                }
                Ok(Some(run)) => {
                    // Answered from its own task: removing a worktree is a git process, and the
                    // loop every session's traffic goes through must not wait on one.
                    let store = Arc::clone(store);
                    let stdout = Arc::clone(stdout);
                    tokio::spawn(async move {
                        let response =
                            match crate::automation_runner::discard_run(&store, &run).await {
                                Ok(()) => MaestroRpcMessage::Response(
                                    ServerResponse::DeleteAutomationRunOk,
                                ),
                                Err(e) => error_response(e),
                            };
                        if let Err(e) = send_response(&stdout, &response).await {
                            send_diag(
                                "warn",
                                format!("[automation] could not answer a run deletion: {e}"),
                            );
                        }
                    });
                    return true;
                }
                Err(e) => Err(e),
            };
            match deleted {
                Ok(()) => send_or_return!(
                    send_response(
                        stdout,
                        &MaestroRpcMessage::Response(ServerResponse::DeleteAutomationRunOk),
                    )
                    .await
                ),
                Err(e) => send_or_return!(send_response(stdout, &error_response(e)).await),
            }
        }

        MaestroRpcMessage::Request(ServerRequest::SetRunRetention(req)) => {
            let Some(store) = automation_store else {
                send_or_return!(
                    send_response(stdout, &error_response(NO_AUTOMATION_STORE.to_string())).await
                );
                return true;
            };
            let project_path = crate::automations::canonical_project_path(&req.project_path);
            let saved = {
                let conn = store.lock().await;
                crate::automations::set_retention(&conn, &project_path, req.retention)
            };
            match saved {
                Ok(()) => {
                    // Answered once trimmed, so the client's next read of the list is already the
                    // short one. From its own task, because trimming removes worktrees.
                    let store = Arc::clone(store);
                    let stdout = Arc::clone(stdout);
                    tokio::spawn(async move {
                        crate::automation_runner::apply_retention(&store, &project_path).await;
                        let response =
                            MaestroRpcMessage::Response(ServerResponse::SetRunRetentionOk);
                        if let Err(e) = send_response(&stdout, &response).await {
                            send_diag(
                                "warn",
                                format!("[automation] could not answer a retention change: {e}"),
                            );
                        }
                    });
                }
                Err(e) => send_or_return!(send_response(stdout, &error_response(e)).await),
            }
        }

        MaestroRpcMessage::Request(ServerRequest::GetServerStatus) => {
            let running_runs = match automation_store {
                Some(store) => crate::automations::count_running(&*store.lock().await),
                None => 0,
            };
            let status = server_status(sessions.len(), running_runs, crate::autostart::current());
            send_or_return!(
                send_response(
                    stdout,
                    &MaestroRpcMessage::Response(ServerResponse::ServerStatusOk(status)),
                )
                .await
            );
        }

        MaestroRpcMessage::Request(ServerRequest::SetAutostart(req)) => {
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
                    Ok(method) => MaestroRpcMessage::Response(ServerResponse::ServerStatusOk(
                        server_status(live_sessions, running_runs, method),
                    )),
                    Err(e) => error_response(e),
                };
                if let Err(e) = send_response(&stdout, &response).await {
                    send_diag("warn", format!("[autostart] could not answer: {e}"));
                }
            });
        }

        MaestroRpcMessage::Request(ServerRequest::GetWebhookSettings) => {
            let Some(store) = automation_store else {
                send_or_return!(
                    send_response(stdout, &error_response(NO_AUTOMATION_STORE.to_string())).await
                );
                return true;
            };
            let status = {
                let conn = store.lock().await;
                crate::webhook::status(&conn)
            };
            send_or_return!(
                send_response(
                    stdout,
                    &MaestroRpcMessage::Response(ServerResponse::WebhookSettingsOk(status)),
                )
                .await
            );
        }

        MaestroRpcMessage::Request(ServerRequest::SetWebhookSettings(settings)) => {
            let Some(store) = automation_store else {
                send_or_return!(
                    send_response(stdout, &error_response(NO_AUTOMATION_STORE.to_string())).await
                );
                return true;
            };
            let saved = {
                let conn = store.lock().await;
                crate::webhook::save_settings(&conn, &settings)
            };
            if let Err(e) = saved {
                send_or_return!(send_response(stdout, &error_response(e)).await);
                return true;
            }
            // Rebound straight away, so the answer already says whether the new address works.
            crate::webhook::restart(store).await;
            let status = {
                let conn = store.lock().await;
                crate::webhook::status(&conn)
            };
            send_or_return!(
                send_response(
                    stdout,
                    &MaestroRpcMessage::Response(ServerResponse::WebhookSettingsOk(status)),
                )
                .await
            );
        }

        MaestroRpcMessage::Request(ServerRequest::RollWebhookSecret(req)) => {
            let Some(store) = automation_store else {
                send_or_return!(
                    send_response(stdout, &error_response(NO_AUTOMATION_STORE.to_string())).await
                );
                return true;
            };
            let rolled = {
                let conn = store.lock().await;
                crate::automations::roll_webhook_secret(&conn, &req.automation_id)
            };
            match rolled {
                Ok(automation) => send_or_return!(
                    send_response(
                        stdout,
                        &MaestroRpcMessage::Response(ServerResponse::RollWebhookSecretOk(
                            automation
                        )),
                    )
                    .await
                ),
                Err(e) => send_or_return!(send_response(stdout, &error_response(e)).await),
            }
        }

        MaestroRpcMessage::Request(ServerRequest::ListWebhookDeliveries(req)) => {
            let Some(store) = automation_store else {
                send_or_return!(
                    send_response(stdout, &error_response(NO_AUTOMATION_STORE.to_string())).await
                );
                return true;
            };
            let listed = {
                let conn = store.lock().await;
                crate::webhook::list_deliveries(&conn, &req.automation_id)
            };
            match listed {
                Ok(deliveries) => send_or_return!(
                    send_response(
                        stdout,
                        &MaestroRpcMessage::Response(ServerResponse::ListWebhookDeliveriesOk(
                            maestro_protocol::ListWebhookDeliveriesResponse { deliveries },
                        )),
                    )
                    .await
                ),
                Err(e) => send_or_return!(send_response(stdout, &error_response(e)).await),
            }
        }

        // No store and no project: an expression being typed belongs to nothing yet. This is here
        // rather than in the editor because the daemon is the only thing that parses cron, and it
        // must stay that way while it is also the thing that decides when a run happens.
        MaestroRpcMessage::Request(ServerRequest::PreviewSchedule(req)) => {
            match crate::automations::validate_schedule(&req.cron, &req.timezone) {
                Ok(()) => {
                    let next =
                        crate::automations::next_due(&req.cron, &req.timezone, chrono::Utc::now())
                            .map(|due| due.to_rfc3339());
                    send_or_return!(
                        send_response(
                            stdout,
                            &MaestroRpcMessage::Response(ServerResponse::PreviewScheduleOk(
                                maestro_protocol::PreviewScheduleResponse { next },
                            )),
                        )
                        .await
                    );
                }
                Err(e) => send_or_return!(send_response(stdout, &error_response(e)).await),
            }
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

        MaestroRpcMessage::Request(ServerRequest::HostToolResult(result)) => {
            if let Some((_, tx)) = pending_host_tools.remove(&result.request_id) {
                let _ = tx.send(result);
            }
        }

        MaestroRpcMessage::Request(ServerRequest::Cancel(req)) => {
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

        MaestroRpcMessage::Request(ServerRequest::InterruptTurn(req)) => {
            if let Some(session) = sessions.get(&req.session_id) {
                let _ = session.cmd_tx.send(SessionCommand::CancelTurn).await;
            }
        }

        MaestroRpcMessage::Request(ServerRequest::PermitResponse(perm_resp)) => {
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

        MaestroRpcMessage::Request(ServerRequest::ElicitationResponse(elicit_resp)) => {
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
            answer_off_loop(stdout, async move {
                let result = tokio::task::spawn_blocking(move || handle_file_search(req))
                    .await
                    .unwrap_or_else(|e| Err(format!("spawn_blocking: {}", e)));
                match result {
                    Ok(files) => MaestroRpcMessage::Response(ServerResponse::FileSearchOk(
                        FileSearchResponse { files },
                    )),
                    Err(msg) => MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
                        message: msg,
                        session_id: None,
                    })),
                }
            });
        }

        MaestroRpcMessage::Request(ServerRequest::FileRead(req)) => {
            answer_off_loop(stdout, async move {
                match handle_file_read(&req).await {
                    Ok(content) => {
                        MaestroRpcMessage::Response(ServerResponse::FileReadOk(FileReadResponse {
                            content,
                        }))
                    }
                    Err(msg) => MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
                        message: msg,
                        session_id: None,
                    })),
                }
            });
        }

        MaestroRpcMessage::Request(ServerRequest::SessionList(req)) => {
            return session::requests::list(req, agent_connections, agents_with_spawn, stdout)
                .await;
        }

        MaestroRpcMessage::Request(ServerRequest::SessionLoad(req)) => {
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

        MaestroRpcMessage::Request(ServerRequest::SessionClose(req)) => {
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

        MaestroRpcMessage::Request(ServerRequest::SessionDelete(req)) => {
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
                let _ = send_response(
                    &stdout,
                    &MaestroRpcMessage::Response(ServerResponse::PreInitializeOk(response)),
                )
                .await;
            });
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

        // Probing a tool runs it, and installing skills runs the skills CLI.
        MaestroRpcMessage::Request(ServerRequest::CheckTools(req)) => {
            answer_off_loop(stdout, async move {
                let results = check_tools(req.tools).await;
                MaestroRpcMessage::Response(ServerResponse::CheckToolsOk(CheckToolsResponse {
                    results,
                }))
            });
        }

        MaestroRpcMessage::Request(ServerRequest::InstallSkills(req)) => {
            answer_off_loop(stdout, async move {
                match crate::skills::install(req.skills).await {
                    Ok(installed) => MaestroRpcMessage::Response(ServerResponse::InstallSkillsOk(
                        InstallSkillsResponse { installed },
                    )),
                    Err(message) => {
                        MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
                            message,
                            session_id: None,
                        }))
                    }
                }
            });
        }

        MaestroRpcMessage::Request(ServerRequest::ListMcpServers(req)) => {
            let response = match crate::mcp_store::list() {
                Ok(servers) => MaestroRpcMessage::Response(ServerResponse::ListMcpServersOk(
                    maestro_protocol::McpServerList {
                        servers,
                        project: req
                            .project_path
                            .as_deref()
                            .map(crate::mcp_config::project_servers)
                            .unwrap_or_default(),
                    },
                )),
                Err(e) => error_response(e),
            };
            send_or_return!(send_response(stdout, &response).await);
        }

        MaestroRpcMessage::Request(ServerRequest::SaveMcpServers(req)) => {
            let response = match crate::mcp_store::save(req.servers) {
                Ok(()) => MaestroRpcMessage::Response(ServerResponse::SaveMcpServersOk),
                Err(e) => error_response(e),
            };
            send_or_return!(send_response(stdout, &response).await);
        }

        MaestroRpcMessage::Request(ServerRequest::SetMcpSecrets(req)) => {
            crate::mcp_store::set_secrets(req.secrets);
            send_or_return!(
                send_response(
                    stdout,
                    &MaestroRpcMessage::Response(ServerResponse::SetMcpSecretsOk)
                )
                .await
            );
        }

        MaestroRpcMessage::Request(ServerRequest::ListSkills(req)) => {
            let response = match crate::skills::list(req.project_path.as_deref()) {
                Ok(list) => MaestroRpcMessage::Response(ServerResponse::ListSkillsOk(list)),
                Err(e) => error_response(e),
            };
            send_or_return!(send_response(stdout, &response).await);
        }

        // Offloaded, like a spawn: starting a server or running the skills CLI takes seconds, and
        // the loop has permission answers and heartbeats to keep serving meanwhile.
        MaestroRpcMessage::Request(ServerRequest::TestMcpServer(req)) => {
            let stdout = Arc::clone(stdout);
            tokio::spawn(async move {
                let result = crate::mcp_store::test(req.server).await;
                let _ = send_response(
                    &stdout,
                    &MaestroRpcMessage::Response(ServerResponse::TestMcpServerOk(result)),
                )
                .await;
            });
        }

        MaestroRpcMessage::Request(ServerRequest::ApplySkill(req)) => {
            let stdout = Arc::clone(stdout);
            tokio::spawn(async move {
                let response = match crate::skills::apply(req).await {
                    Ok(()) => MaestroRpcMessage::Response(ServerResponse::ApplySkillOk),
                    Err(e) => error_response(e),
                };
                let _ = send_response(&stdout, &response).await;
            });
        }

        MaestroRpcMessage::Request(ServerRequest::DeleteSkill(req)) => {
            let stdout = Arc::clone(stdout);
            tokio::spawn(async move {
                let response = match crate::skills::delete(&req.name).await {
                    Ok(()) => MaestroRpcMessage::Response(ServerResponse::DeleteSkillOk),
                    Err(e) => error_response(e),
                };
                let _ = send_response(&stdout, &response).await;
            });
        }

        // `tools.json` is written under a file lock, so two of these at once cannot lose a write.
        MaestroRpcMessage::Request(ServerRequest::SetToolPath(req)) => {
            answer_off_loop(stdout, async move {
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
                MaestroRpcMessage::Response(ServerResponse::SetToolPathOk(result))
            });
        }

        MaestroRpcMessage::Request(ServerRequest::TestToolPath(req)) => {
            answer_off_loop(stdout, async move {
                let result = crate::tool_check::test_tool_path(req.tool, req.path).await;
                MaestroRpcMessage::Response(ServerResponse::TestToolPathOk(result))
            });
        }

        // The probe scans PATH for every bundled agent, which is slow on Windows. What it finds
        // is applied to the agent list back on the loop, which owns it.
        MaestroRpcMessage::Request(ServerRequest::DetectInstalledAgents(_req)) => {
            let settle_tx = settle_tx.clone();
            let stdout = Arc::clone(stdout);
            tokio::spawn(async move {
                let response = agent::detection::detect_installed_agents().await;
                let _ = settle_tx.send(Settle::Detected(response, stdout));
            });
        }

        MaestroRpcMessage::Request(ServerRequest::DetectProjectAgents(req)) => {
            answer_off_loop(stdout, async move {
                let response = agent::detection::detect_project_agents(&req.cwd).await;
                MaestroRpcMessage::Response(ServerResponse::DetectProjectAgentsOk(response))
            });
        }

        MaestroRpcMessage::Request(ServerRequest::AcquireProjectLock(req)) => {
            let path = crate::automations::canonical_project_path(&req.project_path);
            let resp = stdout.lock().await.acquire_project(path, req.label).await;
            send_or_return!(
                send_response(
                    stdout,
                    &MaestroRpcMessage::Response(ServerResponse::AcquireProjectLockOk(resp)),
                )
                .await
            );
        }

        MaestroRpcMessage::Request(ServerRequest::ReleaseProjectLock) => {
            stdout.lock().await.release_project().await;
        }

        MaestroRpcMessage::Request(ServerRequest::ListProjectLocks(req)) => {
            let paths = req
                .project_paths
                .into_iter()
                .map(|sent| {
                    let canonical = crate::automations::canonical_project_path(&sent);
                    (sent, canonical)
                })
                .collect();
            let locks = stdout.lock().await.list_projects(paths).await;
            send_or_return!(
                send_response(
                    stdout,
                    &MaestroRpcMessage::Response(ServerResponse::ProjectLocksOk(
                        maestro_protocol::ListProjectLocksResponse { locks },
                    )),
                )
                .await
            );
        }

        // Answered through the sink, not here: the answer may be ten seconds away.
        MaestroRpcMessage::Request(ServerRequest::RequestTakeover(req)) => {
            let path = crate::automations::canonical_project_path(&req.project_path);
            stdout.lock().await.start_takeover(path, req.label).await;
        }

        MaestroRpcMessage::Request(ServerRequest::TakeoverAnswer(answer)) => {
            stdout
                .lock()
                .await
                .answer_takeover(answer.request_id, answer.accept)
                .await;
        }

        // The host logs both sides of the heartbeat at trace; echoing it here would either be
        // discarded (this process is spawned with a null stderr on one path) or, if forwarded as
        // a diagnostic, put every ping on the IPC channel.
        MaestroRpcMessage::Request(ServerRequest::Pong { seq: _ }) => {}

        // Fast SQLite, so answered on the loop like the session rows. The reply goes first, then
        // the pushes to everybody, the requester included: its own refetch rides on them too.
        MaestroRpcMessage::Request(
            request @ (ServerRequest::ListTasks(_)
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
            | ServerRequest::ListQueueCandidates(_)
            | ServerRequest::ListTasksAwaitingMerge(_)
            | ServerRequest::ImportTasks(_)
            | ServerRequest::ListTaskComments(_)
            | ServerRequest::AddTaskComment(_)
            | ServerRequest::ListTaskAttachments(_)
            | ServerRequest::AddTaskAttachment(_)
            | ServerRequest::DeleteTaskAttachment(_)
            | ServerRequest::ListTaskRelationships(_)
            | ServerRequest::AddTaskRelationship(_)
            | ServerRequest::DeleteTaskRelationship(_)
            | ServerRequest::ListTaskInstructions(_)
            | ServerRequest::AddTaskInstruction(_)
            | ServerRequest::ListWorktrees(_)
            | ServerRequest::GetWorktree(_)
            | ServerRequest::InsertWorktree(_)
            | ServerRequest::UpdateWorktree(_)
            | ServerRequest::DeleteWorktrees(_)
            | ServerRequest::ClaimWorktreeForTask(_)
            | ServerRequest::GetTaskReview(_)
            | ServerRequest::SaveTaskReview(_)
            | ServerRequest::ClearTaskReview(_)
            | ServerRequest::ListPrompts(_)
            | ServerRequest::GetPrompt(_)
            | ServerRequest::CreatePrompt(_)
            | ServerRequest::UpdatePrompt(_)
            | ServerRequest::SetPromptFavorite(_)
            | ServerRequest::DeletePrompt(_)
            | ServerRequest::BeginImport(_)
            | ServerRequest::ImportChunk(_)
            | ServerRequest::CommitImport(_)),
        ) => {
            let Some(store) = project_store else {
                send_or_return!(
                    send_response(
                        stdout,
                        &error_response(crate::project_store::UNAVAILABLE.to_string())
                    )
                    .await
                );
                return true;
            };
            let answered = match request {
                request @ (ServerRequest::ListPrompts(_)
                | ServerRequest::GetPrompt(_)
                | ServerRequest::CreatePrompt(_)
                | ServerRequest::UpdatePrompt(_)
                | ServerRequest::SetPromptFavorite(_)
                | ServerRequest::DeletePrompt(_)) => {
                    crate::prompt_store::answer(&*store.lock().await, request)
                }
                ServerRequest::BeginImport(request) => {
                    crate::task_store::project_import::begin(request).map(|r| (r, Vec::new()))
                }
                ServerRequest::ImportChunk(request) => {
                    crate::task_store::project_import::chunk(request).map(|r| (r, Vec::new()))
                }
                ServerRequest::CommitImport(request) => {
                    match crate::task_store::project_import::take_staged(&request.import_id) {
                        Ok(staged) => crate::task_store::project_import::answer(
                            &mut *store.lock().await,
                            staged,
                        ),
                        Err(e) => Err(e),
                    }
                }
                request => crate::task_store::requests::answer(&mut *store.lock().await, request),
            };
            match answered {
                Ok((reply, pushes)) => {
                    send_or_return!(
                        send_response(stdout, &MaestroRpcMessage::Response(reply)).await
                    );
                    for push in pushes {
                        crate::helpers::broadcast(stdout, push).await;
                    }
                }
                Err(e) => send_or_return!(send_response(stdout, &error_response(e)).await),
            }
        }

        MaestroRpcMessage::Request(
            request @ (ServerRequest::GetCapacity
            | ServerRequest::SetCapacity(_)
            | ServerRequest::GetAutoMode(_)
            | ServerRequest::SetAutoMode(_)),
        ) => {
            let answered = match project_store {
                Some(store) => crate::pipeline_settings::answer(&*store.lock().await, request),
                None => Err(crate::project_store::UNAVAILABLE.to_string()),
            };
            match answered {
                Ok((reply, pushes)) => {
                    send_or_return!(
                        send_response(stdout, &MaestroRpcMessage::Response(reply)).await
                    );
                    for push in pushes {
                        crate::helpers::broadcast(stdout, push).await;
                    }
                }
                Err(e) => send_or_return!(send_response(stdout, &error_response(e)).await),
            }
        }

        MaestroRpcMessage::Request(
            request @ (ServerRequest::HoldTask(_) | ServerRequest::ReleaseTaskHold(_)),
        ) => {
            crate::scheduler::hold_changed(&request);
            let reply = match crate::pipeline_settings::answer_hold(request) {
                Ok(reply) => MaestroRpcMessage::Response(reply),
                Err(e) => error_response(e),
            };
            send_or_return!(send_response(stdout, &reply).await);
        }

        MaestroRpcMessage::Request(ServerRequest::StartTask(req)) => {
            let Some(store) = project_store else {
                send_or_return!(
                    send_response(
                        stdout,
                        &error_response(crate::project_store::UNAVAILABLE.to_string())
                    )
                    .await
                );
                return true;
            };
            // A custom agent added since startup is merged before it is looked for, as `ListAgents`
            // does on every call.
            agent::registry::apply_custom_agents(agents_with_spawn);
            let mut pushes = Vec::new();
            let begun = crate::task_runner::begin(
                &mut *store.lock().await,
                &req,
                crate::pipeline_settings::used_slots(sessions),
                agents_with_spawn,
                &mut pushes,
            );
            for push in pushes {
                crate::helpers::broadcast(stdout, push).await;
            }
            match begun {
                Ok(crate::task_runner::Begun::Deferred) => send_or_return!(
                    send_response(
                        stdout,
                        &MaestroRpcMessage::Response(ServerResponse::StartTaskOk(
                            maestro_protocol::StartTaskResponse { session_id: None },
                        )),
                    )
                    .await
                ),
                // Answered once the session is in the map, or once the start has failed.
                Ok(crate::task_runner::Begun::Claimed(claimed)) => {
                    tokio::spawn(Box::pin(crate::task_runner::launch(
                        crate::task_runner::Launcher {
                            store: Arc::clone(store),
                            agent_connections: Arc::clone(agent_connections),
                            settle_tx: settle_tx.clone(),
                            reply: Arc::clone(stdout),
                        },
                        claimed,
                    )));
                }
                Err(e) => send_or_return!(send_response(stdout, &error_response(e)).await),
            }
        }

        MaestroRpcMessage::Response(_) => {}
    }

    true
}
