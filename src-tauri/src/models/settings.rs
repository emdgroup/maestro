use serde::{Deserialize, Serialize};
use specta::Type;

fn default_max_concurrent_agents() -> i32 {
    3
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

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[specta(export)]
pub struct AppSettings {
    pub theme_preference: Option<String>,
    #[serde(default)]
    pub auto_mode: bool,
    #[serde(default = "default_max_concurrent_agents")]
    pub max_concurrent_agents: i32,
    #[serde(default)]
    pub thinking_visibility: ActivityVisibility,
    #[serde(default)]
    pub tool_call_visibility: ActivityVisibility,
    #[serde(default)]
    pub accent_color: Option<String>,
    #[serde(default)]
    pub terminal_color_mode: TerminalColorMode,
    #[serde(default)]
    pub enter_key_behavior: EnterKeyBehavior,
    pub updated_at: String,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            theme_preference: Some("system".to_string()),
            auto_mode: false,
            max_concurrent_agents: 3,
            thinking_visibility: ActivityVisibility::Auto,
            tool_call_visibility: ActivityVisibility::Auto,
            accent_color: None,
            terminal_color_mode: TerminalColorMode::FollowTheme,
            enter_key_behavior: EnterKeyBehavior::SendPrompt,
            updated_at: chrono::Utc::now().to_rfc3339(),
        }
    }
}
