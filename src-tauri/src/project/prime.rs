use crate::acp::ConnectionKey;
use crate::core::AppState;
use std::sync::Arc;
use tauri::State;

/// Pre-warm the shared maestro-server process for a project and optionally
/// pre-initialize the default agent so the first session spawn is near-instant.
///
/// The frontend should call this fire-and-forget after a successful `open_project`.
/// Failures are benign: a session spawn ensures the server itself.
#[tauri::command]
#[specta::specta]
pub async fn prime_project_server(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
) -> Result<(), String> {
    let (connection_key, project_path) = super::crud::target(&app_state, project_id).await?;

    crate::acp::discovery_handlers::ensure_connection_server(&app_state, connection_key).await?;
    // Remote discovery costs round trips the spawn dialog would otherwise sit waiting on. Local
    // discovery is cheap enough to leave to the dialog, and skipping it keeps opening fast.
    if connection_key != ConnectionKey::Local {
        if let Err(e) =
            crate::acp::discovery_handlers::prefetch_agent_discovery(&app_state, connection_key)
                .await
        {
            log::warn!("[prime] agent discovery on {connection_key:?} failed: {e}");
        }
    }

    // Before the sessions are attached, so the dormant rows the import writes are loaded with the
    // rest, and before the board is shown, which reads what the import writes.
    super::import::import_once(&app_state, project_id, &project_path, connection_key).await?;

    // A config that cannot be read is a project with no default agent, not a failed prime: the
    // session restore below is the more valuable half and must still happen.
    let config = super::settings::load_project_config_for(&app_state, project_id)
        .await
        .unwrap_or_default();
    if let Some(agent_id) = config.default_agent {
        crate::acp::connection_server::query_via_server_within(
            connection_key,
            &app_state,
            maestro_protocol::ServerRequest::PreInitialize(
                maestro_protocol::PreInitializeRequest {
                    agent_id,
                    cwd: project_path.clone(),
                },
            ),
            crate::acp::connection_server::reply!(
                maestro_protocol::ServerResponse::PreInitializeOk(response) => response
            ),
            60,
        )
        .await?;
    }

    crate::acp::session_ops::attach_project_sessions(connection_key, project_id, None, &app_state)
        .await;

    Ok(())
}
