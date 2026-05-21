pub mod keychain;
pub mod token_manager;
pub mod github;
pub mod gitlab;
pub mod forgejo;
pub mod linear;
pub mod jira_cloud;

pub use keychain::KeychainStore;
pub use token_manager::{StoredToken, TokenManager};

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
