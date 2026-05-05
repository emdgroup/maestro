use thiserror::Error;

#[derive(Debug, Error)]
pub enum MaestroError {
    #[error("Database error: {0}")]
    Db(#[from] rusqlite::Error),

    #[error("Project {id} is locked by another instance")]
    ProjectLocked { id: i32 },

    #[error("{0} not found")]
    NotFound(String),

    #[error("SSH error: {0}")]
    Ssh(String),

    #[error("ACP error: {0}")]
    Acp(String),

    #[error("Validation error on field '{field}': {message}")]
    Validation { field: String, message: String },

    #[error("{0}")]
    Other(String),
}

impl From<MaestroError> for String {
    fn from(e: MaestroError) -> Self {
        e.to_string()
    }
}
