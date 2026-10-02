use std::sync::Arc;
use tauri::State;

use crate::acp::connection_server::reply;
use crate::acp::transport::{ServerRequest, ServerResponse};
use crate::core::AppState;

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
    // The daemon counts what its limit is checked against, which no window can see whole: the
    // task sessions of every app attached to it, and the starts still coming up.
    let status = crate::acp::connection_server::query_project_store(
        &app_state,
        project_id,
        |_| ServerRequest::GetCapacity,
        reply!(ServerResponse::GetCapacityOk(status) => status),
    )
    .await?;
    Ok(QueueCapacity {
        slots: status.slots,
        used: status.used as i32,
        mode: status.settings.concurrency_mode.into(),
        reason: status.reason,
    })
}
