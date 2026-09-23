//! Session-update delivery for ACP reader tasks: straight to the frontend, or into the replay
//! buffer that a restored session drains once its listener has registered.

use crate::acp::transport::{SessionModeState, SessionModelState};
use tauri::Emitter;

/// Serialize a payload for the replay buffer, logging and yielding `None` on failure.
fn to_raw_replay_payload(payload: &serde_json::Value) -> Option<Box<serde_json::value::RawValue>> {
    match serde_json::value::to_raw_value(payload) {
        Ok(raw) => Some(raw),
        Err(e) => {
            log::warn!("[acp] serialising replay payload failed: {e}");
            None
        }
    }
}

/// Emit a session-update payload through the replay buffer if one is active,
/// or directly via Tauri event otherwise.
pub(crate) fn emit_or_buffer_payload(
    payload: serde_json::Value,
    replay_buffer: &crate::acp::session_types::ReplayBuffer,
    app_handle: &tauri::AppHandle,
    session_id: &str,
) {
    if let Ok(mut buf) = replay_buffer.lock() {
        if let Some(ref mut vec) = *buf {
            // On serialisation failure fall through and emit directly rather than drop the event.
            if let Some(raw) = to_raw_replay_payload(&payload) {
                vec.push(raw);
                return;
            }
        }
    }
    if let Err(e) = app_handle.emit(&format!("acp://session-update/{}", session_id), &payload) {
        log::warn!("[acp] emit session-update/{session_id} failed: {e}");
    }
}

/// Push a synthetic `config_option_update` session-update into the replay buffer so that
/// model/mode config reaches the frontend via the safely-drained buffer path rather than a
/// directly-emitted event that may race with listener registration in `useAcpSessionLifecycle`.
/// `sessionUpdateRef.current` in that hook is set synchronously (not in a useEffect), so it is
/// always ready when drain fires — unlike the async `listen()` calls for `session-models`.
pub(crate) fn push_config_init_to_buffer(
    models: Option<&SessionModelState>,
    modes: Option<&SessionModeState>,
    replay_buffer: &crate::acp::session_types::ReplayBuffer,
) {
    let mut buf_guard = match replay_buffer.lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    let vec = match buf_guard.as_mut() {
        Some(v) => v,
        None => return,
    };
    // Push value-only updates — don't send options list from load response because
    // it's degraded compared to the catalog from SpawnOk.
    if let Some(m) = models {
        if let Some(raw) = to_raw_replay_payload(&serde_json::json!({
            "sessionUpdate": "current_model_update",
            "modelId": m.current_model_id,
        })) {
            vec.push(raw);
        }
    }
    if let Some(m) = modes {
        if let Some(raw) = to_raw_replay_payload(&serde_json::json!({
            "sessionUpdate": "current_mode_update",
            "modeId": m.current_mode_id,
        })) {
            vec.push(raw);
        }
    }
}
