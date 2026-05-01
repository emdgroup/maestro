use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{mpsc, oneshot, Mutex, Notify};

pub enum SessionCommand {
    Prompt(String),
    PromptStructured(Vec<serde_json::Value>),
    SetModel(String),
}

pub struct TerminalHandle {
    pub output_buf: Arc<Mutex<String>>,
    pub output_byte_limit: Option<u64>,
    pub exit_status: Arc<Mutex<Option<TerminalExitInfo>>>,
    pub exit_notify: Arc<Notify>,
    pub kill_tx: Mutex<Option<oneshot::Sender<()>>>,
}

pub struct TerminalExitInfo {
    pub exit_code: Option<u32>,
    pub signal: Option<String>,
}

pub struct ActiveSession {
    pub cmd_tx: mpsc::Sender<SessionCommand>,
    pub pending_permissions: Arc<Mutex<HashMap<String, oneshot::Sender<Option<String>>>>>,
    pub pending_elicitations: Arc<Mutex<HashMap<String, oneshot::Sender<serde_json::Value>>>>,
    pub task: tokio::task::JoinHandle<()>,
}

pub type SessionMap = HashMap<String, ActiveSession>;
