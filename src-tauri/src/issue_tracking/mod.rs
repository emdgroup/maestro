pub mod keychain;
pub mod token_manager;
pub mod github;
pub mod gitlab;
pub mod forgejo;
pub mod gitea;
pub mod linear;
pub mod jira_cloud;
pub mod azure_devops;
pub mod bitbucket;

pub use keychain::KeychainStore;
pub use token_manager::{StoredToken, TokenManager};

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
