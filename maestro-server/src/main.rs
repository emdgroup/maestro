//! Maestro Remote Server
//!
//! Headless binary that runs on remote SSH hosts. Receives MaestroRpcMessage
//! commands from the local Maestro desktop app over stdin/stdout (piped through
//! SSH exec channel), spawns ACP agents as local subprocesses, and forwards
//! structured session updates back.
//!
//! Architecture: Adapted from Zed's remote_server (GPL-3.0).

mod agent;
mod client;
mod sessions;

#[cfg(test)]
mod tests;

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use maestro_protocol::{
    read_message, ErrorResponse, ListAgentsResponse, MaestroRpcMessage, ServerRequest,
    ServerResponse, SpawnResponse,
};
use tokio_util::compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt};
use agent_client_protocol::{self as acp, Agent};

use client::{send_response, MaestroServerClient};
use sessions::{ActiveSession, SessionMap};

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let local = tokio::task::LocalSet::new();
    local.run_until(async {
        // stdin/stdout MUST be created inside run_until (Pitfall 2: tokio IO on current_thread)
        let stdout: Rc<tokio::sync::Mutex<tokio::io::Stdout>> =
            Rc::new(tokio::sync::Mutex::new(tokio::io::stdout()));
        let mut stdin = tokio::io::stdin();
        let mut sessions: SessionMap = HashMap::new();
        // Map from session_id -> MaestroServerClient (for permission dispatch)
        let mut client_refs: HashMap<String, Rc<MaestroServerClient>> = HashMap::new();

        loop {
            let msg = match read_message(&mut stdin).await {
                Ok(msg) => msg,
                Err(e) => {
                    // stdin closed (Tauri host exited) — exit cleanly.
                    // tokio read_exact returns io::ErrorKind::UnexpectedEof with message "early eof"
                    // when the write end of the pipe closes; check both the kind and string variants.
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
                    // Write error and continue
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
                MaestroRpcMessage::Request(ServerRequest::ListAgents(req)) => {
                    let mut available_agent_ids = Vec::new();
                    for entry in &req.agents {
                        let ok = tokio::process::Command::new("which")
                            .arg(&entry.check_cmd)
                            .stdout(std::process::Stdio::null())
                            .stderr(std::process::Stdio::null())
                            .status()
                            .await
                            .map(|s| s.success())
                            .unwrap_or(false);
                        if ok {
                            available_agent_ids.push(entry.id.clone());
                        }
                    }
                    let _ = send_response(
                        &stdout,
                        &MaestroRpcMessage::Response(ServerResponse::ListAgentsOk(
                            ListAgentsResponse { available_agent_ids },
                        )),
                    )
                    .await;
                }

                MaestroRpcMessage::Request(ServerRequest::Spawn(req)) => {
                    // 1. Spawn agent subprocess
                    let mut child =
                        match agent::spawn_agent_subprocess(&req.cmd, &req.args, &req.cwd).await {
                            Ok(c) => c,
                            Err(e) => {
                                let _ = send_response(
                                    &stdout,
                                    &MaestroRpcMessage::Response(ServerResponse::Error(
                                        ErrorResponse { message: e },
                                    )),
                                )
                                .await;
                                continue;
                            }
                        };

                    // 2. Bridge subprocess stdio to futures::io via compat()
                    let child_stdin = child
                        .stdin
                        .take()
                        .expect("child stdin must be piped");
                    let child_stdout = child
                        .stdout
                        .take()
                        .expect("child stdout must be piped");
                    let outgoing = child_stdin.compat_write();
                    let incoming = child_stdout.compat();

                    // 3. Create MaestroServerClient for this session
                    let terminals = Rc::new(RefCell::new(HashMap::new()));
                    let server_client = Rc::new(MaestroServerClient::new(
                        Rc::clone(&stdout),
                        req.session_id.clone(),
                        Rc::clone(&terminals),
                    ));

                    // 4. Create ClientSideConnection
                    let (conn, handle_io) = acp::ClientSideConnection::new(
                        Rc::clone(&server_client),
                        outgoing,
                        incoming,
                        |fut| {
                            tokio::task::spawn_local(fut);
                        },
                    );

                    // 5. Start I/O task BEFORE calling initialize
                    tokio::task::spawn_local(async move {
                        if let Err(_e) = handle_io.await {
                            // ACP I/O loop ended (agent exited or error)
                            // This is expected on session end; nothing to do
                        }
                    });

                    // 6. Initialize ACP connection
                    match conn
                        .initialize(
                            acp::InitializeRequest::new(acp::ProtocolVersion::V1)
                                .client_info(acp::Implementation::new("maestro-server", "0.1.0"))
                                .client_capabilities(acp::ClientCapabilities::new().terminal(true)),
                        )
                        .await
                    {
                        Ok(_init_resp) => {}
                        Err(e) => {
                            let _ = send_response(
                                &stdout,
                                &MaestroRpcMessage::Response(ServerResponse::Error(
                                    ErrorResponse {
                                        message: format!("ACP initialize failed: {}", e),
                                    },
                                )),
                            )
                            .await;
                            continue;
                        }
                    }

                    // 7. Create new ACP session
                    let acp_session_id = match conn
                        .new_session(acp::NewSessionRequest::new(
                            std::path::PathBuf::from(&req.cwd),
                        ))
                        .await
                    {
                        Ok(resp) => resp.session_id,
                        Err(e) => {
                            let _ = send_response(
                                &stdout,
                                &MaestroRpcMessage::Response(ServerResponse::Error(
                                    ErrorResponse {
                                        message: format!("ACP new_session failed: {}", e),
                                    },
                                )),
                            )
                            .await;
                            continue;
                        }
                    };

                    // 8. Store session
                    client_refs.insert(req.session_id.clone(), server_client);
                    sessions.insert(
                        req.session_id.clone(),
                        ActiveSession {
                            conn: Rc::new(conn),
                            acp_session_id,
                            terminals,
                            child,
                        },
                    );

                    // 9. Write SpawnOk
                    let _ = send_response(
                        &stdout,
                        &MaestroRpcMessage::Response(ServerResponse::SpawnOk(SpawnResponse {
                            session_id: req.session_id,
                        })),
                    )
                    .await;
                }

                MaestroRpcMessage::Request(ServerRequest::Prompt(req)) => {
                    if let Some(session) = sessions.get(&req.session_id) {
                        let acp_session_id = session.acp_session_id.clone();
                        let prompt_req = acp::PromptRequest::new(
                            acp_session_id,
                            vec![acp::ContentBlock::Text(acp::TextContent::new(req.content))],
                        );
                        // Spawn prompt as a separate task so the stdin loop keeps running.
                        // Required: while prompt() awaits, the agent may send a permission
                        // request that needs a PermitResponse from stdin — if we block here,
                        // that response can never arrive (deadlock).
                        let conn = Rc::clone(&session.conn);
                        let stdout2 = Rc::clone(&stdout);
                        let session_id = req.session_id.clone();
                        tokio::task::spawn_local(async move {
                            if let Err(e) = conn.prompt(prompt_req).await {
                                let _ = send_response(
                                    &stdout2,
                                    &MaestroRpcMessage::Response(ServerResponse::Error(
                                        ErrorResponse {
                                            message: format!(
                                                "prompt failed for session {}: {}",
                                                session_id, e
                                            ),
                                        },
                                    )),
                                )
                                .await;
                            }
                        });
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
                    // Drop session — this kills the agent subprocess via kill_on_drop
                    client_refs.remove(&req.session_id);
                    sessions.remove(&req.session_id);
                    // No response needed for cancel — session is gone
                }

                MaestroRpcMessage::Request(ServerRequest::PermitResponse(perm_resp)) => {
                    // Dispatch to the correct MaestroServerClient's pending_permissions
                    if let Some(client) = client_refs.get(&perm_resp.session_id) {
                        if let Some(tx) = client
                            .pending_permissions
                            .borrow_mut()
                            .remove(&perm_resp.request_id)
                        {
                            // client.rs constructs the outcome using the agent's actual option_id
                            let _ = tx.send(perm_resp.allowed);
                        }
                    }
                }

                // Ignore Response messages on stdin (wrong direction)
                MaestroRpcMessage::Response(_) => {}
            }
        }

        Ok::<(), Box<dyn std::error::Error>>(())
    })
    .await
}
