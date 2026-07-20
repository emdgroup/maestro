use std::sync::Arc;
use tauri::{Emitter, State};
use maestro_protocol::{
    AuthenticateRequest, AuthTerminalInputRequest, KillAuthTerminalRequest,
    LogoutRequest, MaestroRpcMessage, ServerRequest, SpawnAuthTerminalRequest,
};
use crate::acp::session_types::AgentAuthInfo;
use crate::acp::transport_types::serialize_message;
use crate::core::AppState;

fn connection_key_id(key: &crate::acp::ConnectionKey) -> String {
    match key {
        crate::acp::ConnectionKey::Local => "local".to_string(),
        crate::acp::ConnectionKey::Ssh { id } => format!("ssh-{id}"),
        crate::acp::ConnectionKey::Wsl { id } => format!("wsl-{id}"),
        crate::acp::ConnectionKey::Docker { id } => format!("docker-{id}"),
    }
}

/// Remove a session that never completed spawn (e.g., auth_required) from in-memory state
/// without sending a Cancel to maestro-server and without tearing down the connection server.
/// This preserves the connection server so that Authenticate can be called afterward.
#[tauri::command]
#[specta::specta]
pub async fn discard_failed_spawn(
    app_state: State<'_, Arc<AppState>>,
    log_id: i32,
) -> Result<(), String> {
    let mut sessions = app_state.acp.sessions.lock().await;
    if let Some(mut session) = sessions.remove(&log_id) {
        if let Some(cancel_tx) = session.reader_cancel_tx.take() {
            let _ = cancel_tx.send(());
        }
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn get_agent_auth_info(
    app_state: State<'_, Arc<AppState>>,
    agent_id: String,
    connection: crate::acp::ConnectionKey,
) -> Result<Option<AgentAuthInfo>, String> {
    let map = app_state.acp.agent_auth_info.lock().await;
    Ok(map.get(&(connection, agent_id)).cloned())
}

#[tauri::command]
#[specta::specta]
pub async fn acp_authenticate(
    app_state: State<'_, Arc<AppState>>,
    agent_id: String,
    method_id: String,
    connection: crate::acp::ConnectionKey,
) -> Result<(), String> {
    let (writer_tx, authenticate_pending) = {
        let servers = app_state.acp.connection_servers.lock().await;
        let server = servers
            .get(&connection)
            .ok_or_else(|| format!("No connection server for connection {:?}", connection))?;
        (server.writer_tx.clone(), server.pending.authenticate.clone())
    };

    let (tx, rx) = tokio::sync::oneshot::channel();
    {
        let mut guard = authenticate_pending
            .lock()
            .map_err(|e| format!("Lock poisoned: {}", e))?;
        if guard.is_some() {
            return Err("Authentication already in progress".to_string());
        }
        *guard = Some(tx);
    }

    // Always use device code flow — browser launch from a subprocess is unreliable
    // (xdg-open returns immediately and the subprocess exits before auth completes).
    // The URL/code is shown in the modal's output area where the user can open it manually.
    let force_no_browser = true;
    let req = MaestroRpcMessage::Request(ServerRequest::Authenticate(AuthenticateRequest {
        agent_id: agent_id.clone(),
        method_id: method_id.clone(),
        force_no_browser,
    }));
    let bytes = serialize_message(&req)?;
    writer_tx
        .send(bytes)
        .await
        .map_err(|_| "Connection server writer channel closed".to_string())?;

    // 5-minute timeout — OAuth flows may require browser interaction.
    let result = tokio::time::timeout(std::time::Duration::from_secs(300), rx).await;
    match result {
        Err(_) => {
            if let Ok(mut guard) = authenticate_pending.lock() {
                guard.take();
            }
            Err("Authentication timed out".to_string())
        }
        Ok(inner) => {
            let outcome = inner
                .map_err(|_| "Authentication response channel dropped".to_string())??;
            // Mark as authenticated in state.
            let mut map = app_state.acp.agent_auth_info.lock().await;
            if let Some(info) = map.get_mut(&(connection, agent_id)) {
                info.authenticated = true;
            }
            Ok(outcome)
        }
    }
}

#[tauri::command]
#[specta::specta]
pub async fn acp_logout(
    app_state: State<'_, Arc<AppState>>,
    agent_id: String,
    connection: crate::acp::ConnectionKey,
) -> Result<(), String> {
    let (writer_tx, logout_pending) = {
        let servers = app_state.acp.connection_servers.lock().await;
        let server = servers
            .get(&connection)
            .ok_or_else(|| format!("No connection server for connection {:?}", connection))?;
        (server.writer_tx.clone(), server.pending.logout.clone())
    };

    let (tx, rx) = tokio::sync::oneshot::channel();
    {
        let mut guard = logout_pending
            .lock()
            .map_err(|e| format!("Lock poisoned: {}", e))?;
        if guard.is_some() {
            return Err("Logout already in progress".to_string());
        }
        *guard = Some(tx);
    }

    let req = MaestroRpcMessage::Request(ServerRequest::Logout(LogoutRequest {
        agent_id: agent_id.clone(),
    }));
    let bytes = serialize_message(&req)?;
    writer_tx
        .send(bytes)
        .await
        .map_err(|_| "Connection server writer channel closed".to_string())?;

    let result = tokio::time::timeout(std::time::Duration::from_secs(30), rx).await;
    match result {
        Err(_) => {
            if let Ok(mut guard) = logout_pending.lock() {
                guard.take();
            }
            Err("Logout timed out".to_string())
        }
        Ok(inner) => {
            let outcome = inner
                .map_err(|_| "Logout response channel dropped".to_string())??;
            let mut map = app_state.acp.agent_auth_info.lock().await;
            if let Some(info) = map.get_mut(&(connection, agent_id)) {
                info.authenticated = false;
            }
            Ok(outcome)
        }
    }
}

#[tauri::command]
#[specta::specta]
pub async fn acp_start_auth_terminal(
    app_state: State<'_, Arc<AppState>>,
    agent_id: String,
    method_id: String,
    connection: crate::acp::ConnectionKey,
    session_key: i32,
) -> Result<String, String> {
    let writer_tx = {
        let servers = app_state.acp.connection_servers.lock().await;
        let server = servers
            .get(&connection)
            .ok_or_else(|| format!("No connection server for connection {:?}", connection))?;
        server.writer_tx.clone()
    };

    let terminal_id = format!("auth-terminal-{}", connection_key_id(&connection));
    let session_id = format!("session-{}", session_key);

    let req = MaestroRpcMessage::Request(ServerRequest::SpawnAuthTerminal(
        SpawnAuthTerminalRequest {
            agent_id,
            method_id,
            terminal_id: terminal_id.clone(),
            session_id,
        },
    ));
    let bytes = serialize_message(&req)?;
    writer_tx
        .send(bytes)
        .await
        .map_err(|_| "Connection server writer channel closed".to_string())?;

    // Emit empty-output event so AgentActivityPanel opens the terminal tab immediately.
    app_state
        .app_handle
        .emit(
            &format!("acp://terminal-output/{}", session_key),
            &serde_json::json!({ "terminal_id": terminal_id, "output": "" }),
        )
        .ok();

    Ok(terminal_id)
}

#[tauri::command]
#[specta::specta]
pub async fn acp_send_auth_pty_input(
    app_state: State<'_, Arc<AppState>>,
    connection: crate::acp::ConnectionKey,
    data: Vec<u8>,
) -> Result<(), String> {
    let writer_tx = {
        let servers = app_state.acp.connection_servers.lock().await;
        servers
            .get(&connection)
            .ok_or_else(|| format!("No connection server for connection {:?}", connection))?
            .writer_tx
            .clone()
    };
    let terminal_id = format!("auth-terminal-{}", connection_key_id(&connection));
    let req = MaestroRpcMessage::Request(ServerRequest::AuthTerminalInput(
        AuthTerminalInputRequest { terminal_id, data },
    ));
    let bytes = serialize_message(&req)?;
    writer_tx
        .send(bytes)
        .await
        .map_err(|_| "Connection server writer channel closed".to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn acp_abort_auth_terminal(
    app_state: State<'_, Arc<AppState>>,
    connection: crate::acp::ConnectionKey,
) -> Result<(), String> {
    let writer_tx = {
        let servers = app_state.acp.connection_servers.lock().await;
        servers
            .get(&connection)
            .ok_or_else(|| format!("No connection server for connection {:?}", connection))?
            .writer_tx
            .clone()
    };
    let terminal_id = format!("auth-terminal-{}", connection_key_id(&connection));
    let req = MaestroRpcMessage::Request(ServerRequest::KillAuthTerminal(
        KillAuthTerminalRequest { terminal_id },
    ));
    let bytes = serialize_message(&req)?;
    writer_tx
        .send(bytes)
        .await
        .map_err(|_| "Connection server writer channel closed".to_string())
}
