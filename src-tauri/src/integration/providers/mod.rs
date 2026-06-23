pub mod github;
pub mod gitlab;
pub mod forgejo;
pub mod gitea;
pub mod linear;
pub mod jira_cloud;
pub mod azure_devops;
pub mod bitbucket;

// ponytail: heuristic — scoped labels like "kind/bug", "type/feature" are the Forgejo/Gitea
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

pub(crate) fn build_http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))
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
