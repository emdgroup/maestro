//! The completion marker an agent ends its work with, stripped from what the user sees, and the
//! review loop's round cap. The daemon decides what a turn ending means (`maestro-server/src/turn.rs`).

/// Emitted by the agent when it considers the task complete. Stripped before display.
///
/// A fixed tag rather than a phrase because a phrase gets paraphrased, quoted back, and written
/// into commit messages. The agent is asked for it by a one-line instruction appended to the
/// prompt the daemon composes (`maestro-server/src/task_prompt.rs`).
pub const COMPLETION_MARKER: &str = "<maestro-task-complete/>";

/// How many times the review agent may send a task back before the user has to look at it.
///
/// Non-negotiable rather than configurable: this is the one place in the pipeline where agents
/// hand work to each other with nobody in between, so the loop needs an end that is not "until
/// the reviewer is satisfied". A reviewer and a coder that disagree about the same code will
/// disagree about it indefinitely, and every round costs money.
///
/// Send-backs, not reviews — `review_rounds` reaches this number and stops, the same way
/// `fix_rounds` does against `FIX_ROUND_CAP`. So a task that never satisfies its reviewer pays for
/// three reviews and three coder rounds, and the fourth review is not bought: `reviewer_should_run`
/// declines it and the user gets the work instead.
pub const REVIEW_ROUND_CAP: i32 = 3;

/// Whether the loop may send a task back once more.
///
/// One predicate for both guards — `reviewer_should_run` before a reviewer is started, and the
/// verdict handler before one is acted on. They were written with different comparisons, and that
/// disagreement is the whole bug: the verdict handler tested `rounds + 1`, so it escalated a round
/// early and spent the cap on two send-backs, which in turn made the other guard unreachable.
pub fn review_rounds_remain(rounds: i32) -> bool {
    rounds < REVIEW_ROUND_CAP
}

/// Strips [`COMPLETION_MARKER`] out of streamed agent text and reports whether it was seen.
///
/// The marker can be split across stream chunks, so text that could still turn out to be the
/// start of one is held back until the next chunk resolves it.
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

#[cfg(test)]
mod tests {
    use super::*;

    mod review_loop {
        use super::*;

        /// The cap counts send-backs, and the number in the constant is the number the loop gets —
        /// which it did not: the verdict handler compared `rounds + 1` and stopped at two, while
        /// `reviewer_should_run` compared `rounds` and so could never fire. One predicate now, and
        /// this is the arithmetic both of them read.
        #[test]
        fn the_cap_is_the_number_of_send_backs_the_loop_gets() {
            let send_backs = (0..)
                .take_while(|rounds| review_rounds_remain(*rounds))
                .count();
            assert_eq!(
                send_backs as i32, REVIEW_ROUND_CAP,
                "a task rejected every time must be sent back REVIEW_ROUND_CAP times"
            );
        }

        /// The guard that stops the loop, and the one that stops paying for a verdict nobody can
        /// act on, have to agree about the round the loop ends on — the bug was that they did not.
        #[test]
        fn the_round_after_the_last_one_is_refused() {
            assert!(review_rounds_remain(REVIEW_ROUND_CAP - 1));
            assert!(!review_rounds_remain(REVIEW_ROUND_CAP));
            // A count that somehow ran past the cap must not wrap back into "carry on".
            assert!(!review_rounds_remain(REVIEW_ROUND_CAP + 1));
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
