use std::sync::Arc;
use tauri::State;

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

/// Drain the Queue column for auto-mode execution
///
/// Checks if auto_mode is enabled in settings. If so, counts currently running
/// ACP executions for the project and returns task IDs that should be started next,
/// up to max_concurrent_agents. Tasks are ordered by priority (Urgent, High,
/// Medium, Low) then creation date.
///
/// Task-associated user shells also consume a concurrency slot, but queue draining does not
/// start agents through PTY. ACP is the sole managed agent execution path.
///
/// # Arguments
/// * `app_state` - Tauri app state with database connection
/// * `project_id` - Project to drain the queue for
/// * `project_path` - Repository path (reserved for future use)
///
/// # Returns
/// Vec of task_ids that should be started through ACP by the frontend.
/// Returns empty vec if auto_mode is disabled or concurrency limit is already reached.
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

    if !settings.auto_mode {
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

    let conn = app_state.db.lock().map_err(|e| format!("Lock failed: {}", e))?;

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

    // Get Queue tasks ordered by priority then created_at
    // Priority order: Urgent=0, High=1, Medium=2, Low=3
    //
    // `phase IS NULL` is what keeps the drain idempotent. A claimed task keeps its column until
    // its session is up, so without this a task already being spawned is picked again on the next
    // tick — and a task whose spawn failed, which sits at `Spawning`/`Failed`, is retried forever.
    // Both of those are the same query returning a task that is not actually waiting.
    let mut stmt = conn.prepare(
        "SELECT id FROM tasks
         WHERE project_id = ? AND status = 'Queue' AND phase IS NULL
         ORDER BY CASE priority
             WHEN 'Urgent' THEN 0
             WHEN 'High' THEN 1
             WHEN 'Medium' THEN 2
             WHEN 'Low' THEN 3
             ELSE 4
         END ASC, created_at ASC
         LIMIT ?"
    ).map_err(|e| format!("Failed to prepare query: {}", e))?;

    let task_ids: Vec<i32> = stmt.query_map(
        rusqlite::params![project_id, slots_available],
        |row| row.get(0),
    ).map_err(|e| format!("Failed to query ready tasks: {}", e))?
    .filter_map(|r| r.ok())
    .collect();

    Ok(task_ids)
}
