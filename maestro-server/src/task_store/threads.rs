//! What hangs off a task: its outcome thread, attachments, relationships and instruction log.
//!
//! The thread is a history: entries are never edited, and a correction is a new entry, so the entry
//! a gate approved cannot change under it. Two kinds are not history. A proposal and a plan are
//! both about the task as it stands, so a new one replaces the last rather than stacking on it.

use std::path::Path;

use chrono::Utc;
use maestro_protocol::{TaskAttachment, TaskComment, TaskInstruction, TaskRelationship};
use rusqlite::{params, Connection, OptionalExtension};

/// Whether a kind is the task's current answer rather than one of a series.
pub fn holds_a_single_value(kind: &str) -> bool {
    matches!(kind, "proposal" | "plan")
}

/// Write one entry, returning it as stored. A `proposal` or `plan` replaces the task's last one.
#[allow(clippy::too_many_arguments)]
pub fn append(
    conn: &Connection,
    project_path: &str,
    task_id: i32,
    kind: &str,
    author: &str,
    body: Option<&str>,
    external_ref: Option<&str>,
    phase: Option<&str>,
) -> Result<TaskComment, String> {
    if holds_a_single_value(kind) {
        conn.execute(
            "DELETE FROM task_comments WHERE project_path = ?1 AND task_id = ?2 AND kind = ?3",
            params![project_path, task_id, kind],
        )
        .map_err(|e| format!("Failed to replace task {task_id} {kind}: {e}"))?;
    }

    let now = Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO task_comments (project_path, task_id, kind, author, body, external_ref, phase,
                                    created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            project_path,
            task_id,
            kind,
            author,
            body,
            external_ref,
            phase,
            now
        ],
    )
    .map_err(|e| format!("Failed to append to task {task_id} thread: {e}"))?;

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

/// What a phase's closing message is, so a gate can find "the latest plan" by kind.
pub fn kind_for_phase(phase: Option<&str>) -> &'static str {
    match phase {
        Some("Refining") => "proposal",
        Some("Drafting") => "plan",
        Some("SelfReview") => "verdict",
        _ => "outcome",
    }
}

const COMMENT_SELECT: &str =
    "SELECT id, task_id, kind, author, body, external_ref, phase, created_at FROM task_comments";

fn comment_from_row(row: &rusqlite::Row) -> rusqlite::Result<TaskComment> {
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

pub fn latest_of_kind(
    conn: &Connection,
    project_path: &str,
    task_id: i32,
    kind: &str,
) -> Result<Option<TaskComment>, String> {
    conn.query_row(
        &format!(
            "{COMMENT_SELECT} WHERE project_path = ?1 AND task_id = ?2 AND kind = ?3
             ORDER BY id DESC LIMIT 1"
        ),
        params![project_path, task_id, kind],
        comment_from_row,
    )
    .optional()
    .map_err(|e| format!("Failed to read task {task_id} thread: {e}"))
}

/// Record an agent's closing message as what its phase delivers, doing nothing when there is
/// nothing worth keeping. Best-effort: failing to write a note must not stop the task moving.
pub fn record_outcome(
    conn: &Connection,
    project_path: &str,
    task_id: i32,
    phase: Option<&str>,
    message: &str,
) {
    record_as(
        conn,
        project_path,
        task_id,
        kind_for_phase(phase),
        phase,
        message,
    )
}

/// Record what an agent said when its turn ended without producing anything. Always an `outcome`:
/// the gates read the thread by kind, and a session-limit error filed as a verdict or a plan is
/// what they would then act on.
pub fn record_unfinished(
    conn: &Connection,
    project_path: &str,
    task_id: i32,
    phase: Option<&str>,
    message: &str,
) {
    record_as(conn, project_path, task_id, "outcome", phase, message)
}

fn record_as(
    conn: &Connection,
    project_path: &str,
    task_id: i32,
    kind: &str,
    phase: Option<&str>,
    message: &str,
) {
    let trimmed = message.trim();
    if trimmed.is_empty() {
        return;
    }
    if let Err(e) = append(
        conn,
        project_path,
        task_id,
        kind,
        "agent",
        Some(trimmed),
        None,
        phase,
    ) {
        crate::send_diag(
            "warn",
            format!("[task-store] could not record the outcome of task {task_id}: {e}"),
        );
    }
}

/// A task's thread, oldest first. By `id`, since two entries of one transition can share a
/// timestamp and a thread that reorders itself on reload is worse than an approximate one.
pub fn list_comments(
    conn: &Connection,
    project_path: &str,
    task_id: i32,
) -> Result<Vec<TaskComment>, String> {
    collect(
        conn,
        &format!("{COMMENT_SELECT} WHERE project_path = ?1 AND task_id = ?2 ORDER BY id ASC"),
        params![project_path, task_id],
        comment_from_row,
    )
}

fn collect<T>(
    conn: &Connection,
    sql: &str,
    args: impl rusqlite::Params,
    from_row: fn(&rusqlite::Row) -> rusqlite::Result<T>,
) -> Result<Vec<T>, String> {
    let mut statement = conn.prepare(sql).map_err(|e| e.to_string())?;
    let rows = statement
        .query_map(args, from_row)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

fn attachment_from_row(row: &rusqlite::Row) -> rusqlite::Result<TaskAttachment> {
    Ok(TaskAttachment {
        id: row.get(0)?,
        task_id: row.get(1)?,
        filename: row.get(2)?,
        file_path: row.get(3)?,
        file_size: row.get(4)?,
        created_at: row.get(5)?,
    })
}

const ATTACHMENT_SELECT: &str =
    "SELECT id, task_id, filename, file_path, file_size, created_at FROM task_attachments";

pub fn list_attachments(
    conn: &Connection,
    project_path: &str,
    task_id: i32,
) -> Result<Vec<TaskAttachment>, String> {
    collect(
        conn,
        &format!(
            "{ATTACHMENT_SELECT} WHERE project_path = ?1 AND task_id = ?2 ORDER BY created_at ASC"
        ),
        params![project_path, task_id],
        attachment_from_row,
    )
}

/// Record an attachment, returning the existing row when that file is already on the task: a
/// second row would be a second copy of the file in every prompt the task sends.
///
/// `file_path` is stored as given. A relative one is measured from the project, which is where the
/// copy made on attach will put it.
pub fn add_attachment(
    conn: &Connection,
    project_path: &str,
    task_id: i32,
    filename: &str,
    file_path: &str,
) -> Result<TaskAttachment, String> {
    let existing = conn
        .query_row(
            &format!(
                "{ATTACHMENT_SELECT} WHERE project_path = ?1 AND task_id = ?2 AND file_path = ?3"
            ),
            params![project_path, task_id, file_path],
            attachment_from_row,
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some(existing) = existing {
        return Ok(existing);
    }

    let file_size = std::fs::metadata(Path::new(project_path).join(file_path))
        .map(|m| m.len() as i64)
        .unwrap_or(0);
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO task_attachments (project_path, task_id, filename, file_path, file_size,
                                       created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![project_path, task_id, filename, file_path, file_size, now],
    )
    .map_err(|e| e.to_string())?;

    Ok(TaskAttachment {
        id: conn.last_insert_rowid() as i32,
        task_id,
        filename: filename.to_string(),
        file_path: file_path.to_string(),
        file_size,
        created_at: now,
    })
}

pub fn delete_attachment(
    conn: &Connection,
    project_path: &str,
    attachment_id: i32,
) -> Result<(), String> {
    conn.execute(
        "DELETE FROM task_attachments WHERE project_path = ?1 AND id = ?2",
        params![project_path, attachment_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Every relationship the task is on either end of.
pub fn list_relationships(
    conn: &Connection,
    project_path: &str,
    task_id: i32,
) -> Result<Vec<TaskRelationship>, String> {
    collect(
        conn,
        "SELECT id, from_task_id, to_task_id, relationship_type, created_at
         FROM task_relationships
         WHERE project_path = ?1 AND (from_task_id = ?2 OR to_task_id = ?2)",
        params![project_path, task_id],
        |row| {
            Ok(TaskRelationship {
                id: row.get(0)?,
                from_task_id: row.get(1)?,
                to_task_id: row.get(2)?,
                relationship_type: row.get(3)?,
                created_at: row.get(4)?,
            })
        },
    )
}

pub fn add_relationship(
    conn: &Connection,
    project_path: &str,
    from_task_id: i32,
    to_task_id: i32,
    relationship_type: &str,
) -> Result<TaskRelationship, String> {
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO task_relationships (project_path, from_task_id, to_task_id,
                                         relationship_type, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            project_path,
            from_task_id,
            to_task_id,
            relationship_type,
            now
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(TaskRelationship {
        id: conn.last_insert_rowid() as i32,
        from_task_id,
        to_task_id,
        relationship_type: relationship_type.to_string(),
        created_at: now,
    })
}

pub fn delete_relationship(
    conn: &Connection,
    project_path: &str,
    relationship_id: i32,
) -> Result<(), String> {
    conn.execute(
        "DELETE FROM task_relationships WHERE project_path = ?1 AND id = ?2",
        params![project_path, relationship_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn list_instructions(
    conn: &Connection,
    project_path: &str,
    task_id: i32,
) -> Result<Vec<TaskInstruction>, String> {
    collect(
        conn,
        "SELECT id, task_id, content, source, created_at FROM task_instructions
         WHERE project_path = ?1 AND task_id = ?2 ORDER BY created_at ASC",
        params![project_path, task_id],
        |row| {
            Ok(TaskInstruction {
                id: row.get(0)?,
                task_id: row.get(1)?,
                content: row.get(2)?,
                source: row.get(3)?,
                created_at: row.get(4)?,
            })
        },
    )
}

pub fn add_instruction(
    conn: &Connection,
    project_path: &str,
    task_id: i32,
    content: &str,
    source: &str,
) -> Result<TaskInstruction, String> {
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO task_instructions (project_path, task_id, content, source, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![project_path, task_id, content, source, now],
    )
    .map_err(|e| e.to_string())?;
    Ok(TaskInstruction {
        id: conn.last_insert_rowid() as i32,
        task_id,
        content: content.to_string(),
        source: source.to_string(),
        created_at: now,
    })
}

#[cfg(test)]
mod tests {
    use super::super::tests::{db_with_task, PROJECT};
    use super::*;

    fn kinds(conn: &Connection, task_id: i32) -> Vec<String> {
        list_comments(conn, PROJECT, task_id)
            .expect("list")
            .into_iter()
            .map(|comment| comment.kind)
            .collect()
    }

    fn note(conn: &Connection, task_id: i32, kind: &str, body: &str) -> TaskComment {
        append(
            conn,
            PROJECT,
            task_id,
            kind,
            "agent",
            Some(body),
            None,
            None,
        )
        .expect("append")
    }

    #[test]
    fn an_entry_holds_either_a_body_or_a_reference() {
        let (conn, task_id) = db_with_task();
        let inline = note(&conn, task_id, "outcome", "done");
        assert_eq!(inline.body.as_deref(), Some("done"));
        assert_eq!(inline.external_ref, None);

        let referenced = append(
            &conn,
            PROJECT,
            task_id,
            "plan",
            "agent",
            None,
            Some("blob://1"),
            None,
        )
        .expect("append");
        assert_eq!(referenced.body, None);
        assert_eq!(referenced.external_ref.as_deref(), Some("blob://1"));
    }

    #[test]
    fn an_empty_outcome_is_not_recorded_and_whitespace_is_trimmed() {
        let (conn, task_id) = db_with_task();
        record_outcome(&conn, PROJECT, task_id, Some("Implementing"), "   \n  ");
        assert!(kinds(&conn, task_id).is_empty());

        record_outcome(
            &conn,
            PROJECT,
            task_id,
            Some("Implementing"),
            "  finished  ",
        );
        let thread = list_comments(&conn, PROJECT, task_id).expect("list");
        assert_eq!(thread.len(), 1);
        assert_eq!(thread[0].kind, "outcome");
        assert_eq!(thread[0].body.as_deref(), Some("finished"));
    }

    /// A reviewer killed by a session limit once had the error filed as its verdict.
    #[test]
    fn a_phase_that_produced_nothing_files_no_deliverable() {
        for phase in ["SelfReview", "Drafting", "Refining"] {
            let (conn, task_id) = db_with_task();
            record_unfinished(
                &conn,
                PROJECT,
                task_id,
                Some(phase),
                "You've hit your limit",
            );
            let thread = list_comments(&conn, PROJECT, task_id).expect("list");
            assert_eq!(thread[0].kind, "outcome", "{phase}");
            assert_eq!(thread[0].phase.as_deref(), Some(phase));
            assert_ne!(kind_for_phase(Some(phase)), "outcome");
        }
    }

    #[test]
    fn entries_accumulate_but_a_proposal_and_a_plan_replace_the_last_one() {
        let (conn, task_id) = db_with_task();
        note(&conn, task_id, "verdict", "first pass");
        note(&conn, task_id, "verdict", "second pass");
        record_outcome(&conn, PROJECT, task_id, Some("Refining"), "first attempt");
        record_outcome(&conn, PROJECT, task_id, Some("Drafting"), "first plan");
        record_outcome(&conn, PROJECT, task_id, Some("Refining"), "second attempt");
        record_outcome(&conn, PROJECT, task_id, Some("Drafting"), "second plan");

        assert_eq!(
            kinds(&conn, task_id),
            ["verdict", "verdict", "proposal", "plan"]
        );
        let latest = |kind| {
            latest_of_kind(&conn, PROJECT, task_id, kind)
                .expect("read")
                .and_then(|comment| comment.body)
        };
        assert_eq!(latest("proposal").as_deref(), Some("second attempt"));
        assert_eq!(latest("plan").as_deref(), Some("second plan"));
        assert_eq!(latest("note"), None);
    }

    #[test]
    fn a_phases_closing_message_is_typed_by_what_it_is() {
        let (conn, task_id) = db_with_task();
        for phase in ["Refining", "Drafting", "SelfReview", "Implementing"] {
            record_outcome(&conn, PROJECT, task_id, Some(phase), "words");
        }
        assert_eq!(
            kinds(&conn, task_id),
            ["proposal", "plan", "verdict", "outcome"]
        );
    }

    #[test]
    fn attaching_the_same_file_twice_leaves_one_row() {
        let (conn, task_id) = db_with_task();
        let first =
            add_attachment(&conn, PROJECT, task_id, "notes.txt", "/tmp/notes.txt").expect("attach");
        let second =
            add_attachment(&conn, PROJECT, task_id, "notes.txt", "/tmp/notes.txt").expect("attach");
        assert_eq!(first, second);
        add_attachment(&conn, PROJECT, task_id, "notes.txt", "/tmp/other/notes.txt")
            .expect("attach");
        assert_eq!(
            list_attachments(&conn, PROJECT, task_id)
                .expect("list")
                .len(),
            2
        );

        delete_attachment(&conn, "/other", first.id).expect("delete");
        assert_eq!(
            list_attachments(&conn, PROJECT, task_id)
                .expect("list")
                .len(),
            2,
            "a delete names the project"
        );
        delete_attachment(&conn, PROJECT, first.id).expect("delete");
        assert_eq!(
            list_attachments(&conn, PROJECT, task_id)
                .expect("list")
                .len(),
            1
        );
    }

    #[test]
    fn a_relative_attachment_is_measured_from_the_project() {
        let directory = tempfile::tempdir().expect("tempdir");
        std::fs::write(directory.path().join("a.txt"), "12345").expect("write");
        let project_path = directory.path().to_string_lossy().into_owned();
        let mut conn = crate::project_store::open_in_memory();
        let task = super::super::tests::new_task(&mut conn, &project_path, "a task");
        let attachment =
            add_attachment(&conn, &project_path, task.id, "a.txt", "a.txt").expect("attach");
        assert_eq!(attachment.file_size, 5);
        assert_eq!(attachment.file_path, "a.txt");
    }

    #[test]
    fn a_relationship_is_listed_from_either_end() {
        let (mut conn, task_id) = db_with_task();
        let other = super::super::tests::new_task(&mut conn, PROJECT, "other task");
        let relationship =
            add_relationship(&conn, PROJECT, task_id, other.id, "blocks").expect("relate");
        assert_eq!(
            list_relationships(&conn, PROJECT, other.id).expect("list"),
            std::slice::from_ref(&relationship)
        );
        assert_eq!(
            list_relationships(&conn, PROJECT, task_id).expect("list"),
            std::slice::from_ref(&relationship)
        );
        assert!(add_relationship(&conn, PROJECT, task_id, 99, "blocks").is_err());

        delete_relationship(&conn, PROJECT, relationship.id).expect("delete");
        assert!(list_relationships(&conn, PROJECT, task_id)
            .expect("list")
            .is_empty());
    }

    #[test]
    fn instructions_are_logged_in_order() {
        let (conn, task_id) = db_with_task();
        add_instruction(&conn, PROJECT, task_id, "first", "user").expect("add");
        add_instruction(&conn, PROJECT, task_id, "second", "agent").expect("add");
        let log: Vec<String> = list_instructions(&conn, PROJECT, task_id)
            .expect("list")
            .into_iter()
            .map(|instruction| instruction.content)
            .collect();
        assert_eq!(log, ["first", "second"]);
    }
}
