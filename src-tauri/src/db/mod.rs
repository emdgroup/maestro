pub mod connection;
pub mod schema;
pub mod settings;
pub mod execution_logs;
pub mod project_storage;

pub use connection::{init_db, AppState, get_git_connection};
pub use schema::initialize_schema;
pub use settings::{load_settings, save_settings};
pub use execution_logs::{create_execution_log, append_output, mark_complete, append_error_event, mark_failed, get_error_event, pause_execution_log, get_current_execution_log};
pub use project_storage::{
    create_project_maestro_folder,
    export_config_to_settings,
    export_state_to_file,
    load_project_config,
    load_project_state,
    ensure_maestro_folder_exists,
};
