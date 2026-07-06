//! ACP session manager — re-exports split across sub-modules.
//! External callers that use `crate::acp::manager::*` paths continue to work via these re-exports.

pub(crate) fn append_debug_log(msg: &str) {
    eprintln!("{msg}");
}

// Re-exports for callers that reference crate::acp::manager::* directly.
pub use crate::acp::session_ops::upsert_session_alias;
pub use crate::acp::connection_server::{
    query_detect_project_agents_via_server,
    query_detect_installed_via_server,
};
pub use crate::acp::canvas::prepend_preamble;
