use std::collections::HashMap;
use std::sync::Arc;

use agent_client_protocol as acp;
use acp::schema::{
    CreateTerminalRequest, CreateTerminalResponse, KillTerminalRequest, KillTerminalResponse,
    LoadSessionRequest, NewSessionRequest, ReleaseTerminalRequest, ReleaseTerminalResponse,
    RequestPermissionRequest, RequestPermissionResponse, SessionNotification,
    TerminalExitStatus, TerminalOutputRequest, TerminalOutputResponse,
    WaitForTerminalExitRequest, WaitForTerminalExitResponse,
};
use maestro_protocol::{
    ErrorResponse, MaestroRpcMessage, PromptCapabilitiesInfo, ServerResponse,
    SessionModeState as ProtocolSessionModeState,
    SessionModelState as ProtocolSessionModelState,
};
use tokio::sync::{oneshot, Mutex};

use crate::send_response;
use crate::sessions::ActiveSession;
use super::command_loop::{
    AgentBootstrap, bootstrap_agent_transport, build_initialize_request, convert_acp_models,
    convert_acp_modes, extract_prompt_capabilities, models_from_config_options,
    modes_from_config_options, run_command_loop,
};
use super::handlers::configure_acp_builder;

pub(crate) struct SpawnResult {
    pub(crate) session: ActiveSession,
    pub(crate) models: Option<ProtocolSessionModelState>,
    pub(crate) modes: Option<ProtocolSessionModeState>,
    pub(crate) prompt_capabilities: PromptCapabilitiesInfo,
    pub(crate) supports_session_list: bool,
    pub(crate) supports_session_load: bool,
    pub(crate) supports_session_close: bool,
    pub(crate) acp_session_id: String,
}

pub(crate) async fn spawn_acp_session(
    spawn_cmd: &str,
    spawn_args: &[String],
    spawn_env: &HashMap<String, String>,
    cwd: &str,
    maestro_session_id: String,
    stdout: Arc<Mutex<tokio::io::Stdout>>,
) -> Option<SpawnResult> {
    let Some(boot) = bootstrap_agent_transport(spawn_cmd, spawn_args, spawn_env, cwd, maestro_session_id, Arc::clone(&stdout)).await else {
        return None;
    };
    let AgentBootstrap { child, transport, cmd_tx, cmd_rx, pending_permissions, pending_elicitations, session_state, handlers, terms, so, sid, cwd_owned } = boot;
    let router = Arc::clone(&handlers.router);

    let (ready_tx, ready_rx) = oneshot::channel::<Result<(Option<ProtocolSessionModelState>, Option<ProtocolSessionModeState>, PromptCapabilitiesInfo, bool, bool, bool, String), String>>();

    let task = tokio::spawn(async move {
        let _result = configure_acp_builder!(handlers, terms)
            .connect_with(transport, async move |cx: acp::ConnectionTo<acp::Agent>| {
                let init_response = match cx.send_request(build_initialize_request()).block_task().await {
                    Ok(resp) => resp,
                    Err(e) => {
                        let _ = ready_tx.send(Err(format!("ACP initialize failed: {}", e)));
                        return Ok(());
                    }
                };
                let prompt_caps = extract_prompt_capabilities(&init_response);
                let supports_list = init_response.agent_capabilities.session_capabilities.list.is_some();
                let supports_load = init_response.agent_capabilities.load_session;
                let supports_close = supports_list;

                let session_req = NewSessionRequest::new(std::path::PathBuf::from(&cwd_owned));
                let session_response = match cx.send_request(session_req).block_task().await {
                    Ok(r) => r,
                    Err(e) => {
                        let _ = ready_tx.send(Err(format!("ACP new_session failed: {}", e)));
                        return Ok(());
                    }
                };
                let models = convert_acp_models(session_response.models.as_ref());
                let modes = convert_acp_modes(session_response.modes.as_ref());
                let session = match cx.attach_session(session_response, vec![]) {
                    Ok(s) => s,
                    Err(e) => {
                        let _ = ready_tx.send(Err(format!("ACP attach_session failed: {}", e)));
                        return Ok(());
                    }
                };
                let acp_native_session_id = session.session_id().to_string();
                router.register(acp_native_session_id.clone(), sid.clone(), session_state).await;
                let _ = ready_tx.send(Ok((models, modes, prompt_caps, supports_list, supports_load, supports_close, acp_native_session_id)));
                run_command_loop(cmd_rx, session.connection().clone(), session.session_id().clone(), so, sid, None).await;
                Ok(())
            })
            .await;
        drop(child);
    });

    match ready_rx.await {
        Ok(Ok((models, modes, prompt_caps, supports_list, supports_load, supports_close, native_session_id))) => Some(SpawnResult {
            session: ActiveSession { cmd_tx, pending_permissions, pending_elicitations, task, cleanup: None },
            models,
            modes,
            prompt_capabilities: prompt_caps,
            supports_session_list: supports_list,
            supports_session_load: supports_load,
            supports_session_close: supports_close,
            acp_session_id: native_session_id,
        }),
        Ok(Err(e)) => {
            let _ = send_response(&stdout, &MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse { message: e }))).await;
            None
        }
        Err(_) => {
            let _ = send_response(&stdout, &MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
                message: "ACP connection task exited unexpectedly".to_string(),
            }))).await;
            None
        }
    }
}

pub(crate) async fn load_acp_session(
    spawn_cmd: &str,
    spawn_args: &[String],
    spawn_env: &HashMap<String, String>,
    cwd: &str,
    acp_session_id: String,
    maestro_session_id: String,
    stdout: Arc<Mutex<tokio::io::Stdout>>,
) -> Option<(ActiveSession, Option<ProtocolSessionModelState>, Option<ProtocolSessionModeState>, PromptCapabilitiesInfo)> {
    let Some(boot) = bootstrap_agent_transport(spawn_cmd, spawn_args, spawn_env, cwd, maestro_session_id.clone(), Arc::clone(&stdout)).await else {
        return None;
    };
    let AgentBootstrap { child, transport, cmd_tx, cmd_rx, pending_permissions, pending_elicitations, session_state, handlers, terms, so, sid, cwd_owned } = boot;
    let router = Arc::clone(&handlers.router);

    let load_sid = acp_session_id.clone();
    let (ready_tx, ready_rx) = oneshot::channel::<Result<(Option<ProtocolSessionModelState>, Option<ProtocolSessionModeState>, PromptCapabilitiesInfo), String>>();

    // Register the route before spawning — we already know the ACP session ID for a load.
    router.register(acp_session_id.clone(), maestro_session_id, session_state).await;

    let task = tokio::spawn(async move {
        let _result = configure_acp_builder!(handlers, terms)
            .connect_with(transport, async move |cx: acp::ConnectionTo<acp::Agent>| {
                let init_response = match cx.send_request(build_initialize_request()).block_task().await {
                    Ok(resp) => resp,
                    Err(e) => {
                        let _ = ready_tx.send(Err(format!("ACP initialize failed: {}", e)));
                        return Ok(());
                    }
                };
                let prompt_caps = extract_prompt_capabilities(&init_response);

                let load_req = LoadSessionRequest::new(load_sid.clone(), std::path::PathBuf::from(&cwd_owned));
                let load_response = match cx.send_request(load_req).block_task().await {
                    Ok(r) => r,
                    Err(e) => {
                        let _ = ready_tx.send(Err(format!("ACP session/load failed: {}", e)));
                        return Ok(());
                    }
                };
                let models = convert_acp_models(load_response.models.as_ref())
                    .or_else(|| load_response.config_options.as_deref().and_then(models_from_config_options));
                let modes = load_response.config_options.as_deref()
                    .and_then(modes_from_config_options)
                    .or_else(|| convert_acp_modes(load_response.modes.as_ref()));
                let _ = ready_tx.send(Ok((models, modes, prompt_caps)));
                run_command_loop(cmd_rx, cx, acp::schema::SessionId::new(load_sid), so, sid, None).await;
                Ok(())
            })
            .await;
        drop(child);
    });

    match ready_rx.await {
        Ok(Ok((models, modes, prompt_caps))) => Some((
            ActiveSession { cmd_tx, pending_permissions, pending_elicitations, task, cleanup: None },
            models,
            modes,
            prompt_caps,
        )),
        Ok(Err(e)) => {
            let _ = send_response(&stdout, &MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse { message: e }))).await;
            None
        }
        Err(_) => {
            let _ = send_response(&stdout, &MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
                message: "ACP load connection task exited unexpectedly".to_string(),
            }))).await;
            None
        }
    }
}
