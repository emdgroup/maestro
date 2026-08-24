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

/// What the review agent concluded.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReviewVerdict {
    Approved,
    ChangesRequested,
}

/// Read the review agent's verdict off the first line of its reply.
///
/// A line of ordinary text rather than a hidden marker, because unlike the completion marker this
/// is something the user should see: it is the headline of the verdict stored in the outcome
/// thread, and stripping it would leave the thread saying nothing about the conclusion.
///
/// **Anything unrecognised is `Approved`**, which does not mean "the code is fine" — it means the
/// task goes to the human gate. The asymmetry is deliberate: a reviewer whose reply we cannot
/// parse must not be able to spend another coder round on the strength of a guess, and the gate
/// is where an unreviewed task would have gone anyway.
pub fn classify_verdict(reply: &str) -> ReviewVerdict {
    let first_line = reply.lines().map(str::trim).find(|line| !line.is_empty()).unwrap_or("");
    // Tolerates the decorations agents reach for — `**CHANGES REQUESTED**`, `## Changes requested`,
    // a trailing colon — without accepting the phrase buried in a paragraph.
    let normalised: String = first_line
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || c.is_whitespace())
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_uppercase();

    if normalised.starts_with("CHANGES REQUESTED") {
        ReviewVerdict::ChangesRequested
    } else {
        ReviewVerdict::Approved
    }
}

#[cfg(test)]
mod verdict_tests {
    use super::*;

    #[test]
    fn reads_the_verdict_off_the_first_line() {
        assert_eq!(classify_verdict("APPROVED\n\nLooks good."), ReviewVerdict::Approved);
        assert_eq!(
            classify_verdict("CHANGES REQUESTED\n\nThe null check is missing."),
            ReviewVerdict::ChangesRequested
        );
    }

    /// Agents decorate headings. None of these is a different verdict.
    #[test]
    fn tolerates_the_decorations_agents_reach_for() {
        for reply in [
            "**CHANGES REQUESTED**\n\nwhy",
            "## Changes Requested\n\nwhy",
            "changes requested:\n\nwhy",
            "\n\n  CHANGES REQUESTED  \nwhy",
        ] {
            assert_eq!(classify_verdict(reply), ReviewVerdict::ChangesRequested, "for {:?}", reply);
        }
    }

    /// The asymmetry that keeps the loop from spending a round on a guess: anything unparseable
    /// is approval, which means the human gate, not another coder.
    #[test]
    fn anything_unparseable_goes_to_the_human_rather_than_another_round() {
        for reply in [
            "",
            "I have some concerns about this change.",
            "The code looks fine but changes requested for the tests.",
            "Summary\n\nCHANGES REQUESTED",
        ] {
            assert_eq!(classify_verdict(reply), ReviewVerdict::Approved, "for {:?}", reply);
        }
    }
}

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

/// The agent's closing message for the current turn.
///
/// Not a transcript: the accumulator is cleared whenever the agent does something other than
/// speak, so what survives is the last run of prose before the turn ended — which is the summary
/// of what happened, not the narration of it happening. Everything earlier is still in the session
/// while the session lives, and the point of the outcome thread is what is left afterwards.
#[derive(Default)]
pub struct ClosingMessage {
    text: String,
}

impl ClosingMessage {
    /// Beyond this the entry stops being a summary and starts being a transcript. Agents that end
    /// a turn with a wall of text get the head of it, where the conclusion is.
    const MAX_BYTES: usize = 16 * 1024;

    pub fn push(&mut self, chunk: &str) {
        if self.text.len() >= Self::MAX_BYTES {
            return;
        }
        self.text.push_str(chunk);
        if self.text.len() > Self::MAX_BYTES {
            // Truncate on a character boundary — `String::truncate` panics otherwise, and agent
            // output is full of multi-byte characters.
            let mut cut = Self::MAX_BYTES;
            while cut > 0 && !self.text.is_char_boundary(cut) {
                cut -= 1;
            }
            self.text.truncate(cut);
            self.text.push_str("\n\n_(truncated)_");
        }
    }

    /// The agent did something other than talk, so anything said before it was working, not
    /// concluding.
    pub fn reset(&mut self) {
        self.text.clear();
    }

    pub fn take(&mut self) -> String {
        std::mem::take(&mut self.text)
    }
}

/// Accumulate an agent's prose and discard it again when the agent acts.
///
/// Called for every session update, so the decision about what counts as "acting" lives in one
/// place rather than being spread across the reader.
pub(crate) fn track_closing_message(
    payload: &serde_json::Value,
    text: Option<&str>,
    closing_message: &std::sync::Arc<std::sync::Mutex<ClosingMessage>>,
) {
    let Ok(mut closing) = closing_message.lock() else {
        return;
    };

    match payload.get("sessionUpdate").and_then(|v| v.as_str()) {
        Some("agent_message_chunk") => {
            if let Some(text) = text {
                closing.push(text);
            }
        }
        // A *new* tool call is the agent acting, so whatever it said beforehand was narration.
        // A user message means the prose before it belongs to an earlier exchange.
        Some("tool_call") | Some("user_message_chunk") => closing.reset(),
        // Everything else — thoughts, plans, mode changes, and crucially `tool_call_update` — is
        // not the agent acting. `tool_call_update` is the status of a call already made, and it
        // can arrive *after* the agent's closing words: `ExitPlanMode` is the tool every role held
        // in plan mode ends its turn on, and resolving it last used to wipe the closing message.
        // That left the proposal and plan gates with nothing to show and their accept buttons
        // disabled, and made an empty reviewer verdict classify as `Approved`.
        _ => {}
    }
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

    mod closing_message {
        use super::*;

        fn update(kind: &str) -> serde_json::Value {
            serde_json::json!({ "sessionUpdate": kind })
        }

        fn track(updates: &[(&str, Option<&str>)]) -> String {
            let closing = std::sync::Arc::new(std::sync::Mutex::new(ClosingMessage::default()));
            for (kind, text) in updates {
                track_closing_message(&update(kind), *text, &closing);
            }
            let mut guard = closing.lock().unwrap();
            guard.take()
        }

        #[test]
        fn the_last_run_of_prose_survives_and_the_narration_before_it_does_not() {
            let closing = track(&[
                ("agent_message_chunk", Some("let me look at that")),
                ("tool_call", None),
                ("agent_message_chunk", Some("here is what I found")),
            ]);
            assert_eq!(closing, "here is what I found");
        }

        /// The defect this pass found. `ExitPlanMode` is the tool every role held in plan mode ends
        /// its turn on, and its completion arrives after the agent has finished speaking. Treating
        /// that as "the agent acted" emptied the buffer, which left the proposal and plan gates
        /// with nothing to show and no way to accept, and made an empty reviewer verdict read as
        /// approval.
        #[test]
        fn a_tool_finishing_after_the_agent_speaks_does_not_wipe_the_message() {
            let closing = track(&[
                ("tool_call", None),
                ("agent_message_chunk", Some("the plan is above")),
                ("tool_call_update", None),
            ]);
            assert_eq!(closing, "the plan is above");
        }

        #[test]
        fn thoughts_plans_and_mode_changes_leave_the_message_alone() {
            let closing = track(&[
                ("agent_message_chunk", Some("done")),
                ("agent_thought_chunk", Some("reconsidering")),
                ("plan", None),
                ("current_mode_update", None),
            ]);
            assert_eq!(closing, "done");
        }

        #[test]
        fn a_user_turn_discards_what_the_agent_said_before_it() {
            let closing = track(&[
                ("agent_message_chunk", Some("anything else?")),
                ("user_message_chunk", Some("yes, do this")),
                ("agent_message_chunk", Some("finished")),
            ]);
            assert_eq!(closing, "finished");
        }
    }

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
