use crate::models::issue_tracking::{GiteaConfig, ProviderConfig, RemoteIssue, IssueTrackingConfig};
use crate::models::project::now_rfc3339;
use crate::issue_tracking::token_manager::StoredToken;

#[derive(serde::Deserialize)]
struct GiteaUserResponse {
    login: String,
}

#[derive(serde::Deserialize)]
struct GiteaIssueResponse {
    number: u64,
    title: String,
    body: Option<String>,
    html_url: String,
    labels: Vec<GiteaLabel>,
    updated_at: Option<String>,
}

#[derive(serde::Deserialize)]
struct GiteaLabel {
    name: String,
}

use super::normalize_instance_url;

/// Validate a Gitea API token, save the IssueTrackingConfig, and store the token.
/// Returns the authenticated Gitea login name on success.
pub async fn validate_and_store(
    project_id: i32,
    instance_url: &str,
    owner: &str,
    repo: &str,
    token: &str,
    project_root: &str,
    app_state: &crate::db::AppState,
) -> Result<String, String> {
    let base = normalize_instance_url(instance_url);

    let client = super::build_http_client()?;

    let response = client
        .get(format!("{}/api/v1/user", base))
        .header("Authorization", format!("token {}", token))
        .send()
        .await
        .map_err(|e| format!("Network error: {}", e))?;

    if response.status().as_u16() == 401 {
        return Err("Gitea: invalid or expired token".to_string());
    }
    if response.status().as_u16() == 403 {
        return Err(
            "Gitea: token is valid but missing the required 'read:user' scope. \
             Regenerate your token with 'read:user' permission enabled."
                .to_string(),
        );
    }
    if !response.status().is_success() {
        let status = response.status();
        return Err(format!(
            "Gitea API error {}: {}",
            status.as_u16(),
            status.canonical_reason().unwrap_or("Unknown")
        ));
    }

    let user: GiteaUserResponse = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse Gitea user response: {}", e))?;

    let config = IssueTrackingConfig {
        provider: Some(ProviderConfig::Gitea(GiteaConfig {
            instance_url: base,
            owner: owner.to_string(),
            repo: repo.to_string(),
        })),
        updated_at: now_rfc3339(),
    };
    config.save_to_project(project_root)?;

    let stored_token = StoredToken {
        access_token: token.to_string(),
        refresh_token: None,
        expires_at: None,
        provider: "gitea".to_string(),
    };
    app_state.token_manager.store_token(
        project_id,
        stored_token,
        &app_state.app_data_dir,
        &app_state.app_handle,
    )?;

    Ok(user.login)
}

/// Fetch open issues (excluding PRs, filtered server-side) from a Gitea repository.
pub async fn fetch_issues(
    instance_url: &str,
    owner: &str,
    repo: &str,
    token: &str,
) -> Result<Vec<RemoteIssue>, String> {
    let base = normalize_instance_url(instance_url);

    let client = super::build_http_client()?;

    let url = format!(
        "{}/api/v1/repos/{}/{}/issues?state=open&type=issues&limit=50",
        base,
        urlencoding::encode(owner),
        urlencoding::encode(repo),
    );

    let response = client
        .get(&url)
        .header("Authorization", format!("token {}", token))
        .send()
        .await
        .map_err(|e| format!("Network error: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        return Err(format!(
            "Gitea API error {}: {}",
            status.as_u16(),
            status.canonical_reason().unwrap_or("Unknown")
        ));
    }

    let issues: Vec<GiteaIssueResponse> = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse Gitea issues response: {}", e))?;

    let remote_issues = issues
        .into_iter()
        .map(|issue| RemoteIssue {
            external_id: format!("gitea:{}", issue.number),
            title: issue.title,
            body: issue.body,
            url: issue.html_url,
            labels: issue.labels.into_iter().map(|l| l.name).collect(),
            updated_at: issue.updated_at,
            priority: None,
        })
        .collect();

    Ok(remote_issues)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_normalize_instance_url_strips_trailing_slash() {
        assert_eq!(
            normalize_instance_url("https://gitea.example.com/"),
            "https://gitea.example.com"
        );
    }

    #[test]
    fn test_normalize_instance_url_adds_https_when_scheme_absent() {
        assert_eq!(
            normalize_instance_url("gitea.myco.com"),
            "https://gitea.myco.com"
        );
    }

    #[test]
    fn test_gitea_external_id_format() {
        let number: u64 = 42;
        assert_eq!(format!("gitea:{}", number), "gitea:42");
    }

    #[test]
    fn test_gitea_issue_deserialization() {
        let json = r#"{"number":42,"title":"Feature request","body":"Some description","html_url":"https://gitea.example.com/a/b/issues/42","labels":[{"name":"enhancement"}],"updated_at":"2024-01-01T00:00:00Z"}"#;
        let issue: GiteaIssueResponse = serde_json::from_str(json).unwrap();
        assert_eq!(issue.number, 42);
        assert_eq!(issue.labels[0].name, "enhancement");
    }
}
