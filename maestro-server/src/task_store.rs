//! A project's tasks, kept in `projects.db` so every app opening the project sees one board.
//!
//! Ported from the app's `task::crud`, `task::transition`, `task::comments` and their siblings with
//! their behaviour intact. What changed is the key: a task is `(project_path, id)`, and ids are
//! minted per project from a counter that never goes back, so a deleted task's `task-<id>` folder
//! or `maestro/<id>-` branch is never mistaken for a new task's.
//!
//! Every function that reads and then writes runs in one transaction. The app got that atomicity
//! from its one `Mutex<Connection>`; here the guard travels with the request instead.

pub mod project_import;
pub mod requests;
pub mod reviews;
mod threads;
pub mod transition;
pub mod worktrees;

pub use threads::*;

use chrono::Utc;
use maestro_protocol::{
    BranchMode, CloseRefinementRequest, CreateTaskRequest, EndTaskTurnRequest, ImportTasksRequest,
    ListQueueCandidatesRequest, RequestTaskExecutionRequest, Task, TaskPhase, TaskStatus,
    TaskTransition, TaskUpdate, TransitionGuard, TurnEnding, WorkspaceMode,
};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{de::DeserializeOwned, Serialize};

/// Version 2 of `projects.db`: the task tables, mirroring the app's with `project_path` where
/// `project_id` was. There is no foreign key to `worktrees` from `workspace_worktree_id`.
///
/// Frozen: a later change to these tables is a new entry in `project_store::MIGRATIONS`.
pub const V2_TASKS: &str = "
-- The highest task id a project has ever minted. Never lowered, so an id is never reused.
CREATE TABLE IF NOT EXISTS project_counters (
    project_path  TEXT PRIMARY KEY,
    last_task_id  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
    project_path TEXT NOT NULL,
    id INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'Planning',
    priority TEXT NOT NULL DEFAULT 'Medium',
    base_branch TEXT NOT NULL,
    archived_at TEXT,
    external_id TEXT,
    is_imported INTEGER DEFAULT 0,
    import_source TEXT,
    skills TEXT DEFAULT '[]',
    model_override TEXT,
    mcp_allowlist TEXT,
    skills_override TEXT,
    external_url TEXT,
    external_updated_at TEXT,
    labels TEXT DEFAULT '[]',
    auto_approve INTEGER NOT NULL DEFAULT 0,
    workspace_mode TEXT NOT NULL DEFAULT 'NewWorktree',
    workspace_worktree_id INTEGER,
    workspace_branch_mode TEXT NOT NULL DEFAULT 'Create',
    workspace_branch TEXT,
    agent_id TEXT,
    permission_mode_override TEXT,
    execution_start_sha TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    phase TEXT,
    phase_status TEXT,
    ball TEXT NOT NULL DEFAULT 'None',
    completion TEXT,
    execute_requested_at TEXT,
    pull_request_url TEXT,
    pull_request_number INTEGER,
    review_rounds INTEGER NOT NULL DEFAULT 0,
    fix_rounds INTEGER NOT NULL DEFAULT 0,
    pull_request_ci TEXT,
    profile_overrides TEXT,
    PRIMARY KEY (project_path, id)
);
CREATE INDEX IF NOT EXISTS idx_tasks_project_status ON tasks(project_path, status);

CREATE TABLE IF NOT EXISTS task_relationships (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_path TEXT NOT NULL,
    from_task_id INTEGER NOT NULL,
    to_task_id INTEGER NOT NULL,
    relationship_type TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (project_path, from_task_id) REFERENCES tasks(project_path, id) ON DELETE CASCADE,
    FOREIGN KEY (project_path, to_task_id) REFERENCES tasks(project_path, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS task_instructions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_path TEXT NOT NULL,
    task_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    source TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (project_path, task_id) REFERENCES tasks(project_path, id) ON DELETE CASCADE
);

-- The outcome thread. `body` holds the text, `external_ref` a pointer to bytes stored elsewhere.
CREATE TABLE IF NOT EXISTS task_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_path TEXT NOT NULL,
    task_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    author TEXT NOT NULL,
    body TEXT,
    external_ref TEXT,
    phase TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (project_path, task_id) REFERENCES tasks(project_path, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_task_comments_task_id ON task_comments(project_path, task_id);

CREATE TABLE IF NOT EXISTS task_attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_path TEXT NOT NULL,
    task_id INTEGER NOT NULL,
    filename TEXT NOT NULL,
    file_path TEXT NOT NULL,
    file_size INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (project_path, task_id) REFERENCES tasks(project_path, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_task_attachments_task_id ON task_attachments(project_path, task_id);
";

/// How many times a review agent may send a task back, as the app's `acp::completion` has it.
const REVIEW_ROUND_CAP: i32 = 3;

const TASK_SELECT: &str = "SELECT * FROM tasks";

/// A protocol enum as the column stores it: the variant name, which is what the app wrote.
fn text<T: Serialize>(value: T) -> String {
    serde_json::to_value(value)
        .ok()
        .and_then(|value| value.as_str().map(str::to_owned))
        .unwrap_or_default()
}

fn parse<T: DeserializeOwned>(text: &str) -> Option<T> {
    serde_json::from_value(serde_json::Value::String(text.to_owned())).ok()
}

fn json<T: Serialize>(value: &T) -> Result<String, String> {
    serde_json::to_string(value).map_err(|e| format!("JSON serialization failed: {e}"))
}

fn transaction(conn: &mut Connection) -> Result<Transaction<'_>, String> {
    conn.transaction()
        .map_err(|e| format!("Transaction failed: {e}"))
}

fn commit(tx: Transaction) -> Result<(), String> {
    tx.commit().map_err(|e| format!("Commit failed: {e}"))
}

/// Unreadable status, priority and modes fall back to their column defaults, and unreadable
/// pipeline fields to `None`, exactly as the app's `Task::from_row` does.
fn from_row(row: &rusqlite::Row) -> rusqlite::Result<Task> {
    let optional_text = |column: &str| -> rusqlite::Result<Option<String>> { row.get(column) };
    Ok(Task {
        id: row.get("id")?,
        project_path: row.get("project_path")?,
        title: row.get("title")?,
        description: row.get("description")?,
        status: parse(&row.get::<_, String>("status")?).unwrap_or(TaskStatus::Planning),
        priority: parse(&row.get::<_, String>("priority")?)
            .unwrap_or(maestro_protocol::TaskPriority::Medium),
        base_branch: row.get("base_branch")?,
        archived_at: row.get("archived_at")?,
        external_id: row.get("external_id")?,
        is_imported: row.get("is_imported")?,
        import_source: row.get("import_source")?,
        skills: row
            .get::<_, Option<String>>("skills")?
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default(),
        model_override: row.get("model_override")?,
        mcp_allowlist: row
            .get::<_, Option<String>>("mcp_allowlist")?
            .and_then(|s| serde_json::from_str(&s).ok()),
        skills_override: row
            .get::<_, Option<String>>("skills_override")?
            .and_then(|s| serde_json::from_str(&s).ok()),
        labels: row
            .get::<_, Option<String>>("labels")?
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default(),
        external_url: row.get("external_url")?,
        external_updated_at: row.get("external_updated_at")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        auto_approve: row.get("auto_approve")?,
        workspace_mode: optional_text("workspace_mode")?
            .and_then(|s| parse(&s))
            .unwrap_or(WorkspaceMode::NewWorktree),
        workspace_worktree_id: row.get("workspace_worktree_id")?,
        workspace_branch_mode: optional_text("workspace_branch_mode")?
            .and_then(|s| parse(&s))
            .unwrap_or(BranchMode::Create),
        workspace_branch: row.get("workspace_branch")?,
        agent_id: row.get("agent_id")?,
        permission_mode_override: row.get("permission_mode_override")?,
        execution_start_sha: row.get("execution_start_sha")?,
        phase: optional_text("phase")?.and_then(|s| parse(&s)),
        phase_status: optional_text("phase_status")?.and_then(|s| parse(&s)),
        ball: optional_text("ball")?
            .and_then(|s| parse(&s))
            .unwrap_or(maestro_protocol::TaskBall::None),
        completion: optional_text("completion")?.and_then(|s| parse(&s)),
        execute_requested_at: row.get("execute_requested_at")?,
        pull_request_url: row.get("pull_request_url")?,
        pull_request_number: row.get("pull_request_number")?,
        review_rounds: row.get("review_rounds")?,
        fix_rounds: row.get("fix_rounds")?,
        pull_request_ci: optional_text("pull_request_ci")?.and_then(|s| parse(&s)),
        profile_overrides: row.get("profile_overrides")?,
        claimed_from: optional_text("claimed_from")?.and_then(|s| parse(&s)),
    })
}

fn read(conn: &Connection, project_path: &str, task_id: i32) -> Result<Task, String> {
    get(conn, project_path, task_id)?.ok_or_else(|| format!("Task {task_id} not found"))
}

/// Every task of a project, newest first, archived ones included.
pub fn list(conn: &Connection, project_path: &str) -> Result<Vec<Task>, String> {
    query(
        conn,
        &format!("{TASK_SELECT} WHERE project_path = ?1 ORDER BY created_at DESC"),
        params![project_path],
    )
}

fn query(conn: &Connection, sql: &str, args: impl rusqlite::Params) -> Result<Vec<Task>, String> {
    let mut statement = conn.prepare(sql).map_err(|e| e.to_string())?;
    let tasks = statement
        .query_map(args, from_row)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(tasks)
}

pub fn get(conn: &Connection, project_path: &str, task_id: i32) -> Result<Option<Task>, String> {
    conn.query_row(
        &format!("{TASK_SELECT} WHERE project_path = ?1 AND id = ?2"),
        params![project_path, task_id],
        from_row,
    )
    .optional()
    .map_err(|e| format!("Failed to read task {task_id}: {e}"))
}

/// The project's next task id. Counted from what the project ever minted, not from what is left.
fn mint_id(conn: &Connection, project_path: &str) -> Result<i32, String> {
    conn.query_row(
        "INSERT INTO project_counters (project_path, last_task_id) VALUES (?1, 1)
         ON CONFLICT(project_path) DO UPDATE SET last_task_id = last_task_id + 1
         RETURNING last_task_id",
        params![project_path],
        |row| row.get(0),
    )
    .map_err(|e| format!("Failed to mint a task id: {e}"))
}

pub fn create(conn: &mut Connection, request: &CreateTaskRequest) -> Result<Task, String> {
    let trimmed_title = request.title.trim();
    if trimmed_title.len() < 3 || trimmed_title.len() > 255 {
        return Err("Title must be 3-255 characters".to_string());
    }
    let description = request
        .description
        .as_deref()
        .map(str::trim)
        .filter(|d| !d.is_empty());
    let now = Utc::now().to_rfc3339();

    let tx = transaction(conn)?;
    let id = mint_id(&tx, &request.project_path)?;
    tx.execute(
        "INSERT INTO tasks (project_path, id, title, description, skills, status, base_branch,
                            agent_id, priority, auto_approve, workspace_mode, workspace_worktree_id,
                            workspace_branch_mode, workspace_branch, model_override, labels,
                            created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 'Planning', ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15,
                 ?16, ?16)",
        params![
            request.project_path,
            id,
            request.title,
            description,
            json(&request.skills)?,
            request.base_branch,
            request.agent_id,
            text(
                request
                    .priority
                    .unwrap_or(maestro_protocol::TaskPriority::Medium)
            ),
            request.auto_approve,
            text(request.workspace_mode),
            // A pin only means something for the mode that has one.
            match request.workspace_mode {
                WorkspaceMode::ReuseWorkspace => request.workspace_worktree_id,
                _ => None,
            },
            text(request.workspace_branch_mode),
            // Likewise a branch name: only the mode that creates a worktree picks one, and only
            // `Create` names it.
            match (request.workspace_mode, request.workspace_branch_mode) {
                (WorkspaceMode::NewWorktree, BranchMode::Create) => {
                    request.workspace_branch.as_deref()
                }
                _ => None,
            },
            request.model_override,
            json(&request.labels)?,
            now,
        ],
    )
    .map_err(|e| e.to_string())?;
    let task = read(&tx, &request.project_path, id)?;
    commit(tx)?;
    Ok(task)
}

/// Write the columns `update` names. See `TaskUpdate` for which of them leave `updated_at` alone.
pub fn update(
    conn: &mut Connection,
    project_path: &str,
    task_id: i32,
    update: &TaskUpdate,
) -> Result<Task, String> {
    let tx = transaction(conn)?;
    write_update(&tx, project_path, task_id, update)?;
    let task = read(&tx, project_path, task_id)?;
    commit(tx)?;
    Ok(task)
}

/// [`update`] inside a transaction the caller holds, for a composite step.
fn write_update(
    conn: &Connection,
    project_path: &str,
    task_id: i32,
    update: &TaskUpdate,
) -> Result<(), String> {
    let mut sets: Vec<(&str, Box<dyn rusqlite::ToSql>)> = Vec::new();

    if let Some(v) = &update.description {
        sets.push(("description", Box::new(v.clone())));
    }
    if let Some(v) = &update.title {
        sets.push(("title", Box::new(v.clone())));
    }
    if let Some(v) = update.priority {
        sets.push(("priority", Box::new(text(v))));
    }
    if let Some(v) = &update.base_branch {
        sets.push(("base_branch", Box::new(v.clone())));
    }
    if let Some(v) = &update.skills {
        sets.push(("skills", Box::new(json(v)?)));
    }
    if let Some(v) = &update.agent_id {
        sets.push(("agent_id", Box::new(v.clone())));
    }
    if let Some(v) = &update.labels {
        sets.push(("labels", Box::new(json(v)?)));
    }
    if let Some(v) = update.auto_approve {
        sets.push(("auto_approve", Box::new(v)));
    }
    // The mode writes its companion too, so leaving `ReuseWorkspace` cannot leave a pin behind
    // that nothing will ever look at again, and `Checkout` cannot keep a branch name.
    if let Some(mode) = update.workspace_mode {
        sets.push(("workspace_mode", Box::new(text(mode))));
        sets.push((
            "workspace_worktree_id",
            Box::new(match mode {
                WorkspaceMode::ReuseWorkspace => update.workspace_worktree_id,
                _ => None,
            }),
        ));
    }
    if let Some(mode) = update.workspace_branch_mode {
        sets.push(("workspace_branch_mode", Box::new(text(mode))));
        sets.push((
            "workspace_branch",
            Box::new(match mode {
                BranchMode::Create => update.workspace_branch.clone(),
                BranchMode::Checkout => None,
            }),
        ));
    }
    if let Some(v) = &update.model_override {
        sets.push(("model_override", Box::new(v.clone())));
    }
    if let Some(v) = &update.mcp_allowlist {
        sets.push(("mcp_allowlist", Box::new(v.as_ref().map(json).transpose()?)));
    }
    if let Some(v) = &update.skills_override {
        sets.push((
            "skills_override",
            Box::new(v.as_ref().map(json).transpose()?),
        ));
    }
    if let Some(v) = &update.permission_mode_override {
        sets.push(("permission_mode_override", Box::new(v.clone())));
    }
    if let Some(v) = &update.profile_overrides {
        sets.push(("profile_overrides", Box::new(v.clone())));
    }
    if let Some(v) = &update.external_updated_at {
        sets.push(("external_updated_at", Box::new(v.clone())));
    }
    let edits = sets.len();
    let edited = edits > 0 || update.status.is_some();

    // The pipeline's own columns: a poll or a spawn is not an edit to the task.
    if let Some(v) = &update.execution_start_sha {
        sets.push(("execution_start_sha", Box::new(v.clone())));
    }
    if let Some(v) = &update.pull_request_url {
        sets.push(("pull_request_url", Box::new(v.clone())));
    }
    if let Some(v) = update.pull_request_number {
        sets.push(("pull_request_number", Box::new(v)));
    }
    if let Some(v) = update.pull_request_ci {
        sets.push(("pull_request_ci", Box::new(v.map(text))));
    }
    let pipeline = sets.len() > edits
        || update.increment_fix_rounds
        || update.execution_start_sha_if_empty.is_some();
    // An update naming nothing still bumps it, as the app's always did.
    if edited || !pipeline {
        sets.push(("updated_at", Box::new(Utc::now().to_rfc3339())));
    }

    let mut assignments: Vec<String> = sets.iter().map(|(c, _)| format!("{c} = ?")).collect();
    if update.increment_fix_rounds {
        assignments.push("fix_rounds = fix_rounds + 1".to_string());
    }
    let mut values: Vec<Box<dyn rusqlite::ToSql>> = sets.into_iter().map(|(_, v)| v).collect();
    if let Some(sha) = &update.execution_start_sha_if_empty {
        assignments
            .push("execution_start_sha = COALESCE(NULLIF(execution_start_sha, ''), ?)".to_string());
        values.push(Box::new(sha.clone()));
    }
    values.push(Box::new(project_path.to_string()));
    values.push(Box::new(task_id));

    conn.execute(
        &format!(
            "UPDATE tasks SET {} WHERE project_path = ? AND id = ?",
            assignments.join(", ")
        ),
        rusqlite::params_from_iter(values.iter().map(|v| v.as_ref())),
    )
    .map_err(|e| e.to_string())?;

    // Status is not part of the SET above: moving a task also resets its pipeline activity, and
    // that correlation belongs to the transition.
    if let Some(status) = update.status {
        // Sending a task back to a board column un-archives it, or a task restored from the
        // archive would sit in a column and in the archive list at once.
        if status != TaskStatus::Cancelled {
            conn.execute(
                "UPDATE tasks SET archived_at = NULL WHERE project_path = ?1 AND id = ?2",
                params![project_path, task_id],
            )
            .map_err(|e| e.to_string())?;
        }
        transition::apply(
            conn,
            project_path,
            task_id,
            TaskTransition::ManualMove(status),
            &TransitionGuard::Always,
        )?;
    }
    Ok(())
}

pub fn archive(conn: &Connection, project_path: &str, task_id: i32) -> Result<Task, String> {
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE tasks SET archived_at = ?1, updated_at = ?1 WHERE project_path = ?2 AND id = ?3",
        params![now, project_path, task_id],
    )
    .map_err(|e| e.to_string())?;
    read(conn, project_path, task_id)
}

/// Archive, then apply `Cancelled`, so the transition's read-back returns the finished row.
pub fn cancel(conn: &mut Connection, project_path: &str, task_id: i32) -> Result<Task, String> {
    let tx = transaction(conn)?;
    tx.execute(
        "UPDATE tasks SET archived_at = ?1 WHERE project_path = ?2 AND id = ?3",
        params![Utc::now().to_rfc3339(), project_path, task_id],
    )
    .map_err(|e| e.to_string())?;
    let task = transition::apply(
        &tx,
        project_path,
        task_id,
        TaskTransition::Cancelled,
        &TransitionGuard::Always,
    )?
    .ok_or_else(|| format!("Task {task_id} not found"))?;
    commit(tx)?;
    Ok(task)
}

/// Its threads go with it, by cascade. Its id is not given back.
pub fn delete(conn: &Connection, project_path: &str, task_id: i32) -> Result<(), String> {
    conn.execute(
        "DELETE FROM tasks WHERE project_path = ?1 AND id = ?2",
        params![project_path, task_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Answer the refiner's proposal gate.
///
/// Accepting is the first time the description changes, so rejecting is safe by construction. An
/// accepted proposal is the description now and leaves the thread, where it would show the same
/// text twice; a rejected one stays, since what was turned down exists nowhere else.
pub fn close_refinement(
    conn: &mut Connection,
    request: &CloseRefinementRequest,
) -> Result<Task, String> {
    let (project_path, task_id) = (request.project_path.as_str(), request.task_id);
    let tx = transaction(conn)?;
    if request.accept {
        let proposal = latest_of_kind(&tx, project_path, task_id, "proposal")?
            .ok_or("This task has no proposal to accept")?;
        let body = proposal.body.ok_or("This task has no proposal to accept")?;
        tx.execute(
            "UPDATE tasks SET description = ?1 WHERE project_path = ?2 AND id = ?3",
            params![body, project_path, task_id],
        )
        .map_err(|e| format!("Failed to apply the proposal to task {task_id}: {e}"))?;
        tx.execute("DELETE FROM task_comments WHERE id = ?1", [proposal.id])
            .map_err(|e| format!("Failed to tidy task {task_id}'s thread: {e}"))?;
    }
    let task = transition::apply(
        &tx,
        project_path,
        task_id,
        TaskTransition::RefinementClosed,
        &TransitionGuard::Always,
    )?
    .ok_or_else(|| format!("Task {task_id} not found"))?;
    commit(tx)?;
    Ok(task)
}

/// Defer an Execute the host has no slot for: a Planning task moves to Queue, and a queued task
/// with no phase is stamped with `execute_requested_at` unless it already has one.
///
/// `false` when the task moved between the button and here, so the caller goes ahead and lets the
/// claim refuse it, which produces the right message. `COALESCE` so pressing Execute again on a
/// deferred task keeps its place among the deferrals.
pub fn request_execution(
    conn: &mut Connection,
    request: &RequestTaskExecutionRequest,
) -> Result<bool, String> {
    let (project_path, task_id) = (request.project_path.as_str(), request.task_id);
    let tx = transaction(conn)?;
    transition::apply(
        &tx,
        project_path,
        task_id,
        TaskTransition::ManualMove(TaskStatus::Queue),
        &TransitionGuard::Status(vec![TaskStatus::Planning]),
    )?;
    let stamped = tx
        .execute(
            "UPDATE tasks SET execute_requested_at = COALESCE(execute_requested_at, ?1)
             WHERE project_path = ?2 AND id = ?3 AND status = 'Queue' AND phase IS NULL",
            params![Utc::now().to_rfc3339(), project_path, task_id],
        )
        .map_err(|e| format!("Failed to record the deferred execution: {e}"))?;
    commit(tx)?;
    Ok(stamped > 0)
}

/// The tasks the scheduler may start, best first: deferrals in the order they were made, then by
/// priority and age. Without `include_undeferred` only deferrals, which are the one thing manual
/// mode may start. `phase IS NULL` keeps a task already being spawned, or failed at it, out.
pub fn queue_candidates(
    conn: &Connection,
    request: &ListQueueCandidatesRequest,
) -> Result<Vec<i32>, String> {
    let mut statement = conn
        .prepare(
            "SELECT id FROM tasks
             WHERE project_path = ?1 AND status = 'Queue' AND phase IS NULL
               AND (?2 OR execute_requested_at IS NOT NULL)
             ORDER BY
                 execute_requested_at IS NULL ASC,
                 execute_requested_at ASC,
                 CASE priority
                     WHEN 'Urgent' THEN 0
                     WHEN 'High' THEN 1
                     WHEN 'Medium' THEN 2
                     WHEN 'Low' THEN 3
                     ELSE 4
                 END ASC,
                 created_at ASC",
        )
        .map_err(|e| format!("Failed to prepare query: {e}"))?;
    let ids = statement
        .query_map(
            params![request.project_path, request.include_undeferred],
            |row| row.get(0),
        )
        .map_err(|e| format!("Failed to query ready tasks: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("Failed to read ready tasks: {e}"))?;
    Ok(ids)
}

/// Unarchived tasks waiting on a pull request, for the forge sweep.
pub fn awaiting_merge(conn: &Connection, project_path: &str) -> Result<Vec<Task>, String> {
    query(
        conn,
        &format!(
            "{TASK_SELECT} WHERE project_path = ?1 AND phase = 'AwaitingMerge'
               AND pull_request_number IS NOT NULL AND archived_at IS NULL ORDER BY id"
        ),
        params![project_path],
    )
}

/// Create a Planning task per issue the project has not imported yet, returning the new ones.
pub fn import(conn: &mut Connection, request: &ImportTasksRequest) -> Result<Vec<Task>, String> {
    let project_path = request.project_path.as_str();
    let now = Utc::now().to_rfc3339();
    let tx = transaction(conn)?;
    let mut created = Vec::new();
    for issue in &request.issues {
        let imported: bool = tx
            .query_row(
                "SELECT EXISTS (SELECT 1 FROM tasks WHERE project_path = ?1 AND external_id = ?2)",
                params![project_path, issue.external_id],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        if imported {
            continue;
        }
        if issue.title.len() > 1000 || issue.external_id.len() > 200 {
            return Err(format!(
                "Issue fields exceed maximum allowed length: {}",
                issue.external_id
            ));
        }
        let import_source = issue.external_id.split(':').next().unwrap_or("");
        let id = mint_id(&tx, project_path)?;
        tx.execute(
            "INSERT INTO tasks (project_path, id, title, description, status, priority, base_branch,
                                is_imported, import_source, external_id, external_url,
                                external_updated_at, labels, skills, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, 'Planning', ?5, ?6, 1, ?7, ?8, ?9, ?10, ?11, '[]', ?12, ?12)",
            params![
                project_path,
                id,
                issue.title,
                issue.body,
                text(issue.priority),
                request.base_branch,
                import_source,
                issue.external_id,
                issue.url,
                issue.updated_at,
                json(&issue.labels)?,
                now,
            ],
        )
        .map_err(|e| e.to_string())?;
        created.push(read(&tx, project_path, id)?);
    }
    commit(tx)?;
    Ok(created)
}

/// The turn end, under one lock: read the phase, turn a reviewer's reply into its verdict, apply
/// the transition while the task still has a phase, and file the closing message by what the
/// phase produced.
///
/// Filed only when the transition applied, since a turn resolved against a task the user already
/// moved has no claim on its record either.
///
/// A delivered artifact is a plan-mode agent's, so it counts only while the task is still in a
/// read-only phase. Anywhere else the task moved on under the request, and the plan it carries is
/// no other phase's outcome: nothing is written and `None` is returned.
pub fn end_turn(
    conn: &mut Connection,
    request: &EndTaskTurnRequest,
) -> Result<Option<Task>, String> {
    let (project_path, task_id) = (request.project_path.as_str(), request.task_id);
    let tx = transaction(conn)?;
    let phase = transition::read_state(&tx, project_path, task_id)?.phase;
    if matches!(request.ending, TurnEnding::ArtifactDelivered)
        && !matches!(
            phase,
            Some(TaskPhase::Refining | TaskPhase::Drafting | TaskPhase::SelfReview)
        )
    {
        return Ok(None);
    }
    let delivered = matches!(
        request.ending,
        TurnEnding::Completed { .. } | TurnEnding::ArtifactDelivered
    );

    let event = if phase == Some(TaskPhase::SelfReview) && delivered {
        review_verdict_event(&tx, project_path, task_id, request.review_approved)
    } else {
        match request.ending {
            TurnEnding::Completed {
                is_git_repo,
                has_changes,
                reviewer_pending,
            } => TaskTransition::TurnCompleted {
                is_git_repo,
                has_changes,
                reviewer_pending,
            },
            TurnEnding::Stalled => TaskTransition::AwaitingUserInput,
            TurnEnding::Failed => TaskTransition::PhaseFailed,
            TurnEnding::ArtifactDelivered => TaskTransition::ArtifactDelivered,
        }
    };

    let task = transition::apply(&tx, project_path, task_id, event, &TransitionGuard::Active)?;
    if task.is_some() {
        let phase = phase.map(text);
        if delivered {
            record_outcome(
                &tx,
                project_path,
                task_id,
                phase.as_deref(),
                &request.closing_message,
            )?;
        } else {
            record_unfinished(
                &tx,
                project_path,
                task_id,
                phase.as_deref(),
                &request.closing_message,
            )?;
        }
    }
    commit(tx)?;
    Ok(task)
}

/// Turn the review agent's reply into the transition it implies, counting the round when the loop
/// goes round again. Counted here, where the decision to spend another round is taken, so a
/// rejected task that never got a coder cannot be rejected again for free.
fn review_verdict_event(
    conn: &Connection,
    project_path: &str,
    task_id: i32,
    approved: bool,
) -> TaskTransition {
    if approved {
        return TaskTransition::ReviewFinished;
    }
    let rounds: i32 = conn
        .query_row(
            "SELECT review_rounds FROM tasks WHERE project_path = ?1 AND id = ?2",
            params![project_path, task_id],
            |row| row.get(0),
        )
        .unwrap_or(REVIEW_ROUND_CAP);
    if rounds >= REVIEW_ROUND_CAP {
        crate::send_diag(
            "info",
            format!(
                "[task-store] task {task_id} hit the review round cap ({REVIEW_ROUND_CAP}); \
                 escalating to the user"
            ),
        );
        return TaskTransition::ReviewFinished;
    }
    if let Err(e) = conn.execute(
        "UPDATE tasks SET review_rounds = review_rounds + 1 WHERE project_path = ?1 AND id = ?2",
        params![project_path, task_id],
    ) {
        // Failing to count would make the loop unbounded, which is the one thing it must not be.
        crate::send_diag(
            "error",
            format!("[task-store] could not count a review round for task {task_id}: {e}"),
        );
        return TaskTransition::ReviewFinished;
    }
    TaskTransition::ReviewRejected
}

#[cfg(test)]
mod tests {
    use super::*;
    use maestro_protocol::{ImportedIssue, PhaseStatus, TaskBall, TaskPriority};

    pub(super) const PROJECT: &str = "/srv/shop";

    pub(super) fn new_task(conn: &mut Connection, project_path: &str, title: &str) -> Task {
        create(
            conn,
            &CreateTaskRequest {
                project_path: project_path.to_string(),
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
            },
        )
        .expect("create a task")
    }

    /// A store with one queued task in [`PROJECT`].
    pub(super) fn db_with_task() -> (Connection, i32) {
        let mut conn = crate::project_store::open_in_memory();
        let task = new_task(&mut conn, PROJECT, "demo task");
        update(
            &mut conn,
            PROJECT,
            task.id,
            &TaskUpdate {
                status: Some(TaskStatus::Queue),
                ..TaskUpdate::default()
            },
        )
        .expect("queue it");
        (conn, task.id)
    }

    fn count(conn: &Connection, table: &str) -> i64 {
        conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
            row.get(0)
        })
        .expect("count")
    }

    #[test]
    fn ids_are_per_project_and_never_reused() {
        let mut conn = crate::project_store::open_in_memory();
        assert_eq!(new_task(&mut conn, "/a", "first of a").id, 1);
        assert_eq!(new_task(&mut conn, "/b", "first of b").id, 1);
        let top = new_task(&mut conn, "/a", "second of a");
        assert_eq!(top.id, 2);

        delete(&conn, "/a", top.id).expect("delete");
        assert_eq!(new_task(&mut conn, "/a", "third of a").id, 3);
        assert_eq!(list(&conn, "/b").expect("list").len(), 1);
    }

    #[test]
    fn deleting_a_task_takes_its_threads_and_nothing_else() {
        let mut conn = crate::project_store::open_in_memory();
        let doomed = new_task(&mut conn, PROJECT, "doomed task");
        let kept = new_task(&mut conn, PROJECT, "kept task");
        let other = new_task(&mut conn, "/other", "same id elsewhere");
        assert_eq!(other.id, doomed.id);
        for task in [&doomed, &other] {
            append(
                &conn,
                &task.project_path,
                task.id,
                "note",
                "user",
                Some("hi"),
                None,
                None,
            )
            .expect("comment");
            add_attachment(
                &conn,
                &task.project_path,
                task.id,
                "a.txt",
                "/nowhere/a.txt",
            )
            .expect("attachment");
            add_instruction(&conn, &task.project_path, task.id, "do it", "user")
                .expect("instruction");
        }
        add_relationship(&conn, PROJECT, doomed.id, kept.id, "blocks").expect("relationship");

        delete(&conn, PROJECT, doomed.id).expect("delete");

        for table in ["task_comments", "task_attachments", "task_instructions"] {
            assert_eq!(
                count(&conn, table),
                1,
                "{table} keeps the other project's row"
            );
        }
        assert_eq!(count(&conn, "task_relationships"), 0);
        assert!(get(&conn, "/other", other.id).expect("get").is_some());
    }

    #[test]
    fn a_thread_cannot_hang_off_a_task_that_does_not_exist() {
        let conn = crate::project_store::open_in_memory();
        assert!(append(&conn, PROJECT, 9, "note", "user", Some("hi"), None, None).is_err());
    }

    #[test]
    fn create_task_rejects_short_name() {
        let mut conn = crate::project_store::open_in_memory();
        let err = create(
            &mut conn,
            &CreateTaskRequest {
                title: "ab".to_string(),
                ..request_for(PROJECT)
            },
        )
        .unwrap_err();
        assert!(err.contains("Title must be 3-255 characters"), "got: {err}");
    }

    fn request_for(project_path: &str) -> CreateTaskRequest {
        CreateTaskRequest {
            project_path: project_path.to_string(),
            title: "Valid Task Name".to_string(),
            description: Some("  a description  ".to_string()),
            skills: vec!["rust".to_string()],
            labels: vec!["bug".to_string()],
            base_branch: "main".to_string(),
            agent_id: None,
            priority: Some(TaskPriority::High),
            auto_approve: true,
            workspace_mode: WorkspaceMode::RepositoryDirectory,
            workspace_worktree_id: Some(4),
            workspace_branch_mode: BranchMode::Create,
            workspace_branch: Some("topic".to_string()),
            model_override: None,
        }
    }

    #[test]
    fn a_created_task_reads_back_as_written() {
        let mut conn = crate::project_store::open_in_memory();
        let task = create(&mut conn, &request_for(PROJECT)).expect("create");
        assert_eq!(task.status, TaskStatus::Planning);
        assert_eq!(task.priority, TaskPriority::High);
        assert_eq!(task.description.as_deref(), Some("a description"));
        assert_eq!(task.skills, ["rust"]);
        assert_eq!(task.labels, ["bug"]);
        assert!(task.auto_approve);
        assert_eq!(task.ball, TaskBall::None);
        // Neither companion survives a mode that has no use for it.
        assert_eq!(task.workspace_worktree_id, None);
        assert_eq!(task.workspace_branch, None);
        assert_eq!(get(&conn, PROJECT, task.id).expect("get"), Some(task));
    }

    fn archived_task(conn: &mut Connection) -> i32 {
        let task = new_task(conn, PROJECT, "Archived task");
        conn.execute(
            "UPDATE tasks SET status = 'Done', archived_at = '2024-01-02T00:00:00Z' WHERE id = ?1",
            [task.id],
        )
        .expect("archive");
        task.id
    }

    /// Done is the only column filtered on `archived_at`, so an archived task moved back onto the
    /// board would otherwise be listed in the archive and invisible in the column it was sent to.
    #[test]
    fn moving_a_task_back_onto_the_board_un_archives_it() {
        let mut conn = crate::project_store::open_in_memory();
        let task_id = archived_task(&mut conn);
        let update_to = TaskUpdate {
            status: Some(TaskStatus::Planning),
            ..TaskUpdate::default()
        };
        let task = update(&mut conn, PROJECT, task_id, &update_to).expect("update");
        assert_eq!(task.archived_at, None);
        assert_eq!(task.status, TaskStatus::Planning);
    }

    /// Only a status change may un-archive: editing an archived task's title must leave it filed.
    #[test]
    fn editing_an_archived_task_leaves_it_archived() {
        let mut conn = crate::project_store::open_in_memory();
        let task_id = archived_task(&mut conn);
        let rename = TaskUpdate {
            title: Some("Renamed while archived".to_string()),
            ..TaskUpdate::default()
        };
        assert!(update(&mut conn, PROJECT, task_id, &rename)
            .expect("update")
            .archived_at
            .is_some());
    }

    #[test]
    fn an_update_clears_only_what_it_sends_null_for() {
        let mut conn = crate::project_store::open_in_memory();
        let task = create(&mut conn, &request_for(PROJECT)).expect("create");
        let settings = TaskUpdate {
            mcp_allowlist: Some(Some(vec!["maestro".to_string()])),
            profile_overrides: Some(Some(r#"{"Planner":null}"#.to_string())),
            ..TaskUpdate::default()
        };
        update(&mut conn, PROJECT, task.id, &settings).expect("update");
        let clear = TaskUpdate {
            description: Some(None),
            mcp_allowlist: Some(None),
            ..TaskUpdate::default()
        };
        let task = update(&mut conn, PROJECT, task.id, &clear).expect("update");
        assert_eq!(task.description, None);
        assert_eq!(task.mcp_allowlist, None);
        assert_eq!(
            task.profile_overrides.as_deref(),
            Some(r#"{"Planner":null}"#)
        );
    }

    fn age(conn: &Connection, task_id: i32) {
        conn.execute(
            "UPDATE tasks SET updated_at = '2000-01-01T00:00:00Z' WHERE id = ?1",
            [task_id],
        )
        .expect("age");
    }

    /// A poll or a spawn is not an edit: `updated_at` is what sorts the Changed tab and dates a
    /// card, and a sweep every three minutes would otherwise make every open PR "just edited".
    #[test]
    fn pipeline_columns_leave_updated_at_alone_and_edits_bump_it() {
        let mut conn = crate::project_store::open_in_memory();
        let task = new_task(&mut conn, PROJECT, "a task");
        age(&conn, task.id);

        let pipeline = TaskUpdate {
            execution_start_sha: Some(Some("abc".to_string())),
            pull_request_url: Some("https://example.com/pr/1".to_string()),
            pull_request_number: Some(1),
            pull_request_ci: Some(Some(maestro_protocol::PullRequestCi::Failing)),
            increment_fix_rounds: true,
            ..TaskUpdate::default()
        };
        let task = update(&mut conn, PROJECT, task.id, &pipeline).expect("update");
        assert_eq!(task.updated_at, "2000-01-01T00:00:00Z");
        assert_eq!(task.fix_rounds, 1);
        assert_eq!(
            task.pull_request_ci,
            Some(maestro_protocol::PullRequestCi::Failing)
        );

        let edit = TaskUpdate {
            pull_request_ci: Some(None),
            labels: Some(vec!["x".to_string()]),
            ..TaskUpdate::default()
        };
        let task = update(&mut conn, PROJECT, task.id, &edit).expect("update");
        assert_ne!(task.updated_at, "2000-01-01T00:00:00Z");
        assert_eq!(task.pull_request_ci, None);
    }

    /// A resumed session must keep the anchor its first run recorded, or it hides that run's work.
    #[test]
    fn the_start_sha_is_written_only_where_there_is_none() {
        let mut conn = crate::project_store::open_in_memory();
        let task_id = new_task(&mut conn, PROJECT, "a task").id;
        let anchor = |conn: &mut Connection, sha: &str| {
            let only_if_empty = TaskUpdate {
                execution_start_sha_if_empty: Some(sha.to_string()),
                ..TaskUpdate::default()
            };
            update(conn, PROJECT, task_id, &only_if_empty)
                .expect("update")
                .execution_start_sha
        };
        assert_eq!(anchor(&mut conn, "first").as_deref(), Some("first"));
        assert_eq!(anchor(&mut conn, "second").as_deref(), Some("first"));

        let emptied = TaskUpdate {
            execution_start_sha: Some(Some(String::new())),
            ..TaskUpdate::default()
        };
        update(&mut conn, PROJECT, task_id, &emptied).expect("empty it");
        assert_eq!(anchor(&mut conn, "third").as_deref(), Some("third"));
    }

    fn request_ci_fix(conn: &mut Connection, task_id: i32) -> Option<Task> {
        transition::apply_transition(
            conn,
            &maestro_protocol::ApplyTaskTransitionRequest {
                project_path: PROJECT.to_string(),
                task_id,
                event: TaskTransition::CiFixRequested,
                guard: TransitionGuard::FixRoundsBelow(2),
                update: Some(TaskUpdate {
                    increment_fix_rounds: true,
                    ..TaskUpdate::default()
                }),
                comment: Some(maestro_protocol::NewTaskComment {
                    kind: "ci".to_string(),
                    author: "maestro".to_string(),
                    body: Some("CI failed".to_string()),
                    external_ref: None,
                    phase: Some("AwaitingMerge".to_string()),
                }),
            },
        )
        .expect("request a CI fix")
    }

    /// The count, the report and the handoff are one step: a refused fix writes none of them.
    #[test]
    fn a_ci_fix_is_counted_and_reported_only_when_it_is_sent() {
        let (mut conn, task_id) = db_with_task();
        in_phase(&conn, task_id, TaskTransition::PullRequestOpened);

        let sent = request_ci_fix(&mut conn, task_id).expect("sent");
        assert_eq!(sent.fix_rounds, 1);
        assert_eq!(sent.ball, TaskBall::Agent);
        assert_eq!(kinds(&conn, task_id), ["ci"]);

        let being_fixed = get(&conn, PROJECT, task_id).expect("get");
        assert!(
            request_ci_fix(&mut conn, task_id).is_none(),
            "the ball is not External"
        );
        assert_eq!(get(&conn, PROJECT, task_id).expect("get"), being_fixed);
        assert_eq!(kinds(&conn, task_id), ["ci"]);

        in_phase(&conn, task_id, TaskTransition::CiFixPushed);
        request_ci_fix(&mut conn, task_id).expect("the second round");
        in_phase(&conn, task_id, TaskTransition::CiFixPushed);
        let capped = get(&conn, PROJECT, task_id).expect("get");
        assert!(
            request_ci_fix(&mut conn, task_id).is_none(),
            "the rounds are spent"
        );
        assert_eq!(get(&conn, PROJECT, task_id).expect("get"), capped);
        assert_eq!(kinds(&conn, task_id), ["ci", "ci"]);
    }

    #[test]
    fn cancelling_archives_and_parks_the_task() {
        let (mut conn, task_id) = db_with_task();
        let task = cancel(&mut conn, PROJECT, task_id).expect("cancel");
        assert_eq!(task.status, TaskStatus::Cancelled);
        assert!(task.archived_at.is_some());
    }

    #[test]
    fn accepting_a_proposal_replaces_the_description_and_leaves_the_thread() {
        let (mut conn, task_id) = db_with_task();
        record_outcome(&conn, PROJECT, task_id, Some("Refining"), "sharper wording")
            .expect("record");
        let accept = CloseRefinementRequest {
            project_path: PROJECT.to_string(),
            task_id,
            accept: true,
        };
        let task = close_refinement(&mut conn, &accept).expect("close");
        assert_eq!(task.description.as_deref(), Some("sharper wording"));
        assert_eq!(task.status, TaskStatus::Planning);
        assert!(list_comments(&conn, PROJECT, task_id)
            .expect("list")
            .is_empty());

        assert!(close_refinement(&mut conn, &accept)
            .unwrap_err()
            .contains("no proposal"));
    }

    #[test]
    fn a_rejected_proposal_stays_in_the_thread() {
        let (mut conn, task_id) = db_with_task();
        record_outcome(&conn, PROJECT, task_id, Some("Refining"), "sharper wording")
            .expect("record");
        let reject = CloseRefinementRequest {
            project_path: PROJECT.to_string(),
            task_id,
            accept: false,
        };
        let task = close_refinement(&mut conn, &reject).expect("close");
        assert_eq!(task.description, None);
        assert_eq!(
            list_comments(&conn, PROJECT, task_id).expect("list").len(),
            1
        );
    }

    fn execute(conn: &mut Connection, task_id: i32) -> bool {
        request_execution(
            conn,
            &RequestTaskExecutionRequest {
                project_path: PROJECT.to_string(),
                task_id,
            },
        )
        .expect("request execution")
    }

    #[test]
    fn a_deferred_execute_queues_a_planning_task_and_keeps_its_first_stamp() {
        let mut conn = crate::project_store::open_in_memory();
        let task = new_task(&mut conn, PROJECT, "a task");
        assert!(execute(&mut conn, task.id));
        let first = get(&conn, PROJECT, task.id).expect("get").expect("task");
        assert_eq!(first.status, TaskStatus::Queue);
        assert!(first.execute_requested_at.is_some());

        assert!(execute(&mut conn, task.id));
        let second = get(&conn, PROJECT, task.id).expect("get").expect("task");
        assert_eq!(second.execute_requested_at, first.execute_requested_at);
    }

    /// A task that moved away first is not stamped, and the caller lets the claim refuse it.
    #[test]
    fn a_task_that_moved_on_is_not_deferred() {
        let mut conn = crate::project_store::open_in_memory();
        let task = new_task(&mut conn, PROJECT, "a task");
        let to_review = TaskUpdate {
            status: Some(TaskStatus::Review),
            ..TaskUpdate::default()
        };
        update(&mut conn, PROJECT, task.id, &to_review).expect("move");
        assert!(!execute(&mut conn, task.id));
    }

    fn queued(conn: &mut Connection, priority: TaskPriority, created_at: &str) -> i32 {
        let task = new_task(conn, PROJECT, "queued task");
        conn.execute(
            "UPDATE tasks SET status = 'Queue', priority = ?1, created_at = ?2 WHERE id = ?3",
            params![text(priority), created_at, task.id],
        )
        .expect("queue");
        task.id
    }

    fn defer(conn: &Connection, task_id: i32, at: &str) {
        conn.execute(
            "UPDATE tasks SET execute_requested_at = ?1 WHERE id = ?2",
            params![at, task_id],
        )
        .expect("defer");
    }

    fn candidates(conn: &Connection, project_path: &str, include_undeferred: bool) -> Vec<i32> {
        queue_candidates(
            conn,
            &ListQueueCandidatesRequest {
                project_path: project_path.to_string(),
                include_undeferred,
            },
        )
        .expect("candidates")
    }

    #[test]
    fn candidates_come_back_in_priority_then_arrival_order() {
        let mut conn = crate::project_store::open_in_memory();
        let low = queued(&mut conn, TaskPriority::Low, "2026-01-01");
        let urgent = queued(&mut conn, TaskPriority::Urgent, "2026-01-03");
        let medium_late = queued(&mut conn, TaskPriority::Medium, "2026-01-02");
        let medium_early = queued(&mut conn, TaskPriority::Medium, "2026-01-01");
        assert_eq!(
            candidates(&conn, PROJECT, true),
            [urgent, medium_early, medium_late, low]
        );
    }

    /// A deferred task waits for a slot, so a stream of higher-priority arrivals must not starve
    /// it, and two deferrals are kept in the order they were made.
    #[test]
    fn deferrals_come_first_in_the_order_they_were_made() {
        let mut conn = crate::project_store::open_in_memory();
        let low = queued(&mut conn, TaskPriority::Low, "2026-01-05");
        let urgent = queued(&mut conn, TaskPriority::Urgent, "2026-01-01");
        let high = queued(&mut conn, TaskPriority::High, "2026-01-01");
        defer(&conn, high, "2026-01-06T11:00:00Z");
        defer(&conn, low, "2026-01-06T10:00:00Z");
        assert_eq!(candidates(&conn, PROJECT, true), [low, high, urgent]);
    }

    #[test]
    fn manual_mode_drains_only_what_was_deferred() {
        let mut conn = crate::project_store::open_in_memory();
        queued(&mut conn, TaskPriority::Urgent, "2026-01-01");
        let low = queued(&mut conn, TaskPriority::Low, "2026-01-01");
        defer(&conn, low, "2026-01-06T10:00:00Z");
        assert_eq!(candidates(&conn, PROJECT, false), [low]);
        assert!(candidates(&conn, "/other", false).is_empty());
    }

    #[test]
    fn a_task_already_being_spawned_is_not_a_candidate() {
        let mut conn = crate::project_store::open_in_memory();
        let task_id = queued(&mut conn, TaskPriority::High, "2026-01-01");
        transition::apply(
            &conn,
            PROJECT,
            task_id,
            TaskTransition::ExecutionStarted,
            &TransitionGuard::Claim(vec![TaskStatus::Queue]),
        )
        .expect("claim")
        .expect("claimed");
        assert!(candidates(&conn, PROJECT, true).is_empty());
    }

    #[test]
    fn only_unarchived_tasks_with_a_pull_request_await_merge() {
        let (mut conn, task_id) = db_with_task();
        let other = new_task(&mut conn, PROJECT, "no pull request");
        for id in [task_id, other.id] {
            transition::apply(
                &conn,
                PROJECT,
                id,
                TaskTransition::PullRequestOpened,
                &TransitionGuard::Always,
            )
            .expect("open");
        }
        let numbered = TaskUpdate {
            pull_request_number: Some(9),
            ..TaskUpdate::default()
        };
        update(&mut conn, PROJECT, task_id, &numbered).expect("number");
        let waiting = awaiting_merge(&conn, PROJECT).expect("awaiting");
        assert_eq!(waiting.iter().map(|t| t.id).collect::<Vec<_>>(), [task_id]);

        archive(&conn, PROJECT, task_id).expect("archive");
        assert!(awaiting_merge(&conn, PROJECT).expect("awaiting").is_empty());
    }

    fn issue(external_id: &str) -> ImportedIssue {
        ImportedIssue {
            external_id: external_id.to_string(),
            title: format!("Issue {external_id}"),
            body: Some("body".to_string()),
            url: "https://example.com/1".to_string(),
            labels: vec!["bug".to_string()],
            updated_at: Some("2026-01-01T00:00:00Z".to_string()),
            priority: TaskPriority::Low,
        }
    }

    #[test]
    fn import_skips_what_the_project_already_has() {
        let mut conn = crate::project_store::open_in_memory();
        let request = |project_path: &str, issues: Vec<ImportedIssue>| ImportTasksRequest {
            project_path: project_path.to_string(),
            base_branch: "main".to_string(),
            issues,
        };
        let created =
            import(&mut conn, &request(PROJECT, vec![issue("jira:A-1")])).expect("import");
        assert_eq!(created.len(), 1);
        let task = &created[0];
        assert_eq!(task.import_source.as_deref(), Some("jira"));
        assert_eq!(task.is_imported, Some(true));
        assert_eq!(task.priority, TaskPriority::Low);
        assert_eq!(task.labels, ["bug"]);

        let again = import(
            &mut conn,
            &request(PROJECT, vec![issue("jira:A-1"), issue("jira:A-2")]),
        )
        .expect("import");
        assert_eq!(again.iter().map(|t| t.id).collect::<Vec<_>>(), [2]);
        assert_eq!(
            import(&mut conn, &request("/other", vec![issue("jira:A-1")]))
                .expect("import")
                .len(),
            1,
            "another project imports it on its own"
        );
    }

    fn end(
        conn: &mut Connection,
        task_id: i32,
        ending: TurnEnding,
        review_approved: bool,
    ) -> Option<Task> {
        end_turn(
            conn,
            &EndTaskTurnRequest {
                project_path: PROJECT.to_string(),
                task_id,
                ending,
                review_approved,
                closing_message: "  closing words  ".to_string(),
            },
        )
        .expect("end the turn")
    }

    const DONE: TurnEnding = TurnEnding::Completed {
        is_git_repo: true,
        has_changes: Some(true),
        reviewer_pending: false,
    };

    fn in_phase(conn: &Connection, task_id: i32, event: TaskTransition) {
        transition::apply(conn, PROJECT, task_id, event, &TransitionGuard::Always)
            .expect("apply")
            .expect("applied");
    }

    fn kinds(conn: &Connection, task_id: i32) -> Vec<String> {
        list_comments(conn, PROJECT, task_id)
            .expect("list")
            .into_iter()
            .map(|comment| comment.kind)
            .collect()
    }

    #[test]
    fn a_finished_turn_moves_the_task_and_files_its_deliverable() {
        let (mut conn, task_id) = db_with_task();
        in_phase(
            &conn,
            task_id,
            TaskTransition::SessionReady(maestro_protocol::AgentRole::Planner),
        );
        let task = end(&mut conn, task_id, DONE, false).expect("applied");
        assert_eq!(task.phase, Some(TaskPhase::PlanReview));
        let thread = list_comments(&conn, PROJECT, task_id).expect("list");
        assert_eq!(thread.len(), 1);
        assert_eq!(thread[0].kind, "plan");
        assert_eq!(thread[0].phase.as_deref(), Some("Drafting"));
        assert_eq!(thread[0].body.as_deref(), Some("closing words"));
    }

    #[test]
    fn a_failed_turn_files_an_outcome_not_a_deliverable() {
        let (mut conn, task_id) = db_with_task();
        in_phase(
            &conn,
            task_id,
            TaskTransition::SessionReady(maestro_protocol::AgentRole::Reviewer),
        );
        let task = end(&mut conn, task_id, TurnEnding::Failed, false).expect("applied");
        assert_eq!(task.phase_status, Some(PhaseStatus::Failed));
        assert_eq!(kinds(&conn, task_id), ["outcome"]);
    }

    #[test]
    fn a_turn_landing_on_a_parked_task_changes_nothing() {
        let (mut conn, task_id) = db_with_task();
        assert!(end(&mut conn, task_id, DONE, false).is_none());
        assert!(kinds(&conn, task_id).is_empty());
    }

    /// A rejection counts a round until the cap, and the round the cap is reached goes to the user.
    #[test]
    fn a_reviewer_rejects_until_the_round_cap_then_hands_over() {
        let (mut conn, task_id) = db_with_task();
        for round in 1..=REVIEW_ROUND_CAP {
            in_phase(
                &conn,
                task_id,
                TaskTransition::SessionReady(maestro_protocol::AgentRole::Reviewer),
            );
            let task = end(&mut conn, task_id, DONE, false).expect("applied");
            assert_eq!(task.phase, Some(TaskPhase::Rework));
            assert_eq!(task.ball, TaskBall::Agent);
            assert_eq!(task.review_rounds, round);
        }
        in_phase(
            &conn,
            task_id,
            TaskTransition::SessionReady(maestro_protocol::AgentRole::Reviewer),
        );
        let task = end(&mut conn, task_id, DONE, false).expect("applied");
        assert_eq!(task.phase, Some(TaskPhase::Approval));
        assert_eq!(task.review_rounds, REVIEW_ROUND_CAP);
        assert_eq!(kinds(&conn, task_id), ["verdict"; 4]);
    }

    #[test]
    fn an_approving_reviewer_hands_over_without_counting_a_round() {
        let (mut conn, task_id) = db_with_task();
        in_phase(
            &conn,
            task_id,
            TaskTransition::SessionReady(maestro_protocol::AgentRole::Reviewer),
        );
        let task = end(&mut conn, task_id, TurnEnding::ArtifactDelivered, true).expect("applied");
        assert_eq!(task.phase, Some(TaskPhase::Approval));
        assert_eq!(task.review_rounds, 0);
    }

    #[test]
    fn a_delivered_plan_reaches_the_plan_gate() {
        let (mut conn, task_id) = db_with_task();
        in_phase(
            &conn,
            task_id,
            TaskTransition::SessionReady(maestro_protocol::AgentRole::Planner),
        );
        let task = end(&mut conn, task_id, TurnEnding::ArtifactDelivered, false).expect("applied");
        assert_eq!(task.phase, Some(TaskPhase::PlanReview));
        assert_eq!(kinds(&conn, task_id), ["plan"]);
    }

    /// A plan-mode reviewer delivers its verdict through `ExitPlanMode`, not a finished turn.
    #[test]
    fn a_plan_mode_reviewer_rejecting_sends_the_task_to_rework() {
        let (mut conn, task_id) = db_with_task();
        in_phase(
            &conn,
            task_id,
            TaskTransition::SessionReady(maestro_protocol::AgentRole::Reviewer),
        );
        let task = end(&mut conn, task_id, TurnEnding::ArtifactDelivered, false).expect("applied");
        assert_eq!(task.phase, Some(TaskPhase::Rework));
        assert_eq!(task.review_rounds, 1);
        assert_eq!(kinds(&conn, task_id), ["verdict"]);
    }

    /// The coder that replaced the planner must not have the plan filed as its outcome.
    #[test]
    fn a_delivered_artifact_outside_a_read_only_phase_writes_nothing() {
        let (mut conn, task_id) = db_with_task();
        in_phase(
            &conn,
            task_id,
            TaskTransition::SessionReady(maestro_protocol::AgentRole::Coder),
        );
        assert!(end(&mut conn, task_id, TurnEnding::ArtifactDelivered, false).is_none());
        assert!(kinds(&conn, task_id).is_empty());
        let state = transition::read_state(&conn, PROJECT, task_id).expect("read");
        assert_eq!(state.phase, Some(TaskPhase::Implementing));
    }
}
