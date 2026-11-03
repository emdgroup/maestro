//! Paths as strings: the app and the daemon match projects, worktrees and session directories by
//! comparing paths that were written down on different machines and at different times, so the
//! tidying they do before comparing has to be the same on both sides. Nothing here touches the
//! filesystem; resolving a path stays with whoever is on the machine it exists on.

/// `path` without the verbatim prefix Windows' `canonicalize` adds, which no other part of Maestro
/// ever shows or stores. A share comes back as `\\?\UNC\server\share`, whose plain spelling is
/// `\\server\share`.
pub fn strip_verbatim(path: &str) -> String {
    match path.strip_prefix(r"\\?\UNC\") {
        Some(share) => format!(r"\\{share}"),
        None => path.strip_prefix(r"\\?\").unwrap_or(path).to_string(),
    }
}

/// `path` as Maestro stores and compares it: no verbatim prefix, forward slashes, and no trailing
/// slash, except that a root keeps its own.
pub fn tidy_path(path: &str) -> String {
    let path = strip_verbatim(path).replace('\\', "/");
    let trimmed = path.trim_end_matches('/');
    if trimmed.is_empty() {
        path
    } else {
        trimmed.to_string()
    }
}

/// True when `path` is `root` or a directory inside it.
///
/// Compared as strings, so the paths of deleted worktrees still match. Separators and trailing
/// slashes do not matter, and on a Windows host neither does case: a local path there can come
/// back in the case it has on disk rather than the case it was opened with. That makes the answer
/// "yes" more often, which is the safe side for every caller: a worktree some session is within is
/// kept rather than removed.
pub fn path_is_within(path: &str, root: &str) -> bool {
    let fold = |path: &str| {
        let path = tidy_path(path);
        if cfg!(windows) {
            path.to_lowercase()
        } else {
            path
        }
    };
    let (path, root) = (fold(path), fold(root));
    match path.strip_prefix(&root) {
        // `…/maestro` must not swallow `…/maestro-server`.
        Some(rest) => rest.is_empty() || rest.starts_with('/') || root.ends_with('/'),
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_verbatim_share_keeps_its_two_slashes() {
        assert_eq!(
            strip_verbatim(r"\\?\UNC\server\share\p"),
            r"\\server\share\p"
        );
        assert_eq!(strip_verbatim(r"\\?\C:\p"), r"C:\p");
        assert_eq!(strip_verbatim("/home/p"), "/home/p");
    }

    /// The app's `match_project_path` used to strip only `\\?\`, so a project on a share tidied to
    /// `UNC/server/share` there and to `//server/share` in the daemon, and never matched.
    #[test]
    fn a_path_is_tidied_the_same_way_whatever_spelling_it_arrives_in() {
        assert_eq!(tidy_path(r"\\?\UNC\server\share\p\"), "//server/share/p");
        assert_eq!(tidy_path(r"\\?\C:\Users\me\proj\"), "C:/Users/me/proj");
        assert_eq!(tidy_path("/home/me/proj///"), "/home/me/proj");
        assert_eq!(tidy_path("/"), "/");
    }

    #[test]
    fn a_path_is_within_itself_and_its_children_only() {
        let root = "/repo/.maestro/worktrees/session-3";
        assert!(path_is_within(root, root));
        assert!(path_is_within("/repo/.maestro/worktrees/session-3/", root));
        assert!(path_is_within(
            "/repo/.maestro/worktrees/session-3/src",
            root
        ));
        // A prefix that is not a path boundary is a different worktree, not a child.
        assert!(!path_is_within("/repo/.maestro/worktrees/session-30", root));
        assert!(!path_is_within("/repo", root));
        assert!(path_is_within("/home", "/"));
    }

    /// The app's copy compared separators as written, so a session whose directory came back with
    /// backslashes was not within its worktree, and the worktree could be swept from under it.
    #[test]
    fn mixed_separators_match() {
        assert!(path_is_within(
            r"C:\Users\me\maestro\src",
            "C:/Users/me/maestro"
        ));
        assert!(path_is_within(
            r"C:\Users\me\maestro\.maestro\worktrees\session-100",
            r"C:\Users\me\maestro\"
        ));
        assert!(!path_is_within(
            r"C:\Users\me\maestro-server",
            r"C:\Users\me\maestro"
        ));
    }

    /// The other place the copies differed: the app's was case-sensitive on Windows too.
    #[test]
    #[cfg(windows)]
    fn case_does_not_matter_on_windows() {
        assert!(path_is_within(
            r"c:\users\me\Maestro\src-tauri",
            r"C:\Users\me\maestro"
        ));
    }

    #[test]
    #[cfg(not(windows))]
    fn case_matters_elsewhere() {
        assert!(!path_is_within("/srv/Shop/src", "/srv/shop"));
    }
}
