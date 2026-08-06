use serde::{Deserialize, Serialize};
use specta::Type;
use std::str::FromStr;

/// SQL SELECT clause for all task columns, matching Task::from_row column order.
///
/// Column order: id(0), project_id(1), title(2), description(3), status(4), priority(5),
/// base_branch(6), archived_at(7), external_id(8), is_imported(9), import_source(10),
/// skills(11), model_override(12), mcp_allowlist(13), skills_override(14), labels(15),
/// external_url(16), external_updated_at(17), created_at(18), updated_at(19),
/// auto_approve(20), isolated_worktree(21), agent_id(22), permission_mode_override(23),
/// execution_start_sha(24), phase(25), phase_status(26), ball(27)
pub const TASK_SELECT: &str =
    "SELECT id, project_id, title, description, status, priority, \
     base_branch, archived_at, external_id, is_imported, import_source, skills, \
     model_override, mcp_allowlist, skills_override, labels, \
     external_url, external_updated_at, created_at, updated_at, \
     auto_approve, isolated_worktree, agent_id, permission_mode_override, \
     execution_start_sha, phase, phase_status, ball, completion FROM tasks";

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct Task {
    pub id: i32,
    pub project_id: i32,
    pub title: String,
    #[specta(optional)]
    pub description: Option<String>,
    pub status: TaskStatus,
    pub priority: TaskPriority,
    pub base_branch: String,
    #[specta(optional)]
    pub archived_at: Option<String>,
    #[specta(optional)]
    pub external_id: Option<String>,
    #[specta(optional)]
    pub is_imported: Option<bool>,
    #[specta(optional)]
    pub import_source: Option<String>,
    pub skills: Vec<String>,
    #[specta(optional)]
    pub model_override: Option<String>,
    #[specta(optional)]
    pub mcp_allowlist: Option<Vec<String>>,
    #[specta(optional)]
    pub skills_override: Option<Vec<String>>,
    pub labels: Vec<String>,
    #[specta(optional)]
    pub external_url: Option<String>,
    #[specta(optional)]
    pub external_updated_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub auto_approve: bool,
    pub isolated_worktree: bool,
    #[specta(optional)]
    pub agent_id: Option<String>,
    #[specta(optional)]
    pub permission_mode_override: Option<String>,
    #[specta(optional)]
    pub execution_start_sha: Option<String>,
    /// Pipeline activity, orthogonal to `status`. `status` is the board column; these three are
    /// what is happening inside it. `None` means no pipeline activity, in which case
    /// `phase_status` is `None` and `ball` is `TaskBall::None`. Written only via
    /// `task::transition`, never by ad-hoc SQL.
    #[specta(optional)]
    pub phase: Option<TaskPhase>,
    #[specta(optional)]
    pub phase_status: Option<PhaseStatus>,
    pub ball: TaskBall,
    /// How a Done task got there. `None` on every task that is not Done, and on Done tasks in a
    /// non-git project, where none of the variants mean anything.
    #[specta(optional)]
    pub completion: Option<TaskCompletion>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct TaskRelationship {
    pub id: i32,
    pub from_task_id: i32,
    pub to_task_id: i32,
    pub relationship_type: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct TaskInstruction {
    pub id: i32,
    pub task_id: i32,
    pub content: String,
    pub source: String,
    pub created_at: String,
}

/// One entry in a task's outcome thread.
///
/// `kind` is what a gate points at — `proposal`, `plan`, `verdict`, `outcome`, `note`. Kept as a
/// string rather than an enum because the pipeline adds kinds as roles land, and an unknown one
/// arriving from an older or newer build should render as itself, not fail to deserialise the
/// whole thread.
///
/// `body` and `external_ref` are the inline-or-reference pair: exactly one carries the content.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct TaskComment {
    pub id: i32,
    pub task_id: i32,
    pub kind: String,
    pub author: String,
    #[specta(optional)]
    pub body: Option<String>,
    #[specta(optional)]
    pub external_ref: Option<String>,
    /// The phase that produced it, so a thread can be read back against the pipeline.
    #[specta(optional)]
    pub phase: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct TaskAttachment {
    pub id: i32,
    pub task_id: i32,
    pub filename: String,
    pub file_path: String,
    pub file_size: i64,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
#[serde(rename_all = "PascalCase")]
pub enum TaskPriority {
    Urgent,
    High,
    Medium,
    Low,
    None,
}

impl FromStr for TaskPriority {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "Urgent" => Ok(TaskPriority::Urgent),
            "High" => Ok(TaskPriority::High),
            "Medium" => Ok(TaskPriority::Medium),
            "Low" => Ok(TaskPriority::Low),
            "None" => Ok(TaskPriority::None),
            _ => Ok(TaskPriority::Medium),
        }
    }
}

impl FromStr for TaskStatus {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "Planning" => Ok(TaskStatus::Planning),
            "Queue" => Ok(TaskStatus::Queue),
            "InProgress" => Ok(TaskStatus::InProgress),
            "Review" => Ok(TaskStatus::Review),
            "Done" => Ok(TaskStatus::Done),
            "Cancelled" => Ok(TaskStatus::Cancelled),
            _ => Ok(TaskStatus::Planning),
        }
    }
}

impl Task {
    pub fn from_row(row: &rusqlite::Row) -> rusqlite::Result<Self> {
        Ok(Task {
            id: row.get(0)?,
            project_id: row.get(1)?,
            title: row.get(2)?,
            description: row.get(3)?,
            status: row.get::<_, String>(4)?.parse().unwrap_or(TaskStatus::Planning),
            priority: row.get::<_, String>(5)?.parse().unwrap_or(TaskPriority::Medium),
            base_branch: row.get::<_, String>(6)?,
            archived_at: row.get(7)?,
            external_id: row.get(8)?,
            is_imported: row.get(9)?,
            import_source: row.get(10)?,
            skills: serde_json::from_str(&row.get::<_, String>(11)?).unwrap_or_default(),
            model_override: row.get(12)?,
            mcp_allowlist: row.get::<_, Option<String>>(13)?.and_then(|s| serde_json::from_str(&s).ok()),
            skills_override: row.get::<_, Option<String>>(14)?.and_then(|s| serde_json::from_str(&s).ok()),
            labels: serde_json::from_str(&row.get::<_, String>(15).unwrap_or_else(|_| "[]".to_string())).unwrap_or_default(),
            external_url: row.get(16)?,
            external_updated_at: row.get(17)?,
            created_at: row.get(18)?,
            updated_at: row.get(19)?,
            auto_approve: row.get::<_, bool>(20).unwrap_or(false),
            isolated_worktree: row.get::<_, bool>(21).unwrap_or(true),
            agent_id: row.get(22)?,
            permission_mode_override: row.get(23)?,
            execution_start_sha: row.get(24)?,
            phase: row.get::<_, Option<String>>(25)?.and_then(|s| s.parse().ok()),
            phase_status: row.get::<_, Option<String>>(26)?.and_then(|s| s.parse().ok()),
            ball: row
                .get::<_, String>(27)
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(TaskBall::None),
            completion: row.get::<_, Option<String>>(28)?.and_then(|s| s.parse().ok()),
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct CreateTaskRequest {
    pub project_id: i32,
    pub title: String,
    #[specta(optional)]
    pub description: Option<String>,
    pub skills: Vec<String>,
}

// Copy/PartialEq so the transition table can compare and pass statuses by value.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[specta(export)]
#[serde(rename_all = "PascalCase")]
pub enum TaskStatus {
    Planning,
    Queue,
    InProgress,
    Review,
    Done,
    Cancelled,
}

/// What the pipeline is doing to a task right now, independent of which column it sits in.
///
/// `Refining`, `Drafting`, `PlanReview`, `SelfReview` and `AwaitingMerge` are defined but inert:
/// no transition produces them until the refiner, planner, reviewer and PR roles land. They exist
/// now so adding those roles does not need a second migration.
///
/// A phase says nothing about which column the task is in. `Spawning` sits in Queue, which is what
/// lets a failed spawn be an ordinary active row rather than an exception to the phase invariant.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[specta(export)]
#[serde(rename_all = "PascalCase")]
pub enum TaskPhase {
    Spawning,
    Refining,
    Drafting,
    PlanReview,
    Implementing,
    Rework,
    SelfReview,
    Approval,
    AwaitingMerge,
}

/// How the current phase is going.
///
/// `Blocked` and `Waiting` both mean the user has to act, and are deliberately distinct: `Blocked`
/// is an agent stopped mid-phase that cannot continue without an answer, and drives the animated
/// card treatment. `Waiting` is a gate with nothing running, and is static. Collapsing the two
/// would make every waiting card pulse and turn the animation into wallpaper.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[specta(export)]
#[serde(rename_all = "PascalCase")]
pub enum PhaseStatus {
    Running,
    Blocked,
    Waiting,
    Failed,
}

/// Who the pipeline is blocked on — not who owns the ticket.
///
/// A Planning backlog and a queued task are `None`, because nothing is waiting on anyone. That is
/// what keeps the "Needs me" filter showing genuine gates rather than the whole board.
///
/// `External` is a task waiting on something outside Maestro — a PR waiting on CI and a human
/// reviewer on GitHub. Folding that into `User` would list tasks in "Needs me" that our user
/// cannot act on, which is the one thing that filter has to get right.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[specta(export)]
#[serde(rename_all = "PascalCase")]
pub enum TaskBall {
    Agent,
    User,
    External,
    None,
}

/// How a task reached `Done`, and therefore what is left over.
///
/// Only meaningful on a Done task, and only in a git project — a non-git task has no merge, no
/// worktree and no PR, so its completion is `None` rather than a variant meaning "not applicable".
///
/// `LocalOnly` is the one that carries unfinished business: the changes were committed and
/// approved but never merged, and the worktree is still alive holding them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[specta(export)]
#[serde(rename_all = "PascalCase")]
pub enum TaskCompletion {
    Merged,
    MergedViaPR,
    LocalOnly,
    NoChanges,
}

// Unlike TaskStatus and TaskPriority above, these three reject unknown input rather than falling
// back to a default. `from_row` reads phase and phase_status into an Option and discards the
// error, so a stray value becomes "no phase" instead of silently claiming to be a real one; a
// fallback variant would invent activity that never happened.
impl FromStr for TaskPhase {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "Spawning" => Ok(TaskPhase::Spawning),
            "Refining" => Ok(TaskPhase::Refining),
            "Drafting" => Ok(TaskPhase::Drafting),
            "PlanReview" => Ok(TaskPhase::PlanReview),
            "Implementing" => Ok(TaskPhase::Implementing),
            "Rework" => Ok(TaskPhase::Rework),
            "SelfReview" => Ok(TaskPhase::SelfReview),
            "Approval" => Ok(TaskPhase::Approval),
            "AwaitingMerge" => Ok(TaskPhase::AwaitingMerge),
            other => Err(format!("Unknown task phase: {}", other)),
        }
    }
}

impl FromStr for PhaseStatus {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "Running" => Ok(PhaseStatus::Running),
            "Blocked" => Ok(PhaseStatus::Blocked),
            "Waiting" => Ok(PhaseStatus::Waiting),
            "Failed" => Ok(PhaseStatus::Failed),
            other => Err(format!("Unknown phase status: {}", other)),
        }
    }
}

impl FromStr for TaskBall {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "Agent" => Ok(TaskBall::Agent),
            "User" => Ok(TaskBall::User),
            "External" => Ok(TaskBall::External),
            "None" => Ok(TaskBall::None),
            other => Err(format!("Unknown task ball: {}", other)),
        }
    }
}

impl FromStr for TaskCompletion {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "Merged" => Ok(TaskCompletion::Merged),
            "MergedViaPR" => Ok(TaskCompletion::MergedViaPR),
            "LocalOnly" => Ok(TaskCompletion::LocalOnly),
            "NoChanges" => Ok(TaskCompletion::NoChanges),
            other => Err(format!("Unknown task completion: {}", other)),
        }
    }
}

impl TaskPhase {
    pub fn as_str(self) -> &'static str {
        match self {
            TaskPhase::Spawning => "Spawning",
            TaskPhase::Refining => "Refining",
            TaskPhase::Drafting => "Drafting",
            TaskPhase::PlanReview => "PlanReview",
            TaskPhase::Implementing => "Implementing",
            TaskPhase::Rework => "Rework",
            TaskPhase::SelfReview => "SelfReview",
            TaskPhase::Approval => "Approval",
            TaskPhase::AwaitingMerge => "AwaitingMerge",
        }
    }
}

impl PhaseStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            PhaseStatus::Running => "Running",
            PhaseStatus::Blocked => "Blocked",
            PhaseStatus::Waiting => "Waiting",
            PhaseStatus::Failed => "Failed",
        }
    }
}

impl TaskBall {
    pub fn as_str(self) -> &'static str {
        match self {
            TaskBall::Agent => "Agent",
            TaskBall::User => "User",
            TaskBall::External => "External",
            TaskBall::None => "None",
        }
    }
}

impl TaskCompletion {
    pub fn as_str(self) -> &'static str {
        match self {
            TaskCompletion::Merged => "Merged",
            TaskCompletion::MergedViaPR => "MergedViaPR",
            TaskCompletion::LocalOnly => "LocalOnly",
            TaskCompletion::NoChanges => "NoChanges",
        }
    }
}

impl TaskStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            TaskStatus::Planning => "Planning",
            TaskStatus::Queue => "Queue",
            TaskStatus::InProgress => "InProgress",
            TaskStatus::Review => "Review",
            TaskStatus::Done => "Done",
            TaskStatus::Cancelled => "Cancelled",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct ProjectConfigResponse {
    pub default_agent: Option<String>,
    pub startup_tab: Option<String>,
    pub default_existing_worktree: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct ProjectConfigRequest {
    pub default_agent: Option<String>,
    pub startup_tab: Option<String>,
    pub default_existing_worktree: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct TaskConfigRequest {
    #[specta(optional)]
    pub model_override: Option<String>,
    #[specta(optional)]
    pub mcp_allowlist: Option<Vec<String>>,
    #[specta(optional)]
    pub skills_override: Option<Vec<String>>,
    #[specta(optional)]
    pub permission_mode_override: Option<String>,
}
