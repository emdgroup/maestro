pub mod azure_devops;
pub mod forgejo;
pub mod gitea;
pub mod github;
pub mod gitlab;
pub mod jira_cloud;
pub mod linear;

// Heuristic — scoped labels like "kind/bug", "type/feature" are the Forgejo/Gitea
// convention for exclusive classification; extract the suffix as the display type
pub(super) fn extract_type_from_labels(labels: &[String]) -> Option<String> {
    const SCOPES: &[&str] = &["kind/", "type/", "category/"];
    labels.iter().find_map(|label| {
        let lower = label.to_lowercase();
        SCOPES.iter().find_map(|scope| {
            lower.strip_prefix(scope).map(|val| {
                let mut chars = val.chars();
                chars
                    .next()
                    .map(|c| c.to_uppercase().collect::<String>() + chars.as_str())
                    .unwrap_or_default()
            })
        })
    })
}

/// The process-wide HTTP client every provider call goes through.
///
/// One client rather than one per request, because a `reqwest::Client` owns the connection pool
/// and the TLS configuration: building one per call threw both away and paid a fresh handshake
/// every time. That cost fell hardest on `reconcile_pull_requests`, which asks the same forge
/// about every open pull request on a three-minute timer.
///
/// Cloning is how `reqwest` is meant to be shared — the clone is an `Arc` bump onto the same pool,
/// not a second client.
///
/// The build failure is cached alongside the success. It depends only on the TLS backend being
/// available, so a second attempt would fail identically, and retrying per request would mean
/// re-running that failure a few hundred times an hour to reach the same answer.
pub(crate) fn http_client() -> Result<reqwest::Client, String> {
    static CLIENT: std::sync::OnceLock<Result<reqwest::Client, String>> =
        std::sync::OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(15))
                .build()
                .map_err(|e| format!("Failed to build HTTP client: {}", e))
        })
        .clone()
}

/// Strip trailing slashes and ensure the URL has an https:// scheme.
/// If the user explicitly provides http://, that is preserved.
pub(crate) fn normalize_instance_url(url: &str) -> String {
    let trimmed = url.trim_end_matches('/');
    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        trimmed.to_string()
    } else {
        format!("https://{}", trimmed)
    }
}
