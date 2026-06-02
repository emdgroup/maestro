use crate::models::issue_tracking::{BitbucketConfig, ProviderConfig, IssueTrackingConfig};
use crate::models::project::now_rfc3339;
use crate::issue_tracking::token_manager::StoredToken;
use super::normalize_instance_url;
use base64::Engine as _;

#[derive(serde::Deserialize)]
struct BitbucketCloudUser {
    display_name: String,
}

#[derive(serde::Deserialize)]
struct BitbucketServerUser {
    #[serde(rename = "displayName")]
    display_name: String,
}

#[derive(serde::Deserialize)]
struct BitbucketServerUsersResponse {
    values: Vec<BitbucketServerUser>,
}

fn make_basic_auth(email: &str, token: &str) -> String {
    let credentials = format!("{}:{}", email, token);
    format!("Basic {}", base64::engine::general_purpose::STANDARD.encode(credentials.as_bytes()))
}

/// Validate Bitbucket credentials and store the integration.
/// Returns the display name of the authenticated user.
/// - Cloud: instance_url is None, validates against api.bitbucket.org
/// - Server/Data Center: instance_url is Some, validates against the self-hosted instance
pub async fn validate_and_store(
    project_id: i32,
    instance_url: Option<&str>,
    workspace: &str,
    repo_slug: &str,
    email: &str,
    token: &str,
    project_root: &str,
    app_state: &crate::db::AppState,
) -> Result<String, String> {
    let client = super::build_http_client()?;

    let auth = make_basic_auth(email, token);

    let display_name = match instance_url {
        None => {
            let response = client
                .get("https://api.bitbucket.org/2.0/user")
                .header("Authorization", &auth)
                .send()
                .await
                .map_err(|e| format!("Network error: {}", e))?;

            if !response.status().is_success() {
                let status = response.status();
                return Err(format!(
                    "Bitbucket API error {}: {}",
                    status.as_u16(),
                    status.canonical_reason().unwrap_or("Unknown")
                ));
            }

            let user: BitbucketCloudUser = response
                .json()
                .await
                .map_err(|e| format!("Failed to parse Bitbucket user response: {}", e))?;

            user.display_name
        }
        Some(url) => {
            let base = normalize_instance_url(url);
            let response = client
                .get(format!("{}/rest/api/latest/users?limit=1", base))
                .header("Authorization", &auth)
                .send()
                .await
                .map_err(|e| format!("Network error: {}", e))?;

            if !response.status().is_success() {
                let status = response.status();
                return Err(format!(
                    "Bitbucket Server API error {}: {}",
                    status.as_u16(),
                    status.canonical_reason().unwrap_or("Unknown")
                ));
            }

            let users: BitbucketServerUsersResponse = response
                .json()
                .await
                .map_err(|e| format!("Failed to parse Bitbucket Server response: {}", e))?;

            users
                .values
                .into_iter()
                .next()
                .map(|u| u.display_name)
                .unwrap_or_else(|| email.to_string())
        }
    };

    let stored_instance_url = instance_url.map(|u| normalize_instance_url(u));

    let config = IssueTrackingConfig {
        provider: Some(ProviderConfig::Bitbucket(BitbucketConfig {
            instance_url: stored_instance_url,
            workspace: workspace.to_string(),
            repo_slug: repo_slug.to_string(),
        })),
        updated_at: now_rfc3339(),
    };
    config.save_to_project(project_root)?;

    let stored_token = StoredToken {
        access_token: token.to_string(),
        refresh_token: None,
        expires_at: None,
        provider: "bitbucket".to_string(),
    };
    app_state.token_manager.store_token(
        project_id,
        stored_token,
        &app_state.app_data_dir,
        &app_state.app_handle,
    )?;

    Ok(display_name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_make_basic_auth() {
        let auth = make_basic_auth("user@example.com", "mytoken");
        assert!(auth.starts_with("Basic "));
        let decoded = String::from_utf8(
            base64::engine::general_purpose::STANDARD
                .decode(&auth["Basic ".len()..])
                .unwrap(),
        )
        .unwrap();
        assert_eq!(decoded, "user@example.com:mytoken");
    }
}
