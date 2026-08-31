use std::sync::Arc;
use tauri::State;

use crate::core::AppState;

/// Shell-safe quoting for paths used in SSH commands.
/// Wraps in single quotes and escapes internal single quotes as '\'' (end quote, escaped quote, restart quote).
pub fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// A git remote URL split into the host that serves it and the path below it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedRemote {
    /// Lowercased hostname, no port, no `www.` prefix.
    pub host: String,
    /// Path with no leading/trailing slash and no `.git` suffix, e.g. `owner/repo`
    /// or a nested GitLab group path `group/subgroup/repo`.
    pub path: String,
}

/// Parse a git remote URL into host + path.
///
/// Covers the three forms git accepts for network remotes: scp-style
/// (`git@host:owner/repo.git`), a URL with a scheme (`ssh://`, `https://`, `git://`),
/// and either of those carrying a user or a port. Local paths return `None` — they
/// have no host to map to a provider.
pub fn parse_remote_url(url: &str) -> Option<ParsedRemote> {
    let url = url.trim();

    let (host_part, path) = match url.split_once("://") {
        Some((_scheme, rest)) => rest.split_once('/')?,
        // scp-style has no scheme: `[user@]host:path`. A colon before any slash
        // distinguishes it from a bare local path like `C:\repos\thing`, which has
        // no slash-separated path after the colon.
        None => {
            let (host_part, path) = url.split_once(':')?;
            if host_part.is_empty() || path.starts_with('/') || path.starts_with('\\') {
                return None;
            }
            (host_part, path)
        }
    };

    let host_part = host_part.rsplit_once('@').map_or(host_part, |(_user, host)| host);
    let host = host_part.split_once(':').map_or(host_part, |(host, _port)| host);
    let host = host.trim_start_matches("www.").to_ascii_lowercase();

    let path = path.trim_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    let path = path.trim_matches('/');

    if host.is_empty() || path.is_empty() {
        return None;
    }

    Some(ParsedRemote { host, path: path.to_string() })
}

/// Pick the URL of the most likely "upstream" remote out of `git remote -v` output,
/// preferring `origin`, then `upstream`, then whatever comes first.
pub fn pick_remote_url(remote_v_output: &str) -> Option<String> {
    pick_remote(remote_v_output).map(|(_name, url)| url)
}

/// A remote URL with any embedded credential removed, safe to show a user.
///
/// An HTTPS remote may carry one — `https://x-access-token:ghp_…@github.com/owner/repo` is what
/// `gh` writes — and anything shown in Settings ends up in screenshots attached to bug reports.
/// Only the `user[:password]@` segment of the authority goes; the scheme, host, port and path are
/// left exactly as git has them, so what the user sees still matches `git remote -v`.
///
/// scp-style `git@host:owner/repo` is untouched: its `git@` is the SSH login, not a secret, and
/// removing it would print a URL that does not work if copied.
pub fn redact_remote_url(url: &str) -> String {
    let url = url.trim();
    let Some((scheme, rest)) = url.split_once("://") else {
        return url.to_string();
    };
    // The credential is in the authority, which ends at the first `/`. Splitting on the last `@`
    // before that boundary keeps a password containing `@` from leaving part of itself behind.
    let (authority, path) = match rest.split_once('/') {
        Some((authority, path)) => (authority, Some(path)),
        None => (rest, None),
    };
    let Some((_credential, host)) = authority.rsplit_once('@') else {
        return url.to_string();
    };
    match path {
        Some(path) => format!("{}://{}/{}", scheme, host, path),
        None => format!("{}://{}", scheme, host),
    }
}

/// Every remote name in `git remote -v` output, deduped, in the order git printed them.
///
/// `git remote -v` lists each remote twice, once for fetch and once for push, so the dedup is
/// not defensive — it is the whole point.
pub fn remote_names(remote_v_output: &str) -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
    for line in remote_v_output.lines() {
        let Some(name) = line.split_whitespace().next() else { continue };
        if !names.iter().any(|seen| seen == name) {
            names.push(name.to_string());
        }
    }
    names
}

/// The URL of one named remote in `git remote -v` output, or `None` if the repository has no
/// remote by that name.
///
/// Needed because the remote a project pushes to is a setting, not a guess: [`pick_remote`]
/// answers "which one would we choose", and this answers "where does the chosen one point".
pub fn url_for_remote(remote_v_output: &str, name: &str) -> Option<String> {
    remote_v_output.lines().find_map(|line| {
        let mut parts = line.split_whitespace();
        match (parts.next(), parts.next()) {
            (Some(found), Some(url)) if found == name => Some(url.to_string()),
            _ => None,
        }
    })
}

/// As `pick_remote_url`, but also returns the remote's name — which is what `git push`
/// takes, and which is not recoverable from the URL.
pub fn pick_remote(remote_v_output: &str) -> Option<(String, String)> {
    let mut first: Option<(String, String)> = None;
    let mut upstream: Option<(String, String)> = None;

    for line in remote_v_output.lines() {
        let mut parts = line.split_whitespace();
        let (Some(name), Some(url)) = (parts.next(), parts.next()) else { continue };
        let entry = (name.to_string(), url.to_string());
        match name {
            "origin" => return Some(entry),
            "upstream" if upstream.is_none() => upstream = Some(entry.clone()),
            _ => {}
        }
        if first.is_none() {
            first = Some(entry);
        }
    }

    upstream.or(first)
}

/// The fallback when a project has no remote at all — every caller still needs a name to build a
/// ref from, and a ref that does not resolve is treated as absent rather than as an error.
pub const DEFAULT_REMOTE: &str = "origin";

/// The remote this project's branches live on: the configured `remote_name`, or [`pick_remote`]'s
/// guess, or [`DEFAULT_REMOTE`].
///
/// Cached on `AppState`, and that is not an optimisation. `list_worktrees_with_status` refetches
/// every ten seconds, and a miss here costs a `.maestro/settings.json` read plus a `git remote -v`
/// — an SFTP round trip and an SSH one for a remote project. `update_project_settings` drops the
/// entry after writing, so a changed setting applies without a restart.
pub async fn project_remote(app_state: &AppState, project_id: i32) -> String {
    if let Ok(cache) = app_state.project_remotes.lock() {
        if let Some(name) = cache.get(&project_id) {
            return name.clone();
        }
    }

    let resolved = resolve_project_remote(app_state, project_id).await;
    if let Ok(mut cache) = app_state.project_remotes.lock() {
        cache.insert(project_id, resolved.clone());
    }
    resolved
}

/// Forget the cached remote for a project, so the next [`project_remote`] re-reads its settings.
pub fn forget_project_remote(app_state: &AppState, project_id: i32) {
    if let Ok(mut cache) = app_state.project_remotes.lock() {
        cache.remove(&project_id);
    }
}

async fn resolve_project_remote(app_state: &AppState, project_id: i32) -> String {
    let Ok((project, git_conn)) = crate::core::get_project_with_git_conn(app_state, project_id).await
    else {
        return DEFAULT_REMOTE.to_string();
    };

    let config: crate::models::ProjectConfig = crate::core::project_storage::read_maestro_json(
        &git_conn,
        crate::project::settings::SETTINGS_FILE,
    )
    .await;
    if let Some(name) = config.remote_name.filter(|name| !name.trim().is_empty()) {
        return name;
    }

    match crate::git::run_git_in_dir_lossy(&git_conn, &project.path, &["remote", "-v"]).await {
        Ok(output) => pick_remote(&output)
            .map(|(name, _url)| name)
            .unwrap_or_else(|| DEFAULT_REMOTE.to_string()),
        Err(e) => {
            log::debug!("[git] `git remote -v` failed for project {project_id}: {e}");
            DEFAULT_REMOTE.to_string()
        }
    }
}

/// Every remote configured for the project, for the Settings picker.
///
/// An empty list is the honest answer for a repository with no remote, and for one git could not
/// be asked about — the picker offers only "Auto" in both cases.
#[tauri::command]
#[specta::specta]
pub async fn list_project_remotes(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
) -> Result<Vec<String>, String> {
    let (project, git_conn) =
        crate::core::get_project_with_git_conn(&app_state, project_id).await?;
    match crate::git::run_git_in_dir_lossy(&git_conn, &project.path, &["remote", "-v"]).await {
        Ok(output) => Ok(remote_names(&output)),
        Err(e) => {
            log::debug!("[git] listing remotes failed for project {project_id}: {e}");
            Ok(Vec::new())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parsed(url: &str) -> (String, String) {
        let remote = parse_remote_url(url).expect("should parse");
        (remote.host, remote.path)
    }

    #[test]
    fn parses_remote_url_forms() {
        assert_eq!(
            parsed("git@github.com:owner/repo.git"),
            ("github.com".into(), "owner/repo".into())
        );
        assert_eq!(
            parsed("https://github.com/owner/repo"),
            ("github.com".into(), "owner/repo".into())
        );
        assert_eq!(
            parsed("https://user@github.com/owner/repo.git"),
            ("github.com".into(), "owner/repo".into())
        );
        assert_eq!(
            parsed("ssh://git@git.example.com:2222/owner/repo.git"),
            ("git.example.com".into(), "owner/repo".into())
        );
        assert_eq!(
            parsed("git://github.com/owner/repo.git"),
            ("github.com".into(), "owner/repo".into())
        );
        assert_eq!(
            parsed("https://GitHub.com/Owner/Repo/"),
            ("github.com".into(), "Owner/Repo".into())
        );
        assert_eq!(
            parsed("https://gitlab.com/group/subgroup/repo.git"),
            ("gitlab.com".into(), "group/subgroup/repo".into())
        );
        assert_eq!(
            parsed("https://org@dev.azure.com/org/project/_git/repo"),
            ("dev.azure.com".into(), "org/project/_git/repo".into())
        );
        assert_eq!(
            parsed("git@ssh.dev.azure.com:v3/org/project/repo"),
            ("ssh.dev.azure.com".into(), "v3/org/project/repo".into())
        );
    }

    /// The settings page shows this URL, and a screenshot of it ends up on bug reports, so an
    /// embedded token must not survive the trip.
    /// The remote a project pushes to is a setting, so the lookup has to answer for the name it
    /// is given rather than for the one `pick_remote` would have preferred.
    #[test]
    fn url_for_remote_answers_for_the_name_it_is_given() {
        let output = "\
origin\thttps://github.com/me/repo.git (fetch)
origin\thttps://github.com/me/repo.git (push)
fork\tgit@github.com:someone/repo.git (fetch)
fork\tgit@github.com:someone/repo.git (push)
";
        assert_eq!(
            url_for_remote(output, "fork").as_deref(),
            Some("git@github.com:someone/repo.git")
        );
        assert_eq!(
            url_for_remote(output, "origin").as_deref(),
            Some("https://github.com/me/repo.git")
        );
        // A remote the repository does not have, which is what a stale setting looks like.
        assert_eq!(url_for_remote(output, "upstream"), None);
        assert_eq!(url_for_remote("", "origin"), None);
    }

    #[test]
    fn redaction_removes_an_embedded_credential() {
        assert_eq!(
            redact_remote_url("https://x-access-token:ghp_secret@github.com/owner/repo.git"),
            "https://github.com/owner/repo.git"
        );
        assert_eq!(
            redact_remote_url("https://user@github.com/owner/repo"),
            "https://github.com/owner/repo"
        );
        // A password containing `@` must not leave its tail behind.
        assert_eq!(
            redact_remote_url("https://user:p@ss@gitlab.com/group/repo.git"),
            "https://gitlab.com/group/repo.git"
        );
        assert_eq!(redact_remote_url("ssh://git@git.example.com:2222/owner/repo.git"), "ssh://git.example.com:2222/owner/repo.git");
    }

    /// A URL with nothing to hide has to come back byte for byte, or what Settings shows stops
    /// matching what `git remote -v` prints.
    #[test]
    fn redaction_leaves_everything_else_alone() {
        for url in [
            "https://github.com/owner/repo.git",
            // scp-style: the `git@` is the SSH login, and dropping it would print a URL that
            // does not work if copied.
            "git@github.com:owner/repo.git",
            "git@ssh.dev.azure.com:v3/org/project/repo",
            "git://github.com/owner/repo.git",
            "/srv/git/repo.git",
            "",
        ] {
            assert_eq!(redact_remote_url(url), url);
        }
    }

    #[test]
    fn rejects_urls_without_a_host_and_path() {
        assert_eq!(parse_remote_url(""), None);
        assert_eq!(parse_remote_url("../sibling-repo"), None);
        assert_eq!(parse_remote_url("/srv/git/repo.git"), None);
        assert_eq!(parse_remote_url("C:\\repos\\thing"), None);
        assert_eq!(parse_remote_url("git@github.com:"), None);
        assert_eq!(parse_remote_url("https://github.com/"), None);
    }

    #[test]
    fn picks_origin_then_upstream_then_first() {
        let output = "\
upstream\thttps://github.com/upstream/repo.git (fetch)
upstream\thttps://github.com/upstream/repo.git (push)
origin\tgit@github.com:me/repo.git (fetch)
origin\tgit@github.com:me/repo.git (push)
";
        assert_eq!(pick_remote_url(output).as_deref(), Some("git@github.com:me/repo.git"));

        let no_origin = "\
upstream\thttps://github.com/upstream/repo.git (fetch)
fork\thttps://github.com/fork/repo.git (fetch)
";
        assert_eq!(
            pick_remote_url(no_origin).as_deref(),
            Some("https://github.com/upstream/repo.git")
        );

        let neither = "fork\thttps://github.com/fork/repo.git (fetch)\n";
        assert_eq!(pick_remote_url(neither).as_deref(), Some("https://github.com/fork/repo.git"));

        assert_eq!(pick_remote_url(""), None);
    }

    #[test]
    fn pick_remote_reports_the_name_alongside_the_url() {
        let output = "\
upstream\thttps://github.com/upstream/repo.git (fetch)
fork\thttps://github.com/fork/repo.git (fetch)
";
        assert_eq!(
            pick_remote(output),
            Some(("upstream".into(), "https://github.com/upstream/repo.git".into()))
        );
    }

    /// `git remote -v` prints each remote twice, once for fetch and once for push, so the picker
    /// would otherwise offer every name as a duplicate pair.
    #[test]
    fn remote_names_are_listed_once_each_in_git_order() {
        let output = "\
origin\tgit@github.com:me/repo.git (fetch)
origin\tgit@github.com:me/repo.git (push)
fork\thttps://github.com/fork/repo.git (fetch)
fork\thttps://github.com/fork/repo.git (push)
";
        assert_eq!(remote_names(output), vec!["origin", "fork"]);
        assert!(remote_names("").is_empty());
    }
}
