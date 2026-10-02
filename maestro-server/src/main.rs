#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]
//! Maestro Remote Server
//!
//! Headless binary that runs on remote SSH hosts. Receives MaestroRpcMessage
//! commands from the local Maestro desktop app over stdin/stdout (piped through
//! SSH exec channel), spawns ACP agents as local subprocesses, and forwards
//! structured session updates back.
//!
//! Architecture: Adapted from Zed's remote_server (GPL-3.0).

mod agent;
mod agent_restart;
mod auth;
mod automation_runner;
mod automations;
mod autostart;
mod client_sink;
mod command_ext;
mod daemon;
mod dispatch;
mod exec_channel;
mod file_ops;
mod helpers;
mod mcp_config;
mod mcp_gateway;
mod mcp_stdio;
mod mcp_store;
mod pipeline_settings;
mod profiles;
mod project_locks;
mod project_store;
mod prompt_store;
mod scheduler;
mod session;
mod sessions;
mod skills;
mod task_prompt;
mod task_restart;
mod task_runner;
mod task_store;
mod task_turn;
mod terminal;
mod tool_check;
mod tool_config;
mod turn;
mod webhook;
mod workspace_roots;
mod worktree;

#[cfg(test)]
mod tests;

use std::collections::HashMap;
use std::sync::Arc;

use maestro_protocol::{
    AcpRegistry, DiagnosticPayload, ErrorResponse, HandshakeResponse, MaestroRpcMessage,
    ServerRequest, ServerResponse, PROTOCOL_VERSION,
};

use agent_restart::handle_agent_restart;
use auth::AuthTerminalState;
use dispatch::dispatch_message;
use sessions::{
    ActiveSession, AgentConnectionMap, SessionCommand, SessionMap, SharedAgentConnections,
};

// Re-export so that `crate::send_response` and `crate::send_diag` still resolve
// for the submodules that import them via `use crate::send_response` /
// `crate::send_diag(...)`.
pub(crate) use client_sink::ClientOut;
pub(crate) use helpers::{send_diag, send_response, DIAG_TX};

fn main() {
    if std::env::args().any(|a| a == "--protocol-version") {
        println!("{}", PROTOCOL_VERSION);
        return;
    }
    if std::env::args().any(|a| a == "--app-version") {
        println!(
            "{}-protocol-{}",
            env!("CARGO_PKG_VERSION"),
            PROTOCOL_VERSION
        );
        return;
    }
    if std::env::args().nth(1).as_deref() == Some("mcp") {
        // Its own runtime: the shim is a separate process from the ACP server it talks to, and
        // shares no state with it.
        std::process::exit(mcp_stdio::run());
    }
    // Resident mode and the relay that reaches it. Both need a runtime; `daemon` then never
    // returns until it is asked to stop, and `attach` returns when the app's stdin closes.
    if let Some(mode @ ("daemon" | "attach")) = std::env::args().nth(1).as_deref() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("Failed to build tokio runtime");
        let result = match mode {
            "daemon" => runtime.block_on(daemon::run_daemon()),
            _ => runtime.block_on(daemon::run_attach()),
        };
        if let Err(e) = result {
            eprintln!("maestro-server {mode}: {e}");
            std::process::exit(1);
        }
        return;
    }
    if std::env::args().nth(1).as_deref() == Some(maestro_protocol::exec::EXEC_CHANNEL_ARG) {
        // Its own runtime: this mode shares no state with the ACP server and never starts one.
        if let Err(e) = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("Failed to build tokio runtime")
            .block_on(exec_channel::run())
        {
            eprintln!("exec channel failed: {}", e);
            std::process::exit(1);
        }
        return;
    }
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("Failed to build tokio runtime")
        .block_on(async_main())
        .expect("maestro-server fatal error");
}

/// Channel the server loop receives client requests on, whatever carried them.
type MsgRx = tokio::sync::mpsc::Receiver<Inbound>;

/// A client request, with the route its replies take (`None` for the stdio client, the only one)
/// and the id it came with, which its reply echoes.
pub(crate) type Inbound = Result<
    (
        MaestroRpcMessage,
        Option<ClientOut>,
        Option<maestro_protocol::RequestId>,
    ),
    String,
>;

/// Stdio mode: one client, this process's parent, for the life of the process.
async fn async_main() -> Result<(), Box<dyn std::error::Error>> {
    let stdout = client_sink::ClientSink::stdio();

    // On Windows, anonymous pipes don't support overlapped I/O (IOCP), so
    // tokio::io::stdin() falls back to spawn_blocking for each read. When a
    // tokio::select! picks a different arm and drops the read_message future,
    // the blocking thread keeps running and its ReadFile result is discarded —
    // silently consuming the 4-byte framing prefix and desyncing the stream.
    // Fix: one dedicated blocking thread owns stdin forever and forwards messages
    // over a channel, so the future the select polls is always the channel receive,
    // never a raw stdin read.
    let (stdin_msg_tx, mut stdin_msg_rx) = tokio::sync::mpsc::channel::<Inbound>(4);
    tokio::task::spawn_blocking(move || {
        let stdin = std::io::stdin();
        let mut locked = stdin.lock();
        loop {
            match maestro_protocol::read_message_with_id_sync(&mut locked) {
                Ok((request_id, msg)) => {
                    if stdin_msg_tx
                        .blocking_send(Ok((msg, None, request_id)))
                        .is_err()
                    {
                        break;
                    }
                }
                Err(e) => {
                    let msg = e.to_string();
                    let is_eof = msg.contains("failed to fill whole buffer")
                        || msg.contains("unexpected eof")
                        || msg.contains("early eof");
                    let _ = stdin_msg_tx.blocking_send(Err(msg));
                    if is_eof {
                        break;
                    }
                    // "Message too large": body bytes still in pipe; loop back
                    // and read the next 4 bytes — same cascade semantics as before.
                }
            }
        }
    });

    // Validate the protocol version handshake before entering the main dispatch loop.
    let first_msg = match stdin_msg_rx.recv().await {
        Some(Ok((msg, _, _))) => msg,
        _ => return Ok(()),
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
                        session_id: None,
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
                    session_id: None,
                })),
            )
            .await;
            return Ok(());
        }
    }

    run_server(stdin_msg_rx, stdout).await
}

/// Daemon mode: no client at first, then whichever one is attached, then none again.
///
/// The server loop below never learns which it is running under. It ends when its message channel
/// closes, and in daemon mode that channel is owned by the accept loop rather than by any one
/// client, so a client disconnecting leaves every running session exactly where it was.
pub(crate) async fn run_resident(
    listener: tokio::net::TcpListener,
    token: String,
) -> Result<(), String> {
    let sink = client_sink::ClientSink::detached();
    let (msg_tx, msg_rx) = tokio::sync::mpsc::channel::<Inbound>(4);

    tokio::spawn({
        let sink = Arc::clone(&sink);
        async move {
            let token = Arc::new(token);
            let mut clients = tokio::task::JoinSet::new();
            loop {
                tokio::select! {
                    accepted = listener.accept() => {
                        let Ok((stream, _)) = accepted else {
                            continue;
                        };
                        let (token, sink, msg_tx) =
                            (Arc::clone(&token), Arc::clone(&sink), msg_tx.clone());
                        clients.spawn(async move {
                            daemon::serve_client(stream, &token, &sink, &msg_tx).await
                        });
                    }
                    // Matched inside rather than in the pattern: a pattern that misses disables the
                    // branch until the next accept, and a shutdown finishing then would wait on it.
                    Some(joined) = clients.join_next() => {
                        if matches!(joined, Ok(true)) {
                            break;
                        }
                    }
                }
            }
            // Dropping the set aborts every client task and with it their senders; dropping ours,
            // the last one, ends the server loop, which tears down every session.
        }
    });

    run_server(msg_rx, sink).await.map_err(|e| e.to_string())
}

/// How often the sweep below runs, and so the unit its grace period is counted in.
///
/// Residency made sessions immortal, and an immortal session is an agent child process this
/// machine keeps forever. The sweep is what separates "the app is closing and will be back" from
/// "nobody is coming": a session has to be found idle twice running to be closed, so it survives
/// for between one and two minutes after the last client leaves. A reopen inside that re-adopts it
/// as it stands, and a later one pays a `session/load` to get the same transcript back from the
/// agent's own history.
const IDLE_SWEEP: std::time::Duration = std::time::Duration::from_secs(60);

/// How often the clock looks for an automation that has come round.
///
/// A minute, because that is the finest a cron expression can name. Anything shorter would ask the
/// same question of the same rows for no answer that could differ.
const AUTOMATION_TICK: std::time::Duration = std::time::Duration::from_secs(60);

/// Mark sessions that are idle with no client attached, and close the ones already marked.
///
/// Two passes rather than one so that resuming counts for something: any activity in between
/// clears the mark, and the session starts over. Idle means no turn in flight, so a session
/// working through a prompt runs to completion whether or not anyone is watching, and is only
/// marked once it is done. A session blocked on a permission prompt counts as mid-turn, which is
/// what keeps the question answerable after a reopen instead of being reaped out from under the
/// user.
///
/// The close goes through the session's own command loop rather than aborting its task, because
/// `session/close` is what leaves the agent holding a transcript that `session/load` can replay.
/// An agent that does not support `session/load` loses that transcript here; reaping uniformly is
/// the accepted cost of not keeping an unbounded number of agent processes alive.
async fn reap_idle_sessions(
    sessions: &mut SessionMap,
    stdout: &crate::ClientOut,
    automation_store: Option<&automation_runner::Store>,
    project_store: Option<&project_store::Store>,
) {
    let attached = stdout.lock().await.is_attached();
    let mut reap: Vec<String> = Vec::new();

    for (session_id, session) in sessions.iter_mut() {
        let busy = attached
            || session
                .turn_active
                .load(std::sync::atomic::Ordering::SeqCst);
        if busy {
            session.idle_marked = false;
        } else if session.idle_marked {
            reap.push(session_id.clone());
        } else {
            session.idle_marked = true;
        }
    }

    for session_id in reap {
        let Some(session) = sessions.remove(&session_id) else {
            continue;
        };
        // The command loop drains what is queued before it sees the closed channel, so removing
        // the session from the map does not race the close it was just asked for.
        if session
            .cmd_tx
            .send(SessionCommand::CloseSession)
            .await
            .is_err()
        {
            session.task.abort();
        }
        if let Some(cleanup) = &session.cleanup {
            cleanup.router.unregister(&cleanup.acp_session_id).await;
        }
        send_diag(
            "info",
            format!("[reap] closed idle session={session_id} with no client attached"),
        );
        if let Some(store) = project_store {
            project_store::report(project_store::go_dormant(
                &*store.lock().await,
                &session_id,
                chrono::Utc::now(),
            ));
            if let (Some(automation_store), Some(cleanup)) = (automation_store, &session.cleanup) {
                automation_runner::close_finished_run_rows(
                    automation_store,
                    store,
                    Some((&session.agent_id, &cleanup.acp_session_id)),
                )
                .await;
            }
        }
        // Only now: the agent held files open under its workspace for as long as the session
        // lived, and on Windows a removal while it does simply fails.
        if let Some(store) = automation_store {
            automation_runner::settle_worktree_for_session(store, stdout, &session_id).await;
        }
    }
}

/// Record a session that has just come up and take it into the map.
///
/// Unless its row was closed while it was coming up: nothing would own it and no list would show
/// it, and the idle sweep never closes it while a window is attached. The client was already sent
/// its `SpawnOk` or `SessionLoadOk`, and needs nothing more: every host path that closes a row
/// has dropped its own entry first, so it holds nothing waiting on this session. `false` then.
pub(crate) async fn register_started_session(
    session_id: String,
    session: ActiveSession,
    sessions: &mut SessionMap,
    agent_connections: &SharedAgentConnections,
    project_store: Option<&project_store::Store>,
    automation_store: Option<&automation_runner::Store>,
    stdout: &crate::ClientOut,
) -> bool {
    let recorded = match (
        project_store,
        session.project.as_ref(),
        session.cleanup.as_ref(),
    ) {
        (Some(store), Some(project), Some(cleanup)) => project_store::upsert(
            &*store.lock().await,
            &project_store::Started {
                agent_id: &session.agent_id,
                acp_session_id: &cleanup.acp_session_id,
                project_path: &automations::canonical_project_path(&project.project_path),
                cwd: &session.cwd,
                meta: &project.meta,
                can_reload: project.can_reload,
                session_id: &session_id,
                requested_at: project.requested_at,
            },
            chrono::Utc::now(),
        ),
        _ => Ok(true),
    };
    match recorded {
        Ok(true) => {}
        Ok(false) => {
            send_diag(
                "info",
                format!(
                    "[session] closing session={session_id}, its row was closed while it came up"
                ),
            );
            dispatch::close_session(
                &session_id,
                session,
                agent_connections,
                automation_store,
                stdout,
            )
            .await;
            return false;
        }
        Err(e) => project_store::report(Err(e)),
    }
    sessions.insert(session_id.clone(), session);
    // Only now can a client adopt it: `ListProjectSessions` reports a row as live when this map
    // holds its routing id. An automation's run is announced again here and nowhere earlier, after
    // the row and the entry, so a window already attached finds the session the moment it is told
    // the run has one.
    if let Some(store) = automation_store {
        automation_runner::announce_session(store, stdout, &session_id).await;
    }
    true
}

/// The server proper: dispatch requests until the client channel closes.
/// When this process began serving, for the status the app shows beside Stop.
pub(crate) static STARTED_AT: std::sync::OnceLock<String> = std::sync::OnceLock::new();

async fn run_server(
    mut stdin_msg_rx: MsgRx,
    stdout: crate::ClientOut,
) -> Result<(), Box<dyn std::error::Error>> {
    STARTED_AT.get_or_init(|| chrono::Utc::now().to_rfc3339());
    let mut sessions: SessionMap = HashMap::new();
    let agent_connections: SharedAgentConnections =
        Arc::new(tokio::sync::Mutex::new(AgentConnectionMap::new()));
    // Completed Spawn and SessionLoad tasks send their results here so the main loop
    // can insert sessions without holding any lock across the async ACP operations.
    let (spawn_result_tx, mut spawn_result_rx) =
        tokio::sync::mpsc::channel::<(String, ActiveSession)>(8);
    // Requests answered off the loop hand back what touches state only the loop owns.
    let (settle_tx, mut settle_rx) = tokio::sync::mpsc::unbounded_channel::<dispatch::Settle>();
    let _ = dispatch::SETTLE_TX.set(settle_tx.clone());

    let (diag_tx, diag_rx) = tokio::sync::mpsc::unbounded_channel::<DiagnosticPayload>();
    let _ = DIAG_TX.set(diag_tx);

    let (turn_tx, mut turn_rx) = tokio::sync::mpsc::unbounded_channel::<helpers::TurnEnd>();
    let _ = helpers::TURN_TX.set(turn_tx);

    let (fire_tx, mut fire_rx) = tokio::sync::mpsc::unbounded_channel::<webhook::Fire>();
    let _ = webhook::FIRE_TX.set(fire_tx);

    // `None` when the store cannot be opened. Sessions are the server's real job and go on without
    // it; automations answer with the reason instead, which is better than refusing to start.
    let automation_store: Option<automation_runner::Store> = daemon::dir()
        .and_then(|dir| automations::open(&dir))
        .map(|conn| {
            match automations::fail_interrupted_runs(&conn) {
                Ok(0) => {}
                Ok(closed) => send_diag(
                    "info",
                    format!("[automation] closed out {closed} run(s) left by an earlier server"),
                ),
                Err(e) => send_diag("warn", format!("[automation] {e}")),
            }
            Arc::new(tokio::sync::Mutex::new(conn))
        })
        .map_err(|e| send_diag("warn", format!("[automation] store unavailable: {e}")))
        .ok();

    // `None` when it cannot be opened, as above: sessions run, and are simply not recorded.
    let project_store: Option<project_store::Store> = daemon::dir()
        .and_then(|dir| project_store::open(&dir))
        .and_then(|conn| {
            project_store::reset_on_start(&conn, chrono::Utc::now())?;
            Ok(Arc::new(tokio::sync::Mutex::new(conn)))
        })
        .map_err(|e| send_diag("warn", format!("[project-store] store unavailable: {e}")))
        .ok();
    if let Some(store) = &project_store {
        let _ = project_store::SHARED.set(Arc::clone(store));
    }

    // After the runs above are closed out, so a workspace left by a server that died mid-run is
    // evaluated rather than sitting there for ever.
    if let Some(store) = automation_store.as_ref() {
        Box::pin(automation_runner::sweep_worktrees(store, &stdout)).await;
        Box::pin(automation_runner::apply_all_retention(store)).await;
        Box::pin(webhook::restart(store)).await;
    }
    // Every run is over by now, `fail_interrupted_runs` having ended the ones this daemon's
    // predecessor died in, so none of their sessions is running and none is left for a project
    // open to reload.
    if let (Some(automation_store), Some(project_store)) =
        (automation_store.as_ref(), project_store.as_ref())
    {
        Box::pin(automation_runner::close_finished_run_rows(
            automation_store,
            project_store,
            None,
        ))
        .await;
    }

    // Agent discovery (which::which PATH scanning) runs after the handshake so the client does not
    // time out waiting on slow PATH scans on Windows.
    let registry: AcpRegistry = tokio::task::spawn_blocking(agent::load_registry)
        .await
        .unwrap_or_else(|_| agent::load_registry());

    // After the handshake so a client of the wrong protocol version never opens a listener, and
    // before the first session so `mcp_servers_for` has an address to inject.
    let mut gateway_rx = Box::pin(mcp_gateway::start()).await;
    let mut pending_host_tools = mcp_gateway::PendingHostTools::new();

    let mut agents_with_spawn: Vec<agent::registry::DiscoveredAgentWithSpawn> =
        agent::discover_agents(&registry);
    // Before the first request, because a project opening on this connection loads its sessions
    // before it lists any agents, and a custom agent missing here would make those loads final.
    agent::registry::apply_custom_agents(&mut agents_with_spawn);
    // The queue drains itself. Its slot count is asked of this loop.
    let mut scheduler_rx = project_store.as_ref().map(|store| {
        scheduler::start(scheduler::Deps {
            store: Arc::clone(store),
            agent_connections: Arc::clone(&agent_connections),
            settle_tx: settle_tx.clone(),
            stdout: Arc::clone(&stdout),
        })
    });
    // Once, with the map empty: the tasks the last daemon left in flight are picked up off the loop,
    // their reloaded sessions arriving through `settle_rx` like any task session.
    if let Some(store) = project_store.as_ref() {
        let planned = task_restart::plan(&*store.lock().await);
        task_restart::spawn(
            task_turn::Driver {
                store: Arc::clone(store),
                agent_connections: Arc::clone(&agent_connections),
                settle_tx: settle_tx.clone(),
                stdout: Arc::clone(&stdout),
                agents: agents_with_spawn.clone(),
            },
            planned,
        );
    }
    let mut task_slots = 0;
    let auth_terminals: Arc<
        tokio::sync::Mutex<std::collections::HashMap<String, AuthTerminalState>>,
    > = Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new()));

    // Heartbeat: send Ping every 10s so the parent (Tauri) can detect stale connections.
    tokio::spawn({
        let stdout = Arc::clone(&stdout);
        async move {
            let mut seq: u64 = 0;
            loop {
                tokio::time::sleep(tokio::time::Duration::from_secs(10)).await;
                seq = seq.wrapping_add(1);
                if send_response(
                    &stdout,
                    &MaestroRpcMessage::Response(ServerResponse::Ping { seq }),
                )
                .await
                .is_err()
                {
                    break;
                }
                // Checked on the ping's own clock: a client that has let three of these go by
                // without a word loses its project lock.
                stdout
                    .lock()
                    .await
                    .release_stale(project_locks::STALE_AFTER)
                    .await;
            }
        }
    });

    // Flush diagnostics in the background so they appear even when an arm is blocked mid-await.
    tokio::spawn({
        let stdout = Arc::clone(&stdout);
        async move {
            let mut diag_rx = diag_rx;
            while let Some(payload) = diag_rx.recv().await {
                if send_response(
                    &stdout,
                    &MaestroRpcMessage::Response(ServerResponse::Diagnostic(payload)),
                )
                .await
                .is_err()
                {
                    break;
                }
            }
        }
    });

    let mut liveness_interval = tokio::time::interval(tokio::time::Duration::from_secs(10));
    liveness_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    let mut reap_interval = tokio::time::interval(IDLE_SWEEP);
    reap_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    // Everything before this instant belongs to whatever ran last. An occurrence missed while this
    // machine was off is dropped rather than run late.
    let automations_floor = chrono::Utc::now();
    let mut automations_interval = tokio::time::interval(AUTOMATION_TICK);
    automations_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    loop {
        // A task session left the map, however it went: a slot is free on this machine.
        let used = pipeline_settings::used_slots(&sessions);
        if used < task_slots {
            scheduler::request_all();
        }
        task_slots = used;

        let (msg, route, request_id) = tokio::select! {
            biased;

            msg_result = stdin_msg_rx.recv() => {
                match msg_result {
                    Some(Ok(inbound)) => inbound,
                    Some(Err(e)) => {
                        let is_eof = e.contains("failed to fill whole buffer")
                            || e.contains("early eof")
                            || e.contains("unexpected eof")
                            || e.contains("UnexpectedEof");
                        if is_eof {
                            break;
                        }
                        send_diag("error", format!("stdin framing error: {e}"));
                        if send_response(
                            &stdout,
                            &MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
                                message: format!("read error: {}", e),
                                session_id: None,
                            })),
                        )
                        .await
                        .is_err()
                        {
                            break;
                        }
                        continue;
                    }
                    None => break,
                }
            }

            result = spawn_result_rx.recv() => {
                if let Some((session_id, session)) = result {
                    Box::pin(register_started_session(
                        session_id,
                        session,
                        &mut sessions,
                        &agent_connections,
                        project_store.as_ref(),
                        automation_store.as_ref(),
                        &stdout,
                    ))
                    .await;
                }
                continue;
            }

            settled = settle_rx.recv() => {
                if let Some(settled) = settled {
                    Box::pin(dispatch::settle(
                        settled,
                        &mut sessions,
                        &mut agents_with_spawn,
                        &agent_connections,
                        project_store.as_ref(),
                        automation_store.as_ref(),
                        &mut pending_host_tools,
                    ))
                    .await;
                }
                continue;
            }

            // After `settle_rx`: a start handed over before the question is in the map by the answer.
            asked = async {
                match scheduler_rx.as_mut() {
                    Some(rx) => rx.recv().await,
                    None => std::future::pending().await,
                }
            } => {
                if let Some(reply) = asked {
                    let _ = reply.send(scheduler::Snapshot {
                        used: pipeline_settings::used_slots(&sessions),
                        // Read here, with `used`: a start leaves it only once its session is in.
                        in_flight: task_runner::in_flight(),
                        busy: scheduler::busy_tasks(&sessions),
                        agents: agents_with_spawn.clone(),
                    });
                }
                continue;
            }

            call = async {
                match gateway_rx.as_mut() {
                    Some(rx) => rx.recv().await,
                    // No gateway bound: this arm must never resolve, or the loop spins.
                    None => std::future::pending().await,
                }
            } => {
                if let Some((call, reply_tx)) = call {
                    Box::pin(mcp_gateway::handle_host_tool_call(
                        call,
                        reply_tx,
                        &sessions,
                        project_store.as_ref(),
                        &mut pending_host_tools,
                        &stdout,
                    ))
                    .await;
                }
                continue;
            }

            _ = liveness_interval.tick() => {
                let agents_with_dead: Vec<String> = {
                    let connections = agent_connections.lock().await;
                    connections.iter()
                        .filter(|(_, conn)| conn.connection_task.is_finished())
                        .map(|(id, _)| id.clone())
                        .collect()
                };
                for agent_id in agents_with_dead {
                    Box::pin(handle_agent_restart(
                        agent_id,
                        &agent_connections,
                        &mut sessions,
                        &agents_with_spawn,
                        project_store.as_ref(),
                        &stdout,
                    ))
                    .await;
                }
                // A command loop that ended on a transport error leaves its entry in the map for
                // the host to cancel, and ends deep inside the session where the store is out of
                // reach. Its finished task is what shows here. Repeating it is a no-op.
                if let Some(store) = project_store.as_ref() {
                    for (session_id, session) in sessions.iter() {
                        if session.task.is_finished() {
                            project_store::report(project_store::go_dormant(
                                &*store.lock().await,
                                session_id,
                                chrono::Utc::now(),
                            ));
                        }
                    }
                }
                continue;
            }

            _ = reap_interval.tick() => {
                Box::pin(reap_idle_sessions(
                    &mut sessions,
                    &stdout,
                    automation_store.as_ref(),
                    project_store.as_ref(),
                ))
                .await;
                continue;
            }

            _ = automations_interval.tick() => {
                if let Some(store) = automation_store.as_ref() {
                    Box::pin(automation_runner::tick(
                        store,
                        automations_floor,
                        automation_runner::Spawner {
                            agents_with_spawn: &mut agents_with_spawn,
                            agent_connections: &agent_connections,
                            stdout: &stdout,
                            spawn_result_tx: &spawn_result_tx,
                        },
                    ))
                    .await;
                    Box::pin(automation_runner::drain_webhook_queues(
                        store,
                        automation_runner::Spawner {
                            agents_with_spawn: &mut agents_with_spawn,
                            agent_connections: &agent_connections,
                            stdout: &stdout,
                            spawn_result_tx: &spawn_result_tx,
                        },
                    ))
                    .await;
                }
                continue;
            }

            ended = turn_rx.recv() => {
                let Some(ended) = ended else { continue };
                // A task session the daemon prompted before adopting it: held until it is.
                let ended = if sessions.contains_key(&ended.session_id) {
                    ended
                } else {
                    match task_runner::hold_turn_end(ended) {
                        Some(ended) => ended,
                        None => continue,
                    }
                };
                // A task's session: resolve the turn and start the next stage, off the loop.
                let ending = sessions.get(&ended.session_id);
                let task_binding = ending.and_then(task_turn::task_of);
                let role = ending.and_then(task_turn::role_of);
                if let (Some(store), Some((project_path, task_id))) =
                    (project_store.as_ref(), task_binding)
                {
                    task_turn::spawn(
                        task_turn::Driver {
                            store: Arc::clone(store),
                            agent_connections: Arc::clone(&agent_connections),
                            settle_tx: settle_tx.clone(),
                            stdout: Arc::clone(&stdout),
                            agents: agents_with_spawn.clone(),
                        },
                        project_path,
                        task_id,
                        role,
                        ended.stop_reason.clone(),
                        ended.facts.clone(),
                    );
                }
                if let Some(store) = automation_store.as_ref() {
                    Box::pin(automation_runner::finish_for_session(store, &stdout, ended)).await;
                    Box::pin(automation_runner::drain_webhook_queues(
                        store,
                        automation_runner::Spawner {
                            agents_with_spawn: &mut agents_with_spawn,
                            agent_connections: &agent_connections,
                            stdout: &stdout,
                            spawn_result_tx: &spawn_result_tx,
                        },
                    ))
                    .await;
                }
                continue;
            }

            fired = fire_rx.recv() => {
                if let (Some(fired), Some(store)) = (fired, automation_store.as_ref()) {
                    let started = Box::pin(automation_runner::start(
                        store,
                        &fired.automation_id,
                        maestro_protocol::RunTrigger::Webhook,
                        Some(fired.payload),
                        automation_runner::Spawner {
                            agents_with_spawn: &mut agents_with_spawn,
                            agent_connections: &agent_connections,
                            stdout: &stdout,
                            spawn_result_tx: &spawn_result_tx,
                        },
                    ))
                    .await;
                    if fired.reply.send(started).is_err() {
                        send_diag("debug", "[webhook] the request gave up before its run opened");
                    }
                }
                continue;
            }
        };

        let reply_sink =
            client_sink::ClientSink::for_request(route.as_ref().unwrap_or(&stdout), request_id)
                .await;
        // Boxed: inlined, its state machine sits in this loop's future on the main thread's stack,
        // which a debug build on Windows (1 MB) overflows.
        if !Box::pin(dispatch_message(
            msg,
            &mut sessions,
            &agent_connections,
            &mut agents_with_spawn,
            &reply_sink,
            &spawn_result_tx,
            &settle_tx,
            &auth_terminals,
            &mut pending_host_tools,
            automation_store.as_ref(),
            project_store.as_ref(),
        ))
        .await
        {
            break;
        }
    }

    // Nothing is live past this point. The rows stay open, so the sessions reload afterwards.
    if let Some(store) = project_store.as_ref() {
        // A session blocked on a prompt is mid-turn too, so this covers both.
        let live_turns: Vec<String> = sessions
            .iter()
            .filter(|(_, session)| {
                session
                    .turn_active
                    .load(std::sync::atomic::Ordering::SeqCst)
            })
            .map(|(id, _)| id.clone())
            .collect();
        project_store::report(project_store::note_live_turns(
            &*store.lock().await,
            &live_turns,
        ));
        project_store::report(project_store::all_dormant(
            &*store.lock().await,
            chrono::Utc::now(),
        ));
    }

    // Abort all active session tasks so agent child processes are killed promptly.
    for (_id, session) in sessions.drain() {
        session.task.abort();
        if let Some(c) = session.cleanup {
            c.router.unregister(&c.acp_session_id).await;
        }
    }
    // Drop all pool entries (kills agent subprocesses via _shutdown_tx drop).
    agent_connections.lock().await.clear();

    Ok(())
}
