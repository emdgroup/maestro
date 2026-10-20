//! A loop task's rows: its checks, its iterations and its hidden files. See `docs/loops-plan.md`.
//!
//! Only the rows live here. What runs an iteration and what fills its row is the engine's.

use chrono::Utc;
use maestro_protocol::{
    AnswerLoopProposalRequest, LoopCheck, LoopCheckKind, LoopCheckResult, LoopCheckSpec,
    LoopCheckState, LoopConfig, LoopHalt, LoopHiddenFile, LoopIteration, LoopIterationOutcome,
    RunMode, SetLoopChecksRequest, SetLoopHiddenFilesRequest, TickLoopCheckRequest, WorkspaceMode,
};
use rusqlite::{params, Connection, OptionalExtension};

use super::{commit, parse, text, transaction};

/// Version 12 of `projects.db`: the Loop run mode, every table and column the whole feature uses.
///
/// Not shipped yet, so it may still be rewritten. Frozen once a release carries it.
pub const V12_LOOPS: &str = "
ALTER TABLE tasks ADD COLUMN run_mode TEXT NOT NULL DEFAULT 'Pipeline';
ALTER TABLE tasks ADD COLUMN loop_config TEXT;
-- When the user last let a stopped loop go on: its streaks count from there.
ALTER TABLE tasks ADD COLUMN loop_resumed_at TEXT;
-- Why the loop last stopped for the user, a `LoopHalt`.
ALTER TABLE tasks ADD COLUMN loop_halt TEXT;
-- A pause or stop the user asked for, taken once the running step ends.
ALTER TABLE tasks ADD COLUMN loop_hold TEXT;
-- The agent whose usage limit last refused the task, any task: its gate is the one it waits on.
ALTER TABLE tasks ADD COLUMN gated_agent_id TEXT;
-- The automation, and the number of its run, whose agent created the task with `create_task`.
ALTER TABLE tasks ADD COLUMN drafted_by TEXT;
ALTER TABLE tasks ADD COLUMN drafted_run INTEGER;
-- How many loops may wait on the user before the drain starts no more; 0 is no cap.
ALTER TABLE project_settings ADD COLUMN loop_wait_cap INTEGER NOT NULL DEFAULT 2;

CREATE TABLE IF NOT EXISTS loop_checks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_path TEXT NOT NULL,
    task_id INTEGER NOT NULL,
    position INTEGER NOT NULL,
    kind TEXT NOT NULL,
    label TEXT NOT NULL,
    command TEXT,
    state TEXT NOT NULL DEFAULT 'Pending',
    detail TEXT,
    proposed INTEGER NOT NULL DEFAULT 0,
    accepted INTEGER NOT NULL DEFAULT 0,
    passed_at_sha TEXT,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (project_path, task_id) REFERENCES tasks(project_path, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_loop_checks_task ON loop_checks(project_path, task_id);

CREATE TABLE IF NOT EXISTS loop_iterations (
    project_path TEXT NOT NULL,
    task_id INTEGER NOT NULL,
    n INTEGER NOT NULL,
    attempt INTEGER NOT NULL,
    acp_session_id TEXT,
    agent_id TEXT,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    outcome TEXT NOT NULL DEFAULT 'Running',
    counted INTEGER NOT NULL DEFAULT 0,
    commit_sha TEXT,
    files INTEGER NOT NULL DEFAULT 0,
    added INTEGER NOT NULL DEFAULT 0,
    removed INTEGER NOT NULL DEFAULT 0,
    summary TEXT,
    check_output TEXT,
    -- Why the worker said it cannot go on, through `loop_blocked`.
    blocked TEXT,
    PRIMARY KEY (project_path, task_id, n, attempt),
    FOREIGN KEY (project_path, task_id) REFERENCES tasks(project_path, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS loop_hidden_files (
    project_path TEXT NOT NULL,
    task_id INTEGER NOT NULL,
    path TEXT NOT NULL,
    content TEXT NOT NULL,
    PRIMARY KEY (project_path, task_id, path),
    FOREIGN KEY (project_path, task_id) REFERENCES tasks(project_path, id) ON DELETE CASCADE
);

-- When an agent may be prompted again after a usage limit. Per daemon, not per project: the
-- limit is the account's.
CREATE TABLE IF NOT EXISTS agent_gates (
    agent_id TEXT PRIMARY KEY,
    resume_at TEXT NOT NULL,
    reason TEXT,
    backoff_step INTEGER NOT NULL DEFAULT 0
);
";

/// Version 13 of `projects.db`: every check's result after each iteration, passing ones included,
/// which the iteration's row in the Loop tab shows. `loop_checks` keeps only the latest.
///
/// Not shipped yet, so it may still be rewritten. Frozen once a release carries it.
pub const V13_LOOP_CHECK_RESULTS: &str = "
CREATE TABLE IF NOT EXISTS loop_check_results (
    project_path TEXT NOT NULL,
    task_id INTEGER NOT NULL,
    n INTEGER NOT NULL,
    check_id INTEGER NOT NULL,
    state TEXT NOT NULL,
    detail TEXT,
    command TEXT,
    PRIMARY KEY (project_path, task_id, n, check_id),
    FOREIGN KEY (project_path, task_id) REFERENCES tasks(project_path, id) ON DELETE CASCADE
);
";

/// A config as stored: every number at least 1, the setup command trimmed, and the sealed paths
/// relative.
pub fn normalize_config(config: &LoopConfig) -> Result<LoopConfig, String> {
    for (name, value) in [
        ("max_iterations", config.max_iterations),
        ("max_build_secs", config.max_build_secs),
        ("stall_limit", config.stall_limit),
        ("check_timeout_secs", config.check_timeout_secs),
    ] {
        if value == 0 {
            return Err(format!("{name} must be at least 1"));
        }
    }
    Ok(LoopConfig {
        setup_command: config
            .setup_command
            .as_deref()
            .map(str::trim)
            .filter(|c| !c.is_empty())
            .map(str::to_owned),
        sealed_paths: config
            .sealed_paths
            .iter()
            .map(|p| relative_path(p, true))
            .collect::<Result<_, _>>()?,
        ..config.clone()
    })
}

/// A loop seals its tests by leaving them out of its own worktree, which a shared checkout cannot
/// do without hiding them from everyone else too.
pub(crate) fn check_workspace(mode: RunMode, workspace: WorkspaceMode) -> Result<(), String> {
    if mode == RunMode::Loop && workspace != WorkspaceMode::NewWorktree {
        return Err(
            "A loop runs in a new worktree of its own, so its checks can be sealed \
                    from the agent"
                .to_string(),
        );
    }
    Ok(())
}

/// A path inside the worktree, with `/`. A sealed path may end in `/` to name a directory; a hidden
/// file's may not. Nothing may climb out with `..`.
pub(crate) fn relative_path(path: &str, directory: bool) -> Result<String, String> {
    let path = path.trim().replace('\\', "/");
    let body = match path.strip_suffix('/') {
        Some(body) if directory => body,
        _ => path.as_str(),
    };
    let fine = !body.is_empty()
        && !body.starts_with('/')
        && !body.contains(':')
        && body
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..");
    if fine {
        Ok(path)
    } else {
        Err(format!(
            "\"{path}\" is not a relative path inside the project"
        ))
    }
}

pub(crate) fn spec(spec: &LoopCheckSpec) -> Result<LoopCheckSpec, String> {
    let label = spec.label.trim();
    if label.is_empty() {
        return Err("A check needs a label".to_string());
    }
    let command = match spec.kind {
        LoopCheckKind::Command => Some(
            spec.command
                .as_deref()
                .map(str::trim)
                .filter(|c| !c.is_empty())
                .ok_or_else(|| format!("The command check \"{label}\" has no command"))?
                .to_owned(),
        ),
        LoopCheckKind::Judge | LoopCheckKind::Manual => None,
    };
    Ok(LoopCheckSpec {
        kind: spec.kind,
        label: label.to_owned(),
        command,
    })
}

/// Refuse a write to the loop rows of a task that is not a loop.
fn loop_task(conn: &Connection, project_path: &str, task_id: i32) -> Result<(), String> {
    let mode: Option<String> = conn
        .query_row(
            "SELECT run_mode FROM tasks WHERE project_path = ?1 AND id = ?2",
            params![project_path, task_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    match mode.as_deref().and_then(parse) {
        Some(RunMode::Loop) => Ok(()),
        Some(RunMode::Pipeline) => Err(format!("Task {task_id} is not a loop")),
        None => Err(format!("Task {task_id} not found")),
    }
}

fn check_from_row(row: &rusqlite::Row) -> rusqlite::Result<LoopCheck> {
    Ok(LoopCheck {
        id: row.get("id")?,
        position: row.get("position")?,
        kind: parse(&row.get::<_, String>("kind")?).unwrap_or(LoopCheckKind::Manual),
        label: row.get("label")?,
        command: row.get("command")?,
        state: parse(&row.get::<_, String>("state")?).unwrap_or(LoopCheckState::Pending),
        detail: row.get("detail")?,
        proposed: row.get("proposed")?,
        accepted: row.get("accepted")?,
        passed_at_sha: row.get("passed_at_sha")?,
        updated_at: row.get("updated_at")?,
    })
}

/// In list order: the user's checks, then the pending proposals.
pub fn list_checks(
    conn: &Connection,
    project_path: &str,
    task_id: i32,
) -> Result<Vec<LoopCheck>, String> {
    let mut statement = conn
        .prepare(
            "SELECT * FROM loop_checks WHERE project_path = ?1 AND task_id = ?2
             ORDER BY position, id",
        )
        .map_err(|e| e.to_string())?;
    let checks = statement
        .query_map(params![project_path, task_id], check_from_row)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(checks)
}

fn is_pending_proposal(check: &LoopCheck) -> bool {
    check.proposed && !check.accepted
}

pub fn set_checks(
    conn: &mut Connection,
    request: &SetLoopChecksRequest,
) -> Result<Vec<LoopCheck>, String> {
    let (project, task_id) = (request.project_path.as_str(), request.task_id);
    let tx = transaction(conn)?;
    loop_task(&tx, project, task_id)?;
    let existing = list_checks(&tx, project, task_id)?;
    let now = Utc::now().to_rfc3339();

    let mut kept = Vec::new();
    for entry in &request.checks {
        if let Some(id) = entry.id {
            let ours = existing
                .iter()
                .any(|c| c.id == id && !is_pending_proposal(c));
            if !ours || kept.contains(&id) {
                return Err(format!("Check {id} is not on this loop's list"));
            }
            kept.push(id);
        }
    }
    for check in existing.iter().filter(|c| !is_pending_proposal(c)) {
        if !kept.contains(&check.id) {
            tx.execute("DELETE FROM loop_checks WHERE id = ?1", params![check.id])
                .map_err(|e| e.to_string())?;
        }
    }

    for (position, entry) in request.checks.iter().enumerate() {
        let spec = spec(&entry.spec)?;
        let current = entry.id.and_then(|id| existing.iter().find(|c| c.id == id));
        match current {
            Some(check)
                if check.kind == spec.kind
                    && check.label == spec.label
                    && check.command == spec.command =>
            {
                tx.execute(
                    "UPDATE loop_checks SET position = ?2 WHERE id = ?1",
                    params![check.id, position as i32],
                )
            }
            // A changed check is a new question, so what it answered before no longer holds.
            Some(check) => tx.execute(
                "UPDATE loop_checks SET position = ?2, kind = ?3, label = ?4, command = ?5,
                        state = 'Pending', detail = NULL, passed_at_sha = NULL, updated_at = ?6
                 WHERE id = ?1",
                params![
                    check.id,
                    position as i32,
                    text(spec.kind),
                    spec.label,
                    spec.command,
                    now
                ],
            ),
            None => tx.execute(
                "INSERT INTO loop_checks (project_path, task_id, position, kind, label, command,
                                          updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    project,
                    task_id,
                    position as i32,
                    text(spec.kind),
                    spec.label,
                    spec.command,
                    now
                ],
            ),
        }
        .map_err(|e| e.to_string())?;
    }

    // Pending proposals follow the list, in the order they had.
    let after = request.checks.len();
    for (offset, check) in existing
        .iter()
        .filter(|c| is_pending_proposal(c))
        .enumerate()
    {
        tx.execute(
            "UPDATE loop_checks SET position = ?2 WHERE id = ?1",
            params![check.id, (after + offset) as i32],
        )
        .map_err(|e| e.to_string())?;
    }

    let checks = list_checks(&tx, project, task_id)?;
    commit(tx)?;
    Ok(checks)
}

fn find_check(
    conn: &Connection,
    project_path: &str,
    task_id: i32,
    check_id: i32,
) -> Result<LoopCheck, String> {
    conn.query_row(
        "SELECT * FROM loop_checks WHERE project_path = ?1 AND task_id = ?2 AND id = ?3",
        params![project_path, task_id, check_id],
        check_from_row,
    )
    .optional()
    .map_err(|e| e.to_string())?
    .ok_or_else(|| format!("Check {check_id} is not on this loop's list"))
}

pub fn answer_proposal(
    conn: &mut Connection,
    request: &AnswerLoopProposalRequest,
) -> Result<Vec<LoopCheck>, String> {
    let (project, task_id) = (request.project_path.as_str(), request.task_id);
    let tx = transaction(conn)?;
    loop_task(&tx, project, task_id)?;
    let check = find_check(&tx, project, task_id, request.check_id)?;
    if !is_pending_proposal(&check) {
        return Err("That check is not a proposal waiting for an answer".to_string());
    }
    match &request.accept {
        Some(accepted) => {
            let spec = spec(accepted)?;
            if !request.seal.is_empty() {
                seal_more(&tx, project, task_id, &request.seal)?;
            }
            tx.execute(
                "UPDATE loop_checks SET kind = ?2, label = ?3, command = ?4, accepted = 1,
                        state = 'Pending', detail = NULL, updated_at = ?5
                 WHERE id = ?1",
                params![
                    check.id,
                    text(spec.kind),
                    spec.label,
                    spec.command,
                    Utc::now().to_rfc3339()
                ],
            )
        }
        None => tx.execute("DELETE FROM loop_checks WHERE id = ?1", params![check.id]),
    }
    .map_err(|e| e.to_string())?;
    let checks = list_checks(&tx, project, task_id)?;
    commit(tx)?;
    Ok(checks)
}

/// Add `paths` to the loop's sealed paths, each once.
fn seal_more(
    conn: &Connection,
    project_path: &str,
    task_id: i32,
    paths: &[String],
) -> Result<(), String> {
    let stored: Option<String> = conn
        .query_row(
            "SELECT loop_config FROM tasks WHERE project_path = ?1 AND id = ?2",
            params![project_path, task_id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    let mut config: LoopConfig = stored
        .and_then(|json| serde_json::from_str(&json).ok())
        .unwrap_or_default();
    for path in paths {
        let path = relative_path(path, true)?;
        if !config.sealed_paths.contains(&path) {
            config.sealed_paths.push(path);
        }
    }
    let json = serde_json::to_string(&config).map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE tasks SET loop_config = ?3 WHERE project_path = ?1 AND id = ?2",
        params![project_path, task_id, json],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

pub fn tick(
    conn: &mut Connection,
    request: &TickLoopCheckRequest,
) -> Result<Vec<LoopCheck>, String> {
    let (project, task_id) = (request.project_path.as_str(), request.task_id);
    let tx = transaction(conn)?;
    loop_task(&tx, project, task_id)?;
    let check = find_check(&tx, project, task_id, request.check_id)?;
    if check.kind != LoopCheckKind::Manual || is_pending_proposal(&check) {
        return Err("Only a manual check is ticked by hand".to_string());
    }
    let state = if request.ticked {
        LoopCheckState::Pass
    } else {
        LoopCheckState::Pending
    };
    tx.execute(
        "UPDATE loop_checks SET state = ?2, updated_at = ?3 WHERE id = ?1",
        params![check.id, text(state), Utc::now().to_rfc3339()],
    )
    .map_err(|e| e.to_string())?;
    let checks = list_checks(&tx, project, task_id)?;
    commit(tx)?;
    Ok(checks)
}

/// Oldest first.
pub fn list_iterations(
    conn: &Connection,
    project_path: &str,
    task_id: i32,
) -> Result<Vec<LoopIteration>, String> {
    let mut statement = conn
        .prepare(
            "SELECT i.*,
                    (SELECT SUM(u.total_tokens) FROM usage_turns u
                     WHERE u.acp_session_id = i.acp_session_id) AS tokens
             FROM loop_iterations i WHERE i.project_path = ?1 AND i.task_id = ?2
             ORDER BY i.n, i.attempt",
        )
        .map_err(|e| e.to_string())?;
    let iterations = statement
        .query_map(params![project_path, task_id], |row| {
            Ok(LoopIteration {
                n: row.get("n")?,
                attempt: row.get("attempt")?,
                acp_session_id: row.get("acp_session_id")?,
                agent_id: row.get("agent_id")?,
                started_at: row.get("started_at")?,
                ended_at: row.get("ended_at")?,
                outcome: parse(&row.get::<_, String>("outcome")?)
                    .unwrap_or(LoopIterationOutcome::Failed),
                counted: row.get("counted")?,
                commit_sha: row.get("commit_sha")?,
                files: row.get("files")?,
                added: row.get("added")?,
                removed: row.get("removed")?,
                summary: row.get("summary")?,
                check_output: row.get("check_output")?,
                tokens: row.get("tokens")?,
                blocked: row.get("blocked")?,
                results: Vec::new(),
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(iterations)
}

/// [`list_iterations`] with each number's check results on its newest attempt, for the Loop tab.
pub fn list_iterations_with_results(
    conn: &Connection,
    project_path: &str,
    task_id: i32,
) -> Result<Vec<LoopIteration>, String> {
    let mut iterations = list_iterations(conn, project_path, task_id)?;
    let mut statement = conn
        .prepare(
            "SELECT n, check_id, state, detail, command FROM loop_check_results
             WHERE project_path = ?1 AND task_id = ?2",
        )
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map(params![project_path, task_id], |row| {
            Ok((
                row.get::<_, i32>(0)?,
                LoopCheckResult {
                    check_id: row.get(1)?,
                    state: parse(&row.get::<_, String>(2)?).unwrap_or(LoopCheckState::Fail),
                    detail: row.get(3)?,
                    command: row.get(4)?,
                },
            ))
        })
        .map_err(|e| e.to_string())?;
    for row in rows {
        let (n, result) = row.map_err(|e| e.to_string())?;
        // Oldest first, so the last attempt of `n` is the one the checks ran after.
        if let Some(iteration) = iterations.iter_mut().rev().find(|i| i.n == n) {
            iteration.results.push(result);
        }
    }
    Ok(iterations)
}

/// By path.
pub fn list_hidden_files(
    conn: &Connection,
    project_path: &str,
    task_id: i32,
) -> Result<Vec<LoopHiddenFile>, String> {
    let mut statement = conn
        .prepare(
            "SELECT path, content FROM loop_hidden_files WHERE project_path = ?1 AND task_id = ?2
             ORDER BY path",
        )
        .map_err(|e| e.to_string())?;
    let files = statement
        .query_map(params![project_path, task_id], |row| {
            Ok(LoopHiddenFile {
                path: row.get(0)?,
                content: row.get(1)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(files)
}

pub fn set_hidden_files(
    conn: &mut Connection,
    request: &SetLoopHiddenFilesRequest,
) -> Result<Vec<LoopHiddenFile>, String> {
    let (project, task_id) = (request.project_path.as_str(), request.task_id);
    let mut paths = Vec::new();
    for file in &request.files {
        let path = relative_path(&file.path, false)?;
        if paths.contains(&path) {
            return Err(format!("\"{path}\" is listed twice"));
        }
        paths.push(path);
    }
    let tx = transaction(conn)?;
    loop_task(&tx, project, task_id)?;
    tx.execute(
        "DELETE FROM loop_hidden_files WHERE project_path = ?1 AND task_id = ?2",
        params![project, task_id],
    )
    .map_err(|e| e.to_string())?;
    for (path, file) in paths.iter().zip(&request.files) {
        tx.execute(
            "INSERT INTO loop_hidden_files (project_path, task_id, path, content)
             VALUES (?1, ?2, ?3, ?4)",
            params![project, task_id, path, file.content],
        )
        .map_err(|e| e.to_string())?;
    }
    let files = list_hidden_files(&tx, project, task_id)?;
    commit(tx)?;
    Ok(files)
}

/// The number the next iteration takes: one past every iteration that ended, so one a usage limit
/// cut off runs again. A `Running` row is the live iteration's, or a start's that never came up,
/// which the next start replaces.
pub(crate) fn next_iteration(
    conn: &Connection,
    project_path: &str,
    task_id: i32,
) -> Result<i32, String> {
    conn.query_row(
        "SELECT COALESCE(MAX(n), 0) + 1 FROM loop_iterations
         WHERE project_path = ?1 AND task_id = ?2 AND outcome NOT IN ('Running', 'Interrupted')",
        params![project_path, task_id],
        |row| row.get(0),
    )
    .map_err(|e| e.to_string())
}

/// Everything a loop's run left behind: its iterations, its checks' results, its halt, hold and
/// resume mark. The checks themselves and the hidden files stay, as the loop's definition.
pub(crate) fn clear_progress(
    conn: &mut Connection,
    project_path: &str,
    task_id: i32,
) -> Result<(), String> {
    let tx = transaction(conn)?;
    let at = Utc::now().to_rfc3339();
    tx.execute(
        "DELETE FROM loop_iterations WHERE project_path = ?1 AND task_id = ?2",
        params![project_path, task_id],
    )
    .and_then(|_| {
        tx.execute(
            "DELETE FROM loop_check_results WHERE project_path = ?1 AND task_id = ?2",
            params![project_path, task_id],
        )
    })
    .and_then(|_| {
        tx.execute(
            "UPDATE loop_checks SET state = 'Pending', detail = NULL, passed_at_sha = NULL,
                 updated_at = ?3
             WHERE project_path = ?1 AND task_id = ?2",
            params![project_path, task_id, at],
        )
    })
    .and_then(|_| {
        tx.execute(
            "UPDATE tasks SET loop_halt = NULL, loop_hold = NULL, loop_resumed_at = NULL
             WHERE project_path = ?1 AND id = ?2",
            params![project_path, task_id],
        )
    })
    .map_err(|e| format!("Failed to clear the loop's progress: {e}"))?;
    commit(tx)
}

/// The loops with an iteration running, in every project.
pub(crate) fn running_iteration_tasks(conn: &Connection) -> Result<Vec<(String, i32)>, String> {
    let mut statement = conn
        .prepare(
            "SELECT DISTINCT project_path, task_id FROM loop_iterations WHERE outcome = 'Running'",
        )
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

/// The row of an iteration whose session is up, as the next attempt of its number.
pub(crate) fn start_iteration(
    conn: &Connection,
    project_path: &str,
    task_id: i32,
    n: i32,
    acp_session_id: &str,
    agent_id: &str,
) -> Result<(), String> {
    conn.execute(
        "DELETE FROM loop_iterations
         WHERE project_path = ?1 AND task_id = ?2 AND outcome = 'Running'",
        params![project_path, task_id],
    )
    .and_then(|_| {
        conn.execute(
            "INSERT INTO loop_iterations (project_path, task_id, n, attempt, acp_session_id,
                                          agent_id, started_at)
             VALUES (?1, ?2, ?3,
                     (SELECT COALESCE(MAX(attempt), 0) + 1 FROM loop_iterations
                      WHERE project_path = ?1 AND task_id = ?2 AND n = ?3),
                     ?4, ?5, ?6)",
            params![
                project_path,
                task_id,
                n,
                acp_session_id,
                agent_id,
                Utc::now().to_rfc3339()
            ],
        )
    })
    .map(|_| ())
    .map_err(|e| e.to_string())
}

/// What ending an iteration found in its worktree.
#[derive(Debug, Default, Clone, PartialEq)]
pub(crate) struct Committed {
    /// `None` when there was nothing to commit, or the commit failed.
    pub commit_sha: Option<String>,
    pub files: i32,
    pub added: i32,
    pub removed: i32,
}

/// How many proposals a loop may hold unanswered, so a worker cannot bury the list.
pub(crate) const MAX_PENDING_PROPOSALS: usize = 3;

/// The worker's `loop_propose_check`: a check waiting for the user's answer. Its reason is kept as
/// the detail and its command, if any, prefills the user's Accept. The kind is the user's to pick,
/// so it is only a guess here.
pub(crate) fn propose_check(
    conn: &mut Connection,
    project_path: &str,
    task_id: i32,
    label: &str,
    why: Option<&str>,
    command: Option<&str>,
) -> Result<i32, String> {
    let tx = transaction(conn)?;
    loop_task(&tx, project_path, task_id)?;
    let pending = list_checks(&tx, project_path, task_id)?
        .iter()
        .filter(|c| is_pending_proposal(c))
        .count();
    if pending >= MAX_PENDING_PROPOSALS {
        return Err(format!(
            "This loop already has {pending} proposals waiting for the user. Carry on without \
             this one, or mention it in your notes."
        ));
    }
    let kind = if command.is_some() {
        LoopCheckKind::Command
    } else {
        LoopCheckKind::Judge
    };
    tx.execute(
        "INSERT INTO loop_checks (project_path, task_id, position, kind, label, command, detail,
                                  proposed, updated_at)
         VALUES (?1, ?2,
                 (SELECT COALESCE(MAX(position), 0) + 1 FROM loop_checks
                  WHERE project_path = ?1 AND task_id = ?2),
                 ?3, ?4, ?5, ?6, 1, ?7)",
        params![
            project_path,
            task_id,
            text(kind),
            label,
            command,
            why,
            Utc::now().to_rfc3339()
        ],
    )
    .map_err(|e| e.to_string())?;
    let id = tx.last_insert_rowid() as i32;
    commit(tx)?;
    Ok(id)
}

/// The worker's `loop_blocked`, on iteration `n`. `false` when that is not the iteration running.
pub(crate) fn set_blocked(
    conn: &Connection,
    project_path: &str,
    task_id: i32,
    n: i32,
    reason: &str,
) -> Result<bool, String> {
    conn.execute(
        "UPDATE loop_iterations SET blocked = ?4
         WHERE project_path = ?1 AND task_id = ?2 AND n = ?3 AND outcome = 'Running'",
        params![project_path, task_id, n, reason],
    )
    .map(|changed| changed > 0)
    .map_err(|e| e.to_string())
}

/// The iteration's session is over: when it ended, what it said and what was committed. It counts
/// from here on. A commit clears every manual tick, since the user ticked what came before it.
pub(crate) fn record_commit(
    conn: &Connection,
    project_path: &str,
    task_id: i32,
    iteration: &LoopIteration,
    summary: Option<&str>,
    committed: &Committed,
) -> Result<(), String> {
    conn.execute(
        "UPDATE loop_iterations
         SET ended_at = COALESCE(ended_at, ?5), counted = 1, summary = COALESCE(?6, summary),
             commit_sha = ?7, files = ?8, added = ?9, removed = ?10
         WHERE project_path = ?1 AND task_id = ?2 AND n = ?3 AND attempt = ?4",
        params![
            project_path,
            task_id,
            iteration.n,
            iteration.attempt,
            Utc::now().to_rfc3339(),
            summary,
            committed.commit_sha,
            committed.files,
            committed.added,
            committed.removed,
        ],
    )
    .map_err(|e| e.to_string())?;
    if committed.commit_sha.is_some() {
        conn.execute(
            "UPDATE loop_checks SET state = 'Pending', updated_at = ?3
             WHERE project_path = ?1 AND task_id = ?2 AND kind = 'Manual' AND state = 'Pass'",
            params![project_path, task_id, Utc::now().to_rfc3339()],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub(crate) fn record_outcome(
    conn: &Connection,
    project_path: &str,
    task_id: i32,
    iteration: &LoopIteration,
    outcome: LoopIterationOutcome,
    check_output: Option<&str>,
) -> Result<(), String> {
    conn.execute(
        "UPDATE loop_iterations
         SET outcome = ?5, check_output = ?6,
             counted = CASE WHEN ?5 = 'Interrupted' THEN 0 ELSE counted END
         WHERE project_path = ?1 AND task_id = ?2 AND n = ?3 AND attempt = ?4",
        params![
            project_path,
            task_id,
            iteration.n,
            iteration.attempt,
            text(outcome),
            check_output
        ],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

/// What one check run concluded about each check, by id. `ran` is the list the run read: a check
/// edited since then is a new question, which this run did not answer, so it is left alone.
pub(crate) fn record_results(
    conn: &mut Connection,
    project_path: &str,
    task_id: i32,
    ran: &[LoopCheck],
    results: &[(i32, LoopCheckState, Option<String>)],
) -> Result<(), String> {
    let tx = transaction(conn)?;
    let now = Utc::now().to_rfc3339();
    for (id, state, detail) in results {
        let Some(check) = ran.iter().find(|c| c.id == *id) else {
            continue;
        };
        let updated = tx
            .execute(
                "UPDATE loop_checks SET state = ?4, detail = ?5, updated_at = ?6
                 WHERE project_path = ?1 AND task_id = ?2 AND id = ?3
                   AND kind = ?7 AND command IS ?8",
                params![
                    project_path,
                    task_id,
                    id,
                    text(*state),
                    detail,
                    now,
                    text(check.kind),
                    check.command
                ],
            )
            .map_err(|e| e.to_string())?;
        if updated > 0 {
            let command = check.command.as_deref();
            keep_result(
                &tx,
                project_path,
                task_id,
                *id,
                *state,
                detail.as_deref(),
                command,
            )?;
        }
    }
    commit(tx)
}

/// A check's result, kept against the newest iteration: the one the checks ran after. Run again
/// on the same iteration, the newer result replaces it.
fn keep_result(
    conn: &Connection,
    project_path: &str,
    task_id: i32,
    check_id: i32,
    state: LoopCheckState,
    detail: Option<&str>,
    command: Option<&str>,
) -> Result<(), String> {
    conn.execute(
        "INSERT OR REPLACE INTO loop_check_results
             (project_path, task_id, n, check_id, state, detail, command)
         SELECT ?1, ?2, MAX(n), ?3, ?4, ?5, ?6 FROM loop_iterations
         WHERE project_path = ?1 AND task_id = ?2
         HAVING MAX(n) IS NOT NULL",
        params![
            project_path,
            task_id,
            check_id,
            text(state),
            detail,
            command
        ],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

/// What the judge concluded, by check id: passed or not, and its reason. A pass holds for `sha`.
pub(crate) fn record_judged(
    conn: &mut Connection,
    project_path: &str,
    task_id: i32,
    sha: &str,
    verdicts: &[(i32, bool, String)],
) -> Result<(), String> {
    let tx = transaction(conn)?;
    let now = Utc::now().to_rfc3339();
    for (id, passed, reason) in verdicts {
        let state = if *passed {
            LoopCheckState::Pass
        } else {
            LoopCheckState::Fail
        };
        tx.execute(
            "UPDATE loop_checks SET state = ?4, detail = ?5, passed_at_sha = ?6, updated_at = ?7
             WHERE project_path = ?1 AND task_id = ?2 AND id = ?3",
            params![
                project_path,
                task_id,
                id,
                text(state),
                reason,
                passed.then_some(sha),
                now
            ],
        )
        .map_err(|e| e.to_string())?;
        keep_result(&tx, project_path, task_id, *id, state, Some(reason), None)?;
    }
    commit(tx)
}

/// The commit the loop is at: the newest iteration's that committed anything.
pub(crate) fn head_sha(iterations: &[LoopIteration]) -> Option<&str> {
    iterations
        .iter()
        .rev()
        .find_map(|i| i.commit_sha.as_deref())
}

/// The `judge` checks the judge has to decide at the loop's commit: every one, but those that
/// already passed there. With the commit, `None` when nothing was committed yet.
pub(crate) fn to_judge(
    conn: &Connection,
    project_path: &str,
    task_id: i32,
) -> Result<(Vec<LoopCheck>, Option<String>), String> {
    let iterations = list_iterations(conn, project_path, task_id)?;
    let sha = head_sha(&iterations).map(str::to_owned);
    let checks = list_checks(conn, project_path, task_id)?
        .into_iter()
        .filter(|c| c.kind == LoopCheckKind::Judge && !is_pending_proposal(c))
        .filter(|c| c.passed_at_sha.is_none() || c.passed_at_sha != sha)
        .collect();
    Ok((checks, sha))
}

/// When the user last let the loop go on, if ever.
/// The loop stopped for the user, and why. Any hold asked for is spent.
pub(crate) fn set_halt(
    conn: &Connection,
    project_path: &str,
    task_id: i32,
    halt: LoopHalt,
) -> Result<(), String> {
    conn.execute(
        "UPDATE tasks SET loop_halt = ?3, loop_hold = NULL WHERE project_path = ?1 AND id = ?2",
        params![project_path, task_id, text(halt)],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

/// Ask for a pause or a stop once the running step ends, or drop the request.
pub(crate) fn set_hold(
    conn: &Connection,
    project_path: &str,
    task_id: i32,
    hold: Option<LoopHalt>,
) -> Result<(), String> {
    conn.execute(
        "UPDATE tasks SET loop_hold = ?3 WHERE project_path = ?1 AND id = ?2",
        params![project_path, task_id, hold.map(text)],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

/// `(loop_halt, loop_hold)`.
pub(crate) fn halt_and_hold(
    conn: &Connection,
    project_path: &str,
    task_id: i32,
) -> Result<(Option<LoopHalt>, Option<LoopHalt>), String> {
    conn.query_row(
        "SELECT loop_halt, loop_hold FROM tasks WHERE project_path = ?1 AND id = ?2",
        params![project_path, task_id],
        |row| {
            let read = |i: usize| row.get::<_, Option<String>>(i);
            Ok((
                read(0)?.and_then(|s| parse(&s)),
                read(1)?.and_then(|s| parse(&s)),
            ))
        },
    )
    .optional()
    .map(Option::unwrap_or_default)
    .map_err(|e| e.to_string())
}

pub(crate) fn resumed_at(
    conn: &Connection,
    project_path: &str,
    task_id: i32,
) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT loop_resumed_at FROM tasks WHERE project_path = ?1 AND id = ?2",
        params![project_path, task_id],
        |row| row.get(0),
    )
    .optional()
    .map(Option::flatten)
    .map_err(|e| e.to_string())
}

/// The checks the daemon runs: the user's command checks and the accepted proposals.
pub(crate) fn is_runnable(check: &LoopCheck) -> bool {
    check.kind == LoopCheckKind::Command && !is_pending_proposal(check)
}

/// Move a loop that is not running into `Checking`, for Re-run checks: paused on a flaky check,
/// stopped, failed, or at sign-off, with a commit to check.
pub(crate) fn claim_recheck(
    conn: &mut Connection,
    project_path: &str,
    task_id: i32,
) -> Result<maestro_protocol::Task, String> {
    use maestro_protocol::{PhaseStatus, TaskPhase, TaskTransition, TransitionGuard};
    let tx = transaction(conn)?;
    loop_task(&tx, project_path, task_id)?;
    let task = super::read(&tx, project_path, task_id)?;
    let settled = matches!(
        (task.phase, task.phase_status),
        (
            Some(TaskPhase::Checking | TaskPhase::Iterating | TaskPhase::Judging),
            Some(PhaseStatus::Failed)
        ) | (
            Some(TaskPhase::Iterating | TaskPhase::Approval),
            Some(PhaseStatus::Waiting)
        )
    );
    if !settled {
        return Err("The checks can only run again while the loop is stopped".to_string());
    }
    let checked = list_iterations(&tx, project_path, task_id)?
        .iter()
        .any(|i| i.commit_sha.is_some());
    if !checked {
        return Err("No iteration has committed anything to check yet".to_string());
    }
    let task = super::transition::apply(
        &tx,
        project_path,
        task_id,
        TaskTransition::LoopChecking,
        &TransitionGuard::Always,
    )?
    .ok_or_else(|| format!("Task {task_id} not found"))?;
    commit(tx)?;
    Ok(task)
}

#[cfg(test)]
mod tests {
    use super::*;
    use maestro_protocol::{
        BranchMode, CreateTaskRequest, LoopCheckEntry, TaskUpdate, WorkspaceMode,
    };

    const PROJECT: &str = "/repo";

    fn create(conn: &mut Connection, run_mode: RunMode, config: Option<LoopConfig>) -> i32 {
        super::super::create(
            conn,
            &CreateTaskRequest {
                project_path: PROJECT.to_string(),
                title: "Make it fast".to_string(),
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
                run_mode,
                loop_config: config,
            },
        )
        .expect("create")
        .id
    }

    fn entry(
        id: Option<i32>,
        kind: LoopCheckKind,
        label: &str,
        command: Option<&str>,
    ) -> LoopCheckEntry {
        LoopCheckEntry {
            id,
            spec: LoopCheckSpec {
                kind,
                label: label.to_string(),
                command: command.map(str::to_string),
            },
        }
    }

    fn set(
        conn: &mut Connection,
        task_id: i32,
        checks: Vec<LoopCheckEntry>,
    ) -> Result<Vec<LoopCheck>, String> {
        set_checks(
            conn,
            &SetLoopChecksRequest {
                project_path: PROJECT.to_string(),
                task_id,
                checks,
            },
        )
    }

    fn propose(conn: &mut Connection, task_id: i32, label: &str) -> i32 {
        propose_check(conn, PROJECT, task_id, label, None, None).expect("propose")
    }

    #[test]
    fn a_loop_gets_the_default_config_and_a_pipeline_none() {
        let mut conn = crate::project_store::open_in_memory();
        let task = create(&mut conn, RunMode::Loop, None);
        let task = super::super::read(&conn, PROJECT, task).unwrap();
        assert_eq!(task.run_mode, RunMode::Loop);
        assert_eq!(task.loop_config, Some(LoopConfig::default()));

        let pipeline = create(&mut conn, RunMode::Pipeline, None);
        let pipeline = super::super::read(&conn, PROJECT, pipeline).unwrap();
        assert_eq!(pipeline.run_mode, RunMode::Pipeline);
        assert_eq!(pipeline.loop_config, None);
    }

    #[test]
    fn a_config_is_normalized_and_a_zero_refused() {
        let mut conn = crate::project_store::open_in_memory();
        let config = LoopConfig {
            setup_command: Some("  ".to_string()),
            sealed_paths: vec!["tests\\".to_string(), " scripts/check.sh ".to_string()],
            ..LoopConfig::default()
        };
        let task = create(&mut conn, RunMode::Loop, Some(config));
        let stored = super::super::read(&conn, PROJECT, task)
            .unwrap()
            .loop_config
            .unwrap();
        assert_eq!(stored.setup_command, None);
        assert_eq!(stored.sealed_paths, ["tests/", "scripts/check.sh"]);

        for bad in ["../outside", "/etc/passwd", "C:/x", "a//b", "./a"] {
            let config = LoopConfig {
                sealed_paths: vec![bad.to_string()],
                ..LoopConfig::default()
            };
            assert!(normalize_config(&config).is_err(), "{bad} was accepted");
        }
        let zero = LoopConfig {
            stall_limit: 0,
            ..LoopConfig::default()
        };
        assert!(normalize_config(&zero).is_err());
    }

    #[test]
    fn a_started_loop_keeps_its_sealed_paths_and_changes_its_budget() {
        let mut conn = crate::project_store::open_in_memory();
        let task = create(&mut conn, RunMode::Loop, None);
        conn.execute(
            "UPDATE tasks SET phase = 'Iterating' WHERE id = ?1",
            params![task],
        )
        .unwrap();
        let longer = TaskUpdate {
            loop_config: Some(LoopConfig {
                max_iterations: 20,
                ..LoopConfig::default()
            }),
            ..TaskUpdate::default()
        };
        let id = task;
        let task = super::super::update(&mut conn, PROJECT, id, &longer).unwrap();
        assert_eq!(task.loop_config.unwrap().max_iterations, 20);
        // Its sealed paths are not: the worktree is sealed to them.
        let resealed = TaskUpdate {
            loop_config: Some(LoopConfig {
                sealed_paths: vec!["tests/".to_string()],
                ..LoopConfig::default()
            }),
            ..TaskUpdate::default()
        };
        assert!(super::super::update(&mut conn, PROJECT, id, &resealed).is_err());
    }

    #[test]
    fn a_loop_being_prepared_has_not_started() {
        let mut conn = crate::project_store::open_in_memory();
        let id = create(&mut conn, RunMode::Loop, None);
        conn.execute(
            "UPDATE tasks SET phase = 'Refining', phase_status = 'Waiting' WHERE id = ?1",
            params![id],
        )
        .unwrap();
        let sealed = TaskUpdate {
            loop_config: Some(LoopConfig {
                sealed_paths: vec!["tests/".to_string()],
                ..LoopConfig::default()
            }),
            ..TaskUpdate::default()
        };
        let task = super::super::update(&mut conn, PROJECT, id, &sealed).unwrap();
        assert_eq!(task.loop_config.unwrap().sealed_paths, ["tests/"]);
    }

    #[test]
    fn setting_the_list_keeps_unchanged_checks_and_resets_changed_ones() {
        let mut conn = crate::project_store::open_in_memory();
        let task = create(&mut conn, RunMode::Loop, None);
        let first = set(
            &mut conn,
            task,
            vec![
                entry(
                    None,
                    LoopCheckKind::Command,
                    "Tests pass",
                    Some("bun run test"),
                ),
                entry(
                    None,
                    LoopCheckKind::Judge,
                    "No new dependency",
                    Some("ignored"),
                ),
                entry(None, LoopCheckKind::Manual, "Scrolls smoothly", None),
            ],
        )
        .unwrap();
        assert_eq!(
            first[1].command, None,
            "only a command check keeps a command"
        );
        conn.execute("UPDATE loop_checks SET state = 'Pass'", [])
            .unwrap();

        let (tests, judge, manual) = (first[0].id, first[1].id, first[2].id);
        let second = set(
            &mut conn,
            task,
            vec![
                entry(
                    Some(manual),
                    LoopCheckKind::Manual,
                    "Scrolls smoothly",
                    None,
                ),
                entry(
                    Some(tests),
                    LoopCheckKind::Command,
                    "Tests pass",
                    Some("bun run test:all"),
                ),
            ],
        )
        .unwrap();
        assert_eq!(second.len(), 2, "the judge check left the list");
        assert!(second.iter().all(|c| c.id != judge));
        assert_eq!(
            (second[0].id, second[0].state),
            (manual, LoopCheckState::Pass)
        );
        assert_eq!(
            (second[1].id, second[1].state),
            (tests, LoopCheckState::Pending)
        );
    }

    #[test]
    fn a_run_does_not_answer_a_check_edited_while_it_ran() {
        let mut conn = crate::project_store::open_in_memory();
        let task = create(&mut conn, RunMode::Loop, None);
        let command = |label, cmd| entry(None, LoopCheckKind::Command, label, Some(cmd));
        let ran = set(
            &mut conn,
            task,
            vec![
                command("Tests pass", "bun test"),
                command("Lint", "bun lint"),
            ],
        )
        .unwrap();
        // Edited while the run read the old list.
        set(
            &mut conn,
            task,
            vec![
                entry(
                    Some(ran[0].id),
                    LoopCheckKind::Command,
                    "Tests pass",
                    Some("bun test:all"),
                ),
                entry(
                    Some(ran[1].id),
                    LoopCheckKind::Command,
                    "Lint",
                    Some("bun lint"),
                ),
            ],
        )
        .unwrap();
        let results = [
            (ran[0].id, LoopCheckState::Pass, None),
            (ran[1].id, LoopCheckState::Pass, None),
        ];
        record_results(&mut conn, PROJECT, task, &ran, &results).unwrap();
        let states: Vec<_> = list_checks(&conn, PROJECT, task)
            .unwrap()
            .into_iter()
            .map(|c| c.state)
            .collect();
        assert_eq!(states, [LoopCheckState::Pending, LoopCheckState::Pass]);
    }

    #[test]
    fn every_result_is_kept_against_the_iteration_it_followed() {
        let mut conn = crate::project_store::open_in_memory();
        let task = create(&mut conn, RunMode::Loop, None);
        let ran = set(
            &mut conn,
            task,
            vec![
                entry(None, LoopCheckKind::Command, "Tests pass", Some("bun test")),
                entry(None, LoopCheckKind::Judge, "Reads well", None),
            ],
        )
        .unwrap();
        let (tests, judge) = (ran[0].id, ran[1].id);
        let newest =
            |conn: &Connection| list_iterations(conn, PROJECT, task).unwrap().pop().unwrap();
        // A first attempt cut off, then the attempt the checks run after.
        start_iteration(&conn, PROJECT, task, 1, "a", "claude").unwrap();
        let cut = newest(&conn);
        record_outcome(
            &conn,
            PROJECT,
            task,
            &cut,
            LoopIterationOutcome::Interrupted,
            None,
        )
        .unwrap();
        start_iteration(&conn, PROJECT, task, 1, "b", "claude").unwrap();
        let failing = [(tests, LoopCheckState::Fail, Some("1 failed".to_string()))];
        record_results(&mut conn, PROJECT, task, &ran, &failing).unwrap();
        let first = newest(&conn);
        record_outcome(
            &conn,
            PROJECT,
            task,
            &first,
            LoopIterationOutcome::Checked,
            None,
        )
        .unwrap();

        start_iteration(&conn, PROJECT, task, 2, "c", "claude").unwrap();
        let passing = [(tests, LoopCheckState::Pass, Some("ok".to_string()))];
        record_results(&mut conn, PROJECT, task, &ran, &failing).unwrap();
        // Re-run on the same iteration: the newer result replaces it.
        record_results(&mut conn, PROJECT, task, &ran, &passing).unwrap();
        record_judged(
            &mut conn,
            PROJECT,
            task,
            "abc",
            &[(judge, true, "fine".to_string())],
        )
        .unwrap();

        let rows = list_iterations_with_results(&conn, PROJECT, task).unwrap();
        let read = |i: usize| {
            let mut results: Vec<_> = rows[i]
                .results
                .iter()
                .map(|r| (r.check_id, r.state, r.detail.clone(), r.command.clone()))
                .collect();
            results.sort_by_key(|r| r.0);
            results
        };
        assert!(rows[0].results.is_empty(), "the cut attempt has none");
        let bun = Some("bun test".to_string());
        assert_eq!(
            read(1),
            [(
                tests,
                LoopCheckState::Fail,
                Some("1 failed".into()),
                bun.clone()
            )]
        );
        assert_eq!(
            read(2),
            [
                (tests, LoopCheckState::Pass, Some("ok".into()), bun),
                (judge, LoopCheckState::Pass, Some("fine".into()), None),
            ]
        );
        assert!(
            list_iterations(&conn, PROJECT, task)
                .unwrap()
                .iter()
                .all(|i| i.results.is_empty()),
            "the engine's list never reads them"
        );

        clear_progress(&mut conn, PROJECT, task).unwrap();
        let left: i64 = conn
            .query_row("SELECT COUNT(*) FROM loop_check_results", [], |r| r.get(0))
            .unwrap();
        assert_eq!(left, 0, "Start over clears them");
    }

    #[test]
    fn the_list_leaves_proposals_to_their_answer() {
        let mut conn = crate::project_store::open_in_memory();
        let task = create(&mut conn, RunMode::Loop, None);
        let proposal = propose(&mut conn, task, "Handles an empty list");

        let refused = set(
            &mut conn,
            task,
            vec![entry(
                Some(proposal),
                LoopCheckKind::Judge,
                "Mine now",
                None,
            )],
        );
        assert!(refused.is_err(), "a proposal is answered, not overwritten");

        let checks = set(
            &mut conn,
            task,
            vec![entry(None, LoopCheckKind::Manual, "Looks right", None)],
        )
        .unwrap();
        assert_eq!(checks.len(), 2);
        assert_eq!(checks[1].id, proposal, "the proposal follows the list");

        let answer = |accept| AnswerLoopProposalRequest {
            project_path: PROJECT.to_string(),
            task_id: task,
            check_id: proposal,
            accept,
            seal: vec!["tests/empty.test.ts".to_string(), "tests/".to_string()],
        };
        let accepted = answer_proposal(
            &mut conn,
            &answer(Some(LoopCheckSpec {
                kind: LoopCheckKind::Command,
                label: "Handles an empty list".to_string(),
                command: Some("bun run test empty".to_string()),
            })),
        )
        .unwrap();
        assert!(accepted[1].accepted);
        assert_eq!(accepted[1].kind, LoopCheckKind::Command);
        let config = super::super::get(&conn, PROJECT, task)
            .unwrap()
            .unwrap()
            .loop_config
            .unwrap();
        assert_eq!(
            config.sealed_paths,
            ["tests/empty.test.ts", "tests/"],
            "what accepting it seals joins the list"
        );
        assert!(
            answer_proposal(&mut conn, &answer(None)).is_err(),
            "answered once"
        );
    }

    #[test]
    fn a_commit_clears_the_manual_ticks() {
        let mut conn = crate::project_store::open_in_memory();
        let task = create(&mut conn, RunMode::Loop, None);
        let manual = set(
            &mut conn,
            task,
            vec![entry(None, LoopCheckKind::Manual, "Looks right", None)],
        )
        .unwrap()[0]
            .id;
        let ticked = tick(
            &mut conn,
            &TickLoopCheckRequest {
                project_path: PROJECT.to_string(),
                task_id: task,
                check_id: manual,
                ticked: true,
            },
        )
        .unwrap();
        assert_eq!(ticked[0].state, LoopCheckState::Pass);
        start_iteration(&conn, PROJECT, task, 1, "acp", "claude").unwrap();
        let iteration = list_iterations(&conn, PROJECT, task).unwrap().remove(0);
        let nothing = Committed::default();
        record_commit(&conn, PROJECT, task, &iteration, None, &nothing).unwrap();
        let state = |conn: &Connection| list_checks(conn, PROJECT, task).unwrap()[0].state;
        assert_eq!(state(&conn), LoopCheckState::Pass, "nothing committed");
        let committed = Committed {
            commit_sha: Some("abc".to_string()),
            ..Committed::default()
        };
        record_commit(&conn, PROJECT, task, &iteration, None, &committed).unwrap();
        assert_eq!(state(&conn), LoopCheckState::Pending);
    }

    #[test]
    fn a_rejected_proposal_is_gone() {
        let mut conn = crate::project_store::open_in_memory();
        let task = create(&mut conn, RunMode::Loop, None);
        let proposal = propose(&mut conn, task, "Something");
        let checks = answer_proposal(
            &mut conn,
            &AnswerLoopProposalRequest {
                project_path: PROJECT.to_string(),
                task_id: task,
                check_id: proposal,
                accept: None,
                seal: vec![],
            },
        )
        .unwrap();
        assert!(checks.is_empty());
    }

    #[test]
    fn only_a_manual_check_is_ticked() {
        let mut conn = crate::project_store::open_in_memory();
        let task = create(&mut conn, RunMode::Loop, None);
        let checks = set(
            &mut conn,
            task,
            vec![
                entry(None, LoopCheckKind::Manual, "Looks right", None),
                entry(None, LoopCheckKind::Command, "Builds", Some("cargo build")),
            ],
        )
        .unwrap();
        let tick_one = |conn: &mut Connection, check_id, ticked| {
            tick(
                conn,
                &TickLoopCheckRequest {
                    project_path: PROJECT.to_string(),
                    task_id: task,
                    check_id,
                    ticked,
                },
            )
        };
        let ticked = tick_one(&mut conn, checks[0].id, true).unwrap();
        assert_eq!(ticked[0].state, LoopCheckState::Pass);
        let unticked = tick_one(&mut conn, checks[0].id, false).unwrap();
        assert_eq!(unticked[0].state, LoopCheckState::Pending);
        assert!(tick_one(&mut conn, checks[1].id, true).is_err());
    }

    #[test]
    fn a_pipeline_task_has_no_loop_rows_to_write() {
        let mut conn = crate::project_store::open_in_memory();
        let task = create(&mut conn, RunMode::Pipeline, None);
        let err = set(&mut conn, task, vec![]).unwrap_err();
        assert!(err.contains("not a loop"), "got: {err}");
        assert!(set(&mut conn, 404, vec![])
            .unwrap_err()
            .contains("not found"));
    }

    #[test]
    fn hidden_files_replace_the_set_and_stay_inside() {
        let mut conn = crate::project_store::open_in_memory();
        let task = create(&mut conn, RunMode::Loop, None);
        let write = |conn: &mut Connection, paths: &[&str]| {
            set_hidden_files(
                conn,
                &SetLoopHiddenFilesRequest {
                    project_path: PROJECT.to_string(),
                    task_id: task,
                    files: paths
                        .iter()
                        .map(|p| LoopHiddenFile {
                            path: p.to_string(),
                            content: format!("// {p}"),
                        })
                        .collect(),
                },
            )
        };
        write(&mut conn, &["tests/a.test.ts", "tests\\b.test.ts"]).unwrap();
        let files = write(&mut conn, &["tests/b.test.ts"]).unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "tests/b.test.ts");

        assert!(write(&mut conn, &["../escape.ts"]).is_err());
        assert!(
            write(&mut conn, &["tests/"]).is_err(),
            "a file, not a directory"
        );
        assert!(write(&mut conn, &["a.ts", "a.ts"]).is_err());
        assert_eq!(list_hidden_files(&conn, PROJECT, task).unwrap().len(), 1);
    }

    #[test]
    fn a_loop_needs_a_worktree_of_its_own() {
        let mut conn = crate::project_store::open_in_memory();
        let mut request = CreateTaskRequest {
            project_path: PROJECT.to_string(),
            title: "In place".to_string(),
            description: None,
            skills: vec![],
            labels: vec![],
            base_branch: "main".to_string(),
            agent_id: None,
            priority: None,
            auto_approve: false,
            workspace_mode: WorkspaceMode::RepositoryDirectory,
            workspace_worktree_id: None,
            workspace_branch_mode: BranchMode::Create,
            workspace_branch: None,
            model_override: None,
            run_mode: RunMode::Loop,
            loop_config: None,
        };
        assert!(super::super::create(&mut conn, &request).is_err());
        request.workspace_mode = WorkspaceMode::NewWorktree;
        let task = super::super::create(&mut conn, &request).unwrap();
        assert_eq!(task.run_mode, RunMode::Loop);
        let shared = TaskUpdate {
            workspace_mode: Some(WorkspaceMode::RepositoryDirectory),
            ..TaskUpdate::default()
        };
        assert!(super::super::update(&mut conn, PROJECT, task.id, &shared).is_err());
    }

    #[test]
    fn the_checks_run_again_only_on_a_stopped_loop_with_a_commit() {
        let mut conn = crate::project_store::open_in_memory();
        let task = create(&mut conn, RunMode::Loop, None);
        let set_state = |conn: &Connection, phase: &str, status: &str| {
            conn.execute(
                "UPDATE tasks SET phase = ?1, phase_status = ?2 WHERE id = ?3",
                params![phase, status, task],
            )
            .unwrap();
        };
        set_state(&conn, "Checking", "Failed");
        let err = claim_recheck(&mut conn, PROJECT, task).unwrap_err();
        assert!(err.contains("No iteration"), "got: {err}");

        start_iteration(&conn, PROJECT, task, 1, "acp", "claude").unwrap();
        conn.execute(
            "UPDATE loop_iterations SET commit_sha = 'abc', outcome = 'Checked'",
            [],
        )
        .unwrap();
        set_state(&conn, "Iterating", "Running");
        assert!(
            claim_recheck(&mut conn, PROJECT, task).is_err(),
            "a live iteration"
        );
        set_state(&conn, "Checking", "Failed");
        let claimed = claim_recheck(&mut conn, PROJECT, task).unwrap();
        assert_eq!(
            (claimed.phase, claimed.phase_status),
            (
                Some(maestro_protocol::TaskPhase::Checking),
                Some(maestro_protocol::PhaseStatus::Running)
            )
        );
        assert_eq!(next_iteration(&conn, PROJECT, task).unwrap(), 2);
    }

    #[test]
    fn a_deleted_task_takes_its_loop_rows() {
        let mut conn = crate::project_store::open_in_memory();
        let task = create(&mut conn, RunMode::Loop, None);
        set(
            &mut conn,
            task,
            vec![entry(None, LoopCheckKind::Manual, "Done", None)],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO loop_iterations (project_path, task_id, n, attempt, started_at)
             VALUES (?1, ?2, 1, 1, 'now')",
            params![PROJECT, task],
        )
        .unwrap();
        assert_eq!(list_iterations(&conn, PROJECT, task).unwrap().len(), 1);
        super::super::delete(&conn, PROJECT, task).unwrap();
        assert!(list_checks(&conn, PROJECT, task).unwrap().is_empty());
        assert!(list_iterations(&conn, PROJECT, task).unwrap().is_empty());
    }
}
