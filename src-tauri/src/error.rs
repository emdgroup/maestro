//! Error handling module for the GSD orchestrator application.
//!
//! SSH helper functions (calculate_key_fingerprint, is_retriable_error) were removed in Phase 13 Bug Fixes (v1.1).
//! These functions were not used in v1.0 codebase. When SSH authentication is enhanced in future phases,
//! they can be re-implemented from VCS history if needed. See Phase 13 Bug Fixes research documentation for context:
//! .planning/phases/13-bug-fixes/13-RESEARCH.md

use std::fmt;
use std::io;
use rusqlite;

#[derive(Debug)]
pub enum AppError {
    DatabaseError(String),
    IoError(String),
}

impl fmt::Display for AppError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            AppError::DatabaseError(msg) => write!(f, "Database error: {}", msg),
            AppError::IoError(msg) => write!(f, "IO error: {}", msg),
        }
    }
}

impl std::error::Error for AppError {}

impl From<rusqlite::Error> for AppError {
    fn from(err: rusqlite::Error) -> Self {
        AppError::DatabaseError(err.to_string())
    }
}

impl From<io::Error> for AppError {
    fn from(err: io::Error) -> Self {
        AppError::IoError(err.to_string())
    }
}
