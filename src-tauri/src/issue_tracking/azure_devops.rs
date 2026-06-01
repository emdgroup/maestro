use crate::models::issue_tracking::{AzureDevOpsConfig, ProviderConfig, RemoteIssue, IssueTrackingConfig};
use crate::models::project_config::now_rfc3339;
use crate::issue_tracking::token_manager::StoredToken;
use super::normalize_instance_url;
use base64::Engine as _;

pub(crate) const AZDO_API_VERSION: &str = "7.0";

/// Normalize an Azure DevOps organization URL.
/// For cloud URLs (dev.azure.com), strips an accidental project segment:
/// `https://dev.azure.com/myorg/MyProject` → `https://dev.azure.com/myorg`
/// On-prem URLs are left intact (collection path is required and we can't
/// distinguish it from a project path without a network call).
pub(crate) fn normalize_azdo_org_url(url: &str) -> String {
    let base = normalize_instance_url(url);
    let prefix = if base.starts_with("https://dev.azure.com/") {
        "https://dev.azure.com/"
    } else if base.starts_with("http://dev.azure.com/") {
        "http://dev.azure.com/"
    } else {
        return base;
    };
    let after_host = &base[prefix.len()..];
    if let Some(slash_pos) = after_host.find('/') {
        format!("{}{}", prefix, &after_host[..slash_pos])
    } else {
        base
    }
}

fn html_to_markdown(html: &str) -> String {
    htmd::convert(html).unwrap_or_else(|_| html.to_string())
}

fn make_azdo_auth(token: &str) -> String {
    let credentials = format!(":{}", token);
    format!("Basic {}", base64::engine::general_purpose::STANDARD.encode(credentials.as_bytes()))
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct AzdoConnectionDataResponse {
    authenticated_user: AzdoAuthUser,
}

#[derive(serde::Deserialize)]
struct AzdoAuthUser {
    #[serde(rename = "providerDisplayName")]
    provider_display_name: Option<String>,
    #[serde(rename = "subjectDescriptor")]
    subject_descriptor: Option<String>,
}

#[derive(serde::Serialize)]
struct WiqlRequest<'a> {
    query: &'a str,
}

#[derive(serde::Deserialize)]
struct WiqlResponse {
    #[serde(rename = "workItems")]
    work_items: Vec<WiqlWorkItemRef>,
}

#[derive(serde::Deserialize)]
struct WiqlWorkItemRef {
    id: i32,
}

#[derive(serde::Serialize)]
struct BatchRequest<'a> {
    ids: &'a [i32],
    fields: &'a [&'a str],
}

#[derive(serde::Deserialize)]
struct BatchResponse {
    value: Vec<WorkItemDetail>,
}

#[derive(serde::Deserialize)]
struct WorkItemDetail {
    id: i32,
    fields: WorkItemFields,
}

#[derive(serde::Deserialize)]
struct WorkItemFields {
    #[serde(rename = "System.Title")]
    title: String,
    #[serde(rename = "System.Description")]
    description: Option<String>,
    #[serde(rename = "System.ChangedDate")]
    changed_date: Option<String>,
    #[serde(rename = "System.Tags")]
    tags: Option<String>,
    #[serde(rename = "Microsoft.VSTS.Common.Priority")]
    priority: Option<i32>,
}

const WIQL_FIELDS: &[&str] = &[
    "System.Id",
    "System.Title",
    "System.Description",
    "System.WorkItemType",
    "System.ChangedDate",
    "System.Tags",
    "Microsoft.VSTS.Common.Priority",
];

/// Validate an Azure DevOps PAT against the connectionData endpoint, save the
/// IssueTrackingConfig to the project, and store the token in the token manager.
/// Returns the authenticated user's display name on success.
pub async fn validate_and_store(
    project_id: i32,
    org_url: &str,
    project: &str,
    token: &str,
    project_path: &str,
    app_state: &crate::db::AppState,
) -> Result<String, String> {
    let base = normalize_azdo_org_url(org_url);
    let auth = make_azdo_auth(token);

    let client = super::build_http_client()?;

    let response = client
        .get(format!("{}/_apis/connectionData?api-version={}", base, AZDO_API_VERSION))
        .header("Authorization", auth)
        .send()
        .await
        .map_err(|e| format!("Network error: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        let body_hint = if body.is_empty() { String::new() } else { format!(" — {}", &body[..body.len().min(500)]) };
        if status.as_u16() == 401 {
            return Err("Azure DevOps: invalid or expired credentials".to_string());
        }
        return Err(format!("Azure DevOps: HTTP {}{}", status.as_u16(), body_hint));
    }

    let conn_data: AzdoConnectionDataResponse = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse Azure DevOps response: {}", e))?;

    let display_name = conn_data
        .authenticated_user
        .provider_display_name
        .or(conn_data.authenticated_user.subject_descriptor)
        .unwrap_or_else(|| "unknown".to_string());

    let config = IssueTrackingConfig {
        provider: Some(ProviderConfig::Azuredevops(AzureDevOpsConfig {
            org_url: base.clone(),
            project: project.to_string(),
        })),
        updated_at: now_rfc3339(),
    };
    config.save_to_project(project_path)?;

    let stored_token = StoredToken {
        access_token: token.to_string(),
        refresh_token: None,
        expires_at: None,
        provider: "azure_devops".to_string(),
    };
    app_state.token_manager.store_token(
        project_id,
        stored_token,
        &app_state.app_data_dir,
        &app_state.app_handle,
    )?;

    Ok(display_name)
}

/// Fetch open work items from an Azure DevOps project using a two-step WIQL + batch approach.
/// Step 1: POST WIQL query to get work item IDs.
/// Step 2: POST to workitemsbatch in chunks of 200 to get full details.
pub async fn fetch_issues(
    org_url: &str,
    project: &str,
    token: &str,
) -> Result<Vec<RemoteIssue>, String> {
    let base = normalize_azdo_org_url(org_url);
    let auth = make_azdo_auth(token);

    let client = super::build_http_client()?;

    // Step 1: WIQL — get list of work item IDs
    // Single-quote escaping: WIQL uses '' to escape ' within string literals.
    let escaped_project = project.replace('\'', "''");
    let wiql_query = format!(
        "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = '{}' AND [System.State] <> 'Closed'",
        escaped_project
    );
    let encoded_project = urlencoding::encode(project);
    let wiql_url = format!("{}/{}/_apis/wit/wiql?api-version={}", base, encoded_project, AZDO_API_VERSION);
    let wiql_response = client
        .post(&wiql_url)
        .header("Authorization", auth.clone())
        .json(&WiqlRequest { query: &wiql_query })
        .send()
        .await
        .map_err(|e| format!("Network error: {}", e))?;

    if !wiql_response.status().is_success() {
        let status = wiql_response.status();
        let body = wiql_response.text().await.unwrap_or_default();
        let body_hint = if body.is_empty() { String::new() } else { format!(" — {}", &body[..body.len().min(500)]) };
        if status.as_u16() == 401 {
            return Err("Azure DevOps: invalid or expired credentials".to_string());
        }
        return Err(format!("Azure DevOps: HTTP {}{}", status.as_u16(), body_hint));
    }

    let wiql_result: WiqlResponse = wiql_response
        .json()
        .await
        .map_err(|e| format!("Failed to parse Azure DevOps WIQL response: {}", e))?;

    let ids: Vec<i32> = wiql_result.work_items.into_iter().map(|r| r.id).collect();

    if ids.is_empty() {
        return Ok(vec![]);
    }

    // Step 2: Batch fetch work item details in chunks of 200
    let batch_url = format!("{}/{}/_apis/wit/workitemsbatch?api-version={}", base, encoded_project, AZDO_API_VERSION);
    let mut results: Vec<RemoteIssue> = Vec::new();

    for chunk in ids.chunks(200) {
        let batch_response = client
            .post(&batch_url)
            .header("Authorization", auth.clone())
            .json(&BatchRequest { ids: chunk, fields: WIQL_FIELDS })
            .send()
            .await
            .map_err(|e| format!("Network error: {}", e))?;

        if !batch_response.status().is_success() {
            let status = batch_response.status();
            let body = batch_response.text().await.unwrap_or_default();
            let body_hint = if body.is_empty() { String::new() } else { format!(" — {}", &body[..body.len().min(500)]) };
            if status.as_u16() == 401 {
                return Err("Azure DevOps: invalid or expired credentials".to_string());
            }
            return Err(format!("Azure DevOps: HTTP {}{}", status.as_u16(), body_hint));
        }

        let batch_result: BatchResponse = batch_response
            .json()
            .await
            .map_err(|e| format!("Failed to parse Azure DevOps batch response: {}", e))?;

        for item in batch_result.value {
            let labels = item
                .fields
                .tags
                .map(|tags| tags.split("; ").map(|s| s.to_string()).collect())
                .unwrap_or_default();

            results.push(RemoteIssue {
                external_id: format!("azuredevops:{}", item.id),
                title: item.fields.title,
                body: item.fields.description.map(|h| html_to_markdown(&h)),
                url: format!("{}/{}/_workitems/edit/{}", base, encoded_project, item.id),
                labels,
                updated_at: item.fields.changed_date,
                priority: match item.fields.priority {
                    Some(1) => Some("Urgent".to_string()),
                    Some(2) => Some("High".to_string()),
                    Some(3) => Some("Medium".to_string()),
                    Some(4) => Some("Low".to_string()),
                    _ => None,
                },
            });
        }
    }

    Ok(results)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_wiql_response_deserialization() {
        let json = r#"{"workItems":[{"id":42},{"id":43}]}"#;
        let resp: WiqlResponse = serde_json::from_str(json).unwrap();
        assert_eq!(resp.work_items.len(), 2);
        assert_eq!(resp.work_items[0].id, 42);
    }

    #[test]
    fn test_batch_response_deserialization() {
        let json = r#"{"value":[{"id":42,"fields":{"System.Title":"Fix bug","System.Description":null,"System.ChangedDate":"2024-01-01T00:00:00Z","System.Tags":null}}]}"#;
        let resp: BatchResponse = serde_json::from_str(json).unwrap();
        assert_eq!(resp.value.len(), 1);
        assert_eq!(resp.value[0].fields.title, "Fix bug");
        assert_eq!(resp.value[0].fields.description, None);
    }

    #[test]
    fn test_azdo_external_id_format() {
        let id: i32 = 42;
        assert_eq!(format!("azuredevops:{}", id), "azuredevops:42");
    }

    #[test]
    fn test_normalize_azdo_strips_trailing_slash() {
        assert_eq!(
            normalize_azdo_org_url("https://dev.azure.com/myorg/"),
            "https://dev.azure.com/myorg"
        );
    }

    #[test]
    fn test_normalize_azdo_strips_project_segment() {
        assert_eq!(
            normalize_azdo_org_url("https://dev.azure.com/myorg/MyProject"),
            "https://dev.azure.com/myorg"
        );
    }

    #[test]
    fn test_normalize_azdo_preserves_clean_cloud_url() {
        assert_eq!(
            normalize_azdo_org_url("https://dev.azure.com/myorg"),
            "https://dev.azure.com/myorg"
        );
    }

    #[test]
    fn test_normalize_azdo_preserves_onprem_collection_path() {
        assert_eq!(
            normalize_azdo_org_url("https://tfs.company.com/tfs/DefaultCollection"),
            "https://tfs.company.com/tfs/DefaultCollection"
        );
    }

    #[test]
    fn test_normalize_azdo_adds_scheme() {
        assert_eq!(
            normalize_azdo_org_url("dev.azure.com/myorg"),
            "https://dev.azure.com/myorg"
        );
    }

    #[test]
    fn test_tags_split() {
        let tags = Some("backend; urgent".to_string());
        let labels: Vec<String> = tags
            .map(|t| t.split("; ").map(|s| s.to_string()).collect())
            .unwrap_or_default();
        assert_eq!(labels, vec!["backend", "urgent"]);
    }

    #[test]
    fn test_id_chunking() {
        let ids: Vec<i32> = (1..=201).collect();
        let chunks: Vec<&[i32]> = ids.chunks(200).collect();
        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0].len(), 200);
        assert_eq!(chunks[1].len(), 1);
    }
}
