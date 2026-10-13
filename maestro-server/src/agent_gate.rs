//! The usage-limit gate. An agent whose turn is refused for a usage limit starts no task until the
//! limit resets: the drain leaves its tasks waiting, and the next real turn is the probe. If that is
//! refused too, the gate closes again.
//!
//! The gate is per agent and per daemon, because a limit belongs to the account the agent runs as.
//! Only `claude-agent-acp` says when a limit resets, as `_claude/rateLimit` on `usage_update`, and
//! only once a turn has had a real model reply, so a fresh session refused on its first prompt
//! carries none. The latest reading from any session of the agent is kept for that, and with no
//! usable reading the gate backs off. The gates are `agent_gates`, made by `V11_LOOPS`.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

use chrono::{DateTime, Duration, Utc};
use maestro_protocol::NewTaskComment;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;

use crate::helpers::send_diag;

/// Minutes to wait after each refusal in a row that came with no reset time.
const BACKOFF_MINUTES: [i64; 5] = [5, 15, 30, 60, 120];

/// What a `_claude/rateLimit` reading says about the account's spent limit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PlanReading {
    /// When the latest-resetting window that is rejected or full resets, in unix seconds. `None`
    /// when the reading names no such window.
    pub resets_at: Option<i64>,
}

/// The agent's latest reading, from whichever of its sessions sent it.
static READINGS: LazyLock<Mutex<HashMap<String, PlanReading>>> = LazyLock::new(Default::default);

/// A refused turn of a task's session, and when its agent's gate opens.
pub(crate) struct Limited {
    pub session_id: String,
    pub until: DateTime<Utc>,
}

/// The plan reading a `usage_update` carries, if it carries one.
pub(crate) fn reading(payload: &Value) -> Option<PlanReading> {
    let info = payload.get("_meta")?.get("_claude/rateLimit")?;
    let seconds = |v: &Value| v.as_f64().map(|s| s as i64);
    let named = (info.get("status")?.as_str()? == "rejected")
        .then(|| seconds(&info["resetsAt"]))
        .flatten();
    let full = info["unifiedWindows"]
        .as_object()
        .into_iter()
        .flat_map(|windows| windows.values())
        .filter(|w| w["utilization"].as_f64().is_some_and(|u| u >= 1.0))
        .filter_map(|w| seconds(&w["resetsAt"]));
    Some(PlanReading {
        resets_at: named.into_iter().chain(full).max(),
    })
}

/// Whether a failed prompt was refused for a usage limit: Claude's `errorKind`, or for any agent
/// an error message that names one.
pub(crate) fn is_limit(data: Option<&Value>, message: &str) -> bool {
    let kind = data
        .and_then(|d| d.get("errorKind"))
        .and_then(Value::as_str);
    if matches!(kind, Some("rate_limit" | "billing_error")) {
        return true;
    }
    let message = message.to_lowercase();
    [
        "usage limit",
        "rate limit",
        "rate_limit",
        "quota",
        "hit your limit",
    ]
    .iter()
    .any(|words| message.contains(words))
        || message
            .split(|c: char| !c.is_ascii_alphanumeric())
            .any(|word| word == "429")
}

/// A turn of `agent_id` ended. Keeps its plan reading. A refusal closes the gate and returns when
/// it opens; a turn that ended normally opens it, since the account answers again.
pub(crate) fn turn_ended(
    conn: &Connection,
    agent_id: &str,
    facts: &crate::turn::TurnFacts,
    stop_reason: &str,
    now: DateTime<Utc>,
) -> Option<DateTime<Utc>> {
    let known = {
        let mut readings = READINGS.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(reading) = facts.plan_reading {
            readings.insert(agent_id.to_string(), reading);
        }
        readings
            .get(agent_id)
            .and_then(|r| r.resets_at)
            .and_then(|s| DateTime::from_timestamp(s, 0))
            .filter(|at| *at > now)
    };
    let written = if facts.usage_limited {
        close(conn, agent_id, known, now).map(Some)
    } else if stop_reason == "end_turn" {
        open(conn, agent_id).map(|()| None)
    } else {
        Ok(None)
    };
    written.unwrap_or_else(|e| {
        send_diag("warn", format!("[gate] agent {agent_id}: {e}"));
        None
    })
}

/// Close the gate until `known`, or with no reset time until the next backoff. A gate already
/// closed by another session's refusal stays as it is: that refusal was the same limit.
fn close(
    conn: &Connection,
    agent_id: &str,
    known: Option<DateTime<Utc>>,
    now: DateTime<Utc>,
) -> Result<DateTime<Utc>, String> {
    let fail = |e: rusqlite::Error| format!("cannot close the gate: {e}");
    let row: Option<(String, i64)> = conn
        .query_row(
            "SELECT resume_at, backoff_step FROM agent_gates WHERE agent_id = ?1",
            params![agent_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(fail)?;
    let closed = row
        .as_ref()
        .and_then(|(at, _)| parse(at))
        .filter(|at| *at > now);
    let step = row.map_or(0, |(_, step)| step);
    // `backoff_step` counts the refusals in a row that came with no reset time.
    let (resume_at, step, reason) = match (known, closed) {
        (Some(at), _) => (at, step, "reset"),
        (None, Some(at)) => return Ok(at),
        (None, None) => {
            let minutes = BACKOFF_MINUTES[(step.max(0) as usize).min(BACKOFF_MINUTES.len() - 1)];
            (now + Duration::minutes(minutes), step + 1, "backoff")
        }
    };
    conn.execute(
        "INSERT INTO agent_gates (agent_id, resume_at, reason, backoff_step) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (agent_id) DO UPDATE
         SET resume_at = excluded.resume_at, reason = excluded.reason,
             backoff_step = excluded.backoff_step",
        params![agent_id, resume_at.to_rfc3339(), reason, step],
    )
    .map_err(fail)?;
    send_diag(
        "info",
        format!("[gate] agent {agent_id} hit a usage limit, closed until {resume_at}"),
    );
    Ok(resume_at)
}

/// Open the gate, and start the backoff over.
pub(crate) fn open(conn: &Connection, agent_id: &str) -> Result<(), String> {
    conn.execute(
        "DELETE FROM agent_gates WHERE agent_id = ?1",
        params![agent_id],
    )
    .map(|_| ())
    .map_err(|e| format!("cannot open the gate: {e}"))
}

/// When `agent_id`'s gate opens, while it is closed.
pub(crate) fn closed_until(
    conn: &Connection,
    agent_id: &str,
    now: DateTime<Utc>,
) -> Option<DateTime<Utc>> {
    conn.query_row(
        "SELECT resume_at FROM agent_gates WHERE agent_id = ?1",
        params![agent_id],
        |row| row.get::<_, String>(0),
    )
    .ok()
    .and_then(|at| parse(&at))
    .filter(|at| *at > now)
}

fn parse(at: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(at)
        .ok()
        .map(|at| at.with_timezone(&Utc))
}

/// The thread's note on a task whose turn was refused.
pub(crate) fn note(until: DateTime<Utc>) -> NewTaskComment {
    let at = until.with_timezone(&chrono::Local).format("%a %H:%M");
    NewTaskComment {
        kind: "note".to_string(),
        author: "maestro".to_string(),
        body: Some(format!(
            "The agent hit its usage limit, so this task waits until {at} and then goes on."
        )),
        external_ref: None,
        phase: None,
    }
}

/// `OpenAgentGate`: Try now. The drain starts the agent's waiting tasks.
pub(crate) async fn answer_open(
    store: &crate::project_store::Store,
    agent_id: &str,
) -> maestro_protocol::ServerResponse {
    match open(&*store.lock().await, agent_id) {
        Ok(()) => {
            crate::scheduler::request_all();
            maestro_protocol::ServerResponse::OpenAgentGateOk
        }
        Err(e) => crate::helpers::error_response(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::turn::TurnFacts;

    fn at(s: &str) -> DateTime<Utc> {
        parse(s).unwrap()
    }

    fn refused(reading: Option<PlanReading>) -> TurnFacts {
        TurnFacts {
            usage_limited: true,
            plan_reading: reading,
            ..Default::default()
        }
    }

    #[test]
    fn a_reading_names_the_spent_window_that_resets_last() {
        let update = serde_json::json!({
            "sessionUpdate": "usage_update",
            "_meta": {"_claude/rateLimit": {
                "status": "rejected", "rateLimitType": "five_hour", "resetsAt": 1000,
                "unifiedWindows": {
                    "five_hour": {"utilization": 1.0, "resetsAt": 1000},
                    "seven_day": {"utilization": 1.0, "resetsAt": 9000.0}
                }
            }}
        });
        assert_eq!(reading(&update).unwrap().resets_at, Some(9000));
        let warning = serde_json::json!({"_meta": {"_claude/rateLimit": {
            "status": "allowed_warning", "resetsAt": 1000,
            "unifiedWindows": {"five_hour": {"utilization": 0.9, "resetsAt": 1000}}
        }}});
        assert_eq!(reading(&warning).unwrap().resets_at, None);
        assert_eq!(reading(&serde_json::json!({"used": 1})), None);
    }

    #[test]
    fn a_limit_is_known_by_claudes_error_kind_or_its_words() {
        let kind = serde_json::json!({"errorKind": "rate_limit"});
        assert!(is_limit(Some(&kind), "Internal error"));
        assert!(is_limit(
            None,
            "Internal error: You've hit your limit · resets 8pm"
        ));
        assert!(is_limit(None, "HTTP 429 Too Many Requests"));
        assert!(is_limit(None, "Quota exceeded for this account"));
        assert!(!is_limit(None, "failed at line 4290"));
        let other = serde_json::json!({"errorKind": "server_error"});
        assert!(!is_limit(Some(&other), "Internal error"));
    }

    #[test]
    fn the_gate_waits_for_the_reading_or_backs_off_and_a_normal_turn_opens_it() {
        let conn = crate::project_store::open_in_memory();
        let now = at("2026-10-13T12:00:00Z");
        let agent = "gate-test-backoff";

        // No reading: 5 minutes, then 15 once the first has passed and the next turn is refused.
        assert_eq!(
            turn_ended(&conn, agent, &refused(None), "error", now),
            Some(now + Duration::minutes(5))
        );
        assert!(closed_until(&conn, agent, now).is_some());
        // A second session refused while the gate is closed is the same limit.
        assert_eq!(
            turn_ended(
                &conn,
                agent,
                &refused(None),
                "error",
                now + Duration::minutes(1)
            ),
            Some(now + Duration::minutes(5))
        );
        let later = now + Duration::minutes(6);
        assert_eq!(closed_until(&conn, agent, later), None);
        assert_eq!(
            turn_ended(&conn, agent, &refused(None), "error", later),
            Some(later + Duration::minutes(15))
        );

        // A turn that ends normally opens it and starts the backoff over.
        turn_ended(&conn, agent, &TurnFacts::default(), "end_turn", later);
        assert_eq!(closed_until(&conn, agent, later), None);
        assert_eq!(
            turn_ended(&conn, agent, &refused(None), "error", later),
            Some(later + Duration::minutes(5))
        );
        open(&conn, agent).unwrap();

        // A reading from an earlier turn of any session says when.
        let reset = at("2026-10-13T20:00:00Z");
        let earlier = TurnFacts {
            plan_reading: Some(PlanReading {
                resets_at: Some(reset.timestamp()),
            }),
            ..Default::default()
        };
        turn_ended(&conn, agent, &earlier, "end_turn", now);
        assert_eq!(closed_until(&conn, agent, now), None);
        assert_eq!(
            turn_ended(&conn, agent, &refused(None), "error", now),
            Some(reset)
        );
    }
}
