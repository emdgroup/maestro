use rusqlite::{Connection, Result as SqlResult};

pub const SCHEMA_VERSION: u32 = 9;

pub const SCHEMA_V1: &str = r#"
-- Projects table: stores project metadata
CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    path TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
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
    started_at TEXT NOT NULL,
    completed_at TEXT,
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

-- Settings table: stores application settings per project
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

-- Index for fast task_reviews lookups
CREATE UNIQUE INDEX IF NOT EXISTS idx_task_reviews_task_id ON task_reviews(task_id);

-- Enable foreign keys
PRAGMA foreign_keys = ON;
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

    // If schema needs initialization
    if current_version < SCHEMA_VERSION {
        // Execute schema DDL (v1 base schema)
        conn.execute_batch(SCHEMA_V1)?;

        // Apply migrations based on current version
        if current_version < 2 {
            // Migration from v1 to v2: terminal_output is now in base schema, so skip
            // Previous code attempted: ALTER TABLE execution_logs ADD COLUMN terminal_output TEXT;
            // But terminal_output is already in SCHEMA_V1, so this would fail
        }

        if current_version < 3 {
            // Migration from v2 to v3: add task_reviews and review_comments tables
            conn.execute(
                "CREATE TABLE IF NOT EXISTS task_reviews (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    task_id INTEGER NOT NULL UNIQUE,
                    decision TEXT NOT NULL,
                    general_feedback TEXT,
                    reviewed_at TEXT,
                    created_at TEXT NOT NULL,
                    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
                );",
                [],
            )?;

            conn.execute(
                "CREATE TABLE IF NOT EXISTS review_comments (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    review_id INTEGER NOT NULL,
                    file_path TEXT NOT NULL,
                    comment TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    FOREIGN KEY (review_id) REFERENCES task_reviews(id) ON DELETE CASCADE
                );",
                [],
            )?;

            conn.execute(
                "CREATE UNIQUE INDEX IF NOT EXISTS idx_task_reviews_task_id ON task_reviews(task_id);",
                [],
            )?;
        }

        if current_version < 4 {
            // Migration from v3 to v4: add configuration columns to tasks table
            // These columns store task-level configuration overrides
            conn.execute(
                "ALTER TABLE tasks ADD COLUMN model_override TEXT;",
                [],
            )?;

            conn.execute(
                "ALTER TABLE tasks ADD COLUMN mcp_allowlist TEXT;",
                [],
            )?;

            conn.execute(
                "ALTER TABLE tasks ADD COLUMN skills_override TEXT;",
                [],
            )?;
        }

        if current_version < 5 {
            // Migration from v4 to v5: add error_event column to execution_logs table
            // Stores ErrorEvent struct as JSON for error detection and suggestions
            conn.execute(
                "ALTER TABLE execution_logs ADD COLUMN error_event TEXT;",
                [],
            )?;
        }

        if current_version < 6 {
            // Migration from v5 to v6: add remote project support
            // Add is_remote and ssh_config columns to projects table
            conn.execute(
                "ALTER TABLE projects ADD COLUMN is_remote BOOLEAN NOT NULL DEFAULT 0;",
                [],
            )?;

            conn.execute(
                "ALTER TABLE projects ADD COLUMN ssh_config TEXT;",
                [],
            )?;

            // Create known_hosts table for storing accepted SSH host keys
            conn.execute(
                "CREATE TABLE IF NOT EXISTS known_hosts (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    project_id INTEGER NOT NULL,
                    host_fingerprint TEXT NOT NULL,
                    fingerprint_type TEXT NOT NULL,
                    first_seen_at TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
                );",
                [],
            )?;

            conn.execute(
                "CREATE UNIQUE INDEX IF NOT EXISTS idx_known_hosts_project_fingerprint ON known_hosts(project_id, host_fingerprint);",
                [],
            )?;
        }

        if current_version < 7 {
            // Migration from v6 to v7: add SSH connections table
            // Stores saved SSH connections for quick reconnection
            conn.execute(
                "CREATE TABLE IF NOT EXISTS ssh_connections (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    connection_string TEXT NOT NULL UNIQUE,
                    username TEXT NOT NULL,
                    host TEXT NOT NULL,
                    port INTEGER NOT NULL DEFAULT 22,
                    auth_method TEXT NOT NULL,
                    last_used_at TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );",
                [],
            )?;

            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_ssh_connections_last_used ON ssh_connections(last_used_at DESC);",
                [],
            )?;
        }

        if current_version < 8 {
            // Migration from v7 to v8: add display_name to ssh_connections
            // Allows users to give friendly names to connections
            conn.execute(
                "ALTER TABLE ssh_connections ADD COLUMN display_name TEXT;",
                [],
            )?;
        }

        if current_version < 9 {
            // Migration from v8 to v9: add last_opened to projects
            // Track when each project was last opened for proper recent sorting
            conn.execute(
                "ALTER TABLE projects ADD COLUMN last_opened TEXT;",
                [],
            )?;

            // Initialize last_opened with created_at for existing projects
            conn.execute(
                "UPDATE projects SET last_opened = created_at WHERE last_opened IS NULL;",
                [],
            )?;
        }

        // Update schema version
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

        // Verify foreign keys are enabled
        let fk_enabled: u32 = conn
            .query_row("PRAGMA foreign_keys", [], |row| row.get(0))
            .unwrap();
        assert_eq!(fk_enabled, 1);
    }
}
