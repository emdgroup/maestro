use crate::models::issue_tracking::{LinearConfig, ProviderConfig, RemoteIssue, IssueTrackingConfig};
use crate::models::project::now_rfc3339;
use crate::integration::token_manager::StoredToken;

// ── Response structs ────────────────────────────────────────────────────────

#[derive(serde::Serialize)]
struct GraphqlRequest<'a> {
    query: &'a str,
    variables: serde_json::Value,
}

#[derive(serde::Deserialize)]
struct ViewerResponseData {
    viewer: ViewerUser,
}

#[derive(serde::Deserialize)]
struct ViewerUser {
    #[allow(dead_code)]
    id: String,
    name: String,
}

#[derive(serde::Deserialize)]
struct IssuesResponseData {
    issues: IssuesConnection,
}

#[derive(serde::Deserialize)]
struct IssuesConnection {
    nodes: Vec<LinearIssue>,
}

#[derive(serde::Deserialize)]
struct LinearIssue {
    identifier: String,
    title: String,
    description: Option<String>,
    url: String,
    #[serde(rename = "updatedAt")]
    updated_at: Option<String>,
    labels: LabelConnection,
    priority: Option<i32>,   // 0=null, 1=Urgent, 2=High, 3=Medium, 4=Low
}

#[derive(serde::Deserialize)]
struct LabelConnection {
    nodes: Vec<LabelNode>,
}

#[derive(serde::Deserialize)]
struct LabelNode {
    name: String,
}

#[derive(serde::Deserialize)]
struct TeamsResponseData {
    teams: TeamsConnection,
}

#[derive(serde::Deserialize)]
struct TeamsConnection {
    nodes: Vec<LinearTeam>,
}

/// A Linear team, exported to TypeScript bindings for the team picker (Phase 55).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, specta::Type)]
#[specta(export)]
pub struct LinearTeam {
    pub id: String,
    pub name: String,
    pub key: String,
}

// ── Query constants ──────────────────────────────────────────────────────────

const VIEWER_QUERY: &str = "{ viewer { id name } }";
const TEAMS_QUERY: &str = "{ teams { nodes { id name key } } }";
const ISSUES_QUERY_ALL: &str = r#"{ issues(first: 100) { nodes { identifier title description url updatedAt priority labels { nodes { name } } } } }"#;
const ISSUES_QUERY_TEAM: &str = r#"query IssuesByTeam($teamId: ID!) { issues(filter: { team: { id: { eq: $teamId } } }, first: 100) { nodes { identifier title description url updatedAt priority labels { nodes { name } } } } }"#;

// ── HTTP helper ──────────────────────────────────────────────────────────────

async fn post_graphql_query(
    client: &reqwest::Client,
    token: &str,
    query: &str,
    variables: serde_json::Value,
) -> Result<reqwest::Response, String> {
    let body = GraphqlRequest { query, variables };
    client
        .post("https://api.linear.app/graphql")
        .header("Authorization", format!("Bearer {}", token))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Linear: Network error: {}", e))
}

// ── Public API ───────────────────────────────────────────────────────────────

/// Validate a Linear API key via the viewer query, save the IssueTrackingConfig to the
/// project, and store the token. Returns the authenticated user's display name.
pub async fn validate_and_store(
    project_id: i32,
    api_key: &str,
    project_path: &str,
    app_state: &crate::core::AppState,
) -> Result<String, String> {
    let client = super::build_http_client()?;

    let response = post_graphql_query(&client, api_key, VIEWER_QUERY, serde_json::Value::Null).await?;

    if !response.status().is_success() {
        let status = response.status();
        if status.as_u16() == 401 {
            return Err("Linear: bad credentials".to_string());
        }
        return Err(format!(
            "Linear API error {}: {}",
            status.as_u16(),
            status.canonical_reason().unwrap_or("Unknown")
        ));
    }

    let gql: graphql_client::Response<ViewerResponseData> = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse Linear response: {}", e))?;

    if let Some(errors) = &gql.errors {
        if !errors.is_empty() {
            return Err(format!("Linear: {}", errors[0].message));
        }
    }

    let display_name = gql
        .data
        .ok_or_else(|| "Linear: empty response".to_string())?
        .viewer
        .name;

    let config = IssueTrackingConfig {
        provider: Some(ProviderConfig::Linear(LinearConfig { team_id: None })),
        updated_at: now_rfc3339(),
    };
    config.save_to_project(project_path)?;

    let stored_token = StoredToken {
        access_token: api_key.to_string(),
        refresh_token: None,
        expires_at: None,
        provider: "linear".to_string(),
    };
    app_state.token_manager.store_token(
        project_id,
        stored_token,
        &app_state.app_data_dir,
        &app_state.app_handle,
    )?;

    Ok(display_name)
}

/// Fetch all teams in the Linear workspace for the given API key.
pub async fn list_teams(token: &str) -> Result<Vec<LinearTeam>, String> {
    let client = super::build_http_client()?;

    let response = post_graphql_query(&client, token, TEAMS_QUERY, serde_json::Value::Null).await?;

    if !response.status().is_success() {
        let status = response.status();
        if status.as_u16() == 401 {
            return Err("Linear: bad credentials".to_string());
        }
        return Err(format!(
            "Linear API error {}: {}",
            status.as_u16(),
            status.canonical_reason().unwrap_or("Unknown")
        ));
    }

    let gql: graphql_client::Response<TeamsResponseData> = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse Linear teams response: {}", e))?;

    if let Some(errors) = &gql.errors {
        if !errors.is_empty() {
            return Err(format!("Linear: {}", errors[0].message));
        }
    }

    Ok(gql
        .data
        .ok_or_else(|| "Linear: empty response".to_string())?
        .teams
        .nodes)
}

/// Fetch open issues from Linear, optionally filtered to a specific team.
pub async fn fetch_issues(
    token: &str,
    team_id: Option<&str>,
) -> Result<Vec<RemoteIssue>, String> {
    let client = super::build_http_client()?;

    let response = match team_id {
        None => {
            post_graphql_query(&client, token, ISSUES_QUERY_ALL, serde_json::Value::Null).await?
        }
        Some(id) => {
            let variables = serde_json::json!({ "teamId": id });
            post_graphql_query(&client, token, ISSUES_QUERY_TEAM, variables).await?
        }
    };

    if !response.status().is_success() {
        let status = response.status();
        if status.as_u16() == 401 {
            return Err("Linear: bad credentials".to_string());
        }
        return Err(format!(
            "Linear API error {}: {}",
            status.as_u16(),
            status.canonical_reason().unwrap_or("Unknown")
        ));
    }

    let gql: graphql_client::Response<IssuesResponseData> = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse Linear issues response: {}", e))?;

    if let Some(errors) = &gql.errors {
        if !errors.is_empty() {
            return Err(format!("Linear: {}", errors[0].message));
        }
    }

    let nodes = gql
        .data
        .ok_or_else(|| "Linear: empty response".to_string())?
        .issues
        .nodes;

    let remote_issues = nodes
        .into_iter()
        .map(|issue| RemoteIssue {
            external_id: format!("linear:{}", issue.identifier),
            title: issue.title,
            body: issue.description,
            url: issue.url,
            labels: issue.labels.nodes.into_iter().map(|l| l.name).collect(),
            updated_at: issue.updated_at,
            priority: match issue.priority {
                Some(1) => Some("Urgent".to_string()),
                Some(2) => Some("High".to_string()),
                Some(3) => Some("Medium".to_string()),
                Some(4) => Some("Low".to_string()),
                _ => None,
            },
        })
        .collect();

    Ok(remote_issues)
}

// ── Unit tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_viewer_response_deserialization() {
        let json = r#"{"data":{"viewer":{"id":"abc","name":"Jane Doe"}}}"#;
        let resp: graphql_client::Response<ViewerResponseData> =
            serde_json::from_str(json).unwrap();
        assert_eq!(resp.data.unwrap().viewer.name, "Jane Doe");
    }

    #[test]
    fn test_issues_response_deserialization() {
        let json = r#"{
            "data": {
                "issues": {
                    "nodes": [
                        {
                            "identifier": "ENG-42",
                            "title": "Fix bug",
                            "description": null,
                            "url": "https://linear.app/team/issue/ENG-42",
                            "updatedAt": null,
                            "labels": { "nodes": [] }
                        }
                    ]
                }
            }
        }"#;
        let resp: graphql_client::Response<IssuesResponseData> =
            serde_json::from_str(json).unwrap();
        let nodes = resp.data.unwrap().issues.nodes;
        assert_eq!(nodes.len(), 1);
        let external_id = format!("linear:{}", nodes[0].identifier);
        assert_eq!(external_id, "linear:ENG-42");
    }

    #[test]
    fn test_linear_external_id_format() {
        assert_eq!(format!("linear:{}", "ENG-42"), "linear:ENG-42");
    }

    #[test]
    fn test_labels_extraction() {
        let json = r#"{
            "data": {
                "issues": {
                    "nodes": [
                        {
                            "identifier": "ENG-1",
                            "title": "Labeled issue",
                            "description": null,
                            "url": "https://linear.app/team/issue/ENG-1",
                            "updatedAt": null,
                            "labels": { "nodes": [{"name": "bug"}, {"name": "urgent"}] }
                        }
                    ]
                }
            }
        }"#;
        let resp: graphql_client::Response<IssuesResponseData> =
            serde_json::from_str(json).unwrap();
        let nodes = resp.data.unwrap().issues.nodes;
        let labels: Vec<String> = nodes[0].labels.nodes.iter().map(|l| l.name.clone()).collect();
        assert_eq!(labels, vec!["bug", "urgent"]);
    }

    #[test]
    fn test_teams_response_deserialization() {
        let json = r#"{"data":{"teams":{"nodes":[{"id":"t1","name":"Engineering","key":"ENG"}]}}}"#;
        let resp: graphql_client::Response<TeamsResponseData> =
            serde_json::from_str(json).unwrap();
        let nodes = resp.data.unwrap().teams.nodes;
        assert_eq!(nodes[0].name, "Engineering");
        assert_eq!(nodes[0].key, "ENG");
        assert_eq!(nodes[0].id, "t1");
    }
}
