use crate::models::ticketing::{ForgejoConfig, ProviderConfig, RemoteIssue, TicketingConfig};
use crate::models::project_config::now_rfc3339;
use crate::ticketing::token_manager::StoredToken;

#[derive(serde::Deserialize)]
struct ForgejoUserResponse {
    login: String,
}

#[derive(serde::Deserialize)]
struct ForgejoIssueResponse {
    number: u64,
    title: String,
    body: Option<String>,
    html_url: String,
    labels: Vec<ForgejoLabel>,
    updated_at: Option<String>,
}

#[derive(serde::Deserialize)]
struct ForgejoLabel {
    name: String,
}

/// Strip trailing slashes and ensure the URL has an https:// scheme.
/// If the user explicitly provides http://, that is preserved.
pub fn normalize_instance_url(url: &str) -> String {
    let trimmed = url.trim_end_matches('/');
    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        trimmed.to_string()
    } else {
        format!("https://{}", trimmed)
    }
}

/// Validate a Forgejo API token, save the TicketingConfig, and store the token.
/// Returns the authenticated Forgejo login name on success.
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

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))?;

    let response = client
        .get(format!("{}/api/v1/user", base))
        .header("Authorization", format!("token {}", token))
        .send()
        .await
        .map_err(|e| format!("Network error: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        return Err(format!(
            "Forgejo API error {}: {}",
            status.as_u16(),
            status.canonical_reason().unwrap_or("Unknown")
        ));
    }

    let user: ForgejoUserResponse = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse Forgejo user response: {}", e))?;

    let config = TicketingConfig {
        provider: Some(ProviderConfig::Forgejo(ForgejoConfig {
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
        provider: "forgejo".to_string(),
    };
    app_state.token_manager.store_token(
        project_id,
        stored_token,
        &app_state.app_data_dir,
        &app_state.app_handle,
    )?;

    Ok(user.login)
}

/// Fetch open issues (excluding PRs, filtered server-side) from a Forgejo repository.
pub async fn fetch_issues(
    instance_url: &str,
    owner: &str,
    repo: &str,
    token: &str,
) -> Result<Vec<RemoteIssue>, String> {
    let base = normalize_instance_url(instance_url);

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))?;

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
            "Forgejo API error {}: {}",
            status.as_u16(),
            status.canonical_reason().unwrap_or("Unknown")
        ));
    }

    let issues: Vec<ForgejoIssueResponse> = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse Forgejo issues response: {}", e))?;

    let remote_issues = issues
        .into_iter()
        .map(|issue| RemoteIssue {
            external_id: format!("forgejo:{}", issue.number),
            title: issue.title,
            body: issue.body,
            url: issue.html_url,
            labels: issue.labels.into_iter().map(|l| l.name).collect(),
            updated_at: issue.updated_at,
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
            normalize_instance_url("https://codeberg.org/"),
            "https://codeberg.org"
        );
    }

    #[test]
    fn test_normalize_instance_url_adds_https_when_scheme_absent() {
        assert_eq!(
            normalize_instance_url("forgejo.myco.com"),
            "https://forgejo.myco.com"
        );
    }

    #[test]
    fn test_normalize_instance_url_preserves_existing_https() {
        assert_eq!(
            normalize_instance_url("https://codeberg.org"),
            "https://codeberg.org"
        );
    }

    #[test]
    fn test_forgejo_external_id_format() {
        let number: u64 = 42;
        assert_eq!(format!("forgejo:{}", number), "forgejo:42");
    }

    #[test]
    fn test_forgejo_issue_deserialization() {
        let json = r#"{"number":42,"title":"Feature request","body":"Some description","html_url":"https://codeberg.org/a/b/issues/42","labels":[{"name":"enhancement"}],"updated_at":"2024-01-01T00:00:00Z"}"#;
        let issue: ForgejoIssueResponse = serde_json::from_str(json).unwrap();
        assert_eq!(issue.number, 42);
        assert_eq!(issue.labels[0].name, "enhancement");
    }

    #[test]
    fn test_forgejo_label_deserialization() {
        let json = r#"{"number":1,"title":"T","body":null,"html_url":"","labels":[{"name":"bug"},{"name":"good first issue"}],"updated_at":null}"#;
        let issue: ForgejoIssueResponse = serde_json::from_str(json).unwrap();
        assert_eq!(issue.labels.len(), 2);
        assert_eq!(issue.labels[0].name, "bug");
    }
}
