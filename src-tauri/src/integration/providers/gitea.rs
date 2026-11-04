use crate::models::issue_tracking::RemoteIssue;

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

use super::{extract_type_from_labels, normalize_instance_url};

/// Fetch open issues (excluding PRs, filtered server-side) from a Gitea repository.
pub async fn fetch_issues(
    instance_url: &str,
    owner: &str,
    repo: &str,
    token: &str,
) -> Result<Vec<RemoteIssue>, String> {
    let base = normalize_instance_url(instance_url);

    let client = super::http_client()?;

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
        .map(|issue| {
            let labels: Vec<String> = issue.labels.into_iter().map(|l| l.name).collect();
            let issue_type = extract_type_from_labels(&labels);
            RemoteIssue {
                external_id: format!("gitea:{}", issue.number),
                title: issue.title,
                body: issue.body,
                url: issue.html_url,
                labels,
                updated_at: issue.updated_at,
                priority: None,
                issue_type,
            }
        })
        .collect();

    Ok(remote_issues)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_gitea_issue_deserialization() {
        let json = r#"{"number":42,"title":"Feature request","body":"Some description","html_url":"https://gitea.example.com/a/b/issues/42","labels":[{"name":"enhancement"}],"updated_at":"2024-01-01T00:00:00Z"}"#;
        let issue: GiteaIssueResponse = serde_json::from_str(json).unwrap();
        assert_eq!(issue.number, 42);
        assert_eq!(issue.labels[0].name, "enhancement");
    }
}
