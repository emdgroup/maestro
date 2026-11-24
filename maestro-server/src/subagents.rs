//! Native ACP subagents: which of a session's child sessions are still working.
//!
//! An agent that runs a subagent as a child session (ACP `subagent_update`) can end the parent's
//! turn while the child keeps going. The session is still working then: the idle reaper must not
//! close it (closing a session cancels its children), and a task's turn is not over until its
//! children are. The window's composer is not held by this; only the daemon's view of the session
//! is. See `docs/subagents/design.md`, "Busy while subagents work".
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

use crate::helpers::TurnEnd;

#[derive(Default)]
struct Children {
    /// Child ACP session id → whether it is running or waiting on the user.
    working: HashMap<String, bool>,
    /// The parent's turn end, held while a child still works.
    held: Option<TurnEnd>,
}

/// Maestro session id → its subagents.
static SESSIONS: LazyLock<Mutex<HashMap<String, Children>>> = LazyLock::new(Default::default);

/// Whether a subagent state means it is still working. ACP's states are `running`,
/// `requires_action`, `idle` and `unknown`; anything newer counts as not working, so a state this
/// build does not know cannot pin a session open for ever.
pub(crate) fn is_working(state: &str) -> bool {
    matches!(state, "running" | "requires_action")
}

/// Records a subagent's latest state. Returns the parent's held turn end when this was the last
/// working child, for the caller to announce.
pub(crate) fn note_state(session_id: &str, child: &str, state: &str) -> Option<TurnEnd> {
    let mut sessions = SESSIONS.lock().unwrap_or_else(|e| e.into_inner());
    let entry = sessions.entry(session_id.to_string()).or_default();
    entry.working.insert(child.to_string(), is_working(state));
    if entry.working.values().any(|w| *w) {
        None
    } else {
        entry.held.take()
    }
}

/// How many of the session's subagents are still working.
pub(crate) fn working(session_id: &str) -> usize {
    SESSIONS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(session_id)
        .map_or(0, |c| c.working.values().filter(|w| **w).count())
}

/// Holds a turn end while subagents work. Gives it back when none does.
pub(crate) fn hold_turn_end(ended: TurnEnd) -> Option<TurnEnd> {
    let mut sessions = SESSIONS.lock().unwrap_or_else(|e| e.into_inner());
    match sessions.get_mut(&ended.session_id) {
        Some(c) if c.working.values().any(|w| *w) => {
            c.held = Some(ended);
            None
        }
        _ => Some(ended),
    }
}

/// A new turn started: one held from before is superseded, since this turn will end on its own.
pub(crate) fn turn_started(session_id: &str) {
    if let Some(c) = SESSIONS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get_mut(session_id)
    {
        c.held = None;
    }
}

/// The session is gone, and its subagents with it.
pub(crate) fn forget(session_id: &str) {
    SESSIONS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(session_id);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn turn_end(session_id: &str) -> TurnEnd {
        TurnEnd {
            session_id: session_id.to_string(),
            stop_reason: "end_turn".to_string(),
            facts: Default::default(),
            usage: None,
            model_usage: None,
            meter: Default::default(),
        }
    }

    #[test]
    fn a_turn_end_waits_for_the_last_working_child() {
        let sid = "subagents-hold";
        assert!(note_state(sid, "a", "running").is_none());
        assert!(note_state(sid, "b", "requires_action").is_none());
        assert_eq!(working(sid), 2);
        assert!(hold_turn_end(turn_end(sid)).is_none());

        assert!(note_state(sid, "a", "idle").is_none());
        let released = note_state(sid, "b", "unknown").expect("released with the last child");
        assert_eq!(released.session_id, sid);
        assert_eq!(working(sid), 0);
        forget(sid);
    }

    #[test]
    fn a_turn_end_passes_when_no_child_works() {
        let sid = "subagents-pass";
        assert!(hold_turn_end(turn_end(sid)).is_some());
        note_state(sid, "a", "idle");
        assert!(hold_turn_end(turn_end(sid)).is_some());
        forget(sid);
    }

    #[test]
    fn a_new_turn_drops_the_held_end() {
        let sid = "subagents-superseded";
        note_state(sid, "a", "running");
        assert!(hold_turn_end(turn_end(sid)).is_none());
        turn_started(sid);
        assert!(note_state(sid, "a", "idle").is_none());
        forget(sid);
    }
}
