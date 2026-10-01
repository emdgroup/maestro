//! Phase 4 of the daemon store: what this app held for a project before the daemon kept it, sent
//! to the daemon once, on the first open after the upgrade.
//!
//! The only place allowed to read the legacy task, worktree, review, prompt and alias tables, and
//! the old `restorable_sessions` and `session_folders` of `.maestro/state.json`.

use crate::acp::connection_server::{query_via_server, reply};
use crate::acp::transport::{MaestroRpcMessage, ServerRequest, ServerResponse};
use crate::acp::ConnectionKey;
use crate::core::AppState;
use crate::models::GitConnection;
use crate::task::attachments::{
    attachment_relative_path, on_project_machine, TASK_ATTACHMENTS_DIR,
};
use maestro_protocol::{
    split_import, BeginImportRequest, ImportChunkRequest, ImportFloors, ImportProjectRequest,
    ImportRef, ImportedSession, Prompt, ReviewComment, SessionMeta, Task, TaskAttachment,
    TaskComment, TaskInstruction, TaskRelationship, TaskReview, Worktree, IMPORT_CHUNK_BYTES,
};
use rusqlite::types::{FromSql, Value, ValueRef};
use rusqlite::{params, Connection, OptionalExtension, Row, RowIndex};
use serde::de::DeserializeOwned;
use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};
use tauri::Emitter;

/// A large board with its threads can take the daemon a while to write in one transaction.
const IMPORT_TIMEOUT_SECS: u64 = 300;

/// `importFailure` in `src/utils/helpers/error-utils.ts` matches this prefix, so the picker can
/// tell a failed import, which keeps the project closed, from a prime failure it shrugs off.
pub const IMPORT_FAILED_PREFIX: &str = "IMPORT_FAILED:";

/// One per project, so a second open of a project waits for the first one's import and then finds
/// the stamp rather than sending the same rows again.
static IMPORT_LOCKS: LazyLock<Mutex<HashMap<i32, Arc<tokio::sync::Mutex<()>>>>> =
    LazyLock::new(Default::default);

/// Send this app's rows for the project to its daemon unless that was done before. A failure
/// leaves the project unstamped and fails the open, since a board shown without its rows would
/// look empty.
pub(crate) async fn import_once(
    app_state: &Arc<AppState>,
    project_id: i32,
    project_path: &str,
    connection_key: ConnectionKey,
) -> Result<(), String> {
    let lock = IMPORT_LOCKS
        .lock()
        .map_err(|e| format!("Lock failed: {e}"))?
        .entry(project_id)
        .or_default()
        .clone();
    let _guard = lock.lock().await;
    import(app_state, project_id, project_path, connection_key)
        .await
        .map_err(|error| {
            log::error!("[import] project {project_id} was not moved to its server: {error}");
            format!(
                "{IMPORT_FAILED_PREFIX}The board could not be moved to the project's server: {error}"
            )
        })
}

async fn import(
    app_state: &Arc<AppState>,
    project_id: i32,
    project_path: &str,
    connection_key: ConnectionKey,
) -> Result<(), String> {
    let mut request = {
        let conn = app_state
            .db
            .lock()
            .map_err(|e| format!("Lock failed: {e}"))?;
        let stamped: Option<String> = conn
            .query_row(
                "SELECT daemon_imported_at FROM projects WHERE id = ?1",
                [project_id],
                |row| row.get(0),
            )
            .map_err(|e| format!("Project {project_id} not found: {e}"))?;
        if stamped.is_some() {
            return Ok(());
        }
        gather(&conn, project_id, project_path)
            .map_err(|e| format!("Failed to read the project's rows: {e}"))?
    };

    let (_, git_conn) = crate::core::get_project_with_git_conn(app_state, project_id).await?;
    let state = read_legacy_state(&git_conn).await?;
    let aliases = read_aliases(app_state, project_id)?;
    let task_titles: HashMap<i32, &str> = request
        .tasks
        .iter()
        .map(|task| (task.id, task.title.as_str()))
        .collect();
    let sessions = sessions_from_state(&state, &aliases, &task_titles, project_path);
    request.sessions = sessions;

    if !is_empty(&request) {
        if let Err(e) = app_state.app_handle.emit("project-importing", project_id) {
            log::warn!("[import] emitting project-importing failed: {e}");
        }
        let copies = plan_attachments(&git_conn, project_path, &mut request.attachments).await?;
        let not_found = format!("No connection server for connection {connection_key:?}");
        let timed_out = "The project's server did not finish the import in time";
        let import_id = query_via_server(
            connection_key,
            app_state,
            &not_found,
            MaestroRpcMessage::Request(ServerRequest::BeginImport(BeginImportRequest {
                project_path: request.project_path.clone(),
                floors: std::mem::take(&mut request.floors),
            })),
            reply!(ServerResponse::BeginImportOk(response) => response.import_id),
            IMPORT_TIMEOUT_SECS,
            timed_out,
        )
        .await?;
        for chunk in split_import(request, IMPORT_CHUNK_BYTES) {
            query_via_server(
                connection_key,
                app_state,
                &not_found,
                MaestroRpcMessage::Request(ServerRequest::ImportChunk(ImportChunkRequest {
                    import_id: import_id.clone(),
                    chunk,
                })),
                reply!(ServerResponse::ImportChunkOk => ()),
                IMPORT_TIMEOUT_SECS,
                timed_out,
            )
            .await?;
        }
        let response = query_via_server(
            connection_key,
            app_state,
            &not_found,
            MaestroRpcMessage::Request(ServerRequest::CommitImport(ImportRef { import_id })),
            reply!(ServerResponse::ImportProjectOk(response) => response),
            IMPORT_TIMEOUT_SECS,
            timed_out,
        )
        .await?;
        log::info!(
            "[import] project {project_id}: {}",
            if response.imported {
                "rows moved to its server"
            } else {
                "its server already held rows, this app's were left out"
            }
        );
        if response.imported {
            copy_attachments(app_state, &git_conn, project_path, copies).await;
        }
    }

    let conn = app_state
        .db
        .lock()
        .map_err(|e| format!("Lock failed: {e}"))?;
    conn.execute(
        "UPDATE projects SET daemon_imported_at = ?1 WHERE id = ?2",
        params![crate::project::now_rfc3339(), project_id],
    )
    .map_err(|e| format!("Failed to mark the project imported: {e}"))?;
    Ok(())
}

fn is_empty(request: &ImportProjectRequest) -> bool {
    request.tasks.is_empty()
        && request.worktrees.is_empty()
        && request.prompts.is_empty()
        && request.sessions.is_empty()
}

fn read_aliases(
    app_state: &AppState,
    project_id: i32,
) -> Result<HashMap<(String, String), String>, String> {
    let conn = app_state
        .db
        .lock()
        .map_err(|e| format!("Lock failed: {e}"))?;
    aliases(&conn, project_id).map_err(|e| format!("Failed to read session names: {e}"))
}

fn aliases(
    conn: &Connection,
    project_id: i32,
) -> rusqlite::Result<HashMap<(String, String), String>> {
    conn.prepare(
        "SELECT agent_id, acp_session_id, display_name FROM session_aliases WHERE project_id = ?1",
    )?
    .query_map([project_id], |row| {
        Ok(((row.get(0)?, row.get(1)?), row.get(2)?))
    })?
    .collect()
}

/// An enum column as the app wrote it: the variant's name, which is also its serde name.
fn variant<T: DeserializeOwned>(value: Option<String>) -> Option<T> {
    serde_json::from_value(serde_json::Value::String(value?)).ok()
}

fn json_list(value: Option<String>) -> Option<Vec<String>> {
    serde_json::from_str(&value?).ok()
}

fn task_from_row(row: &Row, project_path: &str) -> rusqlite::Result<Task> {
    Ok(Task {
        id: get(row, "id")?,
        project_path: project_path.to_string(),
        title: get(row, "title")?,
        description: get(row, "description")?,
        status: variant(get(row, "status")?).unwrap_or(maestro_protocol::TaskStatus::Planning),
        priority: variant(get(row, "priority")?).unwrap_or(maestro_protocol::TaskPriority::Medium),
        base_branch: get(row, "base_branch")?,
        archived_at: get(row, "archived_at")?,
        external_id: get(row, "external_id")?,
        is_imported: get(row, "is_imported")?,
        import_source: get(row, "import_source")?,
        skills: json_list(get(row, "skills")?).unwrap_or_default(),
        model_override: get(row, "model_override")?,
        mcp_allowlist: json_list(get(row, "mcp_allowlist")?),
        skills_override: json_list(get(row, "skills_override")?),
        labels: json_list(get(row, "labels")?).unwrap_or_default(),
        external_url: get(row, "external_url")?,
        external_updated_at: get(row, "external_updated_at")?,
        created_at: get(row, "created_at")?,
        updated_at: get(row, "updated_at")?,
        auto_approve: get::<Option<bool>, _>(row, "auto_approve")?.unwrap_or(false),
        workspace_mode: variant(get(row, "workspace_mode")?)
            .unwrap_or(maestro_protocol::WorkspaceMode::NewWorktree),
        workspace_worktree_id: get(row, "workspace_worktree_id")?,
        workspace_branch_mode: variant(get(row, "workspace_branch_mode")?)
            .unwrap_or(maestro_protocol::BranchMode::Create),
        workspace_branch: get(row, "workspace_branch")?,
        agent_id: get(row, "agent_id")?,
        permission_mode_override: get(row, "permission_mode_override")?,
        execution_start_sha: get(row, "execution_start_sha")?,
        phase: variant(get(row, "phase")?),
        phase_status: variant(get(row, "phase_status")?),
        ball: variant(get(row, "ball")?).unwrap_or(maestro_protocol::TaskBall::None),
        completion: variant(get(row, "completion")?),
        execute_requested_at: get(row, "execute_requested_at")?,
        pull_request_url: get(row, "pull_request_url")?,
        pull_request_number: get(row, "pull_request_number")?,
        review_rounds: get(row, "review_rounds")?,
        fix_rounds: get(row, "fix_rounds")?,
        pull_request_ci: variant(get(row, "pull_request_ci")?),
        profile_overrides: get(row, "profile_overrides")?,
    })
}

/// A cell read as `T`, or, when it holds another storage class, converted to the nearest one `T`
/// reads: SQLite's affinity lets an old build leave text in an integer column and the like.
fn get<T: FromSql, I: RowIndex + Copy>(row: &Row, index: I) -> rusqlite::Result<T> {
    let error = match row.get::<_, T>(index) {
        Err(error @ rusqlite::Error::InvalidColumnType(..)) => error,
        other => return other,
    };
    let candidates = match row.get::<_, Value>(index)? {
        Value::Integer(number) => vec![Value::Text(number.to_string())],
        Value::Real(number) if number.fract() == 0.0 => {
            vec![
                Value::Integer(number as i64),
                Value::Text(number.to_string()),
            ]
        }
        Value::Real(number) => vec![Value::Text(number.to_string())],
        Value::Text(text) => {
            let trimmed = text.trim();
            let mut candidates = Vec::new();
            if let Ok(number) = trimmed.parse::<i64>() {
                candidates.push(Value::Integer(number));
            }
            if let Ok(number) = trimmed.parse::<f64>() {
                candidates.push(Value::Real(number));
            }
            candidates
        }
        Value::Blob(bytes) => vec![Value::Text(String::from_utf8_lossy(&bytes).into_owned())],
        Value::Null => Vec::new(),
    };
    candidates
        .iter()
        .find_map(|candidate| T::column_result(ValueRef::from(candidate)).ok())
        .ok_or(error)
}

/// The rows `map` reads. One whose cells cannot be read is logged and left out, so a single odd
/// cell does not fail every open; any other error still fails the read.
fn select<T>(
    conn: &Connection,
    sql: &str,
    project_id: i32,
    map: impl FnMut(&Row) -> rusqlite::Result<T>,
) -> rusqlite::Result<Vec<T>> {
    let mut statement = conn.prepare(sql)?;
    let mut kept = Vec::new();
    for row in statement.query_map([project_id], map)? {
        match row {
            Ok(value) => kept.push(value),
            Err(
                error @ (rusqlite::Error::InvalidColumnType(..)
                | rusqlite::Error::FromSqlConversionFailure(..)
                | rusqlite::Error::IntegralValueOutOfRange(..)),
            ) => log::warn!("[import] a row was left out, a cell could not be read: {error}"),
            Err(error) => return Err(error),
        }
    }
    Ok(kept)
}

/// Every row the app holds for the project, shaped so the daemon accepts it: a row naming a task
/// the request does not carry is dropped, or loses the reference where the row stands on its own.
/// Sessions are left to the caller, since they come from `state.json`.
fn gather(
    conn: &Connection,
    project_id: i32,
    project_path: &str,
) -> rusqlite::Result<ImportProjectRequest> {
    const OF_PROJECT: &str = "task_id IN (SELECT id FROM tasks WHERE project_id = ?1)";

    let mut tasks = select(
        conn,
        "SELECT * FROM tasks WHERE project_id = ?1 ORDER BY id",
        project_id,
        |row| task_from_row(row, project_path),
    )?;
    let task_ids: HashSet<i32> = tasks.iter().map(|task| task.id).collect();

    let relationships = select(
        conn,
        "SELECT id, from_task_id, to_task_id, relationship_type, created_at FROM task_relationships
         WHERE from_task_id IN (SELECT id FROM tasks WHERE project_id = ?1) ORDER BY id",
        project_id,
        |row| {
            Ok(TaskRelationship {
                id: get(row, 0)?,
                from_task_id: get(row, 1)?,
                to_task_id: get(row, 2)?,
                relationship_type: get(row, 3)?,
                created_at: get(row, 4)?,
            })
        },
    )?
    .into_iter()
    .filter(|r| task_ids.contains(&r.from_task_id) && task_ids.contains(&r.to_task_id))
    .collect();

    let mut instructions: Vec<TaskInstruction> = select(
        conn,
        &format!(
            "SELECT id, task_id, content, source, created_at FROM task_instructions
             WHERE {OF_PROJECT} ORDER BY id"
        ),
        project_id,
        |row| {
            Ok(TaskInstruction {
                id: get(row, 0)?,
                task_id: get(row, 1)?,
                content: get(row, 2)?,
                source: get(row, 3)?,
                created_at: get(row, 4)?,
            })
        },
    )?;
    instructions.retain(|row| task_ids.contains(&row.task_id));

    // Oldest first, since the daemon numbers them in the order sent.
    let mut comments: Vec<TaskComment> = select(
        conn,
        &format!(
            "SELECT id, task_id, kind, author, body, external_ref, phase, created_at
             FROM task_comments WHERE {OF_PROJECT} ORDER BY id"
        ),
        project_id,
        |row| {
            Ok(TaskComment {
                id: get(row, 0)?,
                task_id: get(row, 1)?,
                kind: get(row, 2)?,
                author: get(row, 3)?,
                body: get(row, 4)?,
                external_ref: get(row, 5)?,
                phase: get(row, 6)?,
                created_at: get(row, 7)?,
            })
        },
    )?;
    comments.retain(|row| task_ids.contains(&row.task_id));

    let mut attachments: Vec<TaskAttachment> = select(
        conn,
        &format!(
            "SELECT id, task_id, filename, file_path, file_size, created_at FROM task_attachments
             WHERE {OF_PROJECT} ORDER BY id"
        ),
        project_id,
        |row| {
            Ok(TaskAttachment {
                id: get(row, 0)?,
                task_id: get(row, 1)?,
                filename: get(row, 2)?,
                file_path: get(row, 3)?,
                file_size: get(row, 4)?,
                created_at: get(row, 5)?,
            })
        },
    )?;
    attachments.retain(|row| task_ids.contains(&row.task_id));

    let mut worktrees = select(
        conn,
        "SELECT id, task_id, branch_name, base_branch, path, git_status, created_at
         FROM worktrees WHERE project_id = ?1 ORDER BY id",
        project_id,
        |row| {
            Ok(Worktree {
                id: get(row, 0)?,
                project_path: project_path.to_string(),
                task_id: get(row, 1)?,
                branch_name: get(row, 2)?,
                base_branch: get(row, 3)?,
                path: get(row, 4)?,
                git_status: get(row, 5)?,
                created_at: get(row, 6)?,
            })
        },
    )?;
    for worktree in &mut worktrees {
        worktree.task_id = worktree.task_id.filter(|id| task_ids.contains(id));
    }
    let worktree_ids: HashSet<i32> = worktrees.iter().map(|worktree| worktree.id).collect();
    for task in &mut tasks {
        task.workspace_worktree_id = task
            .workspace_worktree_id
            .filter(|id| worktree_ids.contains(id));
    }

    let mut review_comments: HashMap<i32, Vec<ReviewComment>> = HashMap::new();
    for comment in select(
        conn,
        &format!(
            "SELECT id, review_id, file_path, comment, created_at FROM review_comments
             WHERE review_id IN (SELECT id FROM task_reviews WHERE {OF_PROJECT}) ORDER BY id"
        ),
        project_id,
        |row| {
            Ok(ReviewComment {
                id: get(row, 0)?,
                review_id: get(row, 1)?,
                file_path: get(row, 2)?,
                comment: get(row, 3)?,
                created_at: get(row, 4)?,
            })
        },
    )? {
        review_comments
            .entry(comment.review_id)
            .or_default()
            .push(comment);
    }
    let mut reviews: Vec<TaskReview> = select(
        conn,
        &format!(
            "SELECT id, task_id, decision, general_feedback, reviewed_at, created_at
             FROM task_reviews WHERE {OF_PROJECT} ORDER BY id"
        ),
        project_id,
        |row| {
            Ok(TaskReview {
                id: get(row, 0)?,
                task_id: get(row, 1)?,
                decision: get(row, 2)?,
                general_feedback: get(row, 3)?,
                reviewed_at: get(row, 4)?,
                created_at: get(row, 5)?,
                comments: Vec::new(),
            })
        },
    )?;
    reviews.retain(|row| task_ids.contains(&row.task_id));
    for review in &mut reviews {
        review.comments = review_comments.remove(&review.id).unwrap_or_default();
    }

    let prompts = select(
        conn,
        "SELECT id, title, body, tags, favorite, created_at, updated_at FROM prompts
         WHERE project_id = ?1 ORDER BY id",
        project_id,
        |row| {
            Ok(Prompt {
                id: get(row, 0)?,
                project_path: project_path.to_string(),
                title: get(row, 1)?,
                body: get(row, 2)?,
                tags: json_list(get(row, 3)?).unwrap_or_default(),
                favorite: get(row, 4)?,
                created_at: get(row, 5)?,
                updated_at: get(row, 6)?,
            })
        },
    )?;

    Ok(ImportProjectRequest {
        project_path: project_path.to_string(),
        tasks,
        relationships,
        instructions,
        comments,
        attachments,
        worktrees,
        reviews,
        prompts,
        sessions: Vec::new(),
        floors: floors(conn)?,
    })
}

/// The highest id the app ever minted per kind, deleted rows' included. The sequence is the app's
/// across every project, so it overshoots this project's, which only costs unused numbers.
fn floors(conn: &Connection) -> rusqlite::Result<ImportFloors> {
    let floor = |table: &str| -> rusqlite::Result<Option<i32>> {
        conn.query_row(
            "SELECT seq FROM sqlite_sequence WHERE name = ?1",
            [table],
            |row| row.get(0),
        )
        .optional()
    };
    Ok(ImportFloors {
        tasks: floor("tasks")?,
        worktrees: floor("worktrees")?,
        prompts: floor("prompts")?,
    })
}

/// One of `state.json`'s `restorable_sessions`, as builds before the daemon kept sessions wrote it.
#[derive(Deserialize)]
struct LegacySnapshot {
    agent_id: String,
    acp_session_id: String,
    #[serde(default)]
    cwd: String,
    #[serde(default)]
    session_name: Option<String>,
    #[serde(default)]
    branch_name: Option<String>,
    #[serde(default)]
    task_id: Option<i32>,
}

#[derive(Deserialize)]
struct LegacyFolder {
    agent_id: String,
    acp_session_id: String,
    relative_path: String,
}

/// Entries of `state[key]` that parse, each on its own, so one bad entry costs only itself.
fn entries<T: DeserializeOwned>(state: &serde_json::Value, key: &str) -> Vec<T> {
    state
        .get(key)
        .and_then(serde_json::Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| serde_json::from_value(item.clone()).ok())
                .collect()
        })
        .unwrap_or_default()
}

fn sessions_from_state(
    state: &serde_json::Value,
    aliases: &HashMap<(String, String), String>,
    task_titles: &HashMap<i32, &str>,
    project_path: &str,
) -> Vec<ImportedSession> {
    let folders: HashMap<(String, String), String> =
        entries::<LegacyFolder>(state, "session_folders")
            .into_iter()
            .map(|folder| {
                (
                    (folder.agent_id, folder.acp_session_id),
                    folder.relative_path,
                )
            })
            .collect();
    let folder_cwd = |relative: &String| {
        if relative.is_empty() {
            project_path.to_string()
        } else {
            on_project_machine(project_path, relative)
        }
    };
    let open: Vec<ImportedSession> = entries::<LegacySnapshot>(state, "restorable_sessions")
        .into_iter()
        .map(|snapshot| {
            let key = (snapshot.agent_id.clone(), snapshot.acp_session_id.clone());
            let cwd = match folders.get(&key) {
                Some(relative) => folder_cwd(relative),
                None if !snapshot.cwd.is_empty() => snapshot.cwd,
                None => project_path.to_string(),
            };
            let task_id = snapshot.task_id.filter(|id| task_titles.contains_key(id));
            ImportedSession {
                meta: SessionMeta {
                    session_name: aliases.get(&key).cloned().or(snapshot.session_name),
                    task_id,
                    task_name: task_id
                        .and_then(|id| task_titles.get(&id))
                        .map(|title| title.to_string()),
                    branch_name: snapshot.branch_name,
                    session_start_sha: None,
                    role: None,
                },
                agent_id: snapshot.agent_id,
                acp_session_id: snapshot.acp_session_id,
                cwd,
                can_reload: None,
                closed: false,
            }
        })
        .collect();

    // Every other conversation the user named or gave a folder arrives closed, so Session History
    // still shows both.
    let is_open: HashSet<(String, String)> = open
        .iter()
        .map(|session| (session.agent_id.clone(), session.acp_session_id.clone()))
        .collect();
    let past: HashSet<&(String, String)> = aliases
        .keys()
        .chain(folders.keys())
        .filter(|key| !is_open.contains(*key))
        .collect();
    let mut sessions = open;
    sessions.extend(past.into_iter().map(|key| {
        ImportedSession {
            agent_id: key.0.clone(),
            acp_session_id: key.1.clone(),
            cwd: folders
                .get(key)
                .map(folder_cwd)
                .unwrap_or_else(|| project_path.to_string()),
            meta: SessionMeta {
                session_name: aliases.get(key).cloned(),
                ..SessionMeta::default()
            },
            can_reload: None,
            closed: true,
        }
    }));
    sessions
}

/// `state.json` as builds before the daemon wrote it. A missing file holds no sessions and an
/// unparseable one is logged and read as none, but one that is there and cannot be read fails the
/// import, so the project is not stamped with its sessions left behind.
async fn read_legacy_state(conn: &GitConnection) -> Result<serde_json::Value, String> {
    let path = format!("{}/.maestro/state.json", conn.path());
    if !crate::connectivity::files::try_exists(conn, &path).await? {
        return Ok(serde_json::Value::Null);
    }
    let text = if matches!(conn, GitConnection::Local { .. }) {
        tokio::fs::read_to_string(&path)
            .await
            .map_err(|e| format!("Failed to read {path}: {e}"))?
    } else {
        let output = crate::connectivity::exec_channel::run_on(conn, None, "cat", &[&path]).await?;
        if !output.success() {
            return Err(format!("Failed to read {path}: {}", output.stderr_string()));
        }
        output.stdout_string()
    };
    Ok(serde_json::from_str(&text).unwrap_or_else(|e| {
        log::warn!("[import] {path} is not JSON, its sessions are left out: {e}");
        serde_json::Value::Null
    }))
}

/// A file on this machine to copy into the project once the daemon has taken the rows.
struct PendingCopy {
    attachment_id: i32,
    task_id: i32,
    source: PathBuf,
    relative: String,
}

/// Point each attachment whose file is on this machine (`present`) at a name of its own under its
/// task's folder, one `existing` does not hold, and return the copies that makes owed. A row
/// whose file is elsewhere keeps the path it has and shows as missing.
fn assign_destinations(
    attachments: &mut [TaskAttachment],
    present: &HashSet<i32>,
    existing: &HashMap<i32, HashSet<String>>,
) -> Vec<PendingCopy> {
    let mut taken: HashMap<i32, HashSet<String>> = HashMap::new();
    let mut copies = Vec::new();
    for attachment in attachments.iter_mut() {
        if !present.contains(&attachment.id) {
            continue;
        }
        let source = PathBuf::from(&attachment.file_path);
        let Some(name) = source.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let task_taken = taken.entry(attachment.task_id).or_insert_with(|| {
            existing
                .get(&attachment.task_id)
                .into_iter()
                .flatten()
                .map(|name| format!("{TASK_ATTACHMENTS_DIR}/{}/{name}", attachment.task_id))
                .collect()
        });
        let relative = attachment_relative_path(
            attachment.task_id,
            name,
            &task_taken.iter().map(String::as_str).collect(),
        );
        task_taken.insert(relative.clone());
        attachment.file_path = relative.clone();
        copies.push(PendingCopy {
            attachment_id: attachment.id,
            task_id: attachment.task_id,
            source,
            relative,
        });
    }
    copies
}

/// Decide where each attachment on this machine goes in the project, reading every destination
/// folder first so no file already there is overwritten. Nothing is copied yet.
async fn plan_attachments(
    git_conn: &GitConnection,
    project_path: &str,
    attachments: &mut [TaskAttachment],
) -> Result<Vec<PendingCopy>, String> {
    let mut present = HashSet::new();
    let mut existing: HashMap<i32, HashSet<String>> = HashMap::new();
    for attachment in attachments.iter() {
        let source = Path::new(&attachment.file_path);
        if !source.is_absolute() || !tokio::fs::try_exists(source).await.unwrap_or(false) {
            continue;
        }
        present.insert(attachment.id);
        if existing.contains_key(&attachment.task_id) {
            continue;
        }
        let dir = on_project_machine(
            project_path,
            &format!("{TASK_ATTACHMENTS_DIR}/{}", attachment.task_id),
        );
        let names = if crate::connectivity::files::try_dir_exists(git_conn, &dir).await? {
            crate::connectivity::files::contents(git_conn, &dir, true)
                .await?
                .into_iter()
                .map(|entry| entry.name)
                .collect()
        } else {
            HashSet::new()
        };
        existing.insert(attachment.task_id, names);
    }
    Ok(assign_destinations(attachments, &present, &existing))
}

/// Make the copies the daemon's rows now point at. A failure is logged and the row shows as
/// missing; the rows are already in, so it does not fail the import.
async fn copy_attachments(
    app_state: &AppState,
    git_conn: &GitConnection,
    project_path: &str,
    copies: Vec<PendingCopy>,
) {
    for copy in copies {
        let dir = on_project_machine(
            project_path,
            &format!("{TASK_ATTACHMENTS_DIR}/{}", copy.task_id),
        );
        let dest = on_project_machine(project_path, &copy.relative);
        if let Err(e) = crate::acp::attachment_handlers::copy_to_machine(
            app_state,
            git_conn,
            &copy.source,
            &dir,
            &dest,
        )
        .await
        {
            log::warn!(
                "[import] attachment {} was not copied: {e}",
                copy.attachment_id
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PROJECT: &str = "/srv/shop";

    fn app_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::core::schema::initialize_schema(&conn).unwrap();
        conn.execute_batch(
            "INSERT INTO projects (id, name, path, created_at, updated_at)
                 VALUES (1, 'shop', '/srv/shop', 't', 't'), (2, 'other', '/srv/other', 't', 't');
             INSERT INTO tasks (id, project_id, title, status, priority, base_branch, created_at,
                                updated_at, phase, ball, labels, mcp_allowlist)
                 VALUES (7, 1, 'Seven', 'Review', 'High', 'main', 't', 't', 'SelfReview', 'User',
                         '[\"ui\"]', '[\"maestro\"]'),
                        (9, 1, 'Nine', 'Bogus', 'Low', 'main', 't', 't', NULL, 'None', '[]', NULL),
                        (11, 2, 'Other', 'Queue', 'Low', 'main', 't', 't', NULL, 'None', '[]', NULL);
             INSERT INTO worktrees (id, project_id, task_id, branch_name, path, created_at)
                 VALUES (3, 1, 7, 'maestro/7-seven', '.maestro/worktrees/task-7', 't'),
                        (4, 1, NULL, 'session', '.maestro/worktrees/session-4', 't');
             UPDATE tasks SET workspace_worktree_id = 4, workspace_mode = 'ReuseWorkspace'
                 WHERE id = 9;
             INSERT INTO task_comments (id, task_id, kind, author, body, created_at)
                 VALUES (20, 9, 'note', 'user', 'second of nine', 't2'),
                        (5, 7, 'plan', 'agent', 'first of seven', 't1'),
                        (6, 9, 'note', 'user', 'first of nine', 't1'),
                        (30, 11, 'note', 'user', 'other project', 't');
             INSERT INTO task_relationships (from_task_id, to_task_id, relationship_type, created_at)
                 VALUES (7, 9, 'blocks', 't'), (7, 11, 'blocks', 't');
             INSERT INTO task_reviews (id, task_id, decision, created_at)
                 VALUES (2, 7, 'RequestChanges', 't');
             INSERT INTO review_comments (review_id, file_path, comment, created_at)
                 VALUES (2, 'a.rs', 'one', 't'), (2, 'b.rs', 'two', 't');
             INSERT INTO prompts (id, project_id, title, body, tags, created_at, updated_at, favorite)
                 VALUES (4, 1, 'mine', 'b', '[\"x\"]', 't', 't', 1),
                        (5, NULL, 'shared', 'b', '[]', 't', 't', 0);
             INSERT INTO session_aliases (project_id, agent_id, acp_session_id, display_name)
                 VALUES (1, 'claude-acp', 'acp-1', 'Named');",
        )
        .unwrap();
        conn
    }

    #[test]
    fn gather_keeps_ids_and_orders_threads_oldest_first() {
        let request = gather(&app_db(), 1, PROJECT).unwrap();

        let ids: Vec<i32> = request.tasks.iter().map(|task| task.id).collect();
        assert_eq!(ids, vec![7, 9]);
        let seven = &request.tasks[0];
        assert_eq!(seven.status, maestro_protocol::TaskStatus::Review);
        assert_eq!(seven.phase, Some(maestro_protocol::TaskPhase::SelfReview));
        assert_eq!(seven.ball, maestro_protocol::TaskBall::User);
        assert_eq!(seven.labels, vec!["ui"]);
        assert_eq!(seven.mcp_allowlist, Some(vec!["maestro".to_string()]));
        assert_eq!(seven.project_path, PROJECT);
        // An unknown value falls back to the default the app read it as.
        assert_eq!(
            request.tasks[1].status,
            maestro_protocol::TaskStatus::Planning
        );
        assert_eq!(request.tasks[1].workspace_worktree_id, Some(4));

        let bodies: Vec<&str> = request
            .comments
            .iter()
            .filter_map(|comment| comment.body.as_deref())
            .collect();
        assert_eq!(
            bodies,
            vec!["first of seven", "first of nine", "second of nine"]
        );

        assert_eq!(request.relationships.len(), 1);
        assert_eq!(request.relationships[0].to_task_id, 9);
        assert_eq!(request.reviews.len(), 1);
        let files: Vec<&str> = request.reviews[0]
            .comments
            .iter()
            .map(|comment| comment.file_path.as_str())
            .collect();
        assert_eq!(files, vec!["a.rs", "b.rs"]);

        let worktrees: Vec<(i32, Option<i32>)> = request
            .worktrees
            .iter()
            .map(|worktree| (worktree.id, worktree.task_id))
            .collect();
        assert_eq!(worktrees, vec![(3, Some(7)), (4, None)]);

        assert_eq!(request.prompts.len(), 1);
        assert_eq!(request.prompts[0].id, 4);
        assert!(request.prompts[0].favorite);
        assert_eq!(request.prompts[0].tags, vec!["x"]);
    }

    /// Rows left behind while foreign keys were off name tasks the request does not carry, and
    /// would roll the whole import back if sent.
    #[test]
    fn gather_drops_or_unlinks_rows_whose_task_is_gone() {
        let conn = app_db();
        conn.execute_batch(
            "PRAGMA foreign_keys = OFF;
             INSERT INTO task_comments (task_id, kind, author, body, created_at)
                 VALUES (99, 'note', 'user', 'orphan', 't');
             INSERT INTO worktrees (id, project_id, task_id, branch_name, path, created_at)
                 VALUES (8, 1, 99, 'gone', '.maestro/worktrees/task-99', 't');
             UPDATE tasks SET workspace_worktree_id = 77 WHERE id = 7;
             PRAGMA foreign_keys = ON;",
        )
        .unwrap();

        let request = gather(&conn, 1, PROJECT).unwrap();
        assert!(request.comments.iter().all(|comment| comment.task_id != 99));
        let orphan = request.worktrees.iter().find(|w| w.id == 8).unwrap();
        assert_eq!(orphan.task_id, None);
        assert_eq!(request.tasks[0].workspace_worktree_id, None);
    }

    #[test]
    fn sessions_come_from_state_json_with_names_and_folders() {
        let state = serde_json::json!({
            "tasks": [],
            "restorable_sessions": [
                { "agent_id": "claude-acp", "acp_session_id": "acp-1", "cwd": "/old/cwd",
                  "session_name": "snapshot name", "connection_key": { "type": "local" },
                  "branch_name": "maestro/7-seven", "task_id": 7 },
                { "agent_id": "codex", "acp_session_id": "acp-2", "cwd": "/srv/shop/sub",
                  "session_name": null, "task_id": 99 },
                { "agent_id": "broken" },
                { "agent_id": "codex", "acp_session_id": "acp-3" }
            ],
            "session_folders": [
                { "agent_id": "claude-acp", "acp_session_id": "acp-1",
                  "relative_path": ".maestro/worktrees/task-7" },
                { "agent_id": "codex", "acp_session_id": "acp-3", "relative_path": "" },
                { "agent_id": "codex", "acp_session_id": "acp-past", "relative_path": "sub" }
            ]
        });
        let aliases = aliases(&app_db(), 1).unwrap();
        let titles = HashMap::from([(7, "Seven")]);

        let sessions = sessions_from_state(&state, &aliases, &titles, PROJECT);
        assert_eq!(sessions.len(), 4);
        assert!(sessions[..3].iter().all(|session| !session.closed));

        assert_eq!(sessions[0].cwd, "/srv/shop/.maestro/worktrees/task-7");
        assert_eq!(sessions[0].meta.session_name.as_deref(), Some("Named"));
        assert_eq!(sessions[0].meta.task_id, Some(7));
        assert_eq!(sessions[0].meta.task_name.as_deref(), Some("Seven"));
        assert_eq!(
            sessions[0].meta.branch_name.as_deref(),
            Some("maestro/7-seven")
        );
        assert_eq!(sessions[0].can_reload, None);

        assert_eq!(sessions[1].cwd, "/srv/shop/sub");
        assert_eq!(sessions[1].meta.task_id, None);
        assert_eq!(sessions[1].meta.task_name, None);

        assert_eq!(sessions[2].cwd, PROJECT);

        assert_eq!(sessions[3].acp_session_id, "acp-past");
        assert!(sessions[3].closed);
        assert_eq!(sessions[3].cwd, "/srv/shop/sub");
    }

    #[test]
    fn floors_come_from_the_app_sequence() {
        let conn = app_db();
        let floors = floors(&conn).unwrap();
        let tasks: Option<i32> = conn
            .query_row(
                "SELECT seq FROM sqlite_sequence WHERE name = 'tasks'",
                [],
                |row| row.get(0),
            )
            .ok();
        assert_eq!(floors.tasks, tasks);
    }

    #[test]
    fn a_malformed_state_json_yields_no_sessions() {
        let titles = HashMap::new();
        for state in [
            serde_json::Value::Null,
            serde_json::json!("not an object"),
            serde_json::json!({ "restorable_sessions": { "not": "a list" } }),
        ] {
            assert!(sessions_from_state(&state, &HashMap::new(), &titles, PROJECT).is_empty());
        }
    }

    #[test]
    fn a_row_with_an_unreadable_cell_is_left_out_and_odd_cells_are_coerced() {
        let conn = app_db();
        conn.execute_batch(
            "UPDATE tasks SET review_rounds = 'many' WHERE id = 9;
             UPDATE tasks SET title = X'5365766e' WHERE id = 7;
             UPDATE prompts SET favorite = '1' WHERE id = 4;",
        )
        .unwrap();

        let request = gather(&conn, 1, PROJECT).unwrap();
        let ids: Vec<i32> = request.tasks.iter().map(|task| task.id).collect();
        assert_eq!(ids, vec![7]);
        assert_eq!(request.tasks[0].title, "Sevn");
        assert!(request.comments.iter().all(|comment| comment.task_id == 7));
        assert!(request.prompts[0].favorite);
    }

    fn attachment(id: i32, task_id: i32, file_path: &str) -> TaskAttachment {
        TaskAttachment {
            id,
            task_id,
            filename: "notes.txt".to_string(),
            file_path: file_path.to_string(),
            file_size: 1,
            created_at: "t".to_string(),
        }
    }

    #[test]
    fn destinations_step_around_files_already_in_the_project() {
        let mut attachments = vec![
            attachment(1, 7, "/home/me/notes.txt"),
            attachment(2, 7, "/tmp/notes.txt"),
            attachment(3, 9, "/home/me/notes.txt"),
            attachment(4, 7, "/elsewhere/gone.txt"),
        ];
        let present = HashSet::from([1, 2, 3]);
        let existing = HashMap::from([(7, HashSet::from(["notes.txt".to_string()]))]);

        let copies = assign_destinations(&mut attachments, &present, &existing);
        let paths: Vec<&str> = attachments.iter().map(|a| a.file_path.as_str()).collect();
        assert_eq!(
            paths,
            vec![
                ".maestro/attachments/tasks/7/notes-1.txt",
                ".maestro/attachments/tasks/7/notes-2.txt",
                ".maestro/attachments/tasks/9/notes.txt",
                "/elsewhere/gone.txt",
            ]
        );
        assert_eq!(copies.len(), 3);
        assert_eq!(copies[0].source, PathBuf::from("/home/me/notes.txt"));
        assert_eq!(copies[0].relative, paths[0]);
    }

    #[tokio::test]
    async fn state_json_missing_is_empty_malformed_is_logged_and_unreadable_fails() {
        let project = tempfile::tempdir().unwrap();
        let conn = GitConnection::Local {
            path: project.path().to_string_lossy().into_owned(),
        };
        assert_eq!(
            read_legacy_state(&conn).await.unwrap(),
            serde_json::Value::Null
        );

        let maestro = project.path().join(".maestro");
        std::fs::create_dir_all(&maestro).unwrap();
        std::fs::write(maestro.join("state.json"), "{ not json").unwrap();
        assert_eq!(
            read_legacy_state(&conn).await.unwrap(),
            serde_json::Value::Null
        );

        std::fs::remove_file(maestro.join("state.json")).unwrap();
        std::fs::create_dir(maestro.join("state.json")).unwrap();
        assert!(read_legacy_state(&conn).await.is_err());
    }
}
