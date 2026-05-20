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
            updated_at: chrono::Utc::now().to_rfc3339(),
        }
    }
}
