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
    let mut first: Option<String> = None;
    let mut upstream: Option<String> = None;

    for line in remote_v_output.lines() {
        let mut parts = line.split_whitespace();
        let (Some(name), Some(url)) = (parts.next(), parts.next()) else { continue };
        match name {
            "origin" => return Some(url.to_string()),
            "upstream" if upstream.is_none() => upstream = Some(url.to_string()),
            _ => {}
        }
        if first.is_none() {
            first = Some(url.to_string());
        }
    }

    upstream.or(first)
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
}
