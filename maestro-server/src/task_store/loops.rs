//! A loop task's rows: its checks, its iterations and its hidden files. See `docs/loops-plan.md`.
//!
//! Only the rows live here. What runs an iteration and what fills its row is the engine's.

use chrono::Utc;
use maestro_protocol::{
    AnswerLoopProposalRequest, LoopCheck, LoopCheckKind, LoopCheckSpec, LoopCheckState, LoopConfig,
    LoopHiddenFile, LoopIteration, LoopIterationOutcome, RunMode, SetLoopChecksRequest,
    SetLoopHiddenFilesRequest, TickLoopCheckRequest,
};
use rusqlite::{params, Connection, OptionalExtension};

use super::{commit, parse, text, transaction};

/// Version 11 of `projects.db`: the Loop run mode, every table and column the whole feature uses.
///
/// Not shipped yet, so it may still be rewritten. Frozen once a release carries it.
pub const V11_LOOPS: &str = "
ALTER TABLE tasks ADD COLUMN run_mode TEXT NOT NULL DEFAULT 'Pipeline';
ALTER TABLE tasks ADD COLUMN loop_config TEXT;
ALTER TABLE tasks ADD COLUMN loop_sealed_sha TEXT;

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
    touched_sealed INTEGER NOT NULL DEFAULT 0,
    commit_sha TEXT,
    files INTEGER NOT NULL DEFAULT 0,
    added INTEGER NOT NULL DEFAULT 0,
    removed INTEGER NOT NULL DEFAULT 0,
    summary TEXT,
    check_output TEXT,
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

/// A config as stored: every number at least 1, the setup command trimmed, and the sealed paths
/// relative.
pub fn normalize_config(config: &LoopConfig) -> Result<LoopConfig, String> {
    for (name, value) in [
        ("max_iterations", config.max_iterations),
        ("max_agent_secs", config.max_agent_secs),
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

/// A path inside the worktree, with `/`. A sealed path may end in `/` to name a directory; a hidden
/// file's may not. Nothing may climb out with `..`.
fn relative_path(path: &str, directory: bool) -> Result<String, String> {
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

fn spec(spec: &LoopCheckSpec) -> Result<LoopCheckSpec, String> {
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
            "SELECT * FROM loop_iterations WHERE project_path = ?1 AND task_id = ?2
             ORDER BY n, attempt",
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
                touched_sealed: row.get("touched_sealed")?,
                commit_sha: row.get("commit_sha")?,
                files: row.get("files")?,
                added: row.get("added")?,
                removed: row.get("removed")?,
                summary: row.get("summary")?,
                check_output: row.get("check_output")?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
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

    /// What the worker's `loop_propose_check` will write, until it exists.
    fn propose(conn: &Connection, task_id: i32, label: &str) -> i32 {
        conn.execute(
            "INSERT INTO loop_checks (project_path, task_id, position, kind, label, proposed,
                                      updated_at)
             VALUES (?1, ?2, 99, 'Judge', ?3, 1, 'now')",
            params![PROJECT, task_id, label],
        )
        .expect("propose");
        conn.last_insert_rowid() as i32
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
    fn the_run_mode_changes_only_before_the_task_starts() {
        let mut conn = crate::project_store::open_in_memory();
        let task = create(&mut conn, RunMode::Pipeline, None);
        let to_loop = TaskUpdate {
            run_mode: Some(RunMode::Loop),
            ..TaskUpdate::default()
        };
        let switched = super::super::update(&mut conn, PROJECT, task, &to_loop).unwrap();
        assert_eq!(switched.run_mode, RunMode::Loop);
        assert_eq!(switched.loop_config, Some(LoopConfig::default()));

        conn.execute(
            "UPDATE tasks SET phase = 'Implementing' WHERE id = ?1",
            params![task],
        )
        .unwrap();
        let back = TaskUpdate {
            run_mode: Some(RunMode::Pipeline),
            ..TaskUpdate::default()
        };
        assert!(super::super::update(&mut conn, PROJECT, task, &back).is_err());
        // The config is not the mode, and stays editable.
        let longer = TaskUpdate {
            loop_config: Some(LoopConfig {
                max_iterations: 20,
                ..LoopConfig::default()
            }),
            ..TaskUpdate::default()
        };
        let task = super::super::update(&mut conn, PROJECT, task, &longer).unwrap();
        assert_eq!(task.loop_config.unwrap().max_iterations, 20);
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
    fn the_list_leaves_proposals_to_their_answer() {
        let mut conn = crate::project_store::open_in_memory();
        let task = create(&mut conn, RunMode::Loop, None);
        let proposal = propose(&conn, task, "Handles an empty list");

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
        assert!(
            answer_proposal(&mut conn, &answer(None)).is_err(),
            "answered once"
        );
    }

    #[test]
    fn a_rejected_proposal_is_gone() {
        let mut conn = crate::project_store::open_in_memory();
        let task = create(&mut conn, RunMode::Loop, None);
        let proposal = propose(&conn, task, "Something");
        let checks = answer_proposal(
            &mut conn,
            &AnswerLoopProposalRequest {
                project_path: PROJECT.to_string(),
                task_id: task,
                check_id: proposal,
                accept: None,
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
