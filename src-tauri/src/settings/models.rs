use serde::{Deserialize, Serialize};
use specta::Type;

/// How many agents may run at once on one connection.
///
/// Per connection rather than per app or per project because the constraint is memory, and memory
/// belongs to the host: every project pointed at the same machine draws on the same pool.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct ConnectionCapacitySettings {
    pub concurrency_mode: crate::execution::capacity::ConcurrencyMode,
    /// The cap in `Hard` mode, and in `Auto` the fallback for a host whose free memory cannot be
    /// read. One number with two uses, not two settings.
    pub max_concurrent_agents: i32,
}

impl Default for ConnectionCapacitySettings {
    fn default() -> Self {
        Self {
            concurrency_mode: crate::execution::capacity::ConcurrencyMode::default(),
            max_concurrent_agents: 3,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
#[specta(export)]
pub enum ActivityVisibility {
    #[default]
    Auto,
    Show,
    Collapse,
    Hide,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
#[specta(export)]
pub enum TerminalColorMode {
    #[default]
    FollowTheme,
    Default,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
#[specta(export)]
pub enum EnterKeyBehavior {
    #[default]
    SendPrompt,
    NewLine,
}

impl std::fmt::Display for ActivityVisibility {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Auto => write!(f, "auto"),
            Self::Show => write!(f, "show"),
            Self::Collapse => write!(f, "collapse"),
            Self::Hide => write!(f, "hide"),
        }
    }
}

impl std::str::FromStr for ActivityVisibility {
    type Err = ();
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "auto" => Ok(Self::Auto),
            "show" => Ok(Self::Show),
            "collapse" => Ok(Self::Collapse),
            "hide" => Ok(Self::Hide),
            _ => Err(()),
        }
    }
}

impl std::fmt::Display for TerminalColorMode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::FollowTheme => write!(f, "follow_theme"),
            Self::Default => write!(f, "default"),
        }
    }
}

impl std::str::FromStr for TerminalColorMode {
    type Err = ();
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "follow_theme" => Ok(Self::FollowTheme),
            "default" => Ok(Self::Default),
            _ => Err(()),
        }
    }
}

impl std::fmt::Display for EnterKeyBehavior {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::SendPrompt => write!(f, "send_prompt"),
            Self::NewLine => write!(f, "new_line"),
        }
    }
}

impl std::str::FromStr for EnterKeyBehavior {
    type Err = ();
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "send_prompt" => Ok(Self::SendPrompt),
            "new_line" => Ok(Self::NewLine),
            _ => Err(()),
        }
    }
}

/// What colour a project that has never chosen one gets on first open.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
#[specta(export)]
pub enum NewProjectColor {
    /// Pick one of the preset hues at random and persist it to the project.
    #[default]
    Auto,
    /// Leave the project colourless so it follows the global default.
    Global,
}

impl std::fmt::Display for NewProjectColor {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Auto => write!(f, "auto"),
            Self::Global => write!(f, "global"),
        }
    }
}

impl std::str::FromStr for NewProjectColor {
    type Err = ();
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "auto" => Ok(Self::Auto),
            "global" => Ok(Self::Global),
            _ => Err(()),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
#[specta(export)]
pub enum AgentStreamWidth {
    #[default]
    Full,
    Compact,
}

impl std::fmt::Display for AgentStreamWidth {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Full => write!(f, "full"),
            Self::Compact => write!(f, "compact"),
        }
    }
}

impl std::str::FromStr for AgentStreamWidth {
    type Err = ();
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "full" => Ok(Self::Full),
            "compact" => Ok(Self::Compact),
            _ => Err(()),
        }
    }
}

/// Where logs go now versus where they will go next launch.
///
/// Two fields rather than one because a directory change needs a restart, and the UI has to be
/// able to say so instead of pointing at a folder that is still empty.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct LogLocation {
    /// Directory the running logger is writing to. Empty if logging failed to start.
    pub active_directory: String,
    /// Directory that will be used at the next launch.
    pub configured_directory: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct AppSettings {
    pub theme_preference: Option<String>,
    #[serde(default)]
    pub auto_mode: bool,
    #[serde(default)]
    pub thinking_visibility: ActivityVisibility,
    #[serde(default)]
    pub tool_call_visibility: ActivityVisibility,
    /// Global default accent hue in degrees, as a string. Projects without their own
    /// `accent_color` follow this; `None` follows the OS accent colour.
    #[serde(default)]
    pub accent_color: Option<String>,
    /// Whether a project that has never chosen a colour gets a random preset on first open.
    #[serde(default)]
    pub new_project_color: NewProjectColor,
    #[serde(default)]
    pub terminal_color_mode: TerminalColorMode,
    #[serde(default)]
    pub enter_key_behavior: EnterKeyBehavior,
    #[serde(default)]
    pub agent_stream_width: AgentStreamWidth,
    pub updated_at: String,
    #[serde(default)]
    pub auto_update: bool,
    #[serde(default)]
    pub ui_scale: Option<String>,
    /// One of `core::logging::LOG_LEVELS`. `None` means the `info` default.
    #[serde(default)]
    pub log_level: Option<String>,
    /// `None` means the OS log directory. Only read at startup — fern's targets are fixed once
    /// built, so a change here needs a restart.
    #[serde(default)]
    pub log_directory: Option<String>,
    /// OS toast when an agent ends its turn normally. Off by default — the window attention
    /// request fires regardless, so a user who wants nothing extra gets nothing extra.
    #[serde(default)]
    pub notify_on_done: bool,
    /// OS toast when an agent blocks on a permission prompt, a question, or authentication.
    #[serde(default)]
    pub notify_on_input_needed: bool,
    /// OS toast when an agent's turn ends in an error, a refusal, or a limit.
    #[serde(default)]
    pub notify_on_failure: bool,
    /// Use the OS window frame instead of Maestro's own title bar. Off by default — the app ships
    /// frameless. Ignored on macOS, which always uses its native title bar.
    #[serde(default)]
    pub native_window_frame: bool,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            theme_preference: Some("system".to_string()),
            auto_mode: false,
            thinking_visibility: ActivityVisibility::Auto,
            tool_call_visibility: ActivityVisibility::Auto,
            accent_color: None,
            new_project_color: NewProjectColor::Auto,
            terminal_color_mode: TerminalColorMode::FollowTheme,
            enter_key_behavior: EnterKeyBehavior::SendPrompt,
            agent_stream_width: AgentStreamWidth::Full,
            updated_at: chrono::Utc::now().to_rfc3339(),
            auto_update: false,
            ui_scale: None,
            log_level: None,
            log_directory: None,
            notify_on_done: false,
            notify_on_input_needed: false,
            notify_on_failure: false,
            native_window_frame: false,
        }
    }
}
