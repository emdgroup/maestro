//! Authenticating an agent, and the interactive terminal some agents need to do it.
//!
//! Split out of `dispatch_message`, where these five arms were a third of a 1135-line match.
//! Nothing here is shared with the rest of dispatch beyond the connection map and stdout, so the
//! only thing that separation cost was the `send_or_return!` macro, which is spelled out.
//!
//! Every path that can block offloads onto its own task. The authentication window is 300 seconds
//! and the dispatch loop is what carries `PermitResponse` and terminal input, so a handler that
//! awaited an agent's reply inline would stop answering the very messages the user needs to
//! complete the sign-in.

use std::sync::Arc;

use maestro_protocol::{
    AuthTerminalExitResponse, ErrorResponse, MaestroRpcMessage, ServerResponse,
};
use tokio::sync::Mutex;

use crate::agent;
use crate::command_ext::NoConsoleWindow;
use crate::helpers::{resolve_agent_spawn_params, send_diag, send_response};
use crate::sessions::SharedAgentConnections;

/// How long the user has to finish signing in before the attempt is abandoned.
const AUTH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300);

/// The live half of an auth terminal: how to kill it, and how to type into it.
pub(crate) struct AuthTerminalState {
    pub kill_tx: tokio::sync::oneshot::Sender<()>,
    pub input_tx: tokio::sync::mpsc::Sender<Vec<u8>>,
}

pub(crate) type AuthTerminals =
    Arc<tokio::sync::Mutex<std::collections::HashMap<String, AuthTerminalState>>>;

type Stdout = Arc<Mutex<tokio::io::Stdout>>;

fn error_response(message: String) -> MaestroRpcMessage {
    MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
        message,
        session_id: None,
    }))
}

/// Run an agent's authentication method, either as a subprocess or over the ACP connection.
///
/// Returns `false` only when stdout is broken, which is the caller's signal to stop.
pub(crate) async fn authenticate(
    req: maestro_protocol::AuthenticateRequest,
    agent_connections: &SharedAgentConnections,
    agents_with_spawn: &[agent::registry::DiscoveredAgentWithSpawn],
    stdout: &Stdout,
) -> bool {
    let (conn_opt, auth_methods) = {
        let conns = agent_connections.lock().await;
        match conns.get(&req.agent_id) {
            Some(c) => (
                Some(c.connection.clone()),
                c.capabilities.auth_methods.clone(),
            ),
            None => (None, Vec::new()),
        }
    };
    let Some(conn) = conn_opt else {
        return send_response(
            stdout,
            &error_response(format!("agent '{}' not found", req.agent_id)),
        )
        .await
        .is_ok();
    };

    let method = auth_methods.into_iter().find(|m| m.id == req.method_id);
    if method.as_ref().map(|m| m.method_type.as_str()) == Some("terminal") {
        let Some(method) = method else {
            return true;
        };
        // Resolved before offloading: `agents_with_spawn` is borrowed from the dispatch loop and
        // cannot be moved into the task, and the lookup is an in-memory list search anyway.
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
        tokio::spawn(async move {
            let mut child_cmd = tokio::process::Command::new(&spawn_cmd);
            child_cmd
                .args(&spawn_args)
                .args(&method.args)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .no_console_window();
            if req.force_no_browser {
                child_cmd.env("NO_BROWSER", "1");
            }
            let mut child = match child_cmd.spawn() {
                Ok(c) => c,
                Err(e) => {
                    send_response(
                        &stdout_task,
                        &error_response(format!("failed to spawn auth command: {}", e)),
                    )
                    .await
                    .ok();
                    return;
                }
            };
            // The auth command talks to the user through its own output, which has nowhere to go
            // in a windowless subprocess — forwarded as diagnostics so it reaches the host's log.
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
            let response = match tokio::time::timeout(AUTH_TIMEOUT, child.wait()).await {
                Ok(Ok(status)) if status.success() => {
                    MaestroRpcMessage::Response(ServerResponse::AuthenticateOk)
                }
                Ok(Ok(status)) => {
                    error_response(format!("auth command exited with {:?}", status.code()))
                }
                Ok(Err(e)) => error_response(format!("auth command error: {}", e)),
                Err(_) => {
                    child.kill().await.ok();
                    error_response("authentication timed out".to_string())
                }
            };
            send_response(&stdout_task, &response).await.ok();
        });
    } else {
        use agent_client_protocol_schema::v1::{AuthMethodId, AuthenticateRequest};
        let stdout_task = Arc::clone(stdout);
        tokio::spawn(async move {
            let result = tokio::time::timeout(
                AUTH_TIMEOUT,
                conn.send_request(AuthenticateRequest::new(AuthMethodId::new(
                    req.method_id.as_str(),
                )))
                .block_task(),
            )
            .await;
            let response = match result {
                Ok(Ok(_)) => MaestroRpcMessage::Response(ServerResponse::AuthenticateOk),
                Ok(Err(e)) => error_response(format!("authenticate failed: {}", e)),
                Err(_) => error_response("authentication timed out".to_string()),
            };
            send_response(&stdout_task, &response).await.ok();
        });
    }
    true
}

/// Start an auth flow that needs a terminal, wiring its pipes to the host as terminal frames.
pub(crate) async fn spawn_auth_terminal(
    req: maestro_protocol::SpawnAuthTerminalRequest,
    agent_connections: &SharedAgentConnections,
    agents_with_spawn: &[agent::registry::DiscoveredAgentWithSpawn],
    auth_terminals: &AuthTerminals,
    stdout: &Stdout,
) -> bool {
    let auth_methods = {
        let conns = agent_connections.lock().await;
        conns
            .get(&req.agent_id)
            .map(|c| c.capabilities.auth_methods.clone())
            .unwrap_or_default()
    };
    let Some(method) = auth_methods.into_iter().find(|m| m.id == req.method_id) else {
        return send_response(
            stdout,
            &error_response(format!(
                "auth method '{}' not found for agent '{}'",
                req.method_id, req.agent_id
            )),
        )
        .await
        .is_ok();
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
    let all_args: Vec<String> = spawn_args.into_iter().chain(method.args).collect();
    let stdout_task = Arc::clone(stdout);
    let auth_terminals_task = Arc::clone(auth_terminals);
    let agent_connections_task = Arc::clone(agent_connections);
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
            .env("TERM", "xterm-256color")
            .no_console_window();
        let mut child = match child_cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                send_response(
                    &stdout_task,
                    &error_response(format!("failed to spawn auth terminal: {}", e)),
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
        auth_terminals_task
            .lock()
            .await
            .insert(terminal_id.clone(), AuthTerminalState { kill_tx, input_tx });

        forward_pipe_as_terminal_output(
            child_stdout,
            Arc::clone(&stdout_task),
            session_id.clone(),
            terminal_id.clone(),
        );
        forward_pipe_as_terminal_output(
            child_stderr,
            Arc::clone(&stdout_task),
            session_id,
            terminal_id.clone(),
        );

        if let Some(mut stdin_pipe) = child_stdin {
            tokio::spawn(async move {
                while let Some(data) = input_rx.recv().await {
                    if stdin_pipe.write_all(&data).await.is_err() {
                        break;
                    }
                }
            });
        }

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
        // Evict the old agent connection on successful auth so the next Spawn
        // starts a fresh process that reads the newly written credentials from disk.
        if exit_code == Some(0) {
            agent_connections_task.lock().await.remove(&agent_id);
        }
        send_response(
            &stdout_task,
            &MaestroRpcMessage::Response(ServerResponse::AuthTerminalExit(
                AuthTerminalExitResponse {
                    terminal_id,
                    agent_id,
                    exit_code,
                },
            )),
        )
        .await
        .ok();
    });
    true
}

/// Relay one of the child's output pipes to the host as `TerminalOutput` frames.
///
/// One function for stdout and stderr because the terminal shows them interleaved anyway: they
/// carry the same terminal id and the user is reading one stream.
fn forward_pipe_as_terminal_output<R>(
    pipe: R,
    stdout: Stdout,
    session_id: String,
    terminal_id: String,
) where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        use tokio::io::AsyncReadExt;
        let mut reader = pipe;
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    send_response(
                        &stdout,
                        &MaestroRpcMessage::Response(ServerResponse::TerminalOutput(
                            maestro_protocol::TerminalOutput {
                                session_id: session_id.clone(),
                                terminal_id: terminal_id.clone(),
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
}

pub(crate) async fn kill_auth_terminal(
    req: maestro_protocol::KillAuthTerminalRequest,
    auth_terminals: &AuthTerminals,
) {
    if let Some(state) = auth_terminals.lock().await.remove(&req.terminal_id) {
        // The receiver is gone only if the terminal task already exited, which is the same
        // outcome this asks for.
        state.kill_tx.send(()).ok();
    }
}

pub(crate) async fn auth_terminal_input(
    req: maestro_protocol::AuthTerminalInputRequest,
    auth_terminals: &AuthTerminals,
) {
    let tx = auth_terminals
        .lock()
        .await
        .get(&req.terminal_id)
        .map(|s| s.input_tx.clone());
    if let Some(tx) = tx {
        tx.send(req.data).await.ok();
    }
}

/// Sign the agent out, over its ACP connection.
pub(crate) async fn logout(
    req: maestro_protocol::LogoutRequest,
    agent_connections: &SharedAgentConnections,
    stdout: &Stdout,
) -> bool {
    let conn_handle = {
        let conns = agent_connections.lock().await;
        conns.get(&req.agent_id).map(|c| c.connection.clone())
    };
    let Some(conn) = conn_handle else {
        return send_response(
            stdout,
            &error_response(format!("agent '{}' not found", req.agent_id)),
        )
        .await
        .is_ok();
    };
    use agent_client_protocol_schema::v1::LogoutRequest;
    let stdout_task = Arc::clone(stdout);
    tokio::spawn(async move {
        let response = match conn.send_request(LogoutRequest::new()).block_task().await {
            Ok(_) => MaestroRpcMessage::Response(ServerResponse::LogoutOk),
            Err(e) => error_response(format!("logout failed: {}", e)),
        };
        send_response(&stdout_task, &response).await.ok();
    });
    true
}
