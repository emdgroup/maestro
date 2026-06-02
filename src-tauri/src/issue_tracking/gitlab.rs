use crate::models::issue_tracking::{GitLabConfig, ProviderConfig, RemoteIssue, IssueTrackingConfig};
use crate::models::project::now_rfc3339;
use crate::issue_tracking::token_manager::StoredToken;

#[derive(serde::Deserialize)]
struct GitLabUserResponse {
    username: String,
}

#[derive(serde::Deserialize)]
struct GitLabProjectResponse {
    id: i64,
}

#[derive(serde::Deserialize)]
struct GitLabIssueResponse {
    iid: u64,
    #[allow(dead_code)]
    id: u64,
    title: String,
    description: Option<String>,
    web_url: String,
    labels: Vec<String>,
    updated_at: Option<String>,
}

use super::normalize_instance_url;

/// Validate a GitLab PAT, resolve the numeric project ID from the project path,
/// save the IssueTrackingConfig, and store the token.
/// Returns the authenticated GitLab username on success.
pub async fn validate_and_store(
    project_id: i32,
    instance_url: &str,
    project_path: &str,
    token: &str,
    project_root: &str,
    app_state: &crate::db::AppState,
) -> Result<String, String> {
    let base = normalize_instance_url(instance_url);

    let client = super::build_http_client()?;

    let user_response = client
        .get(format!("{}/api/v4/user", base))
        .header("PRIVATE-TOKEN", token)
        .send()
        .await
        .map_err(|e| format!("Network error: {}", e))?;

    if !user_response.status().is_success() {
        let status = user_response.status();
        return Err(format!(
            "GitLab API error {}: {}",
            status.as_u16(),
            status.canonical_reason().unwrap_or("Unknown")
        ));
    }

    let user: GitLabUserResponse = user_response
        .json()
        .await
        .map_err(|e| format!("Failed to parse GitLab user response: {}", e))?;

    let encoded_path = urlencoding::encode(project_path);
    let project_response = client
        .get(format!("{}/api/v4/projects/{}", base, encoded_path))
        .header("PRIVATE-TOKEN", token)
        .send()
        .await
        .map_err(|e| format!("Network error fetching project: {}", e))?;

    if !project_response.status().is_success() {
        let status = project_response.status();
        return Err(format!(
            "GitLab project lookup error {}: {}",
            status.as_u16(),
            status.canonical_reason().unwrap_or("Unknown")
        ));
    }

    let project_info: GitLabProjectResponse = project_response
        .json()
        .await
        .map_err(|e| format!("Failed to parse GitLab project response: {}", e))?;

    let config = IssueTrackingConfig {
        provider: Some(ProviderConfig::Gitlab(GitLabConfig {
            instance_url: base,
            project_path: project_path.to_string(),
            project_id: project_info.id,
        })),
        updated_at: now_rfc3339(),
    };
    config.save_to_project(project_root)?;

    let stored_token = StoredToken {
        access_token: token.to_string(),
        refresh_token: None,
        expires_at: None,
        provider: "gitlab".to_string(),
    };
    app_state.token_manager.store_token(
        project_id,
        stored_token,
        &app_state.app_data_dir,
        &app_state.app_handle,
    )?;

    Ok(user.username)
}

/// Fetch open issues from a GitLab project using its numeric project ID.
pub async fn fetch_issues(
    instance_url: &str,
    project_id: i64,
    token: &str,
) -> Result<Vec<RemoteIssue>, String> {
    let base = normalize_instance_url(instance_url);

    let client = super::build_http_client()?;

    let url = format!(
        "{}/api/v4/projects/{}/issues?state=opened&per_page=100",
        base, project_id
    );

    let response = client
        .get(&url)
        .header("PRIVATE-TOKEN", token)
        .send()
        .await
        .map_err(|e| format!("Network error: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        return Err(format!(
            "GitLab API error {}: {}",
            status.as_u16(),
            status.canonical_reason().unwrap_or("Unknown")
        ));
    }

    let issues: Vec<GitLabIssueResponse> = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse GitLab issues response: {}", e))?;

    let remote_issues = issues
        .into_iter()
        .map(|issue| {
            let project_base = extract_project_base_from_web_url(&issue.web_url, &base);
            RemoteIssue {
                external_id: format!("gitlab:{}/{}", project_id, issue.iid),
                title: issue.title,
                body: issue.description.map(|desc| {
                    normalize_gitlab_upload_urls(&desc, &project_base)
                }),
                url: issue.web_url,
                labels: issue.labels,
                updated_at: issue.updated_at,
                priority: None,
            }
        })
        .collect();

    Ok(remote_issues)
}

// Extracts the project base URL from a GitLab issue web_url.
// e.g. "https://gitlab.com/group/project/-/issues/7" → "https://gitlab.com/group/project"
fn extract_project_base_from_web_url(web_url: &str, fallback_base: &str) -> String {
    if let Some(pos) = web_url.find("/-/") {
        web_url[..pos].to_string()
    } else {
        fallback_base.to_string()
    }
}

// Replaces relative /uploads/ refs with absolute URLs so the image proxy can fetch them.
// "](/uploads/abc/img.png)" → "](https://gitlab.com/group/project/uploads/abc/img.png)"
fn normalize_gitlab_upload_urls(body: &str, project_base_url: &str) -> String {
    body.replace("](/uploads/", &format!("]({}/uploads/", project_base_url))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_normalize_instance_url_strips_trailing_slash() {
        assert_eq!(
            normalize_instance_url("https://gitlab.com/"),
            "https://gitlab.com"
        );
    }

    #[test]
    fn test_normalize_instance_url_adds_https_when_scheme_absent() {
        assert_eq!(
            normalize_instance_url("gitlab.myco.com"),
            "https://gitlab.myco.com"
        );
    }

    #[test]
    fn test_normalize_instance_url_preserves_existing_https() {
        assert_eq!(
            normalize_instance_url("https://self-hosted.example.com"),
            "https://self-hosted.example.com"
        );
    }

    #[test]
    fn test_normalize_instance_url_preserves_explicit_http() {
        assert_eq!(
            normalize_instance_url("http://internal.corp.com"),
            "http://internal.corp.com"
        );
    }

    #[test]
    fn test_gitlab_response_uses_iid_not_id() {
        let json = r#"{"iid":7,"id":99999,"title":"Bug","description":null,"web_url":"https://gitlab.com/a/b/-/issues/7","labels":[],"updated_at":null}"#;
        let issue: GitLabIssueResponse = serde_json::from_str(json).unwrap();
        assert_eq!(issue.iid, 7);
        assert_eq!(issue.id, 99999);
    }

    #[test]
    fn test_gitlab_external_id_format() {
        let project_id: i64 = 12345;
        let iid: u64 = 7;
        assert_eq!(format!("gitlab:{}/{}", project_id, iid), "gitlab:12345/7");
    }

    #[test]
    fn test_gitlab_labels_as_strings() {
        let json = r#"{"iid":1,"id":1,"title":"T","description":null,"web_url":"","labels":["bug","help wanted"],"updated_at":null}"#;
        let issue: GitLabIssueResponse = serde_json::from_str(json).unwrap();
        assert_eq!(issue.labels, vec!["bug", "help wanted"]);
    }

    #[test]
    fn test_extract_project_base_from_web_url() {
        assert_eq!(
            extract_project_base_from_web_url("https://gitlab.com/mygroup/myproject/-/issues/7", "https://gitlab.com"),
            "https://gitlab.com/mygroup/myproject"
        );
    }

    #[test]
    fn test_extract_project_base_fallback() {
        assert_eq!(
            extract_project_base_from_web_url("https://gitlab.com/weird-url", "https://gitlab.com"),
            "https://gitlab.com"
        );
    }

    #[test]
    fn test_normalize_gitlab_upload_urls() {
        let body = "Some text ![diagram](/uploads/abc123/arch.png) more text";
        let result = normalize_gitlab_upload_urls(body, "https://gitlab.com/group/project");
        assert_eq!(
            result,
            "Some text ![diagram](https://gitlab.com/group/project/uploads/abc123/arch.png) more text"
        );
    }

    #[test]
    fn test_normalize_gitlab_upload_urls_no_uploads() {
        let body = "No images here";
        let result = normalize_gitlab_upload_urls(body, "https://gitlab.com/g/p");
        assert_eq!(result, "No images here");
    }
}
