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
        "DELETE FROM usage_turns WHERE started_at < ?1",
        params![cutoff],
    )
    .map_err(fail)?;
    tx.commit().map_err(fail)
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
}
