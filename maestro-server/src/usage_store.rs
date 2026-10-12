//! What each turn used, kept for usage charts.
//!
//! One row per prompt turn in `usage_turns`, with the models the agent says it used in
//! `usage_turn_models`. Turns older than [`TURN_RETENTION_DAYS`] are merged into hourly totals
//! rather than deleted: history stays for charts and the turn table stays small. Hours are UTC, so a
//! chart can show them in whatever timezone it is read in.
//!
//! The daemon records turns, not the app: an automation's or a task's turns happen with no window
//! open.

use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{LazyLock, Mutex};

use chrono::{DateTime, Duration, SecondsFormat, Utc};
use maestro_protocol::TurnUsage;
use rusqlite::{params, Connection};
use serde_json::Value;

pub const V10_USAGE: &str = "
-- One row per prompt turn. It carries the session's identity rather than referencing its row,
-- because closed sessions are dropped after 90 days and their usage is not.
CREATE TABLE IF NOT EXISTS usage_turns (
    id                  INTEGER PRIMARY KEY,
    agent_id            TEXT NOT NULL,
    acp_session_id      TEXT NOT NULL,
    project_path        TEXT NOT NULL,
    role                TEXT,
    -- The model selected in the session when the turn ended, as the agent names it.
    model_id            TEXT,
    started_at          TEXT NOT NULL,
    ended_at            TEXT NOT NULL,
    stop_reason         TEXT NOT NULL,
    -- PromptResponse.usage exactly as the agent reported it. Null when it did not.
    total_tokens        INTEGER,
    input_tokens        INTEGER,
    output_tokens       INTEGER,
    thought_tokens      INTEGER,
    cached_read_tokens  INTEGER,
    cached_write_tokens INTEGER,
    -- What the turn added to the session's cumulative usage_update cost. Null when unknown.
    cost_amount         REAL,
    cost_currency       TEXT,
    context_used        INTEGER,
    context_size        INTEGER
);

CREATE INDEX IF NOT EXISTS usage_turns_by_time ON usage_turns(started_at);

-- The models the agent says it used in a turn, from _meta.quota.model_usage.
CREATE TABLE IF NOT EXISTS usage_turn_models (
    turn_id             INTEGER NOT NULL REFERENCES usage_turns(id) ON DELETE CASCADE,
    model               TEXT NOT NULL,
    input_tokens        INTEGER,
    output_tokens       INTEGER,
    thought_tokens      INTEGER,
    cached_read_tokens  INTEGER,
    cached_write_tokens INTEGER,
    PRIMARY KEY (turn_id, model)
);

-- Turns past retention, summed per UTC hour. '' stands for an unknown model or currency, which a
-- key cannot hold as null.
CREATE TABLE IF NOT EXISTS usage_hourly (
    hour                TEXT NOT NULL,
    agent_id            TEXT NOT NULL,
    project_path        TEXT NOT NULL,
    model_id            TEXT NOT NULL,
    cost_currency       TEXT NOT NULL,
    turns               INTEGER NOT NULL,
    -- Distinct sessions with a turn in the hour, so not additive across hours.
    sessions            INTEGER NOT NULL,
    active_seconds      INTEGER NOT NULL,
    total_tokens        INTEGER,
    input_tokens        INTEGER,
    output_tokens       INTEGER,
    thought_tokens      INTEGER,
    cached_read_tokens  INTEGER,
    cached_write_tokens INTEGER,
    cost_amount         REAL,
    PRIMARY KEY (hour, agent_id, project_path, model_id, cost_currency)
);

CREATE TABLE IF NOT EXISTS usage_hourly_models (
    hour                TEXT NOT NULL,
    agent_id            TEXT NOT NULL,
    project_path        TEXT NOT NULL,
    model               TEXT NOT NULL,
    input_tokens        INTEGER,
    output_tokens       INTEGER,
    thought_tokens      INTEGER,
    cached_read_tokens  INTEGER,
    cached_write_tokens INTEGER,
    PRIMARY KEY (hour, agent_id, project_path, model)
);
";

/// What a mirror of this store needs to stay in step: an id that changes when the database is
/// recreated, and how far the merge into hours has reached.
pub const V11_USAGE_META: &str = "
CREATE TABLE IF NOT EXISTS usage_meta (
    id                  INTEGER PRIMARY KEY CHECK (id = 1),
    store_id            TEXT NOT NULL,
    -- The highest turn id merge_old has folded into an hour.
    merged_through_id   INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO usage_meta (id, store_id) VALUES (1, lower(hex(randomblob(16))));
";

/// How long a turn is kept whole before it is merged into its hour.
const TURN_RETENTION_DAYS: i64 = 90;

/// What the daemon follows of a live session between turns, to fill its next turn's row.
#[derive(Default)]
struct Meter {
    model_id: Option<String>,
    started_at: Option<DateTime<Utc>>,
    /// The session's cumulative cost when its last turn ended, which the next turn is measured
    /// from. `None` while unknown.
    cost_base: Option<f64>,
    /// The latest cumulative cost the agent reported, with its currency.
    cost: Option<(f64, String)>,
    /// The latest context window reading, `(used, size)`.
    context: Option<(u64, u64)>,
}

/// What a turn's row takes from its session's meter.
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct TurnMeter {
    pub model_id: Option<String>,
    pub started_at: Option<DateTime<Utc>>,
    /// What this turn spent, not the session's total.
    pub cost: Option<(f64, String)>,
    pub context: Option<(u64, u64)>,
}

static METERS: LazyLock<Mutex<HashMap<String, Meter>>> = LazyLock::new(Default::default);

fn with_meter(session_id: &str, f: impl FnOnce(&mut Meter)) {
    if let Ok(mut meters) = METERS.lock() {
        f(meters.entry(session_id.to_string()).or_default());
    }
}

/// A session came up. A new one has spent nothing yet. A loaded one may have, and whether its
/// agent's first cumulative cost includes what was spent before the load is the agent's business,
/// so the turn that reports it records no cost rather than a guess.
pub(crate) fn note_session(session_id: &str, loaded: bool, model_id: Option<String>) {
    with_meter(session_id, |m| {
        *m = Meter {
            model_id,
            cost_base: (!loaded).then_some(0.0),
            ..Default::default()
        };
    });
}

pub(crate) fn note_model(session_id: &str, model_id: &str) {
    with_meter(session_id, |m| m.model_id = Some(model_id.to_string()));
}

pub(crate) fn note_turn_started(session_id: &str) {
    with_meter(session_id, |m| {
        m.started_at = Some(Utc::now());
        // A cost reported before any turn came with the load: it is what the session had spent.
        if m.cost_base.is_none() {
            m.cost_base = m.cost.as_ref().map(|(total, _)| *total);
        }
    });
}

/// Follow the agent's `usage_update` and model changes.
pub(crate) fn note_update(session_id: &str, payload: &Value) {
    match payload.get("sessionUpdate").and_then(Value::as_str) {
        Some("usage_update") => with_meter(session_id, |m| {
            if let (Some(used), Some(size)) = (payload["used"].as_u64(), payload["size"].as_u64()) {
                m.context = Some((used, size));
            }
            let cost = &payload["cost"];
            if let (Some(total), Some(currency)) =
                (cost["amount"].as_f64(), cost["currency"].as_str())
            {
                m.cost = Some((total, currency.to_string()));
            }
        }),
        Some("config_option_update") => {
            let model = payload["configOptions"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|option| option["id"] == "model")
                .and_then(|option| option["currentValue"].as_str());
            if let Some(model) = model {
                note_model(session_id, model);
            }
        }
        _ => {}
    }
}

/// Read what the session's meter says about the turn that just ended, and start the next one.
pub(crate) fn take_turn(session_id: &str) -> TurnMeter {
    let Ok(mut meters) = METERS.lock() else {
        return TurnMeter::default();
    };
    let m = meters.entry(session_id.to_string()).or_default();
    let cost = match (m.cost_base, &m.cost) {
        // A total below the last one: the agent's process restarted and counts from zero again.
        (Some(base), Some((total, currency))) => Some((
            if *total >= base { total - base } else { *total },
            currency.clone(),
        )),
        _ => None,
    };
    if let Some((total, _)) = &m.cost {
        m.cost_base = Some(*total);
    }
    TurnMeter {
        model_id: m.model_id.clone(),
        started_at: m.started_at.take(),
        cost,
        context: m.context,
    }
}

/// The session's command loop ended.
pub(crate) fn forget(session_id: &str) {
    if let Ok(mut meters) = METERS.lock() {
        meters.remove(session_id);
    }
}

/// A finished turn, as its row records it.
pub(crate) struct Turn<'a> {
    pub agent_id: &'a str,
    pub acp_session_id: &'a str,
    pub project_path: String,
    pub role: Option<&'a str>,
    pub stop_reason: &'a str,
    pub meter: &'a TurnMeter,
    pub usage: Option<&'a TurnUsage>,
    pub model_usage: Option<&'a Value>,
}

impl<'a> Turn<'a> {
    /// A session with no project is filed under its working directory.
    pub(crate) fn of(
        session_id: &'a str,
        session: &'a crate::sessions::ActiveSession,
        ended: &'a crate::helpers::TurnEnd,
    ) -> Self {
        let project = session.project.as_ref();
        Turn {
            agent_id: &session.agent_id,
            acp_session_id: session
                .cleanup
                .as_ref()
                .map_or(session_id, |c| c.acp_session_id.as_str()),
            project_path: project.map_or_else(
                || session.cwd.clone(),
                |p| crate::automations::canonical_project_path(&p.project_path),
            ),
            role: project.and_then(|p| p.meta.role.as_deref()),
            stop_reason: &ended.stop_reason,
            meter: &ended.meter,
            usage: ended.usage.as_ref(),
            model_usage: ended.model_usage.as_ref(),
        }
    }
}

fn stamp(time: DateTime<Utc>) -> String {
    time.to_rfc3339_opts(SecondsFormat::Secs, true)
}

/// Record a turn, and merge old turns into their hours once a day: on a turn, because a turn is
/// the only thing that adds rows, and a daemon on a server may never restart.
pub(crate) fn record(conn: &Connection, turn: &Turn, now: DateTime<Utc>) -> Result<(), String> {
    let fail = |e: rusqlite::Error| format!("cannot record a turn's usage: {e}");
    let usage = turn.usage;
    let (cost_amount, cost_currency) = turn.meter.cost.clone().unzip();
    let (context_used, context_size) = turn.meter.context.unzip();
    // Token counts fit SQLite's signed integers many times over.
    let int = |n: Option<u64>| n.map(|n| n as i64);
    let tx = conn.unchecked_transaction().map_err(fail)?;
    tx.execute(
        "INSERT INTO usage_turns (agent_id, acp_session_id, project_path, role, model_id,
                                  started_at, ended_at, stop_reason, total_tokens, input_tokens,
                                  output_tokens, thought_tokens, cached_read_tokens,
                                  cached_write_tokens, cost_amount, cost_currency, context_used,
                                  context_size)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)",
        params![
            turn.agent_id,
            turn.acp_session_id,
            turn.project_path,
            turn.role,
            turn.meter.model_id,
            stamp(turn.meter.started_at.unwrap_or(now)),
            stamp(now),
            turn.stop_reason,
            int(usage.map(|u| u.total_tokens)),
            int(usage.map(|u| u.input_tokens)),
            int(usage.map(|u| u.output_tokens)),
            int(usage.and_then(|u| u.thought_tokens)),
            int(usage.and_then(|u| u.cached_read_tokens)),
            int(usage.and_then(|u| u.cached_write_tokens)),
            cost_amount,
            cost_currency,
            int(context_used),
            int(context_size),
        ],
    )
    .map_err(fail)?;
    let turn_id = tx.last_insert_rowid();
    for row in model_rows(turn.model_usage) {
        tx.execute(
            "INSERT OR IGNORE INTO usage_turn_models VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                turn_id,
                row.model,
                row.input,
                row.output,
                row.thought,
                row.cached_read,
                row.cached_write
            ],
        )
        .map_err(fail)?;
    }
    tx.commit().map_err(fail)?;

    static LAST_MERGE_DAY: AtomicI64 = AtomicI64::new(i64::MIN);
    let today = now.timestamp().div_euclid(86_400);
    if LAST_MERGE_DAY.swap(today, Ordering::Relaxed) != today {
        merge_old(conn, now)?;
    }
    Ok(())
}

struct ModelRow {
    model: String,
    input: Option<i64>,
    output: Option<i64>,
    thought: Option<i64>,
    cached_read: Option<i64>,
    cached_write: Option<i64>,
}

/// `_meta.quota.model_usage`, whose field names differ by agent: camelCase from Claude and Codex,
/// snake_case from Gemini, and a different name for cache writes from each.
fn model_rows(model_usage: Option<&Value>) -> Vec<ModelRow> {
    let count = |c: &Value, keys: &[&str]| keys.iter().find_map(|k| c.get(*k)?.as_i64());
    model_usage
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            let c = entry.get("token_count")?;
            Some(ModelRow {
                model: entry.get("model")?.as_str()?.to_string(),
                input: count(c, &["inputTokens", "input_tokens"]),
                output: count(c, &["outputTokens", "output_tokens"]),
                thought: count(c, &["reasoningOutputTokens", "reasoning_output_tokens"]),
                cached_read: count(c, &["cachedInputTokens", "cached_input_tokens"]),
                cached_write: count(
                    c,
                    &[
                        "cachedWriteTokens",
                        "cacheWriteInputTokens",
                        "cache_write_input_tokens",
                    ],
                ),
            })
        })
        .collect()
}

const TOKENS: [&str; 6] = [
    "total_tokens",
    "input_tokens",
    "output_tokens",
    "thought_tokens",
    "cached_read_tokens",
    "cached_write_tokens",
];

/// `SET` clauses adding a merge to the hour already there, keeping null only where both are.
fn add_to_existing(columns: &[&str]) -> String {
    columns
        .iter()
        .map(|c| format!("{c} = COALESCE({c} + excluded.{c}, {c}, excluded.{c})"))
        .collect::<Vec<_>>()
        .join(", ")
}

/// Merge every turn that started before the hour [`TURN_RETENTION_DAYS`] ago into its hour, and
/// drop it.
pub(crate) fn merge_old(conn: &Connection, now: DateTime<Utc>) -> Result<(), String> {
    let fail = |e: rusqlite::Error| format!("cannot merge old usage into hours: {e}");
    let cutoff = (now - Duration::days(TURN_RETENTION_DAYS))
        .format("%Y-%m-%dT%H:00:00Z")
        .to_string();
    let hour = "strftime('%Y-%m-%dT%H:00:00Z', started_at)";
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
    let tx = conn.unchecked_transaction().map_err(fail)?;
    tx.execute(
        &format!(
            "INSERT INTO usage_hourly (hour, agent_id, project_path, model_id, cost_currency,
                                       turns, sessions, active_seconds, {tokens}, cost_amount)
             SELECT {hour}, agent_id, project_path, COALESCE(model_id, ''),
                    COALESCE(cost_currency, ''), COUNT(*), COUNT(DISTINCT acp_session_id),
                    SUM(unixepoch(ended_at) - unixepoch(started_at)), {sums}, SUM(cost_amount)
             FROM usage_turns WHERE started_at < ?1
             GROUP BY 1, 2, 3, 4, 5
             ON CONFLICT (hour, agent_id, project_path, model_id, cost_currency)
             DO UPDATE SET {add}",
            tokens = TOKENS.join(", "),
            sums = sums("", &TOKENS),
            add = add_to_existing(&hourly_added),
        ),
        params![cutoff],
    )
    .map_err(fail)?;
    tx.execute(
        &format!(
            "INSERT INTO usage_hourly_models (hour, agent_id, project_path, model, {tokens})
             SELECT strftime('%Y-%m-%dT%H:00:00Z', t.started_at), t.agent_id, t.project_path,
                    m.model, {sums}
             FROM usage_turn_models m JOIN usage_turns t ON t.id = m.turn_id
             WHERE t.started_at < ?1
             GROUP BY 1, 2, 3, 4
             ON CONFLICT (hour, agent_id, project_path, model) DO UPDATE SET {add}",
            tokens = model_tokens.join(", "),
            sums = sums("m.", model_tokens),
            add = add_to_existing(model_tokens),
        ),
        params![cutoff],
    )
    .map_err(fail)?;
    tx.execute(
        "UPDATE usage_meta SET merged_through_id = MAX(merged_through_id,
             COALESCE((SELECT MAX(id) FROM usage_turns WHERE started_at < ?1), 0))",
        params![cutoff],
    )
    .map_err(fail)?;
    tx.execute(
        "DELETE FROM usage_turns WHERE started_at < ?1",
        params![cutoff],
    )
    .map_err(fail)?;
    tx.commit().map_err(fail)
}

/// A conversation's recorded turns, oldest first, across every load of it. Turns merged into their
/// hour no longer name their session, so a conversation older than [`TURN_RETENTION_DAYS`] shows
/// only its recent turns.
pub(crate) fn session_turns(
    conn: &Connection,
    agent_id: &str,
    acp_session_id: &str,
) -> Result<Vec<maestro_protocol::UsageTurn>, String> {
    let fail = |e: rusqlite::Error| format!("cannot read a session's usage: {e}");
    let mut stmt = conn
        .prepare(
            "SELECT model_id, started_at, ended_at, total_tokens, input_tokens, output_tokens,
                    thought_tokens, cached_read_tokens, cached_write_tokens
             FROM usage_turns WHERE agent_id = ?1 AND acp_session_id = ?2
             ORDER BY started_at, id",
        )
        .map_err(fail)?;
    let count = |r: &rusqlite::Row, i| r.get::<_, Option<i64>>(i).map(|n| n.map(|n| n as u64));
    stmt.query_map(params![agent_id, acp_session_id], |r| {
        // A turn with no total is one the agent reported nothing for.
        let usage = match (count(r, 3)?, count(r, 4)?, count(r, 5)?) {
            (Some(total_tokens), input, output) => Some(TurnUsage {
                total_tokens,
                input_tokens: input.unwrap_or(0),
                output_tokens: output.unwrap_or(0),
                thought_tokens: count(r, 6)?,
                cached_read_tokens: count(r, 7)?,
                cached_write_tokens: count(r, 8)?,
            }),
            _ => None,
        };
        Ok(maestro_protocol::UsageTurn {
            model_id: r.get(0)?,
            started_at: r.get(1)?,
            ended_at: r.get(2)?,
            usage,
        })
    })
    .and_then(|rows| rows.collect())
    .map_err(fail)
}

/// Turns per [`turns_after`] answer, and hours per [`hours_after`] answer. An hour holds one row
/// per agent, project, model and currency, so a page of hours is a few times larger in rows.
const TURNS_PAGE: usize = 2000;
const HOURS_PAGE: usize = 500;

fn store_meta(conn: &Connection) -> rusqlite::Result<(String, i64)> {
    conn.query_row(
        "SELECT store_id, merged_through_id FROM usage_meta",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
}

/// The six token columns, read from `start` on. A model's row selects `NULL` for its total.
fn tokens(r: &rusqlite::Row, start: usize) -> rusqlite::Result<maestro_protocol::UsageTokens> {
    Ok(maestro_protocol::UsageTokens {
        total_tokens: r.get(start)?,
        input_tokens: r.get(start + 1)?,
        output_tokens: r.get(start + 2)?,
        thought_tokens: r.get(start + 3)?,
        cached_read_tokens: r.get(start + 4)?,
        cached_write_tokens: r.get(start + 5)?,
    })
}

/// The turns after `after_turn_id` in id order, one page, with their models.
pub(crate) fn turns_after(
    conn: &Connection,
    after_turn_id: i64,
) -> Result<maestro_protocol::UsageTurnsResponse, String> {
    turns_page(conn, after_turn_id, TURNS_PAGE)
}

fn turns_page(
    conn: &Connection,
    after_turn_id: i64,
    page: usize,
) -> Result<maestro_protocol::UsageTurnsResponse, String> {
    let fail = |e: rusqlite::Error| format!("cannot read usage turns: {e}");
    let (store_id, merged_through_id) = store_meta(conn).map_err(fail)?;
    let mut turns = conn
        .prepare(&format!(
            "SELECT id, agent_id, acp_session_id, project_path, model_id, started_at, ended_at,
                    {tokens}, cost_amount, cost_currency
             FROM usage_turns WHERE id > ?1 ORDER BY id LIMIT ?2",
            tokens = TOKENS.join(", "),
        ))
        .map_err(fail)?
        .query_map(params![after_turn_id, page as i64 + 1], |r| {
            Ok(maestro_protocol::UsageTurnRow {
                id: r.get(0)?,
                agent_id: r.get(1)?,
                acp_session_id: r.get(2)?,
                project_path: r.get(3)?,
                model_id: r.get(4)?,
                started_at: r.get(5)?,
                ended_at: r.get(6)?,
                tokens: tokens(r, 7)?,
                cost_amount: r.get(13)?,
                cost_currency: r.get(14)?,
            })
        })
        .and_then(|rows| rows.collect::<Result<Vec<_>, _>>())
        .map_err(fail)?;
    let more = turns.len() > page;
    turns.truncate(page);
    let last = turns.last().map_or(after_turn_id, |t| t.id);
    let models = conn
        .prepare(&format!(
            "SELECT turn_id, model, NULL, {tokens} FROM usage_turn_models
             WHERE turn_id > ?1 AND turn_id <= ?2 ORDER BY turn_id, model",
            tokens = TOKENS[1..].join(", "),
        ))
        .map_err(fail)?
        .query_map(params![after_turn_id, last], |r| {
            Ok(maestro_protocol::UsageTurnModelRow {
                turn_id: r.get(0)?,
                model: r.get(1)?,
                tokens: tokens(r, 2)?,
            })
        })
        .and_then(|rows| rows.collect())
        .map_err(fail)?;
    Ok(maestro_protocol::UsageTurnsResponse {
        store_id,
        merged_through_id,
        turns,
        models,
        more,
    })
}

/// Every hourly row of the hours after `after_hour`, one page of hours, with their models.
pub(crate) fn hours_after(
    conn: &Connection,
    after_hour: &str,
) -> Result<maestro_protocol::UsageHoursResponse, String> {
    hours_page(conn, after_hour, HOURS_PAGE)
}

fn hours_page(
    conn: &Connection,
    after_hour: &str,
    page: usize,
) -> Result<maestro_protocol::UsageHoursResponse, String> {
    let fail = |e: rusqlite::Error| format!("cannot read usage hours: {e}");
    let (store_id, _) = store_meta(conn).map_err(fail)?;
    let mut hours: Vec<String> = conn
        .prepare("SELECT DISTINCT hour FROM usage_hourly WHERE hour > ?1 ORDER BY hour LIMIT ?2")
        .map_err(fail)?
        .query_map(params![after_hour, page as i64 + 1], |r| r.get(0))
        .and_then(|rows| rows.collect())
        .map_err(fail)?;
    let more = hours.len() > page;
    hours.truncate(page);
    let Some(last) = hours.last() else {
        return Ok(maestro_protocol::UsageHoursResponse {
            store_id,
            hours: Vec::new(),
            models: Vec::new(),
            more: false,
        });
    };
    let rows = conn
        .prepare(&format!(
            "SELECT hour, agent_id, project_path, model_id, cost_currency, turns, sessions,
                    active_seconds, {tokens}, cost_amount
             FROM usage_hourly WHERE hour > ?1 AND hour <= ?2
             ORDER BY hour, agent_id, project_path, model_id, cost_currency",
            tokens = TOKENS.join(", "),
        ))
        .map_err(fail)?
        .query_map(params![after_hour, last], |r| {
            Ok(maestro_protocol::UsageHourRow {
                hour: r.get(0)?,
                agent_id: r.get(1)?,
                project_path: r.get(2)?,
                model_id: r.get(3)?,
                cost_currency: r.get(4)?,
                turns: r.get(5)?,
                sessions: r.get(6)?,
                active_seconds: r.get(7)?,
                tokens: tokens(r, 8)?,
                cost_amount: r.get(14)?,
            })
        })
        .and_then(|rows| rows.collect())
        .map_err(fail)?;
    let models = conn
        .prepare(&format!(
            "SELECT hour, agent_id, project_path, model, NULL, {tokens}
             FROM usage_hourly_models WHERE hour > ?1 AND hour <= ?2
             ORDER BY hour, agent_id, project_path, model",
            tokens = TOKENS[1..].join(", "),
        ))
        .map_err(fail)?
        .query_map(params![after_hour, last], |r| {
            Ok(maestro_protocol::UsageHourModelRow {
                hour: r.get(0)?,
                agent_id: r.get(1)?,
                project_path: r.get(2)?,
                model: r.get(3)?,
                tokens: tokens(r, 4)?,
            })
        })
        .and_then(|rows| rows.collect())
        .map_err(fail)?;
    Ok(maestro_protocol::UsageHoursResponse {
        store_id,
        hours: rows,
        models,
        more,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn usage(total: u64) -> TurnUsage {
        TurnUsage {
            total_tokens: total,
            input_tokens: total / 2,
            output_tokens: total / 2,
            thought_tokens: None,
            cached_read_tokens: Some(7),
            cached_write_tokens: None,
        }
    }

    fn turn_at(
        conn: &Connection,
        session: &str,
        started_at: DateTime<Utc>,
        tokens: u64,
        cost: f64,
    ) {
        let meter = TurnMeter {
            model_id: Some("opus".into()),
            started_at: Some(started_at),
            cost: Some((cost, "USD".into())),
            context: Some((10, 100)),
        };
        let usage = usage(tokens);
        let models = json!([{ "model": "claude-opus", "token_count": { "inputTokens": tokens } }]);
        record(
            conn,
            &Turn {
                agent_id: "claude-acp",
                acp_session_id: session,
                project_path: "/p".into(),
                role: None,
                stop_reason: "end_turn",
                meter: &meter,
                usage: Some(&usage),
                model_usage: Some(&models),
            },
            started_at + Duration::seconds(30),
        )
        .expect("record");
    }

    fn count(conn: &Connection, table: &str) -> i64 {
        conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
            .unwrap()
    }

    #[test]
    fn model_usage_is_read_in_every_agents_spelling() {
        let rows = model_rows(Some(&json!([
            // Claude
            { "model": "claude-opus", "token_count": {
                "inputTokens": 1, "outputTokens": 2, "cachedInputTokens": 3,
                "cachedWriteTokens": 4, "reasoningOutputTokens": 0 } },
            // Codex
            { "model": "gpt", "token_count": { "inputTokens": 5, "cacheWriteInputTokens": 6 } },
            // Gemini
            { "model": "gemini", "token_count": { "input_tokens": 7, "output_tokens": 8 } },
            { "token_count": { "inputTokens": 9 } },
        ])));
        let seen: Vec<_> = rows
            .iter()
            .map(|r| {
                (
                    r.model.as_str(),
                    r.input,
                    r.output,
                    r.cached_read,
                    r.cached_write,
                )
            })
            .collect();
        assert_eq!(
            seen,
            [
                ("claude-opus", Some(1), Some(2), Some(3), Some(4)),
                ("gpt", Some(5), None, None, Some(6)),
                ("gemini", Some(7), Some(8), None, None),
            ]
        );
        assert!(model_rows(Some(&json!({ "not": "a list" }))).is_empty());
        assert!(model_rows(None).is_empty());
    }

    fn cost_update(total: f64) -> Value {
        json!({ "sessionUpdate": "usage_update", "used": 5, "size": 50,
                "cost": { "amount": total, "currency": "USD" } })
    }

    #[test]
    fn a_turn_costs_what_it_added_to_the_sessions_total() {
        let sid = "meter-new";
        note_session(sid, false, Some("opus".into()));
        note_turn_started(sid);
        note_update(sid, &cost_update(1.5));
        let first = take_turn(sid);
        assert_eq!(first.cost, Some((1.5, "USD".into())));
        assert_eq!(first.context, Some((5, 50)));
        assert!(first.started_at.is_some());

        note_turn_started(sid);
        note_update(sid, &cost_update(2.0));
        assert_eq!(take_turn(sid).cost, Some((0.5, "USD".into())));

        // The agent restarted and counts from zero.
        note_turn_started(sid);
        note_update(sid, &cost_update(0.25));
        assert_eq!(take_turn(sid).cost, Some((0.25, "USD".into())));
        forget(sid);
    }

    #[test]
    fn a_loaded_sessions_first_cost_is_unknown_unless_the_load_reported_one() {
        let sid = "meter-loaded";
        note_session(sid, true, None);
        note_turn_started(sid);
        note_update(sid, &cost_update(9.0));
        assert_eq!(
            take_turn(sid).cost,
            None,
            "may include what came before the load"
        );
        note_turn_started(sid);
        note_update(sid, &cost_update(9.5));
        assert_eq!(take_turn(sid).cost, Some((0.5, "USD".into())));

        let sid = "meter-loaded-replayed";
        note_session(sid, true, None);
        note_update(sid, &cost_update(4.0));
        note_turn_started(sid);
        note_update(sid, &cost_update(4.5));
        assert_eq!(take_turn(sid).cost, Some((0.5, "USD".into())));
        forget(sid);
        forget("meter-loaded");
    }

    #[test]
    fn the_selected_model_follows_config_option_updates() {
        let sid = "meter-model";
        note_session(sid, false, Some("sonnet".into()));
        note_update(
            sid,
            &json!({ "sessionUpdate": "config_option_update", "configOptions": [
                { "id": "mode", "currentValue": "plan" },
                { "id": "model", "currentValue": "opus" } ] }),
        );
        assert_eq!(take_turn(sid).model_id.as_deref(), Some("opus"));
        note_model(sid, "haiku");
        assert_eq!(take_turn(sid).model_id.as_deref(), Some("haiku"));
        forget(sid);
    }

    #[test]
    fn a_sessions_turns_are_read_back_in_order_and_alone() {
        let conn = crate::project_store::open_in_memory();
        let now = Utc::now();
        turn_at(&conn, "a", now - Duration::minutes(5), 200, 0.2);
        turn_at(&conn, "b", now - Duration::minutes(4), 999, 0.9);
        turn_at(&conn, "a", now - Duration::minutes(10), 100, 0.1);

        let turns = session_turns(&conn, "claude-acp", "a").expect("read");
        let totals: Vec<_> = turns
            .iter()
            .map(|t| t.usage.as_ref().map(|u| u.total_tokens))
            .collect();
        assert_eq!(totals, [Some(100), Some(200)]);
        assert_eq!(turns[0].model_id.as_deref(), Some("opus"));
        assert_eq!(turns[0].usage, Some(usage(100)));
        assert!(session_turns(&conn, "other-agent", "a").unwrap().is_empty());
    }

    #[test]
    fn old_turns_merge_into_their_hour_and_new_ones_stay() {
        let conn = crate::project_store::open_in_memory();
        let now = Utc::now();
        let old = now - Duration::days(100);
        let hour_start = old.format("%Y-%m-%dT%H:00:00Z").to_string();
        let old = DateTime::parse_from_rfc3339(&hour_start).unwrap().to_utc();
        turn_at(&conn, "a", old, 100, 1.0);
        turn_at(&conn, "a", old + Duration::minutes(10), 200, 2.0);
        turn_at(&conn, "b", old + Duration::minutes(20), 300, 3.0);
        turn_at(&conn, "a", now - Duration::days(1), 400, 4.0);

        merge_old(&conn, now).expect("merge");

        assert_eq!(
            count(&conn, "usage_turns"),
            1,
            "only the recent turn stays whole"
        );
        assert_eq!(
            count(&conn, "usage_turn_models"),
            1,
            "its models go with the turns"
        );
        let (hour, turns, sessions, seconds, tokens, cached, cost): (
            String,
            i64,
            i64,
            i64,
            i64,
            i64,
            f64,
        ) = conn
            .query_row(
                "SELECT hour, turns, sessions, active_seconds, total_tokens, cached_read_tokens,
                        cost_amount
                 FROM usage_hourly WHERE agent_id = 'claude-acp' AND model_id = 'opus'
                   AND cost_currency = 'USD'",
                [],
                |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                        r.get(6)?,
                    ))
                },
            )
            .expect("one hour");
        assert_eq!(hour, hour_start);
        assert_eq!((turns, sessions, seconds), (3, 2, 90));
        assert_eq!((tokens, cached), (600, 21));
        assert!((cost - 6.0).abs() < 1e-9);
        let model_input: i64 = conn
            .query_row(
                "SELECT input_tokens FROM usage_hourly_models WHERE model = 'claude-opus'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(model_input, 600);

        // A turn landing in an hour already merged adds to it.
        turn_at(&conn, "c", old + Duration::minutes(30), 1000, 0.5);
        merge_old(&conn, now).expect("merge again");
        let (turns, tokens): (i64, i64) = conn
            .query_row("SELECT turns, total_tokens FROM usage_hourly", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!((turns, tokens), (4, 1600));
        assert_eq!(count(&conn, "usage_hourly"), 1);
    }

    #[test]
    fn turns_page_by_id_with_their_models_and_name_the_store() {
        let conn = crate::project_store::open_in_memory();
        let now = Utc::now();
        for i in 0..5 {
            turn_at(
                &conn,
                "a",
                now - Duration::minutes(10 - i),
                100 + i as u64,
                0.1,
            );
        }

        let first = turns_page(&conn, 0, 2).expect("page");
        let ids = |page: &maestro_protocol::UsageTurnsResponse| {
            page.turns.iter().map(|t| t.id).collect::<Vec<_>>()
        };
        assert_eq!(ids(&first), [1, 2]);
        let model_turns: Vec<_> = first.models.iter().map(|m| m.turn_id).collect();
        assert_eq!(model_turns, [1, 2], "only this page's models");
        assert_eq!(first.models[0].tokens.input_tokens, Some(100));
        assert_eq!(first.models[0].tokens.total_tokens, None);
        assert_eq!(first.turns[0].tokens.total_tokens, Some(100));
        assert_eq!(first.turns[0].cost_currency.as_deref(), Some("USD"));
        assert!(first.more);
        assert_eq!(first.store_id.len(), 32);

        let last = turns_page(&conn, 4, 2).expect("page");
        assert_eq!(ids(&last), [5]);
        assert!(!last.more);
        assert_eq!(last.store_id, first.store_id, "the store keeps its id");
        assert!(turns_page(&conn, 5, 2).unwrap().turns.is_empty());
    }

    #[test]
    fn merging_moves_merged_through_id_and_hours_page_whole() {
        let conn = crate::project_store::open_in_memory();
        let now = Utc::now();
        let old = now - Duration::days(100);
        turn_at(&conn, "a", old, 100, 1.0);
        turn_at(&conn, "a", old + Duration::hours(1), 200, 1.0);
        turn_at(&conn, "b", old + Duration::hours(1), 300, 1.0);
        turn_at(&conn, "a", old + Duration::hours(2), 400, 1.0);
        turn_at(&conn, "a", now - Duration::days(1), 500, 1.0);

        merge_old(&conn, now).expect("merge");

        let turns = turns_page(&conn, 0, 10).unwrap();
        assert_eq!(turns.merged_through_id, 4);
        let ids: Vec<_> = turns.turns.iter().map(|t| t.id).collect();
        assert_eq!(ids, [5]);

        let first = hours_page(&conn, "", 2).expect("hours");
        assert!(first.more);
        assert_eq!(first.hours.len(), 2, "two hours, one row each");
        assert_eq!(first.hours[1].turns, 2, "both sessions' turns in one row");
        assert_eq!(first.models.len(), 2);
        let rest = hours_page(&conn, &first.hours[1].hour, 2).expect("hours");
        assert_eq!(rest.hours.len(), 1);
        assert_eq!(rest.hours[0].tokens.total_tokens, Some(400));
        assert!(!rest.more);
        assert!(hours_page(&conn, &rest.hours[0].hour, 2)
            .unwrap()
            .hours
            .is_empty());
    }
}
