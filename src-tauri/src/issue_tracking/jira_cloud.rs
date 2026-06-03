use crate::models::issue_tracking::{JiraCloudConfig, ProviderConfig, RemoteIssue, IssueTrackingConfig};
use crate::models::project::now_rfc3339;
use crate::issue_tracking::token_manager::StoredToken;
use super::normalize_instance_url;
use base64::Engine as _;

#[derive(serde::Deserialize)]
struct JiraMyselfResponse {
    #[serde(rename = "displayName")]
    display_name: Option<String>,
    #[serde(rename = "emailAddress")]
    email_address: Option<String>,
}

#[derive(serde::Deserialize)]
struct JiraSearchResponse {
    issues: Vec<JiraIssueResponse>,
}

#[derive(serde::Deserialize)]
struct JiraIssueResponse {
    key: String,
    fields: JiraIssueFields,
}

#[derive(serde::Deserialize)]
struct JiraPriority {
    name: String,
}

#[derive(serde::Deserialize)]
struct JiraIssueFields {
    summary: String,
    description: Option<serde_json::Value>,
    labels: Vec<String>,
    updated: Option<String>,
    priority: Option<JiraPriority>,
}

fn make_basic_auth(email: &str, api_token: &str) -> String {
    let credentials = format!("{}:{}", email, api_token);
    format!("Basic {}", base64::engine::general_purpose::STANDARD.encode(credentials.as_bytes()))
}

fn extract_body(description: Option<serde_json::Value>) -> Option<String> {
    description.map(|adf| jc_adf::from_adf::to_markdown(&adf))
}

pub async fn validate_and_store(
    project_id: i32,
    site_url: &str,
    email: &str,
    api_token: &str,
    project_key: &str,
    project_path: &str,
    app_state: &crate::core::AppState,
) -> Result<String, String> {
    let base = normalize_instance_url(site_url);
    let auth = make_basic_auth(email, api_token);

    let client = super::build_http_client()?;

    let response = client
        .get(format!("{}/rest/api/3/myself", base))
        .header("Authorization", auth)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("Network error: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        if status.as_u16() == 401 {
            return Err("Jira Cloud: bad credentials".to_string());
        }
        return Err(format!(
            "Jira Cloud API error {}: {}",
            status.as_u16(),
            status.canonical_reason().unwrap_or("Unknown")
        ));
    }

    let user: JiraMyselfResponse = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse Jira Cloud response: {}", e))?;

    let display_name = user.display_name
        .or(user.email_address)
        .unwrap_or_else(|| "unknown".to_string());

    let config = IssueTrackingConfig {
        provider: Some(ProviderConfig::Jiracloud(JiraCloudConfig {
            site_url: base.clone(),
            email: email.to_string(),
            project_key: project_key.to_string(),
        })),
        updated_at: now_rfc3339(),
    };
    config.save_to_project(project_path)?;

    let stored_token = StoredToken {
        access_token: api_token.to_string(),
        refresh_token: None,
        expires_at: None,
        provider: "jira_cloud".to_string(),
    };
    app_state.token_manager.store_token(
        project_id,
        stored_token,
        &app_state.app_data_dir,
        &app_state.app_handle,
    )?;

    Ok(display_name)
}

pub async fn fetch_issues(
    site_url: &str,
    email: &str,
    api_token: &str,
    project_key: &str,
) -> Result<Vec<RemoteIssue>, String> {
    let base = normalize_instance_url(site_url);
    let auth = make_basic_auth(email, api_token);

    let client = super::build_http_client()?;

    let safe_key = project_key.replace('"', "\\\"");
    let jql = format!(
        "project = \"{}\" AND statusCategory != Done ORDER BY updated DESC",
        safe_key
    );
    let search_url = format!("{}/rest/api/3/search/jql", base);

    let body = serde_json::json!({
        "jql": jql,
        "maxResults": 100,
        "fields": ["summary", "description", "labels", "updated", "priority"]
    });

    let response = client
        .post(&search_url)
        .header("Authorization", auth)
        .header("Accept", "application/json")
        .header("Content-Type", "application/json")
        .body(body.to_string())
        .send()
        .await
        .map_err(|e| format!("Network error: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        if status.as_u16() == 401 {
            return Err("Jira Cloud: bad credentials".to_string());
        }
        return Err(format!(
            "Jira Cloud API error {}: {}",
            status.as_u16(),
            status.canonical_reason().unwrap_or("Unknown")
        ));
    }

    let search: JiraSearchResponse = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse Jira Cloud issues response: {}", e))?;

    let remote_issues = search
        .issues
        .into_iter()
        .map(|issue| {
            let url = format!("{}/browse/{}", base, issue.key);
            RemoteIssue {
                external_id: format!("jira:{}", issue.key),
                title: issue.fields.summary,
                body: extract_body(issue.fields.description),
                url,
                labels: issue.fields.labels,
                updated_at: issue.fields.updated,
                priority: issue.fields.priority.as_ref().and_then(|p| match p.name.as_str() {
                    "Highest" => Some("Urgent".to_string()),
                    "High" => Some("High".to_string()),
                    "Medium" => Some("Medium".to_string()),
                    "Low" | "Lowest" => Some("Low".to_string()),
                    _ => None,
                }),
            }
        })
        .collect();

    Ok(remote_issues)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_myself_response_display_name() {
        let json = r#"{"displayName":"Jane Doe","emailAddress":"jane@co.com"}"#;
        let resp: JiraMyselfResponse = serde_json::from_str(json).unwrap();
        assert_eq!(resp.display_name, Some("Jane Doe".to_string()));
    }

    #[test]
    fn test_myself_response_fallback_email() {
        let json = r#"{"emailAddress":"jane@co.com"}"#;
        let resp: JiraMyselfResponse = serde_json::from_str(json).unwrap();
        let name = resp.display_name.or(resp.email_address);
        assert_eq!(name, Some("jane@co.com".to_string()));
    }

    #[test]
    fn test_adf_body_extraction_some() {
        let adf = serde_json::json!({"type": "doc", "version": 1, "content": []});
        let result = extract_body(Some(adf));
        assert!(result.is_some());
    }

    #[test]
    fn test_adf_body_extraction_none() {
        let result = extract_body(None);
        assert_eq!(result, None);
    }

    #[test]
    fn test_jira_cloud_external_id_format() {
        let key = "PROJ-42";
        assert_eq!(format!("jira:{}", key), "jira:PROJ-42");
    }

    #[test]
    fn test_normalize_url_strips_slash() {
        assert_eq!(
            normalize_instance_url("https://myco.atlassian.net/"),
            "https://myco.atlassian.net"
        );
    }

    #[test]
    fn test_search_response_deserialization() {
        let json = r#"{
            "issues": [
                {
                    "key": "PROJ-42",
                    "fields": {
                        "summary": "Fix bug",
                        "description": null,
                        "labels": ["backend"],
                        "updated": "2024-01-01T00:00:00.000+0000"
                    }
                }
            ]
        }"#;
        let resp: JiraSearchResponse = serde_json::from_str(json).unwrap();
        assert_eq!(resp.issues.len(), 1);
        assert_eq!(resp.issues[0].key, "PROJ-42");
        assert_eq!(resp.issues[0].fields.labels[0], "backend");
    }
}
