use std::sync::Arc;
use tauri::State;

use crate::acp::connection_server::reply;
use crate::acp::transport::{ServerRequest, ServerResponse};
use crate::acp::ConnectionKey;
use crate::core::AppState;

/// Count the agents currently occupying a slot on `connection`.
///
/// Filtered by connection because the limit is: the constraint is memory, and a machine's memory is
/// not spent by agents running somewhere else.
///
/// Only ACP sessions count. A task-associated terminal is a shell the user opened, not an agent,
/// and reserving an agent's worth of memory for one made the board report work that was not running.
///
/// A session parked in Review does count. That is deliberate back-pressure — it stops the farm
/// outrunning the reviewer — and it is also simply true of memory, which a parked agent still
/// holds. It is the reason the board has to show slot usage: a queue that has silently stopped
/// moving because three reviews are open looks identical to one that is broken.
async fn occupied_slots(app_state: &Arc<AppState>, connection: ConnectionKey) -> i32 {
    let acp = app_state.acp.sessions.lock().await;
    acp.values()
        .filter(|p| p.task_id.is_some() && p.connection_key == connection)
        .count() as i32
}

/// The connection a project runs on, and the limit in force there.
///
/// The host is measured only when the measurement is used. A `Hard` limit discards `available_mb` —
/// `resolve_capacity` returns the configured number whatever the third argument is — while measuring
/// means an exec over SSH for a remote host, and the badge asks this on every board event.
///
/// Reading the project row is unavoidable now that the limit is per connection, but it is a local
/// query; the round trip this ordering avoids is the memory probe, not the lookup.
async fn capacity_for_project(
    app_state: &Arc<AppState>,
    project_id: i32,
) -> Result<(ConnectionKey, crate::execution::capacity::HostCapacity), String> {
    use crate::execution::capacity::{available_memory_mb, resolve_capacity, ConcurrencyMode};

    let (connection, settings) = {
        let conn = app_state
            .db
            .lock()
            .map_err(|e| format!("Lock failed: {}", e))?;
        let connection = conn
            .query_row(
                "SELECT connection_id, wsl_connection_id, docker_connection_id FROM projects WHERE id = ?",
                [project_id],
                |row| {
                    Ok(ConnectionKey::from_all_ids(row.get(0)?, row.get(1)?, row.get(2)?))
                },
            )
            .map_err(|e| format!("Project {} not found: {}", project_id, e))?;
        let settings = crate::core::settings::load_connection_capacity(&conn, connection)?;
        (connection, settings)
    };

    if settings.concurrency_mode == ConcurrencyMode::Hard {
        return Ok((
            connection,
            resolve_capacity(
                settings.concurrency_mode,
                settings.max_concurrent_agents,
                None,
            ),
        ));
    }

    let available_mb = match crate::core::get_project_with_git_conn(app_state, project_id).await {
        Ok((_, git_conn)) => available_memory_mb(&git_conn).await,
        Err(_) => None,
    };
    Ok((
        connection,
        resolve_capacity(
            settings.concurrency_mode,
            settings.max_concurrent_agents,
            available_mb,
        ),
    ))
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
    let (connection, capacity) = capacity_for_project(&app_state, project_id).await?;

    let used = occupied_slots(&app_state, connection).await;

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
    let (connection, capacity) = capacity_for_project(&app_state, project_id).await?;

    let used = occupied_slots(&app_state, connection).await;

    if used < capacity.slots {
        return Ok(ExecuteDecision {
            verdict: ExecuteVerdict::Start,
            reason: capacity.reason,
        });
    }

    if capacity.mode == crate::execution::capacity::ConcurrencyMode::Auto {
        return Ok(ExecuteDecision {
            verdict: ExecuteVerdict::Warn,
            reason: capacity.reason,
        });
    }

    // Moves a Planning task to Queue and stamps `execute_requested_at` there, keeping an earlier
    // stamp so pressing Execute again reports the same deferral rather than losing its place.
    // `false` means the task moved between the button and here, so the caller is told to go
    // ahead and let the claim refuse it, which produces the right message.
    let deferred = crate::acp::connection_server::query_project_store(
        &app_state,
        project_id,
        |project_path| {
            ServerRequest::RequestTaskExecution(maestro_protocol::RequestTaskExecutionRequest {
                project_path,
                task_id,
            })
        },
        reply!(ServerResponse::RequestTaskExecutionOk(response) => response.deferred),
    )
    .await?;

    if !deferred {
        return Ok(ExecuteDecision {
            verdict: ExecuteVerdict::Start,
            reason: capacity.reason,
        });
    }

    Ok(ExecuteDecision {
        verdict: ExecuteVerdict::Deferred,
        reason: capacity.reason,
    })
}

/// Pick the tasks that should be started next on this project's host.
///
/// Returns ids for the frontend to run rather than starting anything itself: only Rust can decide
/// *which* tasks run, because the limit is per host and a host serves every project pointed at it,
/// but only the frontend can start one — spawning means a worktree, an ACP session and a prompt.
#[tauri::command]
#[specta::specta]
pub async fn drain_ready_queue(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    project_path: String,
) -> Result<Vec<i32>, String> {
    let _ = project_path; // reserved for future use

    // Auto-mode is still an application-wide switch: it says whether the scheduler may start
    // anything at all, which is about the user's way of working rather than about any one host.
    // Load it in a block so the sync MutexGuard drops before the async lock below.
    let auto_mode = {
        let conn = app_state
            .db
            .lock()
            .map_err(|e| format!("Lock failed: {}", e))?;
        crate::core::settings::load_settings(&conn)
            .map_err(|e| format!("Failed to load settings: {}", e))?
            .auto_mode
    };

    // Candidates before capacity, because measuring capacity means probing the host — an exec over
    // SSH for a remote one — and a drain fires on every board event. Asking a remote box how much
    // memory it has in order to schedule an empty queue is a cost paid for nothing.
    //
    // Without auto mode only deferred tasks come back: manual mode means "do not start what I did
    // not ask for", and a deferral is precisely something the user did ask for.
    let candidates = crate::acp::connection_server::query_project_store(
        &app_state,
        project_id,
        |project_path| {
            ServerRequest::ListQueueCandidates(maestro_protocol::ListQueueCandidatesRequest {
                project_path,
                include_undeferred: auto_mode,
            })
        },
        reply!(ServerResponse::ListQueueCandidatesOk(list) => list.task_ids),
    )
    .await?;

    // Whatever the user has their hands on is not the scheduler's to take. Applied after the query
    // rather than in it because a drag is a client-side fact with no row behind it.
    let candidates = app_state.task_holds.retain_unheld(candidates);

    if candidates.is_empty() {
        return Ok(vec![]);
    }

    // Sampled here rather than on a timer: a drain is called at exactly the moments the answer
    // could have changed — a session ending, a task arriving, the app starting.
    let (connection, capacity) = capacity_for_project(&app_state, project_id).await?;

    let running_count = occupied_slots(&app_state, connection).await;

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

    Ok(candidates
        .into_iter()
        .take(slots_available as usize)
        .collect())
}
