use crate::core::AppState;
use crate::integration::keychain::{KeychainOutcome, KeychainStore};

pub mod atlassian;
pub mod forgejo_gitea;
pub mod github;
pub mod gitlab;
pub mod linear;

pub use atlassian::*;
pub use forgejo_gitea::*;
pub use github::*;
pub use gitlab::*;
pub use linear::*;

/// Paginated fetch for APIs returning a flat JSON array with page-based pagination.
/// Loops from page 1 until an empty response, appending `{limit_param}=N&{page_param}=N`
/// to `base_url` each iteration.
pub(crate) async fn fetch_all_pages<T: serde::de::DeserializeOwned>(
    client: &reqwest::Client,
    base_url: &str,
    headers: &[(&str, &str)],
    page_param: &str,
    limit_param: &str,
    limit_value: u32,
    provider_name: &str,
) -> Result<Vec<T>, String> {
    let mut all_items = Vec::new();
    let mut page = 1u32;
    let joiner = if base_url.contains('?') { '&' } else { '?' };

    loop {
        let url = format!(
            "{}{}{page_param}={page}&{limit_param}={limit_value}",
            base_url, joiner,
        );

        let mut request = client.get(&url);
        for &(name, value) in headers {
            request = request.header(name, value);
        }

        let response = request
            .send()
            .await
            .map_err(|e| format!("Network error: {}", e))?;

        if !response.status().is_success() {
            return Err(format!("{} API error {}", provider_name, response.status().as_u16()));
        }

        let items: Vec<T> = response
            .json()
            .await
            .map_err(|e| format!("Failed to parse {} response: {}", provider_name, e))?;

        if items.is_empty() {
            break;
        }
        all_items.extend(items);
        page += 1;
    }

    Ok(all_items)
}

pub(crate) async fn get_github_token(app_state: &AppState) -> Result<String, String> {
    match KeychainStore::get_integration("github", &app_state.app_data_dir)? {
        KeychainOutcome::Keychain(Some(creds)) | KeychainOutcome::FileFallback(Some(creds)) => {
            Ok(creds.token)
        }
        KeychainOutcome::Keychain(None) | KeychainOutcome::FileFallback(None) => {
            crate::integration::github::try_gh_cli_token()
                .await
                .ok_or_else(|| "No GitHub credentials found".to_string())
        }
    }
}
