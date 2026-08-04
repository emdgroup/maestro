//! Deciding when a turn ending means the work is finished.
//!
//! A turn ending is not the same as the task being done: an agent that stops to ask a question
//! ends its turn exactly like one that finished the job. This module holds the two things that
//! tell them apart — a marker the agent emits when it believes it is done, and the classification
//! of a turn from that marker, the stop reason, and whether the repository actually changed.
//!
//! Both are deliberately free of database, git and session access so the rules can be tested
//! directly.

/// Emitted by the agent when it considers the task complete. Stripped before display.
///
/// A fixed tag rather than a phrase because a phrase gets paraphrased, quoted back, and written
/// into commit messages. The agent is asked for it by a one-line instruction appended to the
/// initial prompt in `useExecuteTask`.
pub const COMPLETION_MARKER: &str = "<maestro-task-complete/>";

/// What a turn ending means for the task.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TurnOutcome {
    /// The phase is finished — advance the task.
    Complete,
    /// The agent stopped without finishing and without changing anything, so it is waiting on
    /// the user. The task keeps its column; only the ball moves.
    Stalled,
    /// The turn ended badly and the task needs attention.
    Failed,
    /// Another code path owns this stop reason.
    Ignore,
}

/// Decide what a turn ending means.
///
/// `has_changes` is `None` when there is no repository to consult, in which case there is no
/// evidence either way and the agent is taken at its word that the turn ending finished the work
/// — the behaviour before any of this existed.
///
/// Unrecognised stop reasons are treated as failures rather than ignored: a new one appearing
/// should surface on the board, not leave a task running forever with nothing happening.
pub fn classify_turn(
    stop_reason: &str,
    declared_complete: bool,
    has_changes: Option<bool>,
) -> TurnOutcome {
    match stop_reason {
        "end_turn" => {
            if declared_complete {
                return TurnOutcome::Complete;
            }
            match has_changes {
                Some(false) => TurnOutcome::Stalled,
                Some(true) | None => TurnOutcome::Complete,
            }
        }
        // The user stopped it: `interrupt_task` has already moved the task.
        "cancelled" => TurnOutcome::Ignore,
        // The auth flow owns this one and will retry the prompt itself.
        "auth_required" => TurnOutcome::Ignore,
        _ => TurnOutcome::Failed,
    }
}

/// Strips [`COMPLETION_MARKER`] out of streamed agent text and reports whether it was seen.
///
/// The marker can be split across stream chunks, so text that could still turn out to be the
/// start of one is held back until the next chunk resolves it. Same problem and same shape as
/// `CanvasFenceExtractor` in `canvas.rs`.
#[derive(Default)]
pub struct CompletionMarkerFilter {
    /// Text received but not yet safe to forward, because it may be a partial marker.
    buffer: String,
}

impl CompletionMarkerFilter {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed a chunk of agent text. Returns the text to forward and whether a marker completed.
    pub fn process_chunk(&mut self, chunk: &str) -> (String, bool) {
        self.buffer.push_str(chunk);
        let mut forward = String::new();
        let mut found = false;

        loop {
            match self.buffer.find(COMPLETION_MARKER) {
                Some(pos) => {
                    forward.push_str(&self.buffer[..pos]);
                    self.buffer = self.buffer[pos + COMPLETION_MARKER.len()..].to_string();
                    found = true;
                }
                None => {
                    let safe = safe_forward_len(&self.buffer);
                    forward.push_str(&self.buffer[..safe]);
                    self.buffer = self.buffer[safe..].to_string();
                    break;
                }
            }
        }

        (forward, found)
    }

    /// Release anything still held back. Call when the stream ends, so a chunk that merely looked
    /// like the start of a marker is not swallowed.
    pub fn flush(&mut self) -> String {
        std::mem::take(&mut self.buffer)
    }
}

/// How many leading bytes of `text` cannot be part of a marker split across chunks.
///
/// Holds back only the longest suffix of `text` that is also a prefix of the marker, so ordinary
/// text streams through without waiting.
fn safe_forward_len(text: &str) -> usize {
    for hold in (1..COMPLETION_MARKER.len()).rev() {
        if text.ends_with(&COMPLETION_MARKER[..hold]) {
            let mut candidate = text.len() - hold;
            while candidate > 0 && !text.is_char_boundary(candidate) {
                candidate -= 1;
            }
            return candidate;
        }
    }
    text.len()
}

/// Strip the completion marker from an `agent_message_chunk` payload.
///
/// Returns the modified payload — `None` when the chunk was nothing but a marker and there is
/// no longer anything to forward. Non-chunk payloads pass through untouched. `declared_complete`
/// is set when a marker completes; it is read and reset when the turn ends.
///
/// Mirrors `extract_canvas_fences_from_payload` in `canvas.rs`, which solves the same problem for
/// canvas fences.
pub(crate) fn strip_completion_marker_from_payload(
    payload: serde_json::Value,
    completion_filter: &std::sync::Arc<std::sync::Mutex<CompletionMarkerFilter>>,
    declared_complete: &std::sync::Arc<std::sync::atomic::AtomicBool>,
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

    let (remaining_text, found) = match completion_filter.lock() {
        Ok(mut filter) => filter.process_chunk(&chunk_text),
        Err(_) => return Some(payload),
    };

    if found {
        declared_complete.store(true, std::sync::atomic::Ordering::Release);
    }

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

#[cfg(test)]
mod tests {
    use super::*;

    mod classification {
        use super::*;

        #[test]
        fn an_agent_that_says_it_is_done_is_believed() {
            assert_eq!(classify_turn("end_turn", true, Some(false)), TurnOutcome::Complete);
            assert_eq!(classify_turn("end_turn", true, Some(true)), TurnOutcome::Complete);
            assert_eq!(classify_turn("end_turn", true, None), TurnOutcome::Complete);
        }

        /// The bug this whole module exists for: a turn that ended with a question, not work.
        #[test]
        fn a_turn_that_changed_nothing_is_a_stall_not_a_completion() {
            assert_eq!(classify_turn("end_turn", false, Some(false)), TurnOutcome::Stalled);
        }

        #[test]
        fn a_turn_that_changed_something_still_completes() {
            assert_eq!(classify_turn("end_turn", false, Some(true)), TurnOutcome::Complete);
        }

        /// No repository means no evidence, so behave as the code did before the diff check.
        #[test]
        fn without_a_repository_a_turn_ending_completes() {
            assert_eq!(classify_turn("end_turn", false, None), TurnOutcome::Complete);
        }

        #[test]
        fn bad_stop_reasons_fail_the_phase() {
            for reason in ["refusal", "max_tokens", "max_turn_requests", "error", "unknown"] {
                assert_eq!(
                    classify_turn(reason, false, Some(true)),
                    TurnOutcome::Failed,
                    "for {reason}"
                );
            }
        }

        /// A stop reason we have never seen must surface, not vanish.
        #[test]
        fn an_unrecognised_stop_reason_fails_rather_than_being_ignored() {
            assert_eq!(classify_turn("something_new", false, Some(true)), TurnOutcome::Failed);
        }

        #[test]
        fn stop_reasons_owned_elsewhere_are_left_alone() {
            assert_eq!(classify_turn("cancelled", false, Some(true)), TurnOutcome::Ignore);
            assert_eq!(classify_turn("auth_required", false, Some(true)), TurnOutcome::Ignore);
        }

        /// A declared completion must not override a refusal — the turn still failed.
        #[test]
        fn the_marker_does_not_rescue_a_failed_turn() {
            assert_eq!(classify_turn("refusal", true, Some(true)), TurnOutcome::Failed);
        }
    }

    mod marker_filter {
        use super::*;

        #[test]
        fn ordinary_text_passes_through_untouched() {
            let mut filter = CompletionMarkerFilter::new();
            let (text, found) = filter.process_chunk("All done, the tests pass.");
            assert_eq!(text, "All done, the tests pass.");
            assert!(!found);
        }

        #[test]
        fn a_marker_is_stripped_and_reported() {
            let mut filter = CompletionMarkerFilter::new();
            let (text, found) = filter.process_chunk("Finished.<maestro-task-complete/>");
            assert_eq!(text, "Finished.");
            assert!(found);
        }

        #[test]
        fn text_around_a_marker_survives() {
            let mut filter = CompletionMarkerFilter::new();
            let (text, found) = filter.process_chunk("before<maestro-task-complete/>after");
            assert_eq!(text, "beforeafter");
            assert!(found);
        }

        /// The reason this is a stateful filter rather than a `contains` call.
        #[test]
        fn a_marker_split_across_chunks_is_still_caught() {
            let mut filter = CompletionMarkerFilter::new();

            let (first, found_first) = filter.process_chunk("Work is done. <maestro-task");
            assert_eq!(first, "Work is done. ");
            assert!(!found_first, "a partial marker must not fire");

            let (second, found_second) = filter.process_chunk("-complete/> bye");
            assert_eq!(second, " bye");
            assert!(found_second);
        }

        #[test]
        fn a_marker_split_one_byte_at_a_time_is_still_caught() {
            let mut filter = CompletionMarkerFilter::new();
            let mut forwarded = String::new();
            let mut found = false;

            for ch in format!("done {COMPLETION_MARKER} ok").chars() {
                let (text, hit) = filter.process_chunk(&ch.to_string());
                forwarded.push_str(&text);
                found |= hit;
            }
            forwarded.push_str(&filter.flush());

            assert_eq!(forwarded, "done  ok");
            assert!(found);
        }

        /// Text that merely starts like the marker must not be swallowed for ever.
        #[test]
        fn a_false_start_is_released_on_flush() {
            let mut filter = CompletionMarkerFilter::new();
            let (text, found) = filter.process_chunk("see <maestro-task");
            assert_eq!(text, "see ");
            assert!(!found);
            assert_eq!(filter.flush(), "<maestro-task");
        }

        #[test]
        fn two_markers_in_one_chunk_both_strip() {
            let mut filter = CompletionMarkerFilter::new();
            let (text, found) =
                filter.process_chunk("a<maestro-task-complete/>b<maestro-task-complete/>c");
            assert_eq!(text, "abc");
            assert!(found);
        }

        /// Holding back a partial match must not slice a multi-byte character.
        #[test]
        fn multibyte_text_is_not_split_mid_character() {
            let mut filter = CompletionMarkerFilter::new();
            let (text, _) = filter.process_chunk("résumé ✅ <");
            assert_eq!(text, "résumé ✅ ");
            assert_eq!(filter.flush(), "<");
        }
    }
}
