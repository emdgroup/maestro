//! The one name a project is filed under in the daemon's stores.

/// The name a project is filed under, resolved on the machine the path exists on.
///
/// Falls back to tidying the given path when it does not resolve, so a project on a disconnected
/// drive still matches the rows it wrote: being unable to reach a directory is not a reason to
/// forget the automations pointing at it.
pub fn canonical_project_path(path: &str) -> String {
    let resolved = std::fs::canonicalize(path)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| path.to_string());
    maestro_protocol::paths::tidy_path(&resolved)
}
