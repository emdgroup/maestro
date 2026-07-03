use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use agent_client_protocol as acp;
use acp::schema::v1::{
    CreateTerminalRequest, CreateTerminalResponse, PermissionOptionId,
    RequestPermissionOutcome, RequestPermissionRequest, RequestPermissionResponse,
    SelectedPermissionOutcome, SessionNotification,
};
use agent_client_protocol_schema::v1::{CreateElicitationRequest, CreateElicitationResponse};
use maestro_protocol::{
    ElicitationRequest as MaestroElicitationRequest, MaestroRpcMessage,
    PermissionRequest as MaestroPermissionRequest, ServerResponse, SessionUpdate,
};
use tokio::sync::{oneshot, Mutex};

use crate::send_response;
use crate::sessions::{SessionRouter, TerminalHandle};
use crate::terminal::handle_create_terminal;

/// Shared state for ACP connection handlers, routable across N sessions.
#[derive(Clone)]
pub(crate) struct ConnectionHandlers {
    pub router: Arc<SessionRouter>,
    pub terminals: Arc<Mutex<HashMap<String, TerminalHandle>>>,
    pub terminal_counter: Arc<AtomicU64>,
    pub stdout: Arc<Mutex<tokio::io::Stdout>>,
    pub elicit_counter: Arc<AtomicU64>,
}

macro_rules! configure_acp_builder {
    ($handlers:expr, $terms:expr) => {{
        let _h = $handlers;
        let _terms = $terms;
        acp::Client
            .builder()
            .name("maestro-server")
            .on_receive_request(
                {
                    let h = _h.clone();
                    move |request: RequestPermissionRequest, responder: acp::Responder<RequestPermissionResponse>, cx: acp::ConnectionTo<acp::Agent>| {
                        let h = h.clone();
                        async move { h.handle_permission(request, responder, cx).await }
                    }
                },
                acp::on_receive_request!(),
            )
            .on_receive_notification(
                {
                    let h = _h.clone();
                    move |notification: SessionNotification, _cx: acp::ConnectionTo<acp::Agent>| {
                        let h = h.clone();
                        async move { h.handle_notification(notification).await }
                    }
                },
                acp::on_receive_notification!(),
            )
            .on_receive_request(
                {
                    let h = _h.clone();
                    move |request: CreateTerminalRequest, responder: acp::Responder<CreateTerminalResponse>, _cx: acp::ConnectionTo<acp::Agent>| {
                        let h = h.clone();
                        async move { h.handle_create_terminal(request, responder).await }
                    }
                },
                acp::on_receive_request!(),
            )
            .on_receive_request(
                {
                    let terms = Arc::clone(&_terms);
                    move |request: TerminalOutputRequest, responder: acp::Responder<TerminalOutputResponse>, _cx: acp::ConnectionTo<acp::Agent>| {
                        let terms = terms.clone();
                        async move {
                            let terminal_id_str = request.terminal_id.to_string();
                            let terminals = terms.lock().await;
                            let handle = terminals.get(&terminal_id_str).ok_or_else(|| {
                                acp::Error::new(-32603, "unknown terminal")
                            })?;
                            let output = handle.output_buf.lock().await.clone();
                            let truncated = handle
                                .output_byte_limit
                                .map(|limit| output.len() >= limit as usize)
                                .unwrap_or(false);
                            let exit_status =
                                handle.exit_status.lock().await.as_ref().map(|info| {
                                    TerminalExitStatus::new()
                                        .exit_code(info.exit_code)
                                        .signal(info.signal.clone())
                                });
                            responder.respond(
                                TerminalOutputResponse::new(output, truncated)
                                    .exit_status(exit_status),
                            )
                        }
                    }
                },
                acp::on_receive_request!(),
            )
            .on_receive_request(
                {
                    let terms = Arc::clone(&_terms);
                    move |request: ReleaseTerminalRequest, responder: acp::Responder<ReleaseTerminalResponse>, _cx: acp::ConnectionTo<acp::Agent>| {
                        let terms = terms.clone();
                        async move {
                            let terminal_id_str = request.terminal_id.to_string();
                            terms.lock().await.remove(&terminal_id_str);
                            responder.respond(ReleaseTerminalResponse::new())
                        }
                    }
                },
                acp::on_receive_request!(),
            )
            .on_receive_request(
                {
                    let terms = Arc::clone(&_terms);
                    move |request: WaitForTerminalExitRequest, responder: acp::Responder<WaitForTerminalExitResponse>, cx: acp::ConnectionTo<acp::Agent>| {
                        let terms = terms.clone();
                        async move {
                            let terminal_id_str = request.terminal_id.to_string();
                            let maybe_arcs = {
                                let terminals = terms.lock().await;
                                terminals.get(&terminal_id_str).map(|h| {
                                    (Arc::clone(&h.exit_status), Arc::clone(&h.exit_notify))
                                })
                            };
                            let (exit_status_arc, exit_notify_arc) = match maybe_arcs {
                                None => return responder.respond(WaitForTerminalExitResponse::new(TerminalExitStatus::new())),
                                Some(arcs) => arcs,
                            };
                            {
                                let info = exit_status_arc.lock().await;
                                if let Some(exit_info) = info.as_ref() {
                                    let status = TerminalExitStatus::new()
                                        .exit_code(exit_info.exit_code)
                                        .signal(exit_info.signal.clone());
                                    return responder.respond(WaitForTerminalExitResponse::new(status));
                                }
                            }
                            cx.spawn(async move {
                                loop {
                                    exit_notify_arc.notified().await;
                                    let info = exit_status_arc.lock().await;
                                    if let Some(exit_info) = info.as_ref() {
                                        let status = TerminalExitStatus::new()
                                            .exit_code(exit_info.exit_code)
                                            .signal(exit_info.signal.clone());
                                        let _ = responder.respond(WaitForTerminalExitResponse::new(status));
                                        return Ok(());
                                    }
                                }
                            })?;
                            Ok(())
                        }
                    }
                },
                acp::on_receive_request!(),
            )
            .on_receive_request(
                {
                    let terms = Arc::clone(&_terms);
                    move |request: KillTerminalRequest, responder: acp::Responder<KillTerminalResponse>, _cx: acp::ConnectionTo<acp::Agent>| {
                        let terms = terms.clone();
                        async move {
                            let terminal_id_str = request.terminal_id.to_string();
                            let mut terminals = terms.lock().await;
                            if let Some(handle) = terminals.get_mut(&terminal_id_str) {
                                if let Some(tx) = handle.kill_tx.lock().await.take() {
                                    let _ = tx.send(());
                                }
                            }
                            responder.respond(KillTerminalResponse::new())
                        }
                    }
                },
                acp::on_receive_request!(),
            )
            .on_receive_request(
                {
                    let h = _h.clone();
                    move |request: acp::UntypedMessage, responder: acp::Responder<serde_json::Value>, cx: acp::ConnectionTo<acp::Agent>| {
                        let h = h.clone();
                        async move { h.handle_elicitation(request, responder, cx).await }
                    }
                },
                acp::on_receive_request!(),
            )
    }};
}

pub(crate) use configure_acp_builder;

impl ConnectionHandlers {
    pub fn new(stdout: Arc<Mutex<tokio::io::Stdout>>) -> (Self, Arc<SessionRouter>) {
        let router = Arc::new(SessionRouter::default());
        let handlers = Self {
            router: Arc::clone(&router),
            terminals: Arc::new(Mutex::new(HashMap::new())),
            terminal_counter: Arc::new(AtomicU64::new(0)),
            stdout,
            elicit_counter: Arc::new(AtomicU64::new(0)),
        };
        (handlers, router)
    }

    pub async fn handle_permission(
        &self,
        request: RequestPermissionRequest,
        responder: acp::Responder<RequestPermissionResponse>,
        cx: acp::ConnectionTo<acp::Agent>,
    ) -> acp::Result<()> {
        let acp_sid = request.session_id.to_string();
        let (maestro_sid, state) = self
            .router
            .get_session(&acp_sid)
            .await
            .ok_or_else(|| acp::Error::new(-32603, format!("unknown session: {acp_sid}")))?;

        let request_id = request.tool_call.tool_call_id.to_string();
        let (tx, rx) = oneshot::channel::<Option<String>>();

        let payload = serde_json::to_value(&request)
            .map_err(|e| acp::Error::new(-32603, e.to_string()))?;
        let msg = MaestroRpcMessage::Response(ServerResponse::PermissionRequest(
            MaestroPermissionRequest {
                session_id: maestro_sid,
                request_id: request_id.clone(),
                payload,
            },
        ));
        // Insert tx after send_response: single-threaded runtime guarantees no PermitResponse
        // can arrive between these two awaits, so there is no race.
        send_response(&self.stdout, &msg)
            .await
            .map_err(|e| acp::Error::new(-32603, e.to_string()))?;
        state.pending_permissions.lock().await.insert(request_id, tx);

        cx.spawn(async move {
            let outcome = match rx.await {
                Ok(Some(id)) => RequestPermissionOutcome::Selected(
                    SelectedPermissionOutcome::new(PermissionOptionId::new(id)),
                ),
                Ok(None) | Err(_) => RequestPermissionOutcome::Cancelled,
            };
            let _ = responder.respond(RequestPermissionResponse::new(outcome));
            Ok(())
        })?;
        Ok(())
    }

    pub async fn handle_notification(
        &self,
        notification: SessionNotification,
    ) -> acp::Result<()> {
        let acp_sid = notification.session_id.to_string();
        let maestro_sid = self
            .router
            .get_maestro_id(&acp_sid)
            .await
            .ok_or_else(|| acp::Error::new(-32603, format!("unknown session: {acp_sid}")))?;

        let payload = serde_json::to_value(&notification.update)
            .map_err(|e| acp::Error::new(-32603, e.to_string()))?;
        let msg = MaestroRpcMessage::Response(ServerResponse::SessionUpdate(SessionUpdate {
            session_id: maestro_sid,
            payload,
        }));
        send_response(&self.stdout, &msg)
            .await
            .map_err(|e| acp::Error::new(-32603, e.to_string()))?;
        Ok(())
    }

    pub async fn handle_create_terminal(
        &self,
        request: CreateTerminalRequest,
        responder: acp::Responder<CreateTerminalResponse>,
    ) -> acp::Result<()> {
        let acp_sid = request.session_id.to_string();
        let maestro_sid = self
            .router
            .get_maestro_id(&acp_sid)
            .await
            .ok_or_else(|| acp::Error::new(-32603, format!("unknown session: {acp_sid}")))?;

        let resp = handle_create_terminal(
            request,
            Arc::clone(&self.terminals),
            Arc::clone(&self.terminal_counter),
            Arc::clone(&self.stdout),
            maestro_sid,
        )
        .await?;
        responder.respond(resp)
    }

    pub async fn handle_elicitation(
        &self,
        request: acp::UntypedMessage,
        responder: acp::Responder<serde_json::Value>,
        cx: acp::ConnectionTo<acp::Agent>,
    ) -> acp::Result<()> {
        if request.method() != "elicitation/create" {
            return responder.respond_with_error(
                acp::Error::method_not_found().data(request.method().to_string()),
            );
        }
        let elicitation: CreateElicitationRequest =
            serde_json::from_value(request.params().clone())
                .map_err(|e| acp::Error::new(-32602, format!("invalid elicitation request: {e}")))?;

        let acp_sid = match elicitation.scope() {
            agent_client_protocol_schema::v1::ElicitationScope::Session(scope) => {
                scope.session_id.to_string()
            }
            _ => {
                return responder.respond_with_error(acp::Error::new(
                    -32603,
                    "non-session elicitation scope not supported",
                ))
            }
        };
        let (maestro_sid, state) = self
            .router
            .get_session(&acp_sid)
            .await
            .ok_or_else(|| acp::Error::new(-32603, format!("unknown session: {acp_sid}")))?;

        let request_id = format!(
            "elicit-{}",
            self.elicit_counter.fetch_add(1, Ordering::Relaxed) + 1
        );
        let (tx, rx) = oneshot::channel::<serde_json::Value>();

        let payload = request.params().clone();
        let msg = MaestroRpcMessage::Response(ServerResponse::ElicitationRequest(
            MaestroElicitationRequest {
                session_id: maestro_sid,
                request_id: request_id.clone(),
                message: elicitation.message,
                payload,
            },
        ));
        // Insert tx after send_response: single-threaded runtime guarantees no ElicitationResponse
        // can arrive between these two awaits, so there is no race.
        send_response(&self.stdout, &msg)
            .await
            .map_err(|e| acp::Error::new(-32603, e.to_string()))?;
        state.pending_elicitations.lock().await.insert(request_id, tx);

        cx.spawn(async move {
            let response = match rx.await {
                Ok(r) => r,
                Err(_) => {
                    let _ = responder.respond_with_error(acp::Error::new(-32603, "elicitation channel closed"));
                    return Ok(());
                }
            };
            match serde_json::from_value::<CreateElicitationResponse>(response.clone()) {
                Ok(_) => { let _ = responder.respond(response); }
                Err(e) => {
                    let _ = responder.respond_with_error(acp::Error::new(-32603, format!("invalid elicitation response: {e}")));
                }
            }
            Ok(())
        })?;
        Ok(())
    }
}
