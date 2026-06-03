pub mod providers;
pub mod keychain;
pub mod token_manager;
pub mod handlers;
pub mod lookup_handlers;
pub mod issue_tracking_handlers;
pub mod integration_models;
pub mod issue_tracking_models;

pub use token_manager::TokenManager;
pub use integration_models::{IntegrationStatus, CredentialSource, IntegrationCredentials};
pub use issue_tracking_models::{IssueTrackingConfig, RemoteIssue};
pub(crate) use providers::{build_http_client, normalize_instance_url};
// Re-export provider modules at integration:: level for existing crate::integration::github etc. paths
pub use providers::github;
pub use providers::gitlab;
pub use providers::forgejo;
pub use providers::gitea;
pub use providers::linear;
pub use providers::jira_cloud;
pub use providers::azure_devops;
pub use providers::bitbucket;
