//! Automations, their runs and their webhooks.

use serde::{Deserialize, Serialize};

/// Where an automation's agent runs.
///
/// A path rather than the app's worktree row id: the daemon has to act on this with no access to
/// the app's database, and on a remote project not even to the machine that database is on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum AutomationWorkspace {
    /// The project directory itself.
    Repository,
    /// A directory that already exists, named outright.
    Path { path: String },
    /// A fresh worktree per run, branched from `base_branch`.
    ///
    /// Created and removed by the daemon, which is the process on the machine the repository is
    /// on. The app adopts a `worktrees` row for one that outlives its run; see phase 4 of
    /// `docs/automations-plan.md`.
    NewWorktree { base_branch: String },
}

/// One automation, whole.
///
/// The agent settings are the automation's own rather than a reference to an agent profile.
/// Profiles say what a *pipeline role* means on a project, and an automation has no role.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct Automation {
    pub id: String,
    /// Canonicalized path of the project this belongs to, as the daemon resolved it.
    pub project_path: String,
    pub name: String,
    /// What the agent is asked to do. The whole contract of the run.
    pub prompt: String,
    pub agent_id: String,
    /// Five-field cron, or `None` for an automation that only runs when asked.
    ///
    /// Cron rather than the editor's presets because the daemon is what evaluates it, and a preset
    /// is a shape the UI can compile to this rather than a second thing to store.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cron: Option<String>,
    /// IANA name the cron is read in, so a laptop that crosses a timezone keeps its schedule.
    pub timezone: String,
    /// Whether the schedule is live. Disabling stops the clock; running it by hand still works,
    /// which is what makes this a pause rather than a second kind of delete.
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// The ACP session mode id. `None` leaves it to the agent, which for an unattended run means
    /// whatever that agent's default asks before doing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    pub workspace: AutomationWorkspace,
    /// Whether `POST /hooks/<id>` starts this. Independent of `enabled` above only in one
    /// direction: with `enabled` off, nothing automatic fires, webhook included.
    pub webhook_enabled: bool,
    /// What a delivery does while a run of this automation is already going.
    pub webhook_overlap: WebhookOverlap,
    /// What a webhook sender signs with, or presents as a bearer token. Made by the server when
    /// the webhook is first turned on and changed only by `RollWebhookSecret`, so a save from a
    /// client never touches it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub webhook_secret: Option<String>,
    /// When this next comes round, RFC 3339. Computed on read and never stored — a stored one
    /// would be wrong the moment the clock or the timezone database moved.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_due_at: Option<String>,
}

/// What happened to one firing of an automation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum AutomationRunStatus {
    Running,
    Succeeded,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct AutomationRun {
    pub id: String,
    pub automation_id: String,
    pub project_path: String,
    /// Copied rather than joined, so a run still says what it was even after the automation that
    /// produced it is renamed or deleted.
    pub automation_name: String,
    pub status: AutomationRunStatus,
    /// What started it: the clock, somebody pressing Run now, or a webhook.
    pub trigger: RunTrigger,
    pub started_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<String>,
    /// The session the run is happening in, absent when the spawn itself failed. This is how a
    /// client finds a session the daemon started, since nothing the host wrote is attached to it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// The agent's own id for this conversation, which is what `session/load` resumes from.
    ///
    /// `session_id` above names a live session and stops resolving the moment the idle sweep
    /// closes it. These three are what it takes to open the run again afterwards, and this row is
    /// the only place they outlive the session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    /// Whether that agent answers `session/load`. `None` for a run recorded before this was kept.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub can_reload: Option<bool>,
    /// The worktree this run provisioned, while it is still on disk. Cleared once the daemon has
    /// removed it, so a value here means there is a directory somebody still has to deal with —
    /// which is also what the app adopts a `worktrees` row from. `cwd` above keeps the record of
    /// where the run happened either way.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree_path: Option<String>,
    /// The local branch created with it, and deleted with it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree_branch: Option<String>,
    /// What that branch was cut from, resolved at creation. Carried so the app's adopted row can
    /// say how many commits the run made, which is the question a kept workspace raises.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree_base: Option<String>,
    /// Why that worktree was kept rather than removed, in words meant for the person who has to
    /// act on it. `None` means nothing was kept, which is also true of a run still going.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree_kept: Option<String>,
    /// Which run of its automation this is, counting from 1. `None` for a run recorded before
    /// runs were numbered. It is what a session opened from this run is labelled with, and the
    /// number in the name of the worktree it made.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ordinal: Option<u32>,
    /// The agent's last message, the text after its final tool call, recorded when the run ends.
    /// What a finished run is read by, so nobody has to open a session to see what it concluded.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<String>,
}

/// Every request below names a project by the path the client knows it by. The daemon
/// canonicalizes it, because it is the process on the machine that path exists on.
#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct ListAutomationsRequest {
    pub project_path: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct ListAutomationsResponse {
    pub automations: Vec<Automation>,
    /// The IANA zone this server's own machine is set to.
    ///
    /// Sent with the list because it is what the editor has to offer: an automation on a remote
    /// project runs on that machine, so "09:00" means one thing there and another where the window
    /// is. Falls back to `UTC` when the machine cannot say.
    pub server_timezone: String,
    /// How much of this project's run history is kept.
    pub retention: RunRetention,
}

/// Which finished runs a project keeps, per automation. A run is deleted only once it breaks every
/// limit that is set: past the newest `keep_last` **and** older than `max_age_days`. Both `None`
/// keeps everything. A running run is never deleted.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct RunRetention {
    pub keep_last: Option<u32>,
    pub max_age_days: Option<u32>,
}

/// What a project that never chose gets: enough to look back on, without growing forever on a
/// machine running an hourly schedule.
impl Default for RunRetention {
    fn default() -> Self {
        Self {
            keep_last: Some(50),
            max_age_days: Some(90),
        }
    }
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct DeleteAutomationRunRequest {
    pub run_id: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct SetRunRetentionRequest {
    pub project_path: String,
    pub retention: RunRetention,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct SaveAutomationRequest {
    pub project_path: String,
    pub automation: Automation,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct DeleteAutomationRequest {
    pub automation_id: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct RunAutomationRequest {
    pub automation_id: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct ListAutomationRunsRequest {
    pub project_path: String,
    /// Newest first, capped by the server whatever this says.
    #[serde(default)]
    pub limit: Option<u32>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct ListAutomationRunsResponse {
    pub runs: Vec<AutomationRun>,
}

/// A schedule the editor is in the middle of writing. Nothing is stored, and no project is named:
/// the answer depends only on the expression and the zone it is read in.
#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct PreviewScheduleRequest {
    pub cron: String,
    pub timezone: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct PreviewScheduleResponse {
    /// RFC 3339, or `None` for an expression with no next occurrence at all. A cron naming
    /// February 30th is valid syntax and never happens.
    #[serde(default)]
    pub next: Option<String>,
}

/// What started a run.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum RunTrigger {
    Schedule,
    #[default]
    Manual,
    Webhook,
}

/// What a webhook delivery does while a run of the same automation is already going.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum WebhookOverlap {
    /// Answer 409 and run nothing.
    #[default]
    Refuse,
    /// Wait in line, up to a cap, and run once the current run ends.
    Queue,
    /// Start another run beside it.
    Parallel,
}

/// The webhook listener of one machine's server, shared by every project on it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct WebhookSettings {
    pub port: u16,
    /// `127.0.0.1` unless a proxy on another machine has to reach it.
    pub bind_address: String,
    /// The address senders actually call, a tunnel's or a reverse proxy's. Webhook URLs are built
    /// from it; `None` means they are shown on the local address.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub public_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct WebhookStatus {
    pub settings: WebhookSettings,
    /// Why the listener is not listening, or `None` when it is.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// What became of one delivery.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum DeliveryOutcome {
    Started,
    Queued,
    /// A run was going and the automation refuses overlap.
    Busy,
    QueueFull,
    RateLimited,
    Unauthorized,
    Duplicate,
    /// The webhook, or everything automatic about the automation, is switched off.
    Disabled,
    TooLarge,
    /// Authorized and accepted, but the run could not be opened.
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct WebhookDelivery {
    pub id: String,
    pub automation_id: String,
    pub received_at: String,
    /// The HTTP status the sender got.
    pub status: u16,
    pub outcome: DeliveryOutcome,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// The run it started, once it has one. A queued delivery gets it when its turn comes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct AutomationIdRequest {
    pub automation_id: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct ListWebhookDeliveriesResponse {
    pub deliveries: Vec<WebhookDelivery>,
}
