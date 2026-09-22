//! Where automations live, and what they have done.
//!
//! One SQLite file per daemon, beside its lock, holding every project on this machine rather than
//! one per checkout. That is the point: the clock has to fire for a project whose window nobody has
//! opened, so the store cannot be something only an open project brings with it.
//!
//! A project is keyed by its canonicalized path because that is the only name both sides agree on.
//! The app's own project ids are rows in the app's database, and for an SSH, WSL or container
//! project that database is not even on this machine.

use std::path::Path;
use std::str::FromStr;

use chrono::{DateTime, Utc};
use maestro_protocol::{Automation, AutomationRun, AutomationRunStatus, AutomationWorkspace};
use rusqlite::{params, Connection, OptionalExtension};

/// Cap on what a run list hands back, whatever the client asks for.
const RUN_LIMIT: u32 = 200;

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS projects (
    path       TEXT PRIMARY KEY,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS automations (
    id              TEXT PRIMARY KEY,
    project_path    TEXT NOT NULL REFERENCES projects(path) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    prompt          TEXT NOT NULL,
    agent_id        TEXT NOT NULL,
    cron            TEXT,
    timezone        TEXT NOT NULL,
    enabled         INTEGER NOT NULL,
    model           TEXT,
    permission_mode TEXT,
    effort          TEXT,
    workspace       TEXT NOT NULL,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    last_fired_at   TEXT
);

CREATE TABLE IF NOT EXISTS runs (
    id                TEXT PRIMARY KEY,
    automation_id     TEXT NOT NULL,
    project_path      TEXT NOT NULL,
    automation_name   TEXT NOT NULL,
    status            TEXT NOT NULL,
    scheduled         INTEGER NOT NULL,
    started_at        TEXT NOT NULL,
    finished_at       TEXT,
    session_id        TEXT,
    error             TEXT,
    -- What it takes to open this run again once its session has been closed. The session id above
    -- names a live session and stops meaning anything when the sweep takes it; these three are
    -- what `session/load` needs, and the run row is the only place they survive.
    agent_session_id  TEXT,
    agent_id          TEXT,
    cwd               TEXT,
    -- Whether that agent answers session/load. Known when the session was made and not after it
    -- is gone, which is exactly when a run needs to say whether it can be opened again.
    can_reload        INTEGER
);

CREATE INDEX IF NOT EXISTS runs_by_project ON runs(project_path, started_at DESC);
CREATE INDEX IF NOT EXISTS runs_by_session ON runs(session_id);
";

/// Open, or create, the daemon's automation database.
///
/// WAL and a busy timeout because two processes reach this file whenever the app is attached: the
/// daemon's clock writes runs while the window reads them.
pub fn open(dir: &Path) -> Result<Connection, String> {
    let path = dir.join("automations.db");
    let conn = Connection::open(&path).map_err(|e| format!("cannot open {path:?}: {e}"))?;
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|e| format!("cannot set WAL on {path:?}: {e}"))?;
    conn.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|e| format!("cannot set busy_timeout on {path:?}: {e}"))?;
    conn.pragma_update(None, "foreign_keys", "ON")
        .map_err(|e| format!("cannot enable foreign keys on {path:?}: {e}"))?;
    conn.execute_batch(SCHEMA)
        .map_err(|e| format!("cannot create the automation schema: {e}"))?;
    // Added after the table existed on machines that had already run a daemon. Each is nullable,
    // so a run recorded before them simply cannot be reopened, which is what it was anyway.
    for column in ["agent_session_id", "agent_id", "cwd", "can_reload"] {
        add_column_if_missing(&conn, "runs", column)?;
    }
    Ok(conn)
}

fn add_column_if_missing(conn: &Connection, table: &str, column: &str) -> Result<(), String> {
    let present: bool = conn
        .query_row(
            "SELECT COUNT(*) > 0 FROM pragma_table_info(?1) WHERE name = ?2",
            params![table, column],
            |row| row.get(0),
        )
        .map_err(|e| format!("cannot read the shape of {table}: {e}"))?;
    if present {
        return Ok(());
    }
    conn.execute(&format!("ALTER TABLE {table} ADD COLUMN {column} TEXT"), [])
        .map(|_| ())
        .map_err(|e| format!("cannot add {table}.{column}: {e}"))
}

/// The name a project is filed under, resolved on the machine the path exists on.
///
/// Falls back to tidying the given path when it does not resolve, so a project on a disconnected
/// drive still matches the rows it wrote — being unable to reach a directory is not a reason to
/// forget the automations pointing at it.
pub fn canonical_project_path(path: &str) -> String {
    let resolved = std::fs::canonicalize(path)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| path.to_string());
    // Windows hands back a verbatim path, which no other part of Maestro ever shows or stores.
    let resolved = resolved
        .strip_prefix(r"\\?\")
        .unwrap_or(&resolved)
        .replace('\\', "/");
    let trimmed = resolved.trim_end_matches('/');
    if trimmed.is_empty() {
        resolved
    } else {
        trimmed.to_string()
    }
}

/// The IANA zone this machine is set to, or `UTC` when it will not say.
///
/// `UTC` rather than an error: a machine with no readable zone still has to be able to run an
/// automation, and a schedule an hour out is better than a project whose automations will not load.
pub fn server_timezone() -> String {
    match iana_time_zone::get_timezone() {
        Ok(zone) if zone.parse::<chrono_tz::Tz>().is_ok() => zone,
        Ok(zone) => {
            crate::send_diag(
                "warn",
                format!(
                    "[automation] this machine reports an unknown timezone '{zone}', using UTC"
                ),
            );
            "UTC".to_string()
        }
        Err(e) => {
            crate::send_diag(
                "warn",
                format!("[automation] cannot read this machine's timezone, using UTC: {e}"),
            );
            "UTC".to_string()
        }
    }
}

/// Rewrite a standard five-field cron into what the `cron` crate parses.
///
/// Two differences, both silent if ignored: the crate wants a seconds field in front, and it counts
/// days of the week from 1 for Sunday where cron counts from 0. An expression that already carries
/// six fields is taken as the crate's own dialect and passed through.
fn to_crate_expression(expression: &str) -> Option<String> {
    let fields: Vec<&str> = expression.split_whitespace().collect();
    if fields.len() != 5 {
        return (fields.len() == 6 || fields.len() == 7).then(|| expression.to_string());
    }
    let weekdays: String = fields[4]
        .chars()
        .map(|c| match c.to_digit(10) {
            // 7 is Sunday in either counting, so it needs no shift and must not wrap to 8.
            Some(digit) if digit < 7 => char::from_digit(digit + 1, 10).unwrap_or(c),
            _ => c,
        })
        .collect();
    Some(format!(
        "0 {} {} {} {} {}",
        fields[0], fields[1], fields[2], fields[3], weekdays
    ))
}

/// The first time this expression comes round strictly after `after`.
///
/// `None` for an expression or a timezone that does not parse, and for one with no next occurrence
/// at all — a cron naming February 30th is valid syntax and never happens.
pub fn next_due(expression: &str, timezone: &str, after: DateTime<Utc>) -> Option<DateTime<Utc>> {
    let zone: chrono_tz::Tz = timezone.parse().ok()?;
    let schedule = cron::Schedule::from_str(&to_crate_expression(expression)?).ok()?;
    schedule
        .after(&after.with_timezone(&zone))
        .next()
        .map(|next| next.with_timezone(&Utc))
}

/// Everything wrong with an automation, checked here because this is the only door into the store.
pub fn validate(automation: &Automation) -> Result<(), String> {
    if automation.id.trim().is_empty() {
        return Err("Every automation needs an id".to_string());
    }
    if automation.name.trim().is_empty() {
        return Err("Every automation needs a name".to_string());
    }
    if automation.prompt.trim().is_empty() {
        return Err(format!("Automation '{}' has no prompt", automation.name));
    }
    if automation.agent_id.trim().is_empty() {
        return Err(format!("Automation '{}' has no agent", automation.name));
    }
    if automation.timezone.parse::<chrono_tz::Tz>().is_err() {
        return Err(format!(
            "Automation '{}' names a timezone that does not exist: '{}'",
            automation.name, automation.timezone
        ));
    }
    if let Some(expression) = &automation.cron {
        validate_schedule(expression, &automation.timezone).map_err(|e| {
            format!(
                "Automation '{}' has a schedule that cannot be read: {e}",
                automation.name
            )
        })?;
    }
    Ok(())
}

/// An expression and the zone it is read in, on their own.
///
/// Used by the editor's preview, where there is no automation yet and nothing to name in the
/// error, and by `validate` above, which wraps it in one.
pub fn validate_schedule(expression: &str, timezone: &str) -> Result<(), String> {
    if timezone.parse::<chrono_tz::Tz>().is_err() {
        return Err(format!("'{timezone}' is not a timezone"));
    }
    let parsed = to_crate_expression(expression)
        .and_then(|expression| cron::Schedule::from_str(&expression).ok());
    if parsed.is_none() {
        return Err(format!("'{expression}' is not a schedule"));
    }
    Ok(())
}

fn row_to_automation(row: &rusqlite::Row<'_>) -> rusqlite::Result<Automation> {
    let workspace: String = row.get("workspace")?;
    Ok(Automation {
        id: row.get("id")?,
        project_path: row.get("project_path")?,
        name: row.get("name")?,
        prompt: row.get("prompt")?,
        agent_id: row.get("agent_id")?,
        cron: row.get("cron")?,
        timezone: row.get("timezone")?,
        enabled: row.get::<_, i64>("enabled")? != 0,
        model: row.get("model")?,
        permission_mode: row.get("permission_mode")?,
        effort: row.get("effort")?,
        // A workspace that will not deserialize would otherwise take the whole list down with it.
        workspace: serde_json::from_str(&workspace).unwrap_or(AutomationWorkspace::Repository),
        next_due_at: None,
    })
}

/// Fill in when each of these next comes round, so no client has to parse cron.
fn with_next_due(mut automations: Vec<Automation>) -> Vec<Automation> {
    let now = Utc::now();
    for automation in &mut automations {
        automation.next_due_at = automation
            .enabled
            .then_some(automation.cron.as_deref())
            .flatten()
            .and_then(|expression| next_due(expression, &automation.timezone, now))
            .map(|next| next.to_rfc3339());
    }
    automations
}

pub fn list(conn: &Connection, project_path: &str) -> Result<Vec<Automation>, String> {
    let mut statement = conn
        .prepare("SELECT * FROM automations WHERE project_path = ? ORDER BY name")
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([project_path], row_to_automation)
        .map_err(|e| e.to_string())?;
    let automations: rusqlite::Result<Vec<Automation>> = rows.collect();
    Ok(with_next_due(automations.map_err(|e| e.to_string())?))
}

/// Every automation the clock has to consider, across every project on this machine.
pub fn list_scheduled(conn: &Connection) -> Result<Vec<Automation>, String> {
    let mut statement = conn
        .prepare("SELECT * FROM automations WHERE enabled = 1 AND cron IS NOT NULL")
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([], row_to_automation)
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<Automation>>>()
        .map_err(|e| e.to_string())
}

pub fn get(conn: &Connection, automation_id: &str) -> Result<Option<Automation>, String> {
    conn.query_row(
        "SELECT * FROM automations WHERE id = ?",
        [automation_id],
        row_to_automation,
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// Create or replace one automation.
///
/// Per automation rather than a whole document: SQLite is a set of rows, and a whole-document
/// write would have had two clients overwriting each other's edits with whatever each last read.
pub fn save(
    conn: &Connection,
    project_path: &str,
    automation: &Automation,
) -> Result<Automation, String> {
    validate(automation)?;
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "INSERT OR IGNORE INTO projects (path, created_at) VALUES (?, ?)",
        params![project_path, now],
    )
    .map_err(|e| format!("cannot record the project: {e}"))?;

    let workspace = serde_json::to_string(&automation.workspace).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO automations (
            id, project_path, name, prompt, agent_id, cron, timezone, enabled,
            model, permission_mode, effort, workspace, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            prompt = excluded.prompt,
            agent_id = excluded.agent_id,
            cron = excluded.cron,
            timezone = excluded.timezone,
            enabled = excluded.enabled,
            model = excluded.model,
            permission_mode = excluded.permission_mode,
            effort = excluded.effort,
            workspace = excluded.workspace,
            updated_at = excluded.updated_at",
        params![
            automation.id,
            project_path,
            automation.name,
            automation.prompt,
            automation.agent_id,
            automation.cron,
            automation.timezone,
            automation.enabled as i64,
            automation.model,
            automation.permission_mode,
            automation.effort,
            workspace,
            now,
            now,
        ],
    )
    .map_err(|e| format!("cannot save the automation: {e}"))?;

    get(conn, &automation.id)?
        .map(|saved| with_next_due(vec![saved]).remove(0))
        .ok_or_else(|| "the automation vanished as it was written".to_string())
}

pub fn delete(conn: &Connection, automation_id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM automations WHERE id = ?", [automation_id])
        .map(|_| ())
        .map_err(|e| format!("cannot delete the automation: {e}"))
}

/// Claim an occurrence, so the same one cannot be fired twice.
pub fn mark_fired(conn: &Connection, automation_id: &str, at: DateTime<Utc>) -> Result<(), String> {
    conn.execute(
        "UPDATE automations SET last_fired_at = ? WHERE id = ?",
        params![at.to_rfc3339(), automation_id],
    )
    .map(|_| ())
    .map_err(|e| format!("cannot record the firing: {e}"))
}

pub fn last_fired_at(conn: &Connection, automation_id: &str) -> Option<DateTime<Utc>> {
    let stored: Option<String> = conn
        .query_row(
            "SELECT last_fired_at FROM automations WHERE id = ?",
            [automation_id],
            |row| row.get(0),
        )
        .optional()
        .ok()
        .flatten();
    stored
        .and_then(|at| DateTime::parse_from_rfc3339(&at).ok())
        .map(|at| at.with_timezone(&Utc))
}

fn row_to_run(row: &rusqlite::Row<'_>) -> rusqlite::Result<AutomationRun> {
    let status: String = row.get("status")?;
    Ok(AutomationRun {
        id: row.get("id")?,
        automation_id: row.get("automation_id")?,
        project_path: row.get("project_path")?,
        automation_name: row.get("automation_name")?,
        status: match status.as_str() {
            "running" => AutomationRunStatus::Running,
            "succeeded" => AutomationRunStatus::Succeeded,
            _ => AutomationRunStatus::Failed,
        },
        scheduled: row.get::<_, i64>("scheduled")? != 0,
        started_at: row.get("started_at")?,
        finished_at: row.get("finished_at")?,
        session_id: row.get("session_id")?,
        error: row.get("error")?,
        agent_session_id: row.get("agent_session_id")?,
        agent_id: row.get("agent_id")?,
        cwd: row.get("cwd")?,
        can_reload: row
            .get::<_, Option<i64>>("can_reload")?
            .map(|flag| flag != 0),
    })
}

fn status_name(status: AutomationRunStatus) -> &'static str {
    match status {
        AutomationRunStatus::Running => "running",
        AutomationRunStatus::Succeeded => "succeeded",
        AutomationRunStatus::Failed => "failed",
    }
}

/// Open a run, before anything is spawned.
///
/// Written first so that a spawn which fails, or a daemon which dies mid-run, still leaves a record
/// of an automation having tried.
pub fn start_run(
    conn: &Connection,
    automation: &Automation,
    scheduled: bool,
) -> Result<AutomationRun, String> {
    let run = AutomationRun {
        id: uuid::Uuid::new_v4().to_string(),
        automation_id: automation.id.clone(),
        project_path: automation.project_path.clone(),
        automation_name: automation.name.clone(),
        status: AutomationRunStatus::Running,
        scheduled,
        started_at: Utc::now().to_rfc3339(),
        finished_at: None,
        session_id: None,
        error: None,
        // Filled in by `attach_session` once there is a session. A run that never gets one failed
        // before it started, and there is nothing to reopen.
        agent_session_id: None,
        agent_id: None,
        cwd: None,
        can_reload: None,
    };
    conn.execute(
        "INSERT INTO runs (
            id, automation_id, project_path, automation_name, status, scheduled, started_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)",
        params![
            run.id,
            run.automation_id,
            run.project_path,
            run.automation_name,
            status_name(run.status),
            run.scheduled as i64,
            run.started_at,
        ],
    )
    .map_err(|e| format!("cannot record the run: {e}"))?;
    Ok(run)
}

/// Record the session a run is happening in, and what it takes to reopen it later.
///
/// `session_id` names a live session and stops resolving once the sweep closes it. The other
/// three are what `session/load` needs, and this row is where they survive that.
pub fn attach_session(
    conn: &Connection,
    run_id: &str,
    session_id: &str,
    agent_session_id: &str,
    agent_id: &str,
    cwd: &str,
    can_reload: bool,
) -> Result<(), String> {
    conn.execute(
        "UPDATE runs
            SET session_id = ?, agent_session_id = ?, agent_id = ?, cwd = ?, can_reload = ?
          WHERE id = ?",
        params![
            session_id,
            agent_session_id,
            agent_id,
            cwd,
            can_reload as i64,
            run_id
        ],
    )
    .map(|_| ())
    .map_err(|e| format!("cannot record the run's session: {e}"))
}

pub fn finish_run(
    conn: &Connection,
    run_id: &str,
    status: AutomationRunStatus,
    error: Option<String>,
) -> Result<Option<AutomationRun>, String> {
    conn.execute(
        "UPDATE runs SET status = ?, finished_at = ?, error = ? WHERE id = ?",
        params![status_name(status), Utc::now().to_rfc3339(), error, run_id],
    )
    .map_err(|e| format!("cannot close the run: {e}"))?;
    conn.query_row("SELECT * FROM runs WHERE id = ?", [run_id], row_to_run)
        .optional()
        .map_err(|e| e.to_string())
}

/// Whether this automation already has a run in flight.
pub fn is_running(conn: &Connection, automation_id: &str) -> bool {
    conn.query_row(
        "SELECT 1 FROM runs WHERE automation_id = ? AND status = 'running' LIMIT 1",
        [automation_id],
        |_| Ok(()),
    )
    .optional()
    .ok()
    .flatten()
    .is_some()
}

/// The run a session belongs to, if a session belongs to one at all.
pub fn run_for_session(conn: &Connection, session_id: &str) -> Option<AutomationRun> {
    conn.query_row(
        "SELECT * FROM runs WHERE session_id = ? AND status = 'running'",
        [session_id],
        row_to_run,
    )
    .optional()
    .ok()
    .flatten()
}

pub fn list_runs(
    conn: &Connection,
    project_path: &str,
    limit: Option<u32>,
) -> Result<Vec<AutomationRun>, String> {
    let limit = limit.unwrap_or(RUN_LIMIT).min(RUN_LIMIT);
    let mut statement = conn
        .prepare(
            "SELECT * FROM runs WHERE project_path = ? ORDER BY started_at DESC, rowid DESC LIMIT ?",
        )
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map(params![project_path, limit], row_to_run)
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<AutomationRun>>>()
        .map_err(|e| e.to_string())
}

/// Close out runs left open by a daemon that died mid-run.
///
/// Called once at startup. The sessions they named are gone with the process that held them, so a
/// row still saying "running" would be a spinner nothing will ever stop.
pub fn fail_interrupted_runs(conn: &Connection) -> Result<usize, String> {
    conn.execute(
        "UPDATE runs SET status = 'failed', finished_at = ?, error = ?
         WHERE status = 'running'",
        params![
            Utc::now().to_rfc3339(),
            "The background server stopped while this was running"
        ],
    )
    .map_err(|e| format!("cannot close out interrupted runs: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> Connection {
        let conn = Connection::open_in_memory().expect("in-memory database");
        conn.execute_batch(SCHEMA).expect("schema");
        conn
    }

    fn automation(id: &str, cron: Option<&str>) -> Automation {
        Automation {
            id: id.to_string(),
            project_path: "/p".to_string(),
            name: format!("Automation {id}"),
            prompt: "do the thing".to_string(),
            agent_id: "claude".to_string(),
            cron: cron.map(str::to_string),
            timezone: "Europe/Paris".to_string(),
            enabled: true,
            model: None,
            permission_mode: None,
            effort: None,
            workspace: AutomationWorkspace::Repository,
            next_due_at: None,
        }
    }

    #[test]
    fn saving_twice_updates_rather_than_duplicates() {
        let conn = store();
        save(&conn, "/p", &automation("a", None)).expect("first save");
        let mut second = automation("a", None);
        second.name = "Renamed".to_string();
        save(&conn, "/p", &second).expect("second save");

        let listed = list(&conn, "/p").expect("list");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].name, "Renamed");
    }

    #[test]
    fn a_five_field_cron_counts_weekdays_the_way_cron_does() {
        // Sunday is 0 in a crontab and 1 in the crate, so an unshifted expression would fire on
        // Saturdays instead.
        let after = DateTime::parse_from_rfc3339("2026-01-01T00:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let next = next_due("0 9 * * 0", "UTC", after).expect("a next occurrence");
        assert_eq!(next.to_rfc3339(), "2026-01-04T09:00:00+00:00");
        assert_eq!(next.format("%A").to_string(), "Sunday");
    }

    #[test]
    fn a_step_expression_fires_within_the_hour() {
        // What the editor writes for anything below a day. The seconds field this prepends must
        // not shift the step onto the wrong column.
        let after = DateTime::parse_from_rfc3339("2026-01-01T09:07:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let minutes = next_due("*/30 * * * *", "UTC", after).expect("a next occurrence");
        assert_eq!(minutes.to_rfc3339(), "2026-01-01T09:30:00+00:00");
        let hours = next_due("0 */6 * * *", "UTC", after).expect("a next occurrence");
        assert_eq!(hours.to_rfc3339(), "2026-01-01T12:00:00+00:00");
    }

    #[test]
    fn a_schedule_is_read_in_its_own_timezone() {
        let after = DateTime::parse_from_rfc3339("2026-01-01T00:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let paris = next_due("0 9 * * *", "Europe/Paris", after).expect("next");
        let utc = next_due("0 9 * * *", "UTC", after).expect("next");
        assert_eq!(paris.to_rfc3339(), "2026-01-01T08:00:00+00:00");
        assert_eq!(utc.to_rfc3339(), "2026-01-01T09:00:00+00:00");
    }

    #[test]
    fn validation_refuses_what_the_clock_could_not_read() {
        let mut bad_zone = automation("a", None);
        bad_zone.timezone = "Middle/Earth".to_string();
        assert!(validate(&bad_zone).is_err());

        let bad_cron = automation("a", Some("not a cron"));
        assert!(validate(&bad_cron).is_err());

        assert!(validate(&automation("a", Some("*/5 * * * *"))).is_ok());
    }

    #[test]
    fn a_disabled_automation_has_no_next_occurrence() {
        let conn = store();
        let mut disabled = automation("a", Some("0 9 * * *"));
        disabled.enabled = false;
        save(&conn, "/p", &disabled).expect("save");
        save(&conn, "/p", &automation("b", Some("0 9 * * *"))).expect("save");

        let listed = list(&conn, "/p").expect("list");
        let by_id = |id: &str| listed.iter().find(|a| a.id == id).expect("present").clone();
        assert!(by_id("a").next_due_at.is_none());
        assert!(by_id("b").next_due_at.is_some());
        assert_eq!(list_scheduled(&conn).expect("scheduled").len(), 1);
    }

    #[test]
    fn a_run_outlives_the_automation_that_produced_it() {
        let conn = store();
        let saved = save(&conn, "/p", &automation("a", None)).expect("save");
        let run = start_run(&conn, &saved, true).expect("start");
        attach_session(
            &conn,
            &run.id,
            "session-1",
            "agent-session-1",
            "claude-acp",
            "/p",
            true,
        )
        .expect("attach");
        delete(&conn, "a").expect("delete");

        let runs = list_runs(&conn, "/p", None).expect("runs");
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].automation_name, "Automation a");
        assert_eq!(runs[0].session_id.as_deref(), Some("session-1"));
        // The three below are what a closed session is reopened from, so a run keeps them even
        // after the automation that produced it is gone.
        assert_eq!(runs[0].agent_session_id.as_deref(), Some("agent-session-1"));
        assert_eq!(runs[0].agent_id.as_deref(), Some("claude-acp"));
        assert_eq!(runs[0].can_reload, Some(true));
    }

    #[test]
    fn an_interrupted_run_does_not_stay_running() {
        let conn = store();
        let saved = save(&conn, "/p", &automation("a", None)).expect("save");
        let run = start_run(&conn, &saved, false).expect("start");
        attach_session(
            &conn,
            &run.id,
            "session-1",
            "agent-session-1",
            "claude-acp",
            "/p",
            true,
        )
        .expect("attach");
        assert!(run_for_session(&conn, "session-1").is_some());

        assert_eq!(fail_interrupted_runs(&conn).expect("sweep"), 1);
        assert!(run_for_session(&conn, "session-1").is_none());
        assert_eq!(
            list_runs(&conn, "/p", None).expect("runs")[0].status,
            AutomationRunStatus::Failed
        );
    }
}
