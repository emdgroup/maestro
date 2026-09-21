//! Automations: an agent this project runs on its own, for work nobody should have to file a task
//! for.
//!
//! An automation is not a task and does not enter the pipeline. It is a prompt, an agent to run it
//! and a workspace to run it in; what the run *produces* — a file, a commit, a pull request, a
//! task — is whatever the prompt asks for, using the tools the agent already has. That is why
//! there is no output field here: the prompt is the contract.
//!
//! Stored in `.maestro/automations.json`, beside the project rather than in the database, so an
//! automation travels with the checkout it runs against — including to the remote for SSH and WSL
//! projects, where the agent actually runs.
//!
//! Not shared with the team: `ensure_project_storage` writes `.maestro/` into the repository's
//! `info/exclude`, so the file is this machine's and stays out of every commit. Reuse across
//! machines and projects is what the automation templates are for.
//!
//! Deliberately absent: anything about a *run*. Which session an automation is currently driving
//! would outlive the session it names — sessions do not survive a restart — so a stored id would
//! have to be swept at startup to stop it lying. The frontend keeps it in memory instead.

use serde::{Deserialize, Serialize};
use specta::Type;
use std::sync::Arc;
use tauri::State;

use crate::core::project_storage::{read_maestro_json, write_maestro_json};
use crate::core::AppState;
use crate::models::WorkspaceMode;

pub const AUTOMATIONS_FILE: &str = "automations.json";

fn default_true() -> bool {
    true
}

/// How often a schedule comes round.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "PascalCase")]
pub enum ScheduleKind {
    Daily,
    /// Monday to Friday.
    Weekdays,
    /// One day a week, named by `weekday`.
    Weekly,
}

/// When an automation fires on its own.
///
/// Presets rather than a cron expression: the app has to *show* a schedule as much as run it, and
/// "every second Tuesday at 03:17" is a sentence nobody wanted to write here. A cron field can be
/// added later as another kind without moving what exists.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct AutomationSchedule {
    pub kind: ScheduleKind,
    /// `HH:MM`, in the machine's own local time. There is no timezone field because there is
    /// nowhere else for it to run: an automation only fires while Maestro is open on this machine.
    pub time: String,
    /// 0 is Sunday through 6 is Saturday. Only read for `Weekly`.
    #[specta(optional)]
    pub weekday: Option<u8>,
}

/// One automation, whole.
///
/// The agent settings are the automation's own rather than a reference to an agent profile.
/// Profiles exist to say what a *pipeline role* means on this project, and an automation has no
/// role: picking one would have meant showing the user a list of Refiners and Reviewers to choose
/// between for work that is neither.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct Automation {
    pub id: String,
    pub name: String,
    /// What the agent is asked to do. The whole contract of the run.
    pub prompt: String,
    pub agent_id: String,
    /// When it fires by itself. `None` means it only runs when the user presses Run now.
    #[serde(default)]
    #[specta(optional)]
    pub schedule: Option<AutomationSchedule>,
    /// Whether the schedule is live. Disabling stops the clock; Run now still works, which is what
    /// makes this a pause rather than a second kind of delete.
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[specta(optional)]
    pub model: Option<String>,
    /// The ACP session mode id. `None` leaves it to the agent, which for an unattended run means
    /// whatever that agent's default asks before doing.
    #[specta(optional)]
    pub permission_mode: Option<String>,
    #[specta(optional)]
    pub effort: Option<String>,
    pub workspace_mode: WorkspaceMode,
    /// The worktree to run in, for `ReuseWorkspace`.
    #[specta(optional)]
    pub workspace_worktree_id: Option<i32>,
    /// What a `NewWorktree` run branches from. The branch itself is named per run rather than
    /// stored: a fixed name would collide with the worktree the previous run left behind.
    #[specta(optional)]
    pub base_branch: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, Type)]
pub struct AutomationsDocument {
    #[serde(default)]
    pub automations: Vec<Automation>,
}

async fn git_conn(
    app_state: &Arc<AppState>,
    project_id: i32,
) -> Result<crate::models::GitConnection, String> {
    let (_, conn) = crate::core::get_project_with_git_conn(app_state, project_id).await?;
    Ok(conn)
}

/// Checked here rather than only in the editor, because the file is hand-editable: a time the
/// frontend cannot parse would otherwise be an automation that silently never fires.
fn validate_schedule(name: &str, schedule: &AutomationSchedule) -> Result<(), String> {
    let bad_time = || {
        format!(
            "Automation '{name}' has an invalid time '{}'",
            schedule.time
        )
    };
    let (hours, minutes) = schedule.time.split_once(':').ok_or_else(bad_time)?;
    let hours: u8 = hours.parse().map_err(|_| bad_time())?;
    let minutes: u8 = minutes.parse().map_err(|_| bad_time())?;
    if hours > 23 || minutes > 59 {
        return Err(bad_time());
    }
    if schedule.kind == ScheduleKind::Weekly && !matches!(schedule.weekday, Some(0..=6)) {
        return Err(format!("Automation '{name}' has no weekday to run on"));
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn list_automations(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
) -> Result<AutomationsDocument, String> {
    let conn = git_conn(&app_state, project_id).await?;
    Ok(read_maestro_json(&conn, AUTOMATIONS_FILE).await)
}

/// Replace the whole document.
///
/// Whole-document because the file is hand-editable and the UI already holds the full list: a
/// partial write would have to merge with whatever the user last typed into it, for no gain.
#[tauri::command]
#[specta::specta]
pub async fn save_automations(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    document: AutomationsDocument,
) -> Result<(), String> {
    let mut seen = std::collections::HashSet::new();
    for automation in &document.automations {
        if automation.id.trim().is_empty() {
            return Err("Every automation needs an id".to_string());
        }
        if !seen.insert(automation.id.clone()) {
            return Err(format!("Duplicate automation id '{}'", automation.id));
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
        if let Some(schedule) = &automation.schedule {
            validate_schedule(&automation.name, schedule)?;
        }
    }

    let conn = git_conn(&app_state, project_id).await?;
    crate::core::project_storage::ensure_project_storage(&conn).await?;
    write_maestro_json(&conn, AUTOMATIONS_FILE, &document).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn schedule(kind: ScheduleKind, time: &str, weekday: Option<u8>) -> AutomationSchedule {
        AutomationSchedule {
            kind,
            time: time.to_string(),
            weekday,
        }
    }

    #[test]
    fn accepts_a_well_formed_schedule() {
        assert!(validate_schedule("a", &schedule(ScheduleKind::Daily, "09:00", None)).is_ok());
        assert!(validate_schedule("a", &schedule(ScheduleKind::Weekly, "23:59", Some(6))).is_ok());
    }

    #[test]
    fn rejects_a_time_the_frontend_could_not_run() {
        for time in ["", "9", "24:00", "09:60", "nine", "09:00:00"] {
            assert!(
                validate_schedule("a", &schedule(ScheduleKind::Daily, time, None)).is_err(),
                "accepted {time}"
            );
        }
    }

    #[test]
    fn rejects_a_weekly_schedule_with_no_day() {
        assert!(validate_schedule("a", &schedule(ScheduleKind::Weekly, "09:00", None)).is_err());
        assert!(validate_schedule("a", &schedule(ScheduleKind::Weekly, "09:00", Some(7))).is_err());
    }
}
