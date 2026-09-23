//! Loopback gateway from the per-session MCP shims back into the running server.
//!
//! Each shim (`maestro mcp`, see `mcp_stdio`) opens one short-lived TCP connection per tool call.
//! The listener is bound to `127.0.0.1` only and every request carries a token minted at startup
//! and handed to the shim as an environment variable on its `McpServerStdio` entry — any other
//! local process can connect, so the token is what decides whether it is answered.
//!
//! Canvas calls are answered here: they are session updates, and the server already owns that
//! channel. Everything else is forwarded to Tauri as a `HostToolCall` and parked in
//! `PendingHostTools` until the matching `HostToolResult` comes back.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;

use maestro_protocol::{
    GatewayRequest, HostToolCall, HostToolResult, MaestroRpcMessage, ServerResponse, SessionUpdate,
};
use tokio::sync::{mpsc, oneshot};

use crate::helpers::send_response;
use crate::send_diag;
use crate::sessions::SessionMap;

/// A call waiting for an answer, and where to send it.
pub(crate) type GatewayItem = (HostToolCall, oneshot::Sender<HostToolResult>);

/// Host-bound calls in flight, keyed by the id the server assigned them. The session id is kept
/// alongside the sender so `Cancel` can fail everything a closing session was waiting on.
pub(crate) type PendingHostTools = HashMap<String, (String, oneshot::Sender<HostToolResult>)>;

/// Port and token of the running gateway, once it has bound. `None` if binding failed, in which
/// case no `maestro` MCP server is injected and sessions run without canvas or task tools.
static GATEWAY: OnceLock<(u16, String)> = OnceLock::new();

/// How long a shim gets to send its request after connecting.
const READ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);
/// How long the host gets to answer before the call is failed.
const HOST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(90);

pub(crate) fn gateway_address() -> Option<&'static (u16, String)> {
    GATEWAY.get()
}

/// Bind the gateway and start accepting. Returns the channel the main loop reads calls from.
pub(crate) async fn start() -> Option<mpsc::Receiver<GatewayItem>> {
    let listener = match tokio::net::TcpListener::bind(("127.0.0.1", 0)).await {
        Ok(listener) => listener,
        Err(e) => {
            send_diag(
                "warn",
                format!("[mcp] cannot bind the MCP gateway, canvas and task tools are off: {e}"),
            );
            return None;
        }
    };
    let port = match listener.local_addr() {
        Ok(addr) => addr.port(),
        Err(e) => {
            send_diag(
                "warn",
                format!("[mcp] cannot read the gateway address: {e}"),
            );
            return None;
        }
    };
    let token = uuid::Uuid::new_v4().to_string();
    if GATEWAY.set((port, token.clone())).is_err() {
        return None;
    }

    let (tx, rx) = mpsc::channel::<GatewayItem>(16);
    tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                break;
            };
            let tx = tx.clone();
            let token = token.clone();
            tokio::spawn(async move {
                serve_connection(stream, token, tx).await;
            });
        }
    });
    send_diag(
        "info",
        format!("[mcp] gateway listening on 127.0.0.1:{port}"),
    );
    Some(rx)
}

async fn serve_connection(
    mut stream: tokio::net::TcpStream,
    token: String,
    tx: mpsc::Sender<GatewayItem>,
) {
    let request = match tokio::time::timeout(
        READ_TIMEOUT,
        maestro_protocol::read_frame::<_, GatewayRequest>(&mut stream),
    )
    .await
    {
        Ok(Ok(request)) => request,
        Ok(Err(e)) => {
            send_diag("warn", format!("[mcp] unreadable gateway request: {e}"));
            return;
        }
        Err(_) => {
            send_diag("warn", "[mcp] gateway request timed out before it arrived");
            return;
        }
    };

    if request.token != token {
        send_diag(
            "warn",
            format!(
                "[mcp] rejected a gateway request for {:?} with a bad token",
                request.call.name
            ),
        );
        reply(&mut stream, fail(&request.call, "unauthorized")).await;
        return;
    }

    let call = request.call;
    let (reply_tx, reply_rx) = oneshot::channel::<HostToolResult>();
    if tx.send((call.clone(), reply_tx)).await.is_err() {
        reply(&mut stream, fail(&call, "Maestro is shutting down")).await;
        return;
    }

    let result = match tokio::time::timeout(HOST_TIMEOUT, reply_rx).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => fail(&call, "Maestro dropped the call"),
        Err(_) => fail(&call, "host did not answer"),
    };
    reply(&mut stream, result).await;
}

async fn reply(stream: &mut tokio::net::TcpStream, result: HostToolResult) {
    if let Err(e) = maestro_protocol::write_frame(stream, &result).await {
        send_diag("warn", format!("[mcp] cannot answer the shim: {e}"));
    }
}

fn fail(call: &HostToolCall, message: &str) -> HostToolResult {
    HostToolResult {
        session_id: call.session_id.clone(),
        request_id: call.request_id.clone(),
        result: serde_json::Value::Null,
        error: Some(message.to_string()),
    }
}

/// Answer a call from a shim, or park it until the host answers.
pub(crate) async fn handle_host_tool_call(
    call: HostToolCall,
    reply_tx: oneshot::Sender<HostToolResult>,
    sessions: &SessionMap,
    pending_host_tools: &mut PendingHostTools,
    stdout: &crate::ClientOut,
) {
    // Not "no longer open": the shim is handed its session id while `session/new` is still in
    // flight, so an id absent from the map may be one that has not been registered yet.
    if !sessions.contains_key(&call.session_id) {
        let _ = reply_tx.send(fail(&call, "no Maestro session with this id is open"));
        return;
    }

    // A canvas call is a session update — the server owns that channel, so the surface is drawn
    // from here. It is *also* forwarded to the host below, whose answer carries back whatever the
    // frame has failed at; the agent never sees its own surface and this is the only way it hears.
    if crate::mcp_stdio::is_canvas_tool(&call.name) {
        let payload = crate::mcp_stdio::canvas_payload(&call.name, &call.arguments);
        if let Err(e) = send_response(
            stdout,
            &MaestroRpcMessage::Response(ServerResponse::SessionUpdate(SessionUpdate {
                session_id: call.session_id.clone(),
                payload,
            })),
        )
        .await
        {
            let _ = reply_tx.send(fail(&call, &format!("cannot reach Maestro: {e}")));
            return;
        }
    }

    static NEXT_ID: AtomicU64 = AtomicU64::new(0);
    let request_id = format!("host-{}", NEXT_ID.fetch_add(1, Ordering::Relaxed));
    let forwarded = HostToolCall {
        session_id: call.session_id.clone(),
        request_id: request_id.clone(),
        name: call.name.clone(),
        arguments: call.arguments.clone(),
    };
    if let Err(e) = send_response(
        stdout,
        &MaestroRpcMessage::Response(ServerResponse::HostToolCall(forwarded)),
    )
    .await
    {
        let _ = reply_tx.send(fail(&call, &format!("cannot reach Maestro: {e}")));
        return;
    }
    pending_host_tools.insert(request_id, (call.session_id, reply_tx));
}

/// Fail every call a closing session was waiting on, so its shim is not left hanging.
pub(crate) fn cancel_session(pending_host_tools: &mut PendingHostTools, session_id: &str) {
    let ids: Vec<String> = pending_host_tools
        .iter()
        .filter(|(_, (session, _))| session == session_id)
        .map(|(id, _)| id.clone())
        .collect();
    for id in ids {
        if let Some((session, sender)) = pending_host_tools.remove(&id) {
            let _ = sender.send(HostToolResult {
                session_id: session,
                request_id: id,
                result: serde_json::Value::Null,
                error: Some("session closed".to_string()),
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pending_with(
        entries: &[(&str, &str)],
    ) -> (PendingHostTools, Vec<oneshot::Receiver<HostToolResult>>) {
        let mut pending = PendingHostTools::new();
        let mut receivers = Vec::new();
        for (request_id, session_id) in entries {
            let (tx, rx) = oneshot::channel();
            pending.insert((*request_id).to_string(), ((*session_id).to_string(), tx));
            receivers.push(rx);
        }
        (pending, receivers)
    }

    #[tokio::test]
    async fn cancel_fails_only_the_closing_session() {
        let (mut pending, mut receivers) =
            pending_with(&[("host-0", "session-1"), ("host-1", "session-2")]);
        cancel_session(&mut pending, "session-1");

        assert_eq!(pending.len(), 1);
        assert!(pending.contains_key("host-1"));
        let failed = receivers.remove(0).await.unwrap();
        assert_eq!(failed.error.as_deref(), Some("session closed"));
        // The surviving call is still waiting, not answered.
        assert!(receivers[0].try_recv().is_err());
    }
}
