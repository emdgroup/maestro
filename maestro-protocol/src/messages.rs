//! The two message enums: every request a client sends and every response or push the server sends.

use serde::{Deserialize, Serialize};

use crate::*;

impl ServerRequest {
    /// The host-side session a request is about, if it is about one.
    ///
    /// A daemon serving several windows routes by this and by [`ServerResponse::session_id`]: a
    /// request naming a session makes its sender that session's owner, and a response naming one
    /// goes to the owner.
    pub fn session_id(&self) -> Option<&str> {
        Some(match self {
            Self::Spawn(r) => &r.session_id,
            Self::Prompt(r) => &r.session_id,
            Self::Cancel(r) => &r.session_id,
            Self::InterruptTurn(r) => &r.session_id,
            Self::PermitResponse(r) => &r.session_id,
            Self::ElicitationResponse(r) => &r.session_id,
            Self::SetModel(r) => &r.session_id,
            Self::SetMode(r) => &r.session_id,
            Self::SetConfigOption(r) => &r.session_id,
            Self::SessionLoad(r) => &r.session_id,
            Self::HostToolResult(r) => &r.session_id,
            _ => return None,
        })
    }
}

impl ServerResponse {
    /// The host-side session a response is about, if it is about one. The host routes what it
    /// receives by this, and the daemon by the same answer, so the two sides cannot disagree on
    /// which messages belong to a session.
    pub fn session_id(&self) -> Option<&str> {
        Some(match self {
            Self::SpawnOk(r) => &r.session_id,
            Self::SessionUpdate(r) => &r.session_id,
            Self::PermissionRequest(r) => &r.session_id,
            Self::ElicitationRequest(r) => &r.session_id,
            Self::TerminalOutput(r) => &r.session_id,
            Self::TurnStarted(r) => &r.session_id,
            Self::TurnEnded(r) => &r.session_id,
            Self::HostToolCall(r) => &r.session_id,
            Self::SetModeOk(r) => &r.session_id,
            Self::ConfigOptionUpdated(r) => &r.session_id,
            Self::SessionLoadOk(r) => &r.session_id,
            Self::Error(err) => return err.session_id.as_deref(),
            _ => return None,
        })
    }
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ServerRequest {
    Handshake(HandshakeRequest),
    Spawn(SpawnRequest),
    Prompt(PromptRequest),
    Cancel(CancelRequest),
    InterruptTurn(InterruptTurnRequest),
    PermitResponse(PermissionResponse),
    ElicitationResponse(ElicitationResponse),
    ListAgents(ListAgentsRequest),
    /// Every conversation a project holds, with the live state of the ones running. Asked by a
    /// client opening the project or reconnecting to it.
    ListProjectSessions(ListProjectSessionsRequest),
    /// Change the user's name for a conversation, running or not.
    RenameSession(RenameSessionRequest),
    /// The project is done with a conversation nothing is running. `Cancel` is how a running one
    /// is let go of.
    CloseProjectSession(CloseProjectSessionRequest),
    /// Wind down: end every session and exit.
    ///
    /// Asked for before an update installs, because a resident server holds its own binary open
    /// and Windows will not overwrite the image of a running process. There is no acknowledgement
    /// to wait for: the connection closing is the answer.
    Shutdown,
    /// Every automation stored for one project, with the next time each comes round.
    ListAutomations(ListAutomationsRequest),
    /// Create or replace one automation, by id.
    SaveAutomation(SaveAutomationRequest),
    DeleteAutomation(DeleteAutomationRequest),
    /// Fire one now, whatever its schedule says.
    RunAutomation(RunAutomationRequest),
    /// What this project's automations have done, newest first.
    ListAutomationRuns(ListAutomationRunsRequest),
    /// Forget one run, removing the worktree and branch it made if they are still there.
    DeleteAutomationRun(DeleteAutomationRunRequest),
    /// How much run history this project keeps. Applied straight away, and after every run.
    SetRunRetention(SetRunRetentionRequest),
    /// This machine's webhook listener: how it is set up, and whether it is listening.
    GetWebhookSettings,
    /// Change the listener, which is restarted on the new address straight away.
    SetWebhookSettings(WebhookSettings),
    /// Replace an automation's webhook secret. The old one stops working at once.
    RollWebhookSecret(AutomationIdRequest),
    /// An automation's last deliveries, newest first.
    ListWebhookDeliveries(AutomationIdRequest),
    /// What a conversation's recorded turns used, oldest first.
    SessionUsage(SessionUsageRequest),
    /// Recorded turns after a turn id, oldest first, a page at a time: how the app mirrors usage.
    UsageTurns(UsageTurnsRequest),
    /// Hourly totals after an hour, a page at a time: the history older than the turns.
    UsageHours(UsageHoursRequest),
    /// What this server is: since when, which version, and how busy.
    GetServerStatus,
    /// Start this server with the machine, or stop doing so. Linux only: on the machines the app
    /// runs on, the app writes the login entry itself.
    SetAutostart(SetAutostartRequest),
    /// When an expression would next come round. For a schedule being written, not a stored one.
    PreviewSchedule(PreviewScheduleRequest),
    SetModel(SetModelRequest),
    SetMode(SetModeRequest),
    SetConfigOption(SetConfigOptionRequest),
    FileSearch(FileSearchRequest),
    FileRead(FileReadRequest),
    SessionList(SessionListRequest),
    SessionLoad(SessionLoadRequest),
    SessionClose(SessionCloseRequest),
    SessionDelete(SessionDeleteRequest),
    PreInitialize(PreInitializeRequest),
    Authenticate(AuthenticateRequest),
    Logout(LogoutRequest),
    CheckTools(CheckToolsRequest),
    SetToolPath(SetToolPathRequest),
    InstallSkills(InstallSkillsRequest),
    /// The MCP servers the user manages for this machine, secrets blanked, and the ones a
    /// project's own `.mcp.json` declares.
    ListMcpServers(ProjectScopedRequest),
    /// Replace the whole list. One round trip and no ids: the list is short and has one writer.
    SaveMcpServers(SaveMcpServersRequest),
    /// Replace the secret values held in memory for the managed servers. Never written to disk.
    SetMcpSecrets(SetMcpSecretsRequest),
    /// Connect to a server from this machine and list its tools: a stdio one is started and
    /// stopped, an http or sse one is reached over the network the agents would use.
    TestMcpServer(TestMcpServerRequest),
    /// The skills the user manages for this machine, which agents each is deployed to, and the
    /// ones a project carries in its own agent directories.
    ListSkills(ProjectScopedRequest),
    /// Write a skill into the library if files are given, then install or remove it per agent.
    ApplySkill(ApplySkillRequest),
    /// Remove a skill from every agent, and from the library.
    DeleteSkill(DeleteSkillRequest),
    DetectInstalledAgents(DetectInstalledAgentsRequest),
    SpawnAuthTerminal(SpawnAuthTerminalRequest),
    KillAuthTerminal(KillAuthTerminalRequest),
    AuthTerminalInput(AuthTerminalInputRequest),
    /// Answer to a [`ServerResponse::HostToolCall`] the host resolved.
    HostToolResult(HostToolResult),
    /// Hold a project for this client, releasing whichever one it held before. Refused, not
    /// queued, when another client holds it.
    AcquireProjectLock(AcquireProjectLockRequest),
    /// Let go of whatever project this client holds.
    ReleaseProjectLock,
    /// This server's status and what each of its projects is doing, for Home.
    HomeSummary(HomeSummaryRequest),
    /// Ask the holder of a project to hand it over. Answered with `TakeoverResultOk` once the
    /// holder agrees, refuses or fails to answer in time.
    RequestTakeover(AcquireProjectLockRequest),
    /// The holder's answer to a [`ServerResponse::TakeoverRequested`].
    TakeoverAnswer(TakeoverAnswer),
    /// Every task of the project, newest first, archived ones included.
    ListTasks(ProjectRef),
    GetTask(TaskRef),
    CreateTask(CreateTaskRequest),
    UpdateTask(UpdateTaskRequest),
    ArchiveTask(TaskRef),
    /// Archive and apply `Cancelled`, in that order.
    CancelTask(TaskRef),
    DeleteTask(TaskRef),
    /// One guarded transition, the guard read under the same lock as the write.
    ApplyTaskTransition(ApplyTaskTransitionRequest),
    CloseRefinement(CloseRefinementRequest),
    /// Queued tasks with no phase, deferred first, then by priority and age.
    /// Unarchived tasks at `AwaitingMerge` with a pull request number, for the forge sweep.
    ListTasksAwaitingMerge(ProjectRef),
    /// A task's thread, oldest first.
    ListTaskComments(TaskRef),
    /// A `proposal` or `plan` replaces the task's previous one of that kind.
    AddTaskComment(AddTaskCommentRequest),
    ListTaskAttachments(TaskRef),
    AddTaskAttachment(AddTaskAttachmentRequest),
    DeleteTaskAttachment(DeleteTaskAttachmentRequest),
    ListWorktrees(ListWorktreesRequest),
    GetWorktree(WorktreeRef),
    InsertWorktree(InsertWorktreeRequest),
    UpdateWorktree(UpdateWorktreeRequest),
    DeleteWorktrees(DeleteWorktreesRequest),
    SaveTaskReview(SaveTaskReviewRequest),
    ClearTaskReview(TaskRef),
    /// A loop task's checks in list order, pending proposals included.
    ListLoopChecks(TaskRef),
    /// The user's whole list. Pending proposals are left alone.
    SetLoopChecks(SetLoopChecksRequest),
    AnswerLoopProposal(AnswerLoopProposalRequest),
    /// Tick or untick a `Manual` check.
    TickLoopCheck(TickLoopCheckRequest),
    /// Oldest first.
    ListLoopIterations(TaskRef),
    /// Take the sealed snapshot again and run the checks on the loop's current commit. Not an
    /// iteration. Answered once the checks have started.
    RerunLoopChecks(TaskRef),
    /// Hold the loop for the user once the running iteration and its checks end, or now if
    /// nothing runs.
    PauseLoop(TaskRef),
    /// Halt the loop now: a running session is cut, its work kept as an uncounted WIP commit.
    StopLoop(TaskRef),
    /// Start a task that is not running over from scratch, parked in `status`: its branch back to
    /// where it started, or a new branch from the base once it is Done or Cancelled, and its
    /// progress gone.
    RestartTask(RestartTaskRequest),
    /// The worker's `.maestro/loop/PROGRESS.md`, as it stands in the loop's worktree.
    ReadLoopNotes(TaskRef),
    /// The project's prompt collection, favorites first, then most recently edited.
    ListPrompts(ProjectRef),
    GetPrompt(PromptRef),
    CreatePrompt(CreatePromptRequest),
    /// Bumps `updated_at`; leaves the favorite flag alone.
    UpdatePrompt(UpdatePromptRequest),
    /// Leaves `updated_at`, and so the order within favorites and others, alone.
    SetPromptFavorite(SetPromptFavoriteRequest),
    DeletePrompt(PromptRef),
    /// Opens an import of an app's rows for a project, staged in memory until `CommitImport`.
    /// A frame is capped at `MAX_MESSAGE_SIZE`, so the rows travel in `ImportChunk`s.
    BeginImport(BeginImportRequest),
    ImportChunk(ImportChunkRequest),
    /// Applies everything staged under the id, all or nothing, answered with `ImportProjectOk`.
    CommitImport(ImportRef),
    /// This machine's agent limit and what it resolves to now.
    GetCapacity,
    SetCapacity(CapacitySettings),
    /// Answered with `AutoModeOk`; `enabled` is ignored.
    GetAutoMode(ProjectRef),
    SetAutoMode(AutoModeSetting),
    /// Answered with `LoopWaitCapOk`; `cap` is ignored.
    GetLoopWaitCap(ProjectRef),
    /// Answered with `LoopWaitCapOk`.
    SetLoopWaitCap(LoopWaitCap),
    /// Take or renew a hold.
    HoldTask(HoldTaskRequest),
    /// Drop a hold and let the scheduler look at the task again.
    ReleaseTaskHold(TaskRef),
    /// Open an agent's usage-limit gate now, so the drain starts its waiting tasks ("Try now").
    OpenAgentGate(OpenAgentGateRequest),
    StartTask(StartTaskRequest),
    /// Heartbeat acknowledgment sent by Tauri in response to a `Ping`.
    Pong {
        seq: u64,
    },
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ServerResponse {
    HandshakeOk(HandshakeResponse),
    SpawnOk(SpawnResponse),
    Error(ErrorResponse),
    SessionUpdate(SessionUpdate),
    PermissionRequest(PermissionRequest),
    ElicitationRequest(ElicitationRequest),
    TerminalOutput(TerminalOutput),
    ListAgentsOk(ListAgentsResponse),
    ListProjectSessionsOk(ListProjectSessionsResponse),
    RenameSessionOk,
    CloseProjectSessionOk,
    ListAutomationsOk(ListAutomationsResponse),
    SaveAutomationOk(Automation),
    DeleteAutomationOk,
    ListAutomationRunsOk(ListAutomationRunsResponse),
    DeleteAutomationRunOk,
    SetRunRetentionOk,
    WebhookSettingsOk(WebhookStatus),
    RollWebhookSecretOk(Automation),
    ListWebhookDeliveriesOk(ListWebhookDeliveriesResponse),
    SessionUsageOk(SessionUsageResponse),
    UsageTurnsOk(UsageTurnsResponse),
    UsageHoursOk(UsageHoursResponse),
    ServerStatusOk(ServerStatus),
    PreviewScheduleOk(PreviewScheduleResponse),
    /// A run started or finished. Pushed unasked to whoever is attached, because the client that
    /// cares did not ask for it: the clock did.
    AutomationRunChanged(AutomationRun),
    SetModeOk(SetModeOkResponse),
    ConfigOptionUpdated(ConfigOptionUpdatedResponse),
    FileSearchOk(FileSearchResponse),
    FileReadOk(FileReadResponse),
    TurnStarted(TurnStarted),
    TurnEnded(TurnEnded),
    SessionListOk(SessionListOkResponse),
    SessionLoadOk(SessionLoadOkResponse),
    SessionCloseOk,
    SessionDeleteOk,
    PreInitializeOk(PreInitializeResponse),
    AuthenticateOk,
    LogoutOk,
    AuthTerminalExit(AuthTerminalExitResponse),
    CheckToolsOk(CheckToolsResponse),
    SetToolPathOk(ToolCheckResult),
    InstallSkillsOk(InstallSkillsResponse),
    ListMcpServersOk(McpServerList),
    SaveMcpServersOk,
    SetMcpSecretsOk,
    TestMcpServerOk(McpTestResult),
    ListSkillsOk(SkillList),
    ApplySkillOk,
    DeleteSkillOk,
    DetectInstalledAgentsOk(DetectInstalledAgentsResponse),
    /// An agent called a Maestro MCP tool the host has to answer. Tauri replies with
    /// `ServerRequest::HostToolResult` carrying the same `request_id`.
    HostToolCall(HostToolCall),
    AcquireProjectLockOk(AcquireProjectLockResponse),
    HomeSummaryOk(HomeSummaryResponse),
    /// The answer to `RequestTakeover`, sent once the holder has been dealt with.
    TakeoverResultOk(TakeoverResult),
    /// Some project was locked or released. Pushed to every client, so pickers can refetch.
    ProjectLocksChanged,
    /// Another client wants the project this one holds. Sent to the holder alone, which answers
    /// with `TakeoverAnswer`; no answer within ten seconds counts as yes.
    TakeoverRequested(TakeoverRequested),
    /// This client no longer holds its project. Sent to that client alone.
    ProjectKicked(ProjectKicked),
    ListTasksOk(TaskList),
    GetTaskOk(OptionalTask),
    CreateTaskOk(Task),
    UpdateTaskOk(Task),
    ArchiveTaskOk(Task),
    CancelTaskOk(Task),
    DeleteTaskOk,
    ApplyTaskTransitionOk(OptionalTask),
    CloseRefinementOk(Task),
    ListTasksAwaitingMergeOk(TaskList),
    ListTaskCommentsOk(TaskCommentList),
    AddTaskCommentOk(TaskComment),
    ListTaskAttachmentsOk(TaskAttachmentList),
    AddTaskAttachmentOk(TaskAttachment),
    DeleteTaskAttachmentOk,
    ListWorktreesOk(WorktreeList),
    GetWorktreeOk(OptionalWorktree),
    InsertWorktreeOk(Worktree),
    UpdateWorktreeOk(Worktree),
    DeleteWorktreesOk,
    SaveTaskReviewOk(SaveTaskReviewResponse),
    ClearTaskReviewOk,
    ListLoopChecksOk(LoopCheckList),
    SetLoopChecksOk(LoopCheckList),
    AnswerLoopProposalOk(LoopCheckList),
    TickLoopCheckOk(LoopCheckList),
    ListLoopIterationsOk(LoopIterationList),
    RerunLoopChecksOk,
    PauseLoopOk,
    StopLoopOk,
    RestartTaskOk,
    ReadLoopNotesOk(LoopNotes),
    ListPromptsOk(PromptList),
    GetPromptOk(OptionalPrompt),
    CreatePromptOk(Prompt),
    UpdatePromptOk(Prompt),
    SetPromptFavoriteOk(Prompt),
    DeletePromptOk,
    BeginImportOk(BeginImportResponse),
    ImportChunkOk,
    ImportProjectOk(ImportProjectResponse),
    /// Some task of the project changed. Pushed to every client, whoever wrote it, so a second
    /// window refetches its board.
    TasksChanged(ProjectRef),
    /// A task's thread changed.
    TaskCommentsChanged(TaskRef),
    /// Some worktree row of the project changed.
    WorktreesChanged(ProjectRef),
    /// Some prompt of the project's collection changed.
    PromptsChanged(ProjectRef),
    GetCapacityOk(CapacityStatus),
    SetCapacityOk,
    AutoModeOk(AutoModeSetting),
    SetAutoModeOk,
    LoopWaitCapOk(LoopWaitCap),
    HoldTaskOk,
    ReleaseTaskHoldOk,
    OpenAgentGateOk,
    StartTaskOk(StartTaskResponse),
    /// Pushed to every window, which re-reads what it shows and drains its queue.
    PipelineSettingsChanged(PipelineSettingsChanged),
    /// Pushed to every window: nobody owns the session yet, so it does not route by its id.
    TaskSessionStarted(TaskSessionStarted),
    /// Periodic heartbeat from maestro-server. Tauri responds with `Pong { seq }`.
    Ping {
        seq: u64,
    },
    /// Unsolicited diagnostic event from maestro-server for logging and observability.
    Diagnostic(DiagnosticPayload),
}

impl ServerResponse {
    /// Whether this answers a request, as opposed to being pushed or streamed unasked.
    ///
    /// No wildcard arm on purpose: a new variant has to be classified before the crate compiles,
    /// because a reply mistaken for a push never resolves the request waiting on it.
    pub fn is_reply(&self) -> bool {
        match self {
            Self::SessionUpdate(_)
            | Self::PermissionRequest(_)
            | Self::ElicitationRequest(_)
            | Self::TerminalOutput(_)
            | Self::AutomationRunChanged(_)
            | Self::ConfigOptionUpdated(_)
            | Self::TurnStarted(_)
            | Self::TurnEnded(_)
            | Self::AuthTerminalExit(_)
            | Self::HostToolCall(_)
            | Self::ProjectLocksChanged
            | Self::TakeoverRequested(_)
            | Self::ProjectKicked(_)
            | Self::TasksChanged(_)
            | Self::TaskCommentsChanged(_)
            | Self::WorktreesChanged(_)
            | Self::PromptsChanged(_)
            | Self::PipelineSettingsChanged(_)
            | Self::TaskSessionStarted(_)
            | Self::Ping { .. }
            | Self::Diagnostic(_) => false,
            Self::HandshakeOk(_)
            | Self::SpawnOk(_)
            | Self::Error(_)
            | Self::ListAgentsOk(_)
            | Self::ListProjectSessionsOk(_)
            | Self::RenameSessionOk
            | Self::CloseProjectSessionOk
            | Self::ListAutomationsOk(_)
            | Self::SaveAutomationOk(_)
            | Self::DeleteAutomationOk
            | Self::ListAutomationRunsOk(_)
            | Self::DeleteAutomationRunOk
            | Self::SetRunRetentionOk
            | Self::WebhookSettingsOk(_)
            | Self::RollWebhookSecretOk(_)
            | Self::ListWebhookDeliveriesOk(_)
            | Self::SessionUsageOk(_)
            | Self::UsageTurnsOk(_)
            | Self::UsageHoursOk(_)
            | Self::ServerStatusOk(_)
            | Self::PreviewScheduleOk(_)
            | Self::SetModeOk(_)
            | Self::FileSearchOk(_)
            | Self::FileReadOk(_)
            | Self::SessionListOk(_)
            | Self::SessionLoadOk(_)
            | Self::SessionCloseOk
            | Self::SessionDeleteOk
            | Self::PreInitializeOk(_)
            | Self::AuthenticateOk
            | Self::LogoutOk
            | Self::CheckToolsOk(_)
            | Self::SetToolPathOk(_)
            | Self::InstallSkillsOk(_)
            | Self::ListMcpServersOk(_)
            | Self::SaveMcpServersOk
            | Self::SetMcpSecretsOk
            | Self::TestMcpServerOk(_)
            | Self::ListSkillsOk(_)
            | Self::ApplySkillOk
            | Self::DeleteSkillOk
            | Self::DetectInstalledAgentsOk(_)
            | Self::AcquireProjectLockOk(_)
            | Self::HomeSummaryOk(_)
            | Self::TakeoverResultOk(_)
            | Self::ListTasksOk(_)
            | Self::GetTaskOk(_)
            | Self::CreateTaskOk(_)
            | Self::UpdateTaskOk(_)
            | Self::ArchiveTaskOk(_)
            | Self::CancelTaskOk(_)
            | Self::DeleteTaskOk
            | Self::ApplyTaskTransitionOk(_)
            | Self::CloseRefinementOk(_)
            | Self::ListTasksAwaitingMergeOk(_)
            | Self::ListTaskCommentsOk(_)
            | Self::AddTaskCommentOk(_)
            | Self::ListTaskAttachmentsOk(_)
            | Self::AddTaskAttachmentOk(_)
            | Self::DeleteTaskAttachmentOk
            | Self::ListWorktreesOk(_)
            | Self::GetWorktreeOk(_)
            | Self::InsertWorktreeOk(_)
            | Self::UpdateWorktreeOk(_)
            | Self::DeleteWorktreesOk
            | Self::SaveTaskReviewOk(_)
            | Self::ClearTaskReviewOk
            | Self::ListLoopChecksOk(_)
            | Self::SetLoopChecksOk(_)
            | Self::AnswerLoopProposalOk(_)
            | Self::TickLoopCheckOk(_)
            | Self::ListLoopIterationsOk(_)
            | Self::RerunLoopChecksOk
            | Self::PauseLoopOk
            | Self::StopLoopOk
            | Self::RestartTaskOk
            | Self::ReadLoopNotesOk(_)
            | Self::ListPromptsOk(_)
            | Self::GetPromptOk(_)
            | Self::CreatePromptOk(_)
            | Self::UpdatePromptOk(_)
            | Self::SetPromptFavoriteOk(_)
            | Self::DeletePromptOk
            | Self::BeginImportOk(_)
            | Self::ImportChunkOk
            | Self::ImportProjectOk(_)
            | Self::GetCapacityOk(_)
            | Self::SetCapacityOk
            | Self::AutoModeOk(_)
            | Self::SetAutoModeOk
            | Self::LoopWaitCapOk(_)
            | Self::HoldTaskOk
            | Self::ReleaseTaskHoldOk
            | Self::OpenAgentGateOk
            | Self::StartTaskOk(_) => true,
        }
    }
}

#[cfg(test)]
mod tests;
