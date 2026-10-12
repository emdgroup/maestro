use std::sync::Arc;
use tauri::State;

use crate::acp::connection_server::{query_via_server, reply};
use crate::acp::transport::{ServerRequest, ServerResponse};
use crate::acp::ConnectionKey;
use crate::core::AppState;
use crate::usage::mirror;

const TIMEOUT_SECS: u64 = 30;

async fn turns_after(
    app_state: &AppState,
    connection: ConnectionKey,
    after_turn_id: i64,
) -> Result<maestro_protocol::UsageTurnsResponse, String> {
    query_via_server(
        connection,
        app_state,
        &format!("No connection server for connection {:?}", connection),
        ServerRequest::UsageTurns(maestro_protocol::UsageTurnsRequest { after_turn_id }),
        reply!(ServerResponse::UsageTurnsOk(page) => page),
        TIMEOUT_SECS,
        "The connection's server did not answer within 30s",
    )
    .await
}

async fn hours_after(
    app_state: &AppState,
    connection: ConnectionKey,
    after_hour: String,
) -> Result<maestro_protocol::UsageHoursResponse, String> {
    query_via_server(
        connection,
        app_state,
        &format!("No connection server for connection {:?}", connection),
        ServerRequest::UsageHours(maestro_protocol::UsageHoursRequest { after_hour }),
        reply!(ServerResponse::UsageHoursOk(page) => page),
        TIMEOUT_SECS,
        "The connection's server did not answer within 30s",
    )
    .await
}

fn with_db<T>(
    app_state: &AppState,
    f: impl FnOnce(&rusqlite::Connection) -> rusqlite::Result<T>,
) -> Result<T, String> {
    let conn = app_state
        .db
        .lock()
        .map_err(|e| format!("Lock failed: {}", e))?;
    f(&conn).map_err(|e| format!("Usage mirror: {e}"))
}

/// Bring the app's copy of a connection's usage up to date. Like Home's summary, this never starts
/// a relay: a connection Home has not attached to answers "No connection server".
#[tauri::command]
#[specta::specta]
pub async fn sync_usage(
    app_state: State<'_, Arc<AppState>>,
    connection: ConnectionKey,
) -> Result<(), String> {
    // A cursor past every turn: the answer is only the store's id and how far it has merged.
    let probe = turns_after(&app_state, connection, i64::MAX).await?;
    let store_id = probe.store_id;
    let mut store = with_db(&app_state, |conn| {
        let name = mirror::connection_name(conn, connection)?;
        mirror::adopt_store(
            conn,
            &store_id,
            &mirror::connection_key_id(connection),
            &name,
        )
    })?;

    if store.needs_full_sync(probe.merged_through_id) {
        with_db(&app_state, |conn| mirror::reset_store(conn, &store_id))?;
        let mut after_hour = String::new();
        loop {
            let page = hours_after(&app_state, connection, after_hour).await?;
            if page.store_id != store_id {
                return Err("The connection's usage store changed during the sync".to_string());
            }
            with_db(&app_state, |conn| {
                mirror::save_hours(conn, &store_id, &page)
            })?;
            match page.hours.last() {
                Some(last) if page.more => after_hour = last.hour.clone(),
                _ => break,
            }
        }
        with_db(&app_state, |conn| {
            mirror::finish_hours(conn, &store_id, probe.merged_through_id)
        })?;
        store.last_turn_id = 0;
        store.merged_through_id = probe.merged_through_id;
    }

    let mut after = store.last_turn_id;
    loop {
        let page = turns_after(&app_state, connection, after).await?;
        if page.store_id != store_id {
            return Err("The connection's usage store changed during the sync".to_string());
        }
        // Merged while we were paging: the next sync starts over.
        if page.merged_through_id > after.max(store.merged_through_id) {
            with_db(&app_state, |conn| mirror::reset_store(conn, &store_id))?;
            return Err(
                "The connection merged usage mid-sync; it syncs again next time".to_string(),
            );
        }
        let now = chrono::Utc::now();
        with_db(&app_state, |conn| {
            mirror::save_turns(conn, &store_id, &page, now)
        })?;
        match page.turns.last() {
            Some(last) if page.more => after = last.id,
            _ => break,
        }
    }

    with_db(&app_state, |conn| {
        mirror::merge_old_daily(conn, chrono::Utc::now())
    })
}
