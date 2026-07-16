//! ACP reader tasks: background loops that consume messages from a maestro-server process
//! and dispatch them to per-session handlers or connection-level pending channels.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Emitter;
use crate::acp::transport::{
    MaestroRpcMessage, ServerResponse, ServerRequest,
    SessionModelState, SessionModeState, PromptCapabilitiesInfo,
    FileSearchResponse, FileReadResponse,
};
use crate::acp::transport_types::{AcpReadSource, serialize_message};
use crate::acp::session_types::{
    PendingChannels, ReaderTaskContext, RestorableSession,
};
use crate::acp::canvas::{
    CanvasFenceExtractor, PreambleFilterState,
    emit_or_buffer_payload, push_config_init_to_buffer,
    filter_preamble_from_payload, extract_canvas_fences_from_payload,
};
use crate::acp::manager::append_debug_log;
use tokio::sync::oneshot;

pub(crate) fn spawn_reader_task(
    source: AcpReadSource,
    cancel_rx: oneshot::Receiver<()>,
    ctx: ReaderTaskContext,
) {
    let ReaderTaskContext {
        log_id, app_handle, app_state,
        current_model_id, current_mode_id,
        pending_file_search, pending_file_read,
        acp_session_id_cache, replay_buffer, initialized,
        preamble_injected, preamble_filter, canvas_extractor,
        session_name, agent_id, project_id, task_id,
    } = ctx;
    tokio::spawn(async move {
        let mut source = source;
        let mut cancel_rx = cancel_rx;

        loop {
            let msg = tokio::select! {
                biased;
                _ = &mut cancel_rx => break,
                result = source.next_message() => match result {
                    Some(msg) => msg,
                    None => break,
                },
            };
            match &msg {
                MaestroRpcMessage::Response(ServerResponse::Ping { .. })
                | MaestroRpcMessage::Response(ServerResponse::TerminalOutput(_)) => {}
                _ => {
                    if let Ok(json) = serde_json::to_string(&msg) {
                        append_debug_log(&format!("[acp] << log_id={log_id} {json}"));
                    }
                }
            }
            if let MaestroRpcMessage::Response(ServerResponse::Ping { seq }) = &msg {
                eprintln!("[acp] ping seq={seq} on direct session log_id={log_id}");
                let pong = MaestroRpcMessage::Request(ServerRequest::Pong { seq: *seq });
                if let Err(e) = crate::acp::write_to_acp_session(&app_state, log_id, &pong).await {
                    eprintln!("[acp] pong failed on direct session log_id={log_id}: {e}");
                }
                if let Err(e) = app_state.app_handle.emit("acp://heartbeat", ()) {
                    eprintln!("[acp] emit heartbeat failed: {e}");
                }
                continue;
            }

            update_session_from_response(log_id, &msg, &app_state).await;

            if let MaestroRpcMessage::Response(ServerResponse::PermissionRequest(ref perm_req)) = msg {
                if let Some(tid) = task_id {
                    if try_auto_approve_permission(&app_state, tid, log_id, perm_req).await {
                        continue;
                    }
                }
            }

            if let MaestroRpcMessage::Response(ServerResponse::TurnEnded(ref turn_ended)) = msg {
                if turn_ended.stop_reason == "end_turn" {
                    if let Some(tid) = task_id {
                        if try_complete_task(&app_state, tid).await {
                            app_state.app_handle.emit("tasks-changed", ()).ok();
                        }
                    }
                }
            }

            if let Some(native_id) = handle_server_message(msg, log_id, &app_handle, &current_model_id, &current_mode_id, &pending_file_search, &pending_file_read, &acp_session_id_cache, &replay_buffer, &initialized, &preamble_injected, &preamble_filter, &canvas_extractor) {
                if let (Some(pid), Some(ref name)) = (project_id, &session_name) {
                    if let Ok(conn) = app_state.db.lock() {
                        let _ = crate::acp::session_ops::upsert_session_alias(&conn, pid, &agent_id, &native_id, name);
                    }
                }
                // SpawnOk received — acp_session_id is now set; persist so sessions survive restart.
                if let Some(pid) = project_id {
                    tokio::spawn(crate::project::handlers::save_current_sessions_for_project(
                        Arc::clone(&app_state),
                        pid,
                    ));
                }
            }

        }

        app_state.acp.sessions.lock().await.remove(&log_id);
        app_state.app_handle.emit("sessions-changed", ()).ok();
        if let Err(e) = app_handle.emit(&format!("acp://session-ended/{}", log_id), ()) {
            eprintln!("[acp] emit session-ended/{log_id} failed: {e}");
        }
    });
}

async fn try_complete_task(app_state: &crate::core::AppState, task_id: i32) -> bool {
    let is_git_repo = is_task_project_git_repo(app_state, task_id).await;
    let Ok(conn) = app_state.db.lock() else { return false };
    let now = chrono::Utc::now().to_rfc3339();
    let target_status = if is_git_repo { "Review" } else { "Done" };
    conn.execute(
        &format!("UPDATE tasks SET status = '{}', updated_at = ? WHERE id = ? AND status = 'InProgress'", target_status),
        rusqlite::params![&now, task_id],
    )
    .unwrap_or(0) > 0
}

async fn is_task_project_git_repo(app_state: &crate::core::AppState, task_id: i32) -> bool {
    let result: Option<(i32, String, Option<i32>, Option<i32>, Option<i32>)> = app_state.db.lock().ok().and_then(|conn| {
        conn.query_row(
            "SELECT p.id, p.path, p.connection_id, p.wsl_connection_id, p.docker_connection_id \
             FROM tasks t JOIN projects p ON t.project_id = p.id \
             WHERE t.id = ?",
            [task_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        ).ok()
    });

    let Some((project_id, path, connection_id, wsl_connection_id, docker_connection_id)) = result else {
        return true;
    };

    if connection_id.is_none() && wsl_connection_id.is_none() && docker_connection_id.is_none() {
        return std::path::Path::new(&path).join(".git").exists();
    }

    match crate::core::get_project_with_git_conn(app_state, project_id).await {
        Ok((_project, git_conn)) => {
            crate::git::run_git_in_dir(&git_conn, &path, &["rev-parse", "--is-inside-work-tree"])
                .await
                .map(|output| output.trim() == "true")
                .unwrap_or(false)
        }
        Err(_) => false,
    }
}

async fn try_auto_approve_permission(
    app_state: &Arc<crate::core::AppState>,
    task_id: i32,
    log_id: i32,
    perm_req: &crate::acp::transport::PermissionRequest,
) -> bool {
    let auto_approve = app_state.db.lock().ok()
        .and_then(|conn| conn.query_row(
            "SELECT auto_approve FROM tasks WHERE id = ?",
            [task_id],
            |row| row.get::<_, bool>(0),
        ).ok())
        .unwrap_or(false);

    if !auto_approve {
        return false;
    }

    let option_id = perm_req.payload.get("options")
        .and_then(|v| v.as_array())
        .and_then(|opts| {
            opts.iter().find_map(|opt| {
                let kind = opt.get("kind").and_then(|v| v.as_str())?;
                if kind == "allow_always" {
                    return opt.get("optionId").and_then(|v| v.as_str()).map(|s| s.to_string());
                }
                None
            })
            .or_else(|| opts.iter().find_map(|opt| {
                let kind = opt.get("kind").and_then(|v| v.as_str())?;
                if kind == "allow_once" {
                    return opt.get("optionId").and_then(|v| v.as_str()).map(|s| s.to_string());
                }
                None
            }))
            .or_else(|| opts.iter().find_map(|opt| {
                let kind = opt.get("kind").and_then(|v| v.as_str())?;
                if kind.contains("allow") {
                    return opt.get("optionId").and_then(|v| v.as_str()).map(|s| s.to_string());
                }
                None
            }))
        });

    let Some(oid) = option_id else { return false };

    let session_id = format!("session-{}", log_id);
    let response = MaestroRpcMessage::Request(
        ServerRequest::PermitResponse(crate::acp::transport::PermissionResponse {
            session_id,
            request_id: perm_req.request_id.clone(),
            option_id: Some(oid),
        })
    );
    let _ = crate::acp::write_to_acp_session(app_state, log_id, &response).await;
    true
}

fn emit_session_init_events(
    models: Option<&SessionModelState>,
    modes: Option<&SessionModeState>,
    caps: Option<&PromptCapabilitiesInfo>,
    log_id: i32,
    app_handle: &tauri::AppHandle,
    current_model_id: &Arc<std::sync::Mutex<Option<String>>>,
    current_mode_id: &Arc<std::sync::Mutex<Option<String>>>,
) {
    if let Some(m) = models {
        if let Ok(mut cache) = current_model_id.lock() { *cache = Some(m.current_model_id.clone()); }
        if let Err(e) = app_handle.emit(&format!("acp://session-models/{}", log_id), m) {
            eprintln!("[acp] emit session-models/{log_id} failed: {e}");
        }
    }
    if let Some(m) = modes {
        if let Ok(mut cache) = current_mode_id.lock() { *cache = Some(m.current_mode_id.clone()); }
        if let Err(e) = app_handle.emit(&format!("acp://session-modes/{}", log_id), m) {
            eprintln!("[acp] emit session-modes/{log_id} failed: {e}");
        }
    }
    if let Some(c) = caps {
        if let Err(e) = app_handle.emit(&format!("acp://session-capabilities/{}", log_id), c) {
            eprintln!("[acp] emit session-capabilities/{log_id} failed: {e}");
        }
    }
}

/// Emit Tauri events for a parsed server response. Updates per-session current model/mode IDs.
/// Returns the native ACP session ID when a SpawnOk message is processed, None otherwise.
fn handle_server_message(
    msg: MaestroRpcMessage,
    log_id: i32,
    app_handle: &tauri::AppHandle,
    current_model_id: &Arc<std::sync::Mutex<Option<String>>>,
    current_mode_id: &Arc<std::sync::Mutex<Option<String>>>,
    pending_file_search: &Arc<std::sync::Mutex<Option<oneshot::Sender<Result<Vec<String>, String>>>>>,
    pending_file_read: &Arc<std::sync::Mutex<Option<oneshot::Sender<Result<String, String>>>>>,
    acp_session_id_cache: &Arc<std::sync::Mutex<Option<String>>>,
    replay_buffer: &Arc<std::sync::Mutex<Option<Vec<serde_json::Value>>>>,
    initialized: &Arc<std::sync::Mutex<bool>>,
    preamble_injected: &Arc<AtomicBool>,
    preamble_filter: &Arc<std::sync::Mutex<PreambleFilterState>>,
    canvas_extractor: &Arc<std::sync::Mutex<CanvasFenceExtractor>>,
) -> Option<String> {
    match msg {
        MaestroRpcMessage::Response(ServerResponse::SessionUpdate(upd)) => {
            // Detect CurrentModeUpdate to keep the per-session current_mode_id current.
            if upd.payload.get("sessionUpdate").and_then(|v| v.as_str()) == Some("current_mode_update") {
                if let Some(mode_id) = upd.payload.get("currentModeId").and_then(|v| v.as_str()) {
                    if let Ok(mut m) = current_mode_id.lock() {
                        *m = Some(mode_id.to_string());
                    }
                    if let Err(e) = app_handle.emit(&format!("acp://mode-changed/{}", log_id), mode_id) {
                        eprintln!("[acp] emit mode-changed/{log_id} failed: {e}");
                    }
                }
            }
            // Strip the rendering preamble from user messages before forwarding to the frontend.
            let payload = filter_preamble_from_payload(upd.payload, preamble_injected, preamble_filter);

            if let Some(payload) = payload {
                // Extract canvas fences from agent_message_chunk text. Each complete
                // ```maestro-canvas ... ``` block is emitted as a synthetic canvas session
                // update; the remaining text (fences stripped) is forwarded normally.
                let (payload_opt, canvas_messages) =
                    extract_canvas_fences_from_payload(payload, canvas_extractor);

                for canvas_msg in canvas_messages {
                    emit_or_buffer_payload(canvas_msg, replay_buffer, app_handle, log_id);
                }

                if let Some(payload) = payload_opt {
                    emit_or_buffer_payload(payload, replay_buffer, app_handle, log_id);
                }
            }
        }
        MaestroRpcMessage::Response(ServerResponse::TerminalOutput(out)) => {
            #[derive(serde::Serialize)]
            struct Payload<'a> {
                terminal_id: &'a str,
                output: String,
            }
            let payload = Payload {
                terminal_id: &out.terminal_id,
                output: String::from_utf8_lossy(&out.bytes).into_owned(),
            };
            if let Err(e) = app_handle.emit(&format!("acp://terminal-output/{}", log_id), &payload) {
                eprintln!("[acp] emit terminal-output/{log_id} failed: {e}");
            }
        }
        MaestroRpcMessage::Response(ServerResponse::PermissionRequest(req)) => {
            if let Err(e) = app_handle.emit(&format!("acp://permission-request/{}", log_id), &req) {
                eprintln!("[acp] emit permission-request/{log_id} failed: {e}");
            }
        }
        MaestroRpcMessage::Response(ServerResponse::ElicitationRequest(req)) => {
            if let Err(e) = app_handle.emit(&format!("acp://elicitation-request/{}", log_id), &req) {
                eprintln!("[acp] emit elicitation-request/{log_id} failed: {e}");
            }
        }
        MaestroRpcMessage::Response(ServerResponse::SpawnOk(spawn_ok)) => {
            eprintln!(
                "[acp] spawn-ok log_id={log_id} session={} acp_session={:?} model={:?} session_list={} session_load={} session_close={} session_delete={}",
                spawn_ok.session_id,
                spawn_ok.acp_session_id,
                spawn_ok.models.as_ref().map(|m| &m.current_model_id),
                spawn_ok.supports_session_list,
                spawn_ok.supports_session_load,
                spawn_ok.supports_session_close,
                spawn_ok.supports_session_delete,
            );
            emit_session_init_events(
                spawn_ok.models.as_ref(),
                spawn_ok.modes.as_ref(),
                spawn_ok.prompt_capabilities.as_ref(),
                log_id, app_handle, current_model_id, current_mode_id,
            );
            if let Some(ref config_options) = spawn_ok.config_options {
                if let Err(e) = app_handle.emit(
                    &format!("acp://config-state-updated/{}", log_id),
                    &serde_json::json!({ "configOptions": config_options }),
                ) {
                    eprintln!("[acp] emit config-state-updated/{log_id} failed: {e}");
                }
            }
            let new_native_id = if let Some(native_id) = spawn_ok.acp_session_id {
                if let Ok(mut cache) = acp_session_id_cache.lock() {
                    *cache = Some(native_id.clone());
                }
                Some(native_id)
            } else {
                None
            };
            if let Ok(mut init) = initialized.lock() { *init = true; }
            if let Err(e) = app_handle.emit("sessions-changed", ()) {
                eprintln!("[acp] emit sessions-changed failed: {e}");
            }
            if let Err(e) = app_handle.emit(&format!("acp://spawn-ok/{}", log_id), ()) {
                eprintln!("[acp] emit spawn-ok/{log_id} failed: {e}");
            }
            return new_native_id;
        }
        MaestroRpcMessage::Response(ServerResponse::SessionLoadOk(load_ok)) => {
            append_debug_log(&format!("[acp] session-load-ok log_id={log_id} session={}", load_ok.session_id));
            emit_session_init_events(
                load_ok.models.as_ref(),
                load_ok.modes.as_ref(),
                load_ok.prompt_capabilities.as_ref(),
                log_id, app_handle, current_model_id, current_mode_id,
            );
            if let Some(ref config_options) = load_ok.config_options {
                if let Err(e) = app_handle.emit(
                    &format!("acp://config-state-updated/{}", log_id),
                    &serde_json::json!({ "configOptions": config_options }),
                ) {
                    eprintln!("[acp] emit config-state-updated/{log_id} failed: {e}");
                }
            }
            push_config_init_to_buffer(load_ok.models.as_ref(), load_ok.modes.as_ref(), replay_buffer);
            if let Ok(mut init) = initialized.lock() { *init = true; }
            if let Err(e) = app_handle.emit(&format!("acp://spawn-ok/{}", log_id), ()) {
                eprintln!("[acp] emit spawn-ok/{log_id} failed: {e}");
            }
        }
        MaestroRpcMessage::Response(ServerResponse::SetModelOk(ok)) => {
            append_debug_log(&format!("[acp] set-model-ok log_id={log_id} model={}", ok.model_id));
            if let Ok(mut m) = current_model_id.lock() { *m = Some(ok.model_id.clone()); }
            if let Err(e) = app_handle.emit(&format!("acp://model-changed/{}", log_id), &ok.model_id) {
                eprintln!("[acp] emit model-changed/{log_id} failed: {e}");
            }
        }
        MaestroRpcMessage::Response(ServerResponse::SetModeOk(ok)) => {
            append_debug_log(&format!("[acp] set-mode-ok log_id={log_id} mode={}", ok.mode_id));
            if let Ok(mut m) = current_mode_id.lock() { *m = Some(ok.mode_id.clone()); }
            if let Err(e) = app_handle.emit(&format!("acp://mode-changed/{}", log_id), &ok.mode_id) {
                eprintln!("[acp] emit mode-changed/{log_id} failed: {e}");
            }
        }
        MaestroRpcMessage::Response(ServerResponse::SetConfigOptionOk(ok)) => {
            append_debug_log(&format!("[acp] set-config-ok log_id={log_id} config={} value={}", ok.config_id, ok.value));
            if let Err(e) = app_handle.emit(
                &format!("acp://config-changed/{}", log_id),
                &serde_json::json!({ "config_id": ok.config_id, "value": ok.value }),
            ) {
                eprintln!("[acp] emit config-changed/{log_id} failed: {e}");
            }
        }
        MaestroRpcMessage::Response(ServerResponse::ConfigOptionUpdated(ok)) => {
            append_debug_log(&format!("[acp] config-updated log_id={log_id} config={} value={}", ok.config_id, ok.value));
            if ok.config_id == "model" {
                if let Ok(mut m) = current_model_id.lock() { *m = Some(ok.value.clone()); }
            } else if ok.config_id == "mode" {
                if let Ok(mut m) = current_mode_id.lock() { *m = Some(ok.value.clone()); }
            }
            if let Err(e) = app_handle.emit(
                &format!("acp://config-state-updated/{}", log_id),
                &serde_json::json!({
                    "config_id": ok.config_id,
                    "value": ok.value,
                    "configOptions": ok.config_options,
                }),
            ) {
                eprintln!("[acp] emit config-state-updated/{log_id} failed: {e}");
            }
        }
        MaestroRpcMessage::Response(ServerResponse::FileSearchOk(FileSearchResponse { files })) => {
            if let Ok(mut guard) = pending_file_search.lock() {
                if let Some(tx) = guard.take() {
                    let _ = tx.send(Ok(files));
                }
            }
        }
        MaestroRpcMessage::Response(ServerResponse::FileReadOk(FileReadResponse { content })) => {
            if let Ok(mut guard) = pending_file_read.lock() {
                if let Some(tx) = guard.take() {
                    let _ = tx.send(Ok(content));
                }
            }
        }
        MaestroRpcMessage::Response(ServerResponse::Error(err)) => {
            eprintln!("[acp] session-error log_id={log_id}: {}", err.message);
            // Resolve any pending file op with the error before emitting the session-error event.
            if let Ok(mut guard) = pending_file_search.lock() {
                if let Some(tx) = guard.take() {
                    let _ = tx.send(Err(err.message.clone()));
                }
            }
            if let Ok(mut guard) = pending_file_read.lock() {
                if let Some(tx) = guard.take() {
                    let _ = tx.send(Err(err.message.clone()));
                }
            }
            if let Err(e) = app_handle.emit(&format!("acp://session-error/{}", log_id), &err.message) {
                eprintln!("[acp] emit session-error/{log_id} failed: {e}");
            }
        }
        MaestroRpcMessage::Response(ServerResponse::TurnEnded(turn_ended)) => {
            eprintln!("[acp] turn-ended log_id={log_id} stop={}", turn_ended.stop_reason);
            if let Err(e) = app_handle.emit(
                &format!("acp://turn-ended/{}", log_id),
                &turn_ended.stop_reason,
            ) {
                eprintln!("[acp] emit turn-ended/{log_id} failed: {e}");
            }
        }
        MaestroRpcMessage::Response(ServerResponse::Diagnostic(diag)) => {
            eprintln!("[maestro-server][{}] {}", diag.level, diag.message);
            if let Err(e) = app_handle.emit(&format!("acp://diagnostic/{}", log_id), &diag) {
                eprintln!("[acp] emit diagnostic/{log_id} failed: {e}");
            }
        }
        _ => {
            // Ignore Request variants arriving on stdout — wrong direction.
        }
    }
    None
}

pub(crate) async fn update_session_from_response(
    log_id: i32,
    msg: &MaestroRpcMessage,
    app_state: &Arc<crate::core::AppState>,
) {
    match msg {
        MaestroRpcMessage::Response(ServerResponse::SpawnOk(r)) => {
            let mut sessions = app_state.acp.sessions.lock().await;
            if let Some(session) = sessions.get_mut(&log_id) {
                session.session_capabilities = crate::acp::session_types::SessionCapabilitiesInfo {
                    supports_session_list: r.supports_session_list,
                    supports_session_load: r.supports_session_load,
                    supports_session_close: r.supports_session_close,
                    supports_session_delete: r.supports_session_delete,
                };
                session.config_options = r.config_options.clone().unwrap_or_default();
            }
        }
        MaestroRpcMessage::Response(ServerResponse::SessionLoadOk(r)) => {
            let mut sessions = app_state.acp.sessions.lock().await;
            if let Some(session) = sessions.get_mut(&log_id) {
                session.config_options = r.config_options.clone().unwrap_or_default();
            }
        }
        MaestroRpcMessage::Response(ServerResponse::ConfigOptionUpdated(r)) => {
            let mut sessions = app_state.acp.sessions.lock().await;
            if let Some(session) = sessions.get_mut(&log_id) {
                session.config_options = r.config_options.clone();
            }
        }
        MaestroRpcMessage::Response(ServerResponse::SessionUpdate(upd)) => {
            if upd.payload.get("sessionUpdate").and_then(|v| v.as_str()) == Some("config_option_update") {
                if let Some(options_val) = upd.payload.get("configOptions") {
                    if let Ok(options) = serde_json::from_value::<Vec<serde_json::Value>>(options_val.clone()) {
                        let mut sessions = app_state.acp.sessions.lock().await;
                        if let Some(session) = sessions.get_mut(&log_id) {
                            session.config_options = options;
                        }
                    }
                }
            }
        }
        _ => {}
    }
}

fn log_id_from_session_id(session_id: &str) -> Option<i32> {
    session_id.strip_prefix("session-")?.parse().ok()
}

fn extract_session_log_id(msg: &MaestroRpcMessage) -> Option<i32> {
    match msg {
        MaestroRpcMessage::Response(ServerResponse::SpawnOk(r)) => log_id_from_session_id(&r.session_id),
        MaestroRpcMessage::Response(ServerResponse::SessionUpdate(r)) => log_id_from_session_id(&r.session_id),
        MaestroRpcMessage::Response(ServerResponse::PermissionRequest(r)) => log_id_from_session_id(&r.session_id),
        MaestroRpcMessage::Response(ServerResponse::ElicitationRequest(r)) => log_id_from_session_id(&r.session_id),
        MaestroRpcMessage::Response(ServerResponse::TerminalOutput(r)) => log_id_from_session_id(&r.session_id),
        MaestroRpcMessage::Response(ServerResponse::TurnEnded(r)) => log_id_from_session_id(&r.session_id),
        MaestroRpcMessage::Response(ServerResponse::SetModelOk(r)) => log_id_from_session_id(&r.session_id),
        MaestroRpcMessage::Response(ServerResponse::SetModeOk(r)) => log_id_from_session_id(&r.session_id),
        MaestroRpcMessage::Response(ServerResponse::SetConfigOptionOk(r)) => log_id_from_session_id(&r.session_id),
        MaestroRpcMessage::Response(ServerResponse::ConfigOptionUpdated(r)) => log_id_from_session_id(&r.session_id),
        MaestroRpcMessage::Response(ServerResponse::SessionLoadOk(r)) => log_id_from_session_id(&r.session_id),
        MaestroRpcMessage::Response(ServerResponse::Error(err)) if err.session_id.is_some() => {
            err.session_id.as_deref().and_then(log_id_from_session_id)
        }
        _ => None,
    }
}

/// Route a shared-reader message to the correct per-session handler or to
/// connection-level pending channels (PreInitialize, SessionList, SessionClose, etc.).
async fn handle_shared_server_message(
    msg: MaestroRpcMessage,
    connection_key: crate::acp::ConnectionKey,
    app_handle: &tauri::AppHandle,
    app_state: &Arc<crate::core::AppState>,
    pending: &PendingChannels,
) {
    // Session-bearing messages: extract log_id, borrow caches from AcpProcess,
    // then call the existing single-session handler.
    if let Some(log_id) = extract_session_log_id(&msg) {
        update_session_from_response(log_id, &msg, app_state).await;

        let caches = {
            let sessions = app_state.acp.sessions.lock().await;
            sessions.get(&log_id).map(|s| (
                Arc::clone(&s.current_model_id),
                Arc::clone(&s.current_mode_id),
                Arc::clone(&s.pending_file_search),
                Arc::clone(&s.pending_file_read),
                Arc::clone(&s.acp_session_id),
                Arc::clone(&s.replay_buffer),
                Arc::clone(&s.initialized),
                Arc::clone(&s.preamble_injected),
                Arc::clone(&s.preamble_filter),
                Arc::clone(&s.canvas_extractor),
                s.session_name.clone(),
                s.agent_id_meta.clone(),
                s.project_id,
                s.task_id,
            ))
        };
        if let Some((current_model_id, current_mode_id, pfs, pfr, acp_sid, replay, initialized,
                      preamble_injected, preamble_filter, canvas_extractor,
                      session_name, agent_id, pid, task_id)) = caches {
            if let MaestroRpcMessage::Response(ServerResponse::PermissionRequest(ref perm_req)) = msg {
                if let Some(tid) = task_id {
                    if try_auto_approve_permission(app_state, tid, log_id, perm_req).await {
                        return;
                    }
                }
            }

            if let MaestroRpcMessage::Response(ServerResponse::TurnEnded(ref turn_ended)) = msg {
                if turn_ended.stop_reason == "end_turn" {
                    if let Some(tid) = task_id {
                        if try_complete_task(app_state, tid).await {
                            app_state.app_handle.emit("tasks-changed", ()).ok();
                        }
                    }
                }
            }

            let is_permission_request = matches!(msg, MaestroRpcMessage::Response(ServerResponse::PermissionRequest(_)));
            let is_session_load_error = matches!(&msg, MaestroRpcMessage::Response(ServerResponse::Error(e)) if e.session_id.is_some());
            let native_id = handle_server_message(
                msg, log_id, app_handle,
                &current_model_id, &current_mode_id, &pfs, &pfr, &acp_sid, &replay, &initialized,
                &preamble_injected, &preamble_filter, &canvas_extractor,
            );
            if is_permission_request {
                let sessions = app_state.acp.sessions.lock().await;
                if let Some(session) = sessions.get(&log_id) {
                    session.has_pending_permission.store(true, Ordering::Release);
                }
            }
            if let Some(native_id) = native_id {
                if let (Some(project_id_val), Some(ref name)) = (pid, &session_name) {
                    if let Ok(conn) = app_state.db.lock() {
                        let _ = crate::acp::session_ops::upsert_session_alias(&conn, project_id_val, &agent_id, &native_id, name);
                    }
                }
                // SpawnOk received — acp_session_id is now set; persist so sessions survive restart.
                if let Some(project_id_val) = pid {
                    tokio::spawn(crate::project::handlers::save_current_sessions_for_project(
                        Arc::clone(app_state),
                        project_id_val,
                    ));
                }
            }
            if is_session_load_error {
                // Session load failed (agent no longer has this session). Remove from the in-memory
                // map so getActiveSessions no longer lists it, then notify the frontend.
                app_state.acp.sessions.lock().await.remove(&log_id);
                if let Err(e) = app_handle.emit("sessions-changed", ()) {
                    eprintln!("[acp] emit sessions-changed failed: {e}");
                }
            }
        }
        return;
    }

    // Sessionless messages.
    match msg {
        MaestroRpcMessage::Response(ServerResponse::ListAgentsOk(resp)) => {
            let agents: Vec<crate::acp::registry::DiscoveredAgent> = resp.agents.into_iter().map(|a| crate::acp::registry::DiscoveredAgent {
                id: a.id,
                name: a.name,
                icon: a.icon,
                spawn_deps: a.spawn_deps,
            }).collect();
            append_debug_log(&format!(
                "[registry] ListAgentsOk: {} agents: {:?}",
                agents.len(),
                agents.iter().map(|a| &a.id).collect::<Vec<_>>()
            ));
            if let Ok(mut guard) = pending.list_agents.lock() {
                if let Some(tx) = guard.take() {
                    let _ = tx.send(Ok(agents));
                }
            }
        }
        MaestroRpcMessage::Response(ServerResponse::SessionListOk(resp)) => {
            if let Ok(mut guard) = pending.session_list.lock() {
                if let Some(tx) = guard.take() {
                    let _ = tx.send(Ok(resp));
                }
            }
        }
        MaestroRpcMessage::Response(ServerResponse::SessionCloseOk) => {
            if let Ok(mut guard) = pending.session_close.lock() {
                if let Some(tx) = guard.take() {
                    let _ = tx.send(Ok(()));
                }
            }
        }
        MaestroRpcMessage::Response(ServerResponse::SessionDeleteOk) => {
            if let Ok(mut guard) = pending.session_delete.lock() {
                if let Some(tx) = guard.take() {
                    let _ = tx.send(Ok(()));
                }
            }
        }
        MaestroRpcMessage::Response(ServerResponse::CheckToolsOk(resp)) => {
            if let Ok(mut guard) = pending.check_tools.lock() {
                if let Some(tx) = guard.take() {
                    let _ = tx.send(Ok(resp));
                }
            }
        }
        MaestroRpcMessage::Response(ServerResponse::DetectInstalledAgentsOk(resp)) => {
            append_debug_log(&format!(
                "[registry] DetectInstalledAgentsOk: {:?}",
                resp.agents.iter().map(|a| &a.agent_id).collect::<Vec<_>>()
            ));
            if let Ok(mut guard) = pending.detect_installed.lock() {
                if let Some(tx) = guard.take() {
                    let _ = tx.send(Ok(resp));
                }
            }
        }
        MaestroRpcMessage::Response(ServerResponse::DetectProjectAgentsOk(resp)) => {
            if let Ok(mut guard) = pending.detect_project.lock() {
                if let Some(tx) = guard.take() {
                    let _ = tx.send(Ok(resp));
                }
            }
        }
        MaestroRpcMessage::Response(ServerResponse::PreInitializeOk(resp)) => {
            let agent_id = resp.agent_id.clone();
            let supports = (resp.supports_session_list, resp.supports_session_load, resp.supports_session_close, resp.supports_session_delete);
            // Store auth info before sending the response to avoid a race.
            let auth_info = crate::acp::session_types::AgentAuthInfo {
                auth_methods: resp.auth_methods.iter().map(|m| crate::acp::session_types::AuthMethodDto {
                    id: m.id.clone(),
                    name: m.name.clone(),
                    description: m.description.clone(),
                    method_type: m.method_type.clone(),
                    args: m.args.clone(),
                }).collect(),
                supports_logout: resp.supports_auth_logout,
                authenticated: false,
            };
            app_state.acp.agent_auth_info.lock().await
                .insert((connection_key, agent_id.clone()), auth_info);
            let tx = pending.pre_init
                .lock()
                .ok()
                .and_then(|mut map| map.remove(&resp.agent_id));
            if let Some(tx) = tx {
                let _ = tx.send(Ok(resp));
            }
            append_debug_log(&format!(
                "[acp] pre-initialize-ok agent_id={agent_id} session_list={} session_load={} session_close={} session_delete={}",
                supports.0, supports.1, supports.2, supports.3
            ));
        }
        MaestroRpcMessage::Response(ServerResponse::AuthenticateOk) => {
            if let Ok(mut guard) = pending.authenticate.lock() {
                if let Some(tx) = guard.take() {
                    let _ = tx.send(Ok(()));
                }
            }
        }
        MaestroRpcMessage::Response(ServerResponse::LogoutOk) => {
            if let Ok(mut guard) = pending.logout.lock() {
                if let Some(tx) = guard.take() {
                    let _ = tx.send(Ok(()));
                }
            }
        }
        MaestroRpcMessage::Response(ServerResponse::AgentConnectionLost(lost)) => {
            for session_id_str in &lost.affected_session_ids {
                if let Some(log_id) = log_id_from_session_id(session_id_str) {
                    app_state.acp.sessions.lock().await.remove(&log_id);
                    if let Err(e) = app_handle.emit(&format!("acp://session-ended/{}", log_id), ()) {
                        eprintln!("[acp] emit session-ended/{log_id} failed: {e}");
                    }
                }
            }
            append_debug_log(&format!(
                "[acp] agent-connection-lost agent={} reason={} sessions={:?}",
                lost.agent_id, lost.reason, lost.affected_session_ids
            ));
            app_state.app_handle.emit("sessions-changed", ()).ok();
        }
        MaestroRpcMessage::Response(ServerResponse::FileSearchOk(FileSearchResponse { files })) => {
            // Deliver to the first connection session that has a pending file search.
            let sessions = app_state.acp.sessions.lock().await;
            for (_, session) in sessions.iter().filter(|(_, s)| s.connection_key == connection_key) {
                if let Ok(mut guard) = session.pending_file_search.lock() {
                    if guard.is_some() {
                        if let Some(tx) = guard.take() {
                            let _ = tx.send(Ok(files));
                        }
                        break;
                    }
                }
            }
        }
        MaestroRpcMessage::Response(ServerResponse::FileReadOk(FileReadResponse { content })) => {
            let sessions = app_state.acp.sessions.lock().await;
            for (_, session) in sessions.iter().filter(|(_, s)| s.connection_key == connection_key) {
                if let Ok(mut guard) = session.pending_file_read.lock() {
                    if guard.is_some() {
                        if let Some(tx) = guard.take() {
                            let _ = tx.send(Ok(content));
                        }
                        break;
                    }
                }
            }
        }
        MaestroRpcMessage::Response(ServerResponse::Diagnostic(diag)) => {
            eprintln!("[maestro-server][{}] {}", diag.level, diag.message);
            // Best-effort: emit to any session on this connection for frontend visibility.
            let log_ids: Vec<i32> = {
                let sessions = app_state.acp.sessions.lock().await;
                sessions
                    .iter()
                    .filter(|(_, s)| s.connection_key == connection_key)
                    .map(|(id, _)| *id)
                    .collect()
            };
            for lid in log_ids {
                let _ = app_handle.emit(&format!("acp://diagnostic/{}", lid), &diag);
            }
            // Connection-scoped event so the auth modal can receive output even when the
            // session that triggered auth was discarded before the modal opened.
            app_handle.emit(&format!("acp://auth-output/{}", connection_key_id(&connection_key)), &diag).ok();
        }
        MaestroRpcMessage::Response(ServerResponse::Error(err)) => {
            // Try pending session ops first, then file ops, then PreInitialize, then emit globally.
            let mut resolved = false;

            // Pending SessionList / SessionClose / CheckTools
            if !resolved {
                if let Ok(mut guard) = pending.session_list.lock() {
                    if guard.is_some() {
                        if let Some(tx) = guard.take() {
                            let _ = tx.send(Err(err.message.clone()));
                        }
                        resolved = true;
                    }
                }
            }
            if !resolved {
                if let Ok(mut guard) = pending.session_close.lock() {
                    if guard.is_some() {
                        if let Some(tx) = guard.take() {
                            let _ = tx.send(Err(err.message.clone()));
                        }
                        resolved = true;
                    }
                }
            }
            if !resolved {
                if let Ok(mut guard) = pending.check_tools.lock() {
                    if guard.is_some() {
                        if let Some(tx) = guard.take() {
                            let _ = tx.send(Err(err.message.clone()));
                        }
                        resolved = true;
                    }
                }
            }
            if !resolved {
                if let Ok(mut guard) = pending.detect_installed.lock() {
                    if guard.is_some() {
                        if let Some(tx) = guard.take() {
                            let _ = tx.send(Err(err.message.clone()));
                        }
                        resolved = true;
                    }
                }
            }
            if !resolved {
                if let Ok(mut guard) = pending.detect_project.lock() {
                    if guard.is_some() {
                        if let Some(tx) = guard.take() {
                            let _ = tx.send(Err(err.message.clone()));
                        }
                        resolved = true;
                    }
                }
            }

            if !resolved {
                let sessions = app_state.acp.sessions.lock().await;
                'outer: for (_, session) in
                    sessions.iter().filter(|(_, s)| s.connection_key == connection_key)
                {
                    if let Ok(mut guard) = session.pending_file_search.lock() {
                        if guard.is_some() {
                            if let Some(tx) = guard.take() {
                                let _ = tx.send(Err(err.message.clone()));
                            }
                            resolved = true;
                            break 'outer;
                        }
                    }
                    if let Ok(mut guard) = session.pending_file_read.lock() {
                        if guard.is_some() {
                            if let Some(tx) = guard.take() {
                                let _ = tx.send(Err(err.message.clone()));
                            }
                            resolved = true;
                            break 'outer;
                        }
                    }
                }
            }
            if !resolved {
                // Try pending ListAgents.
                if let Ok(mut guard) = pending.list_agents.lock() {
                    if let Some(tx) = guard.take() {
                        let _ = tx.send(Err(err.message.clone()));
                        resolved = true;
                    }
                }
            }
            if !resolved {
                if let Ok(mut guard) = pending.authenticate.lock() {
                    if guard.is_some() {
                        if let Some(tx) = guard.take() {
                            let _ = tx.send(Err(err.message.clone()));
                        }
                        resolved = true;
                    }
                }
            }
            if !resolved {
                if let Ok(mut guard) = pending.logout.lock() {
                    if guard.is_some() {
                        if let Some(tx) = guard.take() {
                            let _ = tx.send(Err(err.message.clone()));
                        }
                        resolved = true;
                    }
                }
            }
            if !resolved {
                // Try pending PreInitialize.
                let pre_init_tx = pending.pre_init.lock().ok().and_then(|mut map| {
                    let key = map.keys().next().cloned()?;
                    map.remove(&key)
                });
                if let Some(tx) = pre_init_tx {
                    let _ = tx.send(Err(err.message));
                } else {
                    // Emit as session-error for all connection sessions.
                    let log_ids: Vec<i32> = {
                        let sessions = app_state.acp.sessions.lock().await;
                        sessions
                            .iter()
                            .filter(|(_, s)| s.connection_key == connection_key)
                            .map(|(id, _)| *id)
                            .collect()
                    };
                    for log_id in log_ids {
                        if let Err(e) = app_handle.emit(
                            &format!("acp://session-error/{}", log_id),
                            &err.message,
                        ) {
                            eprintln!("[acp] emit session-error/{log_id} failed: {e}");
                        }
                    }
                }
            }
        }
        _ => {}
    }
}

pub(crate) fn spawn_shared_reader_task(
    source: AcpReadSource,
    connection_key: crate::acp::ConnectionKey,
    last_ping_at: Arc<AtomicU64>,
    writer_tx: tokio::sync::mpsc::Sender<Vec<u8>>,
    app_handle: tauri::AppHandle,
    app_state: Arc<crate::core::AppState>,
    pending: PendingChannels,
) {
    tokio::spawn(async move {
        let mut source = source;

        let watchdog_alive = Arc::new(AtomicBool::new(true));
        tokio::spawn({
            let watchdog_alive = Arc::clone(&watchdog_alive);
            let last_ping_at = Arc::clone(&last_ping_at);
            let app_handle = app_handle.clone();
            async move {
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(15)).await;
                    if !watchdog_alive.load(Ordering::Relaxed) {
                        break;
                    }
                    let last = last_ping_at.load(Ordering::Relaxed);
                    if last == 0 {
                        // No ping received yet — server may still be starting up.
                        continue;
                    }
                    let now = SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_secs();
                    let secs_since = now.saturating_sub(last);
                    if secs_since > 25 {
                        eprintln!("[acp] connection stale for {connection_key:?}: {secs_since}s since last ping");
                        if let Err(e) = app_handle.emit("acp://connection-stale", secs_since) {
                            eprintln!("[acp] emit connection-stale failed: {e}");
                        }
                    }
                }
            }
        });

        while let Some(msg) = source.next_message().await {
            match &msg {
                MaestroRpcMessage::Response(ServerResponse::Ping { .. })
                | MaestroRpcMessage::Response(ServerResponse::TerminalOutput(_)) => {}
                _ => {
                    if let Ok(json) = serde_json::to_string(&msg) {
                        append_debug_log(&format!("[acp] << {connection_key:?} {json}"));
                    }
                }
            }
            if let MaestroRpcMessage::Response(ServerResponse::Ping { seq }) = &msg {
                let now = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs();
                last_ping_at.store(now, Ordering::Relaxed);
                eprintln!("[acp] ping seq={seq} from {connection_key:?}");
                let pong = MaestroRpcMessage::Request(ServerRequest::Pong { seq: *seq });
                match serialize_message(&pong) {
                    Ok(bytes) => {
                        if let Err(e) = writer_tx.send(bytes).await {
                            eprintln!("[acp] pong send failed: {e}");
                        }
                    }
                    Err(e) => eprintln!("[acp] pong serialize failed: {e}"),
                }
                if let Err(e) = app_handle.emit("acp://heartbeat", ()) {
                    eprintln!("[acp] emit heartbeat failed: {e}");
                }
                continue;
            }
            handle_shared_server_message(
                msg,
                connection_key,
                &app_handle,
                &app_state,
                &pending,
            )
            .await;
        }

        watchdog_alive.store(false, Ordering::Relaxed);

        // Server process died — clean up all shared sessions for this connection.
        app_state.acp.connection_servers.lock().await.remove(&connection_key);

        // Snapshot restorable metadata before removing sessions from the map.
        // Sessions without an acp_session_id haven't received SpawnOk yet and cannot
        // be restored — emit session-ended for those immediately.
        let (to_restore, to_end_now): (Vec<RestorableSession>, Vec<i32>) = {
            let sessions = app_state.acp.sessions.lock().await;
            let mut restorable: Vec<RestorableSession> = Vec::new();
            let mut unrestorable: Vec<i32> = Vec::new();
            let is_ssh = matches!(connection_key, crate::acp::ConnectionKey::Ssh { .. });
            for (log_id, s) in sessions.iter().filter(|(_, s)| s.connection_key == connection_key) {
                let acp_session_id = s.acp_session_id.lock().ok().and_then(|g| g.clone());
                if acp_session_id.is_some() && is_ssh {
                    restorable.push(RestorableSession {
                        log_id: *log_id,
                        agent_id: s.agent_id_meta.clone(),
                        acp_session_id,
                        cwd: s.cwd.clone(),
                        session_name: s.session_name.clone(),
                        project_id: s.project_id,
                        task_id: s.task_id,
                    });
                } else {
                    unrestorable.push(*log_id);
                }
            }
            (restorable, unrestorable)
        };

        // Remove all affected sessions from the map.
        {
            let mut sessions = app_state.acp.sessions.lock().await;
            for s in &to_restore {
                sessions.remove(&s.log_id);
            }
            for log_id in &to_end_now {
                sessions.remove(log_id);
            }
        }

        // Immediately end unrestorable sessions (no acp_session_id yet, or non-SSH).
        for log_id in &to_end_now {
            if let Err(e) = app_handle.emit(&format!("acp://session-ended/{}", log_id), ()) {
                eprintln!("[acp] emit session-ended/{log_id} failed: {e}");
            }
        }

        // SSH connections only: park restorable sessions for the reconnect handler.
        // Local and WSL have no reconnect path — end immediately.
        match &connection_key {
            crate::acp::ConnectionKey::Ssh { id: conn_id } if !to_restore.is_empty() => {
                app_state.acp.restorable_sessions.lock().await.insert(*conn_id, to_restore);
            }
            _ => {
                for s in &to_restore {
                    if let Err(e) = app_handle.emit(&format!("acp://session-ended/{}", s.log_id), ()) {
                        eprintln!("[acp] emit session-ended/{} failed: {e}", s.log_id);
                    }
                }
            }
        }

        app_state.app_handle.emit("sessions-changed", ()).ok();
    });
}

fn connection_key_id(key: &crate::acp::ConnectionKey) -> String {
    match key {
        crate::acp::ConnectionKey::Local => "local".to_string(),
        crate::acp::ConnectionKey::Ssh { id } => format!("ssh-{id}"),
        crate::acp::ConnectionKey::Wsl { id } => format!("wsl-{id}"),
        crate::acp::ConnectionKey::Docker { id } => format!("docker-{id}"),
    }
}
