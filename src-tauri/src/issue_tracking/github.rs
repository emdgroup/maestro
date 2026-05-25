use tokio::process::Command as TokioCommand;
use crate::models::issue_tracking::{GitHubConfig, ProviderConfig, RemoteIssue, IssueTrackingConfig};
use crate::models::project_config::now_rfc3339;
use crate::issue_tracking::token_manager::StoredToken;

#[derive(serde::Deserialize)]
struct GitHubUserResponse {
    login: String,
}

#[derive(serde::Deserialize)]
struct GitHubIssueResponse {
    number: u64,
    title: String,
    body: Option<String>,
    html_url: String,
    labels: Vec<GitHubLabel>,
    updated_at: Option<String>,
    pull_request: Option<serde_json::Value>,
}

#[derive(serde::Deserialize)]
struct GitHubLabel {
    name: String,
}

/// Fetch the authenticated GitHub username via `gh api user --jq '.login'`.
/// Returns None if gh is unavailable, unauthenticated, or the call fails.
pub async fn try_gh_cli_display_name() -> Option<String> {
    let output = TokioCommand::new("gh")
        .args(["api", "user", "--jq", ".login"])
        .output()
        .await
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let name = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if name.is_empty() { None } else { Some(name) }
}

/// Try to retrieve an auth token from the gh CLI. Never returns Err — returns None
/// if gh is not installed, not authenticated, or the command fails for any reason.
/// The token value is never logged.
pub async fn try_gh_cli_token() -> Option<String> {
    if which::which("gh").is_err() {
        return None;
    }
    let output = TokioCommand::new("gh")
        .args(["auth", "token"])
        .output()
        .await
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let token = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if token.is_empty() {
        None
    } else {
        Some(token)
    }
}

/// Validate a GitHub PAT (or auto-detect via gh CLI if token is None), save the
/// IssueTrackingConfig to the project, and store the token in the token manager.
/// Returns the authenticated GitHub username on success.
pub async fn validate_and_store(
    project_id: i32,
    owner: &str,
    repo: &str,
    token: Option<String>,
    project_path: &str,
    app_state: &crate::db::AppState,
) -> Result<String, String> {
    let resolved_token = match token {
        Some(t) => t,
        None => try_gh_cli_token()
            .await
            .ok_or_else(|| {
                "GitHub: gh CLI not available or not authenticated. Provide a PAT.".to_string()
            })?,
    };

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))?;

    let response = client
        .get("https://api.github.com/user")
        .header("Authorization", format!("Bearer {}", resolved_token))
        .header("User-Agent", "maestro/1.0")
        .send()
        .await
        .map_err(|e| format!("Network error: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        if status.as_u16() == 401 {
            return Err("GitHub: bad credentials".to_string());
        }
        return Err(format!(
            "GitHub API error {}: {}",
            status.as_u16(),
            status.canonical_reason().unwrap_or("Unknown")
        ));
    }

    let user: GitHubUserResponse = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse GitHub response: {}", e))?;

    let config = IssueTrackingConfig {
        provider: Some(ProviderConfig::Github(GitHubConfig {
            owner: owner.to_string(),
            repo: repo.to_string(),
        })),
        updated_at: now_rfc3339(),
    };
    config.save_to_project(project_path)?;

    let stored_token = StoredToken {
        access_token: resolved_token,
        refresh_token: None,
        expires_at: None,
        provider: "github".to_string(),
    };
    app_state.token_manager.store_token(
        project_id,
        stored_token,
        &app_state.app_data_dir,
        &app_state.app_handle,
    )?;

    Ok(user.login)
}

/// Fetch open issues (excluding PRs) from a GitHub repository.
pub async fn fetch_issues(
    owner: &str,
    repo: &str,
    token: &str,
) -> Result<Vec<RemoteIssue>, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))?;

    let url = format!(
        "https://api.github.com/repos/{}/{}/issues?state=open&per_page=100",
        urlencoding::encode(owner),
        urlencoding::encode(repo),
    );

    let response = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", token))
        .header("User-Agent", "maestro/1.0")
        .send()
        .await
        .map_err(|e| format!("Network error: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        return Err(format!(
            "GitHub API error {}: {}",
            status.as_u16(),
            status.canonical_reason().unwrap_or("Unknown")
        ));
    }

    let issues: Vec<GitHubIssueResponse> = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse GitHub issues response: {}", e))?;

    let remote_issues = issues
        .into_iter()
        .filter(|issue| issue.pull_request.is_none())
        .map(|issue| RemoteIssue {
            external_id: format!("github:{}", issue.number),
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
    fn test_github_issue_with_pull_request_field_excluded() {
        let json = r#"{"number":1,"title":"PR title","body":null,"html_url":"https://github.com/a/b/pull/1","labels":[],"updated_at":null,"pull_request":{}}"#;
        let issue: GitHubIssueResponse = serde_json::from_str(json).unwrap();
        assert!(issue.pull_request.is_some());
    }

    #[test]
    fn test_github_issue_without_pull_request_field_kept() {
        let json = r#"{"number":42,"title":"Real issue","body":"Some body","html_url":"https://github.com/a/b/issues/42","labels":[{"name":"bug"}],"updated_at":"2024-01-01T00:00:00Z"}"#;
        let issue: GitHubIssueResponse = serde_json::from_str(json).unwrap();
        assert!(issue.pull_request.is_none());
        assert_eq!(issue.number, 42);
    }

    #[test]
    fn test_github_external_id_format() {
        let number: u64 = 42;
        assert_eq!(format!("github:{}", number), "github:42");
    }

    #[test]
    fn test_github_label_deserialization() {
        let json = r#"{"number":1,"title":"T","body":null,"html_url":"","labels":[{"name":"bug"},{"name":"help wanted"}],"updated_at":null}"#;
        let issue: GitHubIssueResponse = serde_json::from_str(json).unwrap();
        assert_eq!(issue.labels.len(), 2);
        assert_eq!(issue.labels[0].name, "bug");
        assert_eq!(issue.labels[1].name, "help wanted");
    }
}
