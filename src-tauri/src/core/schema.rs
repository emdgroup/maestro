use rusqlite::{Connection, Result as SqlResult};
use std::path::{Path, PathBuf};

pub const SCHEMA_VERSION: u32 = 28;

pub const SCHEMA_V28_FULL: &str = r#"
-- Enable foreign keys
PRAGMA foreign_keys = ON;

-- WSL connections table: one row per WSL distro the user has connected to
CREATE TABLE IF NOT EXISTS wsl_connections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    distro_name TEXT NOT NULL UNIQUE,
    display_name TEXT,
    last_used_at TEXT NOT NULL,
    created_at TEXT NOT NULL
);

-- Docker/Podman/nerdctl container connections
CREATE TABLE IF NOT EXISTS docker_connections (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    container_name TEXT NOT NULL UNIQUE,
    image_name  TEXT,
    display_name TEXT,
    last_used_at TEXT NOT NULL,
    created_at  TEXT NOT NULL
);

-- Projects table: stores project metadata
CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    path TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_opened TEXT,
    connection_id INTEGER REFERENCES ssh_connections(id) ON DELETE SET NULL,
    wsl_connection_id INTEGER REFERENCES wsl_connections(id) ON DELETE SET NULL,
    docker_connection_id INTEGER REFERENCES docker_connections(id) ON DELETE SET NULL
);

-- Tasks table: stores individual tasks for projects
CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'Planning',
    priority TEXT NOT NULL DEFAULT 'Medium',
    base_branch TEXT NOT NULL,
    archived_at TEXT,
    external_id TEXT,
    is_imported INTEGER DEFAULT 0,
    import_source TEXT,
    skills TEXT DEFAULT '[]',
    model_override TEXT,
    mcp_allowlist TEXT,
    skills_override TEXT,
    external_url TEXT,
    external_updated_at TEXT,
    labels TEXT DEFAULT '[]',
    auto_approve INTEGER NOT NULL DEFAULT 0,
    -- Where this task's agent works: NewWorktree / RepositoryDirectory / ReuseWorkspace.
    workspace_mode TEXT NOT NULL DEFAULT 'NewWorktree',
    -- The workspace a ReuseWorkspace task was pinned to, and NULL for every other mode. Cleared
    -- when that worktree goes away, which is what makes "the workspace you picked is gone" a state
    -- the executor can detect rather than a dangling id.
    workspace_worktree_id INTEGER REFERENCES worktrees(id) ON DELETE SET NULL,
    -- For NewWorktree, whether the worktree gets a branch of its own or checks out an existing one:
    -- 'Create' or 'Checkout'. Checkout needs no branch column of its own, because the branch it
    -- checks out is base_branch.
    workspace_branch_mode TEXT NOT NULL DEFAULT 'Create',
    -- The branch name the user chose, for 'Create' only. NULL means "generate it from the task at
    -- spawn time", which is what every task predating this column meant and what an untouched
    -- field still submits.
    workspace_branch TEXT,
    agent_id TEXT,
    permission_mode_override TEXT,
    execution_start_sha TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    -- Pipeline activity, orthogonal to status. `status` is which board column the task is in;
    -- these three are what is happening inside it. phase NULL means no pipeline activity, in
    -- which case phase_status is NULL and ball is 'None'. Written only via task::transition.
    phase TEXT,
    phase_status TEXT,
    ball TEXT NOT NULL DEFAULT 'None',
    -- How a Done task got there: Merged / MergedViaPR / LocalOnly / NoChanges. NULL on anything
    -- that is not Done, and on Done tasks in a non-git project where none of those mean anything.
    completion TEXT,
    -- When the user pressed Execute on a task the host had no free slot for. The scheduler takes
    -- these before its own picks, so the deferral message is a promise it can keep. Cleared by
    -- task::transition the moment the task stops being a queue candidate.
    execute_requested_at TEXT,
    -- The pull request this task's branch was opened as, set when approve chooses the PR path.
    -- Columns rather than an outcome-thread entry because the poller has to find the tasks with
    -- an open PR by query, and the card links straight to it.
    pull_request_url TEXT,
    pull_request_number INTEGER,
    -- How many times the review agent has sent this task back. Bounded, because the rework loop
    -- is the one place agents hand work to each other with no human in between.
    review_rounds INTEGER NOT NULL DEFAULT 0,
    -- How many times an agent has been sent to fix this task's CI. Counted separately from
    -- review_rounds: a task that spent its review rounds must still be able to fix a red build,
    -- and a shared counter would make both cap messages wrong.
    fix_rounds INTEGER NOT NULL DEFAULT 0,
    -- What the forge's CI last said about the open pull request: Passing / Failing / Pending.
    -- A display cache, not a lifecycle field — the sweep runs every three minutes and this is what
    -- lets the card answer "can this land" in between. NULL whenever there is nothing to say.
    pull_request_ci TEXT,
    -- Which agent profile this task wants for a given role, as a JSON object keyed by role name:
    -- {"Reviewer": "strict-reviewer"}. A role absent from it uses the project's default, so NULL
    -- and "{}" both mean "the project decides everything", which is what almost every task wants.
    --
    -- Profile ids rather than inlined settings, so a task cannot describe an agent the project
    -- never defined: `ProfilesDocument::resolve` already takes an override id and falls back when
    -- it names nothing, which is also what makes a deleted profile harmless here.
    profile_overrides TEXT,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

-- Task relationships table: stores dependencies between tasks
CREATE TABLE IF NOT EXISTS task_relationships (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_task_id INTEGER NOT NULL,
    to_task_id INTEGER NOT NULL,
    relationship_type TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (from_task_id) REFERENCES tasks(id) ON DELETE CASCADE,
    FOREIGN KEY (to_task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

-- Task instructions table: stores instruction log entries for tasks
CREATE TABLE IF NOT EXISTS task_instructions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    source TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

-- The task's outcome thread: the closing message of each phase, artifacts, and user notes.
-- Append-only and client-side, so it survives archiving and the death of the session that
-- produced it. `kind` is what the gates point at — a plan gate gates on the latest 'plan' entry.
--
-- Content is inline-or-reference by design: `body` holds the text, `external_ref` a pointer to
-- bytes stored elsewhere. Exactly one is set. Artifacts are small enough to inline today, and the
-- column is what keeps moving them out later from being a migration of stored data.
CREATE TABLE IF NOT EXISTS task_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    author TEXT NOT NULL,
    body TEXT,
    external_ref TEXT,
    phase TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_task_comments_task_id ON task_comments(task_id);

-- Task attachments table: stores file attachment metadata for tasks
CREATE TABLE IF NOT EXISTS task_attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL,
    filename TEXT NOT NULL,
    file_path TEXT NOT NULL,
    file_size INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_task_attachments_task_id ON task_attachments(task_id);

-- Worktrees table: stores git worktree instances
CREATE TABLE IF NOT EXISTS worktrees (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
    branch_name TEXT NOT NULL,
    base_branch TEXT,
    path TEXT NOT NULL,
    git_status TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
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

-- Session aliases: user-defined display names for ACP sessions (client-local, not sent to agent)
CREATE TABLE IF NOT EXISTS session_aliases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    agent_id TEXT NOT NULL,
    acp_session_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(project_id, agent_id, acp_session_id),
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

-- Per-connection settings: how many agents may run on a given host.
--
-- No foreign key: connection_key is a polymorphic (type, id) pair across ssh_connections,
-- wsl_connections and docker_connections, so a cascade cannot be expressed. A deleted connection
-- leaves one row behind, which is harmless and reused if the id is.
CREATE TABLE IF NOT EXISTS connection_settings (
    connection_key TEXT PRIMARY KEY,
    concurrency_mode TEXT NOT NULL,
    max_concurrent_agents INTEGER NOT NULL,
    updated_at TEXT NOT NULL
);

-- Indexes for performance
CREATE UNIQUE INDEX IF NOT EXISTS idx_task_reviews_task_id ON task_reviews(task_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_known_hosts_project_fingerprint ON known_hosts(project_id, host_fingerprint);
CREATE INDEX IF NOT EXISTS idx_ssh_connections_last_used ON ssh_connections(last_used_at DESC);
CREATE INDEX IF NOT EXISTS idx_worktrees_project_id ON worktrees(project_id);
CREATE INDEX IF NOT EXISTS idx_worktrees_task_id ON worktrees(task_id);
CREATE INDEX IF NOT EXISTS idx_tasks_project_status ON tasks(project_id, status);
CREATE INDEX IF NOT EXISTS idx_session_aliases_lookup ON session_aliases(project_id, agent_id);
"#;

fn read_user_version(conn: &Connection) -> u32 {
    conn.query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap_or(0)
}

/// Snapshot the database before an upgrade so a bad migration can be undone by hand.
///
/// Returns the backup path, or `None` when there is nothing to migrate. Uses `VACUUM INTO`
/// rather than copying the file: in WAL mode the most recent commits may still live in
/// `maestro.db-wal`, so a plain copy can produce a snapshot that is missing data.
pub fn backup_before_migration(
    conn: &Connection,
    db_path: &Path,
) -> Result<Option<PathBuf>, String> {
    let current_version = read_user_version(conn);
    if current_version == 0 || current_version >= SCHEMA_VERSION {
        return Ok(None);
    }

    let file_name = db_path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| format!("Database path has no file name: {}", db_path.display()))?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since_epoch| since_epoch.as_secs())
        .unwrap_or(0);
    let backup_path =
        db_path.with_file_name(format!("{file_name}.bak-v{current_version}-{stamp}"));

    // VACUUM INTO refuses to write an existing file.
    if backup_path.exists() {
        std::fs::remove_file(&backup_path)
            .map_err(|e| format!("Failed to replace stale database backup: {e}"))?;
    }

    conn.execute("VACUUM INTO ?1", [backup_path.to_string_lossy().as_ref()])
        .map_err(|e| format!("Failed to back up database before migration: {e}"))?;

    Ok(Some(backup_path))
}

pub fn initialize_schema(conn: &Connection) -> Result<(), String> {
    // Enable foreign keys. This is per-connection state, so it has to happen on every call and
    // not only when there is schema work to do.
    conn.execute("PRAGMA foreign_keys = ON;", [])
        .map_err(|e| e.to_string())?;

    let current_version = read_user_version(conn);

    if current_version == SCHEMA_VERSION {
        return Ok(());
    }

    // Refusing here is what keeps the unconditional `PRAGMA user_version` write below from
    // relabelling a newer database as this version, which would make a later upgrade re-run
    // migrations that have already been applied.
    if current_version > SCHEMA_VERSION {
        return Err(format!(
            "This database was created by a newer version of Maestro (schema v{current_version}, \
             this build supports v{SCHEMA_VERSION}). Update Maestro to continue, or move \
             maestro.db aside to start with an empty database."
        ));
    }

    apply_schema(conn, current_version).map_err(|e| e.to_string())
}

fn apply_schema(conn: &Connection, current_version: u32) -> SqlResult<()> {
    // Enable foreign keys
    conn.execute("PRAGMA foreign_keys = ON;", [])?;

    if current_version == 0 {
        // Fresh install: create full schema
        conn.execute_batch(SCHEMA_V28_FULL)?;
    } else if current_version < 22 {
        // Legacy drop-recreate: no data to preserve before V22
        conn.execute_batch(r#"
            PRAGMA foreign_keys = OFF;
            DROP TABLE IF EXISTS task_attachments;
            DROP TABLE IF EXISTS session_aliases;
            DROP TABLE IF EXISTS review_comments;
            DROP TABLE IF EXISTS task_reviews;
            DROP TABLE IF EXISTS task_instructions;
            DROP TABLE IF EXISTS task_relationships;
            DROP TABLE IF EXISTS worktrees;
            DROP TABLE IF EXISTS tasks;
            DROP TABLE IF EXISTS known_hosts;
            DROP TABLE IF EXISTS projects;
            DROP TABLE IF EXISTS docker_connections;
            DROP TABLE IF EXISTS wsl_connections;
            DROP TABLE IF EXISTS ssh_connections;
            DROP TABLE IF EXISTS settings;
            PRAGMA foreign_keys = ON;
        "#)?;
        conn.execute_batch(SCHEMA_V28_FULL)?;
    } else {
        // current_version >= 22: apply incremental migrations.
        // Committing the migrations and the version bump together means a failure part-way
        // through cannot leave a half-migrated database behind. The two branches above are
        // deliberately outside a transaction: they toggle `PRAGMA foreign_keys`, which SQLite
        // ignores inside one.
        let transaction = conn.unchecked_transaction()?;
        run_migrations(&transaction, current_version)?;
        transaction.execute(&format!("PRAGMA user_version = {}", SCHEMA_VERSION), [])?;
        transaction.commit()?;
        return Ok(());
    }

    conn.execute(
        &format!("PRAGMA user_version = {}", SCHEMA_VERSION),
        [],
    )?;

    Ok(())
}

fn run_migrations(conn: &Connection, from: u32) -> SqlResult<()> {
    if from < 23 {
        migrate_to_v23(conn)?;
    }
    if from < 24 {
        migrate_to_v24(conn)?;
    }
    if from < 25 {
        migrate_to_v25(conn)?;
    }
    if from < 26 {
        migrate_to_v26(conn)?;
    }
    if from < 27 {
        migrate_to_v27(conn)?;
    }
    if from < 28 {
        migrate_to_v28(conn)?;
    }
    Ok(())
}

/// Move the agent concurrency limit from one app-wide value to one per connection.
///
/// The limit is there to keep auto-mode from spawning agents a host has no memory for, and memory
/// belongs to the host — every project pointed at the same machine draws on the same pool. A single
/// global number could not express that.
///
/// Nothing is carried across. The old value was a fixed count, while the new default estimates from
/// free memory, so seeding every connection with it would silently opt existing users out of the
/// behaviour this change exists to give them. Each connection starts at the default instead.
fn migrate_to_v28(conn: &Connection) -> SqlResult<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS connection_settings (
            connection_key TEXT PRIMARY KEY,
            concurrency_mode TEXT NOT NULL,
            max_concurrent_agents INTEGER NOT NULL,
            updated_at TEXT NOT NULL
        );",
    )?;

    conn.execute(
        "DELETE FROM settings WHERE key IN ('concurrency_mode', 'max_concurrent_agents')",
        [],
    )?;

    Ok(())
}

/// Let a `NewWorktree` task say *which* branch it wants, and whether that branch is one to create
/// or one that already exists.
///
/// Both defaults are what every existing task already meant, so there is nothing to backfill:
/// `Create` is the only thing the previous build could do, and a NULL `workspace_branch` keeps the
/// name being generated from the task at spawn time exactly as before.
fn migrate_to_v27(conn: &Connection) -> SqlResult<()> {
    for (name, definition) in [
        ("workspace_branch_mode", "workspace_branch_mode TEXT NOT NULL DEFAULT 'Create'"),
        ("workspace_branch", "workspace_branch TEXT"),
    ] {
        let column_exists: bool = conn.query_row(
            "SELECT COUNT(*) FROM pragma_table_info('tasks') WHERE name = ?",
            [name],
            |row| row.get::<_, i32>(0),
        )? > 0;

        if !column_exists {
            conn.execute_batch(&format!("ALTER TABLE tasks ADD COLUMN {};", definition))?;
        }
    }
    Ok(())
}

/// Replace the `isolated_worktree` boolean with the three-way `workspace_mode`.
///
/// The boolean could say "a worktree of its own" or "the project directory" and had no way to say
/// "the worktree that already exists", which is the choice this adds. The backfill is exact in both
/// directions — every existing task meant one of the two modes the boolean could express — so no
/// task changes where it runs.
///
/// `isolated_worktree` is dropped rather than left in place: nothing reads it after this, and a
/// column that disagrees with `workspace_mode` the first time a task is edited is worse than no
/// column at all.
fn migrate_to_v26(conn: &Connection) -> SqlResult<()> {
    let column_exists = |name: &str| -> SqlResult<bool> {
        conn.query_row(
            "SELECT COUNT(*) FROM pragma_table_info('tasks') WHERE name = ?",
            [name],
            |row| row.get::<_, i32>(0),
        )
        .map(|count| count > 0)
    };

    if !column_exists("workspace_mode")? {
        conn.execute_batch(
            "ALTER TABLE tasks ADD COLUMN workspace_mode TEXT NOT NULL DEFAULT 'NewWorktree';",
        )?;
    }
    if !column_exists("workspace_worktree_id")? {
        conn.execute_batch(
            "ALTER TABLE tasks ADD COLUMN workspace_worktree_id INTEGER \
             REFERENCES worktrees(id) ON DELETE SET NULL;",
        )?;
    }

    if column_exists("isolated_worktree")? {
        conn.execute_batch(
            "UPDATE tasks SET workspace_mode = \
                CASE isolated_worktree WHEN 1 THEN 'NewWorktree' ELSE 'RepositoryDirectory' END;
             ALTER TABLE tasks DROP COLUMN isolated_worktree;",
        )?;
    }

    Ok(())
}

/// Everything the pipeline rework added to a v24 database.
///
/// This was built as three separate steps and collapsed into one, because none of them was ever
/// released: v24 is what shipped in v0.11.0 through v0.16.0, and no database outside this
/// repository has ever held v25 or later. Keeping three migrations for a state nothing was in
/// would be three code paths maintained to serve nobody.
///
/// Two things it deliberately does *not* backfill:
///
/// `completion` stays NULL on existing Done tasks. The board cannot tell a merged task from an
/// approved-and-abandoned one after the fact, and a wrong qualifier is worse than an absent one:
/// `LocalOnly` is the variant that says the work is still sitting in a worktree, so inventing it
/// would send a user looking for something that is not there, and omitting it would hide work that
/// is.
///
/// `execute_requested_at` stays NULL everywhere. It records a promise the user was given, and no
/// existing task was ever given one.
fn migrate_to_v25(conn: &Connection) -> SqlResult<()> {
    for (name, definition) in [
        ("phase", "phase TEXT"),
        ("phase_status", "phase_status TEXT"),
        ("ball", "ball TEXT NOT NULL DEFAULT 'None'"),
        ("completion", "completion TEXT"),
        ("execute_requested_at", "execute_requested_at TEXT"),
        ("pull_request_url", "pull_request_url TEXT"),
        ("pull_request_number", "pull_request_number INTEGER"),
        ("review_rounds", "review_rounds INTEGER NOT NULL DEFAULT 0"),
        ("fix_rounds", "fix_rounds INTEGER NOT NULL DEFAULT 0"),
        ("pull_request_ci", "pull_request_ci TEXT"),
        ("profile_overrides", "profile_overrides TEXT"),
    ] {
        let col_exists: bool = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('tasks') WHERE name = ?",
                [name],
                |row| row.get::<_, i32>(0),
            )
            .unwrap_or(0)
            > 0;

        if !col_exists {
            conn.execute_batch(&format!("ALTER TABLE tasks ADD COLUMN {};", definition))?;
        }
    }

    // `migrate_to_v24` already retired these two legacy values, but `reject_review` has kept
    // writing 'Backlog' ever since. Repeat the cleanup so rows written in between are not left
    // with a status no `TaskStatus` variant matches — `FromStr` maps them to Planning on read,
    // which hides the problem from the UI while keeping them invisible to status-filtered SQL.
    conn.execute_batch(
        "UPDATE tasks SET status = 'Planning' WHERE status = 'Backlog';
         UPDATE tasks SET status = 'Queue' WHERE status = 'Ready';",
    )?;

    conn.execute_batch(
        "UPDATE tasks SET phase = 'Implementing', phase_status = 'Running', ball = 'Agent' \
           WHERE status = 'InProgress';
         UPDATE tasks SET phase = 'Approval', phase_status = 'Waiting', ball = 'User' \
           WHERE status = 'Review';
         UPDATE tasks SET phase = NULL, phase_status = NULL, ball = 'None' \
           WHERE status IN ('Planning', 'Queue', 'Done', 'Cancelled');",
    )?;

    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS task_comments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id INTEGER NOT NULL,
            kind TEXT NOT NULL,
            author TEXT NOT NULL,
            body TEXT,
            external_ref TEXT,
            phase TEXT,
            created_at TEXT NOT NULL,
            FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_task_comments_task_id ON task_comments(task_id);",
    )?;

    Ok(())
}

fn migrate_to_v24(conn: &Connection) -> SqlResult<()> {
    conn.execute_batch(
        "UPDATE tasks SET status = 'Planning' WHERE status = 'Backlog';
         UPDATE tasks SET status = 'Queue' WHERE status = 'Ready';",
    )?;
    Ok(())
}

fn migrate_to_v23(conn: &Connection) -> SqlResult<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS docker_connections (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            container_name TEXT NOT NULL UNIQUE,
            image_name     TEXT,
            display_name   TEXT,
            last_used_at   TEXT NOT NULL,
            created_at     TEXT NOT NULL
        );",
    )?;

    let col_exists: bool = conn
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('projects') WHERE name = 'docker_connection_id'",
            [],
            |row| row.get::<_, i32>(0),
        )
        .unwrap_or(0)
        > 0;

    if !col_exists {
        conn.execute_batch(
            "ALTER TABLE projects ADD COLUMN \
             docker_connection_id INTEGER REFERENCES docker_connections(id) ON DELETE SET NULL;",
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
        assert!(tables.contains(&"settings".to_string()));
        assert!(tables.contains(&"task_reviews".to_string()));
        assert!(tables.contains(&"review_comments".to_string()));
        assert!(tables.contains(&"task_relationships".to_string()));
        assert!(tables.contains(&"task_instructions".to_string()));
        assert!(tables.contains(&"known_hosts".to_string()));
        assert!(tables.contains(&"ssh_connections".to_string()));
        assert!(tables.contains(&"wsl_connections".to_string()));
        assert!(tables.contains(&"session_aliases".to_string()));
        assert!(tables.contains(&"task_attachments".to_string()));
        assert!(!tables.contains(&"execution_logs".to_string()), "execution_logs removed in V13");

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
        assert_eq!(version, 28);
        assert!(tables.contains(&"docker_connections".to_string()));
        assert!(tables.contains(&"connection_settings".to_string()));

        // Verify worktrees table has expected columns
        let worktree_columns: Vec<String> = conn
            .prepare("PRAGMA table_info(worktrees)")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect();

        assert!(worktree_columns.contains(&"task_id".to_string()), "task_id column should exist");
        assert!(worktree_columns.contains(&"git_status".to_string()), "git_status column should exist");
        assert!(worktree_columns.contains(&"base_branch".to_string()), "base_branch column should exist");
        assert!(!worktree_columns.contains(&"status".to_string()), "status column should NOT exist");
        assert!(!worktree_columns.contains(&"leased_at".to_string()), "leased_at column should NOT exist");
        assert!(!worktree_columns.contains(&"returned_at".to_string()), "returned_at column should NOT exist");

        // Verify tasks table has V17 columns
        let task_columns: Vec<String> = conn
            .prepare("PRAGMA table_info(tasks)")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect();
        assert!(task_columns.contains(&"title".to_string()));
        assert!(!task_columns.contains(&"name".to_string()));
        assert!(!task_columns.contains(&"acceptance_criteria".to_string()));
        assert!(task_columns.contains(&"external_url".to_string()));
        assert!(task_columns.contains(&"external_updated_at".to_string()));
        assert!(task_columns.contains(&"labels".to_string()));
        assert!(task_columns.contains(&"auto_approve".to_string()));
        assert!(task_columns.contains(&"workspace_mode".to_string()));
        assert!(task_columns.contains(&"workspace_worktree_id".to_string()));
        assert!(
            !task_columns.contains(&"isolated_worktree".to_string()),
            "isolated_worktree is superseded by workspace_mode in V26"
        );
        assert!(task_columns.contains(&"agent_id".to_string()));
        assert!(task_columns.contains(&"phase".to_string()));
        assert!(task_columns.contains(&"phase_status".to_string()));
        assert!(task_columns.contains(&"ball".to_string()));
    }

    /// Foreign keys are per-connection, so the early return for an already-current database must
    /// still enable them.
    #[test]
    fn test_foreign_keys_enabled_when_schema_already_current() {
        let conn = Connection::open_in_memory().unwrap();
        initialize_schema(&conn).unwrap();
        conn.execute("PRAGMA foreign_keys = OFF;", []).unwrap();

        // Second call takes the "already at SCHEMA_VERSION" path.
        initialize_schema(&conn).unwrap();

        let fk_enabled: u32 = conn
            .query_row("PRAGMA foreign_keys", [], |row| row.get(0))
            .unwrap();
        assert_eq!(fk_enabled, 1, "foreign keys must be on after every call");
    }

    /// A database written by a newer build must be refused rather than relabelled, otherwise the
    /// version bump would silently claim the newer schema is this version.
    #[test]
    fn test_newer_schema_version_is_rejected() {
        let conn = Connection::open_in_memory().unwrap();
        initialize_schema(&conn).unwrap();
        conn.execute(&format!("PRAGMA user_version = {}", SCHEMA_VERSION + 1), [])
            .unwrap();

        let result = initialize_schema(&conn);

        assert!(result.is_err(), "a newer schema version must not be accepted");
        let message = result.unwrap_err();
        assert!(
            message.contains("newer version of Maestro"),
            "error should explain the cause, got: {message}"
        );
        let version = read_user_version(&conn);
        assert_eq!(
            version,
            SCHEMA_VERSION + 1,
            "the stored version must be left untouched"
        );
    }

    /// The v22+ path migrates in place, so existing rows must survive.
    #[test]
    fn test_incremental_migration_preserves_rows() {
        let conn = Connection::open_in_memory().unwrap();
        initialize_schema(&conn).unwrap();
        conn.execute(
            "INSERT INTO projects (id, name, path, created_at, updated_at) \
             VALUES (1, 'demo', '/tmp/demo', '2026-01-01', '2026-01-01')",
            [],
        )
        .unwrap();

        // Rewind to the first version that migrates rather than drops.
        conn.execute("PRAGMA user_version = 22", []).unwrap();
        initialize_schema(&conn).unwrap();

        let surviving: i64 = conn
            .query_row("SELECT COUNT(*) FROM projects WHERE id = 1", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(surviving, 1, "migrating from v22 must not drop project rows");
        assert_eq!(read_user_version(&conn), SCHEMA_VERSION);
    }

    /// v28 moves the agent limit from one app-wide value to one per connection. The old keys must
    /// go: left in place they would read as a global limit that nothing enforces, and the next
    /// person to find them would reasonably assume they still mattered.
    #[test]
    fn test_migration_to_v28_drops_the_app_wide_concurrency_keys() {
        let conn = Connection::open_in_memory().unwrap();
        initialize_schema(&conn).unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES \
             ('max_concurrent_agents', '8', '2026-01-01'), \
             ('concurrency_mode', 'Hard', '2026-01-01'), \
             ('auto_mode', 'true', '2026-01-01')",
            [],
        )
        .unwrap();
        conn.execute("DROP TABLE connection_settings", []).unwrap();

        conn.execute("PRAGMA user_version = 27", []).unwrap();
        initialize_schema(&conn).unwrap();

        let leftover: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM settings WHERE key IN ('concurrency_mode', 'max_concurrent_agents')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(leftover, 0, "the app-wide concurrency keys must be removed");

        // Unrelated settings are not collateral.
        let auto_mode: String = conn
            .query_row("SELECT value FROM settings WHERE key = 'auto_mode'", [], |row| row.get(0))
            .unwrap();
        assert_eq!(auto_mode, "true");

        // Nothing is carried across: a connection starts at the default, which estimates from
        // memory rather than inheriting the fixed 8 the user had.
        let seeded: i64 = conn
            .query_row("SELECT COUNT(*) FROM connection_settings", [], |row| row.get(0))
            .unwrap();
        assert_eq!(seeded, 0);
    }

    /// v24 renamed two task statuses; the migration must rewrite existing rows.
    #[test]
    fn test_migration_to_v24_renames_task_statuses() {
        let conn = Connection::open_in_memory().unwrap();
        initialize_schema(&conn).unwrap();
        conn.execute(
            "INSERT INTO projects (id, name, path, created_at, updated_at) \
             VALUES (1, 'demo', '/tmp/demo', '2026-01-01', '2026-01-01')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO tasks (id, project_id, title, status, base_branch, created_at, updated_at) \
             VALUES (1, 1, 'legacy backlog', 'Backlog', 'main', '2026-01-01', '2026-01-01'), \
                    (2, 1, 'legacy ready', 'Ready', 'main', '2026-01-01', '2026-01-01')",
            [],
        )
        .unwrap();

        conn.execute("PRAGMA user_version = 23", []).unwrap();
        initialize_schema(&conn).unwrap();

        let statuses: Vec<String> = conn
            .prepare("SELECT status FROM tasks ORDER BY id")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect();
        assert_eq!(statuses, vec!["Planning".to_string(), "Queue".to_string()]);
    }

    /// v24 → v25 is the only upgrade the pipeline rework has to survive, because v24 is what
    /// shipped and nothing else was ever released. It has to backfill the pipeline triple from
    /// `status`, repeat the 'Backlog' cleanup (`reject_review` kept writing it after v24), add the
    /// two nullable columns without inventing values for them, and create the outcome thread.
    #[test]
    fn test_migration_from_the_last_released_schema() {
        let conn = Connection::open_in_memory().unwrap();
        initialize_schema(&conn).unwrap();
        conn.execute(
            "INSERT INTO projects (id, name, path, created_at, updated_at) \
             VALUES (1, 'demo', '/tmp/demo', '2026-01-01', '2026-01-01')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO tasks (id, project_id, title, status, base_branch, created_at, updated_at) \
             VALUES (1, 1, 'running', 'InProgress', 'main', '2026-01-01', '2026-01-01'), \
                    (2, 1, 'in review', 'Review', 'main', '2026-01-01', '2026-01-01'), \
                    (3, 1, 'parked', 'Planning', 'main', '2026-01-01', '2026-01-01'), \
                    (4, 1, 'post-v24 backlog', 'Backlog', 'main', '2026-01-01', '2026-01-01'), \
                    (5, 1, 'finished long ago', 'Done', 'main', '2026-01-01', '2026-01-01')",
            [],
        )
        .unwrap();
        // A real v24 database has no outcome thread.
        conn.execute_batch("DROP TABLE task_comments;").unwrap();

        conn.execute("PRAGMA user_version = 24", []).unwrap();
        initialize_schema(&conn).unwrap();

        let row = |id: i32| -> (String, Option<String>, Option<String>, String) {
            conn.query_row(
                "SELECT status, phase, phase_status, ball FROM tasks WHERE id = ?",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap()
        };

        assert_eq!(
            row(1),
            ("InProgress".into(), Some("Implementing".into()), Some("Running".into()), "Agent".into())
        );
        assert_eq!(
            row(2),
            ("Review".into(), Some("Approval".into()), Some("Waiting".into()), "User".into())
        );
        assert_eq!(row(3), ("Planning".into(), None, None, "None".into()));
        // Rewritten to Planning by the repeated cleanup, then backfilled as a parked task.
        assert_eq!(row(4), ("Planning".into(), None, None, "None".into()));

        let (completion, requested): (Option<String>, Option<String>) = conn
            .query_row(
                "SELECT completion, execute_requested_at FROM tasks WHERE id = 5",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .expect("both columns must exist after migrating");
        assert_eq!(
            completion, None,
            "a pre-existing Done task must not be given a completion the board cannot know"
        );
        assert_eq!(requested, None, "no existing task was ever promised a slot");

        conn.execute(
            "INSERT INTO task_comments (task_id, kind, author, body, created_at) \
             VALUES (5, 'note', 'user', 'still here', '2026-01-02')",
            [],
        )
        .expect("the outcome thread must exist after migrating");

        // The thread is part of the task, so deleting the task takes it.
        conn.execute("PRAGMA foreign_keys = ON", []).unwrap();
        conn.execute("DELETE FROM tasks WHERE id = 5", []).unwrap();
        let orphans: i64 = conn
            .query_row("SELECT COUNT(*) FROM task_comments", [], |r| r.get(0))
            .unwrap();
        assert_eq!(orphans, 0, "comments must cascade with their task");
    }

    /// v25 → v26 turns a boolean into a three-way mode. Both values the boolean could hold have an
    /// exact counterpart, so no task may come out running somewhere it was not running before.
    #[test]
    fn test_migration_to_v26_maps_the_worktree_boolean_onto_a_mode() {
        let conn = Connection::open_in_memory().unwrap();
        initialize_schema(&conn).unwrap();

        // Put the tasks table back into its v25 shape.
        conn.execute_batch(
            "ALTER TABLE tasks DROP COLUMN workspace_mode;
             ALTER TABLE tasks DROP COLUMN workspace_worktree_id;
             ALTER TABLE tasks ADD COLUMN isolated_worktree INTEGER NOT NULL DEFAULT 1;",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO projects (id, name, path, created_at, updated_at) \
             VALUES (1, 'demo', '/tmp/demo', '2026-01-01', '2026-01-01')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO tasks (id, project_id, title, status, base_branch, isolated_worktree, created_at, updated_at) \
             VALUES (1, 1, 'isolated', 'Planning', 'main', 1, '2026-01-01', '2026-01-01'), \
                    (2, 1, 'in the repo', 'Planning', 'main', 0, '2026-01-01', '2026-01-01')",
            [],
        )
        .unwrap();

        conn.execute("PRAGMA user_version = 25", []).unwrap();
        initialize_schema(&conn).unwrap();

        let mode = |id: i32| -> String {
            conn.query_row("SELECT workspace_mode FROM tasks WHERE id = ?", [id], |r| {
                r.get(0)
            })
            .unwrap()
        };
        assert_eq!(mode(1), "NewWorktree");
        assert_eq!(mode(2), "RepositoryDirectory");

        let columns: Vec<String> = conn
            .prepare("PRAGMA table_info(tasks)")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect();
        assert!(
            !columns.contains(&"isolated_worktree".to_string()),
            "the boolean must be gone once the mode carries its meaning"
        );

        // Re-running the migration on an already-migrated database must be a no-op, not an error.
        conn.execute("PRAGMA user_version = 25", []).unwrap();
        initialize_schema(&conn).unwrap();
        assert_eq!(mode(2), "RepositoryDirectory");
    }

    /// v26 → v27 adds the branch choice. There is nothing to backfill, so the point of the test is
    /// that an existing task keeps its rows *and* comes out meaning what it meant before: create a
    /// branch, named from the task at spawn time.
    #[test]
    fn test_migration_to_v27_defaults_existing_tasks_to_a_generated_new_branch() {
        let conn = Connection::open_in_memory().unwrap();
        initialize_schema(&conn).unwrap();

        conn.execute_batch(
            "ALTER TABLE tasks DROP COLUMN workspace_branch_mode;
             ALTER TABLE tasks DROP COLUMN workspace_branch;",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO projects (id, name, path, created_at, updated_at) \
             VALUES (1, 'demo', '/tmp/demo', '2026-01-01', '2026-01-01')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO tasks (id, project_id, title, status, base_branch, created_at, updated_at) \
             VALUES (1, 1, 'existing', 'Planning', 'main', '2026-01-01', '2026-01-01')",
            [],
        )
        .unwrap();

        conn.execute("PRAGMA user_version = 26", []).unwrap();
        initialize_schema(&conn).unwrap();

        let row: (String, Option<String>) = conn
            .query_row(
                "SELECT workspace_branch_mode, workspace_branch FROM tasks WHERE id = 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(row.0, "Create");
        assert_eq!(row.1, None, "a NULL name is what keeps the name generated at spawn");

        // Re-running the migration on an already-migrated database must be a no-op, not an error.
        conn.execute("PRAGMA user_version = 26", []).unwrap();
        initialize_schema(&conn).unwrap();
        assert_eq!(
            conn.query_row::<String, _, _>(
                "SELECT workspace_branch_mode FROM tasks WHERE id = 1",
                [],
                |r| r.get(0)
            )
            .unwrap(),
            "Create"
        );
    }

    #[test]
    fn test_backup_written_only_when_migration_is_pending() {
        let dir = std::env::temp_dir().join(format!(
            "maestro-schema-backup-test-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let db_path = dir.join("maestro.db");
        let _ = std::fs::remove_file(&db_path);

        let conn = Connection::open(&db_path).unwrap();
        initialize_schema(&conn).unwrap();

        // Already current: nothing to snapshot.
        assert!(backup_before_migration(&conn, &db_path).unwrap().is_none());

        conn.execute("PRAGMA user_version = 22", []).unwrap();
        let backup = backup_before_migration(&conn, &db_path)
            .unwrap()
            .expect("a pending migration must produce a backup");

        assert!(backup.exists(), "backup file should be on disk");
        assert!(
            backup.file_name().unwrap().to_string_lossy().contains("bak-v22"),
            "backup name should record the version it came from: {}",
            backup.display()
        );

        // The snapshot must be a usable database, not a truncated file.
        let restored = Connection::open(&backup).unwrap();
        let table_count: i64 = restored
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='projects'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(table_count, 1, "backup should contain the schema");

        drop(restored);
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
