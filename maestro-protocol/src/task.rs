//! Tasks, their threads, worktrees and reviews.
//!
//! Rows of the daemon's `projects.db`, keyed by project path where the app's tables carried a
//! `projects.id`. Task ids are per project, so every request naming one names the project too.
//! The ones the app hands its frontend derive `specta::Type` behind the `specta` feature, which
//! only the app turns on, so the binary deployed to every remote host does not compile specta in.

use serde::{Deserialize, Serialize};

use crate::*;

/// Deserializes a present `null` as `Some(None)`, so an update can tell "clear this column" from
/// "leave it alone". Paired with `default`, which gives the absent field its `None`.
fn clearable<'de, T, D>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    T: Deserialize<'de>,
    D: serde::Deserializer<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub enum TaskStatus {
    Planning,
    Queue,
    InProgress,
    Review,
    Done,
    Cancelled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub enum TaskPriority {
    Urgent,
    High,
    Medium,
    Low,
    None,
}

/// Where an agent works: a worktree of its own, the project directory, or a worktree that already
/// exists. Shared by tasks and by the project default that seeds them.
///
/// This replaced a boolean, which could only say the first two. `ReuseWorkspace` is the one that
/// needs a companion, the worktree it names, which is why a task carries
/// `workspace_worktree_id` beside the mode rather than encoding everything here.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub enum WorkspaceMode {
    NewWorktree,
    RepositoryDirectory,
    ReuseWorkspace,
}

/// Which branch a `NewWorktree` workspace ends up on: one created for it, or one that already
/// exists.
///
/// Only `Create` needs a companion, the name to give the branch, which is why the task carries
/// `workspace_branch` beside this rather than encoding the name here. `Checkout` needs nothing: the
/// branch it checks out is the task's `base_branch`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub enum BranchMode {
    Create,
    Checkout,
}

/// What the pipeline is doing to a task right now, independent of which column it sits in.
///
/// A phase says nothing about which column the task is in. `Spawning` sits in Queue, which is what
/// lets a failed spawn be an ordinary active row rather than an exception to the phase invariant.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
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
    /// A loop's coder, one fresh session per iteration.
    Iterating,
    /// A loop's checks running, with no session live.
    Checking,
    /// A loop's judge deciding its `judge` checks, once every command check passes.
    Judging,
}

/// How the current phase is going.
///
/// `Blocked` and `Waiting` both mean the user has to act, and are deliberately distinct: `Blocked`
/// is an agent stopped mid-phase that cannot continue without an answer, and drives the animated
/// card treatment. `Waiting` is a gate with nothing running, and is static. Collapsing the two
/// would make every waiting card pulse and turn the animation into wallpaper.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub enum PhaseStatus {
    Running,
    Blocked,
    Waiting,
    Failed,
}

/// Who the pipeline is blocked on, not who owns the ticket.
///
/// A Planning backlog and a queued task are `None`, because nothing is waiting on anyone. That is
/// what keeps the "Needs me" filter showing genuine gates rather than the whole board.
///
/// `External` is a task waiting on something outside Maestro: a PR waiting on CI and a human
/// reviewer on GitHub. Folding that into `User` would list tasks in "Needs me" that our user
/// cannot act on, which is the one thing that filter has to get right.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub enum TaskBall {
    Agent,
    User,
    External,
    None,
}

/// How a task reached `Done`, and therefore what is left over.
///
/// Only meaningful on a Done task, and only in a git project. A non-git task has no merge, no
/// worktree and no PR, so its completion is `None` rather than a variant meaning "not applicable".
///
/// `LocalOnly` is the one that carries unfinished business: the changes were committed and
/// approved but never merged, and the worktree is still alive holding them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub enum TaskCompletion {
    Merged,
    MergedViaPR,
    LocalOnly,
    NoChanges,
}

/// What the forge's CI last said about an open pull request's head commit.
///
/// A display cache rather than a lifecycle field: the sweep runs every three minutes, and this is
/// what lets the card answer "can this land" in between. Nothing branches on it: `CiState` is what
/// the fix loop reads, freshly, from the forge.
///
/// `None` covers all three ways there is nothing to say: no CI configured, a forge that will not
/// answer, and a pull request not swept yet. They are one silence on the card, so a fourth variant
/// distinguishing them would render identically to its own absence.
///
/// Conflicts are deliberately not in here. `AwaitingMerge` with `Waiting` and the ball on the user
/// is a conflict and nothing else, so storing it would be a second copy of a fact the lifecycle
/// fields already carry, and one a sweep that learned nothing could overwrite.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub enum PullRequestCi {
    Passing,
    Failing,
    Pending,
}

/// The pipeline role a session was started for, and the role a profile is written for.
///
/// Selecting by role is what lets a task say "plan with the planner" without naming a profile, and
/// what makes a project's default reviewer a project-level fact.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub enum AgentRole {
    Refiner,
    Planner,
    Coder,
    Reviewer,
    /// Decides a loop's `judge` checks and writes its review digest. Read-only.
    Judge,
    /// Prepares a loop with the user before it runs: writes its tests in the loop's worktree and
    /// sets its checks. Works a loop's `Refining` phase, which is the refiner's on a pipeline task.
    Preparer,
    /// Works a loop's iterations, each in a fresh session, as the coder works a pipeline task.
    Worker,
}

impl AgentRole {
    /// Whether the role is allowed to modify the repository.
    ///
    /// Only the coder and a loop's worker write, and a loop's preparer, which commits the loop's
    /// tests. This is the single place that says so: a profile claiming otherwise is corrected
    /// rather than trusted, because the read-only guarantee is what the plan and proposal gates are
    /// built on.
    pub fn is_read_only(self) -> bool {
        !matches!(
            self,
            AgentRole::Coder | AgentRole::Worker | AgentRole::Preparer
        )
    }
}

/// One task, every column the app reads.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Task {
    pub id: i32,
    pub project_path: String,
    pub title: String,
    #[serde(default)]
    pub description: Option<String>,
    pub status: TaskStatus,
    pub priority: TaskPriority,
    pub base_branch: String,
    #[serde(default)]
    pub archived_at: Option<String>,
    #[serde(default)]
    pub external_id: Option<String>,
    #[serde(default)]
    pub is_imported: Option<bool>,
    #[serde(default)]
    pub import_source: Option<String>,
    #[serde(default)]
    pub skills: Vec<String>,
    #[serde(default)]
    pub model_override: Option<String>,
    #[serde(default)]
    pub mcp_allowlist: Option<Vec<String>>,
    #[serde(default)]
    pub skills_override: Option<Vec<String>>,
    #[serde(default)]
    pub labels: Vec<String>,
    #[serde(default)]
    pub external_url: Option<String>,
    #[serde(default)]
    pub external_updated_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub auto_approve: bool,
    pub workspace_mode: WorkspaceMode,
    #[serde(default)]
    pub workspace_worktree_id: Option<i32>,
    pub workspace_branch_mode: BranchMode,
    #[serde(default)]
    pub workspace_branch: Option<String>,
    #[serde(default)]
    pub agent_id: Option<String>,
    #[serde(default)]
    pub permission_mode_override: Option<String>,
    #[serde(default)]
    pub execution_start_sha: Option<String>,
    #[serde(default)]
    pub phase: Option<TaskPhase>,
    #[serde(default)]
    pub phase_status: Option<PhaseStatus>,
    pub ball: TaskBall,
    #[serde(default)]
    pub completion: Option<TaskCompletion>,
    #[serde(default)]
    pub execute_requested_at: Option<String>,
    #[serde(default)]
    pub pull_request_url: Option<String>,
    #[serde(default)]
    pub pull_request_number: Option<i64>,
    pub review_rounds: i32,
    pub fix_rounds: i32,
    #[serde(default)]
    pub pull_request_ci: Option<PullRequestCi>,
    /// JSON keyed by role name, stored and returned as the app wrote it.
    #[serde(default)]
    pub profile_overrides: Option<String>,
    /// The phase the last claim took the task from. Equal to `phase` on a `Failed` task when the
    /// failure is a start that did not come up, which a retry of that phase's stage answers.
    #[serde(default)]
    pub claimed_from: Option<TaskPhase>,
    #[serde(default)]
    pub run_mode: RunMode,
    /// Set on every loop task.
    #[serde(default)]
    pub loop_config: Option<LoopConfig>,
    /// What the board shows of a loop, read with it. Set on every loop task the daemon lists.
    /// Boxed, like `gate`: a `Task` rides in many of the daemon's futures, on a stack at its limit.
    #[serde(default)]
    pub loop_summary: Option<Box<LoopSummary>>,
    /// The usage-limit gate of the agent that last refused this task, while it holds the task
    /// waiting.
    #[serde(default)]
    pub gate: Option<Box<AgentGateState>>,
    /// The automation run that created this task through `create_task`, if one did.
    #[serde(default)]
    pub drafted_by: Option<Box<TaskDraft>>,
}

/// The automation run a task came from.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct TaskDraft {
    pub automation: String,
    /// The run's number among its automation's runs, `None` for a run recorded before runs were
    /// numbered.
    #[serde(default)]
    pub run: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TaskRelationship {
    pub id: i32,
    pub from_task_id: i32,
    pub to_task_id: i32,
    pub relationship_type: String,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TaskInstruction {
    pub id: i32,
    pub task_id: i32,
    pub content: String,
    pub source: String,
    pub created_at: String,
}

/// One entry in a task's outcome thread.
///
/// `kind` is what a gate points at: `proposal`, `plan`, `verdict`, `outcome`, `note`. Kept as a
/// string rather than an enum because the pipeline adds kinds as roles land, and an unknown one
/// arriving from an older or newer build should render as itself, not fail to deserialise the
/// whole thread.
///
/// `body` and `external_ref` are the inline-or-reference pair: exactly one carries the content.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct TaskComment {
    pub id: i32,
    pub task_id: i32,
    pub kind: String,
    pub author: String,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub external_ref: Option<String>,
    #[serde(default)]
    pub phase: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct TaskAttachment {
    pub id: i32,
    pub task_id: i32,
    pub filename: String,
    pub file_path: String,
    pub file_size: i64,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Worktree {
    pub id: i32,
    pub project_path: String,
    /// `None` for a worktree no task owns: a session's, or one an automation kept.
    #[serde(default)]
    pub task_id: Option<i32>,
    pub branch_name: String,
    #[serde(default)]
    pub base_branch: Option<String>,
    /// Relative to the project root. Empty while a session's worktree is reserved but not made.
    pub path: String,
    #[serde(default)]
    pub git_status: Option<String>,
    pub created_at: String,
}

/// A task's review, with the per-file comments hanging off it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TaskReview {
    pub id: i32,
    pub task_id: i32,
    /// `Approve` or `RequestChanges`, as the app wrote it.
    pub decision: String,
    #[serde(default)]
    pub general_feedback: Option<String>,
    #[serde(default)]
    pub reviewed_at: Option<String>,
    pub created_at: String,
    #[serde(default)]
    pub comments: Vec<ReviewComment>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReviewComment {
    pub id: i32,
    pub review_id: i32,
    pub file_path: String,
    pub comment: String,
    pub created_at: String,
}

/// A project, for the requests and pushes that need nothing else.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProjectRef {
    pub project_path: String,
}

/// One task of one project.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TaskRef {
    pub project_path: String,
    pub task_id: i32,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct RestartTaskRequest {
    pub project_path: String,
    pub task_id: i32,
    /// Planning or Queue.
    pub status: TaskStatus,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct CreateTaskRequest {
    pub project_path: String,
    pub title: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub skills: Vec<String>,
    #[serde(default)]
    pub labels: Vec<String>,
    pub base_branch: String,
    #[serde(default)]
    pub agent_id: Option<String>,
    /// `None` is `Medium`, the column default.
    #[serde(default)]
    pub priority: Option<TaskPriority>,
    #[serde(default)]
    pub auto_approve: bool,
    pub workspace_mode: WorkspaceMode,
    #[serde(default)]
    pub workspace_worktree_id: Option<i32>,
    pub workspace_branch_mode: BranchMode,
    #[serde(default)]
    pub workspace_branch: Option<String>,
    #[serde(default)]
    pub model_override: Option<String>,
    #[serde(default)]
    pub run_mode: RunMode,
    /// A loop created without one gets `LoopConfig::default()`.
    #[serde(default)]
    pub loop_config: Option<LoopConfig>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct UpdateTaskRequest {
    pub project_path: String,
    pub task_id: i32,
    pub update: TaskUpdate,
}

/// The columns an update writes. An absent field is left alone; for the `Option<Option<_>>` ones a
/// `null` clears the column.
///
/// One struct for the user's edits, the task settings form, issue sync and the pipeline's own
/// columns. The pipeline's (`execution_start_sha*`, the pull request fields, `increment_fix_rounds`)
/// leave `updated_at` alone, because a poll or a spawn is not an edit to the task; any other field
/// bumps it.
#[derive(Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct TaskUpdate {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(
        default,
        deserialize_with = "clearable",
        skip_serializing_if = "Option::is_none"
    )]
    pub description: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub priority: Option<TaskPriority>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_branch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skills: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub labels: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_approve: Option<bool>,
    /// Writes `workspace_worktree_id` with it, so leaving `ReuseWorkspace` drops the pin.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_mode: Option<WorkspaceMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_worktree_id: Option<i32>,
    /// Writes `workspace_branch` with it, so `Checkout` drops the name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_branch_mode: Option<BranchMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_branch: Option<String>,
    /// A manual move: goes through the `ManualMove` transition, and un-archives the task unless
    /// the move is to `Cancelled`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<TaskStatus>,
    #[serde(
        default,
        deserialize_with = "clearable",
        skip_serializing_if = "Option::is_none"
    )]
    pub model_override: Option<Option<String>>,
    #[serde(
        default,
        deserialize_with = "clearable",
        skip_serializing_if = "Option::is_none"
    )]
    pub mcp_allowlist: Option<Option<Vec<String>>>,
    #[serde(
        default,
        deserialize_with = "clearable",
        skip_serializing_if = "Option::is_none"
    )]
    pub skills_override: Option<Option<Vec<String>>>,
    #[serde(
        default,
        deserialize_with = "clearable",
        skip_serializing_if = "Option::is_none"
    )]
    pub permission_mode_override: Option<Option<String>>,
    #[serde(
        default,
        deserialize_with = "clearable",
        skip_serializing_if = "Option::is_none"
    )]
    pub profile_overrides: Option<Option<String>>,
    #[serde(
        default,
        deserialize_with = "clearable",
        skip_serializing_if = "Option::is_none"
    )]
    pub external_updated_at: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub loop_config: Option<LoopConfig>,
    #[serde(
        default,
        deserialize_with = "clearable",
        skip_serializing_if = "Option::is_none"
    )]
    pub execution_start_sha: Option<Option<String>>,
    /// Writes `execution_start_sha` only where it is null or empty, so a resumed session keeps the
    /// anchor its first run recorded.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution_start_sha_if_empty: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pull_request_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pull_request_number: Option<i64>,
    #[serde(
        default,
        deserialize_with = "clearable",
        skip_serializing_if = "Option::is_none"
    )]
    pub pull_request_ci: Option<Option<PullRequestCi>>,
    /// Count one more CI fix round.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub increment_fix_rounds: bool,
}

/// Something that happened to a task, mirroring the app's `task::transition::TaskTransition`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TaskTransition {
    ManualMove(TaskStatus),
    ExecutionStarted,
    SessionReady(AgentRole),
    SpawnAborted,
    /// The daemon stopped before a claimed start came up. A hand-off goes back to waiting on its
    /// agent so the drain starts it again; anything else is put back as `SpawnAborted` would.
    SpawnInterrupted,
    AwaitingUserInput,
    Unblocked,
    TurnCompleted {
        is_git_repo: bool,
        has_changes: Option<bool>,
        reviewer_pending: bool,
    },
    ReviewFinished,
    ReviewRejected,
    ArtifactDelivered,
    Stopped,
    RefinementClosed,
    ReworkRequested,
    MergeConflict,
    Merged,
    ApprovedWithoutMerge,
    PullRequestOpened,
    PullRequestMerged,
    PullRequestClosed,
    PullRequestConflicted,
    PullRequestMergeable,
    CiFixRequested,
    CiFixPushed,
    Discarded,
    Cancelled,
    PhaseFailed,
    /// A loop's coder session is up and prompted: the iteration runs.
    LoopIterationStarted,
    /// An iteration was committed, or the user asked for the checks again: they run now.
    LoopChecking,
    /// The checks left work to do and budget to do it: the next iteration waits on the drain.
    LoopIterate,
    /// The loop stopped for the user: it stalled or spent its budget.
    LoopHalted,
    /// Every check passed: the loop goes to sign-off.
    LoopChecksPassed,
    /// Every command check passed and a `judge` check is left: the judge waits on the drain.
    LoopJudging,
    /// The user let a stopped loop, or one at sign-off, go on: the next iteration waits on the
    /// drain. Its stall streak counts from here.
    LoopResumed,
    /// The agent refused the turn for a usage limit: the stage waits on its agent again, in the
    /// same phase, and the drain starts it in a fresh session once the agent's gate opens.
    UsageLimited,
}

/// What must hold, read under the store's lock, for a transition to apply. One per guarded
/// function in the app's `task::transition`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum TransitionGuard {
    /// `apply`: nothing, and a missing task is an error.
    #[default]
    Always,
    /// `apply_if_status`: the task is in one of these columns.
    Status(Vec<TaskStatus>),
    /// `claim_for_execution`: a handoff, or claimable and in one of these columns. The event is
    /// `ExecutionStarted` whatever the request says.
    Claim(Vec<TaskStatus>),
    /// `apply_if_spawning`.
    Spawning,
    /// `apply_if_active`: the task still has a phase.
    Active,
    /// `apply_if_changed`: the transition would change the stored state.
    Changed,
    /// The task is in this phase, as `end_self_review` asks of `SelfReview`.
    Phase(TaskPhase),
    /// `clear_blocked`: the phase status is `Blocked`.
    Blocked,
    /// `fail_if_agent_running`: the phase status is `Running` or `Blocked`.
    AgentRunning,
    /// `request_ci_fix`: the ball is `External` and fewer than this many fix rounds were spent.
    FixRoundsBelow(i32),
    /// The ball is with this party, as the pull-request sweep asks before moving a task the forge
    /// holds: a coder may have claimed it between the sweep's read and its write.
    Ball(TaskBall),
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct ApplyTaskTransitionRequest {
    pub project_path: String,
    pub task_id: i32,
    pub event: TaskTransition,
    #[serde(default)]
    pub guard: TransitionGuard,
    /// Written before the transition, in its transaction, and only if the guard lets it apply.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub update: Option<TaskUpdate>,
    /// Appended after the transition, in its transaction, and only if the guard lets it apply.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comment: Option<NewTaskComment>,
}

/// A task, or `None` where the guard refused or nothing was found.
#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct OptionalTask {
    #[serde(default)]
    pub task: Option<Task>,
}

/// Answer the refiner's proposal gate: on accept, the latest proposal becomes the description and
/// leaves the thread; either way `RefinementClosed` applies.
#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct CloseRefinementRequest {
    pub project_path: String,
    pub task_id: i32,
    pub accept: bool,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct TaskList {
    pub tasks: Vec<Task>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct AddTaskCommentRequest {
    pub project_path: String,
    pub task_id: i32,
    #[serde(flatten)]
    pub comment: NewTaskComment,
}

/// A thread entry to write. A `proposal`, `plan` or `digest` replaces the task's previous one of
/// that kind.
#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct NewTaskComment {
    pub kind: String,
    pub author: String,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub external_ref: Option<String>,
    #[serde(default)]
    pub phase: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct TaskCommentList {
    pub comments: Vec<TaskComment>,
}

/// Returns the existing row when that file is already attached.
#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct AddTaskAttachmentRequest {
    pub project_path: String,
    pub task_id: i32,
    pub filename: String,
    pub file_path: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct DeleteTaskAttachmentRequest {
    pub project_path: String,
    pub attachment_id: i32,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct TaskAttachmentList {
    pub attachments: Vec<TaskAttachment>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct ListWorktreesRequest {
    pub project_path: String,
    /// Only the worktrees this task owns.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<i32>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct WorktreeList {
    pub worktrees: Vec<Worktree>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct WorktreeRef {
    pub project_path: String,
    pub worktree_id: i32,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct OptionalWorktree {
    #[serde(default)]
    pub worktree: Option<Worktree>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct InsertWorktreeRequest {
    pub project_path: String,
    #[serde(default)]
    pub task_id: Option<i32>,
    pub branch_name: String,
    #[serde(default)]
    pub base_branch: Option<String>,
    /// Empty reserves the row's id for a session worktree not made yet.
    pub path: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct UpdateWorktreeRequest {
    pub project_path: String,
    pub worktree_id: i32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct DeleteWorktreesRequest {
    pub project_path: String,
    pub worktree_ids: Vec<i32>,
}

/// Write a task's review.
///
/// With `comments` the review is replaced, and its comments with it. Without, it is updated in
/// place and keeps the comments it has, which is what a merge conflict's feedback needs.
#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct SaveTaskReviewRequest {
    pub project_path: String,
    pub task_id: i32,
    pub decision: String,
    #[serde(default)]
    pub general_feedback: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comments: Option<Vec<ReviewCommentInput>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ReviewCommentInput {
    pub file_path: String,
    pub comment: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct SaveTaskReviewResponse {
    pub review_id: i32,
}
