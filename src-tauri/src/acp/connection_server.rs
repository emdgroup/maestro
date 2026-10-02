//! Connection server management: spawn and query the shared per-connection maestro-server process.

use crate::acp::reader_task::spawn_shared_reader_task;
use crate::acp::session_types::{ConnectionServer, PendingRequests, TransportTarget};
use crate::acp::transport::{
    CheckToolsRequest, CheckToolsResponse, ListAgentsRequest, PreInitializeRequest,
    PreInitializeResponse, ServerRequest, ServerResponse, SessionCloseRequest,
    SessionDeleteRequest, SessionListOkResponse,
};
#[cfg(windows)]
use crate::acp::transport_setup::open_wsl_transport;
use crate::acp::transport_setup::{
    open_local_transport, open_remote_transport, spawn_stdin_writer_task,
};
use crate::acp::transport_types::{serialize_message, serialize_message_with_id};
use maestro_protocol::{
    DetectInstalledAgentsRequest, DetectInstalledAgentsResponse, DetectProjectAgentsRequest,
    DetectProjectAgentsResponse, InstallSkillsRequest, InstallSkillsResponse, RequestId, SkillFile,
};
use std::sync::atomic::AtomicU64;
use std::sync::Arc;
use tokio::sync::oneshot;

/// Builds the closure `query_via_server` uses to take the one reply a request expects out of
/// whatever came back under its id.
macro_rules! reply {
    ($pattern:pat => $value:expr) => {
        |response| match response {
            $pattern => Some($value),
            _ => None,
        }
    };
}
pub(crate) use reply;

pub(crate) const UNEXPECTED_REPLY: &str = "The server answered with a reply of another type";

async fn connection_handles(
    connection_key: crate::acp::ConnectionKey,
    app_state: &crate::core::AppState,
    not_found_err: &str,
) -> Result<(tokio::sync::mpsc::Sender<Vec<u8>>, PendingRequests), String> {
    let servers = app_state.acp.connection_servers.lock().await;
    let server = servers
        .get(&connection_key)
        .ok_or_else(|| not_found_err.to_string())?;
    Ok((server.writer_tx.clone(), server.pending.clone()))
}

/// Send a registered request under its id and wait for whatever the server answers it with.
async fn await_reply(
    writer_tx: &tokio::sync::mpsc::Sender<Vec<u8>>,
    pending: &PendingRequests,
    id: RequestId,
    receiver: oneshot::Receiver<Result<ServerResponse, String>>,
    request: &ServerRequest,
    timeout_secs: u64,
    timeout_err: &str,
) -> Result<ServerResponse, String> {
    let sent = match serialize_message_with_id(Some(id), request) {
        Ok(bytes) => writer_tx
            .send(bytes)
            .await
            .map_err(|_| "Connection server writer channel closed".to_string()),
        Err(e) => Err(e),
    };
    if let Err(e) = sent {
        pending.forget(id);
        return Err(e);
    }
    match tokio::time::timeout(std::time::Duration::from_secs(timeout_secs), receiver).await {
        Err(_) => {
            pending.forget(id);
            Err(timeout_err.to_string())
        }
        Ok(inner) => inner.map_err(|_| "Response channel dropped".to_string())?,
    }
}

/// Send `request` through the connection's server and return the reply carrying its id.
///
/// `session_id` names the session a request is made for when the request itself cannot, so that
/// an error scoped to that session fails it rather than leaving it to time out.
pub(crate) async fn request_via_server(
    connection_key: crate::acp::ConnectionKey,
    app_state: &crate::core::AppState,
    not_found_err: &str,
    session_id: Option<&str>,
    request: ServerRequest,
    timeout_secs: u64,
    timeout_err: &str,
) -> Result<ServerResponse, String> {
    let (writer_tx, pending) = connection_handles(connection_key, app_state, not_found_err).await?;
    let (id, receiver) = pending.register(session_id);
    await_reply(
        &writer_tx,
        &pending,
        id,
        receiver,
        &request,
        timeout_secs,
        timeout_err,
    )
    .await
}

pub(crate) async fn query_via_server<T>(
    connection_key: crate::acp::ConnectionKey,
    app_state: &crate::core::AppState,
    not_found_err: &str,
    request: ServerRequest,
    extract: impl FnOnce(ServerResponse) -> Option<T>,
    timeout_secs: u64,
    timeout_err: &str,
) -> Result<T, String> {
    let response = request_via_server(
        connection_key,
        app_state,
        not_found_err,
        None,
        request,
        timeout_secs,
        timeout_err,
    )
    .await?;
    extract(response).ok_or_else(|| UNEXPECTED_REPLY.to_string())
}

/// Ask the daemon of the project's connection about its tasks, worktrees or reviews.
///
/// `request` is handed the project's path as this app knows it; the daemon canonicalizes it, and
/// keys every row by that path, so replies carry the canonical one rather than `project_id`.
pub(crate) async fn query_project_store<T>(
    app_state: &Arc<crate::core::AppState>,
    project_id: i32,
    request: impl FnOnce(String) -> ServerRequest,
    extract: impl FnOnce(ServerResponse) -> Option<T>,
) -> Result<T, String> {
    let (connection_key, project_path) =
        crate::project::automations::target(app_state, project_id).await?;
    query_via_server(
        connection_key,
        app_state,
        &format!("No connection server for connection {:?}", connection_key),
        request(project_path),
        extract,
        15,
        "The project's server did not answer within 15s",
    )
    .await
}

/// Send `ListAgents` through the running connection server and return the result.
/// Much faster than `one_shot_rpc` — reuses the existing process and registry cache.
pub async fn query_list_agents_via_connection_server(
    connection_key: crate::acp::ConnectionKey,
    app_state: &Arc<crate::core::AppState>,
) -> Result<Vec<crate::acp::registry::DiscoveredAgent>, String> {
    let response = query_via_server(
        connection_key,
        app_state,
        &format!("No connection server for connection {:?}", connection_key),
        ServerRequest::ListAgents(ListAgentsRequest {}),
        reply!(ServerResponse::ListAgentsOk(response) => response),
        15,
        "ListAgents via connection server timed out after 15s",
    )
    .await?;
    let agents: Vec<crate::acp::registry::DiscoveredAgent> = response
        .agents
        .into_iter()
        .map(|agent| crate::acp::registry::DiscoveredAgent {
            id: agent.id,
            name: agent.name,
            icon: agent.icon,
            spawn_deps: agent.spawn_deps,
        })
        .collect();
    log::debug!(
        "[registry] ListAgentsOk: {} agents: {:?}",
        agents.len(),
        agents.iter().map(|agent| &agent.id).collect::<Vec<_>>()
    );
    Ok(agents)
}

/// Send a request that has no answer. Fails only when there is no relay to send it through.
pub async fn send_via_server(
    connection_key: crate::acp::ConnectionKey,
    app_state: &Arc<crate::core::AppState>,
    request: ServerRequest,
) -> Result<(), String> {
    let writer_tx = app_state
        .acp
        .connection_servers
        .lock()
        .await
        .get(&connection_key)
        .map(|server| server.writer_tx.clone())
        .ok_or_else(|| format!("No connection server for connection {:?}", connection_key))?;
    writer_tx
        .send(serialize_message(&request)?)
        .await
        .map_err(|_| "Connection server writer channel closed".to_string())
}

pub async fn query_acquire_project_lock_via_server(
    connection_key: crate::acp::ConnectionKey,
    request: maestro_protocol::AcquireProjectLockRequest,
    app_state: &Arc<crate::core::AppState>,
) -> Result<maestro_protocol::AcquireProjectLockResponse, String> {
    query_via_server(
        connection_key,
        app_state,
        &format!("No connection server for connection {:?}", connection_key),
        ServerRequest::AcquireProjectLock(request),
        reply!(ServerResponse::AcquireProjectLockOk(response) => response),
        15,
        "AcquireProjectLock via connection server timed out after 15s",
    )
    .await
}

pub async fn query_project_locks_via_server(
    connection_key: crate::acp::ConnectionKey,
    project_paths: Vec<String>,
    app_state: &Arc<crate::core::AppState>,
) -> Result<maestro_protocol::ListProjectLocksResponse, String> {
    query_via_server(
        connection_key,
        app_state,
        &format!("No connection server for connection {:?}", connection_key),
        ServerRequest::ListProjectLocks(maestro_protocol::ListProjectLocksRequest {
            project_paths,
        }),
        reply!(ServerResponse::ProjectLocksOk(response) => response),
        15,
        "ListProjectLocks via connection server timed out after 15s",
    )
    .await
}

/// Fifteen seconds: the server gives the holder ten to answer before deciding for it.
pub async fn query_takeover_via_server(
    connection_key: crate::acp::ConnectionKey,
    request: maestro_protocol::AcquireProjectLockRequest,
    app_state: &Arc<crate::core::AppState>,
) -> Result<bool, String> {
    let (writer_tx, pending) = connection_handles(
        connection_key,
        app_state,
        &format!("No connection server for connection {:?}", connection_key),
    )
    .await?;
    let (id, receiver) = pending.register(None);
    if !pending.claim_takeover(id) {
        pending.forget(id);
        return Err("A takeover is already in progress".to_string());
    }
    let response = await_reply(
        &writer_tx,
        &pending,
        id,
        receiver,
        &ServerRequest::RequestTakeover(request),
        15,
        "The takeover request timed out after 15s",
    )
    .await?;
    match response {
        ServerResponse::TakeoverResultOk(result) => Ok(result.granted),
        _ => Err(UNEXPECTED_REPLY.to_string()),
    }
}

/// Ask every server this app is connected to to wind down, and forget them.
///
/// Exists for the updater. A resident server holds its own binary open, and Windows will not let
/// the image of a running process be overwritten, so an install that does not do this fails — the
/// same reason the old child-process servers were killed on quit.
///
/// Every running agent session ends with them, which is why nothing calls this without telling the
/// user first. Fire and forget: there is no acknowledgement, and a server that does not hear it
/// leaves the install to fail as it would have anyway.
#[tauri::command]
#[specta::specta]
pub async fn stop_resident_servers(
    app_state: tauri::State<'_, Arc<crate::core::AppState>>,
) -> Result<u32, String> {
    let servers: Vec<_> = {
        let mut servers = app_state.acp.connection_servers.lock().await;
        servers.drain().collect()
    };
    let request = serialize_message(&ServerRequest::Shutdown)?;

    let mut stopped = 0;
    for (connection_key, server) in servers {
        match server.writer_tx.send(request.clone()).await {
            Ok(()) => stopped += 1,
            Err(_) => log::warn!("could not reach the server on {connection_key:?} to stop it"),
        }
    }
    app_state.acp.sessions.lock().await.clear();
    log::info!("asked {stopped} resident server(s) to stop");
    Ok(stopped)
}

/// Every conversation the daemon holds for this project, with the live state of the ones it is
/// running. The path goes as the app knows it; the daemon canonicalizes it.
pub async fn query_project_sessions_via_server(
    connection_key: crate::acp::ConnectionKey,
    project_path: String,
    include_closed: bool,
    app_state: &Arc<crate::core::AppState>,
) -> Result<maestro_protocol::ListProjectSessionsResponse, String> {
    query_via_server(
        connection_key,
        app_state,
        &format!("No connection server for connection {:?}", connection_key),
        ServerRequest::ListProjectSessions(maestro_protocol::ListProjectSessionsRequest {
            project_path,
            include_closed,
        }),
        reply!(ServerResponse::ListProjectSessionsOk(response) => response),
        15,
        "ListProjectSessions via connection server timed out after 15s",
    )
    .await
}

pub async fn query_rename_session_via_server(
    connection_key: crate::acp::ConnectionKey,
    request: maestro_protocol::RenameSessionRequest,
    app_state: &Arc<crate::core::AppState>,
) -> Result<(), String> {
    query_via_server(
        connection_key,
        app_state,
        &format!("No connection server for connection {:?}", connection_key),
        ServerRequest::RenameSession(request),
        reply!(ServerResponse::RenameSessionOk => ()),
        15,
        "RenameSession via connection server timed out after 15s",
    )
    .await
}

/// Close a conversation the daemon is not running, by its key. Sent when its load failed for
/// good, see `reader_task::is_gone_session_error`.
pub async fn query_close_project_session_via_server(
    connection_key: crate::acp::ConnectionKey,
    request: maestro_protocol::CloseProjectSessionRequest,
    app_state: &Arc<crate::core::AppState>,
) -> Result<(), String> {
    query_via_server(
        connection_key,
        app_state,
        &format!("No connection server for connection {:?}", connection_key),
        ServerRequest::CloseProjectSession(request),
        reply!(ServerResponse::CloseProjectSessionOk => ()),
        15,
        "CloseProjectSession via connection server timed out after 15s",
    )
    .await
}

/// Wherever the server keeps this project's automations, ask it for them.
///
/// The path goes as the client knows it and comes back canonicalized: the server is the process on
/// the machine that path exists on, so it is the only one that can resolve it.
pub async fn query_list_automations_via_server(
    connection_key: crate::acp::ConnectionKey,
    project_path: String,
    app_state: &Arc<crate::core::AppState>,
) -> Result<maestro_protocol::ListAutomationsResponse, String> {
    query_via_server(
        connection_key,
        app_state,
        &format!("No connection server for connection {:?}", connection_key),
        ServerRequest::ListAutomations(maestro_protocol::ListAutomationsRequest { project_path }),
        reply!(ServerResponse::ListAutomationsOk(response) => response),
        15,
        "ListAutomations via connection server timed out after 15s",
    )
    .await
}

pub async fn query_save_automation_via_server(
    connection_key: crate::acp::ConnectionKey,
    project_path: String,
    automation: maestro_protocol::Automation,
    app_state: &Arc<crate::core::AppState>,
) -> Result<maestro_protocol::Automation, String> {
    query_via_server(
        connection_key,
        app_state,
        &format!("No connection server for connection {:?}", connection_key),
        ServerRequest::SaveAutomation(maestro_protocol::SaveAutomationRequest {
            project_path,
            automation,
        }),
        reply!(ServerResponse::SaveAutomationOk(response) => response),
        15,
        "SaveAutomation via connection server timed out after 15s",
    )
    .await
}

pub async fn query_delete_automation_via_server(
    connection_key: crate::acp::ConnectionKey,
    automation_id: String,
    app_state: &Arc<crate::core::AppState>,
) -> Result<(), String> {
    query_via_server(
        connection_key,
        app_state,
        &format!("No connection server for connection {:?}", connection_key),
        ServerRequest::DeleteAutomation(maestro_protocol::DeleteAutomationRequest {
            automation_id,
        }),
        reply!(ServerResponse::DeleteAutomationOk => ()),
        15,
        "DeleteAutomation via connection server timed out after 15s",
    )
    .await
}

pub async fn query_delete_automation_run_via_server(
    connection_key: crate::acp::ConnectionKey,
    run_id: String,
    app_state: &Arc<crate::core::AppState>,
) -> Result<(), String> {
    query_via_server(
        connection_key,
        app_state,
        &format!("No connection server for connection {:?}", connection_key),
        ServerRequest::DeleteAutomationRun(maestro_protocol::DeleteAutomationRunRequest { run_id }),
        reply!(ServerResponse::DeleteAutomationRunOk => ()),
        // Removing a worktree is a git process over a whole checkout.
        60,
        "DeleteAutomationRun via connection server timed out after 60s",
    )
    .await
}

pub async fn query_set_run_retention_via_server(
    connection_key: crate::acp::ConnectionKey,
    project_path: String,
    retention: maestro_protocol::RunRetention,
    app_state: &Arc<crate::core::AppState>,
) -> Result<(), String> {
    query_via_server(
        connection_key,
        app_state,
        &format!("No connection server for connection {:?}", connection_key),
        ServerRequest::SetRunRetention(maestro_protocol::SetRunRetentionRequest {
            project_path,
            retention,
        }),
        reply!(ServerResponse::SetRunRetentionOk => ()),
        // Answered after trimming, which removes worktrees.
        60,
        "SetRunRetention via connection server timed out after 60s",
    )
    .await
}

/// Read this machine's webhook listener settings, or change them when `settings` is given. Both
/// answer with the listener's state after the change.
pub async fn query_webhook_settings_via_server(
    connection_key: crate::acp::ConnectionKey,
    settings: Option<maestro_protocol::WebhookSettings>,
    app_state: &Arc<crate::core::AppState>,
) -> Result<maestro_protocol::WebhookStatus, String> {
    query_via_server(
        connection_key,
        app_state,
        &format!("No connection server for connection {:?}", connection_key),
        match settings {
            Some(settings) => ServerRequest::SetWebhookSettings(settings),
            None => ServerRequest::GetWebhookSettings,
        },
        reply!(ServerResponse::WebhookSettingsOk(response) => response),
        15,
        "Webhook settings via connection server timed out after 15s",
    )
    .await
}

/// What the connection's server is, or with `autostart`, set it to start with its machine first.
pub async fn query_server_status_via_server(
    connection_key: crate::acp::ConnectionKey,
    autostart: Option<bool>,
    app_state: &Arc<crate::core::AppState>,
) -> Result<maestro_protocol::ServerStatus, String> {
    query_via_server(
        connection_key,
        app_state,
        &format!("No connection server for connection {:?}", connection_key),
        match autostart {
            Some(enabled) => {
                ServerRequest::SetAutostart(maestro_protocol::SetAutostartRequest { enabled })
            }
            None => ServerRequest::GetServerStatus,
        },
        reply!(ServerResponse::ServerStatusOk(response) => response),
        30,
        "Server status via connection server timed out after 30s",
    )
    .await
}

/// Stop the connection's server, and with it every session and run on it.
///
/// The server is forgotten first, so the reader sees the pipe close as a teardown rather than a
/// lost connection, and the call waits for that close: a project reopened before the old server
/// had gone would attach to it just as it exited.
pub async fn stop_connection_server(
    connection_key: crate::acp::ConnectionKey,
    app_state: &Arc<crate::core::AppState>,
) -> Result<(), String> {
    let server = app_state
        .acp
        .connection_servers
        .lock()
        .await
        .remove(&connection_key)
        .ok_or_else(|| format!("No connection server for connection {:?}", connection_key))?;
    let request = serialize_message(&ServerRequest::Shutdown)?;
    server
        .writer_tx
        .send(request)
        .await
        .map_err(|_| "The server could not be reached to stop it".to_string())?;
    let ended =
        tokio::time::timeout(std::time::Duration::from_secs(20), server.ended.notified()).await;
    if ended.is_err() {
        log::warn!("[acp] server on {connection_key:?} did not close after Shutdown");
    }
    // Dropping it kills a local relay still running, and with it any reconnect it had in mind.
    drop(server);
    Ok(())
}

pub async fn query_roll_webhook_secret_via_server(
    connection_key: crate::acp::ConnectionKey,
    automation_id: String,
    app_state: &Arc<crate::core::AppState>,
) -> Result<maestro_protocol::Automation, String> {
    query_via_server(
        connection_key,
        app_state,
        &format!("No connection server for connection {:?}", connection_key),
        ServerRequest::RollWebhookSecret(maestro_protocol::AutomationIdRequest { automation_id }),
        reply!(ServerResponse::RollWebhookSecretOk(response) => response),
        15,
        "RollWebhookSecret via connection server timed out after 15s",
    )
    .await
}

pub async fn query_webhook_deliveries_via_server(
    connection_key: crate::acp::ConnectionKey,
    automation_id: String,
    app_state: &Arc<crate::core::AppState>,
) -> Result<maestro_protocol::ListWebhookDeliveriesResponse, String> {
    query_via_server(
        connection_key,
        app_state,
        &format!("No connection server for connection {:?}", connection_key),
        ServerRequest::ListWebhookDeliveries(maestro_protocol::AutomationIdRequest {
            automation_id,
        }),
        reply!(ServerResponse::ListWebhookDeliveriesOk(response) => response),
        15,
        "ListWebhookDeliveries via connection server timed out after 15s",
    )
    .await
}

/// Ask the server to start an automation now.
///
/// There is no reply to wait for beyond the request being accepted: the run announces itself on
/// `AutomationRunChanged`, exactly as a scheduled one does.
pub async fn query_run_automation_via_server(
    connection_key: crate::acp::ConnectionKey,
    automation_id: String,
    app_state: &Arc<crate::core::AppState>,
) -> Result<(), String> {
    let writer_tx = {
        let servers = app_state.acp.connection_servers.lock().await;
        servers
            .get(&connection_key)
            .map(|server| server.writer_tx.clone())
            .ok_or_else(|| format!("No connection server for connection {:?}", connection_key))?
    };
    let bytes = serialize_message(&ServerRequest::RunAutomation(
        maestro_protocol::RunAutomationRequest { automation_id },
    ))?;
    writer_tx
        .send(bytes)
        .await
        .map_err(|_| "Connection server writer channel closed".to_string())
}

/// When an expression the user is still typing would next come round.
///
/// Short timeout on purpose: this fires while somebody edits a field, and a preview nobody is
/// waiting for any more is worth less than the editor staying responsive.
pub async fn query_preview_schedule_via_server(
    connection_key: crate::acp::ConnectionKey,
    cron: String,
    timezone: String,
    app_state: &Arc<crate::core::AppState>,
) -> Result<maestro_protocol::PreviewScheduleResponse, String> {
    query_via_server(
        connection_key,
        app_state,
        &format!("No connection server for connection {:?}", connection_key),
        ServerRequest::PreviewSchedule(maestro_protocol::PreviewScheduleRequest { cron, timezone }),
        reply!(ServerResponse::PreviewScheduleOk(response) => response),
        5,
        "PreviewSchedule via connection server timed out after 5s",
    )
    .await
}

pub async fn query_automation_runs_via_server(
    connection_key: crate::acp::ConnectionKey,
    project_path: String,
    limit: Option<u32>,
    app_state: &Arc<crate::core::AppState>,
) -> Result<maestro_protocol::ListAutomationRunsResponse, String> {
    query_via_server(
        connection_key,
        app_state,
        &format!("No connection server for connection {:?}", connection_key),
        ServerRequest::ListAutomationRuns(maestro_protocol::ListAutomationRunsRequest {
            project_path,
            limit,
        }),
        reply!(ServerResponse::ListAutomationRunsOk(response) => response),
        15,
        "ListAutomationRuns via connection server timed out after 15s",
    )
    .await
}

/// Send `SessionList` through the running connection server and return the result.
pub async fn query_session_list_via_server(
    connection_key: crate::acp::ConnectionKey,
    request: crate::acp::transport::SessionListRequest,
    app_state: &Arc<crate::core::AppState>,
) -> Result<SessionListOkResponse, String> {
    query_via_server(
        connection_key,
        app_state,
        "Connection not initialized. Run preflight first.",
        ServerRequest::SessionList(request),
        reply!(ServerResponse::SessionListOk(response) => response),
        30,
        "SessionList via connection server timed out after 30s",
    )
    .await
}

/// Send `SessionDelete` through the running connection server.
pub async fn query_session_delete_via_server(
    connection_key: crate::acp::ConnectionKey,
    request: SessionDeleteRequest,
    app_state: &Arc<crate::core::AppState>,
) -> Result<(), String> {
    query_via_server(
        connection_key,
        app_state,
        "Connection not initialized. Run preflight first.",
        ServerRequest::SessionDelete(request),
        reply!(ServerResponse::SessionDeleteOk => ()),
        30,
        "SessionDelete via connection server timed out after 30s",
    )
    .await
}

/// Send `SessionClose` through the running connection server.
pub async fn query_session_close_via_server(
    connection_key: crate::acp::ConnectionKey,
    request: SessionCloseRequest,
    app_state: &Arc<crate::core::AppState>,
) -> Result<(), String> {
    query_via_server(
        connection_key,
        app_state,
        "Connection not initialized. Run preflight first.",
        ServerRequest::SessionClose(request),
        reply!(ServerResponse::SessionCloseOk => ()),
        30,
        "SessionClose via connection server timed out after 30s",
    )
    .await
}

/// Send `CheckTools` through the running connection server and return the result.
pub async fn query_check_tools_via_server(
    connection_key: crate::acp::ConnectionKey,
    tools: Vec<String>,
    app_state: &Arc<crate::core::AppState>,
) -> Result<CheckToolsResponse, String> {
    query_via_server(
        connection_key,
        app_state,
        "Connection not initialized. Run preflight first.",
        ServerRequest::CheckTools(CheckToolsRequest { tools }),
        reply!(ServerResponse::CheckToolsOk(response) => response),
        15,
        "CheckTools via connection server timed out after 15s",
    )
    .await
}

pub async fn set_tool_path_via_server(
    connection_key: crate::acp::ConnectionKey,
    tool: String,
    path: Option<String>,
    app_state: &Arc<crate::core::AppState>,
) -> Result<maestro_protocol::ToolCheckResult, String> {
    query_via_server(
        connection_key,
        app_state,
        "Connection not initialized. Run preflight first.",
        ServerRequest::SetToolPath(maestro_protocol::SetToolPathRequest { tool, path }),
        reply!(ServerResponse::SetToolPathOk(response) => response),
        15,
        "SetToolPath via connection server timed out after 15s",
    )
    .await
}

pub async fn test_tool_path_via_server(
    connection_key: crate::acp::ConnectionKey,
    tool: String,
    path: String,
    app_state: &Arc<crate::core::AppState>,
) -> Result<maestro_protocol::ToolCheckResult, String> {
    query_via_server(
        connection_key,
        app_state,
        "Connection not initialized. Run preflight first.",
        ServerRequest::TestToolPath(maestro_protocol::TestToolPathRequest { tool, path }),
        reply!(ServerResponse::TestToolPathOk(response) => response),
        15,
        "TestToolPath via connection server timed out after 15s",
    )
    .await
}

/// Send `InstallSkills` through the running connection server and return whether it installed.
///
/// The generous timeout covers the first run on a machine, where `npx` downloads the skills CLI
/// before it can do anything; later runs are a couple of file reads and return immediately.
pub async fn query_install_skills_via_server(
    connection_key: crate::acp::ConnectionKey,
    skills: Vec<SkillFile>,
    app_state: &Arc<crate::core::AppState>,
) -> Result<InstallSkillsResponse, String> {
    query_via_server(
        connection_key,
        app_state,
        "Connection not initialized. Run preflight first.",
        ServerRequest::InstallSkills(InstallSkillsRequest { skills }),
        reply!(ServerResponse::InstallSkillsOk(response) => response),
        150,
        "InstallSkills via connection server timed out after 150s",
    )
    .await
}

/// Send `DetectInstalledAgents` through the running connection server and return the result.
pub async fn query_detect_installed_via_server(
    connection_key: crate::acp::ConnectionKey,
    app_state: &Arc<crate::core::AppState>,
) -> Result<DetectInstalledAgentsResponse, String> {
    let response = query_via_server(
        connection_key,
        app_state,
        "Connection not initialized. Run preflight first.",
        ServerRequest::DetectInstalledAgents(DetectInstalledAgentsRequest {}),
        reply!(ServerResponse::DetectInstalledAgentsOk(response) => response),
        30,
        "DetectInstalledAgents timed out after 30s",
    )
    .await?;
    log::debug!(
        "[registry] DetectInstalledAgentsOk: {:?}",
        response
            .agents
            .iter()
            .map(|agent| &agent.agent_id)
            .collect::<Vec<_>>()
    );
    Ok(response)
}

/// Send `DetectProjectAgents` through the running connection server and return the result.
pub async fn query_detect_project_agents_via_server(
    connection_key: crate::acp::ConnectionKey,
    cwd: String,
    app_state: &Arc<crate::core::AppState>,
) -> Result<DetectProjectAgentsResponse, String> {
    query_via_server(
        connection_key,
        app_state,
        "Connection not initialized. Run preflight first.",
        ServerRequest::DetectProjectAgents(DetectProjectAgentsRequest { cwd }),
        reply!(ServerResponse::DetectProjectAgentsOk(response) => response),
        15,
        "DetectProjectAgents timed out after 15s",
    )
    .await
}

/// Spawn a long-lived maestro-server shared across all sessions for `connection_id`.
/// Idempotent — returns `Ok(())` if already running.
/// Uses `TransportTarget` to handle both local subprocess and remote SSH exec channel.
pub async fn spawn_connection_server(
    connection_key: crate::acp::ConnectionKey,
    target: TransportTarget<'_>,
    app_state: &Arc<crate::core::AppState>,
) -> Result<(), String> {
    {
        let servers = app_state.acp.connection_servers.lock().await;
        if servers.contains_key(&connection_key) {
            return Ok(());
        }
    }

    log::debug!("[acp] spawning connection server for {connection_key:?}");

    // Taken, not read: the user agreed to replace what was running this once.
    let replace = app_state
        .acp
        .replace_server
        .lock()
        .is_ok_and(|mut keys| keys.remove(&connection_key));

    // Commands run through a second process started from the same binary. Record where it lives
    // while we have the resolved path — the command call sites are free functions with no
    // `AppHandle` to deploy or locate it themselves.
    {
        use crate::connectivity::exec_channel::{remember_server_path, ExecHost};
        match &target {
            // Local commands spawn directly, so there is no channel to locate a server for.
            TransportTarget::Local => {}
            TransportTarget::Remote { ssh, server_path } => {
                remember_server_path(ExecHost::Ssh(ssh.connection_id()), server_path);
            }
            #[cfg(windows)]
            TransportTarget::Wsl {
                distro,
                server_path,
            } => {
                remember_server_path(ExecHost::Wsl((*distro).to_string()), server_path);
            }
            TransportTarget::Docker {
                container_name,
                server_path,
                ..
            } => {
                remember_server_path(ExecHost::Docker((*container_name).to_string()), server_path);
            }
        }
    }

    let (write_tx, source, child) = match target {
        TransportTarget::Local => {
            let (stdin_writer, source, child) = open_local_transport(app_state, replace).await?;
            (spawn_stdin_writer_task(stdin_writer), source, Some(child))
        }
        TransportTarget::Remote { ssh, server_path } => {
            let (write_tx, source) = open_remote_transport(ssh, server_path, replace).await?;
            (write_tx, source, None)
        }
        #[cfg(windows)]
        TransportTarget::Wsl {
            distro,
            server_path,
        } => {
            let (stdin_writer, source, child) =
                open_wsl_transport(distro, server_path, replace).await?;
            (spawn_stdin_writer_task(stdin_writer), source, Some(child))
        }
        TransportTarget::Docker {
            cli,
            container_name,
            server_path,
        } => {
            let (stdin_writer, source, child) =
                crate::acp::transport_setup::open_container_transport(
                    cli,
                    container_name,
                    server_path,
                    replace,
                )
                .await?;
            (spawn_stdin_writer_task(stdin_writer), source, Some(child))
        }
    };

    let pending = PendingRequests::default();
    let last_ping_at = Arc::new(AtomicU64::new(0));
    let writer_tx_for_reader = write_tx.clone();
    let ended = Arc::new(tokio::sync::Notify::new());

    let connection_server = ConnectionServer {
        child,
        writer_tx: write_tx,
        pending: pending.clone(),
        last_ping_at: Arc::clone(&last_ping_at),
        ended: Arc::clone(&ended),
    };

    // Re-check under lock to avoid double-spawn race.
    {
        let mut servers = app_state.acp.connection_servers.lock().await;
        if servers.contains_key(&connection_key) {
            return Ok(());
        }
        servers.insert(connection_key, connection_server);
    }

    spawn_shared_reader_task(
        source,
        connection_key,
        last_ping_at,
        writer_tx_for_reader,
        app_state.app_handle.clone(),
        Arc::clone(app_state),
        pending,
        ended,
    );

    // A new relay is a new client to the daemon, which knows nothing of what the old one held.
    tokio::spawn(crate::project::lock::reacquire(
        Arc::clone(app_state),
        connection_key,
    ));

    Ok(())
}

/// Send a `PreInitialize` request on the connection's shared maestro-server and wait
/// for the `PreInitializeOk` response (or an error). The connection server must be
/// running before calling this (use `spawn_connection_server` first).
pub async fn pre_initialize_via_connection_server(
    connection_key: crate::acp::ConnectionKey,
    agent_id: &str,
    cwd: &str,
    app_state: &Arc<crate::core::AppState>,
) -> Result<PreInitializeResponse, String> {
    query_via_server(
        connection_key,
        app_state,
        &format!("No connection server for connection {:?}", connection_key),
        ServerRequest::PreInitialize(PreInitializeRequest {
            agent_id: agent_id.to_string(),
            cwd: cwd.to_string(),
        }),
        reply!(ServerResponse::PreInitializeOk(response) => response),
        60,
        &format!("PreInitialize timed out for agent {}", agent_id),
    )
    .await
}

/// The MCP servers the user manages on this connection's machine, secrets blanked.
pub async fn query_list_mcp_servers_via_server(
    connection_key: crate::acp::ConnectionKey,
    project_path: Option<String>,
    app_state: &Arc<crate::core::AppState>,
) -> Result<maestro_protocol::McpServerList, String> {
    query_via_server(
        connection_key,
        app_state,
        "Connection not initialized. Run preflight first.",
        ServerRequest::ListMcpServers(maestro_protocol::ProjectScopedRequest { project_path }),
        reply!(ServerResponse::ListMcpServersOk(response) => response),
        15,
        "ListMcpServers via connection server timed out after 15s",
    )
    .await
}

pub async fn query_save_mcp_servers_via_server(
    connection_key: crate::acp::ConnectionKey,
    servers: Vec<maestro_protocol::ManagedMcpServer>,
    app_state: &Arc<crate::core::AppState>,
) -> Result<(), String> {
    query_via_server(
        connection_key,
        app_state,
        "Connection not initialized. Run preflight first.",
        ServerRequest::SaveMcpServers(maestro_protocol::SaveMcpServersRequest { servers }),
        reply!(ServerResponse::SaveMcpServersOk => ()),
        15,
        "SaveMcpServers via connection server timed out after 15s",
    )
    .await
}

pub async fn query_set_mcp_secrets_via_server(
    connection_key: crate::acp::ConnectionKey,
    secrets: Vec<maestro_protocol::McpSecret>,
    app_state: &Arc<crate::core::AppState>,
) -> Result<(), String> {
    query_via_server(
        connection_key,
        app_state,
        "Connection not initialized. Run preflight first.",
        ServerRequest::SetMcpSecrets(maestro_protocol::SetMcpSecretsRequest { secrets }),
        reply!(ServerResponse::SetMcpSecretsOk => ()),
        15,
        "SetMcpSecrets via connection server timed out after 15s",
    )
    .await
}

/// Connect to a server from the target and list its tools. The server answers within 15 seconds
/// whatever happens, so the margin here only covers the round trip.
pub async fn query_test_mcp_server_via_server(
    connection_key: crate::acp::ConnectionKey,
    server: maestro_protocol::ManagedMcpServer,
    app_state: &Arc<crate::core::AppState>,
) -> Result<maestro_protocol::McpTestResult, String> {
    query_via_server(
        connection_key,
        app_state,
        "Connection not initialized. Run preflight first.",
        ServerRequest::TestMcpServer(maestro_protocol::TestMcpServerRequest { server }),
        reply!(ServerResponse::TestMcpServerOk(response) => response),
        30,
        "TestMcpServer via connection server timed out after 30s",
    )
    .await
}

pub async fn query_list_skills_via_server(
    connection_key: crate::acp::ConnectionKey,
    project_path: Option<String>,
    app_state: &Arc<crate::core::AppState>,
) -> Result<maestro_protocol::SkillList, String> {
    query_via_server(
        connection_key,
        app_state,
        "Connection not initialized. Run preflight first.",
        ServerRequest::ListSkills(maestro_protocol::ProjectScopedRequest { project_path }),
        reply!(ServerResponse::ListSkillsOk(response) => response),
        15,
        "ListSkills via connection server timed out after 15s",
    )
    .await
}

/// Two skills CLI runs for a catalog skill, fetching it and then installing it, each allowed
/// `INSTALL_TIMEOUT` in the server; the first run on a machine also downloads the CLI.
pub async fn query_apply_skill_via_server(
    connection_key: crate::acp::ConnectionKey,
    request: maestro_protocol::ApplySkillRequest,
    app_state: &Arc<crate::core::AppState>,
) -> Result<(), String> {
    query_via_server(
        connection_key,
        app_state,
        "Connection not initialized. Run preflight first.",
        ServerRequest::ApplySkill(request),
        reply!(ServerResponse::ApplySkillOk => ()),
        300,
        "ApplySkill via connection server timed out after 300s",
    )
    .await
}

pub async fn query_delete_skill_via_server(
    connection_key: crate::acp::ConnectionKey,
    name: String,
    app_state: &Arc<crate::core::AppState>,
) -> Result<(), String> {
    query_via_server(
        connection_key,
        app_state,
        "Connection not initialized. Run preflight first.",
        ServerRequest::DeleteSkill(maestro_protocol::DeleteSkillRequest { name }),
        reply!(ServerResponse::DeleteSkillOk => ()),
        150,
        "DeleteSkill via connection server timed out after 150s",
    )
    .await
}
