// Domain-specific handler modules
pub mod ssh_handlers;
pub mod project_handlers;
pub mod worktree_handlers;
pub mod execution_handlers;
pub mod review_handlers;
pub mod settings_handlers;
pub mod recent_projects_handlers;
pub mod filesystem_handlers;

// Re-export all handlers for use in main.rs
pub use project_handlers::*;
pub use worktree_handlers::*;
pub use execution_handlers::*;
pub use review_handlers::*;
pub use settings_handlers::*;
pub use recent_projects_handlers::*;
pub use filesystem_handlers::*;
pub use ssh_handlers::*;
