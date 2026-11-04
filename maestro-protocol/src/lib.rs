pub mod attachments;
#[cfg(feature = "process")]
pub mod command_ext;
pub mod completion;
pub mod exec;
pub mod mcp_args;
pub mod paths;
pub mod profiles;
pub mod skill_names;
pub mod worktree_names;

pub const PROTOCOL_VERSION: u32 = 18;
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

/// Directory holding the resident server's lock and runtime files.
///
/// Set by the host for a local connection, so a development build pointed at its own
/// `MAESTRO_DATA_DIR` gets its own daemon rather than contending with the installed app. Unset on
/// a remote machine, where there is no such directory and the daemon falls back to
/// `~/.maestro/daemon`.
pub const DAEMON_DIR_ENV: &str = "MAESTRO_DAEMON_DIR";

mod automation;
mod collections;
mod framing;
mod loops;
mod messages;
mod pipeline;
mod project;
mod session;
mod task;
mod usage;

pub use automation::*;
pub use collections::*;
pub use framing::*;
pub use loops::*;
pub use messages::*;
pub use pipeline::*;
pub use project::*;
pub use session::*;
pub use task::*;
pub use usage::*;
