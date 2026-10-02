//! A task's review: the decision a reviewer took, their feedback, and per-file comments.
//!
//! One per task. Its tables are in version 3, beside the worktrees (see `worktrees::V3_WORKTREES_REVIEWS`).

use chrono::Utc;
use maestro_protocol::{ReviewComment, SaveTaskReviewRequest, TaskReview};
use rusqlite::{params, Connection, OptionalExtension};

use super::{commit, transaction};

/// The task's review with its comments, or `None` when it has none.
pub fn get_review(
    conn: &Connection,
    project_path: &str,
    task_id: i32,
) -> Result<Option<TaskReview>, String> {
    let review = conn
        .query_row(
            "SELECT id, task_id, decision, general_feedback, reviewed_at, created_at
             FROM task_reviews WHERE project_path = ?1 AND task_id = ?2",
            params![project_path, task_id],
            |row| {
                Ok(TaskReview {
                    id: row.get(0)?,
                    task_id: row.get(1)?,
                    decision: row.get(2)?,
                    general_feedback: row.get(3)?,
                    reviewed_at: row.get(4)?,
                    created_at: row.get(5)?,
                    comments: Vec::new(),
                })
            },
        )
        .optional()
        .map_err(|e| format!("Failed to read the review of task {task_id}: {e}"))?;
    let Some(mut review) = review else {
        return Ok(None);
    };

    let mut statement = conn
        .prepare(
            "SELECT id, review_id, file_path, comment, created_at FROM review_comments
             WHERE review_id = ?1 ORDER BY id",
        )
        .map_err(|e| format!("Prepare failed: {e}"))?;
    review.comments = statement
        .query_map([review.id], |row| {
            Ok(ReviewComment {
                id: row.get(0)?,
                review_id: row.get(1)?,
                file_path: row.get(2)?,
                comment: row.get(3)?,
                created_at: row.get(4)?,
            })
        })
        .map_err(|e| format!("Query failed: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("Query failed: {e}"))?;
    Ok(Some(review))
}

/// Write a task's review, returning its id, in one transaction.
///
/// With `comments` the review is replaced whole, a new row whose old comments go with the old one,
/// as the review panel's save always did. Without, it is updated in place and keeps its id and its
/// comments: a merge conflict reported after an approval must not take the user's per-file
/// comments with it.
pub fn save_review(conn: &mut Connection, request: &SaveTaskReviewRequest) -> Result<i32, String> {
    let now = Utc::now().to_rfc3339();
    let tx = transaction(conn)?;
    let review_id: i32 = match &request.comments {
        Some(comments) => {
            tx.execute(
                "DELETE FROM task_reviews WHERE project_path = ?1 AND task_id = ?2",
                params![request.project_path, request.task_id],
            )
            .map_err(|e| format!("Insert review failed: {e}"))?;
            let review_id: i32 = tx
                .query_row(
                    "INSERT INTO task_reviews (project_path, task_id, decision, general_feedback,
                                               reviewed_at, created_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?5)
                     RETURNING id",
                    params![
                        request.project_path,
                        request.task_id,
                        request.decision,
                        request.general_feedback,
                        now
                    ],
                    |row| row.get(0),
                )
                .map_err(|e| format!("Insert review failed: {e}"))?;
            for comment in comments {
                tx.execute(
                    "INSERT INTO review_comments (review_id, file_path, comment, created_at)
                     VALUES (?1, ?2, ?3, ?4)",
                    params![review_id, comment.file_path, comment.comment, now],
                )
                .map_err(|e| format!("Insert comment failed: {e}"))?;
            }
            review_id
        }
        None => tx
            .query_row(
                "INSERT INTO task_reviews (project_path, task_id, decision, general_feedback,
                                           reviewed_at, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?5)
                 ON CONFLICT(project_path, task_id) DO UPDATE SET
                     decision = excluded.decision,
                     general_feedback = excluded.general_feedback,
                     reviewed_at = excluded.reviewed_at
                 RETURNING id",
                params![
                    request.project_path,
                    request.task_id,
                    request.decision,
                    request.general_feedback,
                    now
                ],
                |row| row.get(0),
            )
            .map_err(|e| format!("Save feedback failed: {e}"))?,
    };
    commit(tx)?;
    Ok(review_id)
}

/// Drop the task's review and its comments, once its feedback has reached the agent.
pub fn clear_review(conn: &Connection, project_path: &str, task_id: i32) -> Result<(), String> {
    conn.execute(
        "DELETE FROM task_reviews WHERE project_path = ?1 AND task_id = ?2",
        params![project_path, task_id],
    )
    .map_err(|e| format!("Delete review failed: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::tests::{db_with_task, PROJECT};
    use super::super::worktrees::{self, tests::worktree};
    use super::*;
    use maestro_protocol::ReviewCommentInput;

    fn save(
        conn: &mut Connection,
        task_id: i32,
        decision: &str,
        comments: Option<&[(&str, &str)]>,
    ) -> i32 {
        save_review(
            conn,
            &SaveTaskReviewRequest {
                project_path: PROJECT.to_string(),
                task_id,
                decision: decision.to_string(),
                general_feedback: Some(format!("{decision} feedback")),
                comments: comments.map(|comments| {
                    comments
                        .iter()
                        .map(|(file_path, comment)| ReviewCommentInput {
                            file_path: file_path.to_string(),
                            comment: comment.to_string(),
                        })
                        .collect()
                }),
            },
        )
        .expect("save a review")
    }

    fn comments(conn: &Connection, task_id: i32) -> Vec<String> {
        get_review(conn, PROJECT, task_id)
            .expect("get")
            .expect("a review")
            .comments
            .into_iter()
            .map(|c| format!("{}: {}", c.file_path, c.comment))
            .collect()
    }

    #[test]
    fn a_review_saves_reads_back_and_clears() {
        let (mut conn, task_id) = db_with_task();
        assert_eq!(get_review(&conn, PROJECT, task_id).expect("get"), None);

        let first = save(&mut conn, task_id, "Approve", Some(&[("a.rs", "old")]));
        let replaced = save(
            &mut conn,
            task_id,
            "RequestChanges",
            Some(&[("b.rs", "one"), ("c.rs", "two")]),
        );
        assert_ne!(first, replaced, "a save with comments is a new review");
        let review = get_review(&conn, PROJECT, task_id).expect("get").unwrap();
        assert_eq!(review.id, replaced);
        assert_eq!(review.decision, "RequestChanges");
        assert_eq!(comments(&conn, task_id), ["b.rs: one", "c.rs: two"]);

        let in_place = save(&mut conn, task_id, "RequestChanges", None);
        assert_eq!(
            in_place, replaced,
            "feedback alone updates the review in place"
        );
        assert_eq!(comments(&conn, task_id), ["b.rs: one", "c.rs: two"]);

        clear_review(&conn, PROJECT, task_id).expect("clear");
        assert_eq!(get_review(&conn, PROJECT, task_id).expect("get"), None);
        let left: i64 = conn
            .query_row("SELECT COUNT(*) FROM review_comments", [], |row| row.get(0))
            .expect("count");
        assert_eq!(left, 0);
    }

    #[test]
    fn deleting_a_task_takes_its_review_and_releases_its_worktree() {
        let (mut conn, task_id) = db_with_task();
        let owned = worktree(&conn, PROJECT, Some(task_id), "owned");
        save(&mut conn, task_id, "Approve", Some(&[("a.rs", "fine")]));

        super::super::delete(&conn, PROJECT, task_id).expect("delete the task");

        let kept = worktrees::get(&conn, PROJECT, owned.id)
            .expect("get")
            .unwrap();
        assert_eq!(kept.task_id, None, "the worktree outlives its task");
        for table in ["task_reviews", "review_comments"] {
            let left: i64 = conn
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                    row.get(0)
                })
                .expect("count");
            assert_eq!(left, 0, "{table} went with the task");
        }
    }
}
