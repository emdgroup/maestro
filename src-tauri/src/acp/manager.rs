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
