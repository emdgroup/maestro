use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

pub mod exec;

pub const MSG_LEN_SIZE: usize = 4;
pub const MAX_MESSAGE_SIZE: usize = 16 * 1024 * 1024; // 16 MB — reject oversized payloads (T-41-01)
pub const PROTOCOL_VERSION: u32 = 11;
/// Canonical error string returned by spawn when the agent requires authentication.
/// Both Rust (session_ops) and TypeScript frontends check for this exact value.
///
/// A refused `StartTask` names the agent too, as `auth_required:<agent_id>`, since the window
/// cannot know which agent the daemon picked for the stage. See [`auth_required_for`].
pub const AUTH_REQUIRED_ERROR: &str = "auth_required";

/// The error a `StartTask` answers with when `agent_id` needs a sign-in.
pub fn auth_required_for(agent_id: &str) -> String {
    format!("{AUTH_REQUIRED_ERROR}:{agent_id}")
}

/// A window's `session/load` refused because the daemon's startup pass is reloading that session
/// itself. Not a load failure: the session arrives as `TaskSessionStarted` once it is up, so the
/// window drops its pending entry and waits. Deliberately not prefixed with
/// [`SESSION_LOAD_FAILED_ERROR`], which would make the host tear the session down.
pub const SESSION_RELOADING_ERROR: &str = "session_reloading";
/// Prefix of the error returned when `session/load` fails.
///
/// `ErrorResponse::session_id` marks an error as *scoped to* a session; this prefix is what marks
/// one as *fatal* to it. The host tears the session down on a load failure and merely reports
/// every other error, so the two cannot be told apart by the id alone. Matched by prefix in
/// `reader_task` and by substring in `useAcpActivity.ts`, so older deployed servers — which
/// spell the same string literally — keep working.
pub const SESSION_LOAD_FAILED_ERROR: &str = "ACP session/load failed";
/// Prefix of a load failure that trying again cannot fix: the agent no longer has the
/// conversation, the folder it ran in is gone, or this machine does not know the agent.
///
/// Begins with [`SESSION_LOAD_FAILED_ERROR`] so everything that matches a load failure still
/// matches this one. The server decides, because it holds the agent's error code and the host is
/// sent only the agent's own wording. It is what lets the host close the conversation's row and
/// leave open one whose agent crashed or wants signing in to again.
pub const SESSION_GONE_ERROR: &str = "ACP session/load failed: the session is gone";
/// Prefix of the error `attach` answers with when the resident server belongs to another build of
/// Maestro and is in use, so replacing it would end work somebody is doing. `attach --replace`
/// replaces it regardless. Matched by substring in `PreflightModal.tsx`.
pub const SERVER_BUSY_ERROR: &str = "server_busy";

// --- Top-level envelope ---

#[derive(Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "direction", rename_all = "snake_case")]
pub enum MaestroRpcMessage {
    Request(ServerRequest),
    Response(ServerResponse),
}

impl MaestroRpcMessage {
    /// The host-side session a message is about, if it is about one.
    ///
    /// A daemon serving several windows routes by this: a request naming a session makes its
    /// sender that session's owner, and a response naming one goes to the owner. The host routes
    /// what it receives by the same answer, so the two sides cannot disagree on which messages
    /// belong to a session.
    pub fn session_id(&self) -> Option<&str> {
        let id = match self {
            Self::Request(req) => match req {
                ServerRequest::Spawn(r) => &r.session_id,
                ServerRequest::Prompt(r) => &r.session_id,
                ServerRequest::Cancel(r) => &r.session_id,
                ServerRequest::InterruptTurn(r) => &r.session_id,
                ServerRequest::PermitResponse(r) => &r.session_id,
                ServerRequest::ElicitationResponse(r) => &r.session_id,
                ServerRequest::SetModel(r) => &r.session_id,
                ServerRequest::SetMode(r) => &r.session_id,
                ServerRequest::SetConfigOption(r) => &r.session_id,
                ServerRequest::SessionLoad(r) => &r.session_id,
                ServerRequest::HostToolResult(r) => &r.session_id,
                _ => return None,
            },
            Self::Response(resp) => match resp {
                ServerResponse::SpawnOk(r) => &r.session_id,
                ServerResponse::SessionUpdate(r) => &r.session_id,
                ServerResponse::PermissionRequest(r) => &r.session_id,
                ServerResponse::ElicitationRequest(r) => &r.session_id,
                ServerResponse::TerminalOutput(r) => &r.session_id,
                ServerResponse::TurnEnded(r) => &r.session_id,
                ServerResponse::HostToolCall(r) => &r.session_id,
                ServerResponse::SetModelOk(r) => &r.session_id,
                ServerResponse::SetModeOk(r) => &r.session_id,
                ServerResponse::SetConfigOptionOk(r) => &r.session_id,
                ServerResponse::ConfigOptionUpdated(r) => &r.session_id,
                ServerResponse::SessionLoadOk(r) => &r.session_id,
                ServerResponse::Error(err) => return err.session_id.as_deref(),
                _ => return None,
            },
        };
        Some(id)
    }
}

// --- Client -> Server ---

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct HandshakeRequest {
    pub protocol_version: u32,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct HandshakeResponse {
    pub protocol_version: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AuthMethodInfo {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub method_type: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub args: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_cmd: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
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
    TestToolPath(TestToolPathRequest),
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
    DetectProjectAgents(DetectProjectAgentsRequest),
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
    /// Who holds each of these projects, for the picker.
    ListProjectLocks(ListProjectLocksRequest),
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
    EndTaskTurn(EndTaskTurnRequest),
    CloseRefinement(CloseRefinementRequest),
    RequestTaskExecution(RequestTaskExecutionRequest),
    /// Queued tasks with no phase, deferred first, then by priority and age.
    ListQueueCandidates(ListQueueCandidatesRequest),
    /// Unarchived tasks at `AwaitingMerge` with a pull request number, for the forge sweep.
    ListTasksAwaitingMerge(ProjectRef),
    ImportTasks(ImportTasksRequest),
    /// A task's thread, oldest first.
    ListTaskComments(TaskRef),
    /// A `proposal` or `plan` replaces the task's previous one of that kind.
    AddTaskComment(AddTaskCommentRequest),
    ListTaskAttachments(TaskRef),
    AddTaskAttachment(AddTaskAttachmentRequest),
    DeleteTaskAttachment(DeleteTaskAttachmentRequest),
    ListTaskRelationships(TaskRef),
    AddTaskRelationship(AddTaskRelationshipRequest),
    DeleteTaskRelationship(DeleteTaskRelationshipRequest),
    ListTaskInstructions(TaskRef),
    AddTaskInstruction(AddTaskInstructionRequest),
    ListWorktrees(ListWorktreesRequest),
    GetWorktree(WorktreeRef),
    InsertWorktree(InsertWorktreeRequest),
    UpdateWorktree(UpdateWorktreeRequest),
    DeleteWorktrees(DeleteWorktreesRequest),
    ClaimWorktreeForTask(ClaimWorktreeForTaskRequest),
    GetTaskReview(TaskRef),
    SaveTaskReview(SaveTaskReviewRequest),
    ClearTaskReview(TaskRef),
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
    /// Take or renew a hold.
    HoldTask(HoldTaskRequest),
    /// Drop a hold and let the scheduler look at the task again.
    ReleaseTaskHold(TaskRef),
    StartTask(StartTaskRequest),
    /// Heartbeat acknowledgment sent by Tauri in response to a `Ping`.
    Pong {
        seq: u64,
    },
}

/// A tool an agent invoked on Maestro's own MCP server, on its way to the host.
///
/// The same struct travels all three hops — MCP shim to the running server over the loopback
/// gateway, server to Tauri over the framed stdio channel — so a tool that the server can answer
/// itself and one only the host can answer differ by where they stop, not by their shape.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct HostToolCall {
    pub session_id: String,
    pub request_id: String,
    pub name: String,
    pub arguments: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct HostToolResult {
    pub session_id: String,
    pub request_id: String,
    pub result: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// What the MCP shim writes to the gateway, framed with [`write_frame`]. The reply is a bare
/// [`HostToolResult`].
///
/// The token is checked before anything else is read from the call: the listener is on loopback,
/// which any local process can reach.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GatewayRequest {
    pub token: String,
    pub call: HostToolCall,
}

/// Environment variables the `McpServerStdio` entry carries to the shim.
pub const MCP_GATEWAY_PORT_ENV: &str = "MAESTRO_MCP_PORT";
pub const MCP_GATEWAY_TOKEN_ENV: &str = "MAESTRO_MCP_TOKEN";
pub const MCP_GATEWAY_SESSION_ENV: &str = "MAESTRO_MCP_SESSION";
/// Name of the MCP server Maestro injects. A `.mcp.json` entry using it is skipped.
pub const MCP_SERVER_NAME: &str = "maestro";

/// Directory holding the resident server's lock and runtime files.
///
/// Set by the host for a local connection, so a development build pointed at its own
/// `MAESTRO_DATA_DIR` gets its own daemon rather than contending with the installed app. Unset on
/// a remote machine, where there is no such directory and the daemon falls back to
/// `~/.maestro/daemon`.
pub const DAEMON_DIR_ENV: &str = "MAESTRO_DAEMON_DIR";
/// Fallback daemon directory, relative to the home directory of the user the server runs as.
pub const DAEMON_DIR_DEFAULT: &str = ".maestro/daemon";
/// Held open by the running daemon for as long as it lives.
///
/// The lock, not the runtime file, is what answers "is a daemon alive here": a killed process
/// leaves its runtime file behind pointing at a dead port, but the OS releases its lock.
pub const DAEMON_LOCK_FILE: &str = "lock";
/// Where a running daemon publishes how to reach it. See [`DaemonRuntime`].
pub const DAEMON_RUNTIME_FILE: &str = "runtime.json";

/// What a running daemon publishes about itself, written once at startup.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DaemonRuntime {
    /// Loopback port the daemon accepts client connections on.
    pub port: u16,
    /// Secret a client must present as its first line. Any local process can reach the port, so
    /// this is the only thing deciding whether a connection is answered.
    pub token: String,
    /// `CARGO_PKG_VERSION` of the daemon binary.
    pub version: String,
    /// Protocol the daemon speaks. A client of a different one kills it and starts its own.
    pub protocol_version: u32,
    pub pid: u32,
}

/// What a daemon answers to a `STATUS` line: whether retiring it would cost anybody anything.
///
/// Asked by an `attach` from another build before it replaces the daemon, so it is read as one
/// JSON line before any framing and must stay readable across protocol versions. Add fields with
/// `#[serde(default)]` only.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub struct DaemonActivity {
    /// A Maestro window is connected to it right now.
    pub client_attached: bool,
    /// A session is mid-turn, which includes one waiting on a permission prompt and every
    /// automation run still going.
    pub turn_active: bool,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct SpawnRequest {
    pub agent_id: String,
    pub session_id: String,
    pub cwd: String,
    /// Extra workspace roots from the project's `.maestro/settings.json`, verbatim.
    ///
    /// `~` is deliberately left unexpanded: these are resolved on the machine the agent runs
    /// on, which for an SSH or WSL project is not the one Tauri runs on.
    ///
    /// `default` so a Tauri and a `maestro-server` of different vintages still talk — the
    /// deployed binary is per project and can lag the app.
    #[serde(default)]
    pub additional_directories: Vec<String>,
    /// The project this session belongs to, which is what files it in the server's store.
    /// `None` is a session that belongs to no project, which gets no row.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_path: Option<String>,
    /// See [`SessionMeta`].
    #[serde(default)]
    pub meta: SessionMeta,
}

/// What a session is, beyond where it runs. Every field optional.
///
/// Typed rather than an opaque blob because the server stores each field in its own column: a
/// second machine opening the project has to read them, and a reload that sends fewer of them
/// must not lose the ones the row already holds.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct SessionMeta {
    /// The user's name for the session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_start_sha: Option<String>,
    /// The pipeline stage that started the session, as the host serializes its own enum. Opaque
    /// here, so a new stage never touches the protocol.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct ListAgentsRequest {}

/// Ask the server for every conversation one project holds.
///
/// Distinct from [`SessionListRequest`], which asks an *agent* what it has on disk for a folder.
/// This asks the *server* what the project has opened, which is the one answer a client needs to
/// adopt the running sessions and reload the dormant ones.
#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct ListProjectSessionsRequest {
    /// Canonicalized by the server, which runs on the machine the path exists on.
    pub project_path: String,
    /// Closed sessions are only wanted by Session History, which needs their name and folder.
    #[serde(default)]
    pub include_closed: bool,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct ListProjectSessionsResponse {
    pub sessions: Vec<ProjectSession>,
}

/// One conversation a project holds, running or not.
///
/// Keyed by `agent_id` and `acp_session_id`, not by the routing id: that one is minted again on
/// every reload, so it cannot name a conversation across them.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProjectSession {
    pub agent_id: String,
    pub acp_session_id: String,
    /// What `session/load` needs, and what Session History reopens in.
    pub cwd: String,
    #[serde(default)]
    pub meta: SessionMeta,
    /// Recorded at spawn, because whether an agent answers `session/load` cannot be asked once
    /// its session is gone.
    #[serde(default)]
    pub can_reload: bool,
    /// The project no longer has it open. Kept so Session History can still name it.
    #[serde(default)]
    pub closed: bool,
    /// Present while the server is running it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub live: Option<LiveSessionState>,
}

/// The part of a [`ProjectSession`] that only exists while the server is running it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LiveSessionState {
    /// The routing id, under which every later request finds this session.
    pub session_id: String,
    /// Whether the agent is mid-turn on this session right now.
    ///
    /// Decides what a client that has just attached may do to it: a session between turns can be
    /// closed and reloaded to recover its transcript, one mid-turn cannot without discarding the
    /// turn in progress.
    #[serde(default)]
    pub turn_active: bool,
    /// Requests this session is still waiting on an answer to.
    ///
    /// A permission or elicitation prompt outlives the client that was shown it: the agent is
    /// blocked on it, so the session is mid-turn and is adopted as it stands rather than reloaded.
    /// Replaying these to whoever adopts the session is the only way the prompt becomes answerable
    /// again, because the message that carried it went to a client that is gone.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub pending_requests: Vec<PendingSessionRequest>,
}

/// Rename a conversation in the server's store, where every client opening the project reads it.
///
/// Names the conversation by its key rather than by a routing id, deliberately: a dormant session
/// has none, and the request must not be routed as though it belonged to a live one.
#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct RenameSessionRequest {
    pub project_path: String,
    pub agent_id: String,
    pub acp_session_id: String,
    pub cwd: String,
    pub name: String,
}

/// Close a conversation in the server's store by its key.
///
/// `Cancel` names a session by its routing id, and a dormant conversation has none. Without this
/// one whose load can never succeed would stay open, and be tried again every time the project
/// is opened.
#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct CloseProjectSessionRequest {
    pub agent_id: String,
    pub acp_session_id: String,
}

/// A request the server sent a client and is still waiting on, replayed to the next client.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PendingSessionRequest {
    Permission(PermissionRequest),
    Elicitation(ElicitationRequest),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DiscoveredAgent {
    pub id: String,
    pub name: String,
    pub icon: String,
    /// Tools required to spawn this agent (e.g. ["npx"], ["uvx"]). Empty for binary agents.
    #[serde(default)]
    pub spawn_deps: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct CheckToolsRequest {
    pub tools: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct SetToolPathRequest {
    pub tool: String,
    /// `None` removes the override and restores automatic detection.
    pub path: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct TestToolPathRequest {
    pub tool: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "snake_case")]
pub enum ToolPathSource {
    Override,
    Path,
    SystemEnvironment,
    KnownLocation,
    ShellEnvironment,
    #[default]
    NotFound,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ToolCheckResult {
    pub tool: String,
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub configured_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_path: Option<String>,
    #[serde(default)]
    pub source: ToolPathSource,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct CheckToolsResponse {
    pub results: Vec<ToolCheckResult>,
}

/// One file of a skill, carried by value so the skills version with the Maestro app rather than
/// with the maestro-server release deployed on the target.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SkillFile {
    /// Path relative to the skills root, e.g. `maestro-output/references/canvas.md`.
    pub path: String,
    pub contents: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct InstallSkillsRequest {
    pub skills: Vec<SkillFile>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct InstallSkillsResponse {
    /// `false` when the target already had these exact skills and nothing was run.
    pub installed: bool,
}

/// One environment variable or header of a managed MCP server.
///
/// A secret's `value` is always `""` in `SaveMcpServers` and `ListMcpServersOk`: the app keeps it
/// in the OS keychain and hands it over through `SetMcpSecrets`, so it is never on disk here.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct McpKeyValue {
    pub key: String,
    pub value: String,
    #[serde(default)]
    pub secret: bool,
}

/// Stands for every agent in a managed MCP server's or skill's agent list, those installed later
/// included, where the other entries name one agent each.
pub const ALL_AGENTS: &str = "*";

/// An MCP server the user added through Maestro, injected into the sessions of the agents it lists.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ManagedMcpServer {
    pub name: String,
    /// `stdio`, `http` or `sse`.
    pub transport: String,
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: Vec<McpKeyValue>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub headers: Vec<McpKeyValue>,
    /// Maestro agent ids, e.g. `claude-acp`, or [`ALL_AGENTS`].
    #[serde(default)]
    pub agents: Vec<String>,
    /// The registry entry it was installed from, if any.
    #[serde(default)]
    pub catalog_id: Option<String>,
    /// How the app signs in to a remote server with OAuth. Kept for the app, never read here: the
    /// token it gets reaches the server as an ordinary `Authorization` secret.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub oauth: Option<serde_json::Value>,
}

/// A listing that can also look inside one project.
#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct ProjectScopedRequest {
    #[serde(default)]
    pub project_path: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct McpServerList {
    pub servers: Vec<ManagedMcpServer>,
    /// The project's `.mcp.json`, read as it is: every agent gets these, and Maestro does not
    /// edit them.
    #[serde(default)]
    pub project: Vec<ManagedMcpServer>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct SaveMcpServersRequest {
    pub servers: Vec<ManagedMcpServer>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct McpSecret {
    pub server: String,
    pub key: String,
    pub value: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct SetMcpSecretsRequest {
    pub secrets: Vec<McpSecret>,
}

/// The server to try, with its secret values filled in.
#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct TestMcpServerRequest {
    pub server: ManagedMcpServer,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct McpTestResult {
    pub ok: bool,
    #[serde(default)]
    pub tools: Vec<String>,
    #[serde(default)]
    pub error: Option<String>,
}

/// A skill in this machine's library.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ManagedSkill {
    pub name: String,
    /// `owner/repo` for a skill installed from the catalog, `None` for one written in Maestro.
    #[serde(default)]
    pub source: Option<String>,
    /// The whole `SKILL.md`, frontmatter included. Parsed by the app, which is what writes it.
    pub skill_md: String,
    /// Maestro agent id to whether the skill is installed for it. An agent set to `false` keeps
    /// its place, so the card still shows a switch to turn it back on. [`ALL_AGENTS`] set to
    /// `true` installs it for every agent the skills CLI knows.
    pub agents: std::collections::BTreeMap<String, bool>,
}

/// A skill a project carries in one of its agent directories, such as `.claude/skills/<name>`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProjectSkill {
    pub name: String,
    /// Relative to the project root, e.g. `.claude/skills/review`.
    pub dir: String,
    pub skill_md: String,
    /// Maestro agent ids that read that directory.
    pub agents: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct SkillList {
    pub skills: Vec<ManagedSkill>,
    /// Maestro agent ids the skills CLI can install for. The rest are drawn disabled.
    pub supported_agents: Vec<String>,
    #[serde(default)]
    pub project: Vec<ProjectSkill>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct ApplySkillRequest {
    pub name: String,
    /// Paths relative to the skill's own directory, e.g. `SKILL.md`. `None` leaves the library
    /// copy as it is, which is all a switch on the card needs.
    #[serde(default)]
    pub files: Option<Vec<SkillFile>>,
    #[serde(default)]
    pub source: Option<String>,
    pub agents: std::collections::BTreeMap<String, bool>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct DeleteSkillRequest {
    pub name: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct DetectInstalledAgentsRequest {}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct DetectProjectAgentsRequest {
    pub cwd: String,
}

/// Info about an ACP agent whose underlying tool was detected on the host.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DetectedAgentInfo {
    /// ACP registry agent ID (e.g. "claude-acp").
    pub agent_id: String,
    /// User-facing tool name to display instead of ACP wrapper name (e.g. "Claude Code").
    pub tool_name: String,
    pub binary_found: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub binary_path: Option<String>,
    pub config_dir_found: bool,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct DetectInstalledAgentsResponse {
    /// Agents whose underlying tool was found (binary on PATH or config dir present).
    pub agents: Vec<DetectedAgentInfo>,
    /// All agent IDs that the detection table has an entry for (found OR not found).
    /// Tauri uses this to distinguish "not installed" from "not in detection table".
    pub all_checked_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProjectAgentMarker {
    pub agent_id: String,
    pub markers_found: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct DetectProjectAgentsResponse {
    pub agents: Vec<ProjectAgentMarker>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct ListAgentsResponse {
    pub agents: Vec<DiscoveredAgent>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct PromptRequest {
    pub session_id: String,
    /// String (legacy, wrapped in text block by receiver) or Array of ContentBlock JSON objects
    pub content: serde_json::Value,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct CancelRequest {
    pub session_id: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct InterruptTurnRequest {
    pub session_id: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct PreInitializeRequest {
    pub agent_id: String,
    pub cwd: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct AuthenticateRequest {
    pub agent_id: String,
    pub method_id: String,
    #[serde(default)]
    pub force_no_browser: bool,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct SpawnAuthTerminalRequest {
    pub agent_id: String,
    pub method_id: String,
    pub terminal_id: String,
    pub session_id: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct KillAuthTerminalRequest {
    pub terminal_id: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct AuthTerminalInputRequest {
    pub terminal_id: String,
    pub data: Vec<u8>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct LogoutRequest {
    pub agent_id: String,
}

// --- Automations ---

/// Where an automation's agent runs.
///
/// A path rather than the app's worktree row id: the daemon has to act on this with no access to
/// the app's database, and on a remote project not even to the machine that database is on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
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
    #[serde(default)]
    pub webhook_enabled: bool,
    /// What a delivery does while a run of this automation is already going.
    #[serde(default)]
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
#[serde(rename_all = "snake_case")]
pub enum AutomationRunStatus {
    Running,
    Succeeded,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
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
pub struct ListAutomationsResponse {
    pub automations: Vec<Automation>,
    /// The IANA zone this server's own machine is set to.
    ///
    /// Sent with the list because it is what the editor has to offer: an automation on a remote
    /// project runs on that machine, so "09:00" means one thing there and another where the window
    /// is. Falls back to `UTC` when the machine cannot say.
    #[serde(default = "utc")]
    pub server_timezone: String,
    /// How much of this project's run history is kept.
    #[serde(default)]
    pub retention: RunRetention,
}

/// Which finished runs a project keeps, per automation. A run is deleted only once it breaks every
/// limit that is set: past the newest `keep_last` **and** older than `max_age_days`. Both `None`
/// keeps everything. A running run is never deleted.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub struct RunRetention {
    #[serde(default)]
    pub keep_last: Option<u32>,
    #[serde(default)]
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

fn utc() -> String {
    "UTC".to_string()
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

/// A project named by the path the client knows it by, and who is asking, in words a user on
/// another machine would recognise.
#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct AcquireProjectLockRequest {
    pub project_path: String,
    pub label: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct AcquireProjectLockResponse {
    pub acquired: bool,
    /// Who holds it, when `acquired` is false.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub holder_label: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct ListProjectLocksRequest {
    pub project_paths: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct ListProjectLocksResponse {
    /// Only the projects somebody holds.
    pub locks: Vec<ProjectLockInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProjectLockInfo {
    /// As the client sent it, so it can be matched without knowing how the daemon canonicalizes.
    pub project_path: String,
    pub holder_label: String,
    /// Held by the client that asked.
    pub yours: bool,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct TakeoverAnswer {
    pub request_id: String,
    pub accept: bool,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct TakeoverResult {
    pub granted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TakeoverRequested {
    pub request_id: String,
    pub project_path: String,
    pub requester_label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProjectKicked {
    pub project_path: String,
    pub reason: KickReason,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum KickReason {
    /// Another client asked for the project and this one gave it up or did not answer.
    TakenOver { by: String },
    /// This client stopped answering pings.
    Stale,
}

// --- Tasks, their threads, worktrees and reviews ---
//
// Rows of the daemon's `projects.db`, keyed by project path where the app's tables carried a
// `projects.id`. Task ids are per project, so every request naming one names the project too.
// Plain serde: the app mirrors these with its own `specta::Type` structs, as it does `Automation`,
// so the binary deployed to every remote host does not compile specta in.

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
pub enum TaskStatus {
    Planning,
    Queue,
    InProgress,
    Review,
    Done,
    Cancelled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TaskPriority {
    Urgent,
    High,
    Medium,
    Low,
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum WorkspaceMode {
    NewWorktree,
    RepositoryDirectory,
    ReuseWorkspace,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum BranchMode {
    Create,
    Checkout,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PhaseStatus {
    Running,
    Blocked,
    Waiting,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TaskBall {
    Agent,
    User,
    External,
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TaskCompletion {
    Merged,
    MergedViaPR,
    LocalOnly,
    NoChanges,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PullRequestCi {
    Passing,
    Failing,
    Pending,
}

/// The pipeline role a session was started for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum AgentRole {
    Refiner,
    Planner,
    Coder,
    Reviewer,
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
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
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

/// How an agent's turn on a task ended, as the app classified it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TurnEnding {
    Completed {
        is_git_repo: bool,
        has_changes: Option<bool>,
        reviewer_pending: bool,
    },
    Stalled,
    Failed,
    /// A read-only role's deliverable arrived as a request to leave plan mode.
    ArtifactDelivered,
}

/// The turn end, under one lock: read the phase, turn a reviewer's reply into its verdict
/// (counting the round when it rejects), apply the transition while the task still has a phase,
/// and file the closing message in the thread by what the phase produced.
///
/// A CI fix ending at `AwaitingMerge` is not sent here: the daemon pushes it and applies
/// `CiFixPushed` itself.
#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct EndTaskTurnRequest {
    pub project_path: String,
    pub task_id: i32,
    pub ending: TurnEnding,
    /// The reply read as an approving verdict. Consulted only when the phase is `SelfReview`.
    #[serde(default)]
    pub review_approved: bool,
    pub closing_message: String,
}

/// Answer the refiner's proposal gate: on accept, the latest proposal becomes the description and
/// leaves the thread; either way `RefinementClosed` applies.
#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct CloseRefinementRequest {
    pub project_path: String,
    pub task_id: i32,
    pub accept: bool,
}

/// Defer an Execute the host has no slot for: a Planning task moves to Queue, and a task parked
/// there is stamped with `execute_requested_at` if it has none.
#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct RequestTaskExecutionRequest {
    pub project_path: String,
    pub task_id: i32,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct RequestTaskExecutionResponse {
    /// `false` when the task moved away first, and the caller should let the claim refuse it.
    pub deferred: bool,
}

/// How the machine's agent limit is decided. Serialized as the app's `ConcurrencyMode` is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum ConcurrencyMode {
    /// The number the user set, regardless of what the machine is doing.
    Hard,
    /// Derived from the machine's free memory, `max_concurrent_agents` when it cannot be read.
    #[default]
    Auto,
}

/// How many agents may run at once on this machine, shared by every app attached to it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct CapacitySettings {
    pub concurrency_mode: ConcurrencyMode,
    /// The cap in `Hard` mode, and in `Auto` the fallback for a machine that cannot be measured.
    pub max_concurrent_agents: i32,
}

/// The stored settings and the limit they resolve to right now.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CapacityStatus {
    pub settings: CapacitySettings,
    /// The limit in force, measured when the mode is `Auto`.
    pub slots: i32,
    /// Why `slots` is what it is, for the board to show when the queue is not moving.
    pub reason: String,
    /// Whether the machine has a stored setting, false while it runs on the default.
    #[serde(default)]
    pub stored: bool,
    /// Slots taken right now, counted as the limit is checked: live task sessions and starts
    /// still coming up.
    #[serde(default)]
    pub used: u32,
}

/// Whether a project's queued tasks start on their own.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AutoModeSetting {
    pub project_path: String,
    pub enabled: bool,
}

/// Keep the scheduler off a task a user is working with, renewed by the client while the
/// interaction lasts. A hold not renewed within `ttl_ms` (10 seconds when absent) lapses.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HoldTaskRequest {
    pub project_path: String,
    pub task_id: i32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ttl_ms: Option<u64>,
}

/// Run one stage of a task: claim it, make or reuse its worktree, spawn the role's agent and send
/// the prompt.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StartTaskRequest {
    pub project_path: String,
    pub task_id: i32,
    pub role: AgentRole,
    /// What the user wrote at a gate, folded into the prompt and not stored.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub feedback: Option<String>,
    /// Nobody pressed anything: skip what would stop to ask rather than default it.
    #[serde(default)]
    pub unattended: bool,
    /// Defer the task to the queue rather than start it when the machine has no free slot.
    #[serde(default)]
    pub respect_capacity: bool,
    /// Run this stage on this agent instead of the one its profile picks. Used once, never
    /// written to the task.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StartTaskResponse {
    /// The routing id of the session started, `None` when the task was deferred to the queue.
    pub session_id: Option<String>,
    /// The attachments the prompt went without, each as `<file>: <why>`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub skipped_attachments: Vec<String>,
}

/// The daemon started a session for a task. Pushed to every window, which adopts it the way it
/// adopts an automation's.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TaskSessionStarted {
    pub project_path: String,
    pub task_id: i32,
    pub session_id: String,
    pub agent_id: String,
    pub acp_session_id: String,
    pub role: AgentRole,
}

/// A pipeline setting changed: a project's auto mode, or with no project the machine's capacity.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PipelineSettingsChanged {
    pub project_path: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct ListQueueCandidatesRequest {
    pub project_path: String,
    /// Auto mode. Without it only deferred tasks are candidates.
    #[serde(default)]
    pub include_undeferred: bool,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct TaskIdList {
    pub task_ids: Vec<i32>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct TaskList {
    pub tasks: Vec<Task>,
}

/// Create a task per issue not already imported into the project.
#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct ImportTasksRequest {
    pub project_path: String,
    pub base_branch: String,
    pub issues: Vec<ImportedIssue>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ImportedIssue {
    pub external_id: String,
    pub title: String,
    #[serde(default)]
    pub body: Option<String>,
    pub url: String,
    #[serde(default)]
    pub labels: Vec<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
    pub priority: TaskPriority,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct AddTaskCommentRequest {
    pub project_path: String,
    pub task_id: i32,
    #[serde(flatten)]
    pub comment: NewTaskComment,
}

/// A thread entry to write. A `proposal` or `plan` replaces the task's previous one of that kind.
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
pub struct AddTaskRelationshipRequest {
    pub project_path: String,
    pub from_task_id: i32,
    pub to_task_id: i32,
    pub relationship_type: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct DeleteTaskRelationshipRequest {
    pub project_path: String,
    pub relationship_id: i32,
}

/// Every relationship the task is on either end of.
#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct TaskRelationshipList {
    pub relationships: Vec<TaskRelationship>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct AddTaskInstructionRequest {
    pub project_path: String,
    pub task_id: i32,
    pub content: String,
    pub source: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct TaskInstructionList {
    pub instructions: Vec<TaskInstruction>,
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

/// One prompt of a project's collection. The shared collection is the app's and never crosses the
/// wire, so there is no `shared` here.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Prompt {
    pub id: i32,
    pub project_path: String,
    pub title: String,
    pub body: String,
    pub tags: Vec<String>,
    pub favorite: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct PromptRef {
    pub project_path: String,
    pub prompt_id: i32,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct OptionalPrompt {
    #[serde(default)]
    pub prompt: Option<Prompt>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct PromptList {
    pub prompts: Vec<Prompt>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct CreatePromptRequest {
    pub project_path: String,
    pub title: String,
    pub body: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub favorite: bool,
}

/// An edit: title, body and tags replaced whole. The favorite flag is not an edit and has its own
/// request.
#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct UpdatePromptRequest {
    pub project_path: String,
    pub prompt_id: i32,
    pub title: String,
    pub body: String,
    #[serde(default)]
    pub tags: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct SetPromptFavoriteRequest {
    pub project_path: String,
    pub prompt_id: i32,
    pub favorite: bool,
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

/// Hand a worktree to a task, releasing any other the task owned. An error when the worktree is
/// gone.
#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct ClaimWorktreeForTaskRequest {
    pub project_path: String,
    pub task_id: i32,
    pub worktree_id: i32,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct OptionalTaskReview {
    #[serde(default)]
    pub review: Option<TaskReview>,
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

/// Everything an app held for one project before the daemon kept it, sent once, applied in one
/// transaction.
///
/// Task, worktree and prompt ids are kept, since they are per project and are embedded in folder
/// and branch names. The ids of relationships, instructions, comments, attachments, reviews and
/// review comments are minted again: the daemon numbers those across every project. The
/// `project_path` inside each row is ignored for the request's own, canonicalized.
#[derive(Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct ImportProjectRequest {
    pub project_path: String,
    #[serde(default)]
    pub tasks: Vec<Task>,
    #[serde(default)]
    pub relationships: Vec<TaskRelationship>,
    #[serde(default)]
    pub instructions: Vec<TaskInstruction>,
    #[serde(default)]
    pub comments: Vec<TaskComment>,
    #[serde(default)]
    pub attachments: Vec<TaskAttachment>,
    #[serde(default)]
    pub worktrees: Vec<Worktree>,
    /// Each with its comments; a comment's `review_id` is ignored for the review it sits in.
    #[serde(default)]
    pub reviews: Vec<TaskReview>,
    #[serde(default)]
    pub prompts: Vec<Prompt>,
    #[serde(default)]
    pub sessions: Vec<ImportedSession>,
    #[serde(default)]
    pub floors: ImportFloors,
}

/// The highest id the app ever minted of each kind, deleted rows' included (its
/// `sqlite_sequence`), so the daemon never hands out a number whose folder or branch may linger.
/// Each counter ends at the highest of its current value, the highest imported id and this.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct ImportFloors {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tasks: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktrees: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompts: Option<i32>,
}

/// A conversation the app had, imported as a dormant row: open, so the project loads it on its
/// next open, or closed, so Session History still lists it with its name and folder.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ImportedSession {
    pub agent_id: String,
    pub acp_session_id: String,
    pub cwd: String,
    #[serde(default)]
    pub meta: SessionMeta,
    /// `None` when the app never recorded it, stored as true: the app kept the session to load it
    /// back, and a load the agent cannot answer closes the row, where false would hide it for good.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub can_reload: Option<bool>,
    /// Stored closed as of the import.
    #[serde(default)]
    pub closed: bool,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct BeginImportRequest {
    pub project_path: String,
    #[serde(default)]
    pub floors: ImportFloors,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct BeginImportResponse {
    pub import_id: String,
}

/// Rows appended to a staged import. The chunk's `project_path` and `floors` are ignored for the
/// ones `BeginImport` carried.
#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct ImportChunkRequest {
    pub import_id: String,
    pub chunk: ImportProjectRequest,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct ImportRef {
    pub import_id: String,
}

/// What a chunk's rows may serialize to, well under `MAX_MESSAGE_SIZE`.
pub const IMPORT_CHUNK_BYTES: usize = 4 * 1024 * 1024;

/// Splits an import's rows into chunks whose JSON stays under `budget`, each list's order kept,
/// so appending the chunks' lists in order gives the input's back. A row larger than the budget
/// gets a chunk of its own, which then fails at encode. `floors` are left out: `BeginImport`
/// carries them.
pub fn split_import(request: ImportProjectRequest, budget: usize) -> Vec<ImportProjectRequest> {
    let empty = || ImportProjectRequest {
        project_path: request.project_path.clone(),
        ..ImportProjectRequest::default()
    };
    // The envelope around the rows: the empty chunk, the frame's own keys and the import id.
    let base = serde_json::to_vec(&empty()).map_or(0, |bytes| bytes.len()) + 256;
    let mut chunks = Vec::new();
    let mut current = empty();
    let mut size = base;
    macro_rules! pack {
        ($($field:ident),*) => {$(
            for row in request.$field {
                let len = serde_json::to_vec(&row).map_or(0, |bytes| bytes.len()) + 1;
                if size + len > budget && size > base {
                    chunks.push(std::mem::replace(&mut current, empty()));
                    size = base;
                }
                size += len;
                current.$field.push(row);
            }
        )*};
    }
    pack!(
        tasks,
        relationships,
        instructions,
        comments,
        attachments,
        worktrees,
        reviews,
        prompts,
        sessions
    );
    chunks.push(current);
    chunks
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct ImportProjectResponse {
    /// False when the project was imported before, in which case nothing was written.
    pub imported: bool,
}

// --- Server -> Client ---

#[derive(Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
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
    ServerStatusOk(ServerStatus),
    PreviewScheduleOk(PreviewScheduleResponse),
    /// A run started or finished. Pushed unasked to whoever is attached, because the client that
    /// cares did not ask for it: the clock did.
    AutomationRunChanged(AutomationRun),
    SetModelOk(SetModelOkResponse),
    SetModeOk(SetModeOkResponse),
    SetConfigOptionOk(SetConfigOptionOkResponse),
    ConfigOptionUpdated(ConfigOptionUpdatedResponse),
    FileSearchOk(FileSearchResponse),
    FileReadOk(FileReadResponse),
    TurnEnded(TurnEnded),
    SessionListOk(SessionListOkResponse),
    SessionLoadOk(SessionLoadOkResponse),
    SessionCloseOk,
    SessionDeleteOk,
    PreInitializeOk(PreInitializeResponse),
    AuthenticateOk,
    LogoutOk,
    AuthTerminalExit(AuthTerminalExitResponse),
    AgentConnectionLost(AgentConnectionLost),
    CheckToolsOk(CheckToolsResponse),
    SetToolPathOk(ToolCheckResult),
    TestToolPathOk(ToolCheckResult),
    InstallSkillsOk(InstallSkillsResponse),
    ListMcpServersOk(McpServerList),
    SaveMcpServersOk,
    SetMcpSecretsOk,
    TestMcpServerOk(McpTestResult),
    ListSkillsOk(SkillList),
    ApplySkillOk,
    DeleteSkillOk,
    DetectInstalledAgentsOk(DetectInstalledAgentsResponse),
    DetectProjectAgentsOk(DetectProjectAgentsResponse),
    /// An agent called a Maestro MCP tool the host has to answer. Tauri replies with
    /// `ServerRequest::HostToolResult` carrying the same `request_id`.
    HostToolCall(HostToolCall),
    AcquireProjectLockOk(AcquireProjectLockResponse),
    ProjectLocksOk(ListProjectLocksResponse),
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
    /// The task when the turn's transition applied, `None` when the task had already been parked.
    EndTaskTurnOk(OptionalTask),
    CloseRefinementOk(Task),
    RequestTaskExecutionOk(RequestTaskExecutionResponse),
    ListQueueCandidatesOk(TaskIdList),
    ListTasksAwaitingMergeOk(TaskList),
    /// The tasks created, not the issues skipped.
    ImportTasksOk(TaskList),
    ListTaskCommentsOk(TaskCommentList),
    AddTaskCommentOk(TaskComment),
    ListTaskAttachmentsOk(TaskAttachmentList),
    AddTaskAttachmentOk(TaskAttachment),
    DeleteTaskAttachmentOk,
    ListTaskRelationshipsOk(TaskRelationshipList),
    AddTaskRelationshipOk(TaskRelationship),
    DeleteTaskRelationshipOk,
    ListTaskInstructionsOk(TaskInstructionList),
    AddTaskInstructionOk(TaskInstruction),
    ListWorktreesOk(WorktreeList),
    GetWorktreeOk(OptionalWorktree),
    InsertWorktreeOk(Worktree),
    UpdateWorktreeOk(Worktree),
    DeleteWorktreesOk,
    ClaimWorktreeForTaskOk(Worktree),
    GetTaskReviewOk(OptionalTaskReview),
    SaveTaskReviewOk(SaveTaskReviewResponse),
    ClearTaskReviewOk,
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
    HoldTaskOk,
    ReleaseTaskHoldOk,
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
            | Self::TurnEnded(_)
            | Self::AuthTerminalExit(_)
            | Self::AgentConnectionLost(_)
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
            | Self::ServerStatusOk(_)
            | Self::PreviewScheduleOk(_)
            | Self::SetModelOk(_)
            | Self::SetModeOk(_)
            | Self::SetConfigOptionOk(_)
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
            | Self::TestToolPathOk(_)
            | Self::InstallSkillsOk(_)
            | Self::ListMcpServersOk(_)
            | Self::SaveMcpServersOk
            | Self::SetMcpSecretsOk
            | Self::TestMcpServerOk(_)
            | Self::ListSkillsOk(_)
            | Self::ApplySkillOk
            | Self::DeleteSkillOk
            | Self::DetectInstalledAgentsOk(_)
            | Self::DetectProjectAgentsOk(_)
            | Self::AcquireProjectLockOk(_)
            | Self::ProjectLocksOk(_)
            | Self::TakeoverResultOk(_)
            | Self::ListTasksOk(_)
            | Self::GetTaskOk(_)
            | Self::CreateTaskOk(_)
            | Self::UpdateTaskOk(_)
            | Self::ArchiveTaskOk(_)
            | Self::CancelTaskOk(_)
            | Self::DeleteTaskOk
            | Self::ApplyTaskTransitionOk(_)
            | Self::EndTaskTurnOk(_)
            | Self::CloseRefinementOk(_)
            | Self::RequestTaskExecutionOk(_)
            | Self::ListQueueCandidatesOk(_)
            | Self::ListTasksAwaitingMergeOk(_)
            | Self::ImportTasksOk(_)
            | Self::ListTaskCommentsOk(_)
            | Self::AddTaskCommentOk(_)
            | Self::ListTaskAttachmentsOk(_)
            | Self::AddTaskAttachmentOk(_)
            | Self::DeleteTaskAttachmentOk
            | Self::ListTaskRelationshipsOk(_)
            | Self::AddTaskRelationshipOk(_)
            | Self::DeleteTaskRelationshipOk
            | Self::ListTaskInstructionsOk(_)
            | Self::AddTaskInstructionOk(_)
            | Self::ListWorktreesOk(_)
            | Self::GetWorktreeOk(_)
            | Self::InsertWorktreeOk(_)
            | Self::UpdateWorktreeOk(_)
            | Self::DeleteWorktreesOk
            | Self::ClaimWorktreeForTaskOk(_)
            | Self::GetTaskReviewOk(_)
            | Self::SaveTaskReviewOk(_)
            | Self::ClearTaskReviewOk
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
            | Self::HoldTaskOk
            | Self::ReleaseTaskHoldOk
            | Self::StartTaskOk(_) => true,
        }
    }
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct TurnEnded {
    pub session_id: String,
    pub stop_reason: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct ModelInfo {
    pub model_id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct SessionModelState {
    pub current_model_id: String,
    pub available_models: Vec<ModelInfo>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct SetModelRequest {
    pub session_id: String,
    pub model_id: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct SetModelOkResponse {
    pub session_id: String,
    pub model_id: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct ModeInfo {
    pub mode_id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct SessionModeState {
    pub current_mode_id: String,
    pub available_modes: Vec<ModeInfo>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct SetModeRequest {
    pub session_id: String,
    pub mode_id: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct SetModeOkResponse {
    pub session_id: String,
    pub mode_id: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct SetConfigOptionRequest {
    pub session_id: String,
    pub config_id: String,
    pub value: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct SetConfigOptionOkResponse {
    pub session_id: String,
    pub config_id: String,
    pub value: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct ConfigOptionUpdatedResponse {
    pub session_id: String,
    pub config_id: String,
    pub value: String,
    pub config_options: Vec<serde_json::Value>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct PromptCapabilitiesInfo {
    pub embedded_context: bool,
    pub image: bool,
    pub audio: bool,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct FileSearchRequest {
    pub cwd: String,
    pub query: String,
    pub limit: Option<u32>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct FileReadRequest {
    pub cwd: String,
    pub relative_path: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct FileSearchResponse {
    pub files: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct FileReadResponse {
    pub content: String,
}

// --- Session management types ---

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct SessionListRequest {
    pub agent_id: String,
    pub cwd: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct SessionLoadRequest {
    pub agent_id: String,
    /// Maestro routing key for this session: the id the host minted for it. Used by
    /// maestro-server to key the session in its internal map so all subsequent
    /// Prompt/Permission/etc. requests (which use the same routing key) find it.
    pub session_id: String,
    /// The agent's real session ID to restore (e.g. a claude-code conversation ID).
    pub resume_session_id: String,
    pub cwd: String,
    /// See [`SpawnRequest::additional_directories`].
    #[serde(default)]
    pub additional_directories: Vec<String>,
    /// The project this session belongs to, which is what files it in the server's store.
    /// `None` is a session that belongs to no project, which gets no row.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_path: Option<String>,
    /// See [`SessionMeta`].
    #[serde(default)]
    pub meta: SessionMeta,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct SessionCloseRequest {
    pub agent_id: String,
    pub session_id: String,
    pub cwd: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct SessionDeleteRequest {
    pub agent_id: String,
    pub session_id: String,
    pub cwd: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SessionListEntry {
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct SessionListOkResponse {
    pub sessions: Vec<SessionListEntry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
    /// Filled in by maestro-server from the live connection's capabilities.
    /// Tauri uses this to tell the frontend whether the delete button should appear.
    #[serde(default)]
    pub supports_session_delete: bool,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct SessionLoadOkResponse {
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub models: Option<SessionModelState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modes: Option<SessionModeState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt_capabilities: Option<PromptCapabilitiesInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config_options: Option<Vec<serde_json::Value>>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct SpawnResponse {
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub acp_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub models: Option<SessionModelState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modes: Option<SessionModeState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt_capabilities: Option<PromptCapabilitiesInfo>,
    #[serde(default)]
    pub supports_session_list: bool,
    #[serde(default)]
    pub supports_session_load: bool,
    #[serde(default)]
    pub supports_session_close: bool,
    #[serde(default)]
    pub supports_session_delete: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config_options: Option<Vec<serde_json::Value>>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct PreInitializeResponse {
    pub agent_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt_capabilities: Option<PromptCapabilitiesInfo>,
    #[serde(default)]
    pub supports_session_list: bool,
    #[serde(default)]
    pub supports_session_load: bool,
    #[serde(default)]
    pub supports_session_close: bool,
    #[serde(default)]
    pub supports_session_delete: bool,
    #[serde(default)]
    pub auth_methods: Vec<AuthMethodInfo>,
    #[serde(default)]
    pub supports_auth_logout: bool,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct AuthTerminalExitResponse {
    pub terminal_id: String,
    pub agent_id: String,
    pub exit_code: Option<i32>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct AgentConnectionLost {
    pub agent_id: String,
    pub reason: String,
    pub affected_session_ids: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct DiagnosticPayload {
    /// "info" | "warn" | "error"
    pub level: String,
    pub message: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct ErrorResponse {
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct SessionUpdate {
    pub session_id: String,
    pub payload: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PermissionRequest {
    pub session_id: String,
    pub request_id: String,
    pub payload: serde_json::Value,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct PermissionResponse {
    pub session_id: String,
    pub request_id: String,
    pub option_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ElicitationRequest {
    pub session_id: String,
    pub request_id: String,
    pub message: String,
    pub payload: serde_json::Value,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct ElicitationResponse {
    pub session_id: String,
    pub request_id: String,
    pub response: serde_json::Value,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct TerminalOutput {
    pub session_id: String,
    pub terminal_id: String,
    pub bytes: Vec<u8>,
}

/// Length-prefixed JSON frame, for any message type. The exec channel shares this framing with
/// the main protocol but carries its own message set.
pub async fn write_frame<W: AsyncWrite + Unpin, T: Serialize>(
    stream: &mut W,
    msg: &T,
) -> Result<(), Box<dyn std::error::Error>> {
    let bytes = serde_json::to_vec(msg)?;
    if bytes.len() > MAX_MESSAGE_SIZE {
        return Err(format!(
            "Message too large to send: {} bytes (max {})",
            bytes.len(),
            MAX_MESSAGE_SIZE
        )
        .into());
    }
    let len = bytes.len() as u32;
    stream.write_all(&len.to_le_bytes()).await?;
    stream.write_all(&bytes).await?;
    Ok(())
}

pub async fn read_frame<R: AsyncRead + Unpin, T: serde::de::DeserializeOwned>(
    stream: &mut R,
) -> Result<T, Box<dyn std::error::Error>> {
    let mut len_buf = [0u8; MSG_LEN_SIZE];
    stream.read_exact(&mut len_buf).await?;
    let len = u32::from_le_bytes(len_buf) as usize;
    if len > MAX_MESSAGE_SIZE {
        return Err(format!(
            "Message too large: {} bytes (max {})",
            len, MAX_MESSAGE_SIZE
        )
        .into());
    }
    let mut body = vec![0u8; len];
    stream.read_exact(&mut body).await?;
    Ok(serde_json::from_slice(&body)?)
}

pub async fn write_message<W: AsyncWrite + Unpin>(
    stream: &mut W,
    msg: &MaestroRpcMessage,
) -> Result<(), Box<dyn std::error::Error>> {
    write_frame(stream, msg).await
}

pub async fn read_message<R: AsyncRead + Unpin>(
    stream: &mut R,
) -> Result<MaestroRpcMessage, Box<dyn std::error::Error>> {
    read_frame(stream).await
}

/// Synchronous version of [`read_message`] for use in `spawn_blocking` reader threads.
///
/// On Windows, anonymous pipes don't support overlapped I/O (IOCP), so the async
/// version uses `spawn_blocking` internally. If the future is dropped while a read
/// is in flight (e.g. when a `tokio::select!` picks another arm), the blocking thread
/// continues and the 4-byte length prefix gets silently discarded — causing framing
/// desync. This function is meant to run in a dedicated blocking thread that is never
/// dropped, writing results to an mpsc channel instead.
pub fn read_message_sync<R: std::io::Read>(
    stream: &mut R,
) -> Result<MaestroRpcMessage, Box<dyn std::error::Error + Send + Sync>> {
    read_message_sync_as(stream)
}

fn read_message_sync_as<R: std::io::Read, T: serde::de::DeserializeOwned>(
    stream: &mut R,
) -> Result<T, Box<dyn std::error::Error + Send + Sync>> {
    let mut len_buf = [0u8; MSG_LEN_SIZE];
    stream.read_exact(&mut len_buf)?;
    let len = u32::from_le_bytes(len_buf) as usize;
    if len > MAX_MESSAGE_SIZE {
        return Err(format!(
            "Message too large: {} bytes (max {})",
            len, MAX_MESSAGE_SIZE
        )
        .into());
    }
    let mut body = vec![0u8; len];
    stream.read_exact(&mut body)?;
    Ok(serde_json::from_slice(&body)?)
}

/// Pairs a reply with the request it answers. Rides as a top-level `rpc_id` key beside
/// `direction` and `type`, and is absent on anything unprompted.
///
/// Not `id` and not `request_id`: the message is flattened into the same object, and payloads
/// already own both (`Automation.id`, `PermissionRequest.request_id`). A shared key fails to decode.
pub type RequestId = u64;

#[derive(Serialize)]
struct OutgoingFrame<'a> {
    #[serde(rename = "rpc_id", skip_serializing_if = "Option::is_none")]
    id: Option<RequestId>,
    #[serde(flatten)]
    message: &'a MaestroRpcMessage,
}

#[derive(Deserialize)]
struct IncomingFrame {
    #[serde(rename = "rpc_id", default)]
    id: Option<RequestId>,
    #[serde(flatten)]
    message: MaestroRpcMessage,
}

/// A whole frame, length prefix included, ready to be written as it stands.
///
/// Synchronous and `Send` in its error so both the host's `serialize_message` and the server's
/// spawned tasks can call it directly.
pub fn encode_message(
    id: Option<RequestId>,
    message: &MaestroRpcMessage,
) -> Result<Vec<u8>, Box<dyn std::error::Error + Send + Sync>> {
    let body = serde_json::to_vec(&OutgoingFrame { id, message })?;
    if body.len() > MAX_MESSAGE_SIZE {
        return Err(format!(
            "Message too large to send: {} bytes (max {})",
            body.len(),
            MAX_MESSAGE_SIZE
        )
        .into());
    }
    let mut frame = Vec::with_capacity(MSG_LEN_SIZE + body.len());
    frame.extend_from_slice(&(body.len() as u32).to_le_bytes());
    frame.extend_from_slice(&body);
    Ok(frame)
}

/// The inverse of [`encode_message`] for a frame's body, the length prefix already stripped.
pub fn decode_message(
    body: &[u8],
) -> Result<(Option<RequestId>, MaestroRpcMessage), serde_json::Error> {
    let frame: IncomingFrame = serde_json::from_slice(body)?;
    Ok((frame.id, frame.message))
}

/// [`read_message`], keeping the request id the frame carried.
pub async fn read_message_with_id<R: AsyncRead + Unpin>(
    stream: &mut R,
) -> Result<(Option<RequestId>, MaestroRpcMessage), Box<dyn std::error::Error>> {
    let frame: IncomingFrame = read_frame(stream).await?;
    Ok((frame.id, frame.message))
}

/// [`read_message_sync`], keeping the request id the frame carried.
pub fn read_message_with_id_sync<R: std::io::Read>(
    stream: &mut R,
) -> Result<(Option<RequestId>, MaestroRpcMessage), Box<dyn std::error::Error + Send + Sync>> {
    let frame: IncomingFrame = read_message_sync_as(stream)?;
    Ok((frame.id, frame.message))
}

// --- CDN registry types — used by maestro-server for agent discovery ---

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AcpRegistry {
    pub version: String,
    pub agents: Vec<AgentRegistryEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AgentRegistryEntry {
    pub id: String,
    pub name: String,
    /// Absent in hand-written `custom-agents.json` entries; the CDN registry always sets it.
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub description: Option<String>,
    pub distribution: AgentDistribution,
    #[serde(default)]
    pub repository: Option<String>,
    #[serde(default)]
    pub authors: Option<Vec<String>>,
    #[serde(default)]
    pub license: Option<String>,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub website: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct AgentDistribution {
    #[serde(default)]
    pub npx: Option<NpxDistribution>,
    #[serde(default)]
    pub binary: Option<HashMap<String, BinaryTarget>>,
    #[serde(default)]
    pub uvx: Option<UvxDistribution>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NpxDistribution {
    pub package: String,
    #[serde(default)]
    pub args: Option<Vec<String>>,
    #[serde(default)]
    pub env: Option<HashMap<String, String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BinaryTarget {
    /// Where the CDN registry says the binary can be downloaded. Maestro never fetches it — it
    /// spawns what is already on the host — so a hand-written entry can leave it out.
    #[serde(default)]
    pub archive: Option<String>,
    pub cmd: String,
    #[serde(default)]
    pub args: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct UvxDistribution {
    pub package: String,
    #[serde(default)]
    pub args: Option<Vec<String>>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id_samples() -> Vec<MaestroRpcMessage> {
        let mut samples = vec![
            MaestroRpcMessage::Response(ServerResponse::TerminalOutput(TerminalOutput {
                session_id: "session".to_string(),
                terminal_id: "terminal".to_string(),
                bytes: vec![0, 27, 91, 255],
            })),
            MaestroRpcMessage::Request(ServerRequest::Shutdown),
            MaestroRpcMessage::Response(ServerResponse::SessionCloseOk),
            MaestroRpcMessage::Response(ServerResponse::Ping { seq: u64::MAX }),
            MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
                message: "no".to_string(),
                session_id: None,
            })),
            MaestroRpcMessage::Request(ServerRequest::Spawn(SpawnRequest {
                agent_id: "claude-acp".to_string(),
                session_id: "session".to_string(),
                cwd: "/tmp".to_string(),
                additional_directories: vec!["~/other".to_string()],
                project_path: None,
                meta: SessionMeta::default(),
            })),
            MaestroRpcMessage::Response(ServerResponse::SessionUpdate(SessionUpdate {
                session_id: "session".to_string(),
                payload: serde_json::json!({
                    "project": 3,
                    "nested": {"id": 9, "type": "inner", "list": [1, null, 2.5]},
                }),
            })),
            // Payloads with a top-level `id` and `request_id` of their own, which the frame's key
            // must not collide with.
            MaestroRpcMessage::Response(ServerResponse::SaveAutomationOk(Automation {
                id: "automation-1".to_string(),
                project_path: "/srv/shop".to_string(),
                name: "Nightly".to_string(),
                prompt: "Run the checks".to_string(),
                agent_id: "claude-acp".to_string(),
                cron: None,
                timezone: "UTC".to_string(),
                enabled: false,
                model: None,
                permission_mode: None,
                effort: None,
                workspace: AutomationWorkspace::NewWorktree {
                    base_branch: "main".to_string(),
                },
                webhook_enabled: false,
                webhook_overlap: WebhookOverlap::default(),
                webhook_secret: None,
                next_due_at: None,
            })),
            MaestroRpcMessage::Response(ServerResponse::TakeoverRequested(TakeoverRequested {
                request_id: "takeover-1".to_string(),
                project_path: "/srv/shop".to_string(),
                requester_label: "laptop".to_string(),
            })),
        ];
        samples.extend(task_messages());
        samples.extend(pipeline_messages());
        samples.extend(prompt_messages());
        samples.extend(import_messages());
        samples
    }

    fn import_messages() -> Vec<MaestroRpcMessage> {
        vec![
            MaestroRpcMessage::Request(ServerRequest::BeginImport(BeginImportRequest {
                project_path: "/srv/shop".to_string(),
                floors: ImportFloors {
                    tasks: Some(12),
                    ..ImportFloors::default()
                },
            })),
            MaestroRpcMessage::Response(ServerResponse::BeginImportOk(BeginImportResponse {
                import_id: "import-1".to_string(),
            })),
            MaestroRpcMessage::Response(ServerResponse::ImportChunkOk),
            MaestroRpcMessage::Request(ServerRequest::CommitImport(ImportRef {
                import_id: "import-1".to_string(),
            })),
            MaestroRpcMessage::Request(ServerRequest::ImportChunk(ImportChunkRequest {
                import_id: "import-1".to_string(),
                chunk: sample_import(),
            })),
            MaestroRpcMessage::Response(ServerResponse::ImportProjectOk(ImportProjectResponse {
                imported: false,
            })),
        ]
    }

    fn sample_import() -> ImportProjectRequest {
        ImportProjectRequest {
            project_path: "/srv/shop".to_string(),
            tasks: vec![sample_task()],
            relationships: vec![],
            instructions: vec![],
            comments: vec![TaskComment {
                id: 8,
                task_id: 3,
                kind: "outcome".to_string(),
                author: "agent".to_string(),
                body: Some("Done".to_string()),
                external_ref: None,
                phase: None,
                created_at: "2026-01-01T00:00:00Z".to_string(),
            }],
            attachments: vec![],
            worktrees: vec![],
            reviews: vec![TaskReview {
                id: 2,
                task_id: 3,
                decision: "RequestChanges".to_string(),
                general_feedback: None,
                reviewed_at: None,
                created_at: "2026-01-01T00:00:00Z".to_string(),
                comments: vec![ReviewComment {
                    id: 5,
                    review_id: 2,
                    file_path: "src/lib.rs".to_string(),
                    comment: "Name this".to_string(),
                    created_at: "2026-01-01T00:00:00Z".to_string(),
                }],
            }],
            prompts: vec![sample_prompt()],
            sessions: vec![ImportedSession {
                agent_id: "claude-acp".to_string(),
                acp_session_id: "acp-1".to_string(),
                cwd: "/srv/shop".to_string(),
                meta: sample_meta(),
                can_reload: None,
                closed: true,
            }],
            floors: ImportFloors::default(),
        }
    }

    #[test]
    fn an_import_answer_is_a_reply() {
        assert!(
            ServerResponse::ImportProjectOk(ImportProjectResponse { imported: true }).is_reply()
        );
    }

    #[test]
    fn an_import_larger_than_a_frame_splits_into_chunks_under_budget() {
        let mut request = sample_import();
        let row = request.tasks.remove(0);
        let comment = request.comments.remove(0);
        for id in 0..9_000 {
            let mut task = row.clone();
            task.id = id;
            task.description = Some("x".repeat(2_000));
            request.tasks.push(task);
            let mut comment = comment.clone();
            comment.task_id = id;
            request.comments.push(comment);
        }
        let total = serde_json::to_vec(&request).unwrap().len();
        assert!(total > MAX_MESSAGE_SIZE, "{total}");

        let budget = IMPORT_CHUNK_BYTES;
        let chunks = split_import(
            serde_json::from_slice(&serde_json::to_vec(&request).unwrap()).unwrap(),
            budget,
        );
        assert!(chunks.len() > 4, "{}", chunks.len());
        let mut joined = ImportProjectRequest {
            project_path: request.project_path.clone(),
            ..ImportProjectRequest::default()
        };
        for chunk in chunks {
            let message =
                MaestroRpcMessage::Request(ServerRequest::ImportChunk(ImportChunkRequest {
                    import_id: "00000000-0000-4000-8000-000000000000".to_string(),
                    chunk,
                }));
            let frame = encode_message(Some(u64::MAX), &message).unwrap();
            assert!(frame.len() < budget, "{}", frame.len());
            let MaestroRpcMessage::Request(ServerRequest::ImportChunk(ImportChunkRequest {
                chunk,
                ..
            })) = message
            else {
                unreachable!()
            };
            assert_eq!(chunk.project_path, request.project_path);
            joined.tasks.extend(chunk.tasks);
            joined.relationships.extend(chunk.relationships);
            joined.instructions.extend(chunk.instructions);
            joined.comments.extend(chunk.comments);
            joined.attachments.extend(chunk.attachments);
            joined.worktrees.extend(chunk.worktrees);
            joined.reviews.extend(chunk.reviews);
            joined.prompts.extend(chunk.prompts);
            joined.sessions.extend(chunk.sessions);
        }
        assert_eq!(joined, request);
    }

    fn sample_prompt() -> Prompt {
        Prompt {
            id: 3,
            project_path: "/srv/shop".to_string(),
            title: "Review".to_string(),
            body: "Review the diff".to_string(),
            tags: vec!["review".to_string()],
            favorite: true,
            created_at: "2026-01-01T00:00:00Z".to_string(),
            updated_at: "2026-01-02T00:00:00Z".to_string(),
        }
    }

    fn prompt_messages() -> Vec<MaestroRpcMessage> {
        let prompt = PromptRef {
            project_path: "/srv/shop".to_string(),
            prompt_id: 3,
        };
        vec![
            MaestroRpcMessage::Request(ServerRequest::ListPrompts(ProjectRef {
                project_path: "/srv/shop".to_string(),
            })),
            MaestroRpcMessage::Request(ServerRequest::CreatePrompt(CreatePromptRequest {
                project_path: "/srv/shop".to_string(),
                title: "Review".to_string(),
                body: "Review the diff".to_string(),
                tags: vec!["review".to_string()],
                favorite: true,
            })),
            MaestroRpcMessage::Request(ServerRequest::UpdatePrompt(UpdatePromptRequest {
                project_path: "/srv/shop".to_string(),
                prompt_id: 3,
                title: "Review".to_string(),
                body: "Review the diff".to_string(),
                tags: vec![],
            })),
            MaestroRpcMessage::Request(ServerRequest::SetPromptFavorite(
                SetPromptFavoriteRequest {
                    project_path: "/srv/shop".to_string(),
                    prompt_id: 3,
                    favorite: false,
                },
            )),
            MaestroRpcMessage::Request(ServerRequest::DeletePrompt(prompt)),
            MaestroRpcMessage::Response(ServerResponse::ListPromptsOk(PromptList {
                prompts: vec![sample_prompt()],
            })),
            MaestroRpcMessage::Response(ServerResponse::GetPromptOk(OptionalPrompt {
                prompt: None,
            })),
            MaestroRpcMessage::Response(ServerResponse::CreatePromptOk(sample_prompt())),
            MaestroRpcMessage::Response(ServerResponse::DeletePromptOk),
            MaestroRpcMessage::Response(ServerResponse::PromptsChanged(ProjectRef {
                project_path: "/srv/shop".to_string(),
            })),
        ]
    }

    #[test]
    fn prompt_pushes_are_not_replies_and_prompt_answers_are() {
        assert!(!ServerResponse::PromptsChanged(ProjectRef {
            project_path: "/srv/shop".to_string(),
        })
        .is_reply());
        assert!(ServerResponse::SetPromptFavoriteOk(sample_prompt()).is_reply());
        assert!(ServerResponse::DeletePromptOk.is_reply());
    }

    fn sample_task() -> Task {
        Task {
            id: 3,
            project_path: "/srv/shop".to_string(),
            title: "Fix login".to_string(),
            description: Some("It fails".to_string()),
            status: TaskStatus::Review,
            priority: TaskPriority::High,
            base_branch: "main".to_string(),
            archived_at: None,
            external_id: Some("jira:SHOP-1".to_string()),
            is_imported: Some(true),
            import_source: Some("jira".to_string()),
            skills: vec!["rust".to_string()],
            model_override: None,
            mcp_allowlist: Some(vec!["maestro".to_string()]),
            skills_override: None,
            labels: vec!["bug".to_string()],
            external_url: None,
            external_updated_at: None,
            created_at: "2026-01-01T00:00:00Z".to_string(),
            updated_at: "2026-01-02T00:00:00Z".to_string(),
            auto_approve: false,
            workspace_mode: WorkspaceMode::ReuseWorkspace,
            workspace_worktree_id: Some(4),
            workspace_branch_mode: BranchMode::Create,
            workspace_branch: None,
            agent_id: Some("claude-acp".to_string()),
            permission_mode_override: None,
            execution_start_sha: Some("abc123".to_string()),
            phase: Some(TaskPhase::AwaitingMerge),
            phase_status: Some(PhaseStatus::Waiting),
            ball: TaskBall::External,
            completion: None,
            execute_requested_at: None,
            pull_request_url: Some("https://example.com/pr/9".to_string()),
            pull_request_number: Some(9),
            review_rounds: 1,
            fix_rounds: 0,
            pull_request_ci: Some(PullRequestCi::Pending),
            profile_overrides: Some(r#"{"Planner":null}"#.to_string()),
        }
    }

    /// Payloads carrying an `id` of their own, a transition with a guard, a composite step and a
    /// push, which is what the `rpc_id` round trip and `is_reply` have to hold for.
    fn task_messages() -> Vec<MaestroRpcMessage> {
        vec![
            MaestroRpcMessage::Response(ServerResponse::CreateTaskOk(sample_task())),
            MaestroRpcMessage::Response(ServerResponse::GetTaskOk(OptionalTask { task: None })),
            MaestroRpcMessage::Request(ServerRequest::UpdateTask(UpdateTaskRequest {
                project_path: "/srv/shop".to_string(),
                task_id: 3,
                update: TaskUpdate {
                    title: Some("Fix login".to_string()),
                    description: Some(None),
                    status: Some(TaskStatus::Queue),
                    pull_request_ci: Some(None),
                    execution_start_sha: Some(Some("abc123".to_string())),
                    increment_fix_rounds: true,
                    ..TaskUpdate::default()
                },
            })),
            MaestroRpcMessage::Request(ServerRequest::ApplyTaskTransition(
                ApplyTaskTransitionRequest {
                    project_path: "/srv/shop".to_string(),
                    task_id: 3,
                    event: TaskTransition::TurnCompleted {
                        is_git_repo: true,
                        has_changes: None,
                        reviewer_pending: false,
                    },
                    guard: TransitionGuard::Status(vec![TaskStatus::Planning, TaskStatus::Queue]),
                    update: None,
                    comment: None,
                },
            )),
            MaestroRpcMessage::Request(ServerRequest::ApplyTaskTransition(
                ApplyTaskTransitionRequest {
                    project_path: "/srv/shop".to_string(),
                    task_id: 3,
                    event: TaskTransition::SessionReady(AgentRole::Coder),
                    guard: TransitionGuard::Phase(TaskPhase::SelfReview),
                    update: None,
                    comment: None,
                },
            )),
            MaestroRpcMessage::Request(ServerRequest::ApplyTaskTransition(
                ApplyTaskTransitionRequest {
                    project_path: "/srv/shop".to_string(),
                    task_id: 3,
                    event: TaskTransition::CiFixRequested,
                    guard: TransitionGuard::FixRoundsBelow(3),
                    update: Some(TaskUpdate {
                        increment_fix_rounds: true,
                        execution_start_sha_if_empty: Some("abc123".to_string()),
                        ..TaskUpdate::default()
                    }),
                    comment: Some(NewTaskComment {
                        kind: "ci".to_string(),
                        author: "maestro".to_string(),
                        body: Some("CI failed".to_string()),
                        external_ref: None,
                        phase: Some("AwaitingMerge".to_string()),
                    }),
                },
            )),
            MaestroRpcMessage::Request(ServerRequest::AddTaskComment(AddTaskCommentRequest {
                project_path: "/srv/shop".to_string(),
                task_id: 3,
                comment: NewTaskComment {
                    kind: "plan".to_string(),
                    author: "agent".to_string(),
                    body: Some("Plan".to_string()),
                    external_ref: None,
                    phase: None,
                },
            })),
            MaestroRpcMessage::Request(ServerRequest::ApplyTaskTransition(
                ApplyTaskTransitionRequest {
                    project_path: "/srv/shop".to_string(),
                    task_id: 3,
                    event: TaskTransition::Stopped,
                    guard: TransitionGuard::Always,
                    update: None,
                    comment: None,
                },
            )),
            MaestroRpcMessage::Request(ServerRequest::EndTaskTurn(EndTaskTurnRequest {
                project_path: "/srv/shop".to_string(),
                task_id: 3,
                ending: TurnEnding::Completed {
                    is_git_repo: true,
                    has_changes: Some(true),
                    reviewer_pending: true,
                },
                review_approved: false,
                closing_message: "Done.".to_string(),
            })),
            MaestroRpcMessage::Response(ServerResponse::InsertWorktreeOk(Worktree {
                id: 4,
                project_path: "/srv/shop".to_string(),
                task_id: None,
                branch_name: "maestro/3-fix-login".to_string(),
                base_branch: Some("main".to_string()),
                path: String::new(),
                git_status: None,
                created_at: "2026-01-01T00:00:00Z".to_string(),
            })),
            MaestroRpcMessage::Response(ServerResponse::TasksChanged(ProjectRef {
                project_path: "/srv/shop".to_string(),
            })),
            MaestroRpcMessage::Response(ServerResponse::TaskCommentsChanged(TaskRef {
                project_path: "/srv/shop".to_string(),
                task_id: 3,
            })),
        ]
    }

    #[test]
    fn roundtrip_task_messages() {
        for message in task_messages() {
            let json = serde_json::to_string(&message).unwrap();
            let back: MaestroRpcMessage = serde_json::from_str(&json).unwrap();
            assert_eq!(message, back);
            assert_eq!(message.session_id(), None);
        }
    }

    fn pipeline_messages() -> Vec<MaestroRpcMessage> {
        vec![
            MaestroRpcMessage::Request(ServerRequest::GetCapacity),
            MaestroRpcMessage::Request(ServerRequest::SetCapacity(CapacitySettings {
                concurrency_mode: ConcurrencyMode::Hard,
                max_concurrent_agents: 2,
            })),
            MaestroRpcMessage::Response(ServerResponse::GetCapacityOk(CapacityStatus {
                settings: CapacitySettings {
                    concurrency_mode: ConcurrencyMode::Auto,
                    max_concurrent_agents: 3,
                },
                slots: 4,
                reason: "4 slots, 2.6 GB free".to_string(),
                stored: true,
                used: 1,
            })),
            MaestroRpcMessage::Request(ServerRequest::SetAutoMode(AutoModeSetting {
                project_path: "/srv/shop".to_string(),
                enabled: true,
            })),
            MaestroRpcMessage::Request(ServerRequest::HoldTask(HoldTaskRequest {
                project_path: "/srv/shop".to_string(),
                task_id: 3,
                ttl_ms: None,
            })),
            MaestroRpcMessage::Request(ServerRequest::ReleaseTaskHold(TaskRef {
                project_path: "/srv/shop".to_string(),
                task_id: 3,
            })),
            MaestroRpcMessage::Request(ServerRequest::StartTask(StartTaskRequest {
                project_path: "/srv/shop".to_string(),
                task_id: 3,
                role: AgentRole::Planner,
                feedback: Some("Split the migration out".to_string()),
                unattended: false,
                respect_capacity: true,
                agent_id: Some("codex-acp".to_string()),
            })),
            MaestroRpcMessage::Response(ServerResponse::StartTaskOk(StartTaskResponse {
                session_id: Some("session-9".to_string()),
                skipped_attachments: vec!["spec.pdf: not found".to_string()],
            })),
            MaestroRpcMessage::Response(ServerResponse::PipelineSettingsChanged(
                PipelineSettingsChanged { project_path: None },
            )),
            MaestroRpcMessage::Response(ServerResponse::TaskSessionStarted(TaskSessionStarted {
                project_path: "/srv/shop".to_string(),
                task_id: 3,
                session_id: "session-9".to_string(),
                agent_id: "claude-acp".to_string(),
                acp_session_id: "conversation-9".to_string(),
                role: AgentRole::Coder,
            })),
        ]
    }

    #[test]
    fn roundtrip_pipeline_messages() {
        for message in pipeline_messages() {
            let json = serde_json::to_string(&message).unwrap();
            let back: MaestroRpcMessage = serde_json::from_str(&json).unwrap();
            assert_eq!(message, back);
            // A started session is broadcast: nobody owns it until a window adopts it.
            assert_eq!(message.session_id(), None);
        }
    }

    #[test]
    fn auth_required_for_names_the_agent() {
        let message = auth_required_for("claude-acp");
        assert_eq!(message, "auth_required:claude-acp");
        assert_eq!(
            message.strip_prefix(&format!("{AUTH_REQUIRED_ERROR}:")),
            Some("claude-acp")
        );
    }

    #[test]
    fn start_task_defaults_what_the_button_leaves_out() {
        let json = r#"{"direction":"request","type":"start_task","project_path":"/srv/shop","task_id":3,"role":"Coder"}"#;
        let MaestroRpcMessage::Request(ServerRequest::StartTask(request)) =
            serde_json::from_str(json).unwrap()
        else {
            panic!("not a start_task");
        };
        assert_eq!(request.feedback, None);
        assert!(!request.unattended && !request.respect_capacity);
        assert_eq!(request.agent_id, None);
    }

    #[test]
    fn pipeline_pushes_are_not_replies_and_answers_are() {
        assert!(!ServerResponse::TaskSessionStarted(TaskSessionStarted {
            project_path: "/srv/shop".to_string(),
            task_id: 3,
            session_id: "s".to_string(),
            agent_id: "a".to_string(),
            acp_session_id: "c".to_string(),
            role: AgentRole::Coder,
        })
        .is_reply());
        assert!(
            !ServerResponse::PipelineSettingsChanged(PipelineSettingsChanged {
                project_path: Some("/srv/shop".to_string()),
            })
            .is_reply()
        );
        assert!(ServerResponse::StartTaskOk(StartTaskResponse {
            session_id: None,
            skipped_attachments: vec![],
        })
        .is_reply());
        assert!(ServerResponse::HoldTaskOk.is_reply());
    }

    #[test]
    fn task_pushes_are_not_replies_and_task_answers_are() {
        assert!(!ServerResponse::TasksChanged(ProjectRef {
            project_path: "/srv/shop".to_string(),
        })
        .is_reply());
        assert!(!ServerResponse::WorktreesChanged(ProjectRef {
            project_path: "/srv/shop".to_string(),
        })
        .is_reply());
        assert!(ServerResponse::EndTaskTurnOk(OptionalTask { task: None }).is_reply());
        assert!(ServerResponse::DeleteWorktreesOk.is_reply());
    }

    /// `null` clears a column and an absent key leaves it alone, which a plain `Option<Option<_>>`
    /// cannot tell apart on the way in.
    #[test]
    fn task_update_tells_a_cleared_column_from_an_untouched_one() {
        let json = r#"{"direction":"request","type":"update_task","project_path":"/srv/shop","task_id":3,"update":{"pull_request_ci":null,"description":"New"}}"#;
        let MaestroRpcMessage::Request(ServerRequest::UpdateTask(request)) =
            serde_json::from_str(json).unwrap()
        else {
            panic!("expected an update_task request");
        };
        assert_eq!(request.update.pull_request_ci, Some(None));
        assert_eq!(request.update.description, Some(Some("New".to_string())));
        assert_eq!(request.update.execution_start_sha, None);
        assert!(!request.update.increment_fix_rounds);
    }

    #[test]
    fn a_transition_without_a_guard_is_unguarded() {
        let json = r#"{"direction":"request","type":"apply_task_transition","project_path":"/srv/shop","task_id":3,"event":{"ManualMove":"Queue"}}"#;
        let MaestroRpcMessage::Request(ServerRequest::ApplyTaskTransition(request)) =
            serde_json::from_str(json).unwrap()
        else {
            panic!("expected an apply_task_transition request");
        };
        assert_eq!(request.event, TaskTransition::ManualMove(TaskStatus::Queue));
        assert_eq!(request.guard, TransitionGuard::Always);
    }

    #[tokio::test]
    async fn request_id_round_trips_with_and_without_id() {
        for id in [None, Some(0), Some(u64::MAX)] {
            for message in id_samples() {
                let frame = encode_message(id, &message).unwrap();
                let body = &frame[MSG_LEN_SIZE..];
                assert_eq!(
                    body.len(),
                    u32::from_le_bytes(frame[..4].try_into().unwrap()) as usize
                );
                let json: serde_json::Value = serde_json::from_slice(body).unwrap();
                assert_eq!(json.get("rpc_id").and_then(|value| value.as_u64()), id);

                assert_eq!(decode_message(body).unwrap(), (id, message));
                let (read_id, read) = read_message_with_id(&mut frame.as_slice()).await.unwrap();
                let (sync_id, sync) = read_message_with_id_sync(&mut frame.as_slice()).unwrap();
                assert_eq!((read_id, sync_id), (id, id));
                assert_eq!(read, sync);

                // The id-unaware readers must keep working against a peer that sends ids.
                let plain = read_message(&mut frame.as_slice()).await.unwrap();
                assert_eq!(plain, read);
                assert_eq!(read_message_sync(&mut frame.as_slice()).unwrap(), read);
            }
        }
    }

    #[tokio::test]
    async fn frame_without_id_key_decodes_to_none_and_matches_the_old_encoding() {
        for message in id_samples() {
            let mut old = Vec::new();
            write_message(&mut old, &message).await.unwrap();
            assert_eq!(old, encode_message(None, &message).unwrap());
            assert_eq!(
                read_message_with_id(&mut old.as_slice()).await.unwrap(),
                (None, message)
            );
        }
    }

    #[test]
    fn is_reply_separates_answers_from_pushes() {
        assert!(ServerResponse::SessionCloseOk.is_reply());
        assert!(ServerResponse::Error(ErrorResponse {
            message: "no".to_string(),
            session_id: None,
        })
        .is_reply());
        assert!(ServerResponse::HandshakeOk(HandshakeResponse {
            protocol_version: PROTOCOL_VERSION,
        })
        .is_reply());
        assert!(!ServerResponse::Ping { seq: 1 }.is_reply());
        assert!(!ServerResponse::ProjectLocksChanged.is_reply());
        assert!(!ServerResponse::TerminalOutput(TerminalOutput {
            session_id: "session".to_string(),
            terminal_id: "terminal".to_string(),
            bytes: vec![1],
        })
        .is_reply());
    }

    fn sample_meta() -> SessionMeta {
        SessionMeta {
            session_name: Some("Fix login".to_string()),
            task_id: Some(7),
            task_name: Some("Login".to_string()),
            branch_name: Some("maestro/login".to_string()),
            session_start_sha: Some("abc123".to_string()),
            role: Some("Coder".to_string()),
        }
    }

    fn project_session_messages() -> Vec<MaestroRpcMessage> {
        let live = ProjectSession {
            agent_id: "claude-acp".to_string(),
            acp_session_id: "conversation-1".to_string(),
            cwd: "/srv/shop".to_string(),
            meta: sample_meta(),
            can_reload: true,
            closed: false,
            live: Some(LiveSessionState {
                session_id: "routing-1".to_string(),
                turn_active: true,
                pending_requests: Vec::new(),
            }),
        };
        let dormant = ProjectSession {
            meta: SessionMeta::default(),
            closed: true,
            live: None,
            ..live.clone()
        };
        vec![
            MaestroRpcMessage::Request(ServerRequest::Spawn(SpawnRequest {
                agent_id: "claude-acp".to_string(),
                session_id: "routing-1".to_string(),
                cwd: "/srv/shop".to_string(),
                additional_directories: Vec::new(),
                project_path: Some("/srv/shop".to_string()),
                meta: sample_meta(),
            })),
            MaestroRpcMessage::Request(ServerRequest::SessionLoad(SessionLoadRequest {
                agent_id: "claude-acp".to_string(),
                session_id: "routing-1".to_string(),
                resume_session_id: "conversation-1".to_string(),
                cwd: "/srv/shop".to_string(),
                additional_directories: Vec::new(),
                project_path: Some("/srv/shop".to_string()),
                meta: sample_meta(),
            })),
            MaestroRpcMessage::Request(ServerRequest::ListProjectSessions(
                ListProjectSessionsRequest {
                    project_path: "/srv/shop".to_string(),
                    include_closed: true,
                },
            )),
            MaestroRpcMessage::Request(ServerRequest::RenameSession(RenameSessionRequest {
                project_path: "/srv/shop".to_string(),
                agent_id: "claude-acp".to_string(),
                acp_session_id: "conversation-1".to_string(),
                cwd: "/srv/shop".to_string(),
                name: "Fix login".to_string(),
            })),
            MaestroRpcMessage::Response(ServerResponse::ListProjectSessionsOk(
                ListProjectSessionsResponse {
                    sessions: vec![live, dormant],
                },
            )),
            MaestroRpcMessage::Response(ServerResponse::RenameSessionOk),
            MaestroRpcMessage::Request(ServerRequest::CloseProjectSession(
                CloseProjectSessionRequest {
                    agent_id: "claude-acp".to_string(),
                    acp_session_id: "conversation-1".to_string(),
                },
            )),
            MaestroRpcMessage::Response(ServerResponse::CloseProjectSessionOk),
        ]
    }

    #[test]
    fn roundtrip_project_session_messages() {
        for message in project_session_messages() {
            let json = serde_json::to_string(&message).unwrap();
            let back: MaestroRpcMessage = serde_json::from_str(&json).unwrap();
            assert_eq!(message, back);
        }
    }

    #[test]
    fn spawn_request_without_project_keys_still_deserializes() {
        let json = r#"{"direction":"request","type":"spawn","agent_id":"claude-acp","session_id":"sess-1","cwd":"/tmp"}"#;
        let MaestroRpcMessage::Request(ServerRequest::Spawn(request)) =
            serde_json::from_str(json).unwrap()
        else {
            panic!("expected a spawn request");
        };
        assert_eq!(request.project_path, None);
        assert_eq!(request.meta, SessionMeta::default());
    }

    #[test]
    fn project_session_requests_are_not_session_routed_and_responses_are_replies() {
        for message in project_session_messages() {
            match &message {
                MaestroRpcMessage::Request(
                    ServerRequest::ListProjectSessions(_)
                    | ServerRequest::RenameSession(_)
                    | ServerRequest::CloseProjectSession(_),
                ) => assert_eq!(message.session_id(), None),
                MaestroRpcMessage::Response(response) => {
                    assert!(response.is_reply());
                    assert_eq!(message.session_id(), None);
                }
                MaestroRpcMessage::Request(_) => {}
            }
        }
    }

    #[test]
    fn roundtrip_handshake() {
        let req = MaestroRpcMessage::Request(ServerRequest::Handshake(HandshakeRequest {
            protocol_version: PROTOCOL_VERSION,
        }));
        let json = serde_json::to_string(&req).unwrap();
        let back: MaestroRpcMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(req, back);

        let resp = MaestroRpcMessage::Response(ServerResponse::HandshakeOk(HandshakeResponse {
            protocol_version: PROTOCOL_VERSION,
        }));
        let json = serde_json::to_string(&resp).unwrap();
        let back: MaestroRpcMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(resp, back);
    }

    #[test]
    fn roundtrip_spawn_request() {
        let msg = MaestroRpcMessage::Request(ServerRequest::Spawn(SpawnRequest {
            agent_id: "claude-acp".to_string(),
            session_id: "sess-1".to_string(),
            cwd: "/home/user/project".to_string(),
            additional_directories: Vec::new(),
            project_path: None,
            meta: SessionMeta::default(),
        }));
        let json = serde_json::to_string(&msg).unwrap();
        let back: MaestroRpcMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(msg, back);
    }

    #[test]
    fn roundtrip_prompt_request() {
        let msg = MaestroRpcMessage::Request(ServerRequest::Prompt(PromptRequest {
            session_id: "sess-1".to_string(),
            content: serde_json::Value::String("fix the bug in auth.rs".to_string()),
        }));
        let json = serde_json::to_string(&msg).unwrap();
        let back: MaestroRpcMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(msg, back);
    }

    #[test]
    fn roundtrip_cancel_request() {
        let msg = MaestroRpcMessage::Request(ServerRequest::Cancel(CancelRequest {
            session_id: "sess-1".to_string(),
        }));
        let json = serde_json::to_string(&msg).unwrap();
        let back: MaestroRpcMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(msg, back);
    }

    #[test]
    fn roundtrip_interrupt_turn_request() {
        let msg = MaestroRpcMessage::Request(ServerRequest::InterruptTurn(InterruptTurnRequest {
            session_id: "sess-1".to_string(),
        }));
        let json = serde_json::to_string(&msg).unwrap();
        let back: MaestroRpcMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(msg, back);
    }

    #[test]
    fn roundtrip_spawn_ok_response() {
        let msg = MaestroRpcMessage::Response(ServerResponse::SpawnOk(SpawnResponse {
            session_id: "sess-1".to_string(),
            acp_session_id: None,
            models: None,
            modes: None,
            prompt_capabilities: None,
            supports_session_list: false,
            supports_session_load: false,
            supports_session_close: false,
            supports_session_delete: false,
            config_options: None,
        }));
        let json = serde_json::to_string(&msg).unwrap();
        let back: MaestroRpcMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(msg, back);
    }

    #[test]
    fn roundtrip_spawn_ok_with_models() {
        let msg = MaestroRpcMessage::Response(ServerResponse::SpawnOk(SpawnResponse {
            session_id: "sess-1".to_string(),
            acp_session_id: Some("native-uuid-123".to_string()),
            prompt_capabilities: Some(PromptCapabilitiesInfo {
                embedded_context: true,
                image: false,
                audio: false,
            }),
            modes: None,
            models: Some(SessionModelState {
                current_model_id: "claude-sonnet-4-6".to_string(),
                available_models: vec![
                    ModelInfo {
                        model_id: "claude-opus-4-7".to_string(),
                        name: "Opus 4.7".to_string(),
                        description: None,
                    },
                    ModelInfo {
                        model_id: "claude-sonnet-4-6".to_string(),
                        name: "Sonnet 4.6".to_string(),
                        description: Some("Fast and capable".to_string()),
                    },
                ],
            }),
            supports_session_list: false,
            supports_session_load: false,
            supports_session_close: false,
            supports_session_delete: false,
            config_options: None,
        }));
        let json = serde_json::to_string(&msg).unwrap();
        let back: MaestroRpcMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(msg, back);
    }

    #[test]
    fn roundtrip_set_model_request() {
        let msg = MaestroRpcMessage::Request(ServerRequest::SetModel(SetModelRequest {
            session_id: "sess-1".to_string(),
            model_id: "claude-opus-4-7".to_string(),
        }));
        let json = serde_json::to_string(&msg).unwrap();
        let back: MaestroRpcMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(msg, back);
    }

    #[test]
    fn roundtrip_set_model_ok_response() {
        let msg = MaestroRpcMessage::Response(ServerResponse::SetModelOk(SetModelOkResponse {
            session_id: "sess-1".to_string(),
            model_id: "claude-opus-4-7".to_string(),
        }));
        let json = serde_json::to_string(&msg).unwrap();
        let back: MaestroRpcMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(msg, back);
    }

    #[test]
    fn roundtrip_error_response() {
        let msg = MaestroRpcMessage::Response(ServerResponse::Error(ErrorResponse {
            message: "agent not found".to_string(),
            session_id: None,
        }));
        let json = serde_json::to_string(&msg).unwrap();
        let back: MaestroRpcMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(msg, back);
    }

    #[test]
    fn roundtrip_session_update() {
        let msg = MaestroRpcMessage::Response(ServerResponse::SessionUpdate(SessionUpdate {
            session_id: "sess-1".to_string(),
            payload: serde_json::json!({"type": "agent_message_chunk", "text": "hello"}),
        }));
        let json = serde_json::to_string(&msg).unwrap();
        let back: MaestroRpcMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(msg, back);
    }

    #[test]
    fn roundtrip_permission_request() {
        let msg =
            MaestroRpcMessage::Response(ServerResponse::PermissionRequest(PermissionRequest {
                session_id: "sess-1".to_string(),
                request_id: "perm-42".to_string(),
                payload: serde_json::json!({"tool": "write_file", "path": "/tmp/foo.txt"}),
            }));
        let json = serde_json::to_string(&msg).unwrap();
        let back: MaestroRpcMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(msg, back);
    }

    #[test]
    fn roundtrip_terminal_output() {
        let msg = MaestroRpcMessage::Response(ServerResponse::TerminalOutput(TerminalOutput {
            session_id: "sess-1".to_string(),
            terminal_id: "term-1".to_string(),
            bytes: vec![0x1b, 0x5b, 0x32, 0x4a], // ESC[2J
        }));
        let json = serde_json::to_string(&msg).unwrap();
        let back: MaestroRpcMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(msg, back);
    }

    #[test]
    fn roundtrip_permission_response() {
        let resp = PermissionResponse {
            session_id: "sess-1".to_string(),
            request_id: "perm-42".to_string(),
            option_id: Some("default".into()),
        };
        let json = serde_json::to_string(&resp).unwrap();
        let back: PermissionResponse = serde_json::from_str(&json).unwrap();
        assert_eq!(resp, back);
    }

    #[tokio::test]
    async fn framing_write_then_read_roundtrip() {
        let msg = MaestroRpcMessage::Request(ServerRequest::Spawn(SpawnRequest {
            agent_id: "gemini".to_string(),
            session_id: "sess-99".to_string(),
            cwd: "/tmp".to_string(),
            additional_directories: Vec::new(),
            project_path: None,
            meta: SessionMeta::default(),
        }));

        let mut buf: Vec<u8> = Vec::new();
        write_message(&mut buf, &msg).await.unwrap();

        let mut cursor = std::io::Cursor::new(buf);
        let back = read_message(&mut cursor).await.unwrap();
        assert_eq!(msg, back);
    }

    #[tokio::test]
    async fn read_message_rejects_oversized() {
        // Craft a length prefix claiming 32 MB
        let fake_len: u32 = 32 * 1024 * 1024;
        let mut buf = Vec::new();
        buf.extend_from_slice(&fake_len.to_le_bytes());
        buf.extend_from_slice(&[0u8; 64]); // some body bytes (doesn't matter)

        let mut cursor = std::io::Cursor::new(buf);
        let result = read_message(&mut cursor).await;
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("Message too large"));
    }

    #[test]
    fn roundtrip_permit_response_request() {
        let msg = MaestroRpcMessage::Request(ServerRequest::PermitResponse(PermissionResponse {
            session_id: "sess-1".to_string(),
            request_id: "perm-42".to_string(),
            option_id: Some("default".into()),
        }));
        let json = serde_json::to_string(&msg).unwrap();
        let back: MaestroRpcMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(msg, back);
    }

    #[tokio::test]
    async fn framing_permit_response_roundtrip() {
        let msg = MaestroRpcMessage::Request(ServerRequest::PermitResponse(PermissionResponse {
            session_id: "sess-1".to_string(),
            request_id: "perm-42".to_string(),
            option_id: None,
        }));
        let mut buf: Vec<u8> = Vec::new();
        write_message(&mut buf, &msg).await.unwrap();
        let mut cursor = std::io::Cursor::new(buf);
        let back = read_message(&mut cursor).await.unwrap();
        assert_eq!(msg, back);
    }

    #[test]
    fn roundtrip_file_search_request() {
        let msg = MaestroRpcMessage::Request(ServerRequest::FileSearch(FileSearchRequest {
            cwd: "/home/user/project".to_string(),
            query: "main".to_string(),
            limit: Some(20),
        }));
        let json = serde_json::to_string(&msg).unwrap();
        let back: MaestroRpcMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(msg, back);
    }

    #[test]
    fn roundtrip_file_search_ok() {
        let msg = MaestroRpcMessage::Response(ServerResponse::FileSearchOk(FileSearchResponse {
            files: vec!["src/main.rs".to_string(), "src/lib.rs".to_string()],
        }));
        let json = serde_json::to_string(&msg).unwrap();
        let back: MaestroRpcMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(msg, back);
    }

    #[test]
    fn roundtrip_file_read_request() {
        let msg = MaestroRpcMessage::Request(ServerRequest::FileRead(FileReadRequest {
            cwd: "/home/user/project".to_string(),
            relative_path: "src/main.rs".to_string(),
        }));
        let json = serde_json::to_string(&msg).unwrap();
        let back: MaestroRpcMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(msg, back);
    }

    #[test]
    fn roundtrip_file_read_ok() {
        let msg = MaestroRpcMessage::Response(ServerResponse::FileReadOk(FileReadResponse {
            content: "fn main() {}".to_string(),
        }));
        let json = serde_json::to_string(&msg).unwrap();
        let back: MaestroRpcMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(msg, back);
    }

    #[test]
    fn roundtrip_turn_ended() {
        let msg = MaestroRpcMessage::Response(ServerResponse::TurnEnded(TurnEnded {
            session_id: "sess-1".to_string(),
            stop_reason: "end_turn".to_string(),
        }));
        let json = serde_json::to_string(&msg).unwrap();
        let back: MaestroRpcMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(msg, back);
    }

    #[test]
    fn roundtrip_set_mode_request() {
        let msg = MaestroRpcMessage::Request(ServerRequest::SetMode(SetModeRequest {
            session_id: "sess-1".to_string(),
            mode_id: "plan".to_string(),
        }));
        let json = serde_json::to_string(&msg).unwrap();
        let back: MaestroRpcMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(msg, back);
    }

    #[test]
    fn roundtrip_set_mode_ok_response() {
        let msg = MaestroRpcMessage::Response(ServerResponse::SetModeOk(SetModeOkResponse {
            session_id: "sess-1".to_string(),
            mode_id: "plan".to_string(),
        }));
        let json = serde_json::to_string(&msg).unwrap();
        let back: MaestroRpcMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(msg, back);
    }

    #[test]
    fn roundtrip_spawn_ok_with_modes() {
        let msg = MaestroRpcMessage::Response(ServerResponse::SpawnOk(SpawnResponse {
            session_id: "sess-1".to_string(),
            acp_session_id: None,
            models: None,
            modes: Some(SessionModeState {
                current_mode_id: "default".to_string(),
                available_modes: vec![
                    ModeInfo {
                        mode_id: "default".to_string(),
                        name: "Ask before edits".to_string(),
                        description: None,
                    },
                    ModeInfo {
                        mode_id: "acceptEdits".to_string(),
                        name: "Edit automatically".to_string(),
                        description: Some("File ops auto-approved".to_string()),
                    },
                ],
            }),
            prompt_capabilities: None,
            supports_session_list: false,
            supports_session_load: false,
            supports_session_close: false,
            supports_session_delete: false,
            config_options: None,
        }));
        let json = serde_json::to_string(&msg).unwrap();
        let back: MaestroRpcMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(msg, back);
    }

    #[test]
    fn request_and_response_are_distinguishable() {
        // Verify that a Spawn request and a SpawnOk response both containing session_id
        // are correctly distinguished by the "direction" tag
        let req = MaestroRpcMessage::Request(ServerRequest::Spawn(SpawnRequest {
            agent_id: "test".to_string(),
            session_id: "sess-1".to_string(),
            cwd: "/tmp".to_string(),
            additional_directories: Vec::new(),
            project_path: None,
            meta: SessionMeta::default(),
        }));
        let resp = MaestroRpcMessage::Response(ServerResponse::SpawnOk(SpawnResponse {
            session_id: "sess-1".to_string(),
            acp_session_id: None,
            models: None,
            modes: None,
            prompt_capabilities: None,
            supports_session_list: false,
            supports_session_load: false,
            supports_session_close: false,
            supports_session_delete: false,
            config_options: None,
        }));
        let req_json = serde_json::to_string(&req).unwrap();
        let resp_json = serde_json::to_string(&resp).unwrap();
        // Verify they produce different JSON
        assert_ne!(req_json, resp_json);
        // Verify each round-trips to the correct variant
        let req_back: MaestroRpcMessage = serde_json::from_str(&req_json).unwrap();
        let resp_back: MaestroRpcMessage = serde_json::from_str(&resp_json).unwrap();
        assert!(matches!(req_back, MaestroRpcMessage::Request(_)));
        assert!(matches!(resp_back, MaestroRpcMessage::Response(_)));
    }

    #[test]
    fn roundtrip_pre_initialize_request() {
        let msg = MaestroRpcMessage::Request(ServerRequest::PreInitialize(PreInitializeRequest {
            agent_id: "claude-acp".to_string(),
            cwd: "/home/user/project".to_string(),
        }));
        let json = serde_json::to_string(&msg).unwrap();
        let back: MaestroRpcMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(msg, back);
    }

    #[test]
    fn roundtrip_pre_initialize_ok() {
        let msg =
            MaestroRpcMessage::Response(ServerResponse::PreInitializeOk(PreInitializeResponse {
                agent_id: "claude-acp".to_string(),
                prompt_capabilities: Some(PromptCapabilitiesInfo {
                    embedded_context: true,
                    image: false,
                    audio: false,
                }),
                supports_session_list: true,
                supports_session_load: true,
                supports_session_close: false,
                supports_session_delete: false,
                auth_methods: vec![],
                supports_auth_logout: false,
            }));
        let json = serde_json::to_string(&msg).unwrap();
        let back: MaestroRpcMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(msg, back);
    }

    #[test]
    fn roundtrip_agent_connection_lost() {
        let msg =
            MaestroRpcMessage::Response(ServerResponse::AgentConnectionLost(AgentConnectionLost {
                agent_id: "claude-acp".to_string(),
                reason: "agent process exited unexpectedly".to_string(),
                affected_session_ids: vec!["session-1".to_string(), "session-2".to_string()],
            }));
        let json = serde_json::to_string(&msg).unwrap();
        let back: MaestroRpcMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(msg, back);
    }

    #[test]
    fn roundtrip_detect_installed_agents_request() {
        let msg = MaestroRpcMessage::Request(ServerRequest::DetectInstalledAgents(
            DetectInstalledAgentsRequest {},
        ));
        let json = serde_json::to_string(&msg).unwrap();
        let back: MaestroRpcMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(msg, back);
    }

    #[test]
    fn roundtrip_detect_installed_agents_ok() {
        let msg = MaestroRpcMessage::Response(ServerResponse::DetectInstalledAgentsOk(
            DetectInstalledAgentsResponse {
                agents: vec![
                    DetectedAgentInfo {
                        agent_id: "claude-acp".to_string(),
                        tool_name: "Claude Code".to_string(),
                        binary_found: true,
                        binary_path: Some("/usr/local/bin/claude".to_string()),
                        config_dir_found: true,
                    },
                    DetectedAgentInfo {
                        agent_id: "github-copilot-cli".to_string(),
                        tool_name: "GitHub Copilot".to_string(),
                        binary_found: false,
                        binary_path: None,
                        config_dir_found: true,
                    },
                ],
                all_checked_ids: vec![
                    "claude-acp".to_string(),
                    "github-copilot-cli".to_string(),
                    "codex-acp".to_string(),
                ],
            },
        ));
        let json = serde_json::to_string(&msg).unwrap();
        let back: MaestroRpcMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(msg, back);
    }

    #[test]
    fn roundtrip_detect_project_agents_request() {
        let msg = MaestroRpcMessage::Request(ServerRequest::DetectProjectAgents(
            DetectProjectAgentsRequest {
                cwd: "/home/user/project".to_string(),
            },
        ));
        let json = serde_json::to_string(&msg).unwrap();
        let back: MaestroRpcMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(msg, back);
    }

    #[test]
    fn roundtrip_ping_response() {
        let msg = MaestroRpcMessage::Response(ServerResponse::Ping { seq: 42 });
        let json = serde_json::to_string(&msg).unwrap();
        let back: MaestroRpcMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(msg, back);
    }

    #[test]
    fn roundtrip_pong_request() {
        let msg = MaestroRpcMessage::Request(ServerRequest::Pong { seq: 42 });
        let json = serde_json::to_string(&msg).unwrap();
        let back: MaestroRpcMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(msg, back);
    }

    #[test]
    fn roundtrip_host_tool_call() {
        let msg = MaestroRpcMessage::Response(ServerResponse::HostToolCall(HostToolCall {
            session_id: "session-7".to_string(),
            request_id: "host-1".to_string(),
            name: "create_task".to_string(),
            arguments: serde_json::json!({"title": "Add retries to SFTP reads"}),
        }));
        let json = serde_json::to_string(&msg).unwrap();
        let back: MaestroRpcMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(msg, back);
    }

    #[test]
    fn roundtrip_host_tool_result() {
        let msg = MaestroRpcMessage::Request(ServerRequest::HostToolResult(HostToolResult {
            session_id: "session-7".to_string(),
            request_id: "host-1".to_string(),
            result: serde_json::json!({"id": 12, "status": "Planning"}),
            error: None,
        }));
        let json = serde_json::to_string(&msg).unwrap();
        let back: MaestroRpcMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(msg, back);

        let failed = MaestroRpcMessage::Request(ServerRequest::HostToolResult(HostToolResult {
            session_id: "session-7".to_string(),
            request_id: "host-2".to_string(),
            result: serde_json::Value::Null,
            error: Some("unknown tool".to_string()),
        }));
        let json = serde_json::to_string(&failed).unwrap();
        let back: MaestroRpcMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(failed, back);
    }

    #[tokio::test]
    async fn framing_gateway_request_roundtrip() {
        let req = GatewayRequest {
            token: "1cb1f3c8-0000-4000-8000-000000000000".to_string(),
            call: HostToolCall {
                session_id: "session-3".to_string(),
                request_id: "shim".to_string(),
                name: "canvas_await".to_string(),
                arguments: serde_json::json!({"surfaceId": "s1", "timeoutSeconds": 30}),
            },
        };
        let mut buf: Vec<u8> = Vec::new();
        write_frame(&mut buf, &req).await.unwrap();
        let mut cursor = std::io::Cursor::new(buf);
        let back: GatewayRequest = read_frame(&mut cursor).await.unwrap();
        assert_eq!(req, back);
    }

    #[test]
    fn roundtrip_diagnostic() {
        let msg = MaestroRpcMessage::Response(ServerResponse::Diagnostic(DiagnosticPayload {
            level: "error".to_string(),
            message: "[spawn] FAILED cmd=\"claude\": No such file".to_string(),
        }));
        let json = serde_json::to_string(&msg).unwrap();
        let back: MaestroRpcMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(msg, back);
    }

    #[test]
    fn roundtrip_detect_project_agents_ok() {
        let msg = MaestroRpcMessage::Response(ServerResponse::DetectProjectAgentsOk(
            DetectProjectAgentsResponse {
                agents: vec![ProjectAgentMarker {
                    agent_id: "claude-acp".to_string(),
                    markers_found: vec!["CLAUDE.md".to_string(), ".claude/".to_string()],
                }],
            },
        ));
        let json = serde_json::to_string(&msg).unwrap();
        let back: MaestroRpcMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(msg, back);
    }
}

/// What started a run.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum RunTrigger {
    Schedule,
    #[default]
    Manual,
    Webhook,
}

/// What a webhook delivery does while a run of the same automation is already going.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
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
pub struct WebhookStatus {
    pub settings: WebhookSettings,
    /// Why the listener is not listening, or `None` when it is.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// What became of one delivery.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
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

/// How a server was set to start with its machine.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AutostartMethod {
    /// A systemd user unit, with linger so it runs without anyone logged in.
    Systemd,
    /// A crontab `@reboot` line, where systemd or linger is not available.
    Cron,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SetAutostartRequest {
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ServerStatus {
    pub version: String,
    pub pid: u32,
    /// RFC 3339.
    pub started_at: String,
    pub live_sessions: u32,
    /// Automation runs still going, across every project on this machine.
    pub running_runs: u32,
    /// Whether this server can set itself to start with its machine at all.
    pub autostart_supported: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub autostart: Option<AutostartMethod>,
}
