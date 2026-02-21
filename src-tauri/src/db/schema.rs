use rusqlite::{Connection, Result as SqlResult};

pub const SCHEMA_VERSION: u32 = 1;

pub const SCHEMA_V1: &str = r#"
-- Enable foreign keys
PRAGMA foreign_keys = ON;

-- Projects table: stores project metadata
CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    path TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_opened TEXT,
    connection_id INTEGER REFERENCES ssh_connections(id) ON DELETE SET NULL
);

-- Tasks table: stores individual tasks for projects
CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    acceptance_criteria TEXT,
    status TEXT NOT NULL DEFAULT 'Backlog',
    external_id TEXT,
    is_imported INTEGER DEFAULT 0,
    import_source TEXT,
    skills TEXT DEFAULT '[]',
    model_override TEXT,
    mcp_allowlist TEXT,
    skills_override TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

-- Worktrees table: stores git worktree instances
CREATE TABLE IF NOT EXISTS worktrees (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    branch_name TEXT NOT NULL,
    path TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'available',
    leased_at TEXT,
    returned_at TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

-- Execution logs table: stores command execution logs
CREATE TABLE IF NOT EXISTS execution_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL,
    output TEXT,
    terminal_output TEXT,
    status TEXT NOT NULL DEFAULT 'running',
    error_event TEXT,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

-- Settings table: stores application settings
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- Task reviews table: stores approval feedback and decisions
CREATE TABLE IF NOT EXISTS task_reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL UNIQUE,
    decision TEXT NOT NULL,
    general_feedback TEXT,
    reviewed_at TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

-- Review comments table: stores per-file comments on reviews
CREATE TABLE IF NOT EXISTS review_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    review_id INTEGER NOT NULL,
    file_path TEXT NOT NULL,
    comment TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (review_id) REFERENCES task_reviews(id) ON DELETE CASCADE
);

-- Known hosts table: stores accepted SSH host keys
CREATE TABLE IF NOT EXISTS known_hosts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    host_fingerprint TEXT NOT NULL,
    fingerprint_type TEXT NOT NULL,
    first_seen_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

-- SSH connections table: stores saved SSH connections
CREATE TABLE IF NOT EXISTS ssh_connections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    connection_string TEXT NOT NULL UNIQUE,
    username TEXT NOT NULL,
    host TEXT NOT NULL,
    port INTEGER NOT NULL DEFAULT 22,
    auth_method TEXT NOT NULL,
    display_name TEXT,
    last_used_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- Indexes for performance
CREATE UNIQUE INDEX IF NOT EXISTS idx_task_reviews_task_id ON task_reviews(task_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_known_hosts_project_fingerprint ON known_hosts(project_id, host_fingerprint);
CREATE INDEX IF NOT EXISTS idx_ssh_connections_last_used ON ssh_connections(last_used_at DESC);
"#;

pub fn initialize_schema(conn: &Connection) -> SqlResult<()> {
    // Enable foreign keys
    conn.execute("PRAGMA foreign_keys = ON;", [])?;

    // Get current schema version
    let current_version: u32 = conn.query_row(
        "PRAGMA user_version",
        [],
        |row| row.get(0),
    ).unwrap_or(0);

    // Initialize schema if needed
    if current_version < SCHEMA_VERSION {
        // Execute complete schema
        conn.execute_batch(SCHEMA_V1)?;

        // Set schema version
        conn.execute(
            &format!("PRAGMA user_version = {}", SCHEMA_VERSION),
            [],
        )?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    #[test]
    fn test_schema_initialization() {
        let conn = Connection::open_in_memory().unwrap();
        let result = initialize_schema(&conn);
        assert!(result.is_ok());

        // Verify tables exist
        let tables: Vec<String> = conn
            .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .filter_map(|t| t.ok())
            .collect();

        assert!(tables.contains(&"projects".to_string()));
        assert!(tables.contains(&"tasks".to_string()));
        assert!(tables.contains(&"worktrees".to_string()));
        assert!(tables.contains(&"execution_logs".to_string()));
        assert!(tables.contains(&"settings".to_string()));
        assert!(tables.contains(&"task_reviews".to_string()));
        assert!(tables.contains(&"review_comments".to_string()));
        assert!(tables.contains(&"known_hosts".to_string()));
        assert!(tables.contains(&"ssh_connections".to_string()));

        // Verify foreign keys are enabled
        let fk_enabled: u32 = conn
            .query_row("PRAGMA foreign_keys", [], |row| row.get(0))
            .unwrap();
        assert_eq!(fk_enabled, 1);

        // Verify schema version
        let version: u32 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);
    }
}
