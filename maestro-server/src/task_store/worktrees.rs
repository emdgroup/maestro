//! A project's worktree rows: which directory under `.maestro/worktrees/` belongs to which task.
//!
//! Only the rows live here. Making, diffing and removing a worktree is git, which the app still runs
//! over its own connection, except for the ones an automation makes, which the daemon cuts itself.
//!
//! A worktree is `(project_path, id)`, like a task, with ids minted per project from a counter
//! that never goes back. A session's worktree is named after its id (`session-<id>`) inside the
//! project, so an id only has to be unique there, and one that is never reused keeps a new
//! session out of an old one's folder. Per project rather than global so that ids imported
//! verbatim from several apps' databases cannot collide.

use chrono::Utc;
use maestro_protocol::{
    ClaimWorktreeForTaskRequest, InsertWorktreeRequest, UpdateWorktreeRequest, Worktree,
};
use rusqlite::{params, Connection, OptionalExtension};

use super::{commit, transaction};

/// Version 3 of `projects.db`: worktrees, and the reviews hanging off a task. Frozen: a later
/// change to these tables is a new entry in `project_store::MIGRATIONS`.
///
/// A task's deletion releases its worktree rather than taking it, as the app's `ON DELETE SET
/// NULL` did. That cannot be a foreign key action here: SET NULL on the composite key would null
/// `project_path` too. So the key only checks, and a trigger clears `task_id` first. Likewise
/// `tasks.workspace_worktree_id`, which version 2 made without a foreign key and SQLite cannot add
/// one to without rebuilding the table: a trigger drops the pin when its worktree goes.
pub const V3_WORKTREES_REVIEWS: &str = "
-- The highest worktree id a project has ever minted, beside its task counter.
ALTER TABLE project_counters ADD COLUMN last_worktree_id INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS worktrees (
    project_path TEXT NOT NULL,
    id INTEGER NOT NULL,
    task_id INTEGER,
    branch_name TEXT NOT NULL,
    base_branch TEXT,
    path TEXT NOT NULL,
    git_status TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (project_path, id),
    FOREIGN KEY (project_path, task_id) REFERENCES tasks(project_path, id)
);
CREATE INDEX IF NOT EXISTS idx_worktrees_task_id ON worktrees(project_path, task_id);

CREATE TRIGGER IF NOT EXISTS tasks_release_worktrees BEFORE DELETE ON tasks
BEGIN
    UPDATE worktrees SET task_id = NULL
     WHERE project_path = old.project_path AND task_id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS worktrees_drop_workspace_pins BEFORE DELETE ON worktrees
BEGIN
    UPDATE tasks SET workspace_worktree_id = NULL
     WHERE project_path = old.project_path AND workspace_worktree_id = old.id;
END;

CREATE TABLE IF NOT EXISTS task_reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_path TEXT NOT NULL,
    task_id INTEGER NOT NULL,
    decision TEXT NOT NULL,
    general_feedback TEXT,
    reviewed_at TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (project_path, task_id),
    FOREIGN KEY (project_path, task_id) REFERENCES tasks(project_path, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS review_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    review_id INTEGER NOT NULL,
    file_path TEXT NOT NULL,
    comment TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (review_id) REFERENCES task_reviews(id) ON DELETE CASCADE
);
";

const SELECT: &str = "SELECT id, project_path, task_id, branch_name, base_branch, path, git_status,
                             created_at
                      FROM worktrees";

fn from_row(row: &rusqlite::Row) -> rusqlite::Result<Worktree> {
    Ok(Worktree {
        id: row.get("id")?,
        project_path: row.get("project_path")?,
        task_id: row.get("task_id")?,
        branch_name: row.get("branch_name")?,
        base_branch: row.get("base_branch")?,
        path: row.get("path")?,
        git_status: row.get("git_status")?,
        created_at: row.get("created_at")?,
    })
}

fn query(
    conn: &Connection,
    sql: &str,
    args: impl rusqlite::Params,
) -> Result<Vec<Worktree>, String> {
    let mut statement = conn
        .prepare(sql)
        .map_err(|e| format!("Failed to prepare query: {e}"))?;
    let rows = statement
        .query_map(args, from_row)
        .map_err(|e| format!("Failed to query worktrees: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("Failed to query worktrees: {e}"))?;
    Ok(rows)
}

/// A project's worktrees in the order they were made, or only the ones a task owns. A task owns
/// one at most, so the first is the answer to "where does task N work".
pub fn list(
    conn: &Connection,
    project_path: &str,
    task_id: Option<i32>,
) -> Result<Vec<Worktree>, String> {
    query(
        conn,
        &format!("{SELECT} WHERE project_path = ?1 AND (?2 IS NULL OR task_id = ?2) ORDER BY id"),
        params![project_path, task_id],
    )
}

pub fn get(conn: &Connection, project_path: &str, id: i32) -> Result<Option<Worktree>, String> {
    conn.query_row(
        &format!("{SELECT} WHERE project_path = ?1 AND id = ?2"),
        params![project_path, id],
        from_row,
    )
    .optional()
    .map_err(|e| format!("Failed to read worktree {id}: {e}"))
}

/// The project's next worktree id, counted from what the project ever minted.
fn mint_id(conn: &Connection, project_path: &str) -> Result<i32, String> {
    conn.query_row(
        "INSERT INTO project_counters (project_path, last_task_id, last_worktree_id)
         VALUES (?1, 0, 1)
         ON CONFLICT(project_path) DO UPDATE SET last_worktree_id = last_worktree_id + 1
         RETURNING last_worktree_id",
        params![project_path],
        |row| row.get(0),
    )
    .map_err(|e| format!("Failed to mint a worktree id: {e}"))
}

fn insert_row(
    conn: &Connection,
    project_path: &str,
    task_id: Option<i32>,
    branch_name: &str,
    base_branch: Option<&str>,
    path: &str,
) -> Result<i32, String> {
    let id = mint_id(conn, project_path)?;
    conn.execute(
        "INSERT INTO worktrees (project_path, id, task_id, branch_name, base_branch, path,
                                created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            project_path,
            id,
            task_id,
            branch_name,
            base_branch,
            path,
            Utc::now().to_rfc3339(),
        ],
    )
    .map_err(|e| format!("Failed to insert worktree: {e}"))?;
    Ok(id)
}

/// Record a worktree. An empty `path` reserves the id for a session worktree whose name is that
/// id, and is filled in by [`update`] once git has made it.
pub fn insert(conn: &Connection, request: &InsertWorktreeRequest) -> Result<Worktree, String> {
    let id = insert_row(
        conn,
        &request.project_path,
        request.task_id,
        &request.branch_name,
        request.base_branch.as_deref(),
        &request.path,
    )?;
    get(conn, &request.project_path, id)?.ok_or_else(|| format!("Worktree {id} not found"))
}

/// Record a worktree the daemon made for an automation, unless the project already has a row at
/// that path. `true` when it wrote one. The path is relative to the project, as every row's is.
pub fn adopt(
    conn: &Connection,
    project_path: &str,
    branch_name: &str,
    base_branch: Option<&str>,
    relative_path: &str,
) -> Result<bool, String> {
    let fail =
        |e: String| format!("cannot adopt the worktree {relative_path} an automation made: {e}");
    let known: bool = conn
        .query_row(
            "SELECT EXISTS (SELECT 1 FROM worktrees WHERE project_path = ?1 AND path = ?2)",
            params![project_path, relative_path],
            |row| row.get(0),
        )
        .map_err(|e| fail(e.to_string()))?;
    if !known {
        insert_row(
            conn,
            project_path,
            None,
            branch_name,
            base_branch,
            relative_path,
        )
        .map_err(fail)?;
    }
    Ok(!known)
}

/// Write the branch and path a reservation ended up with. What the request leaves out is kept.
pub fn update(conn: &Connection, request: &UpdateWorktreeRequest) -> Result<Worktree, String> {
    conn.execute(
        "UPDATE worktrees SET branch_name = COALESCE(?3, branch_name), path = COALESCE(?4, path)
         WHERE project_path = ?1 AND id = ?2",
        params![
            request.project_path,
            request.worktree_id,
            request.branch_name,
            request.path
        ],
    )
    .map_err(|e| format!("Failed to update worktree: {e}"))?;
    get(conn, &request.project_path, request.worktree_id)?
        .ok_or_else(|| format!("Worktree {} not found", request.worktree_id))
}

/// Forget worktree rows, in one transaction. A task pinned to one of them loses the pin. Returns
/// how many rows went; an id the project does not have is skipped.
pub fn delete(conn: &mut Connection, project_path: &str, ids: &[i32]) -> Result<usize, String> {
    let tx = transaction(conn)?;
    let mut deleted = 0;
    for id in ids {
        deleted += tx
            .execute(
                "DELETE FROM worktrees WHERE project_path = ?1 AND id = ?2",
                params![project_path, id],
            )
            .map_err(|e| format!("Failed to delete worktree {id}: {e}"))?;
    }
    commit(tx)?;
    Ok(deleted)
}

/// Hand an existing worktree to a task, for a task whose workspace mode is `ReuseWorkspace`.
///
/// Any worktree the task owned before is released rather than left behind, so the one-worktree-
/// per-task assumption every "where does task N work" query makes still holds.
pub fn claim_for_task(
    conn: &mut Connection,
    request: &ClaimWorktreeForTaskRequest,
) -> Result<Worktree, String> {
    let ClaimWorktreeForTaskRequest {
        project_path,
        task_id,
        worktree_id,
    } = request;
    let tx = transaction(conn)?;
    tx.execute(
        "UPDATE worktrees SET task_id = NULL WHERE project_path = ?1 AND task_id = ?2 AND id != ?3",
        params![project_path, task_id, worktree_id],
    )
    .map_err(|e| format!("Failed to release the previous worktree: {e}"))?;
    let updated = tx
        .execute(
            "UPDATE worktrees SET task_id = ?2 WHERE project_path = ?1 AND id = ?3",
            params![project_path, task_id, worktree_id],
        )
        .map_err(|e| format!("Failed to claim worktree: {e}"))?;
    if updated == 0 {
        return Err(
            "The workspace this task was pinned to no longer exists. Pick another one.".to_string(),
        );
    }
    let worktree = get(&tx, project_path, *worktree_id)?
        .ok_or_else(|| format!("Worktree {worktree_id} not found"))?;
    commit(tx)?;
    Ok(worktree)
}

#[cfg(test)]
pub(super) mod tests {
    use super::super::tests::{db_with_task, PROJECT};
    use super::*;
    use maestro_protocol::{TaskUpdate, WorkspaceMode};

    pub(in crate::task_store) fn worktree(
        conn: &Connection,
        project_path: &str,
        task_id: Option<i32>,
        path: &str,
    ) -> Worktree {
        insert(
            conn,
            &InsertWorktreeRequest {
                project_path: project_path.to_string(),
                task_id,
                branch_name: format!("maestro/{path}"),
                base_branch: Some("main".to_string()),
                path: path.to_string(),
            },
        )
        .expect("insert a worktree")
    }

    #[test]
    fn a_reservation_is_filled_in_and_reads_back() {
        let (conn, _) = db_with_task();
        let reserved = worktree(&conn, PROJECT, None, "");
        assert_eq!(reserved.path, "");

        let made = update(
            &conn,
            &UpdateWorktreeRequest {
                project_path: PROJECT.to_string(),
                worktree_id: reserved.id,
                branch_name: Some("maestro/session".to_string()),
                path: Some(format!(".maestro/worktrees/session-{}", reserved.id)),
            },
        )
        .expect("update");
        assert_eq!(made.branch_name, "maestro/session");
        assert_eq!(get(&conn, PROJECT, reserved.id).expect("get"), Some(made));
        assert_eq!(get(&conn, "/other", reserved.id).expect("get"), None);
    }

    /// `session-<id>` lives inside the project, so ids are the project's, and never handed out twice.
    #[test]
    fn worktree_ids_are_per_project_and_never_reused() {
        let (mut conn, _) = db_with_task();
        let first = worktree(&conn, PROJECT, None, "a");
        let elsewhere = worktree(&conn, "/other", None, "a");
        assert_eq!((first.id, elsewhere.id), (1, 1));

        delete(&mut conn, PROJECT, &[first.id]).expect("delete");
        assert_eq!(worktree(&conn, PROJECT, None, "b").id, 2);
        assert!(adopt(&conn, "/other", "maestro/automation-x-1", None, "c").unwrap());
        assert_eq!(list(&conn, "/other", None).expect("list")[1].id, 2);
    }

    #[test]
    fn claiming_releases_what_the_task_held_before() {
        let (mut conn, task_id) = db_with_task();
        let old = worktree(&conn, PROJECT, Some(task_id), "old");
        let pinned = worktree(&conn, PROJECT, None, "pinned");

        let claimed = claim_for_task(
            &mut conn,
            &ClaimWorktreeForTaskRequest {
                project_path: PROJECT.to_string(),
                task_id,
                worktree_id: pinned.id,
            },
        )
        .expect("claim");
        assert_eq!(claimed.task_id, Some(task_id));
        assert_eq!(
            get(&conn, PROJECT, old.id).expect("get").unwrap().task_id,
            None
        );
        assert_eq!(
            list(&conn, PROJECT, Some(task_id)).expect("list"),
            vec![claimed]
        );

        let gone = claim_for_task(
            &mut conn,
            &ClaimWorktreeForTaskRequest {
                project_path: PROJECT.to_string(),
                task_id,
                worktree_id: 999,
            },
        );
        assert!(gone.is_err(), "claiming a worktree that is gone fails");
        assert_eq!(
            list(&conn, PROJECT, Some(task_id)).expect("list").len(),
            1,
            "a failed claim releases nothing"
        );
    }

    #[test]
    fn deleting_a_worktree_drops_the_pins_on_it() {
        let (mut conn, task_id) = db_with_task();
        let pinned = worktree(&conn, PROJECT, None, "pinned");
        super::super::update(
            &mut conn,
            PROJECT,
            task_id,
            &TaskUpdate {
                workspace_mode: Some(WorkspaceMode::ReuseWorkspace),
                workspace_worktree_id: Some(pinned.id),
                ..TaskUpdate::default()
            },
        )
        .expect("pin");

        assert_eq!(
            delete(&mut conn, PROJECT, &[pinned.id, 999]).expect("delete"),
            1
        );
        let task = super::super::get(&conn, PROJECT, task_id)
            .expect("get")
            .unwrap();
        assert_eq!(task.workspace_worktree_id, None);
    }

    #[test]
    fn an_automation_worktree_is_adopted_once() {
        let (conn, _) = db_with_task();
        let path = ".maestro/worktrees/automation-nightly-1";
        assert!(adopt(
            &conn,
            PROJECT,
            "maestro/automation-nightly-1",
            Some("main"),
            path
        )
        .unwrap());
        assert!(!adopt(
            &conn,
            PROJECT,
            "maestro/automation-nightly-1",
            Some("main"),
            path
        )
        .unwrap());
        assert_eq!(list(&conn, PROJECT, None).expect("list").len(), 1);
    }
}
