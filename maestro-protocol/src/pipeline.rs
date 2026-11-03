//! The task pipeline: capacity, auto mode, holds and starting a stage.

use serde::{Deserialize, Serialize};

use crate::*;

/// An agent's closed usage-limit gate.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct AgentGateState {
    pub agent_id: String,
    /// RFC 3339.
    pub resume_at: String,
    /// The window the limit belongs to, `five_hour` or `seven_day...`, when the agent named it.
    #[serde(default)]
    pub window: Option<String>,
    /// No reset time was known: the gate backs off and tries again at `resume_at`.
    pub backoff: bool,
}

/// How the machine's agent limit is decided.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub enum ConcurrencyMode {
    /// The number the user set, regardless of what the machine is doing.
    Hard,
    /// Derived from the machine's free memory, `max_concurrent_agents` when it cannot be read.
    ///
    /// The default, because the limit exists to stop auto-mode starting agents a host has no
    /// memory for, and a fixed number chosen before anyone knew what the machine looks like
    /// cannot do that.
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

/// How many loops may wait on the user before the drain starts no more of the project's queued
/// loops. 0 is no cap.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LoopWaitCap {
    pub project_path: String,
    pub cap: u32,
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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OpenAgentGateRequest {
    pub agent_id: String,
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
