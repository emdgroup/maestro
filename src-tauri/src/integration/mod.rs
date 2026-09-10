pub mod code_hosting_handlers;
pub mod handlers;
pub mod image_proxy;
pub mod integration_models;
pub mod issue_sync;
pub mod issue_tracking_handlers;
pub mod issue_tracking_models;
pub mod keychain;
pub mod lookup;
pub mod lookup_handlers;
pub mod providers;
pub mod pull_request;
pub mod pull_request_handlers;
pub mod token_manager;

pub use integration_models::{CredentialSource, IntegrationCredentials, IntegrationStatus};
pub use issue_tracking_models::{IssueTrackingConfig, RemoteIssue};
pub(crate) use providers::{build_http_client, normalize_instance_url};
pub use token_manager::TokenManager;
// Re-export provider modules at integration:: level for existing crate::integration::github etc. paths
pub use providers::azure_devops;
pub use providers::forgejo;
pub use providers::gitea;
pub use providers::github;
pub use providers::gitlab;
pub use providers::jira_cloud;
pub use providers::linear;
