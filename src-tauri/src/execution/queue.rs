use std::sync::Arc;
use tauri::{Emitter, State};

use crate::core::AppState;

/// Count the agents currently occupying a slot on this project's host.
///
/// A session parked in Review counts. That is deliberate back-pressure — it stops the farm
/// outrunning the reviewer — and it is also simply true of memory, which a parked agent still
/// holds. It is the reason the board has to show slot usage: a queue that has silently stopped
/// moving because three reviews are open looks identical to one that is broken.
async fn occupied_slots(app_state: &Arc<AppState>) -> i32 {
    let acp = app_state.acp.sessions.lock().await;
    let acp_count = acp.values().filter(|p| p.task_id.is_some()).count();
    let pty_meta = app_state.pty.session_meta.lock().await;
    let pty_count = pty_meta.values().filter(|m| m.task_id.is_some()).count();
    (acp_count + pty_count) as i32
}

/// What the board shows: how many slots this host has, how many are taken, and why.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, specta::Type)]
pub struct QueueCapacity {
    pub slots: i32,
    pub used: i32,
    pub mode: crate::execution::capacity::ConcurrencyMode,
    pub reason: String,
}

#[tauri::command]
#[specta::specta]
pub async fn get_queue_capacity(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
) -> Result<QueueCapacity, String> {
    let settings = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        crate::core::settings::load_settings(&conn)
            .map_err(|e| format!("Failed to load settings: {}", e))?
    };

    let used = occupied_slots(&app_state).await;

    let available_mb = match crate::core::get_project_with_git_conn(&app_state, project_id).await {
        Ok((_, git_conn)) => crate::execution::capacity::available_memory_mb(&git_conn).await,
        Err(_) => None,
    };
    let capacity = crate::execution::capacity::resolve_capacity(
        settings.concurrency_mode,
        settings.max_concurrent_agents,
        available_mb,
    );

    Ok(QueueCapacity {
        slots: capacity.slots,
        used,
        mode: capacity.mode,
        reason: capacity.reason,
    })
}

/// What a manual Execute should do about a host that is already full.
///
/// It never refuses. Which of the other two applies depends on what kind of limit is in force: a
/// fixed number the user chose is a rule and can be deferred against, while a figure derived from
/// live memory is a reading, and a user who knows their machine is fine should not be blocked by it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "PascalCase")]
pub enum ExecuteVerdict {
    Start,
    /// The task has been marked and queued; the scheduler takes it before its own picks.
    Deferred,
    /// Over a memory-derived limit. Start anyway, having said so.
    Warn,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, specta::Type)]
pub struct ExecuteDecision {
    pub verdict: ExecuteVerdict,
    pub reason: String,
}

/// Ask whether a manually-executed task can start now.
///
/// Advisory, not a gate: `claim_for_execution` remains the authority on whether a task is startable
/// at all. This answers the narrower question of whether the host has room, so that Execute can keep
/// D24's promise — never refuse, but defer against a fixed limit rather than quietly exceeding it.
///
/// Deferring moves a Planning task into Queue, because that is where the promise is kept: the
/// scheduler only draws from Queue, so a deferred task left in Planning would wait forever.
#[tauri::command]
#[specta::specta]
pub async fn request_task_execution(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    task_id: i32,
) -> Result<ExecuteDecision, String> {
    use crate::models::TaskStatus;
    use crate::task::transition::{apply_if_status, TaskTransition};

    let settings = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        crate::core::settings::load_settings(&conn)
            .map_err(|e| format!("Failed to load settings: {}", e))?
    };

    let used = occupied_slots(&app_state).await;

    let available_mb = match crate::core::get_project_with_git_conn(&app_state, project_id).await {
        Ok((_, git_conn)) => crate::execution::capacity::available_memory_mb(&git_conn).await,
        Err(_) => None,
    };
    let capacity = crate::execution::capacity::resolve_capacity(
        settings.concurrency_mode,
        settings.max_concurrent_agents,
        available_mb,
    );

    if used < capacity.slots {
        return Ok(ExecuteDecision { verdict: ExecuteVerdict::Start, reason: capacity.reason });
    }

    if capacity.mode == crate::execution::capacity::ConcurrencyMode::Auto {
        return Ok(ExecuteDecision { verdict: ExecuteVerdict::Warn, reason: capacity.reason });
    }

    let stamped = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;

        apply_if_status(
            &conn,
            task_id,
            Some(&[TaskStatus::Planning]),
            TaskTransition::ManualMove(TaskStatus::Queue),
        )?;

        // The status and phase conditions keep the marker's invariant true from the one place that
        // writes it outside `task::transition`: it exists only on a task the scheduler can still
        // pick up. A row count of zero means the task moved between the button and here, so the
        // caller is told to go ahead and let the claim refuse it — which produces the right message.
        //
        // `COALESCE` so that pressing Execute again on an already-deferred task reports the same
        // deferral rather than losing its place in the queue of promises — or, worse, reporting
        // nothing was written and being told to start over the limit.
        conn.execute(
            "UPDATE tasks SET execute_requested_at = COALESCE(execute_requested_at, ?) \
             WHERE id = ? AND status = 'Queue' AND phase IS NULL",
            rusqlite::params![chrono::Utc::now().to_rfc3339(), task_id],
        )
        .map_err(|e| format!("Failed to record the deferred execution: {}", e))?
    };

    if stamped == 0 {
        return Ok(ExecuteDecision { verdict: ExecuteVerdict::Start, reason: capacity.reason });
    }

    app_state.app_handle.emit("tasks-changed", ()).ok();

    Ok(ExecuteDecision { verdict: ExecuteVerdict::Deferred, reason: capacity.reason })
}

/// The tasks the scheduler may start, best first.
///
/// `include_undeferred` is the auto-mode flag. With it off only deferred tasks come back: manual
/// mode means "do not start what I did not ask for", and a deferral is precisely something the user
/// did ask for — dropping it would make the message they were given a lie.
///
/// `phase IS NULL` is what keeps the drain idempotent. A claimed task keeps its column until its
/// session is up, so without it a task already being spawned is picked again on the next tick, and
/// one whose spawn failed — sitting at `Spawning`/`Failed` — is retried forever.
fn queue_candidates(
    conn: &rusqlite::Connection,
    project_id: i32,
    include_undeferred: bool,
) -> Result<Vec<i32>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id FROM tasks
             WHERE project_id = ? AND status = 'Queue' AND phase IS NULL
               AND (? OR execute_requested_at IS NOT NULL)
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
        .map_err(|e| format!("Failed to prepare query: {}", e))?;

    let ids = stmt
        .query_map(rusqlite::params![project_id, include_undeferred], |row| row.get(0))
        .map_err(|e| format!("Failed to query ready tasks: {}", e))?
        .filter_map(|r| r.ok())
        .collect();

    Ok(ids)
}

/// Pick the tasks that should be started next on this project's host.
///
/// Returns ids for the frontend to run rather than starting anything itself: only Rust can decide
/// *which* tasks run, because the limit is per host and a host serves every project pointed at it,
/// but only the frontend can start one — spawning means a worktree, an ACP session and a prompt.
///
/// Task-associated user shells occupy a slot too, but queue draining never starts one; ACP is the
/// sole managed agent path.
#[tauri::command]
#[specta::specta]
pub async fn drain_ready_queue(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    project_path: String,
) -> Result<Vec<i32>, String> {
    let _ = project_path; // reserved for future use

    // Load settings in a block so the sync MutexGuard drops before the async lock below
    let settings = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        crate::core::settings::load_settings(&conn)
            .map_err(|e| format!("Failed to load settings: {}", e))?
    };

    // Candidates before capacity, because measuring capacity means probing the host — an exec over
    // SSH for a remote one — and a drain fires on every board event. Asking a remote box how much
    // memory it has in order to schedule an empty queue is a cost paid for nothing.
    let candidates = {
        let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;
        queue_candidates(&conn, project_id, settings.auto_mode)?
    };

    // Whatever the user has their hands on is not the scheduler's to take. Applied after the query
    // rather than in it because a drag is a client-side fact with no row behind it.
    let candidates = app_state.task_holds.retain_unheld(candidates);

    if candidates.is_empty() {
        return Ok(vec![]);
    }

    let running_count = occupied_slots(&app_state).await;

    // Sampled here rather than on a timer: a drain is called at exactly the moments the answer
    // could have changed — a session ending, a task arriving, the app starting.
    let available_mb = match crate::core::get_project_with_git_conn(&app_state, project_id).await {
        Ok((_, git_conn)) => crate::execution::capacity::available_memory_mb(&git_conn).await,
        Err(_) => None,
    };
    let capacity = crate::execution::capacity::resolve_capacity(
        settings.concurrency_mode,
        settings.max_concurrent_agents,
        available_mb,
    );

    let slots_available = capacity.slots - running_count;
    if slots_available <= 0 {
        log::debug!(
            "[queue] project {} has no free slots: {} running, {}",
            project_id,
            running_count,
            capacity.reason
        );
        return Ok(vec![]);
    }

    Ok(candidates.into_iter().take(slots_available as usize).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::schema::initialize_schema;
    use rusqlite::Connection;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory database");
        initialize_schema(&conn).expect("initialize schema");
        conn.execute(
            "INSERT INTO projects (id, name, path, created_at, updated_at) \
             VALUES (1, 'demo', '/tmp/demo', '2026-01-01', '2026-01-01')",
            [],
        )
        .expect("insert project");
        conn
    }

    fn queued(conn: &Connection, id: i32, priority: &str, created_at: &str) {
        conn.execute(
            "INSERT INTO tasks (id, project_id, title, status, priority, base_branch, created_at, updated_at) \
             VALUES (?, 1, 'task', 'Queue', ?, 'main', ?, ?)",
            rusqlite::params![id, priority, created_at, created_at],
        )
        .expect("insert task");
    }

    fn defer(conn: &Connection, id: i32, at: &str) {
        conn.execute(
            "UPDATE tasks SET execute_requested_at = ? WHERE id = ?",
            rusqlite::params![at, id],
        )
        .expect("defer task");
    }

    #[test]
    fn candidates_come_back_in_priority_then_arrival_order() {
        let conn = db();
        queued(&conn, 1, "Low", "2026-01-01");
        queued(&conn, 2, "Urgent", "2026-01-03");
        queued(&conn, 3, "Medium", "2026-01-02");
        queued(&conn, 4, "Medium", "2026-01-01");

        assert_eq!(queue_candidates(&conn, 1, true).unwrap(), vec![2, 4, 3, 1]);
    }

    /// The promise D35 makes. A deferred task waits for a slot, so a stream of higher-priority
    /// arrivals must not starve it — otherwise the message it was given was a lie.
    #[test]
    fn a_deferred_task_is_taken_before_the_schedulers_own_picks() {
        let conn = db();
        queued(&conn, 1, "Low", "2026-01-05");
        queued(&conn, 2, "Urgent", "2026-01-01");
        defer(&conn, 1, "2026-01-06T10:00:00Z");

        assert_eq!(queue_candidates(&conn, 1, true).unwrap(), vec![1, 2]);
    }

    /// Two deferrals are two promises, kept in the order they were made rather than by priority —
    /// which is the user's ordering of the backlog, not of what they have already asked for.
    #[test]
    fn deferrals_are_kept_in_the_order_they_were_made() {
        let conn = db();
        queued(&conn, 1, "Low", "2026-01-01");
        queued(&conn, 2, "Urgent", "2026-01-01");
        defer(&conn, 2, "2026-01-06T11:00:00Z");
        defer(&conn, 1, "2026-01-06T10:00:00Z");

        assert_eq!(queue_candidates(&conn, 1, true).unwrap(), vec![1, 2]);
    }

    /// Manual mode means "do not start what I did not ask for". A deferral is something the user
    /// did ask for, and it is the only thing the scheduler may take with auto-mode off.
    #[test]
    fn manual_mode_drains_only_what_was_deferred() {
        let conn = db();
        queued(&conn, 1, "Urgent", "2026-01-01");
        queued(&conn, 2, "Low", "2026-01-01");
        defer(&conn, 2, "2026-01-06T10:00:00Z");

        assert_eq!(queue_candidates(&conn, 1, false).unwrap(), vec![2]);
        assert!(queue_candidates(&conn, 2, false).unwrap().is_empty(), "another project's queue");
    }

    /// A claimed task keeps its column. Without the phase guard the drain picks it again on the
    /// next tick, and a failed spawn is retried forever.
    #[test]
    fn a_task_already_being_spawned_is_not_a_candidate() {
        let conn = db();
        queued(&conn, 1, "High", "2026-01-01");
        crate::task::transition::claim_for_execution(
            &conn,
            1,
            &[crate::models::TaskStatus::Queue],
        )
        .unwrap()
        .expect("claim");

        assert!(queue_candidates(&conn, 1, true).unwrap().is_empty());
    }
}
