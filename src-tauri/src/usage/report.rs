//! Everything the Usage view shows for one range and set of filters, read from the mirror's
//! views in one go. Buckets, weekdays and hours are the local clock's.

use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::{params_from_iter, types::Value, Connection};
use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum UsageBucket {
    Minute,
    Hour,
    Day,
    Month,
}

impl UsageBucket {
    fn format(self) -> &'static str {
        match self {
            Self::Minute => "%Y-%m-%dT%H:%M",
            Self::Hour => "%Y-%m-%dT%H",
            Self::Day => "%Y-%m-%d",
            Self::Month => "%Y-%m",
        }
    }
}

/// What the main chart's series are.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum UsageSplit {
    Connection,
    Agent,
    /// Tokens only: cost is recorded per turn.
    Model,
    /// Tokens only, for the same reason.
    TokenType,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct UsageProjectRef {
    pub connection_key: String,
    pub project_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct UsageQuery {
    /// RFC 3339; `None` for the first record.
    pub start: Option<String>,
    /// RFC 3339, exclusive; `None` for now.
    pub end: Option<String>,
    pub bucket: UsageBucket,
    pub split: UsageSplit,
    /// Any of these projects; none means every project.
    pub projects: Vec<UsageProjectRef>,
    /// Any of these models. Cost has no model, so for cost and the turn totals this keeps the
    /// turns (and hours) that used one of them, whatever else they used.
    pub models: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
pub struct UsageTokenSplit {
    pub input: i64,
    pub output: i64,
    pub thought: i64,
    pub cached_read: i64,
    pub cached_write: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct UsageSeriesPoint {
    /// The bucket, in the local clock: `2026-10-12`, `2026-10-12T14`, …
    pub bucket: String,
    /// A connection key, an agent id, a model, or `input`, `output`, `thought`, `cached_read`,
    /// `cached_write`.
    pub key: String,
    /// `None` for the tokens-only splits.
    pub cost: Option<f64>,
    pub tokens: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct UsageHeatCell {
    /// 0 is Sunday.
    pub weekday: u8,
    pub hour: u8,
    pub cost: f64,
    pub tokens: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct UsageProjectRow {
    pub connection_key: String,
    pub project_path: String,
    pub cost: f64,
    pub tokens: i64,
    pub by_type: UsageTokenSplit,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct UsageModelRow {
    pub model: String,
    /// Every agent that used it.
    pub agent_ids: Vec<String>,
    /// The five token types added up: a model's rows carry no total of their own.
    pub tokens: i64,
    pub by_type: UsageTokenSplit,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct UsageCoverage {
    pub connection_key: String,
    /// The name at the last sync, which is all a removed connection has left.
    pub connection_name: String,
    /// RFC 3339; `None` until a sync has copied a turn.
    pub synced_at: Option<String>,
    pub removed: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct UsageReport {
    pub cost: f64,
    pub tokens: i64,
    pub series: Vec<UsageSeriesPoint>,
    pub heatmap: Vec<UsageHeatCell>,
    pub projects: Vec<UsageProjectRow>,
    pub models: Vec<UsageModelRow>,
    pub coverage: Vec<UsageCoverage>,
}

/// The stored form of a time, so string comparison orders it: `2026-10-12T10:00:00Z`.
fn stamp(time: &str) -> Result<String, String> {
    DateTime::parse_from_rfc3339(time)
        .map(|t| {
            t.with_timezone(&Utc)
                .to_rfc3339_opts(SecondsFormat::Secs, true)
        })
        .map_err(|e| format!("Not an RFC 3339 time: {time}: {e}"))
}

/// Which models a fact used: its model rows, or the session's model when it has none, as
/// `usage_model_facts` counts them.
#[derive(Clone, Copy)]
enum ModelMatch {
    /// `usage_model_facts`, which has one model per row.
    Column,
    /// `usage_facts`, whose turns and hours keep their models in the model tables.
    Used,
}

/// A `WHERE` clause over a view aliased `f` joined to `usage_stores s`, and its parameters.
fn filters(query: &UsageQuery, models: ModelMatch) -> Result<(String, Vec<Value>), String> {
    let mut clauses = Vec::new();
    let mut values = Vec::new();
    if let Some(start) = &query.start {
        clauses.push("f.at >= ?".to_string());
        values.push(Value::Text(stamp(start)?));
    }
    if let Some(end) = &query.end {
        clauses.push("f.at < ?".to_string());
        values.push(Value::Text(stamp(end)?));
    }
    if !query.projects.is_empty() {
        let any = vec!["(s.connection_key = ? AND f.project_path = ?)"; query.projects.len()];
        clauses.push(format!("({})", any.join(" OR ")));
        for project in &query.projects {
            values.push(Value::Text(project.connection_key.clone()));
            values.push(Value::Text(project.project_path.clone()));
        }
    }
    if !query.models.is_empty() {
        let marks = vec!["?"; query.models.len()].join(", ");
        let model_values = query.models.iter().cloned().map(Value::Text);
        match models {
            ModelMatch::Column => {
                clauses.push(format!("f.model IN ({marks})"));
                values.extend(model_values);
            }
            // The same attribution as the Models panel, so a model's row and its filter agree.
            ModelMatch::Used => {
                clauses.push(format!(
                    "EXISTS (SELECT 1 FROM usage_model_facts mf
                             WHERE mf.store_id = f.store_id AND mf.model IN ({marks})
                               AND CASE WHEN f.turn_id IS NOT NULL THEN mf.turn_id = f.turn_id
                                   ELSE mf.turn_id IS NULL AND mf.at = f.at
                                        AND mf.agent_id = f.agent_id
                                        AND mf.project_path = f.project_path END)"
                ));
                values.extend(model_values);
            }
        }
    }
    let clause = if clauses.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", clauses.join(" AND "))
    };
    Ok((clause, values))
}

const FACTS: &str = "usage_facts f JOIN usage_stores s ON s.store_id = f.store_id";
const MODEL_FACTS: &str = "usage_model_facts f JOIN usage_stores s ON s.store_id = f.store_id";
const SPLIT_SUMS: &str = "COALESCE(SUM(f.input_tokens), 0), COALESCE(SUM(f.output_tokens), 0),
     COALESCE(SUM(f.thought_tokens), 0), COALESCE(SUM(f.cached_read_tokens), 0),
     COALESCE(SUM(f.cached_write_tokens), 0)";
const TYPE_KEYS: [&str; 5] = ["input", "output", "thought", "cached_read", "cached_write"];

fn token_split(r: &rusqlite::Row, start: usize) -> rusqlite::Result<UsageTokenSplit> {
    Ok(UsageTokenSplit {
        input: r.get(start)?,
        output: r.get(start + 1)?,
        thought: r.get(start + 2)?,
        cached_read: r.get(start + 3)?,
        cached_write: r.get(start + 4)?,
    })
}

fn rows<T>(
    conn: &Connection,
    sql: &str,
    values: &[Value],
    map: impl FnMut(&rusqlite::Row) -> rusqlite::Result<T>,
) -> rusqlite::Result<Vec<T>> {
    conn.prepare(sql)?
        .query_map(params_from_iter(values), map)?
        .collect()
}

/// Whether the connection a store was synced from still exists.
fn connection_exists(conn: &Connection, connection_key: &str) -> rusqlite::Result<bool> {
    let Some((kind, id)) = connection_key.split_once(':') else {
        return Ok(connection_key == "local");
    };
    let table = match kind {
        "ssh" => "ssh_connections",
        "wsl" => "wsl_connections",
        "docker" => "docker_connections",
        _ => return Ok(false),
    };
    conn.query_row(
        &format!("SELECT EXISTS (SELECT 1 FROM {table} WHERE id = ?1)"),
        [id],
        |r| r.get(0),
    )
}

pub fn report(conn: &Connection, query: &UsageQuery) -> Result<UsageReport, String> {
    let fail = |e: rusqlite::Error| format!("Cannot read usage: {e}");
    let (facts_where, facts_values) = filters(query, ModelMatch::Used)?;
    let (models_where, models_values) = filters(query, ModelMatch::Column)?;
    let bucket = format!("strftime('{}', f.at, 'localtime')", query.bucket.format());

    let (cost, tokens) = conn
        .query_row(
            &format!(
                "SELECT COALESCE(SUM(f.cost_amount), 0), COALESCE(SUM(f.total_tokens), 0)
                 FROM {FACTS} {facts_where}"
            ),
            params_from_iter(&facts_values),
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(fail)?;

    let series = match query.split {
        UsageSplit::Connection | UsageSplit::Agent => {
            let key = match query.split {
                UsageSplit::Connection => "s.connection_key",
                _ => "f.agent_id",
            };
            rows(
                conn,
                &format!(
                    "SELECT {bucket}, {key}, COALESCE(SUM(f.cost_amount), 0),
                            COALESCE(SUM(f.total_tokens), 0)
                     FROM {FACTS} {facts_where} GROUP BY 1, 2 ORDER BY 1, 2"
                ),
                &facts_values,
                |r| {
                    Ok(UsageSeriesPoint {
                        bucket: r.get(0)?,
                        key: r.get(1)?,
                        cost: Some(r.get(2)?),
                        tokens: r.get(3)?,
                    })
                },
            )
        }
        UsageSplit::Model => rows(
            conn,
            &format!(
                "SELECT {bucket}, f.model, {SPLIT_SUMS}
                 FROM {MODEL_FACTS} {models_where} GROUP BY 1, 2 ORDER BY 1, 2"
            ),
            &models_values,
            |r| {
                let split = token_split(r, 2)?;
                Ok(UsageSeriesPoint {
                    bucket: r.get(0)?,
                    key: r.get(1)?,
                    cost: None,
                    tokens: split.input
                        + split.output
                        + split.thought
                        + split.cached_read
                        + split.cached_write,
                })
            },
        ),
        UsageSplit::TokenType => rows(
            conn,
            &format!(
                "SELECT {bucket}, {SPLIT_SUMS} FROM {FACTS} {facts_where} GROUP BY 1 ORDER BY 1"
            ),
            &facts_values,
            |r| {
                let bucket: String = r.get(0)?;
                let split = token_split(r, 1)?;
                let counts = [
                    split.input,
                    split.output,
                    split.thought,
                    split.cached_read,
                    split.cached_write,
                ];
                Ok(TYPE_KEYS
                    .iter()
                    .zip(counts)
                    .map(|(key, tokens)| UsageSeriesPoint {
                        bucket: bucket.clone(),
                        key: key.to_string(),
                        cost: None,
                        tokens,
                    })
                    .collect::<Vec<_>>())
            },
        )
        .map(|points| points.into_iter().flatten().collect()),
    }
    .map_err(fail)?;

    let heatmap = rows(
        conn,
        &format!(
            "SELECT CAST(strftime('%w', f.at, 'localtime') AS INTEGER),
                    CAST(strftime('%H', f.at, 'localtime') AS INTEGER),
                    COALESCE(SUM(f.cost_amount), 0), COALESCE(SUM(f.total_tokens), 0)
             FROM {FACTS} {facts_where} GROUP BY 1, 2 ORDER BY 1, 2"
        ),
        &facts_values,
        |r| {
            Ok(UsageHeatCell {
                weekday: r.get(0)?,
                hour: r.get(1)?,
                cost: r.get(2)?,
                tokens: r.get(3)?,
            })
        },
    )
    .map_err(fail)?;

    let projects = rows(
        conn,
        &format!(
            "SELECT s.connection_key, f.project_path, COALESCE(SUM(f.cost_amount), 0),
                    COALESCE(SUM(f.total_tokens), 0), {SPLIT_SUMS}
             FROM {FACTS} {facts_where} GROUP BY 1, 2 ORDER BY 3 DESC, 4 DESC"
        ),
        &facts_values,
        |r| {
            Ok(UsageProjectRow {
                connection_key: r.get(0)?,
                project_path: r.get(1)?,
                cost: r.get(2)?,
                tokens: r.get(3)?,
                by_type: token_split(r, 4)?,
            })
        },
    )
    .map_err(fail)?;

    let mut models = rows(
        conn,
        &format!(
            "SELECT f.model, GROUP_CONCAT(DISTINCT f.agent_id), {SPLIT_SUMS}
             FROM {MODEL_FACTS} {models_where} GROUP BY 1"
        ),
        &models_values,
        |r| {
            let by_type = token_split(r, 2)?;
            Ok(UsageModelRow {
                model: r.get(0)?,
                agent_ids: r
                    .get::<_, String>(1)?
                    .split(',')
                    .map(str::to_string)
                    .collect(),
                tokens: by_type.input
                    + by_type.output
                    + by_type.thought
                    + by_type.cached_read
                    + by_type.cached_write,
                by_type,
            })
        },
    )
    .map_err(fail)?;
    models.sort_by(|a, b| b.tokens.cmp(&a.tokens));

    // One line per connection, named as at its newest store's last sync.
    let coverage = rows(
        conn,
        "SELECT connection_key, connection_name, synced_at FROM usage_stores s
         WHERE rowid = (SELECT MAX(rowid) FROM usage_stores WHERE connection_key = s.connection_key)
         ORDER BY connection_key",
        &[],
        |r| Ok((r.get::<_, String>(0)?, r.get(1)?, r.get(2)?)),
    )
    .map_err(fail)?
    .into_iter()
    .map(
        |(connection_key, connection_name, _): (String, String, Option<String>)| {
            let synced_at = conn
                .query_row(
                    "SELECT MAX(synced_at) FROM usage_stores WHERE connection_key = ?1",
                    [&connection_key],
                    |r| r.get(0),
                )
                .map_err(fail)?;
            Ok(UsageCoverage {
                removed: !connection_exists(conn, &connection_key).map_err(fail)?,
                connection_key,
                connection_name,
                synced_at,
            })
        },
    )
    .collect::<Result<_, String>>()?;

    Ok(UsageReport {
        cost,
        tokens,
        series,
        heatmap,
        projects,
        models,
        coverage,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::usage::mirror::{adopt_store, finish_hours, save_turns};
    use maestro_protocol::{UsageTokens, UsageTurnModelRow, UsageTurnRow, UsageTurnsResponse};

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::core::schema::initialize_schema(&conn).unwrap();
        conn
    }

    fn turn(id: i64, at: &str, project: &str, model: &str, total: i64, cost: f64) -> UsageTurnRow {
        UsageTurnRow {
            id,
            agent_id: "claude-acp".into(),
            acp_session_id: "s".into(),
            project_path: project.into(),
            model_id: Some(model.into()),
            started_at: at.into(),
            ended_at: at.into(),
            tokens: UsageTokens {
                total_tokens: Some(total),
                input_tokens: Some(total / 2),
                cached_read_tokens: Some(total / 2),
                ..Default::default()
            },
            cost_amount: Some(cost),
            cost_currency: Some("USD".into()),
        }
    }

    /// Two connections: a local store with two turns and a removed SSH host's store with one.
    fn seeded() -> Connection {
        let conn = db();
        let now = Utc::now();
        adopt_store(&conn, "a", "local", "This computer").unwrap();
        finish_hours(&conn, "a", 0).unwrap();
        save_turns(
            &conn,
            "a",
            &UsageTurnsResponse {
                store_id: "a".into(),
                merged_through_id: 0,
                turns: vec![
                    turn(1, "2026-10-05T10:00:00Z", "/m", "opus", 100, 1.0),
                    turn(2, "2026-10-06T10:00:00Z", "/m", "sonnet", 50, 0.5),
                ],
                models: vec![UsageTurnModelRow {
                    turn_id: 1,
                    model: "claude-opus[1m]".into(),
                    tokens: UsageTokens {
                        input_tokens: Some(80),
                        output_tokens: Some(20),
                        ..Default::default()
                    },
                }],
                more: false,
            },
            now,
        )
        .unwrap();
        adopt_store(&conn, "b", "ssh:9", "gone-host").unwrap();
        finish_hours(&conn, "b", 0).unwrap();
        save_turns(
            &conn,
            "b",
            &UsageTurnsResponse {
                store_id: "b".into(),
                merged_through_id: 0,
                turns: vec![turn(1, "2026-10-06T11:00:00Z", "/m", "opus", 10, 2.0)],
                models: vec![],
                more: false,
            },
            now,
        )
        .unwrap();
        conn
    }

    fn query(split: UsageSplit) -> UsageQuery {
        UsageQuery {
            start: None,
            end: None,
            bucket: UsageBucket::Month,
            split,
            projects: vec![],
            models: vec![],
        }
    }

    #[test]
    fn totals_projects_and_coverage_span_every_store() {
        let conn = seeded();
        let report = super::report(&conn, &query(UsageSplit::Connection)).unwrap();
        assert_eq!((report.cost, report.tokens), (3.5, 160));
        let keys: Vec<_> = report.series.iter().map(|p| p.key.as_str()).collect();
        assert_eq!(keys, ["local", "ssh:9"]);
        assert_eq!(report.series[0].cost, Some(1.5));

        // The same path on two connections is two projects; the dearest first.
        let projects: Vec<_> = report
            .projects
            .iter()
            .map(|p| (p.connection_key.as_str(), p.cost))
            .collect();
        assert_eq!(projects, [("ssh:9", 2.0), ("local", 1.5)]);
        assert_eq!(report.projects[1].by_type.cached_read, 75);

        assert_eq!(report.coverage.len(), 2);
        assert!(!report.coverage[0].removed, "This computer always exists");
        assert!(report.coverage[1].removed, "no ssh_connections row 9");
        assert_eq!(report.coverage[1].connection_name, "gone-host");
    }

    #[test]
    fn models_are_tokens_and_fall_back_to_the_selected_model() {
        let conn = seeded();
        let report = super::report(&conn, &query(UsageSplit::Model)).unwrap();
        let models: Vec<_> = report
            .models
            .iter()
            .map(|m| (m.model.as_str(), m.tokens))
            .collect();
        // Turn 1 reported claude-opus[1m] with opus selected, so the SSH turn's opus is the same
        // model; nothing says what sonnet is, so it keeps its name.
        assert_eq!(models, [("claude-opus", 110), ("sonnet", 50)]);
        assert_eq!(report.models[0].agent_ids, ["claude-acp"]);
        assert!(report.series.iter().all(|p| p.cost.is_none()));
    }

    #[test]
    fn filters_and_the_range_narrow_every_part() {
        let conn = seeded();
        let mut q = query(UsageSplit::TokenType);
        q.start = Some("2026-10-06T00:00:00+00:00".into());
        q.projects = vec![UsageProjectRef {
            connection_key: "local".into(),
            project_path: "/m".into(),
        }];
        let report = super::report(&conn, &q).unwrap();
        assert_eq!((report.cost, report.tokens), (0.5, 50));
        let types: Vec<_> = report
            .series
            .iter()
            .map(|p| (p.key.as_str(), p.tokens))
            .collect();
        assert_eq!(
            types,
            [
                ("input", 25),
                ("output", 0),
                ("thought", 0),
                ("cached_read", 25),
                ("cached_write", 0)
            ]
        );

        // Turn 1 used claude-opus by its model rows, and the SSH turn by its selected opus.
        let mut q = query(UsageSplit::Agent);
        q.models = vec!["claude-opus".into()];
        let report = super::report(&conn, &q).unwrap();
        assert_eq!((report.cost, report.tokens), (3.0, 110));
        assert_eq!(report.models.len(), 1);
        q.models = vec!["sonnet".into()];
        let report = super::report(&conn, &q).unwrap();
        assert_eq!((report.cost, report.tokens), (0.5, 50));
        assert_eq!(report.heatmap.iter().map(|c| c.tokens).sum::<i64>(), 50);
    }
}
