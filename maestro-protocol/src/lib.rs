use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

pub mod exec;

pub const MSG_LEN_SIZE: usize = 4;
pub const MAX_MESSAGE_SIZE: usize = 16 * 1024 * 1024; // 16 MB — reject oversized payloads (T-41-01)
pub const PROTOCOL_VERSION: u32 = 5;
/// Canonical error string returned by spawn when the agent requires authentication.
/// Both Rust (session_ops) and TypeScript frontends check for this exact value.
pub const AUTH_REQUIRED_ERROR: &str = "auth_required";
/// Prefix of the error returned when `session/load` fails.
///
/// `ErrorResponse::session_id` marks an error as *scoped to* a session; this prefix is what marks
/// one as *fatal* to it. The host tears the session down on a load failure and merely reports
/// every other error, so the two cannot be told apart by the id alone. Matched by prefix in
/// `reader_task` and by substring in `useAcpActivity.ts`, so older deployed servers — which
/// spell the same string literally — keep working.
pub const SESSION_LOAD_FAILED_ERROR: &str = "ACP session/load failed";
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
    /// What is this server running right now. Asked by a client that has just attached.
    ListLiveSessions(ListLiveSessionsRequest),
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
    DetectInstalledAgents(DetectInstalledAgentsRequest),
    DetectProjectAgents(DetectProjectAgentsRequest),
    SpawnAuthTerminal(SpawnAuthTerminalRequest),
    KillAuthTerminal(KillAuthTerminalRequest),
    AuthTerminalInput(AuthTerminalInputRequest),
    /// Answer to a [`ServerResponse::HostToolCall`] the host resolved.
    HostToolResult(HostToolResult),
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
    /// See [`host_meta`](ListLiveSession::host_meta).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_meta: Option<serde_json::Value>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct ListAgentsRequest {}

/// Ask the server which sessions it is currently running.
///
/// Distinct from [`SessionListRequest`], which asks an *agent* what conversations it has stored on
/// disk. This asks the *server* what is alive in its own process right now, which is the question
/// a client that has just attached needs answered.
#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct ListLiveSessionsRequest {}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct ListLiveSessionsResponse {
    pub sessions: Vec<ListLiveSession>,
}

/// One session the server is running, as seen by a client re-adopting it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ListLiveSession {
    /// The routing key the host minted, under which every later request finds this session.
    pub session_id: String,
    pub agent_id: String,
    pub cwd: String,
    /// The agent's own session id, when the session has one. Needed to replay history.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub acp_session_id: Option<String>,
    /// Whether the agent is mid-turn on this session right now.
    ///
    /// Decides what a client that has just attached may do to it: a session between turns can be
    /// closed and reloaded to recover its transcript, one mid-turn cannot without discarding the
    /// turn in progress.
    #[serde(default)]
    pub turn_active: bool,
    /// Whatever the host attached at spawn, returned verbatim.
    ///
    /// The server never reads it. It exists because the host knows things about a session the
    /// server has no business knowing — which project and task it belongs to, what the user named
    /// it — and needs them back when re-adopting a session it did not start in this run. Keeping
    /// it opaque means adding a field to it never touches the protocol.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_meta: Option<serde_json::Value>,
    /// Requests this session is still waiting on an answer to.
    ///
    /// A permission or elicitation prompt outlives the client that was shown it: the agent is
    /// blocked on it, so the session is mid-turn and is adopted as it stands rather than reloaded.
    /// Replaying these to whoever adopts the session is the only way the prompt becomes answerable
    /// again, because the message that carried it went to a client that is gone.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub pending_requests: Vec<PendingSessionRequest>,
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
    ListLiveSessionsOk(ListLiveSessionsResponse),
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
    DetectInstalledAgentsOk(DetectInstalledAgentsResponse),
    DetectProjectAgentsOk(DetectProjectAgentsResponse),
    /// An agent called a Maestro MCP tool the host has to answer. Tauri replies with
    /// `ServerRequest::HostToolResult` carrying the same `request_id`.
    HostToolCall(HostToolCall),
    /// Periodic heartbeat from maestro-server. Tauri responds with `Pong { seq }`.
    Ping {
        seq: u64,
    },
    /// Unsolicited diagnostic event from maestro-server for logging and observability.
    Diagnostic(DiagnosticPayload),
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
    /// See [`host_meta`](ListLiveSession::host_meta).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_meta: Option<serde_json::Value>,
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
            host_meta: None,
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
            host_meta: None,
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
            host_meta: None,
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
