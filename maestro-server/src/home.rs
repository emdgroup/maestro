//! What Home shows for each project on this machine, answered in one round trip.
//!
//! Read from what the daemon already holds: the project store's tasks and sessions, the
//! automation store, the session map and the project locks.

use std::collections::BTreeMap;

use maestro_protocol::{PendingSessionRequest, ProjectLockInfo, ProjectSummary};
use rusqlite::Connection;

use crate::automations::canonical_project_path;
use crate::sessions::SessionMap;

/// Projects by canonical path, each listed once whichever source named it first.
#[derive(Default)]
pub struct Summaries(BTreeMap<String, ProjectSummary>);

impl Summaries {
    fn entry(&mut self, project_path: String) -> &mut ProjectSummary {
        self.0
            .entry(project_path.clone())
            .or_insert_with(|| ProjectSummary {
                project_path,
                ..ProjectSummary::default()
            })
    }

    /// The client's own projects, listed even when the daemon holds nothing for them.
    pub fn requested(&mut self, paths: &[String]) {
        for path in paths {
            self.entry(canonical_project_path(path));
        }
    }

    /// Every project with tasks or sessions, and its task counts.
    ///
    /// The status counts are the board's columns, which leave archived tasks out. `needs_you`
    /// mirrors `needsMeCount` in `src/views/kanban/KanbanView.tsx`: every task with the ball on
    /// the user, archived or not.
    pub fn project_store(&mut self, conn: &Connection) -> Result<(), String> {
        let mut statement = conn
            .prepare(
                "SELECT project_path,
                        SUM(status = 'Queue' AND archived_at IS NULL),
                        SUM(status = 'InProgress' AND archived_at IS NULL),
                        SUM(status = 'Review' AND archived_at IS NULL),
                        SUM(ball = 'User')
                   FROM tasks GROUP BY project_path",
            )
            .map_err(|e| e.to_string())?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    [row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?],
                ))
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (path, [queued, in_progress, review, needs_you]) =
                row.map_err(|e| e.to_string())?;
            let summary = self.entry(path);
            summary.queued = queued;
            summary.in_progress = in_progress;
            summary.review = review;
            summary.needs_you += needs_you;
        }
        for path in column(conn, "SELECT DISTINCT project_path FROM sessions")? {
            self.entry(path);
        }
        Ok(())
    }

    /// Every project with automations, and the names of the ones running.
    pub fn automations(&mut self, conn: &Connection) -> Result<(), String> {
        for path in column(conn, "SELECT DISTINCT project_path FROM automations")? {
            self.entry(path);
        }
        let mut statement = conn
            .prepare(
                "SELECT project_path, automation_name FROM runs
                  WHERE status = 'running' ORDER BY started_at",
            )
            .map_err(|e| e.to_string())?;
        let rows = statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (path, name) = row.map_err(|e| e.to_string())?;
            self.entry(path).running_automations.push(name);
        }
        Ok(())
    }

    /// Agents mid-turn and the prompts waiting on the user.
    ///
    /// A task session's prompt is not counted: the task is marked blocked, which puts the ball on
    /// the user, before the prompt is shown, so the task already counts it.
    pub async fn sessions(&mut self, sessions: &SessionMap) {
        for session in sessions.values() {
            let Some(binding) = &session.project else {
                continue;
            };
            let pending = crate::dispatch::pending_requests(session).await;
            let summary = self.entry(canonical_project_path(&binding.project_path));
            if session
                .turn_active
                .load(std::sync::atomic::Ordering::SeqCst)
            {
                summary.working_agents += 1;
            }
            if binding.meta.task_id.is_none() {
                summary.needs_you += pending.len() as u32;
            }
            if summary.blocking_prompt.is_none() {
                summary.blocking_prompt = pending.first().map(prompt_text);
            }
        }
    }

    /// Every path, as `ListProjectLocks` takes them: what was sent beside its canonical form.
    pub fn lock_query(&self) -> Vec<(String, String)> {
        self.0
            .keys()
            .map(|path| (path.clone(), path.clone()))
            .collect()
    }

    pub fn locks(&mut self, locks: Vec<ProjectLockInfo>) {
        for lock in locks {
            let summary = self.entry(lock.project_path);
            summary.lock_holder = Some(lock.holder_label);
            summary.lock_yours = lock.yours;
        }
    }

    pub fn into_vec(self) -> Vec<ProjectSummary> {
        self.0.into_values().collect()
    }
}

fn column(conn: &Connection, sql: &str) -> Result<Vec<String>, String> {
    let mut statement = conn.prepare(sql).map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([], |row| row.get(0))
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<_>>()
        .map_err(|e| e.to_string())
}

/// What a prompt asks: an elicitation's message, or the title of the tool call a permission is
/// for, which ACP sends as `toolCall.title`.
fn prompt_text(request: &PendingSessionRequest) -> String {
    match request {
        PendingSessionRequest::Elicitation(request) => request.message.clone(),
        PendingSessionRequest::Permission(request) => request
            .payload
            .pointer("/toolCall/title")
            .and_then(|title| title.as_str())
            .unwrap_or("Permission requested")
            .to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task(conn: &Connection, path: &str, id: i32, status: &str, ball: &str, archived: bool) {
        conn.execute(
            "INSERT INTO tasks (project_path, id, title, base_branch, status, ball, archived_at,
                                created_at, updated_at)
             VALUES (?1, ?2, 'task', 'main', ?3, ?4, ?5, 'now', 'now')",
            rusqlite::params![path, id, status, ball, archived.then_some("now")],
        )
        .unwrap();
    }

    #[test]
    fn lists_every_project_once_with_its_counts() {
        let requested = tempfile::tempdir().unwrap();
        let requested_path = canonical_project_path(&requested.path().to_string_lossy());

        let projects = crate::project_store::open_in_memory();
        task(&projects, &requested_path, 1, "Queue", "Agent", false);
        task(&projects, &requested_path, 2, "InProgress", "User", false);
        task(&projects, &requested_path, 3, "Review", "User", false);
        task(&projects, &requested_path, 4, "Review", "None", true);
        task(&projects, "/srv/tasks", 1, "Queue", "None", false);
        projects
            .execute(
                "INSERT INTO sessions (agent_id, acp_session_id, project_path, cwd, created_at)
                 VALUES ('claude', 'one', '/srv/sessions', '/srv/sessions', 'now')",
                [],
            )
            .unwrap();

        let dir = tempfile::tempdir().unwrap();
        let automations = crate::automations::open(dir.path()).unwrap();
        automations
            .execute_batch(
                "INSERT INTO projects (path, created_at) VALUES ('/srv/automations', 'now');
                 INSERT INTO automations (id, project_path, name, prompt, agent_id, timezone,
                                          enabled, workspace, created_at, updated_at)
                 VALUES ('a', '/srv/automations', 'Nightly', 'go', 'claude', 'UTC', 1, '{}',
                         'now', 'now');
                 INSERT INTO runs (id, automation_id, project_path, automation_name, status,
                                   scheduled, started_at)
                 VALUES ('r1', 'a', '/srv/automations', 'Nightly', 'running', 1, 'now'),
                        ('r2', 'a', '/srv/automations', 'Nightly', 'succeeded', 1, 'now');",
            )
            .unwrap();

        let mut summaries = Summaries::default();
        // A trailing separator, so it only lines up with the store's rows once canonicalized.
        summaries.requested(&[format!("{}/", requested.path().to_string_lossy())]);
        summaries.project_store(&projects).unwrap();
        summaries.automations(&automations).unwrap();
        summaries.locks(vec![ProjectLockInfo {
            project_path: "/srv/tasks".to_string(),
            holder_label: "laptop".to_string(),
            yours: false,
        }]);
        let listed: BTreeMap<String, ProjectSummary> = summaries
            .into_vec()
            .into_iter()
            .map(|summary| (summary.project_path.clone(), summary))
            .collect();

        let paths: Vec<&str> = listed.keys().map(String::as_str).collect();
        let mut expected = vec![
            requested_path.as_str(),
            "/srv/automations",
            "/srv/sessions",
            "/srv/tasks",
        ];
        expected.sort();
        assert_eq!(paths, expected);

        let mine = &listed[&requested_path];
        assert_eq!(
            (mine.queued, mine.in_progress, mine.review, mine.needs_you),
            (1, 1, 1, 2)
        );
        assert_eq!(
            listed["/srv/automations"].running_automations,
            vec!["Nightly".to_string()]
        );
        assert_eq!(listed["/srv/tasks"].lock_holder.as_deref(), Some("laptop"));
        assert!(!listed["/srv/tasks"].lock_yours);
        assert_eq!(
            listed["/srv/sessions"],
            ProjectSummary {
                project_path: "/srv/sessions".to_string(),
                ..ProjectSummary::default()
            }
        );
    }

    #[test]
    fn a_prompt_reads_as_what_it_asks() {
        let permission = |payload| {
            PendingSessionRequest::Permission(maestro_protocol::PermissionRequest {
                session_id: "s".to_string(),
                request_id: "r".to_string(),
                payload,
            })
        };
        assert_eq!(
            prompt_text(&permission(
                serde_json::json!({"toolCall": {"title": "Run tests"}})
            )),
            "Run tests"
        );
        assert_eq!(
            prompt_text(&permission(serde_json::json!({}))),
            "Permission requested"
        );
        let elicitation =
            PendingSessionRequest::Elicitation(maestro_protocol::ElicitationRequest {
                session_id: "s".to_string(),
                request_id: "r".to_string(),
                message: "Which branch?".to_string(),
                payload: serde_json::Value::Null,
            });
        assert_eq!(prompt_text(&elicitation), "Which branch?");
    }
}
