//! ACP session manager — re-exports split across sub-modules.
//! External callers that use `crate::acp::manager::*` paths continue to work via these re-exports.

/// maestro-server is a separate process that reports its own severity as a string, so map it onto
/// the host's levels rather than flattening every diagnostic to one line — an error there would
/// otherwise be invisible at the default filter.
pub(crate) fn log_server_diagnostic(level: &str, message: &str) {
    match level {
        "error" => log::error!("[maestro-server] {message}"),
        "warn" => log::warn!("[maestro-server] {message}"),
        _ => log::info!("[maestro-server] {message}"),
    }
}

// Re-exports for callers that reference crate::acp::manager::* directly.
pub use crate::acp::session_ops::upsert_session_alias;
pub use crate::acp::connection_server::{
    query_detect_project_agents_via_server,
    query_detect_installed_via_server,
};
