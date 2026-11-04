//! A project as the daemon holds it: its lock, a board import, its prompts, and the home summary.

use serde::{Deserialize, Serialize};

use crate::*;

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
    /// Each at least the highest id of its kind the import carries.
    #[serde(default)]
    pub floors: ImportFloors,
    /// The sending app installation's stable id. The daemon keeps one import marker per source:
    /// the same source is refused, another one is merged.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct BeginImportResponse {
    /// Empty when `imported_before`, in which case nothing is staged.
    pub import_id: String,
    /// This source, or one from before sources were recorded, imported the project already.
    #[serde(default)]
    pub imported_before: bool,
    /// Another source imported the project first, so this one's rows are merged: each task, worktree
    /// and prompt id moves up by an offset the daemon reserved now, and every reference moves along.
    #[serde(default)]
    pub merge: bool,
    /// What every imported task id becomes `id + task_offset`, zero unless `merge`. Attachment rows
    /// are sent with their final project-relative path, so the app copies files to the final id.
    #[serde(default)]
    pub task_offset: i32,
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HomeSummaryRequest {
    /// The client's own projects on this connection. Listed even when the server holds nothing
    /// for them.
    pub project_paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HomeSummaryResponse {
    pub status: ServerStatus,
    /// The requested projects and every one the server holds tasks, sessions or automations for,
    /// once each by canonical path.
    pub projects: Vec<ProjectSummary>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProjectSummary {
    /// As the client sent it for a requested project, so it can be matched without knowing how
    /// the server canonicalizes; canonical for the rest.
    pub project_path: String,
    pub queued: u32,
    pub in_progress: u32,
    pub review: u32,
    /// Live sessions mid-turn.
    pub working_agents: u32,
    /// Prompts waiting on the user, plus tasks with the ball on the user.
    pub needs_you: u32,
    /// What the first prompt waiting on the user asks.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocking_prompt: Option<String>,
    /// Names of the automations running now.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub running_automations: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lock_holder: Option<String>,
    /// Held by the client that asked.
    #[serde(default)]
    pub lock_yours: bool,
}
