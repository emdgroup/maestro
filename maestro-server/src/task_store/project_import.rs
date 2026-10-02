//! A project's rows as an app held them before the daemon kept them, taken in.
//!
//! All or nothing, in one transaction: a row that does not fit, such as a comment on a task the
//! import does not carry, fails the foreign key and nothing is kept. Every import leaves a row in
//! `project_imports` naming its source, the sending app installation, and an empty import sets it
//! too. A source that imported the project before is refused before anything is written, and so is
//! every source once a marker from before sources were recorded (`source_id` NULL) is there, since
//! nobody can say whose rows that one carried.
//!
//! The first source in keeps its ids. Rows the daemon wrote for the project before it (an
//! automation's adopted worktree, a task or prompt an agent created) are moved above every id the
//! import carries and above its floors, and every reference to them moves along, so the imported
//! rows keep their ids and the folders and branches named after them still match.
//!
//! A later source is merged the other way round: the rows already there stay, and the incoming
//! ones move up by offsets reserved at `begin`, so the app can copy attachments into the folder of
//! each task's final id before it commits.

use std::collections::{HashMap, HashSet};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use chrono::Utc;
use maestro_protocol::{
    BeginImportRequest, BeginImportResponse, ImportChunkRequest, ImportFloors,
    ImportProjectRequest, ImportProjectResponse, ProjectRef, ServerResponse,
};
use rusqlite::{params, Connection, OptionalExtension, Transaction};

use super::{commit, json, text, transaction};
use crate::automations::canonical_project_path;
use crate::sessions::SessionMap;

/// What every staged import together may hold before a begin or a chunk is refused.
const STAGED_LIMIT_BYTES: usize = 512 * 1024 * 1024;
/// A staged import nobody committed for this long is dropped on the next begin or chunk.
const STAGED_TTL: Duration = Duration::from_secs(10 * 60);

/// How much each kind of id of a merged import moves up.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
struct Offsets {
    tasks: i32,
    worktrees: i32,
    prompts: i32,
}

pub struct Staged {
    request: ImportProjectRequest,
    source_id: Option<String>,
    /// `None` for the first source in, else the offsets `begin` reserved.
    merge: Option<Offsets>,
    bytes: usize,
    touched: Instant,
}

impl Staged {
    /// Canonical.
    pub fn project_path(&self) -> &str {
        &self.request.project_path
    }
}

// ponytail: process-wide map rather than main-loop state, one daemon per machine makes them the same.
static STAGED: LazyLock<Mutex<HashMap<String, Staged>>> = LazyLock::new(Default::default);

fn staged() -> std::sync::MutexGuard<'static, HashMap<String, Staged>> {
    let mut staged = STAGED.lock().unwrap_or_else(|e| e.into_inner());
    staged.retain(|_, entry| entry.touched.elapsed() < STAGED_TTL);
    staged
}

/// Opens a staged import; its rows arrive with `chunk`, and `take_staged` hands them to `answer`.
/// Refused here, with nothing staged, when the source imported the project before. A merge
/// reserves its id ranges now: a reservation never committed only costs unused numbers.
pub fn begin(conn: &mut Connection, request: BeginImportRequest) -> Result<ServerResponse, String> {
    if staged().values().map(|entry| entry.bytes).sum::<usize>() >= STAGED_LIMIT_BYTES {
        return Err("Too many imports are staged on this server".to_string());
    }
    let project_path = canonical_project_path(&request.project_path);
    let tx = transaction(conn)?;
    let markers = markers(&tx, &project_path)?;
    if refused(&markers, request.source_id.as_deref()) {
        return Ok(ServerResponse::BeginImportOk(BeginImportResponse {
            import_id: String::new(),
            imported_before: true,
            merge: false,
            task_offset: 0,
        }));
    }
    let merge = if markers.is_empty() {
        None
    } else {
        Some(reserve(&tx, &project_path, &request.floors)?)
    };
    commit(tx)?;

    let import_id = uuid::Uuid::new_v4().to_string();
    staged().insert(
        import_id.clone(),
        Staged {
            request: ImportProjectRequest {
                project_path,
                floors: request.floors,
                ..ImportProjectRequest::default()
            },
            source_id: request.source_id,
            merge,
            bytes: 0,
            touched: Instant::now(),
        },
    );
    Ok(ServerResponse::BeginImportOk(BeginImportResponse {
        import_id,
        imported_before: false,
        merge: merge.is_some(),
        task_offset: merge.map_or(0, |offsets| offsets.tasks),
    }))
}

pub fn chunk(request: ImportChunkRequest) -> Result<ServerResponse, String> {
    let mut staged = staged();
    let bytes = serde_json::to_vec(&request.chunk).map_or(0, |bytes| bytes.len());
    if staged.values().map(|entry| entry.bytes).sum::<usize>() + bytes > STAGED_LIMIT_BYTES {
        return Err("Too many imports are staged on this server".to_string());
    }
    let entry = staged
        .get_mut(&request.import_id)
        .ok_or_else(|| unknown(&request.import_id))?;
    let (into, from) = (&mut entry.request, request.chunk);
    into.tasks.extend(from.tasks);
    into.relationships.extend(from.relationships);
    into.instructions.extend(from.instructions);
    into.comments.extend(from.comments);
    into.attachments.extend(from.attachments);
    into.worktrees.extend(from.worktrees);
    into.reviews.extend(from.reviews);
    into.prompts.extend(from.prompts);
    into.sessions.extend(from.sessions);
    entry.bytes += bytes;
    entry.touched = Instant::now();
    Ok(ServerResponse::ImportChunkOk)
}

/// Takes the staged import out, to be applied with `answer`.
pub fn take_staged(import_id: &str) -> Result<Staged, String> {
    staged().remove(import_id).ok_or_else(|| unknown(import_id))
}

fn unknown(import_id: &str) -> String {
    format!("No import {import_id} is staged on this server")
}

/// The project's tasks something live names right now, which a first import must not renumber.
#[derive(Debug, Default)]
pub struct Live {
    /// Bound to a session in the map, or held by a window.
    pub tasks: HashSet<i32>,
    /// A start is coming up somewhere on the machine, its task not yet in the session map.
    pub starting: bool,
}

/// What `answer` needs to know of the daemon's running state. `project_path` is canonical.
pub fn live(project_path: &str, sessions: &SessionMap) -> Live {
    let mut tasks: HashSet<i32> = sessions
        .values()
        .filter_map(|session| session.project.as_ref())
        .filter(|binding| canonical_project_path(&binding.project_path) == project_path)
        .filter_map(|binding| binding.meta.task_id)
        .collect();
    tasks.extend(crate::pipeline_settings::held_tasks(project_path));
    Live {
        tasks,
        // ponytail: the in-flight count is machine-wide, so any start defers a first import that
        // would renumber; per-project counts if that ever keeps an import waiting long.
        starting: crate::task_runner::in_flight() > 0,
    }
}

/// The reply, and the pushes to broadcast after it: none when the import was refused.
pub fn answer(
    conn: &mut Connection,
    staged: Staged,
    live: &Live,
) -> Result<(ServerResponse, Vec<ServerResponse>), String> {
    let project_path = staged.request.project_path.clone();
    let imported = import(conn, staged, live)?;
    let reply = ServerResponse::ImportProjectOk(ImportProjectResponse { imported });
    if !imported {
        return Ok((reply, Vec::new()));
    }
    let project = || ProjectRef {
        project_path: project_path.clone(),
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

/// Version 9: one marker per project and source, so a second app's board is merged rather than
/// refused. Markers from before keep a NULL source, which matches every source. Frozen.
pub const V9_IMPORT_SOURCES: &str = "
CREATE TABLE project_imports_v9 (
    project_path TEXT NOT NULL,
    -- The app installation that sent the import; NULL when not recorded.
    source_id    TEXT,
    imported_at  TEXT NOT NULL,
    -- 'rows' when the import carried any, 'empty' when it carried none.
    source       TEXT NOT NULL,
    UNIQUE (project_path, source_id)
);
INSERT INTO project_imports_v9 (project_path, source_id, imported_at, source)
    SELECT project_path, NULL, imported_at, source FROM project_imports;
DROP TABLE project_imports;
ALTER TABLE project_imports_v9 RENAME TO project_imports;
";

/// The source of every import the project has had, `None` for one from before sources.
fn markers(tx: &Transaction, project: &str) -> Result<Vec<Option<String>>, String> {
    let read = || -> rusqlite::Result<Vec<Option<String>>> {
        tx.prepare("SELECT source_id FROM project_imports WHERE project_path = ?1")?
            .query_map(params![project], |row| row.get(0))?
            .collect()
    };
    read().map_err(|e| format!("Failed to read the project's import markers: {e}"))
}

/// Whether `source` may not import: it did before, a marker of unknown source could be its own, or
/// it names no source while any marker is there.
fn refused(markers: &[Option<String>], source: Option<&str>) -> bool {
    markers
        .iter()
        .any(|marker| marker.is_none() || source.is_none() || marker.as_deref() == source)
}

/// Each kind's offset for a merge: its counter, highest id held or the import's floor, whichever is
/// highest. The counter moves to the offset plus the floor, which reserves every id the import can
/// land on, since the app sends floors no lower than its highest id.
fn reserve(tx: &Transaction, project: &str, floors: &ImportFloors) -> Result<Offsets, String> {
    let offset = |counter: &str, table: &str, floor: Option<i32>| -> Result<i32, String> {
        tx.query_row(
            &format!(
                "SELECT MAX(COALESCE((SELECT {counter} FROM project_counters
                                      WHERE project_path = ?1), 0),
                            (SELECT COALESCE(MAX(id), 0) FROM {table} WHERE project_path = ?1),
                            ?2)"
            ),
            params![project, floor.unwrap_or(0)],
            |row| row.get(0),
        )
        .map_err(|e| format!("Failed to read the project's counters: {e}"))
    };
    let offsets = Offsets {
        tasks: offset("last_task_id", "tasks", floors.tasks)?,
        worktrees: offset("last_worktree_id", "worktrees", floors.worktrees)?,
        prompts: offset("last_prompt_id", "prompts", floors.prompts)?,
    };
    tx.execute(
        "INSERT INTO project_counters (project_path, last_task_id, last_worktree_id,
                                       last_prompt_id)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(project_path) DO UPDATE SET
             last_task_id = MAX(last_task_id, excluded.last_task_id),
             last_worktree_id = MAX(last_worktree_id, excluded.last_worktree_id),
             last_prompt_id = MAX(last_prompt_id, excluded.last_prompt_id)",
        params![
            project,
            offsets.tasks + floors.tasks.unwrap_or(0),
            offsets.worktrees + floors.worktrees.unwrap_or(0),
            offsets.prompts + floors.prompts.unwrap_or(0),
        ],
    )
    .map_err(|e| format!("Failed to reserve the import's ids: {e}"))?;
    Ok(offsets)
}

/// `Ok(false)` when refused. The staged path is already canonical.
fn import(conn: &mut Connection, staged: Staged, live: &Live) -> Result<bool, String> {
    let Staged {
        mut request,
        source_id,
        merge,
        ..
    } = staged;
    let tx = transaction(conn)?;
    let markers = markers(&tx, &request.project_path)?;
    if refused(&markers, source_id.as_deref()) {
        return Ok(false);
    }
    let failed = |e: String| format!("Import failed, nothing was kept: {e}");
    // Moving a task's id moves its children in separate statements, so keys are checked at commit.
    // SQLite resets this when the transaction ends.
    tx.pragma_update(None, "defer_foreign_keys", "ON")
        .map_err(|e| failed(e.to_string()))?;
    match merge {
        Some(offsets) => renumber(&tx, &mut request, offsets).map_err(failed)?,
        // Another source committed between this one's begin and now, so this one has to merge.
        None if !markers.is_empty() => {
            return Err(
                "Another app's board reached the project's server first. Retry to merge this \
                 one into it"
                    .to_string(),
            )
        }
        None => {
            check_not_live(&tx, &request.project_path, live)?;
            make_room(&tx, &request).map_err(failed)?;
        }
    }
    write(&tx, &request, source_id.as_deref()).map_err(failed)?;
    commit(tx).map_err(failed)?;
    Ok(true)
}

/// `make_room` renumbers every task the daemon holds for the project, so it waits while a session,
/// a hold or a start may name one of them by its current id.
fn check_not_live(tx: &Transaction, project: &str, live: &Live) -> Result<(), String> {
    let held: Vec<i32> = tx
        .prepare("SELECT id FROM tasks WHERE project_path = ?1")
        .and_then(|mut statement| {
            statement
                .query_map(params![project], |row| row.get(0))?
                .collect()
        })
        .map_err(|e| format!("Failed to read the project's tasks: {e}"))?;
    if held.is_empty() {
        return Ok(());
    }
    if live.starting || held.iter().any(|id| live.tasks.contains(id)) {
        return Err(
            "A task on the project's server is being worked on right now, and taking this board \
             in would renumber it. Retry once it settles"
                .to_string(),
        );
    }
    Ok(())
}

/// Move a merged import's ids up by `offsets`, every reference along with them. An incoming
/// worktree whose folder or branch the project already has is left out, the row there kept.
fn renumber(
    tx: &Transaction,
    request: &mut ImportProjectRequest,
    offsets: Offsets,
) -> Result<(), String> {
    let existing: Vec<(String, String)> = tx
        .prepare("SELECT path, branch_name FROM worktrees WHERE project_path = ?1")
        .and_then(|mut statement| {
            statement
                .query_map(params![request.project_path], |row| {
                    Ok((row.get(0)?, row.get(1)?))
                })?
                .collect()
        })
        .map_err(|e| e.to_string())?;
    let (paths, branches): (HashSet<String>, HashSet<String>) = existing.into_iter().unzip();
    let mut dropped = HashSet::new();
    request.worktrees.retain(|worktree| {
        let clash = paths.contains(&worktree.path) || branches.contains(&worktree.branch_name);
        if clash {
            crate::send_diag(
                "warn",
                format!(
                    "[import] worktree {} ({}) of a merged board is already on the project's \
                     server; the row there is kept",
                    worktree.id, worktree.path
                ),
            );
            dropped.insert(worktree.id);
        }
        !clash
    });

    let task = |id: i32| id + offsets.tasks;
    for row in &mut request.tasks {
        row.id = task(row.id);
        row.workspace_worktree_id = row
            .workspace_worktree_id
            .filter(|id| !dropped.contains(id))
            .map(|id| id + offsets.worktrees);
    }
    for row in &mut request.relationships {
        row.from_task_id = task(row.from_task_id);
        row.to_task_id = task(row.to_task_id);
    }
    for row in &mut request.instructions {
        row.task_id = task(row.task_id);
    }
    for row in &mut request.comments {
        row.task_id = task(row.task_id);
    }
    // The file path is already the final one: the app copied into the moved id's folder.
    for row in &mut request.attachments {
        row.task_id = task(row.task_id);
    }
    for row in &mut request.reviews {
        row.task_id = task(row.task_id);
    }
    for row in &mut request.worktrees {
        row.id += offsets.worktrees;
        row.task_id = row.task_id.map(task);
    }
    for row in &mut request.prompts {
        row.id += offsets.prompts;
    }
    for row in &mut request.sessions {
        row.meta.task_id = row.meta.task_id.map(task);
    }
    Ok(())
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
    let floors = &request.floors;
    let task_offset = request
        .tasks
        .iter()
        .map(|t| t.id)
        .fold(tasks.max(floors.tasks.unwrap_or(0)), i32::max);
    let worktree_offset = request
        .worktrees
        .iter()
        .map(|w| w.id)
        .fold(worktrees.max(floors.worktrees.unwrap_or(0)), i32::max);
    let prompt_offset = request
        .prompts
        .iter()
        .map(|p| p.id)
        .fold(prompts.max(floors.prompts.unwrap_or(0)), i32::max);

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

fn write(
    tx: &Transaction,
    request: &ImportProjectRequest,
    source_id: Option<&str>,
) -> Result<(), String> {
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
    // the app's floor (an id it minted for a row since deleted), or where it was if that is higher.
    let floors = &request.floors;
    tx.execute(
        "INSERT INTO project_counters (project_path, last_task_id, last_worktree_id,
                                       last_prompt_id)
         VALUES (?1,
                 MAX(?2, (SELECT COALESCE(MAX(id), 0) FROM tasks WHERE project_path = ?1)),
                 MAX(?3, (SELECT COALESCE(MAX(id), 0) FROM worktrees WHERE project_path = ?1)),
                 MAX(?4, (SELECT COALESCE(MAX(id), 0) FROM prompts WHERE project_path = ?1)))
         ON CONFLICT(project_path) DO UPDATE SET
             last_task_id = MAX(last_task_id, excluded.last_task_id),
             last_worktree_id = MAX(last_worktree_id, excluded.last_worktree_id),
             last_prompt_id = MAX(last_prompt_id, excluded.last_prompt_id)",
        params![
            project,
            floors.tasks.unwrap_or(0),
            floors.worktrees.unwrap_or(0),
            floors.prompts.unwrap_or(0),
        ],
    )
    .map_err(sql)?;

    // Dormant. An open one is loaded on the project's next open; a closed one is there for Session
    // History's name and folder. A row the daemon already has for the conversation is the newer
    // word on it and is kept.
    let now = Utc::now().to_rfc3339();
    for session in &request.sessions {
        let meta = &session.meta;
        tx.execute(
            "INSERT OR IGNORE INTO sessions (agent_id, acp_session_id, project_path, cwd,
                                             session_name, task_id, task_name, branch_name, role,
                                             session_start_sha, can_reload, session_id,
                                             created_at, closed_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, NULL, ?12, ?13)",
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
                session.closed.then_some(&now),
            ],
        )
        .map_err(sql)?;
    }

    let empty = request.tasks.is_empty()
        && request.worktrees.is_empty()
        && request.prompts.is_empty()
        && request.sessions.is_empty();
    tx.execute(
        "INSERT INTO project_imports (project_path, source_id, imported_at, source)
         VALUES (?1, ?2, ?3, ?4)",
        params![
            project,
            source_id,
            now,
            if empty { "empty" } else { "rows" }
        ],
    )
    .map_err(sql)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use maestro_protocol::{
        BranchMode, CreatePromptRequest, CreateTaskRequest, ImportFloors, ImportedSession,
        InsertWorktreeRequest, Prompt, ReviewComment, SessionMeta, Task, TaskBall, TaskComment,
        TaskPhase, TaskPriority, TaskRelationship, TaskReview, TaskStatus, WorkspaceMode, Worktree,
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
            claimed_from: None,
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
            closed: false,
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
            floors: ImportFloors::default(),
        }
    }

    /// Begin, one chunk and commit, as a window sends them, from `source`.
    fn run_as(
        conn: &mut Connection,
        mut request: ImportProjectRequest,
        source: &str,
    ) -> Result<(ServerResponse, Vec<ServerResponse>), String> {
        let begun = begin(
            conn,
            BeginImportRequest {
                project_path: request.project_path.clone(),
                floors: std::mem::take(&mut request.floors),
                source_id: Some(source.to_string()),
            },
        )?;
        let ServerResponse::BeginImportOk(begun) = begun else {
            panic!("expected BeginImportOk, got {begun:?}");
        };
        if begun.imported_before {
            let refused = ImportProjectResponse { imported: false };
            return Ok((ServerResponse::ImportProjectOk(refused), Vec::new()));
        }
        chunk(ImportChunkRequest {
            import_id: begun.import_id.clone(),
            chunk: request,
        })?;
        answer(conn, take_staged(&begun.import_id)?, &Live::default())
    }

    fn run(
        conn: &mut Connection,
        request: ImportProjectRequest,
    ) -> Result<(ServerResponse, Vec<ServerResponse>), String> {
        run_as(conn, request, "app-a")
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
        let (reply, pushes) = run(&mut conn, full_request()).expect("import");
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

        let (reply, _) = run(&mut conn, full_request()).expect("import");
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
            ..ImportProjectRequest::default()
        };
        let (reply, _) = run(&mut conn, empty).expect("empty import");
        assert_eq!(
            reply,
            ServerResponse::ImportProjectOk(ImportProjectResponse { imported: true })
        );
        let (reply, _) = run(&mut conn, full_request()).expect("second import");
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
        run(&mut conn, first).expect("first import");
        let before = count(&conn, "task_comments");

        let mut second = full_request();
        second.tasks = vec![task(20)];
        second.comments = vec![comment(20, "late")];
        second.worktrees.clear();
        second.reviews.clear();
        second.relationships.clear();
        let (reply, pushes) = run(&mut conn, second).expect("second import");
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
        run(&mut conn, request).expect("import");

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
    fn floors_raise_the_counters_and_a_closed_session_stays_closed() {
        let mut conn = crate::project_store::open_in_memory();
        let mut request = full_request();
        request.floors = ImportFloors {
            tasks: Some(40),
            worktrees: None,
            prompts: Some(2),
        };
        let mut past = session("acp-old", "past");
        past.closed = true;
        request.sessions = vec![past];
        run(&mut conn, request).expect("import");

        let counters: (i32, i32) = conn
            .query_row(
                "SELECT last_task_id, last_prompt_id FROM project_counters WHERE project_path = ?1",
                params![PROJECT],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("counters");
        // The task floor is above every imported id; the prompt floor is below the imported 4.
        assert_eq!(counters, (40, 4));

        let sessions = crate::project_store::list(&conn, PROJECT, true).expect("sessions");
        assert_eq!(sessions.len(), 1);
        assert!(sessions[0].0.closed);
    }

    #[test]
    fn a_bad_row_rolls_the_whole_import_back() {
        let mut conn = crate::project_store::open_in_memory();
        let mut request = full_request();
        request
            .comments
            .push(comment(99, "on a task the import lacks"));
        run(&mut conn, request).expect_err("the foreign key refuses");

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
        let (reply, _) = run(&mut conn, full_request()).expect("a retry");
        assert_eq!(
            reply,
            ServerResponse::ImportProjectOk(ImportProjectResponse { imported: true })
        );
    }

    /// A second app's board after the first: the first keeps its ids, the second moves above them,
    /// every reference along, and a worktree both boards name stays the first one's.
    #[test]
    fn a_second_source_is_merged_above_the_first() {
        let mut conn = crate::project_store::open_in_memory();
        run_as(&mut conn, full_request(), "app-a").expect("first import");

        let mut second = full_request();
        second.tasks[0].title = "B 3".to_string();
        second.tasks[1].title = "B 7".to_string();
        second.tasks[0].workspace_worktree_id = Some(10);
        second.tasks[1].workspace_worktree_id = Some(9);
        second.worktrees.push(Worktree {
            id: 10,
            project_path: PROJECT.to_string(),
            task_id: Some(3),
            branch_name: "maestro/3-b".to_string(),
            base_branch: None,
            path: ".maestro/worktrees/task-3".to_string(),
            git_status: None,
            created_at: AT.to_string(),
        });
        second.attachments = vec![maestro_protocol::TaskAttachment {
            id: 1,
            task_id: 3,
            filename: "a.txt".to_string(),
            file_path: ".maestro/attachments/tasks/10/a.txt".to_string(),
            file_size: 1,
            created_at: AT.to_string(),
        }];
        second.sessions = vec![session("acp-1", "B name"), session("acp-2", "B")];
        second.floors = ImportFloors {
            tasks: Some(7),
            worktrees: Some(10),
            prompts: Some(4),
        };

        let begun = begin(
            &mut conn,
            BeginImportRequest {
                project_path: PROJECT.to_string(),
                floors: second.floors.clone(),
                source_id: Some("app-b".to_string()),
            },
        )
        .expect("begin");
        let ServerResponse::BeginImportOk(begun) = begun else {
            panic!("expected BeginImportOk");
        };
        assert!(begun.merge && !begun.imported_before);
        assert_eq!(begun.task_offset, 7);
        chunk(ImportChunkRequest {
            import_id: begun.import_id.clone(),
            chunk: second,
        })
        .expect("chunk");
        let (reply, _) = answer(
            &mut conn,
            take_staged(&begun.import_id).expect("staged"),
            &Live::default(),
        )
        .expect("merge");
        assert_eq!(
            reply,
            ServerResponse::ImportProjectOk(ImportProjectResponse { imported: true })
        );

        let title = |id| {
            super::super::get(&conn, PROJECT, id)
                .expect("read")
                .map(|t| t.title)
        };
        assert_eq!(title(3).as_deref(), Some("Task 3"));
        assert_eq!(title(7).as_deref(), Some("Task 7"));
        assert_eq!(title(10).as_deref(), Some("B 3"));
        assert_eq!(title(14).as_deref(), Some("B 7"));
        let task = |id| {
            super::super::get(&conn, PROJECT, id)
                .expect("read")
                .expect("a task")
        };
        assert_eq!(task(10).workspace_worktree_id, Some(20), "moved by 10");
        assert_eq!(
            task(14).workspace_worktree_id,
            None,
            "pinned to A's, left out"
        );

        let worktree = |id| super::super::worktrees::get(&conn, PROJECT, id).expect("worktree");
        assert_eq!(worktree(9).and_then(|w| w.task_id), Some(7), "A's row kept");
        assert_eq!(worktree(20).and_then(|w| w.task_id), Some(10));
        assert_eq!(count(&conn, "worktrees"), 2);

        let thread = |id| {
            super::super::list_comments(&conn, PROJECT, id)
                .expect("thread")
                .len()
        };
        assert_eq!((thread(7), thread(14)), (2, 2));
        let links = super::super::list_relationships(&conn, PROJECT, 10).expect("links");
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].to_task_id, 14);
        let review = super::super::reviews::get_review(&conn, PROJECT, 14)
            .expect("review")
            .expect("the second review");
        assert_eq!(review.comments.len(), 1);
        let attachment: (i32, String) = conn
            .query_row(
                "SELECT task_id, file_path FROM task_attachments WHERE project_path = ?1",
                params![PROJECT],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("attachment");
        assert_eq!(
            attachment,
            (10, ".maestro/attachments/tasks/10/a.txt".to_string())
        );
        assert_eq!(
            crate::prompt_store::get(&conn, PROJECT, 8)
                .expect("prompt")
                .map(|p| p.title),
            Some("Review".to_string())
        );

        let sessions: Vec<(String, Option<String>, Option<i32>)> =
            crate::project_store::list(&conn, PROJECT, true)
                .expect("sessions")
                .into_iter()
                .map(|(row, _)| (row.acp_session_id, row.meta.session_name, row.meta.task_id))
                .collect();
        assert!(sessions.contains(&("acp-1".to_string(), Some("imported".to_string()), Some(7))));
        assert!(sessions.contains(&("acp-2".to_string(), Some("B".to_string()), Some(14))));

        assert_eq!(
            super::super::create(&mut conn, &create_request("Next"))
                .expect("create")
                .id,
            15
        );
        let (reply, _) = run_as(&mut conn, full_request(), "app-b").expect("again");
        assert_eq!(
            reply,
            ServerResponse::ImportProjectOk(ImportProjectResponse { imported: false }),
            "a merged source is refused the second time"
        );
    }

    #[test]
    fn a_marker_from_before_sources_refuses_every_source() {
        let mut conn = crate::project_store::open_in_memory();
        conn.execute(
            "INSERT INTO project_imports (project_path, source_id, imported_at, source)
             VALUES (?1, NULL, ?2, 'rows')",
            params![PROJECT, AT],
        )
        .expect("legacy marker");
        let (reply, _) = run_as(&mut conn, full_request(), "app-b").expect("import");
        assert_eq!(
            reply,
            ServerResponse::ImportProjectOk(ImportProjectResponse { imported: false })
        );
        assert_eq!(count(&conn, "tasks"), 0);
    }

    /// A first import that began before another source committed has to start over, as a merge.
    #[test]
    fn a_first_import_overtaken_by_another_source_fails_to_be_retried() {
        let mut conn = crate::project_store::open_in_memory();
        let begun = begin(
            &mut conn,
            BeginImportRequest {
                project_path: PROJECT.to_string(),
                floors: ImportFloors::default(),
                source_id: Some("app-b".to_string()),
            },
        )
        .expect("begin");
        let ServerResponse::BeginImportOk(begun) = begun else {
            panic!("expected BeginImportOk");
        };
        assert!(!begun.merge);
        run_as(&mut conn, full_request(), "app-a").expect("A gets there first");
        let error = answer(
            &mut conn,
            take_staged(&begun.import_id).expect("staged"),
            &Live::default(),
        )
        .expect_err("B has to merge");
        assert!(error.contains("Retry"), "{error}");
        let (reply, _) = run_as(&mut conn, full_request(), "app-b").expect("the retry merges");
        assert_eq!(
            reply,
            ServerResponse::ImportProjectOk(ImportProjectResponse { imported: true })
        );
    }

    /// Renumbering the daemon's own tasks waits while anything live names one of them.
    #[test]
    fn a_first_import_waits_while_a_daemon_task_is_live() {
        for live in [
            Live {
                tasks: HashSet::from([1]),
                starting: false,
            },
            Live {
                tasks: HashSet::new(),
                starting: true,
            },
        ] {
            let mut conn = crate::project_store::open_in_memory();
            super::super::create(&mut conn, &create_request("Agent")).expect("task");
            let begun = begin(
                &mut conn,
                BeginImportRequest {
                    project_path: PROJECT.to_string(),
                    floors: ImportFloors::default(),
                    source_id: Some("app-a".to_string()),
                },
            )
            .expect("begin");
            let ServerResponse::BeginImportOk(begun) = begun else {
                panic!("expected BeginImportOk");
            };
            chunk(ImportChunkRequest {
                import_id: begun.import_id.clone(),
                chunk: full_request(),
            })
            .expect("chunk");
            let error = answer(
                &mut conn,
                take_staged(&begun.import_id).expect("staged"),
                &live,
            )
            .expect_err("refused while live");
            assert!(error.contains("Retry"), "{error}");
            assert_eq!(count(&conn, "tasks"), 1);
            assert_eq!(count(&conn, "project_imports"), 0);
        }
    }
}
