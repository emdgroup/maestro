//! The task's outcome thread.
//!
//! What survives a task is what the agents concluded, not how they got there: once a session
//! closes its transcript is gone, and the closing message, the plan, the review verdict and the
//! user's own notes are all that is left to say what happened. They live here, in Maestro's own
//! database rather than in the project, because for an SSH or WSL project the project is on the
//! remote host — where the coder could read and rewrite its own record.
//!
//! Entries are never edited, and a correction is a new entry, so the thread reads as a history
//! rather than a mutable summary. That is also what makes it safe for a gate to point at one: the
//! entry a plan gate approved cannot change under it.
//!
//! Two kinds are not history, and [`holds_a_single_value`] says which. A proposal and a plan are
//! both *about the task as it stands now*: re-running the refiner reads the description it has
//! already been given and answers again, so the previous answer is not a past event, it is a stale
//! copy of a field that has since moved. A verdict is the opposite — each one is a review round
//! that happened, and `review_rounds` counts them.

use std::sync::Arc;

use chrono::Utc;
use rusqlite::Connection;
use tauri::{Emitter, State};

use crate::core::AppState;
use crate::models::TaskComment;

/// Whether a kind is the task's current answer rather than one of a series.
///
/// See the module docs: re-running a refiner or a planner replaces what the last run said about a
/// task, because both read the task as it stands and neither is a record of something that
/// happened to it. Everything else accumulates.
pub fn holds_a_single_value(kind: &str) -> bool {
    matches!(kind, "proposal" | "plan")
}

/// Write one entry, returning it as stored.
///
/// Takes a `&Connection` so a caller already inside a transaction — recording an outcome as part
/// of a phase transition — can write both atomically rather than leaving a task that moved on with
/// no record of why.
pub fn append(
    conn: &Connection,
    task_id: i32,
    kind: &str,
    author: &str,
    body: Option<&str>,
    external_ref: Option<&str>,
    phase: Option<&str>,
) -> Result<TaskComment, String> {
    if holds_a_single_value(kind) {
        conn.execute(
            "DELETE FROM task_comments WHERE task_id = ? AND kind = ?",
            rusqlite::params![task_id, kind],
        )
        .map_err(|e| format!("Failed to replace task {} {}: {}", task_id, kind, e))?;
    }

    let now = Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO task_comments (task_id, kind, author, body, external_ref, phase, created_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?)",
        rusqlite::params![task_id, kind, author, body, external_ref, phase, &now],
    )
    .map_err(|e| format!("Failed to append to task {} thread: {}", task_id, e))?;

    Ok(TaskComment {
        id: conn.last_insert_rowid() as i32,
        task_id,
        kind: kind.to_string(),
        author: author.to_string(),
        body: body.map(str::to_string),
        external_ref: external_ref.map(str::to_string),
        phase: phase.map(str::to_string),
        created_at: now,
    })
}

/// What a phase's closing message *is*, which is not the same for every phase.
///
/// A gate has to be able to find the thing it gates on — "the latest proposal", "the latest plan"
/// — and searching the thread for the last entry that happened to be written during some phase
/// would break the moment a user note landed in between.
pub fn kind_for_phase(phase: Option<&str>) -> &'static str {
    match phase {
        Some("Refining") => "proposal",
        Some("Drafting") => "plan",
        Some("SelfReview") => "verdict",
        _ => "outcome",
    }
}

/// The latest entry of a kind, or `None` when the task has none.
pub fn latest_of_kind(
    conn: &Connection,
    task_id: i32,
    kind: &str,
) -> Result<Option<TaskComment>, String> {
    conn.query_row(
        "SELECT id, task_id, kind, author, body, external_ref, phase, created_at \
         FROM task_comments WHERE task_id = ? AND kind = ? ORDER BY id DESC LIMIT 1",
        rusqlite::params![task_id, kind],
        from_row,
    )
    .map(Some)
    .or_else(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => Ok(None),
        other => Err(format!("Failed to read task {} thread: {}", task_id, other)),
    })
}

/// Record an agent's closing message, doing nothing when there is nothing worth keeping.
///
/// Best-effort by design: this runs from the turn-ended handler, where failing to write a note
/// must not stop the task moving. The caller logs rather than propagating.
pub fn record_outcome(conn: &Connection, task_id: i32, phase: Option<&str>, message: &str) {
    let trimmed = message.trim();
    if trimmed.is_empty() {
        return;
    }

    let kind = kind_for_phase(phase);
    if let Err(e) = append(conn, task_id, kind, "agent", Some(trimmed), None, phase) {
        log::warn!("[task] could not record the outcome of task {task_id}: {e}");
    }
}

fn from_row(row: &rusqlite::Row) -> rusqlite::Result<TaskComment> {
    Ok(TaskComment {
        id: row.get(0)?,
        task_id: row.get(1)?,
        kind: row.get(2)?,
        author: row.get(3)?,
        body: row.get(4)?,
        external_ref: row.get(5)?,
        phase: row.get(6)?,
        created_at: row.get(7)?,
    })
}

/// Read a task's thread, oldest first.
///
/// Ordered by `id` rather than `created_at`: two entries written in the same phase transition can
/// share a timestamp to the second, and a thread that reorders itself on reload is worse than one
/// that is merely approximate about when things happened.
#[tauri::command]
#[specta::specta]
pub fn list_task_comments(
    app_state: State<'_, Arc<AppState>>,
    task_id: i32,
) -> Result<Vec<TaskComment>, String> {
    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
    let mut stmt = conn
        .prepare(
            "SELECT id, task_id, kind, author, body, external_ref, phase, created_at \
             FROM task_comments WHERE task_id = ? ORDER BY id ASC",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map([task_id], from_row)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(rows)
}

/// Add a note of the user's own to a task's thread.
///
/// Only `note` is writable from the UI. The typed kinds are produced by the pipeline and stand as
/// the record of what an agent concluded — letting a user post one by hand would make "the plan
/// the gate approved" something anybody could forge after the fact.
#[tauri::command]
#[specta::specta]
pub fn add_task_note(
    app_state: State<'_, Arc<AppState>>,
    task_id: i32,
    body: String,
) -> Result<TaskComment, String> {
    if body.trim().is_empty() {
        return Err("A note cannot be empty".to_string());
    }

    let comment = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        append(&conn, task_id, "note", "user", Some(body.trim()), None, None)?
    };

    app_state.app_handle.emit("task-comments-changed", task_id).ok();
    Ok(comment)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::schema::initialize_schema;

    fn db_with_task() -> (Connection, i32) {
        let conn = Connection::open_in_memory().expect("open in-memory database");
        initialize_schema(&conn).expect("initialize schema");
        conn.execute(
            "INSERT INTO projects (id, name, path, created_at, updated_at) \
             VALUES (1, 'demo', '/tmp/demo', '2026-01-01', '2026-01-01')",
            [],
        )
        .expect("insert project");
        conn.execute(
            "INSERT INTO tasks (id, project_id, title, status, base_branch, created_at, updated_at) \
             VALUES (1, 1, 'demo task', 'Queue', 'main', '2026-01-01', '2026-01-01')",
            [],
        )
        .expect("insert task");
        (conn, 1)
    }

    fn kinds(conn: &Connection, task_id: i32) -> Vec<String> {
        let mut stmt = conn
            .prepare("SELECT kind FROM task_comments WHERE task_id = ? ORDER BY id ASC")
            .unwrap();
        stmt.query_map([task_id], |row| row.get(0))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect()
    }

    #[test]
    fn an_entry_holds_either_a_body_or_a_reference() {
        let (conn, task_id) = db_with_task();

        let inline = append(&conn, task_id, "outcome", "agent", Some("done"), None, None).unwrap();
        assert_eq!(inline.body.as_deref(), Some("done"));
        assert_eq!(inline.external_ref, None);

        let referenced =
            append(&conn, task_id, "plan", "agent", None, Some("blob://1"), None).unwrap();
        assert_eq!(referenced.body, None);
        assert_eq!(referenced.external_ref.as_deref(), Some("blob://1"));
    }

    /// An agent that ends its turn with nothing to say must not leave an empty bubble on the task.
    #[test]
    fn an_empty_outcome_is_not_recorded() {
        let (conn, task_id) = db_with_task();

        record_outcome(&conn, task_id, Some("Implementing"), "   \n  ");
        assert!(kinds(&conn, task_id).is_empty());

        record_outcome(&conn, task_id, Some("Implementing"), "  finished  ");
        assert_eq!(kinds(&conn, task_id), vec!["outcome".to_string()]);

        let body: String = conn
            .query_row("SELECT body FROM task_comments WHERE task_id = ?", [task_id], |r| r.get(0))
            .unwrap();
        assert_eq!(body, "finished", "surrounding whitespace should not be stored");
    }

    /// The thread is a history, so entries accumulate rather than replacing one another — this is
    /// what `task_reviews`' `NOT NULL UNIQUE` got wrong and why a second review always failed.
    /// A verdict in particular is a round that happened, and `review_rounds` counts them.
    #[test]
    fn entries_accumulate_rather_than_replacing() {
        let (conn, task_id) = db_with_task();

        append(&conn, task_id, "verdict", "agent", Some("first pass"), None, None).unwrap();
        append(&conn, task_id, "verdict", "agent", Some("second pass"), None, None).unwrap();

        assert_eq!(kinds(&conn, task_id), vec!["verdict".to_string(), "verdict".to_string()]);
    }

    /// The exception. Re-running a refiner is not a second event, it is the same question asked
    /// again of a description that has since changed — so the previous answer is stale rather than
    /// historical, and leaving it stacked it above the current one with nothing to tell them apart.
    #[test]
    fn a_proposal_and_a_plan_replace_the_last_one_instead_of_stacking() {
        let (conn, task_id) = db_with_task();

        record_outcome(&conn, task_id, Some("Refining"), "first attempt");
        record_outcome(&conn, task_id, Some("Drafting"), "first plan");
        record_outcome(&conn, task_id, Some("Refining"), "second attempt");
        record_outcome(&conn, task_id, Some("Drafting"), "second plan");

        assert_eq!(kinds(&conn, task_id), vec!["proposal", "plan"]);
        assert_eq!(
            latest_of_kind(&conn, task_id, "proposal").unwrap().unwrap().body.unwrap(),
            "second attempt"
        );
        assert_eq!(
            latest_of_kind(&conn, task_id, "plan").unwrap().unwrap().body.unwrap(),
            "second plan"
        );
    }

    /// A gate has to find the thing it gates on. Typing the entry by the phase that produced it is
    /// what lets "the latest proposal" be a query rather than a guess about ordering.
    #[test]
    fn a_phases_closing_message_is_typed_by_what_it_is() {
        let (conn, task_id) = db_with_task();

        record_outcome(&conn, task_id, Some("Refining"), "sharper wording");
        record_outcome(&conn, task_id, Some("Drafting"), "step one, step two");
        record_outcome(&conn, task_id, Some("SelfReview"), "looks right");
        record_outcome(&conn, task_id, Some("Implementing"), "done");

        assert_eq!(kinds(&conn, task_id), vec!["proposal", "plan", "verdict", "outcome"]);
    }

    /// A gate reads its entry by kind, so entries of other kinds landing in between — a user note,
    /// a verdict — must not become what it finds. Superseding makes the proposal case unambiguous
    /// on its own, but the lookup is what the other kinds still rely on.
    #[test]
    fn the_latest_entry_of_a_kind_wins() {
        let (conn, task_id) = db_with_task();

        record_outcome(&conn, task_id, Some("Refining"), "first attempt");
        append(&conn, task_id, "note", "user", Some("not quite"), None, None).unwrap();
        record_outcome(&conn, task_id, Some("Refining"), "second attempt");

        let latest = latest_of_kind(&conn, task_id, "proposal").unwrap().unwrap();
        assert_eq!(latest.body.as_deref(), Some("second attempt"));
    }

    #[test]
    fn a_task_with_no_entry_of_that_kind_reports_none() {
        let (conn, task_id) = db_with_task();
        assert!(latest_of_kind(&conn, task_id, "proposal").unwrap().is_none());
    }
}
