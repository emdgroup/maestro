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
use maestro_protocol::{AddTaskCommentRequest, NewTaskComment, TaskRef};
use rusqlite::Connection;
use tauri::State;

use crate::acp::connection_server::{query_project_store, reply};
use crate::acp::transport::{ServerRequest, ServerResponse};
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

/// Record an agent's closing message, doing nothing when there is nothing worth keeping.
///
/// Best-effort by design: this runs from the turn-ended handler, where failing to write a note
/// must not stop the task moving. The caller logs rather than propagating.
pub fn record_outcome(conn: &Connection, task_id: i32, phase: Option<&str>, message: &str) {
    record_as(conn, task_id, kind_for_phase(phase), phase, message)
}

/// Record what an agent said when its turn ended without producing anything.
///
/// A deliverable exists only when the phase completed. A turn that failed or stalled still leaves
/// text worth keeping — the error, the question — but it is not a verdict, a plan or a proposal,
/// and filing it as one is not cosmetic: the gates read the thread by kind. A reviewer killed by a
/// session limit had `You've hit your session limit` stored as its verdict, which is what
/// `latest_of_kind(task, "verdict")` then returns; a planner dying the same way would offer its
/// error to the plan gate as the plan to implement.
///
/// The phase is still recorded — it is where this happened, and useful — only the kind changes.
pub fn record_unfinished(conn: &Connection, task_id: i32, phase: Option<&str>, message: &str) {
    record_as(conn, task_id, "outcome", phase, message)
}

fn record_as(conn: &Connection, task_id: i32, kind: &str, phase: Option<&str>, message: &str) {
    let trimmed = message.trim();
    if trimmed.is_empty() {
        return;
    }

    if let Err(e) = append(conn, task_id, kind, "agent", Some(trimmed), None, phase) {
        log::warn!("[task] could not record the outcome of task {task_id}: {e}");
    }
}

/// Read a task's thread, oldest first.
#[tauri::command]
#[specta::specta]
pub async fn list_task_comments(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    task_id: i32,
) -> Result<Vec<TaskComment>, String> {
    let list = query_project_store(
        &app_state,
        project_id,
        |project_path| {
            ServerRequest::ListTaskComments(TaskRef {
                project_path,
                task_id,
            })
        },
        reply!(ServerResponse::ListTaskCommentsOk(list) => list),
    )
    .await?;
    Ok(list.comments.into_iter().map(Into::into).collect())
}

/// Add a note of the user's own to a task's thread.
///
/// Only `note` is writable from the UI. The typed kinds are produced by the pipeline and stand as
/// the record of what an agent concluded — letting a user post one by hand would make "the plan
/// the gate approved" something anybody could forge after the fact.
#[tauri::command]
#[specta::specta]
pub async fn add_task_note(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    task_id: i32,
    body: String,
) -> Result<TaskComment, String> {
    let body = body.trim();
    if body.is_empty() {
        return Err("A note cannot be empty".to_string());
    }
    let comment = query_project_store(
        &app_state,
        project_id,
        |project_path| {
            ServerRequest::AddTaskComment(AddTaskCommentRequest {
                project_path,
                task_id,
                comment: NewTaskComment {
                    kind: "note".to_string(),
                    author: "user".to_string(),
                    body: Some(body.to_string()),
                    external_ref: None,
                    phase: None,
                },
            })
        },
        reply!(ServerResponse::AddTaskCommentOk(comment) => comment),
    )
    .await?;
    Ok(comment.into())
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

        let referenced = append(
            &conn,
            task_id,
            "plan",
            "agent",
            None,
            Some("blob://1"),
            None,
        )
        .unwrap();
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
            .query_row(
                "SELECT body FROM task_comments WHERE task_id = ?",
                [task_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            body, "finished",
            "surrounding whitespace should not be stored"
        );
    }

    /// `kind_for_phase` answers "what does this role deliver", which is the wrong question for a
    /// turn that produced nothing. Observed live: a reviewer killed by a session limit had
    /// "You've hit your session limit" filed as its verdict, so that is what
    /// `latest_of_kind(task, "verdict")` returned. A planner dying the same way would have offered
    /// its error to the plan gate as the plan to implement.
    #[test]
    fn a_phase_that_produced_nothing_files_no_deliverable() {
        for phase in ["SelfReview", "Drafting", "Refining"] {
            let (conn, task_id) = db_with_task();

            record_unfinished(&conn, task_id, Some(phase), "You've hit your session limit");

            assert_eq!(
                kinds(&conn, task_id),
                vec!["outcome".to_string()],
                "{phase} must not file an error as its deliverable"
            );
            assert_ne!(
                kind_for_phase(Some(phase)),
                "outcome",
                "{phase} needs a deliverable kind of its own for this test to mean anything"
            );

            // Where it happened is still worth keeping; only what it counts as changes.
            let stored: Option<String> = conn
                .query_row(
                    "SELECT phase FROM task_comments WHERE task_id = ?",
                    [task_id],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(stored.as_deref(), Some(phase));
        }
    }

    /// The thread is a history, so entries accumulate rather than replacing one another — this is
    /// what `task_reviews`' `NOT NULL UNIQUE` got wrong and why a second review always failed.
    /// A verdict in particular is a round that happened, and `review_rounds` counts them.
    #[test]
    fn entries_accumulate_rather_than_replacing() {
        let (conn, task_id) = db_with_task();

        append(
            &conn,
            task_id,
            "verdict",
            "agent",
            Some("first pass"),
            None,
            None,
        )
        .unwrap();
        append(
            &conn,
            task_id,
            "verdict",
            "agent",
            Some("second pass"),
            None,
            None,
        )
        .unwrap();

        assert_eq!(
            kinds(&conn, task_id),
            vec!["verdict".to_string(), "verdict".to_string()]
        );
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
        let bodies: Vec<String> = conn
            .prepare("SELECT body FROM task_comments WHERE task_id = ? ORDER BY id ASC")
            .unwrap()
            .query_map([task_id], |row| row.get(0))
            .unwrap()
            .filter_map(|row| row.ok())
            .collect();
        assert_eq!(bodies, vec!["second attempt", "second plan"]);
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

        assert_eq!(
            kinds(&conn, task_id),
            vec!["proposal", "plan", "verdict", "outcome"]
        );
    }
}
