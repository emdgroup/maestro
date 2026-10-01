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

/// The connection a project runs on, and the limit in force there, as its daemon measures it.
async fn capacity_for_project(
    app_state: &Arc<AppState>,
    project_id: i32,
) -> Result<(ConnectionKey, crate::execution::capacity::HostCapacity), String> {
    let (connection, _) = crate::project::automations::target(app_state, project_id).await?;
    let status = crate::acp::connection_server::query_project_store(
        app_state,
        project_id,
        |_| ServerRequest::GetCapacity,
        reply!(ServerResponse::GetCapacityOk(status) => status),
    )
    .await?;
    Ok((
        connection,
        crate::execution::capacity::HostCapacity {
            slots: status.slots,
            mode: status.settings.concurrency_mode.into(),
            reason: status.reason,
        },
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
