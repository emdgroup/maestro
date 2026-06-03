// Domain-specific handler modules
pub mod settings_handlers;
pub mod acp_handlers;
pub mod issue_tracking_handlers;
pub mod integration_lookup_handlers;
pub mod integration_handlers;

// Re-export all handlers for use in lib.rs collect_commands!
pub use crate::project::handlers::*;
pub use crate::task::handlers::*;
pub use crate::connectivity::ssh_handlers::*;
pub use crate::connectivity::sftp_handlers::*;
pub use crate::connectivity::wsl_handlers::*;
pub use crate::connectivity::filesystem_handlers::*;
pub use crate::git::worktree_handlers::*;
pub use crate::git::review_handlers::*;
pub use crate::execution::handlers::*;
pub use settings_handlers::*;
pub use acp_handlers::*;
pub use issue_tracking_handlers::*;
pub use integration_lookup_handlers::*;
pub use integration_handlers::*;