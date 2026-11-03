//! Strips the completion marker an agent ends its work with from what the user sees. The marker
//! and the review loop's cap are `maestro_protocol::completion`'s; the daemon decides what a turn
//! ending means (`maestro-server/src/turn.rs`).

use maestro_protocol::completion::CompletionMarkerFilter;

/// Strip the completion marker from an `agent_message_chunk` payload.
///
/// Returns the modified payload — `None` when the chunk was nothing but a marker and there is
/// no longer anything to forward. Non-chunk payloads pass through untouched. Display only: the
/// daemon reads the marker itself to decide the turn.
///
/// Mirrors `extract_canvas_fences_from_payload` in `canvas.rs`, which solves the same problem for
/// canvas fences.
pub(crate) fn strip_completion_marker_from_payload(
    payload: serde_json::Value,
    completion_filter: &std::sync::Arc<std::sync::Mutex<CompletionMarkerFilter>>,
) -> Option<serde_json::Value> {
    if payload.get("sessionUpdate").and_then(|v| v.as_str()) != Some("agent_message_chunk") {
        return Some(payload);
    }

    let chunk_text = match payload
        .get("content")
        .and_then(|c| c.get("text"))
        .and_then(|t| t.as_str())
    {
        Some(text) => text.to_string(),
        None => return Some(payload),
    };

    let remaining_text = match completion_filter.lock() {
        Ok(mut filter) => filter.process_chunk(&chunk_text).0,
        Err(_) => return Some(payload),
    };

    if remaining_text.is_empty() {
        return None;
    }

    let mut updated = payload;
    if let Some(content) = updated.get_mut("content") {
        if let Some(text_field) = content.get_mut("text") {
            *text_field = serde_json::Value::String(remaining_text);
        }
    }
    Some(updated)
}
