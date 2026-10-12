//! What a conversation's turns used, as the connection's server recorded them.

use serde::{Deserialize, Serialize};
use specta::Type;
use std::sync::Arc;
use tauri::State;

use crate::acp::connection_server::{query_via_server, reply};
use crate::acp::transport::{ServerRequest, ServerResponse};
use crate::acp::ConnectionKey;
use crate::core::AppState;

/// One recorded turn. The token counts are `None` when the agent reported none for it.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct UsageTurn {
    pub model_id: Option<String>,
    /// RFC 3339.
    pub started_at: String,
    pub ended_at: String,
    pub total_tokens: Option<u64>,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub thought_tokens: Option<u64>,
    pub cached_read_tokens: Option<u64>,
    pub cached_write_tokens: Option<u64>,
}

impl From<maestro_protocol::UsageTurn> for UsageTurn {
    fn from(turn: maestro_protocol::UsageTurn) -> Self {
        let usage = turn.usage.as_ref();
        Self {
            model_id: turn.model_id,
            started_at: turn.started_at,
            ended_at: turn.ended_at,
            total_tokens: usage.map(|u| u.total_tokens),
            input_tokens: usage.map(|u| u.input_tokens),
            output_tokens: usage.map(|u| u.output_tokens),
            thought_tokens: usage.and_then(|u| u.thought_tokens),
            cached_read_tokens: usage.and_then(|u| u.cached_read_tokens),
            cached_write_tokens: usage.and_then(|u| u.cached_write_tokens),
        }
    }
}

/// A conversation's recorded turns, oldest first, across every load of it.
#[tauri::command]
#[specta::specta]
pub async fn get_session_usage(
    app_state: State<'_, Arc<AppState>>,
    connection: ConnectionKey,
    agent_id: String,
    acp_session_id: String,
) -> Result<Vec<UsageTurn>, String> {
    let response = query_via_server(
        connection,
        &app_state,
        &format!("No connection server for connection {:?}", connection),
        ServerRequest::SessionUsage(maestro_protocol::SessionUsageRequest {
            agent_id,
            acp_session_id,
        }),
        reply!(ServerResponse::SessionUsageOk(response) => response),
        15,
        "The connection's server did not answer within 15s",
    )
    .await?;
    Ok(response.turns.into_iter().map(Into::into).collect())
}
