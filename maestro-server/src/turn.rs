//! What a task turn's end means, followed in the daemon.
//!
//! A turn ending is not the same as the task being done: an agent that stops to ask a question
//! ends its turn exactly like one that finished the job. This module holds what tells them apart
//! (the completion marker the agent emits, the closing words it ends on, whether the user stopped
//! it) per session, and the pure classification of a turn from those facts.
//!
//! The marker itself, its streaming filter and the review cap are `maestro_protocol::completion`,
//! shared with the app. Detection only: the marker is not stripped from what windows are sent,
//! because the app still strips it itself and has to see it to do so.
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

use maestro_protocol::completion::CompletionMarkerFilter;

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
    /// a turn with a wall of text get the head of it, where the conclusion is. Generous because an
    /// automation's result is this message, read whole in its run's dialog.
    const MAX_BYTES: usize = 64 * 1024;

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
    /// The agent emitted [`maestro_protocol::completion::COMPLETION_MARKER`].
    pub declared_complete: bool,
    /// The user asked for the turn to stop.
    pub user_interrupted: bool,
    /// The agent's last run of prose, marker removed, or `None` if it said nothing.
    pub closing_message: Option<String>,
    /// The agent refused the prompt for a usage limit.
    pub usage_limited: bool,
    /// The last plan-limit reading the turn carried.
    pub plan_reading: Option<crate::agent_gate::PlanReading>,
}

#[derive(Default)]
struct TurnState {
    filter: CompletionMarkerFilter,
    declared_complete: bool,
    user_interrupted: bool,
    closing: ClosingMessage,
    usage_limited: bool,
    plan_reading: Option<crate::agent_gate::PlanReading>,
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
        Some("usage_update") => {
            if let Some(reading) = crate::agent_gate::reading(payload) {
                with_state(session_id, |state| state.plan_reading = Some(reading));
            }
        }
        _ => {}
    }
}

/// The agent refused the prompt for a usage limit.
pub(crate) fn note_usage_limited(session_id: &str) {
    with_state(session_id, |state| state.usage_limited = true);
}

/// Read and forget what the session's current turn produced.
pub(crate) fn take_turn_facts(session_id: &str) -> TurnFacts {
    let mut state = TURNS
        .lock()
        .ok()
        .and_then(|mut turns| turns.remove(session_id))
        .unwrap_or_default();
    // What the filter held back as a possible marker never became one.
    let held = state.filter.flush();
    state.closing.push(&held);
    let message = state.closing.take();
    TurnFacts {
        declared_complete: state.declared_complete,
        user_interrupted: state.user_interrupted,
        closing_message: (!message.trim().is_empty()).then_some(message),
        usage_limited: state.usage_limited,
        plan_reading: state.plan_reading,
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
        fn a_turn_keeps_its_last_plan_reading_and_its_refusal() {
            let sid = "facts-plan-reading";
            note_turn_started(sid);
            note_update(
                sid,
                &serde_json::json!({
                    "sessionUpdate": "usage_update", "used": 1, "size": 2,
                    "_meta": {"_claude/rateLimit": {"status": "rejected", "resetsAt": 1234}}
                }),
            );
            note_usage_limited(sid);
            let facts = take_turn_facts(sid);
            assert!(facts.usage_limited);
            assert_eq!(
                facts.plan_reading,
                Some(crate::agent_gate::PlanReading {
                    resets_at: Some(1234),
                    window: None,
                })
            );
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
        fn text_that_only_looked_like_a_marker_is_kept() {
            let facts = run(
                "marker-3",
                &[("agent_message_chunk", Some("a < b and c <maestro"))],
            );
            assert!(!facts.declared_complete);
            assert_eq!(
                facts.closing_message.as_deref(),
                Some("a < b and c <maestro")
            );
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
}
