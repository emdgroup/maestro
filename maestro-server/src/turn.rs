//! What a task turn's end means, followed in the daemon.
//!
//! A turn ending is not the same as the task being done: an agent that stops to ask a question
//! ends its turn exactly like one that finished the job. This module holds what tells them apart
//! (the completion marker the agent emits, the closing words it ends on, whether the user stopped
//! it) per session, and the pure classification of a turn from those facts.
//!
//! A port of the app's `acp/completion.rs`, which still does the same on its own side until the
//! pipeline moves here. Detection only: the marker is not stripped from what windows are sent,
//! because the app still strips it itself and has to see it to do so.
// ponytail: the classifiers have no caller until the daemon drives the pipeline.
#![allow(dead_code)]

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

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
    let first_line = reply
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("");
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
        assert_eq!(
            classify_verdict("APPROVED\n\nLooks good."),
            ReviewVerdict::Approved
        );
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
            assert_eq!(
                classify_verdict(reply),
                ReviewVerdict::ChangesRequested,
                "for {:?}",
                reply
            );
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
            assert_eq!(
                classify_verdict(reply),
                ReviewVerdict::Approved,
                "for {:?}",
                reply
            );
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
/// `user_interrupted` outranks everything, including the stop reason. The reason cannot be relied
/// on to report a stop the user asked for: agents disagree about what an interrupted turn answers,
/// and a coder that had already touched files answering `end_turn` is indistinguishable from one
/// that finished — which handed the task to the next role moments after the user stopped it.
///
/// Unrecognised stop reasons are treated as failures rather than ignored: a new one appearing
/// should surface on the board, not leave a task running forever with nothing happening.
pub fn classify_turn(
    stop_reason: &str,
    declared_complete: bool,
    has_changes: Option<bool>,
    user_interrupted: bool,
) -> TurnOutcome {
    if user_interrupted {
        return TurnOutcome::Ignore;
    }
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

/// What the stream told us about one turn, read once when it ends.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct TurnFacts {
    /// The agent emitted [`COMPLETION_MARKER`].
    pub declared_complete: bool,
    /// The user asked for the turn to stop.
    pub user_interrupted: bool,
    /// The agent's last run of prose, marker removed, or `None` if it said nothing.
    pub closing_message: Option<String>,
}

#[derive(Default)]
struct TurnState {
    filter: CompletionMarkerFilter,
    declared_complete: bool,
    user_interrupted: bool,
    closing: ClosingMessage,
}

/// Per session, keyed by routing id. An entry is dropped when its turn's facts are taken, which
/// happens at every turn end, so this holds at most one turn per live session.
static TURNS: LazyLock<Mutex<HashMap<String, TurnState>>> = LazyLock::new(Default::default);

fn with_state(session_id: &str, f: impl FnOnce(&mut TurnState)) {
    if let Ok(mut turns) = TURNS.lock() {
        f(turns.entry(session_id.to_string()).or_default());
    }
}

/// A prompt was sent: whatever an earlier turn left behind does not belong to this one.
pub(crate) fn note_turn_started(session_id: &str) {
    if let Ok(mut turns) = TURNS.lock() {
        turns.remove(session_id);
    }
}

/// The user asked the session to stop its turn.
pub(crate) fn note_interrupted(session_id: &str) {
    with_state(session_id, |state| state.user_interrupted = true);
}

/// Follow one session update: spot the marker in agent text, and keep the closing words by the
/// app's rules. A new tool call or a user message clears them; a `tool_call_update` does not,
/// since `ExitPlanMode` resolves after the agent's closing words.
pub(crate) fn note_update(session_id: &str, payload: &serde_json::Value) {
    match payload.get("sessionUpdate").and_then(|v| v.as_str()) {
        Some("agent_message_chunk") => {
            let Some(text) = payload
                .get("content")
                .and_then(|c| c.get("text"))
                .and_then(|t| t.as_str())
            else {
                return;
            };
            with_state(session_id, |state| {
                let (forward, found) = state.filter.process_chunk(text);
                state.declared_complete |= found;
                state.closing.push(&forward);
            });
        }
        Some("tool_call") | Some("user_message_chunk") => {
            with_state(session_id, |state| state.closing.reset());
        }
        _ => {}
    }
}

/// Read and forget what the session's current turn produced.
pub(crate) fn take_turn_facts(session_id: &str) -> TurnFacts {
    let state = TURNS
        .lock()
        .ok()
        .and_then(|mut turns| turns.remove(session_id))
        .unwrap_or_default();
    let mut closing = state.closing;
    let message = closing.take();
    TurnFacts {
        declared_complete: state.declared_complete,
        user_interrupted: state.user_interrupted,
        closing_message: (!message.trim().is_empty()).then_some(message),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    mod turn_facts {
        use super::*;

        fn update(kind: &str, text: Option<&str>) -> serde_json::Value {
            match text {
                Some(text) => serde_json::json!({
                    "sessionUpdate": kind,
                    "content": { "type": "text", "text": text },
                }),
                None => serde_json::json!({ "sessionUpdate": kind }),
            }
        }

        /// Each test uses its own session id, since the state is process-wide.
        fn run(sid: &str, updates: &[(&str, Option<&str>)]) -> TurnFacts {
            note_turn_started(sid);
            for (kind, text) in updates {
                note_update(sid, &update(kind, *text));
            }
            take_turn_facts(sid)
        }

        #[test]
        fn the_last_run_of_prose_survives_and_the_narration_before_it_does_not() {
            let facts = run(
                "closing-1",
                &[
                    ("agent_message_chunk", Some("let me look at that")),
                    ("tool_call", None),
                    ("agent_message_chunk", Some("here is what I found")),
                ],
            );
            assert_eq!(
                facts.closing_message.as_deref(),
                Some("here is what I found")
            );
        }

        /// `ExitPlanMode` resolves after the agent has finished speaking.
        #[test]
        fn a_tool_finishing_after_the_agent_speaks_does_not_wipe_the_message() {
            let facts = run(
                "closing-2",
                &[
                    ("tool_call", None),
                    ("agent_message_chunk", Some("the plan is above")),
                    ("tool_call_update", None),
                ],
            );
            assert_eq!(facts.closing_message.as_deref(), Some("the plan is above"));
        }

        #[test]
        fn thoughts_plans_and_mode_changes_leave_the_message_alone() {
            let facts = run(
                "closing-3",
                &[
                    ("agent_message_chunk", Some("done")),
                    ("agent_thought_chunk", Some("reconsidering")),
                    ("plan", None),
                    ("current_mode_update", None),
                ],
            );
            assert_eq!(facts.closing_message.as_deref(), Some("done"));
        }

        #[test]
        fn a_user_turn_discards_what_the_agent_said_before_it() {
            let facts = run(
                "closing-4",
                &[
                    ("agent_message_chunk", Some("anything else?")),
                    ("user_message_chunk", Some("yes, do this")),
                    ("agent_message_chunk", Some("finished")),
                ],
            );
            assert_eq!(facts.closing_message.as_deref(), Some("finished"));
        }

        #[test]
        fn a_turn_that_said_nothing_has_no_closing_message() {
            assert_eq!(
                run("closing-5", &[("tool_call", None)]),
                TurnFacts::default()
            );
        }

        #[test]
        fn a_marker_split_across_chunks_is_declared_and_kept_out_of_the_message() {
            let facts = run(
                "marker-1",
                &[
                    ("agent_message_chunk", Some("Work is done. <maestro-task")),
                    ("agent_message_chunk", Some("-complete/> bye")),
                ],
            );
            assert!(facts.declared_complete);
            assert_eq!(facts.closing_message.as_deref(), Some("Work is done.  bye"));
        }

        #[test]
        fn a_turn_without_the_marker_is_not_declared() {
            let facts = run("marker-2", &[("agent_message_chunk", Some("a question?"))]);
            assert!(!facts.declared_complete);
        }

        #[test]
        fn an_interrupt_is_reported_once_and_cleared_by_the_next_turn() {
            note_turn_started("interrupt-1");
            note_interrupted("interrupt-1");
            assert!(take_turn_facts("interrupt-1").user_interrupted);
            assert!(!take_turn_facts("interrupt-1").user_interrupted);

            note_interrupted("interrupt-1");
            note_turn_started("interrupt-1");
            assert!(!take_turn_facts("interrupt-1").user_interrupted);
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
            assert_eq!(
                classify_turn("end_turn", true, Some(false), false),
                TurnOutcome::Complete
            );
            assert_eq!(
                classify_turn("end_turn", true, Some(true), false),
                TurnOutcome::Complete
            );
            assert_eq!(
                classify_turn("end_turn", true, None, false),
                TurnOutcome::Complete
            );
        }

        /// The bug this whole module exists for: a turn that ended with a question, not work.
        #[test]
        fn a_turn_that_changed_nothing_is_a_stall_not_a_completion() {
            assert_eq!(
                classify_turn("end_turn", false, Some(false), false),
                TurnOutcome::Stalled
            );
        }

        #[test]
        fn a_turn_that_changed_something_still_completes() {
            assert_eq!(
                classify_turn("end_turn", false, Some(true), false),
                TurnOutcome::Complete
            );
        }

        /// No repository means no evidence, so behave as the code did before the diff check.
        #[test]
        fn without_a_repository_a_turn_ending_completes() {
            assert_eq!(
                classify_turn("end_turn", false, None, false),
                TurnOutcome::Complete
            );
        }

        #[test]
        fn bad_stop_reasons_fail_the_phase() {
            for reason in [
                "refusal",
                "max_tokens",
                "max_turn_requests",
                "error",
                "unknown",
            ] {
                assert_eq!(
                    classify_turn(reason, false, Some(true), false),
                    TurnOutcome::Failed,
                    "for {reason}"
                );
            }
        }

        /// A stop reason we have never seen must surface, not vanish.
        #[test]
        fn an_unrecognised_stop_reason_fails_rather_than_being_ignored() {
            assert_eq!(
                classify_turn("something_new", false, Some(true), false),
                TurnOutcome::Failed
            );
        }

        #[test]
        fn stop_reasons_owned_elsewhere_are_left_alone() {
            assert_eq!(
                classify_turn("cancelled", false, Some(true), false),
                TurnOutcome::Ignore
            );
            assert_eq!(
                classify_turn("auth_required", false, Some(true), false),
                TurnOutcome::Ignore
            );
        }

        /// A declared completion must not override a refusal — the turn still failed.
        #[test]
        fn the_marker_does_not_rescue_a_failed_turn() {
            assert_eq!(
                classify_turn("refusal", true, Some(true), false),
                TurnOutcome::Failed
            );
        }

        /// The bug: a user who joined a session and pressed stop watched the board start the next
        /// role anyway. `cancelled` was already ignored, but only some agents report it — a coder
        /// that answered `end_turn` having touched files was indistinguishable from one that had
        /// finished, so the phase completed and the pipeline handed the task on. The interrupt is
        /// known first-hand, so it decides on its own.
        #[test]
        fn a_turn_the_user_stopped_is_ignored_whatever_the_agent_reports() {
            for reason in ["end_turn", "cancelled", "refusal", "error", "something_new"] {
                assert_eq!(
                    classify_turn(reason, false, Some(true), true),
                    TurnOutcome::Ignore,
                    "for {reason}"
                );
            }
        }

        /// Not even the completion marker: an agent that declared itself done and was then stopped
        /// mid-turn still did not finish, and believing it would advance the task the stop was
        /// meant to hold.
        #[test]
        fn an_interrupt_outranks_a_declared_completion() {
            assert_eq!(
                classify_turn("end_turn", true, Some(true), true),
                TurnOutcome::Ignore
            );
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
