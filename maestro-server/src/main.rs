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
mod session;
mod sessions;
mod skills;
mod terminal;
mod tool_check;
mod tool_config;
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
type MsgRx = tokio::sync::mpsc::Receiver<Result<MaestroRpcMessage, String>>;

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
    let (stdin_msg_tx, mut stdin_msg_rx) =
        tokio::sync::mpsc::channel::<Result<MaestroRpcMessage, String>>(4);
    tokio::task::spawn_blocking(move || {
        let stdin = std::io::stdin();
        let mut locked = stdin.lock();
        loop {
            match maestro_protocol::read_message_sync(&mut locked) {
                Ok(msg) => {
                    if stdin_msg_tx.blocking_send(Ok(msg)).is_err() {
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
        Some(Ok(msg)) => msg,
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
    let (msg_tx, msg_rx) = tokio::sync::mpsc::channel::<Result<MaestroRpcMessage, String>>(4);

    tokio::spawn({
        let sink = Arc::clone(&sink);
        async move {
            let token = Arc::new(token);
            let attach_gate = Arc::new(tokio::sync::Mutex::new(()));
            let mut clients = tokio::task::JoinSet::new();
            loop {
                tokio::select! {
                    accepted = listener.accept() => {
                        let Ok((stream, _)) = accepted else {
                            continue;
                        };
                        let (token, sink, msg_tx, attach_gate) = (
                            Arc::clone(&token),
                            Arc::clone(&sink),
                            msg_tx.clone(),
                            Arc::clone(&attach_gate),
                        );
                        clients.spawn(async move {
                            daemon::serve_client(stream, &token, &sink, &msg_tx, &attach_gate).await
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
        if let Some(cleanup) = session.cleanup {
            cleanup.router.unregister(&cleanup.acp_session_id).await;
        }
        send_diag(
            "info",
            format!("[reap] closed idle session={session_id} with no client attached"),
        );
        // Only now: the agent held files open under its workspace for as long as the session
        // lived, and on Windows a removal while it does simply fails.
        if let Some(store) = automation_store {
            automation_runner::settle_worktree_for_session(store, stdout, &session_id).await;
        }
    }
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

    // After the runs above are closed out, so a workspace left by a server that died mid-run is
    // evaluated rather than sitting there for ever.
    if let Some(store) = automation_store.as_ref() {
        automation_runner::sweep_worktrees(store, &stdout).await;
        automation_runner::apply_all_retention(store).await;
        webhook::restart(store).await;
    }

    // Agent discovery (which::which PATH scanning) runs after the handshake so the client does not
    // time out waiting on slow PATH scans on Windows.
    let registry: AcpRegistry = tokio::task::spawn_blocking(agent::load_registry)
        .await
        .unwrap_or_else(|_| agent::load_registry());

    // After the handshake so a client of the wrong protocol version never opens a listener, and
    // before the first session so `mcp_servers_for` has an address to inject.
    let mut gateway_rx = mcp_gateway::start().await;
    let mut pending_host_tools = mcp_gateway::PendingHostTools::new();

    let mut agents_with_spawn: Vec<agent::registry::DiscoveredAgentWithSpawn> =
        agent::discover_agents(&registry);
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
        let msg = tokio::select! {
            biased;

            msg_result = stdin_msg_rx.recv() => {
                match msg_result {
                    Some(Ok(msg)) => msg,
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
                    sessions.insert(session_id.clone(), session);
                    // Only now can a client adopt it: `ListLiveSessions` answers from this map. An
                    // automation's run is announced again here, carrying the session, so a window
                    // already attached picks up a session it did not start.
                    if let Some(store) = automation_store.as_ref() {
                        automation_runner::announce_session(store, &stdout, &session_id).await;
                    }
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
                    mcp_gateway::handle_host_tool_call(
                        call,
                        reply_tx,
                        &sessions,
                        &mut pending_host_tools,
                        &stdout,
                    )
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
                    handle_agent_restart(
                        agent_id,
                        &agent_connections,
                        &mut sessions,
                        &agents_with_spawn,
                        &stdout,
                    )
                    .await;
                }
                continue;
            }

            _ = reap_interval.tick() => {
                reap_idle_sessions(&mut sessions, &stdout, automation_store.as_ref()).await;
                continue;
            }

            _ = automations_interval.tick() => {
                if let Some(store) = automation_store.as_ref() {
                    automation_runner::tick(
                        store,
                        automations_floor,
                        automation_runner::Spawner {
                            agents_with_spawn: &mut agents_with_spawn,
                            agent_connections: &agent_connections,
                            stdout: &stdout,
                            spawn_result_tx: &spawn_result_tx,
                        },
                    )
                    .await;
                    automation_runner::drain_webhook_queues(
                        store,
                        automation_runner::Spawner {
                            agents_with_spawn: &mut agents_with_spawn,
                            agent_connections: &agent_connections,
                            stdout: &stdout,
                            spawn_result_tx: &spawn_result_tx,
                        },
                    )
                    .await;
                }
                continue;
            }

            ended = turn_rx.recv() => {
                if let (Some(ended), Some(store)) = (ended, automation_store.as_ref()) {
                    automation_runner::finish_for_session(store, &stdout, ended).await;
                    automation_runner::drain_webhook_queues(
                        store,
                        automation_runner::Spawner {
                            agents_with_spawn: &mut agents_with_spawn,
                            agent_connections: &agent_connections,
                            stdout: &stdout,
                            spawn_result_tx: &spawn_result_tx,
                        },
                    )
                    .await;
                }
                continue;
            }

            fired = fire_rx.recv() => {
                if let (Some(fired), Some(store)) = (fired, automation_store.as_ref()) {
                    let started = automation_runner::start(
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
                    )
                    .await;
                    if fired.reply.send(started).is_err() {
                        send_diag("debug", "[webhook] the request gave up before its run opened");
                    }
                }
                continue;
            }
        };

        if !dispatch_message(
            msg,
            &mut sessions,
            &agent_connections,
            &mut agents_with_spawn,
            &stdout,
            &spawn_result_tx,
            &auth_terminals,
            &mut pending_host_tools,
            automation_store.as_ref(),
        )
        .await
        {
            break;
        }
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
