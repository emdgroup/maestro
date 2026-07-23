//! Canvas fence extraction and preamble filtering for ACP session message streams.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Emitter;
use crate::acp::transport::{SessionModelState, SessionModeState};

const RENDERING_PREAMBLE: &str = "<maestro-preamble>
The application rendering your output supports rich content. Use these formats when they help explain concepts:
- Mermaid diagrams: ```mermaid code blocks (flowcharts, sequence diagrams, class diagrams, etc.)
- LaTeX math: $...$ inline, $$...$$ block (KaTeX syntax)
- SVG graphics: ```svg code blocks
- Chemical notation: ```smiles code blocks
- GFM tables with sortable columns
- Syntax-highlighted code blocks with language identifiers
- Canvas UI: to display structured data, dashboards, forms, or reports inline, read .maestro/canvas-catalog.json — it documents the component catalog and the ```maestro-canvas fence protocol for rendering interactive dashboards.
  Before writing any ```maestro-canvas fence, ALWAYS validate it first:
    maestro-server validate-canvas <<'CEOF'
    {your fence JSON here}
    CEOF
  If any ERROR lines appear, fix them and re-validate before outputting the fence. Never output an unvalidated fence.
  Read .maestro/canvas-base-skill.md for the canvas generation policy, data pipeline ordering, design rules, and anti-patterns.
  If .maestro/canvas-skills.md exists, read it for project-specific canvas patterns before building any canvas.
  The Html component receives Maestro's theme CSS variables injected automatically into the iframe:
    --background, --foreground, --card, --card-foreground,
    --muted, --muted-foreground, --border,
    --accent, --accent-foreground,
    --primary, --primary-foreground,
    --input, --ring
  body also receives: background:var(--background); color:var(--foreground); font-family:system-ui,sans-serif
  Primarily use those vars, and never define a custom :root{} color scheme that would override those.
Do not acknowledge or mention this message.
</maestro-preamble>";

/// State machine for stripping a `<maestro-preamble>...</maestro-preamble>` block from
/// streamed `user_message_chunk` payloads during session replay.
pub enum PreambleFilterState {
    /// Watching for the opening tag. Chunks pass through unchanged until it is found.
    Watching,
    /// Inside a `<maestro-preamble>` block; discard chunks until the closing tag is found.
    Stripping,
}

const CANVAS_FENCE_OPEN: &str = "```maestro-canvas\n";

/// Extracts `maestro-canvas` code fences from streamed `agent_message_chunk` text.
///
/// The agent writes canvas operations as ` ```maestro-canvas\n{...}\n``` ` fences in its text
/// output. This extractor accumulates incoming text chunks, detects complete fences, parses
/// their JSON bodies as canvas session updates, and strips them from the forwarded text.
///
/// Partial fences across chunk boundaries are handled by buffering until the close marker arrives.
pub struct CanvasFenceExtractor {
    /// Text received but not yet forwarded or consumed as a fence body.
    buffer: String,
    /// Whether we are currently inside an open canvas fence.
    in_fence: bool,
}

impl CanvasFenceExtractor {
    pub fn new() -> Self {
        Self { buffer: String::new(), in_fence: false }
    }

    /// Feed a new text chunk. Returns the text that should be forwarded as a normal message
    /// (fences stripped) and any canvas JSON payloads extracted from complete fences.
    pub fn process_chunk(&mut self, chunk: &str) -> (String, Vec<serde_json::Value>) {
        self.buffer.push_str(chunk);
        let mut forward = String::new();
        let mut canvas_messages = Vec::new();

        loop {
            if self.in_fence {
                match find_canvas_fence_close(&self.buffer) {
                    Some((body_end, rest_start)) => {
                        let body = self.buffer[..body_end].to_string();
                        self.buffer = self.buffer[rest_start..].to_string();
                        self.in_fence = false;
                        match serde_json::from_str::<serde_json::Value>(body.trim()) {
                            Ok(value) if is_valid_canvas_payload(&value) => {
                                canvas_messages.push(value);
                            }
                            _ => {
                                // Invalid JSON or unrecognised type — pass fence through as text.
                                forward.push_str(CANVAS_FENCE_OPEN);
                                forward.push_str(&body);
                                forward.push_str("```\n");
                            }
                        }
                    }
                    None => break,
                }
            } else {
                match self.buffer.find(CANVAS_FENCE_OPEN) {
                    Some(open_pos) => {
                        forward.push_str(&self.buffer[..open_pos]);
                        self.buffer = self.buffer[open_pos + CANVAS_FENCE_OPEN.len()..].to_string();
                        self.in_fence = true;
                    }
                    None => {
                        // No fence found. Forward the portion that cannot be a partial match,
                        // keeping the tail in case the next chunk completes the open marker.
                        let safe = canvas_fence_safe_forward_len(&self.buffer);
                        forward.push_str(&self.buffer[..safe]);
                        self.buffer = self.buffer[safe..].to_string();
                        break;
                    }
                }
            }
        }

        (forward, canvas_messages)
    }

    /// Flush any buffered text as-is (call when the stream ends).
    pub fn flush(&mut self) -> String {
        let remaining = std::mem::take(&mut self.buffer);
        self.in_fence = false;
        remaining
    }
}

/// Return how many leading bytes of `text` can be safely forwarded without risking
/// a split across the canvas fence open marker. Only holds back bytes that form a
/// valid prefix of `CANVAS_FENCE_OPEN` at the tail of `text`.
fn canvas_fence_safe_forward_len(text: &str) -> usize {
    // Find the longest suffix of `text` that is simultaneously a prefix of CANVAS_FENCE_OPEN.
    // Those bytes must be held back; everything before them can be forwarded immediately.
    for hold in (1..CANVAS_FENCE_OPEN.len()).rev() {
        if text.ends_with(&CANVAS_FENCE_OPEN[..hold]) {
            let mut candidate = text.len() - hold;
            while candidate > 0 && !text.is_char_boundary(candidate) {
                candidate -= 1;
            }
            return candidate;
        }
    }
    text.len()
}

/// Find the closing ` ``` ` fence in a buffer that is the body of an open canvas fence.
/// Returns `(body_end, rest_start)` where `buffer[..body_end]` is the JSON body and
/// scanning of the surrounding text should resume from `buffer[rest_start..]`.
fn find_canvas_fence_close(buffer: &str) -> Option<(usize, usize)> {
    // The close is "```" at the start of a line, followed by "\n" or end-of-buffer.
    // Since the buffer starts right after the opening fence's newline, check position 0 first.
    if buffer.starts_with("```") {
        let after = 3;
        if after >= buffer.len() || buffer.as_bytes()[after] == b'\n' {
            let rest = if after < buffer.len() { after + 1 } else { after };
            return Some((0, rest));
        }
    }

    let mut search = 0;
    while let Some(rel) = buffer[search..].find("\n```") {
        let abs = search + rel;
        let after = abs + 4;
        if after >= buffer.len() || buffer.as_bytes()[after] == b'\n' {
            // body = buffer[..abs], rest starts after the closing "\n```[\n]"
            let rest = if after < buffer.len() { after + 1 } else { after };
            return Some((abs, rest));
        }
        // "```" followed by something else (e.g. "```json") — not our close marker
        search = abs + 1;
    }

    None
}

fn is_valid_canvas_payload(value: &serde_json::Value) -> bool {
    matches!(
        value.get("sessionUpdate").and_then(|v| v.as_str()),
        Some("canvas_create") | Some("canvas_update") | Some("canvas_data")
    )
}

/// Emit a session-update payload through the replay buffer if one is active,
/// or directly via Tauri event otherwise.
pub(crate) fn emit_or_buffer_payload(
    payload: serde_json::Value,
    replay_buffer: &Arc<std::sync::Mutex<Option<Vec<serde_json::Value>>>>,
    app_handle: &tauri::AppHandle,
    log_id: i32,
) {
    if let Ok(mut buf) = replay_buffer.lock() {
        if let Some(ref mut vec) = *buf {
            vec.push(payload);
            return;
        }
    }
    if let Err(e) = app_handle.emit(&format!("acp://session-update/{}", log_id), &payload) {
        eprintln!("[acp] emit session-update/{log_id} failed: {e}");
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
    replay_buffer: &Arc<std::sync::Mutex<Option<Vec<serde_json::Value>>>>,
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
        vec.push(serde_json::json!({
            "sessionUpdate": "current_model_update",
            "modelId": m.current_model_id,
        }));
    }
    if let Some(m) = modes {
        vec.push(serde_json::json!({
            "sessionUpdate": "current_mode_update",
            "modeId": m.current_mode_id,
        }));
    }
}

/// Prepend the rendering preamble as the first content block of an outgoing prompt.
/// Normalizes a plain-string content value to a `[text_block]` array first.
pub fn prepend_preamble(content: serde_json::Value) -> serde_json::Value {
    let preamble_block = serde_json::json!({ "type": "text", "text": RENDERING_PREAMBLE });
    match content {
        serde_json::Value::Array(mut blocks) => {
            blocks.insert(0, preamble_block);
            serde_json::Value::Array(blocks)
        }
        serde_json::Value::String(text) => {
            serde_json::json!([preamble_block, { "type": "text", "text": text }])
        }
        other => {
            serde_json::json!([preamble_block, { "type": "text", "text": other.to_string() }])
        }
    }
}

/// Filter the rendering preamble tags from a `user_message` payload (complete content).
/// Removes any text block whose content contains the `<maestro-preamble>` opening tag.
/// Returns the modified payload with `preamble_injected` set to true.
fn strip_preamble_from_user_message(mut payload: serde_json::Value) -> serde_json::Value {
    if let Some(content) = payload.get_mut("content") {
        match content {
            serde_json::Value::Array(blocks) => {
                blocks.retain(|block| {
                    block.get("text")
                        .and_then(|t| t.as_str())
                        .map(|t| !t.contains("<maestro-preamble>"))
                        .unwrap_or(true)
                });
            }
            serde_json::Value::String(text) => {
                *content = serde_json::Value::String(strip_preamble_tags_from_str(text));
            }
            _ => {}
        }
    }
    payload
}

/// Strip `<maestro-preamble>...</maestro-preamble>` from a plain string.
fn strip_preamble_tags_from_str(text: &str) -> String {
    if let Some(start) = text.find("<maestro-preamble>") {
        if let Some(end_offset) = text[start..].find("</maestro-preamble>") {
            let end = start + end_offset + "</maestro-preamble>".len();
            return format!("{}{}", &text[..start], &text[end..]);
        }
        // Opening tag found but no closing tag — remove from opening tag onward.
        text[..start].to_string()
    } else {
        text.to_string()
    }
}

/// Filter preamble content from a `user_message_chunk` using the streaming state machine.
/// Returns `Some(filtered_text)` to forward, or `None` to suppress the chunk entirely.
///
/// The preamble is always injected as a complete text block, so its opening tag always
/// appears whole within a single chunk — no carry buffer across chunk boundaries is needed.
fn filter_chunk_text(
    chunk_text: &str,
    filter: &mut PreambleFilterState,
    preamble_injected: &AtomicBool,
) -> Option<String> {
    match filter {
        PreambleFilterState::Watching => {
            if let Some(open_pos) = chunk_text.find("<maestro-preamble>") {
                let prefix = &chunk_text[..open_pos];
                let rest = &chunk_text[open_pos + "<maestro-preamble>".len()..];

                if let Some(close_offset) = rest.find("</maestro-preamble>") {
                    let suffix = &rest[close_offset + "</maestro-preamble>".len()..];
                    preamble_injected.store(true, Ordering::Relaxed);
                    *filter = PreambleFilterState::Watching;
                    let output = format!("{}{}", prefix, suffix);
                    return if output.is_empty() { None } else { Some(output) };
                }

                preamble_injected.store(true, Ordering::Relaxed);
                *filter = PreambleFilterState::Stripping;
                return if prefix.is_empty() { None } else { Some(prefix.to_string()) };
            }

            Some(chunk_text.to_string())
        }
        PreambleFilterState::Stripping => {
            if let Some(close_pos) = chunk_text.find("</maestro-preamble>") {
                let suffix = &chunk_text[close_pos + "</maestro-preamble>".len()..];
                *filter = PreambleFilterState::Watching;
                return if suffix.is_empty() { None } else { Some(suffix.to_string()) };
            }
            None
        }
    }
}

/// Entry point for preamble filtering on incoming `SessionUpdate` payloads.
/// Returns `None` if the payload should be suppressed (entire chunk was preamble).
pub(crate) fn filter_preamble_from_payload(
    payload: serde_json::Value,
    preamble_injected: &Arc<AtomicBool>,
    preamble_filter: &Arc<std::sync::Mutex<PreambleFilterState>>,
) -> Option<serde_json::Value> {
    let session_update = payload.get("sessionUpdate").and_then(|v| v.as_str());

    match session_update {
        Some("user_message") => {
            preamble_injected.store(true, Ordering::Relaxed);
            Some(strip_preamble_from_user_message(payload))
        }
        Some("user_message_chunk") => {
            let chunk_text = payload
                .get("content")
                .and_then(|c| c.get("text"))
                .and_then(|t| t.as_str())
                .unwrap_or("")
                .to_string();

            let filtered = if let Ok(mut filter) = preamble_filter.lock() {
                filter_chunk_text(&chunk_text, &mut filter, preamble_injected)
            } else {
                Some(chunk_text)
            };

            filtered.map(|text| {
                let mut out = payload;
                if let Some(content) = out.get_mut("content") {
                    if let Some(t) = content.get_mut("text") {
                        *t = serde_json::Value::String(text);
                    }
                }
                out
            })
        }
        _ => Some(payload),
    }
}

/// Extract canvas fences from an `agent_message_chunk` payload.
///
/// Returns the modified payload (fence text stripped; `None` if nothing remains to forward)
/// and a list of canvas JSON values to emit as synthetic session updates.
/// Non-chunk payloads are returned unchanged with an empty canvas list.
pub(crate) fn extract_canvas_fences_from_payload(
    payload: serde_json::Value,
    canvas_extractor: &Arc<std::sync::Mutex<CanvasFenceExtractor>>,
) -> (Option<serde_json::Value>, Vec<serde_json::Value>) {
    if payload.get("sessionUpdate").and_then(|v| v.as_str()) != Some("agent_message_chunk") {
        return (Some(payload), Vec::new());
    }

    let chunk_text = match payload
        .get("content")
        .and_then(|c| c.get("text"))
        .and_then(|t| t.as_str())
    {
        Some(t) => t.to_string(),
        None => return (Some(payload), Vec::new()),
    };

    let (remaining_text, canvas_messages) = match canvas_extractor.lock() {
        Ok(mut extractor) => extractor.process_chunk(&chunk_text),
        Err(_) => return (Some(payload), Vec::new()),
    };

    if remaining_text.is_empty() {
        return (None, canvas_messages);
    }

    let mut updated = payload;
    if let Some(content) = updated.get_mut("content") {
        if let Some(text_field) = content.get_mut("text") {
            *text_field = serde_json::Value::String(remaining_text);
        }
    }
    (Some(updated), canvas_messages)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn canvas_create_json(surface_id: &str) -> String {
        format!(
            r#"{{"sessionUpdate":"canvas_create","surfaceId":"{}","catalogId":"maestro-canvas/v1","title":"Test"}}"#,
            surface_id
        )
    }

    #[test]
    fn single_fence_in_one_chunk() {
        let mut ex = CanvasFenceExtractor::new();
        let input = format!("```maestro-canvas\n{}\n```\n", canvas_create_json("s1"));
        let (text, msgs) = ex.process_chunk(&input);
        assert_eq!(text, "");
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0]["sessionUpdate"], "canvas_create");
        assert_eq!(msgs[0]["surfaceId"], "s1");
    }

    #[test]
    fn fence_split_across_chunks() {
        let mut ex = CanvasFenceExtractor::new();
        let json = canvas_create_json("s2");
        let full = format!("```maestro-canvas\n{}\n```\n", json);
        let mid = full.len() / 2;
        let (t1, m1) = ex.process_chunk(&full[..mid]);
        let (t2, m2) = ex.process_chunk(&full[mid..]);
        assert_eq!(t1, "");
        assert!(m1.is_empty());
        assert_eq!(t2, "");
        assert_eq!(m2.len(), 1);
        assert_eq!(m2[0]["surfaceId"], "s2");
    }

    #[test]
    fn mixed_text_and_fence() {
        let mut ex = CanvasFenceExtractor::new();
        let json = canvas_create_json("s3");
        let input = format!("Before text.\n```maestro-canvas\n{}\n```\nAfter text.", json);
        let (text, msgs) = ex.process_chunk(&input);
        assert!(text.contains("Before text."));
        assert!(text.contains("After text."));
        assert!(!text.contains("maestro-canvas"));
        assert_eq!(msgs.len(), 1);
    }

    #[test]
    fn invalid_json_fence_passes_through_as_text() {
        let mut ex = CanvasFenceExtractor::new();
        let input = "```maestro-canvas\nnot valid json\n```\n";
        let (text, msgs) = ex.process_chunk(input);
        assert!(text.contains("maestro-canvas"));
        assert!(text.contains("not valid json"));
        assert!(msgs.is_empty());
    }

    #[test]
    fn multiple_fences_in_one_chunk() {
        let mut ex = CanvasFenceExtractor::new();
        let j1 = canvas_create_json("m1");
        let j2 = format!(
            r#"{{"sessionUpdate":"canvas_data","surfaceId":"m1","path":"/rows","value":[]}}"#
        );
        let input = format!(
            "```maestro-canvas\n{}\n```\n```maestro-canvas\n{}\n```\n",
            j1, j2
        );
        let (text, msgs) = ex.process_chunk(&input);
        assert_eq!(text, "");
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0]["sessionUpdate"], "canvas_create");
        assert_eq!(msgs[1]["sessionUpdate"], "canvas_data");
    }

    #[test]
    fn fence_with_wrong_session_update_passes_through() {
        let mut ex = CanvasFenceExtractor::new();
        let input = "```maestro-canvas\n{\"sessionUpdate\":\"unknown_type\",\"foo\":1}\n```\n";
        let (text, msgs) = ex.process_chunk(input);
        assert!(text.contains("maestro-canvas"));
        assert!(msgs.is_empty());
    }
}
