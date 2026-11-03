use maestro_protocol as wire;
use serde::{Deserialize, Serialize};
use specta::Type;

pub use maestro_protocol::{
    BranchMode, LoopConfig, PhaseStatus, PullRequestCi, RunMode, TaskAttachment, TaskBall,
    TaskComment, TaskCompletion, TaskPhase, TaskPriority, TaskStatus, WorkspaceMode,
};

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
    /// Where this task's agent works.
    pub workspace_mode: WorkspaceMode,
    /// The workspace a `ReuseWorkspace` task was pinned to, and `None` in every other mode. Also
    /// `None` once that worktree is gone — the column drops the reference with it — which is how
    /// the executor tells "pinned to a workspace that no longer exists" from "never pinned".
    #[specta(optional)]
    pub workspace_worktree_id: Option<i32>,
    /// For `NewWorktree`, whether the worktree gets a branch of its own or checks out one that
    /// already exists. Meaningless in the other two modes, which create no branch either way.
    pub workspace_branch_mode: BranchMode,
    /// The branch name the user chose, for `BranchMode::Create` only. `None` means the name is
    /// generated from the task when the worktree is created, which is what a task that never
    /// touched the field means.
    #[specta(optional)]
    pub workspace_branch: Option<String>,
    #[specta(optional)]
    pub agent_id: Option<String>,
    #[specta(optional)]
    pub permission_mode_override: Option<String>,
    #[specta(optional)]
    pub execution_start_sha: Option<String>,
    /// Pipeline activity, orthogonal to `status`. `status` is the board column; these three are
    /// what is happening inside it. `None` means no pipeline activity, in which case
    /// `phase_status` is `None` and `ball` is `TaskBall::None`. Written only by the daemon's
    /// transition table (`maestro-server/src/task_store/transition.rs`).
    #[specta(optional)]
    pub phase: Option<TaskPhase>,
    #[specta(optional)]
    pub phase_status: Option<PhaseStatus>,
    pub ball: TaskBall,
    /// How a Done task got there. `None` on every task that is not Done, and on Done tasks in a
    /// non-git project, where none of the variants mean anything.
    #[specta(optional)]
    pub completion: Option<TaskCompletion>,
    /// When the user pressed Execute on a task the host had no free slot for. The scheduler takes
    /// these before its own picks, which is what makes the deferral a promise rather than a hope.
    #[specta(optional)]
    pub execute_requested_at: Option<String>,
    /// The pull request this task's branch was opened as. Set together with the `AwaitingMerge`
    /// phase and never cleared — a landed task keeps the link to how it landed.
    #[specta(optional)]
    pub pull_request_url: Option<String>,
    #[specta(optional)]
    pub pull_request_number: Option<i64>,
    /// How many times the review agent has sent this task back, bounded by `REVIEW_ROUND_CAP`.
    pub review_rounds: i32,
    /// How many times an agent has been sent to fix this task's CI, bounded by `FIX_ROUND_CAP`.
    pub fix_rounds: i32,
    /// What the forge's CI last said about the open pull request. Refreshed by the reconcile
    /// sweep; `None` while there is nothing to say.
    #[specta(optional)]
    pub pull_request_ci: Option<PullRequestCi>,
    /// Which profile this task wants for a given role, as JSON keyed by role name — a profile id,
    /// or null for "skip this stage". Carried as the raw string rather than a parsed map because
    /// the frontend is what reads it: it is written by the card's override dialog and handed
    /// straight back to `resolve_agent_profile`, which already takes an override id and falls back
    /// when it names nothing. `role_is_skipped` parses it on the Rust side, for the one stage the
    /// backend decides on its own.
    #[specta(optional)]
    pub profile_overrides: Option<String>,
    /// The phase the last claim took the task from. Equal to `phase` on a `Failed` task when the
    /// stage that phase hands to failed to start, rather than failing at its work.
    #[specta(optional)]
    pub claimed_from: Option<TaskPhase>,
    /// The stage pipeline, or a loop that iterates until its checks pass. See
    /// `docs/loops-plan.md`.
    pub run_mode: RunMode,
    /// Set on every loop task.
    #[specta(optional)]
    pub loop_config: Option<LoopConfig>,
    /// What the board shows of a loop. Set on every loop task.
    #[specta(optional)]
    pub loop_summary: Option<super::loops::LoopSummary>,
    /// The usage-limit gate holding this task while it waits on its agent.
    #[specta(optional)]
    pub gate: Option<super::loops::AgentGateState>,
    /// The automation run that created this task, if one did.
    #[specta(optional)]
    pub drafted_by: Option<super::loops::TaskDraft>,
}

impl Task {
    /// The daemon's row, filed under the project the request named: it keys tasks by path, and
    /// this app by `projects.id`.
    pub fn from_wire(task: wire::Task, project_id: i32) -> Self {
        Task {
            id: task.id,
            project_id,
            title: task.title,
            description: task.description,
            status: task.status,
            priority: task.priority,
            base_branch: task.base_branch,
            archived_at: task.archived_at,
            external_id: task.external_id,
            is_imported: task.is_imported,
            import_source: task.import_source,
            skills: task.skills,
            model_override: task.model_override,
            mcp_allowlist: task.mcp_allowlist,
            skills_override: task.skills_override,
            labels: task.labels,
            external_url: task.external_url,
            external_updated_at: task.external_updated_at,
            created_at: task.created_at,
            updated_at: task.updated_at,
            auto_approve: task.auto_approve,
            workspace_mode: task.workspace_mode,
            workspace_worktree_id: task.workspace_worktree_id,
            workspace_branch_mode: task.workspace_branch_mode,
            workspace_branch: task.workspace_branch,
            agent_id: task.agent_id,
            permission_mode_override: task.permission_mode_override,
            execution_start_sha: task.execution_start_sha,
            phase: task.phase,
            phase_status: task.phase_status,
            ball: task.ball,
            completion: task.completion,
            execute_requested_at: task.execute_requested_at,
            pull_request_url: task.pull_request_url,
            pull_request_number: task.pull_request_number,
            review_rounds: task.review_rounds,
            fix_rounds: task.fix_rounds,
            pull_request_ci: task.pull_request_ci,
            profile_overrides: task.profile_overrides,
            claimed_from: task.claimed_from,
            run_mode: task.run_mode,
            loop_config: task.loop_config,
            loop_summary: task
                .loop_summary
                .and_then(|summary| super::loops::mirror(*summary).ok()),
            gate: task.gate.and_then(|gate| super::loops::mirror(*gate).ok()),
            drafted_by: task
                .drafted_by
                .and_then(|draft| super::loops::mirror(*draft).ok()),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct ProjectConfigResponse {
    pub default_agent: Option<String>,
    pub startup_tab: Option<String>,
    /// Deliberately absent from `ProjectConfigRequest`: the settings form submits the whole
    /// request, and a colour field there would let a form save clobber a colour picked in the
    /// header moments earlier. Writes go through `set_project_accent_color` instead.
    pub accent_color: Option<String>,
    /// `Some(false)` once the colour has been decided; see `ProjectConfig`.
    pub accent_color_auto_assign: Option<bool>,
    /// Resolved, never `None`: the settings file may predate the key, and the UI needs an answer.
    pub default_workspace_mode: WorkspaceMode,
    /// The configured git remote, or `None` for "auto" — deliberately *not* resolved, because the
    /// picker has to be able to show that no choice has been made.
    pub remote_name: Option<String>,
    /// The configured base branch for new worktrees, or `None` for "auto". Not resolved either,
    /// and for the same reason as `remote_name` above.
    pub base_branch: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct ProjectConfigRequest {
    pub default_agent: Option<String>,
    pub startup_tab: Option<String>,
    /// Only `NewWorktree` and `RepositoryDirectory` are offered in Settings — a project default
    /// cannot name a specific workspace — but the field is the full enum so the two places that
    /// read it do not have to translate between two types.
    pub default_workspace_mode: WorkspaceMode,
    /// `None` selects auto-detection; a name must be one the project actually has, which is why
    /// the form offers a picker rather than a text field.
    pub remote_name: Option<String>,
    /// `None` selects the branch the repository is on. Same reasoning as `remote_name` for why the
    /// form offers a picker: a mistyped branch would only surface when a worktree failed to be
    /// created for it.
    pub base_branch: Option<String>,
}
