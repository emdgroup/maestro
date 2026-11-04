//! The Loop run mode: its configuration, checks and iterations.

use serde::{Deserialize, Serialize};

/// A loop as its card and its detail's meters show it.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct LoopSummary {
    /// The number of the latest iteration, running or ended; 0 before the first.
    pub iteration: i32,
    /// Iterations that count against `max_iterations`.
    pub counted: i32,
    /// The agent time those iterations took, in seconds.
    pub agent_secs: i64,
    /// Iterations in a row with no progress, as the stall limit counts them.
    pub no_change: i32,
    /// The latest iteration's closing words.
    #[serde(default)]
    pub last_summary: Option<String>,
    /// Every check's state in list order, proposals still waiting left out.
    pub checks: Vec<LoopCheckState>,
    /// Proposals waiting for the user's answer.
    pub proposals: i32,
    /// Why the loop last stopped for the user. Read only while it waits on the user.
    #[serde(default)]
    pub halt: Option<LoopHalt>,
    /// A pause or stop the user asked for, which takes effect once the current step ends.
    #[serde(default)]
    pub hold: Option<LoopHalt>,
}

/// Why a loop stopped for the user.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub enum LoopHalt {
    Flaky,
    Failing,
    Stalled,
    OutOfIterations,
    Paused,
    Stopped,
    /// The worker called `loop_blocked`.
    Blocked,
    /// An iteration's commit could not be merged back into the loop's worktree.
    Conflict,
}

/// How a task runs once it is started: the stage pipeline, or a loop of fresh coder sessions that
/// ends when its checks pass. See `docs/loops-plan.md`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub enum RunMode {
    #[default]
    Pipeline,
    Loop,
}

/// A loop's budget and how its checks run, stored as JSON on the task. A field the stored JSON
/// lacks takes its default, so adding one needs no migration.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(default)]
pub struct LoopConfig {
    /// Iterations that count. One a usage limit cut off does not.
    pub max_iterations: u32,
    /// How long one iteration's Build session may run, in seconds. One still running then is
    /// closed, and what it wrote is committed and checked as if it had ended.
    pub max_build_secs: u32,
    /// Iterations in a row that change nothing before the loop stops as stalled.
    pub stall_limit: u32,
    /// The time limit of a step or check without its own. A row still running past its limit is
    /// killed and fails.
    pub check_timeout_secs: u32,
    /// What the worker's worktree leaves out, as ordered patterns: anchored at the repository root
    /// unless they start with a `**` segment, `*` within one folder, a `**` segment any number of
    /// folders, a trailing slash a folder and everything under it. `!pattern` makes matching files
    /// visible again, and a later entry wins over an earlier one. (No literal star-slash here: this
    /// comment is copied into a TypeScript block comment, which that would close.)
    pub sealed_paths: Vec<String>,
}

impl Default for LoopConfig {
    fn default() -> Self {
        LoopConfig {
            max_iterations: 10,
            max_build_secs: 2 * 60 * 60,
            stall_limit: 3,
            check_timeout_secs: 10 * 60,
            sealed_paths: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub enum LoopCheckKind {
    /// A shell command; exit 0 passes.
    Command,
    /// A sentence a separate agent judges against the diff.
    Judge,
    /// The user ticks it.
    Manual,
    /// A shell command run before the checks, in list order. Not a check: a failing one stops the
    /// steps after it, and no check runs.
    Setup,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub enum LoopCheckState {
    Pending,
    Pass,
    Fail,
    /// Failed, then passed on the same commit, or the reverse.
    Flaky,
}

/// One item of a loop's done criteria.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct LoopCheck {
    pub id: i32,
    pub position: i32,
    pub kind: LoopCheckKind,
    pub label: String,
    /// What a `Command` check or a `Setup` step runs. `None` for the other kinds.
    #[serde(default)]
    pub command: Option<String>,
    /// Its own time limit, in seconds. `None` takes the loop's `check_timeout_secs`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_secs: Option<u32>,
    pub state: LoopCheckState,
    /// The last output tail, or the judge's reason.
    #[serde(default)]
    pub detail: Option<String>,
    /// Proposed by the worker rather than written by the user.
    pub proposed: bool,
    /// A proposal the user accepted. A proposal not accepted is waiting for an answer.
    pub accepted: bool,
    /// The commit a `Judge` check last passed on.
    #[serde(default)]
    pub passed_at_sha: Option<String>,
    pub updated_at: String,
}

/// What the user writes of a check. The rest is the loop's.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct LoopCheckSpec {
    pub kind: LoopCheckKind,
    pub label: String,
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_secs: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub enum LoopIterationOutcome {
    Running,
    /// Ended and its checks ran.
    Checked,
    /// Cut off by a usage limit or the user; it runs again without counting.
    Interrupted,
    /// Ended with nothing to commit.
    Empty,
    /// The agent failed.
    Failed,
    /// The worker called `loop_blocked`: committed, and its checks did not run.
    Blocked,
}

/// One attempt at one iteration. An interrupted iteration runs again as the next `attempt` of the
/// same `n`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct LoopIteration {
    pub n: i32,
    pub attempt: i32,
    #[serde(default)]
    pub acp_session_id: Option<String>,
    #[serde(default)]
    pub agent_id: Option<String>,
    pub started_at: String,
    #[serde(default)]
    pub ended_at: Option<String>,
    pub outcome: LoopIterationOutcome,
    /// Whether it counts against `max_iterations`.
    pub counted: bool,
    #[serde(default)]
    pub commit_sha: Option<String>,
    pub files: i32,
    pub added: i32,
    pub removed: i32,
    /// The agent's final message.
    #[serde(default)]
    pub summary: Option<String>,
    /// The tail of the checks' output.
    #[serde(default)]
    pub check_output: Option<String>,
    /// Tokens its session's turns used, from the usage record, while that still has them.
    #[serde(default)]
    pub tokens: Option<i64>,
    /// Why the worker said it cannot go on, through `loop_blocked`.
    #[serde(default)]
    pub blocked: Option<String>,
    /// What each check concluded after this iteration, passing ones included. Filled for the
    /// newest attempt of its number, and only in `ListLoopIterations`: the engine never reads it.
    pub results: Vec<LoopCheckResult>,
}

/// One check's result after one iteration, as it was run.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct LoopCheckResult {
    pub check_id: i32,
    pub state: LoopCheckState,
    /// The output tail, or the judge's reason.
    #[serde(default)]
    pub detail: Option<String>,
    /// What a `Command` check ran.
    #[serde(default)]
    pub command: Option<String>,
}

/// One check of the user's list. `id` names a check it keeps, which goes back to `Pending` when
/// its spec changed; no `id` adds one. A check the list leaves out is deleted.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct LoopCheckEntry {
    #[serde(default)]
    pub id: Option<i32>,
    #[serde(flatten)]
    pub spec: LoopCheckSpec,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct SetLoopChecksRequest {
    pub project_path: String,
    pub task_id: i32,
    pub checks: Vec<LoopCheckEntry>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct AnswerLoopProposalRequest {
    pub project_path: String,
    pub task_id: i32,
    pub check_id: i32,
    /// The check as the user accepts it, kind included. `None` rejects the proposal and deletes it.
    #[serde(default)]
    pub accept: Option<LoopCheckSpec>,
    /// The paths accepting it seals, each on the base branch. Ignored on a rejection.
    #[serde(default)]
    pub seal: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct TickLoopCheckRequest {
    pub project_path: String,
    pub task_id: i32,
    pub check_id: i32,
    pub ticked: bool,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct LoopCheckList {
    pub checks: Vec<LoopCheck>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct LoopIterationList {
    pub iterations: Vec<LoopIteration>,
}

/// `None` when the worker has written no notes yet.
#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct LoopNotes {
    #[serde(default)]
    pub content: Option<String>,
}
