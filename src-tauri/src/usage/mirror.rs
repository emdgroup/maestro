//! The app's copy of each connection's usage tables, and the views every chart reads.
//!
//! A server's `projects.db` is a **store**, named by the random id its server sends with every
//! answer. Rows are kept per store rather than per connection, so a store that was recreated (a
//! WSL distro or a container rebuilt) leaves its history here under its old id while the new one
//! syncs from scratch. A store whose connection no longer exists is a removed connection's: its
//! rows stay, under the name the connection had when it last synced.
//!
//! The copy follows the server's retention rule, turns merged into UTC hours after 90 days, so a
//! sync from scratch gives back the same data.

use chrono::{DateTime, Duration, Utc};
use maestro_protocol::{UsageHoursResponse, UsageTokens, UsageTurnsResponse};
use rusqlite::{params, Connection};
use std::sync::atomic::{AtomicI64, Ordering};

use crate::acp::ConnectionKey;

pub const V33_USAGE_MIRROR: &str = r#"
CREATE TABLE IF NOT EXISTS usage_stores (
    store_id          TEXT PRIMARY KEY,
    -- `local`, `ssh:3`, `wsl:2`, `docker:1`: what Home calls the connection.
    connection_key    TEXT NOT NULL,
    -- The connection's name at the last sync, for when it has been removed.
    connection_name   TEXT NOT NULL,
    last_turn_id      INTEGER NOT NULL DEFAULT 0,
    -- The server's merged_through_id when the hours were copied.
    merged_through_id INTEGER NOT NULL DEFAULT 0,
    -- Whether the hourly history has been copied: a sync from scratch starts with it.
    hours_done        INTEGER NOT NULL DEFAULT 0,
    -- RFC 3339.
    synced_at         TEXT
);

CREATE TABLE IF NOT EXISTS usage_turns (
    store_id            TEXT NOT NULL REFERENCES usage_stores(store_id) ON DELETE CASCADE,
    id                  INTEGER NOT NULL,
    agent_id            TEXT NOT NULL,
    acp_session_id      TEXT NOT NULL,
    project_path        TEXT NOT NULL,
    model_id            TEXT,
    started_at          TEXT NOT NULL,
    ended_at            TEXT NOT NULL,
    total_tokens        INTEGER,
    input_tokens        INTEGER,
    output_tokens       INTEGER,
    thought_tokens      INTEGER,
    cached_read_tokens  INTEGER,
    cached_write_tokens INTEGER,
    cost_amount         REAL,
    cost_currency       TEXT,
    PRIMARY KEY (store_id, id)
);

CREATE INDEX IF NOT EXISTS usage_turns_by_time ON usage_turns(started_at);

CREATE TABLE IF NOT EXISTS usage_turn_models (
    store_id            TEXT NOT NULL,
    turn_id             INTEGER NOT NULL,
    model               TEXT NOT NULL,
    input_tokens        INTEGER,
    output_tokens       INTEGER,
    thought_tokens      INTEGER,
    cached_read_tokens  INTEGER,
    cached_write_tokens INTEGER,
    PRIMARY KEY (store_id, turn_id, model),
    FOREIGN KEY (store_id, turn_id) REFERENCES usage_turns(store_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS usage_hourly (
    store_id            TEXT NOT NULL REFERENCES usage_stores(store_id) ON DELETE CASCADE,
    hour                TEXT NOT NULL,
    agent_id            TEXT NOT NULL,
    project_path        TEXT NOT NULL,
    model_id            TEXT NOT NULL,
    cost_currency       TEXT NOT NULL,
    turns               INTEGER NOT NULL,
    sessions            INTEGER NOT NULL,
    active_seconds      INTEGER NOT NULL,
    total_tokens        INTEGER,
    input_tokens        INTEGER,
    output_tokens       INTEGER,
    thought_tokens      INTEGER,
    cached_read_tokens  INTEGER,
    cached_write_tokens INTEGER,
    cost_amount         REAL,
    PRIMARY KEY (store_id, hour, agent_id, project_path, model_id, cost_currency)
);

CREATE TABLE IF NOT EXISTS usage_hourly_models (
    store_id            TEXT NOT NULL REFERENCES usage_stores(store_id) ON DELETE CASCADE,
    hour                TEXT NOT NULL,
    agent_id            TEXT NOT NULL,
    project_path        TEXT NOT NULL,
    model               TEXT NOT NULL,
    input_tokens        INTEGER,
    output_tokens       INTEGER,
    thought_tokens      INTEGER,
    cached_read_tokens  INTEGER,
    cached_write_tokens INTEGER,
    PRIMARY KEY (store_id, hour, agent_id, project_path, model)
);

-- Turns and hours in one shape, so a chart is one GROUP BY. `at` is UTC; '' is an unknown model
-- or currency, as in the hours. `turn_id` is null on an hour.
CREATE VIEW IF NOT EXISTS usage_facts AS
SELECT store_id, id AS turn_id, started_at AS at, agent_id, project_path,
       COALESCE(model_id, '') AS model_id,
       COALESCE(cost_currency, '') AS cost_currency, 1 AS turns, total_tokens, input_tokens,
       output_tokens, thought_tokens, cached_read_tokens, cached_write_tokens, cost_amount
FROM usage_turns
UNION ALL
SELECT store_id, NULL, hour, agent_id, project_path, model_id, cost_currency, turns, total_tokens,
       input_tokens, output_tokens, thought_tokens, cached_read_tokens, cached_write_tokens,
       cost_amount
FROM usage_hourly;

-- Agents name models two ways: the session's selected id (`opus`) and, per turn, the models they
-- report using (`claude-opus-5-5[1m]`). A model is one name: the reported one, without the
-- context-window suffix. A selected id stands for the reported model it spent the most tokens on,
-- learned from the turns and hours that carry both.
CREATE VIEW IF NOT EXISTS usage_model_aliases AS
SELECT agent_id, model_id, model FROM (
    SELECT agent_id, model_id, model,
           ROW_NUMBER() OVER (PARTITION BY agent_id, model_id
                              ORDER BY SUM(tokens) DESC, model) AS rank
    FROM (
        SELECT t.agent_id, t.model_id,
               CASE WHEN instr(m.model, '[') > 0 THEN rtrim(substr(m.model, 1, instr(m.model, '[') - 1))
            ELSE m.model END AS model,
               COALESCE(m.input_tokens, 0) + COALESCE(m.output_tokens, 0)
           + COALESCE(m.thought_tokens, 0) + COALESCE(m.cached_read_tokens, 0)
           + COALESCE(m.cached_write_tokens, 0) AS tokens
        FROM usage_turn_models m
        JOIN usage_turns t ON t.store_id = m.store_id AND t.id = m.turn_id
        WHERE t.model_id IS NOT NULL
        UNION ALL
        SELECT h.agent_id, h.model_id,
               CASE WHEN instr(m.model, '[') > 0 THEN rtrim(substr(m.model, 1, instr(m.model, '[') - 1))
            ELSE m.model END,
               COALESCE(m.input_tokens, 0) + COALESCE(m.output_tokens, 0)
           + COALESCE(m.thought_tokens, 0) + COALESCE(m.cached_read_tokens, 0)
           + COALESCE(m.cached_write_tokens, 0)
        FROM usage_hourly_models m
        JOIN usage_hourly h ON h.store_id = m.store_id AND h.hour = m.hour
                           AND h.agent_id = m.agent_id AND h.project_path = m.project_path
        WHERE h.model_id <> ''
    )
    GROUP BY agent_id, model_id, model
)
WHERE rank = 1;

-- Tokens per model. A turn the agent gave no per-model rows for counts for its selected id's
-- model, with the turn's own tokens; an hour with no model rows likewise. An hour that mixed
-- turns with and without model rows keeps only the model rows. `turn_id` is null on an hour.
CREATE VIEW IF NOT EXISTS usage_model_facts AS
SELECT m.store_id, m.turn_id, t.started_at AS at, t.agent_id, t.project_path,
       CASE WHEN instr(m.model, '[') > 0 THEN rtrim(substr(m.model, 1, instr(m.model, '[') - 1))
            ELSE m.model END AS model,
       m.input_tokens, m.output_tokens, m.thought_tokens, m.cached_read_tokens,
       m.cached_write_tokens
FROM usage_turn_models m JOIN usage_turns t ON t.store_id = m.store_id AND t.id = m.turn_id
UNION ALL
SELECT t.store_id, t.id, t.started_at, t.agent_id, t.project_path,
       COALESCE(a.model, t.model_id, ''), t.input_tokens, t.output_tokens, t.thought_tokens,
       t.cached_read_tokens, t.cached_write_tokens
FROM usage_turns t
LEFT JOIN usage_model_aliases a ON a.agent_id = t.agent_id AND a.model_id = t.model_id
WHERE NOT EXISTS (SELECT 1 FROM usage_turn_models m
                  WHERE m.store_id = t.store_id AND m.turn_id = t.id)
UNION ALL
SELECT store_id, NULL, hour, agent_id, project_path,
       CASE WHEN instr(model, '[') > 0 THEN rtrim(substr(model, 1, instr(model, '[') - 1))
            ELSE model END,
       input_tokens, output_tokens, thought_tokens, cached_read_tokens, cached_write_tokens
FROM usage_hourly_models
UNION ALL
SELECT h.store_id, NULL, h.hour, h.agent_id, h.project_path, COALESCE(a.model, h.model_id),
       h.input_tokens, h.output_tokens, h.thought_tokens, h.cached_read_tokens,
       h.cached_write_tokens
FROM usage_hourly h
LEFT JOIN usage_model_aliases a ON a.agent_id = h.agent_id AND a.model_id = h.model_id
WHERE NOT EXISTS (SELECT 1 FROM usage_hourly_models m
                  WHERE m.store_id = h.store_id AND m.hour = h.hour
                    AND m.agent_id = h.agent_id AND m.project_path = h.project_path);
"#;

/// How long a turn is kept whole before it is merged into its hour, as on the server.
const TURN_RETENTION_DAYS: i64 = 90;

const TOKENS: [&str; 6] = [
    "total_tokens",
    "input_tokens",
    "output_tokens",
    "thought_tokens",
    "cached_read_tokens",
    "cached_write_tokens",
];

/// What Home calls a connection, and what the mirror files its stores under.
pub fn connection_key_id(connection: ConnectionKey) -> String {
    match connection {
        ConnectionKey::Local => "local".to_string(),
        ConnectionKey::Ssh { id } => format!("ssh:{id}"),
        ConnectionKey::Wsl { id } => format!("wsl:{id}"),
        ConnectionKey::Docker { id } => format!("docker:{id}"),
    }
}

/// The name Home shows for a connection.
pub fn connection_name(conn: &Connection, connection: ConnectionKey) -> rusqlite::Result<String> {
    let (sql, id) = match connection {
        ConnectionKey::Local => return Ok("This computer".to_string()),
        ConnectionKey::Ssh { id } => (
            "SELECT COALESCE(display_name, host) FROM ssh_connections WHERE id = ?1",
            id,
        ),
        ConnectionKey::Wsl { id } => (
            "SELECT COALESCE(display_name, distro_name) FROM wsl_connections WHERE id = ?1",
            id,
        ),
        ConnectionKey::Docker { id } => (
            "SELECT COALESCE(display_name, container_name) FROM docker_connections WHERE id = ?1",
            id,
        ),
    };
    conn.query_row(sql, [id], |r| r.get(0))
}

#[derive(Debug, Clone, PartialEq)]
pub struct Store {
    pub store_id: String,
    pub last_turn_id: i64,
    pub merged_through_id: i64,
    pub hours_done: bool,
}

impl Store {
    /// Whether the copy must start over: the hours were never copied whole, or the server has
    /// merged turns into hours that this copy never received as turns.
    pub fn needs_full_sync(&self, merged_through_id: i64) -> bool {
        !self.hours_done || merged_through_id > self.last_turn_id.max(self.merged_through_id)
    }
}

/// The store a server named, created on first sight. Its connection and name are refreshed.
pub fn adopt_store(
    conn: &Connection,
    store_id: &str,
    connection_key: &str,
    connection_name: &str,
) -> rusqlite::Result<Store> {
    conn.execute(
        "INSERT INTO usage_stores (store_id, connection_key, connection_name) VALUES (?1, ?2, ?3)
         ON CONFLICT (store_id) DO UPDATE SET connection_key = excluded.connection_key,
                                              connection_name = excluded.connection_name",
        params![store_id, connection_key, connection_name],
    )?;
    conn.query_row(
        "SELECT store_id, last_turn_id, merged_through_id, hours_done FROM usage_stores
         WHERE store_id = ?1",
        [store_id],
        |r| {
            Ok(Store {
                store_id: r.get(0)?,
                last_turn_id: r.get(1)?,
                merged_through_id: r.get(2)?,
                hours_done: r.get(3)?,
            })
        },
    )
}

/// Empty a store's copy, ready for a sync from scratch.
pub fn reset_store(conn: &Connection, store_id: &str) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    for table in ["usage_turns", "usage_hourly", "usage_hourly_models"] {
        tx.execute(
            &format!("DELETE FROM {table} WHERE store_id = ?1"),
            [store_id],
        )?;
    }
    tx.execute(
        "UPDATE usage_stores SET last_turn_id = 0, merged_through_id = 0, hours_done = 0
         WHERE store_id = ?1",
        [store_id],
    )?;
    tx.commit()
}

fn token_params(tokens: &UsageTokens) -> [Option<i64>; 6] {
    [
        tokens.total_tokens,
        tokens.input_tokens,
        tokens.output_tokens,
        tokens.thought_tokens,
        tokens.cached_read_tokens,
        tokens.cached_write_tokens,
    ]
}

/// Copy one page of hours. Pages never split an hour, and the store starts empty, so a plain
/// insert is enough.
pub fn save_hours(
    conn: &Connection,
    store_id: &str,
    page: &UsageHoursResponse,
) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    for h in &page.hours {
        let [total, input, output, thought, read, write] = token_params(&h.tokens);
        tx.execute(
            "INSERT OR REPLACE INTO usage_hourly VALUES
             (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
            params![
                store_id,
                h.hour,
                h.agent_id,
                h.project_path,
                h.model_id,
                h.cost_currency,
                h.turns,
                h.sessions,
                h.active_seconds,
                total,
                input,
                output,
                thought,
                read,
                write,
                h.cost_amount
            ],
        )?;
    }
    for m in &page.models {
        let [_, input, output, thought, read, write] = token_params(&m.tokens);
        tx.execute(
            "INSERT OR REPLACE INTO usage_hourly_models VALUES
             (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                store_id,
                m.hour,
                m.agent_id,
                m.project_path,
                m.model,
                input,
                output,
                thought,
                read,
                write
            ],
        )?;
    }
    tx.commit()
}

/// The hours are copied: turns come next, from the first.
pub fn finish_hours(
    conn: &Connection,
    store_id: &str,
    merged_through_id: i64,
) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE usage_stores SET hours_done = 1, merged_through_id = ?2, last_turn_id = 0
         WHERE store_id = ?1",
        params![store_id, merged_through_id],
    )
    .map(drop)
}

/// Copy one page of turns and move the store's cursor past it.
pub fn save_turns(
    conn: &Connection,
    store_id: &str,
    page: &UsageTurnsResponse,
    now: DateTime<Utc>,
) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    for t in &page.turns {
        let [total, input, output, thought, read, write] = token_params(&t.tokens);
        tx.execute(
            "INSERT OR IGNORE INTO usage_turns VALUES
             (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
            params![
                store_id,
                t.id,
                t.agent_id,
                t.acp_session_id,
                t.project_path,
                t.model_id,
                t.started_at,
                t.ended_at,
                total,
                input,
                output,
                thought,
                read,
                write,
                t.cost_amount,
                t.cost_currency
            ],
        )?;
    }
    for m in &page.models {
        let [_, input, output, thought, read, write] = token_params(&m.tokens);
        tx.execute(
            "INSERT OR IGNORE INTO usage_turn_models VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![store_id, m.turn_id, m.model, input, output, thought, read, write],
        )?;
    }
    tx.execute(
        "UPDATE usage_stores SET last_turn_id = MAX(last_turn_id, ?2), synced_at = ?3
         WHERE store_id = ?1",
        params![
            store_id,
            page.turns.last().map_or(0, |t| t.id),
            now.to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
        ],
    )?;
    tx.commit()
}

/// Merge turns older than the retention into their hours, at most once a day per process, as the
/// server does with its own.
pub fn merge_old_daily(conn: &Connection, now: DateTime<Utc>) -> rusqlite::Result<()> {
    static LAST_MERGE_DAY: AtomicI64 = AtomicI64::new(i64::MIN);
    let today = now.timestamp().div_euclid(86_400);
    if LAST_MERGE_DAY.swap(today, Ordering::Relaxed) == today {
        return Ok(());
    }
    merge_old(conn, now)
}

/// `SET` clauses adding a merge to the hour already there, keeping null only where both are.
fn add_to_existing(columns: &[&str]) -> String {
    columns
        .iter()
        .map(|c| format!("{c} = COALESCE({c} + excluded.{c}, {c}, excluded.{c})"))
        .collect::<Vec<_>>()
        .join(", ")
}

/// The server's `merge_old`, per store.
fn merge_old(conn: &Connection, now: DateTime<Utc>) -> rusqlite::Result<()> {
    let cutoff = (now - Duration::days(TURN_RETENTION_DAYS))
        .format("%Y-%m-%dT%H:00:00Z")
        .to_string();
    let sums = |prefix: &str, columns: &[&str]| {
        columns
            .iter()
            .map(|c| format!("SUM({prefix}{c})"))
            .collect::<Vec<_>>()
            .join(", ")
    };
    let mut hourly_added = vec!["turns", "sessions", "active_seconds", "cost_amount"];
    hourly_added.extend(TOKENS);
    let model_tokens = &TOKENS[1..];
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        &format!(
            "INSERT INTO usage_hourly (store_id, hour, agent_id, project_path, model_id,
                                       cost_currency, turns, sessions, active_seconds, {tokens},
                                       cost_amount)
             SELECT store_id, strftime('%Y-%m-%dT%H:00:00Z', started_at), agent_id, project_path,
                    COALESCE(model_id, ''), COALESCE(cost_currency, ''), COUNT(*),
                    COUNT(DISTINCT acp_session_id),
                    SUM(unixepoch(ended_at) - unixepoch(started_at)), {sums}, SUM(cost_amount)
             FROM usage_turns WHERE started_at < ?1
             GROUP BY 1, 2, 3, 4, 5, 6
             ON CONFLICT (store_id, hour, agent_id, project_path, model_id, cost_currency)
             DO UPDATE SET {add}",
            tokens = TOKENS.join(", "),
            sums = sums("", &TOKENS),
            add = add_to_existing(&hourly_added),
        ),
        [&cutoff],
    )?;
    tx.execute(
        &format!(
            "INSERT INTO usage_hourly_models (store_id, hour, agent_id, project_path, model,
                                              {tokens})
             SELECT t.store_id, strftime('%Y-%m-%dT%H:00:00Z', t.started_at), t.agent_id,
                    t.project_path, m.model, {sums}
             FROM usage_turn_models m
             JOIN usage_turns t ON t.store_id = m.store_id AND t.id = m.turn_id
             WHERE t.started_at < ?1
             GROUP BY 1, 2, 3, 4, 5
             ON CONFLICT (store_id, hour, agent_id, project_path, model) DO UPDATE SET {add}",
            tokens = model_tokens.join(", "),
            sums = sums("m.", model_tokens),
            add = add_to_existing(model_tokens),
        ),
        [&cutoff],
    )?;
    tx.execute("DELETE FROM usage_turns WHERE started_at < ?1", [&cutoff])?;
    tx.commit()
}

#[cfg(test)]
mod tests {
    use super::*;
    use maestro_protocol::{
        UsageHourModelRow, UsageHourRow, UsageTurnModelRow, UsageTurnRow, UsageTurnsResponse,
    };

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::core::schema::initialize_schema(&conn).unwrap();
        conn
    }

    fn tokens(total: i64) -> UsageTokens {
        UsageTokens {
            total_tokens: Some(total),
            input_tokens: Some(total),
            ..Default::default()
        }
    }

    fn turn(id: i64, started_at: DateTime<Utc>, total: i64, cost: f64) -> UsageTurnRow {
        UsageTurnRow {
            id,
            agent_id: "claude-acp".into(),
            acp_session_id: "s".into(),
            project_path: "/p".into(),
            model_id: Some("opus".into()),
            started_at: started_at.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
            ended_at: (started_at + Duration::seconds(30))
                .to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
            tokens: tokens(total),
            cost_amount: Some(cost),
            cost_currency: Some("USD".into()),
        }
    }

    fn page(turns: Vec<UsageTurnRow>, models: Vec<UsageTurnModelRow>) -> UsageTurnsResponse {
        UsageTurnsResponse {
            store_id: "a".into(),
            merged_through_id: 0,
            turns,
            models,
            more: false,
        }
    }

    fn one<T: rusqlite::types::FromSql>(conn: &Connection, sql: &str) -> T {
        conn.query_row(sql, [], |r| r.get(0)).unwrap()
    }

    #[test]
    fn a_store_keeps_its_cursor_and_a_new_id_starts_another() {
        let conn = db();
        let now = Utc::now();
        let store = adopt_store(&conn, "a", "ssh:1", "devbox").unwrap();
        assert!(store.needs_full_sync(0), "the hours were never copied");
        finish_hours(&conn, "a", 0).unwrap();
        save_turns(
            &conn,
            "a",
            &page(vec![turn(1, now, 10, 0.1), turn(2, now, 20, 0.2)], vec![]),
            now,
        )
        .unwrap();

        let store = adopt_store(&conn, "a", "ssh:1", "renamed").unwrap();
        assert_eq!(store.last_turn_id, 2);
        assert!(!store.needs_full_sync(2), "merged only turns it has");
        assert!(store.needs_full_sync(3), "turn 3 went into an hour unseen");
        assert_eq!(
            one::<String>(&conn, "SELECT connection_name FROM usage_stores"),
            "renamed"
        );

        let fresh = adopt_store(&conn, "b", "ssh:1", "renamed").unwrap();
        assert_eq!(fresh.last_turn_id, 0);
        assert_eq!(
            one::<i64>(&conn, "SELECT COUNT(*) FROM usage_turns"),
            2,
            "a's history stays"
        );

        reset_store(&conn, "a").unwrap();
        assert_eq!(one::<i64>(&conn, "SELECT COUNT(*) FROM usage_turns"), 0);
        assert!(adopt_store(&conn, "a", "ssh:1", "x")
            .unwrap()
            .needs_full_sync(0));
    }

    #[test]
    fn the_views_add_up_and_survive_the_merge() {
        let conn = db();
        let now = Utc::now();
        let old = now - Duration::days(100);
        adopt_store(&conn, "a", "local", "This computer").unwrap();
        save_hours(
            &conn,
            "a",
            &UsageHoursResponse {
                store_id: "a".into(),
                hours: vec![UsageHourRow {
                    hour: "2025-01-01T10:00:00Z".into(),
                    agent_id: "claude-acp".into(),
                    project_path: "/p".into(),
                    model_id: "opus".into(),
                    cost_currency: "USD".into(),
                    turns: 4,
                    sessions: 2,
                    active_seconds: 120,
                    tokens: tokens(1000),
                    cost_amount: Some(4.0),
                }],
                models: vec![UsageHourModelRow {
                    hour: "2025-01-01T10:00:00Z".into(),
                    agent_id: "claude-acp".into(),
                    project_path: "/p".into(),
                    model: "claude-opus".into(),
                    tokens: UsageTokens {
                        input_tokens: Some(1000),
                        ..Default::default()
                    },
                }],
                more: false,
            },
        )
        .unwrap();
        finish_hours(&conn, "a", 0).unwrap();
        save_turns(
            &conn,
            "a",
            &page(
                vec![turn(1, old, 100, 1.0), turn(2, now, 200, 2.0)],
                vec![UsageTurnModelRow {
                    turn_id: 1,
                    model: "claude-opus".into(),
                    tokens: UsageTokens {
                        input_tokens: Some(100),
                        ..Default::default()
                    },
                }],
            ),
            now,
        )
        .unwrap();

        let totals = |conn: &Connection| -> (i64, f64, i64) {
            conn.query_row(
                "SELECT SUM(turns), SUM(cost_amount), SUM(total_tokens) FROM usage_facts",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap()
        };
        let models = |conn: &Connection| -> Vec<(String, i64)> {
            conn.prepare(
                "SELECT model, SUM(input_tokens) FROM usage_model_facts GROUP BY 1 ORDER BY 1",
            )
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
        };
        let before = totals(&conn);
        assert_eq!(before, (6, 7.0, 1300));
        let by_model = models(&conn);
        assert_eq!(
            by_model,
            [("claude-opus".to_string(), 1300)],
            "turn 2 has no model rows: its selected opus is what opus turned out to be"
        );

        merge_old(&conn, now).unwrap();
        assert_eq!(one::<i64>(&conn, "SELECT COUNT(*) FROM usage_turns"), 1);
        assert_eq!(totals(&conn), before);
        assert_eq!(models(&conn), by_model);
    }
}
