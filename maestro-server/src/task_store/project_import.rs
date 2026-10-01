//! A project's rows as an app held them before the daemon kept them, taken in once.
//!
//! All or nothing, in one transaction: a row that does not fit, such as a comment on a task the
//! import does not carry, fails the foreign key and nothing is kept. A project imported once, by
//! this app or another, has a row in `project_imports`, and a second import is refused before
//! anything is written. An empty import sets it too.
//!
//! Without the marker the import merges. Rows the daemon wrote for the project before it (an
//! automation's adopted worktree, a task or prompt an agent created) are moved above every id the
//! import carries and above its floors, and every reference to them moves along, so the imported
//! rows keep their ids and the folders and branches named after them still match.

use chrono::Utc;
use maestro_protocol::{ImportProjectRequest, ImportProjectResponse, ProjectRef, ServerResponse};
use rusqlite::{params, Connection, OptionalExtension, Transaction};

use super::{commit, json, text, transaction};
use crate::automations::canonical_project_path;

/// The reply, and the pushes to broadcast after it: none when the import was refused.
pub fn answer(
    conn: &mut Connection,
    mut request: ImportProjectRequest,
) -> Result<(ServerResponse, Vec<ServerResponse>), String> {
    request.project_path = canonical_project_path(&request.project_path);
    let imported = import(conn, &request)?;
    let reply = ServerResponse::ImportProjectOk(ImportProjectResponse { imported });
    if !imported {
        return Ok((reply, Vec::new()));
    }
    let project = || ProjectRef {
        project_path: request.project_path.clone(),
    };
    let pushes = vec![
        ServerResponse::TasksChanged(project()),
        ServerResponse::WorktreesChanged(project()),
        ServerResponse::PromptsChanged(project()),
    ];
    Ok((reply, pushes))
}

/// Version 5: which projects have been imported. Frozen, see `project_store::MIGRATIONS`.
pub const V5_PROJECT_IMPORTS: &str = "
CREATE TABLE IF NOT EXISTS project_imports (
    project_path TEXT PRIMARY KEY,
    imported_at  TEXT NOT NULL,
    -- 'rows' when the import carried any, 'empty' when it carried none.
    source       TEXT NOT NULL
);
";

/// `Ok(false)` when refused. `request.project_path` is already canonical.
fn import(conn: &mut Connection, request: &ImportProjectRequest) -> Result<bool, String> {
    let tx = transaction(conn)?;
    let imported: bool = tx
        .query_row(
            "SELECT EXISTS (SELECT 1 FROM project_imports WHERE project_path = ?1)",
            params![request.project_path],
            |row| row.get(0),
        )
        .map_err(|e| format!("Failed to read the project's import marker: {e}"))?;
    if imported {
        return Ok(false);
    }
    let failed = |e: String| format!("Import failed, nothing was kept: {e}");
    // Moving a task's id moves its children in separate statements, so keys are checked at commit.
    // SQLite resets this when the transaction ends.
    tx.pragma_update(None, "defer_foreign_keys", "ON")
        .map_err(|e| failed(e.to_string()))?;
    make_room(&tx, request).map_err(failed)?;
    write(&tx, request).map_err(failed)?;
    commit(tx).map_err(failed)?;
    Ok(true)
}

/// Move the rows the daemon already holds for the project above everything the import brings.
///
/// Each kind shifts by one offset: its counter or the highest id imported, whichever is higher.
/// The counter is at least every id the daemon minted, so each moved id lands above every id held
/// or imported, and no update collides with a row not yet moved.
fn make_room(tx: &Transaction, request: &ImportProjectRequest) -> Result<(), String> {
    let project = request.project_path.as_str();
    let (tasks, worktrees, prompts): (i32, i32, i32) = tx
        .query_row(
            "SELECT last_task_id, last_worktree_id, last_prompt_id FROM project_counters
             WHERE project_path = ?1",
            params![project],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .unwrap_or_default();
    let task_offset = request.tasks.iter().map(|t| t.id).fold(tasks, i32::max);
    let worktree_offset = request
        .worktrees
        .iter()
        .map(|w| w.id)
        .fold(worktrees, i32::max);
    let prompt_offset = request.prompts.iter().map(|p| p.id).fold(prompts, i32::max);

    // Sessions first, while `tasks` still has the old ids: a session row naming a task the daemon
    // does not hold names one of the app's, which keeps its id.
    let shifts = [
        (
            "UPDATE sessions SET task_id = task_id + ?2
             WHERE project_path = ?1
               AND task_id IN (SELECT id FROM tasks WHERE project_path = ?1)",
            task_offset,
        ),
        (
            "UPDATE task_relationships
             SET from_task_id = from_task_id + ?2, to_task_id = to_task_id + ?2
             WHERE project_path = ?1",
            task_offset,
        ),
        (
            "UPDATE task_instructions SET task_id = task_id + ?2 WHERE project_path = ?1",
            task_offset,
        ),
        (
            "UPDATE task_comments SET task_id = task_id + ?2 WHERE project_path = ?1",
            task_offset,
        ),
        (
            "UPDATE task_attachments SET task_id = task_id + ?2 WHERE project_path = ?1",
            task_offset,
        ),
        (
            "UPDATE task_reviews SET task_id = task_id + ?2 WHERE project_path = ?1",
            task_offset,
        ),
        (
            "UPDATE worktrees SET task_id = task_id + ?2
             WHERE project_path = ?1 AND task_id IS NOT NULL",
            task_offset,
        ),
        (
            "UPDATE tasks SET id = id + ?2 WHERE project_path = ?1",
            task_offset,
        ),
        (
            "UPDATE tasks SET workspace_worktree_id = workspace_worktree_id + ?2
             WHERE project_path = ?1 AND workspace_worktree_id IS NOT NULL",
            worktree_offset,
        ),
        (
            "UPDATE worktrees SET id = id + ?2 WHERE project_path = ?1",
            worktree_offset,
        ),
        (
            "UPDATE prompts SET id = id + ?2 WHERE project_path = ?1",
            prompt_offset,
        ),
    ];
    for (sql, offset) in shifts {
        tx.execute(sql, params![project, offset])
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn write(tx: &Transaction, request: &ImportProjectRequest) -> Result<(), String> {
    let project = request.project_path.as_str();
    let sql = |e: rusqlite::Error| e.to_string();

    for task in &request.tasks {
        tx.execute(
            "INSERT INTO tasks (project_path, id, title, description, status, priority, base_branch,
                                archived_at, external_id, is_imported, import_source, skills,
                                model_override, mcp_allowlist, skills_override, external_url,
                                external_updated_at, labels, auto_approve, workspace_mode,
                                workspace_worktree_id, workspace_branch_mode, workspace_branch,
                                agent_id, permission_mode_override, execution_start_sha,
                                created_at, updated_at, phase, phase_status, ball, completion,
                                execute_requested_at, pull_request_url, pull_request_number,
                                review_rounds, fix_rounds, pull_request_ci, profile_overrides)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17,
                     ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29, ?30, ?31, ?32,
                     ?33, ?34, ?35, ?36, ?37, ?38, ?39)",
            params![
                project,
                task.id,
                task.title,
                task.description,
                text(task.status),
                text(task.priority),
                task.base_branch,
                task.archived_at,
                task.external_id,
                task.is_imported,
                task.import_source,
                json(&task.skills)?,
                task.model_override,
                task.mcp_allowlist.as_ref().map(json).transpose()?,
                task.skills_override.as_ref().map(json).transpose()?,
                task.external_url,
                task.external_updated_at,
                json(&task.labels)?,
                task.auto_approve,
                text(task.workspace_mode),
                task.workspace_worktree_id,
                text(task.workspace_branch_mode),
                task.workspace_branch,
                task.agent_id,
                task.permission_mode_override,
                task.execution_start_sha,
                task.created_at,
                task.updated_at,
                task.phase.map(text),
                task.phase_status.map(text),
                text(task.ball),
                task.completion.map(text),
                task.execute_requested_at,
                task.pull_request_url,
                task.pull_request_number,
                task.review_rounds,
                task.fix_rounds,
                task.pull_request_ci.map(text),
                task.profile_overrides,
            ],
        )
        .map_err(|e| format!("task {}: {e}", task.id))?;
    }

    for relationship in &request.relationships {
        tx.execute(
            "INSERT INTO task_relationships (project_path, from_task_id, to_task_id,
                                             relationship_type, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                project,
                relationship.from_task_id,
                relationship.to_task_id,
                relationship.relationship_type,
                relationship.created_at,
            ],
        )
        .map_err(sql)?;
    }
    for instruction in &request.instructions {
        tx.execute(
            "INSERT INTO task_instructions (project_path, task_id, content, source, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                project,
                instruction.task_id,
                instruction.content,
                instruction.source,
                instruction.created_at,
            ],
        )
        .map_err(sql)?;
    }
    // Inserted in the order sent, so a thread read back by id keeps the app's order.
    for comment in &request.comments {
        tx.execute(
            "INSERT INTO task_comments (project_path, task_id, kind, author, body, external_ref,
                                        phase, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                project,
                comment.task_id,
                comment.kind,
                comment.author,
                comment.body,
                comment.external_ref,
                comment.phase,
                comment.created_at,
            ],
        )
        .map_err(sql)?;
    }
    for attachment in &request.attachments {
        tx.execute(
            "INSERT INTO task_attachments (project_path, task_id, filename, file_path, file_size,
                                           created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                project,
                attachment.task_id,
                attachment.filename,
                attachment.file_path,
                attachment.file_size,
                attachment.created_at,
            ],
        )
        .map_err(sql)?;
    }

    for worktree in &request.worktrees {
        tx.execute(
            "INSERT INTO worktrees (project_path, id, task_id, branch_name, base_branch, path,
                                    git_status, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                project,
                worktree.id,
                worktree.task_id,
                worktree.branch_name,
                worktree.base_branch,
                worktree.path,
                worktree.git_status,
                worktree.created_at,
            ],
        )
        .map_err(|e| format!("worktree {}: {e}", worktree.id))?;
    }

    for review in &request.reviews {
        let review_id: i64 = tx
            .query_row(
                "INSERT INTO task_reviews (project_path, task_id, decision, general_feedback,
                                           reviewed_at, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 RETURNING id",
                params![
                    project,
                    review.task_id,
                    review.decision,
                    review.general_feedback,
                    review.reviewed_at,
                    review.created_at,
                ],
                |row| row.get(0),
            )
            .map_err(|e| format!("review of task {}: {e}", review.task_id))?;
        for comment in &review.comments {
            tx.execute(
                "INSERT INTO review_comments (review_id, file_path, comment, created_at)
                 VALUES (?1, ?2, ?3, ?4)",
                params![
                    review_id,
                    comment.file_path,
                    comment.comment,
                    comment.created_at
                ],
            )
            .map_err(sql)?;
        }
    }

    for prompt in &request.prompts {
        tx.execute(
            "INSERT INTO prompts (project_path, id, title, body, tags, favorite, created_at,
                                  updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                project,
                prompt.id,
                prompt.title,
                prompt.body,
                json(&prompt.tags)?,
                prompt.favorite,
                prompt.created_at,
                prompt.updated_at,
            ],
        )
        .map_err(|e| format!("prompt {}: {e}", prompt.id))?;
    }

    // Never lowered: each counter ends at the highest id the project now holds, imported or moved,
    // or stays where it was if that is higher.
    tx.execute(
        "INSERT INTO project_counters (project_path, last_task_id, last_worktree_id,
                                       last_prompt_id)
         VALUES (?1,
                 (SELECT COALESCE(MAX(id), 0) FROM tasks WHERE project_path = ?1),
                 (SELECT COALESCE(MAX(id), 0) FROM worktrees WHERE project_path = ?1),
                 (SELECT COALESCE(MAX(id), 0) FROM prompts WHERE project_path = ?1))
         ON CONFLICT(project_path) DO UPDATE SET
             last_task_id = MAX(last_task_id, excluded.last_task_id),
             last_worktree_id = MAX(last_worktree_id, excluded.last_worktree_id),
             last_prompt_id = MAX(last_prompt_id, excluded.last_prompt_id)",
        params![project],
    )
    .map_err(sql)?;

    // Dormant and open, so the project loads them on its next open. A row the daemon already has
    // for the conversation is the newer word on it and is kept.
    let now = Utc::now().to_rfc3339();
    for session in &request.sessions {
        let meta = &session.meta;
        tx.execute(
            "INSERT OR IGNORE INTO sessions (agent_id, acp_session_id, project_path, cwd,
                                             session_name, task_id, task_name, branch_name, role,
                                             session_start_sha, can_reload, session_id,
                                             created_at, closed_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, NULL, ?12, NULL)",
            params![
                session.agent_id,
                session.acp_session_id,
                project,
                session.cwd,
                meta.session_name,
                meta.task_id,
                meta.task_name,
                meta.branch_name,
                meta.role,
                meta.session_start_sha,
                session.can_reload.unwrap_or(true),
                now,
            ],
        )
        .map_err(sql)?;
    }

    let empty = request.tasks.is_empty()
        && request.worktrees.is_empty()
        && request.prompts.is_empty()
        && request.sessions.is_empty();
    tx.execute(
        "INSERT INTO project_imports (project_path, imported_at, source) VALUES (?1, ?2, ?3)",
        params![project, now, if empty { "empty" } else { "rows" }],
    )
    .map_err(sql)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use maestro_protocol::{
        BranchMode, CreatePromptRequest, CreateTaskRequest, ImportedSession, InsertWorktreeRequest,
        Prompt, ReviewComment, SessionMeta, Task, TaskBall, TaskComment, TaskPhase, TaskPriority,
        TaskRelationship, TaskReview, TaskStatus, WorkspaceMode, Worktree,
    };

    const PROJECT: &str = "/nonexistent/import-project";
    const AT: &str = "2025-06-01T00:00:00+00:00";

    fn task(id: i32) -> Task {
        Task {
            id,
            project_path: "/the/app/spelling".to_string(),
            title: format!("Task {id}"),
            description: Some("why".to_string()),
            status: TaskStatus::Review,
            priority: TaskPriority::High,
            base_branch: "main".to_string(),
            archived_at: None,
            external_id: None,
            is_imported: Some(false),
            import_source: None,
            skills: vec!["rust".to_string()],
            model_override: None,
            mcp_allowlist: Some(vec!["maestro".to_string()]),
            skills_override: None,
            labels: vec!["bug".to_string()],
            external_url: None,
            external_updated_at: None,
            created_at: AT.to_string(),
            updated_at: AT.to_string(),
            auto_approve: true,
            workspace_mode: WorkspaceMode::NewWorktree,
            workspace_worktree_id: None,
            workspace_branch_mode: BranchMode::Create,
            workspace_branch: Some(format!("maestro/{id}-task")),
            agent_id: Some("claude-acp".to_string()),
            permission_mode_override: None,
            execution_start_sha: Some("abc".to_string()),
            phase: Some(TaskPhase::AwaitingMerge),
            phase_status: None,
            ball: TaskBall::None,
            completion: None,
            execute_requested_at: None,
            pull_request_url: None,
            pull_request_number: Some(12),
            review_rounds: 1,
            fix_rounds: 2,
            pull_request_ci: None,
            profile_overrides: None,
        }
    }

    fn comment(task_id: i32, body: &str) -> TaskComment {
        TaskComment {
            id: 900,
            task_id,
            kind: "comment".to_string(),
            author: "user".to_string(),
            body: Some(body.to_string()),
            external_ref: None,
            phase: None,
            created_at: AT.to_string(),
        }
    }

    fn session(acp_session_id: &str, name: &str) -> ImportedSession {
        ImportedSession {
            agent_id: "claude-acp".to_string(),
            acp_session_id: acp_session_id.to_string(),
            cwd: PROJECT.to_string(),
            meta: SessionMeta {
                session_name: Some(name.to_string()),
                task_id: Some(7),
                ..SessionMeta::default()
            },
            can_reload: None,
        }
    }

    fn full_request() -> ImportProjectRequest {
        ImportProjectRequest {
            project_path: PROJECT.to_string(),
            tasks: vec![task(3), task(7)],
            relationships: vec![TaskRelationship {
                id: 500,
                from_task_id: 3,
                to_task_id: 7,
                relationship_type: "blocks".to_string(),
                created_at: AT.to_string(),
            }],
            instructions: vec![],
            comments: vec![comment(7, "first"), comment(7, "second")],
            attachments: vec![],
            worktrees: vec![Worktree {
                id: 9,
                project_path: "/the/app/spelling".to_string(),
                task_id: Some(7),
                branch_name: "maestro/7-task".to_string(),
                base_branch: Some("main".to_string()),
                path: ".maestro/worktrees/task-7".to_string(),
                git_status: None,
                created_at: AT.to_string(),
            }],
            reviews: vec![TaskReview {
                id: 400,
                task_id: 7,
                decision: "RequestChanges".to_string(),
                general_feedback: Some("close".to_string()),
                reviewed_at: Some(AT.to_string()),
                created_at: AT.to_string(),
                comments: vec![ReviewComment {
                    id: 401,
                    review_id: 400,
                    file_path: "src/lib.rs".to_string(),
                    comment: "rename".to_string(),
                    created_at: AT.to_string(),
                }],
            }],
            prompts: vec![Prompt {
                id: 4,
                project_path: "/the/app/spelling".to_string(),
                title: "Review".to_string(),
                body: "Review the diff".to_string(),
                tags: vec!["review".to_string()],
                favorite: true,
                created_at: AT.to_string(),
                updated_at: AT.to_string(),
            }],
            sessions: vec![session("acp-1", "imported")],
        }
    }

    fn count(conn: &Connection, table: &str) -> i64 {
        conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
            row.get(0)
        })
        .expect("count")
    }

    #[test]
    fn an_import_keeps_ids_and_the_next_rows_number_above_them() {
        let mut conn = crate::project_store::open_in_memory();
        let (reply, pushes) = answer(&mut conn, full_request()).expect("import");
        assert_eq!(
            reply,
            ServerResponse::ImportProjectOk(ImportProjectResponse { imported: true })
        );
        assert_eq!(pushes.len(), 3);

        let mut expected = task(7);
        expected.project_path = PROJECT.to_string();
        assert_eq!(
            super::super::get(&conn, PROJECT, 7).expect("read"),
            Some(expected)
        );
        let thread = super::super::list_comments(&conn, PROJECT, 7).expect("thread");
        assert_eq!(
            thread
                .iter()
                .map(|c| c.body.as_deref().unwrap_or_default())
                .collect::<Vec<_>>(),
            ["first", "second"]
        );
        let relationships = super::super::list_relationships(&conn, PROJECT, 3).expect("links");
        assert_eq!(relationships.len(), 1);
        assert_eq!(relationships[0].to_task_id, 7);
        let review = super::super::reviews::get_review(&conn, PROJECT, 7)
            .expect("review")
            .expect("a review");
        assert_eq!(review.comments.len(), 1);
        assert_eq!(review.comments[0].review_id, review.id);
        assert_eq!(
            super::super::worktrees::get(&conn, PROJECT, 9)
                .expect("worktree")
                .and_then(|w| w.task_id),
            Some(7)
        );
        let prompt = crate::prompt_store::get(&conn, PROJECT, 4)
            .expect("prompt")
            .expect("a prompt");
        assert!(prompt.favorite);
        let sessions = crate::project_store::list(&conn, PROJECT, false).expect("sessions");
        assert_eq!(sessions.len(), 1);
        assert!(sessions[0].0.can_reload);
        assert_eq!(sessions[0].1, None, "imported dormant");

        let next_task = super::super::create(
            &mut conn,
            &CreateTaskRequest {
                project_path: PROJECT.to_string(),
                title: "After the import".to_string(),
                description: None,
                skills: vec![],
                labels: vec![],
                base_branch: "main".to_string(),
                agent_id: None,
                priority: None,
                auto_approve: false,
                workspace_mode: WorkspaceMode::NewWorktree,
                workspace_worktree_id: None,
                workspace_branch_mode: BranchMode::Create,
                workspace_branch: None,
                model_override: None,
            },
        )
        .expect("create");
        assert_eq!(next_task.id, 8);
        let next_worktree = super::super::worktrees::insert(
            &conn,
            &InsertWorktreeRequest {
                project_path: PROJECT.to_string(),
                task_id: None,
                branch_name: "b".to_string(),
                base_branch: None,
                path: String::new(),
            },
        )
        .expect("worktree");
        assert_eq!(next_worktree.id, 10);
        let next_prompt = crate::prompt_store::create(
            &conn,
            &CreatePromptRequest {
                project_path: PROJECT.to_string(),
                title: "Another".to_string(),
                body: "text".to_string(),
                tags: vec![],
                favorite: false,
            },
        )
        .expect("prompt");
        assert_eq!(next_prompt.id, 5);
    }

    fn create_request(title: &str) -> CreateTaskRequest {
        CreateTaskRequest {
            project_path: PROJECT.to_string(),
            title: title.to_string(),
            description: None,
            skills: vec![],
            labels: vec![],
            base_branch: "main".to_string(),
            agent_id: None,
            priority: None,
            auto_approve: false,
            workspace_mode: WorkspaceMode::NewWorktree,
            workspace_worktree_id: None,
            workspace_branch_mode: BranchMode::Create,
            workspace_branch: None,
            model_override: None,
        }
    }

    #[test]
    fn rows_the_daemon_wrote_first_move_above_the_import() {
        let mut conn = crate::project_store::open_in_memory();
        // An agent's task 1 with a comment, a worktree claimed for it, an automation's worktree,
        // an agent's prompt, and a session row bound to the task.
        let agents_task =
            super::super::create(&mut conn, &create_request("Agent's")).expect("task");
        assert_eq!(agents_task.id, 1);
        conn.execute(
            "INSERT INTO task_comments (project_path, task_id, kind, author, body, created_at)
             VALUES (?1, 1, 'comment', 'agent', 'note', ?2)",
            params![PROJECT, AT],
        )
        .expect("comment");
        let claimed = super::super::worktrees::insert(
            &conn,
            &InsertWorktreeRequest {
                project_path: PROJECT.to_string(),
                task_id: Some(1),
                branch_name: "maestro/1-agents".to_string(),
                base_branch: None,
                path: ".maestro/worktrees/task-1".to_string(),
            },
        )
        .expect("worktree");
        assert_eq!(claimed.id, 1);
        conn.execute(
            "UPDATE tasks SET workspace_worktree_id = 1 WHERE project_path = ?1 AND id = 1",
            params![PROJECT],
        )
        .expect("pin");
        assert!(super::super::worktrees::adopt(
            &conn,
            PROJECT,
            "maestro/automation-nightly-1",
            None,
            ".maestro/worktrees/automation-nightly-1",
        )
        .expect("adopt"));
        let agents_prompt = crate::prompt_store::create(
            &conn,
            &CreatePromptRequest {
                project_path: PROJECT.to_string(),
                title: "Agent's".to_string(),
                body: "text".to_string(),
                tags: vec![],
                favorite: false,
            },
        )
        .expect("prompt");
        assert_eq!(agents_prompt.id, 1);
        crate::project_store::rename(
            &conn,
            &maestro_protocol::RenameSessionRequest {
                project_path: PROJECT.to_string(),
                agent_id: "claude-acp".to_string(),
                acp_session_id: "daemon-session".to_string(),
                cwd: PROJECT.to_string(),
                name: "on the agent's task".to_string(),
            },
            PROJECT,
            Utc::now(),
        )
        .expect("session row");
        conn.execute(
            "UPDATE sessions SET task_id = 1 WHERE acp_session_id = 'daemon-session'",
            [],
        )
        .expect("bind");

        let (reply, _) = answer(&mut conn, full_request()).expect("import");
        assert_eq!(
            reply,
            ServerResponse::ImportProjectOk(ImportProjectResponse { imported: true })
        );

        // Tasks shift by 7 (the highest imported), worktrees by 9, prompts by 4.
        let moved = super::super::get(&conn, PROJECT, 8)
            .expect("read")
            .expect("the agent's task, moved");
        assert_eq!(moved.title, "Agent's");
        assert_eq!(moved.workspace_worktree_id, Some(10));
        let thread = super::super::list_comments(&conn, PROJECT, 8).expect("thread");
        assert_eq!(thread.len(), 1);
        assert_eq!(
            super::super::get(&conn, PROJECT, 7)
                .expect("read")
                .map(|t| t.title),
            Some("Task 7".to_string())
        );
        let worktree = |id| super::super::worktrees::get(&conn, PROJECT, id).expect("worktree");
        assert_eq!(worktree(9).and_then(|w| w.task_id), Some(7));
        assert_eq!(worktree(10).and_then(|w| w.task_id), Some(8));
        assert_eq!(
            worktree(11).map(|w| w.path),
            Some(".maestro/worktrees/automation-nightly-1".to_string())
        );
        assert_eq!(
            crate::prompt_store::get(&conn, PROJECT, 5)
                .expect("prompt")
                .map(|p| p.title),
            Some("Agent's".to_string())
        );
        let bound: Vec<(String, Option<i32>)> = crate::project_store::list(&conn, PROJECT, true)
            .expect("sessions")
            .into_iter()
            .map(|(row, _)| (row.acp_session_id, row.meta.task_id))
            .collect();
        assert!(bound.contains(&("daemon-session".to_string(), Some(8))));
        assert!(bound.contains(&("acp-1".to_string(), Some(7))));

        assert_eq!(
            super::super::create(&mut conn, &create_request("Next"))
                .expect("create")
                .id,
            9
        );
    }

    #[test]
    fn an_empty_import_marks_the_project() {
        let mut conn = crate::project_store::open_in_memory();
        let empty = ImportProjectRequest {
            project_path: PROJECT.to_string(),
            tasks: vec![],
            relationships: vec![],
            instructions: vec![],
            comments: vec![],
            attachments: vec![],
            worktrees: vec![],
            reviews: vec![],
            prompts: vec![],
            sessions: vec![],
        };
        let (reply, _) = answer(&mut conn, empty).expect("empty import");
        assert_eq!(
            reply,
            ServerResponse::ImportProjectOk(ImportProjectResponse { imported: true })
        );
        let (reply, _) = answer(&mut conn, full_request()).expect("second import");
        assert_eq!(
            reply,
            ServerResponse::ImportProjectOk(ImportProjectResponse { imported: false })
        );
        assert_eq!(count(&conn, "tasks"), 0);
    }

    #[test]
    fn an_imported_project_refuses_the_import_and_writes_nothing() {
        let mut conn = crate::project_store::open_in_memory();
        let mut first = full_request();
        first.sessions.clear();
        answer(&mut conn, first).expect("first import");
        let before = count(&conn, "task_comments");

        let mut second = full_request();
        second.tasks = vec![task(20)];
        second.comments = vec![comment(20, "late")];
        second.worktrees.clear();
        second.reviews.clear();
        second.relationships.clear();
        let (reply, pushes) = answer(&mut conn, second).expect("second import");
        assert_eq!(
            reply,
            ServerResponse::ImportProjectOk(ImportProjectResponse { imported: false })
        );
        assert!(pushes.is_empty());
        assert_eq!(super::super::get(&conn, PROJECT, 20).expect("read"), None);
        assert_eq!(count(&conn, "task_comments"), before);
        assert_eq!(
            count(&conn, "sessions"),
            0,
            "a refused import adds no session"
        );
    }

    #[test]
    fn a_session_the_daemon_already_has_is_kept() {
        let mut conn = crate::project_store::open_in_memory();
        crate::project_store::rename(
            &conn,
            &maestro_protocol::RenameSessionRequest {
                project_path: PROJECT.to_string(),
                agent_id: "claude-acp".to_string(),
                acp_session_id: "acp-1".to_string(),
                cwd: PROJECT.to_string(),
                name: "the daemon's name".to_string(),
            },
            PROJECT,
            Utc::now(),
        )
        .expect("an existing row");

        let mut request = full_request();
        request.sessions = vec![session("acp-1", "app name"), session("acp-2", "new")];
        answer(&mut conn, request).expect("import");

        let sessions = crate::project_store::list(&conn, PROJECT, true).expect("sessions");
        let names: Vec<_> = sessions
            .iter()
            .map(|(row, _)| {
                (
                    row.acp_session_id.as_str(),
                    row.meta.session_name.as_deref(),
                    row.closed,
                )
            })
            .collect();
        assert_eq!(
            names,
            [
                ("acp-1", Some("the daemon's name"), true),
                ("acp-2", Some("new"), false)
            ]
        );
    }

    #[test]
    fn a_bad_row_rolls_the_whole_import_back() {
        let mut conn = crate::project_store::open_in_memory();
        let mut request = full_request();
        request
            .comments
            .push(comment(99, "on a task the import lacks"));
        answer(&mut conn, request).expect_err("the foreign key refuses");

        for table in [
            "tasks",
            "task_comments",
            "task_relationships",
            "worktrees",
            "task_reviews",
            "review_comments",
            "prompts",
            "sessions",
            "project_counters",
        ] {
            assert_eq!(count(&conn, table), 0, "{table} kept a row");
        }
        let (reply, _) = answer(&mut conn, full_request()).expect("a retry");
        assert_eq!(
            reply,
            ServerResponse::ImportProjectOk(ImportProjectResponse { imported: true })
        );
    }
}
