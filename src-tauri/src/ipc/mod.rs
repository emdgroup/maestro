// Domain-specific handler modules
pub mod ssh_handlers;
pub mod worktree_handlers;
pub mod execution_handlers;
pub mod review_handlers;
pub mod settings_handlers;
pub mod filesystem_handlers;
pub mod acp_handlers;
pub mod sftp_handlers;
pub mod issue_tracking_handlers;
pub mod integration_lookup_handlers;
pub mod integration_handlers;
pub mod wsl_handlers;

// Re-export all handlers for use in lib.rs collect_commands!
pub use crate::project::handlers::*;
pub use crate::task::handlers::*;
pub use worktree_handlers::*;
pub use execution_handlers::*;
pub use review_handlers::*;
pub use settings_handlers::*;
pub use filesystem_handlers::*;
pub use ssh_handlers::*;
pub use acp_handlers::*;
pub use sftp_handlers::*;
pub use issue_tracking_handlers::*;
pub use integration_lookup_handlers::*;
pub use integration_handlers::*;
pub use wsl_handlers::*;