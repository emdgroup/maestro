//! Token usage, recorded per turn.

use serde::{Deserialize, Serialize};

use crate::*;

/// Keyed like [`ProjectSession`], so the turns of every load of a conversation are found.
#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct SessionUsageRequest {
    pub agent_id: String,
    pub acp_session_id: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct SessionUsageResponse {
    pub turns: Vec<UsageTurn>,
}

/// One recorded turn. Token counts are [`TurnUsage`] as the agent reported it, `None` when it did
/// not report any.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct UsageTurn {
    pub model_id: Option<String>,
    /// RFC 3339.
    pub started_at: String,
    pub ended_at: String,
    pub usage: Option<TurnUsage>,
}

/// Token counts as stored, `None` where the agent reported none. A model's row has no total.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct UsageTokens {
    pub total_tokens: Option<i64>,
    pub input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub thought_tokens: Option<i64>,
    pub cached_read_tokens: Option<i64>,
    pub cached_write_tokens: Option<i64>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct UsageTurnsRequest {
    /// The last turn id the caller has, 0 for none.
    pub after_turn_id: i64,
}

/// Every answer names the store, so a caller sees when the database behind the server was
/// recreated and its turn ids started again.
#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct UsageTurnsResponse {
    pub store_id: String,
    /// The highest turn id merged into its hour so far. Above the caller's last turn id, turns the
    /// caller never received are gone into hours, and only a sync from scratch recovers them.
    pub merged_through_id: i64,
    pub turns: Vec<UsageTurnRow>,
    /// The models of the turns in this page.
    pub models: Vec<UsageTurnModelRow>,
    /// More turns follow the last one in this page.
    pub more: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct UsageTurnRow {
    pub id: i64,
    pub agent_id: String,
    pub acp_session_id: String,
    pub project_path: String,
    pub model_id: Option<String>,
    /// RFC 3339, UTC.
    pub started_at: String,
    pub ended_at: String,
    #[serde(flatten)]
    pub tokens: UsageTokens,
    pub cost_amount: Option<f64>,
    pub cost_currency: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct UsageTurnModelRow {
    pub turn_id: i64,
    pub model: String,
    #[serde(flatten)]
    pub tokens: UsageTokens,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct UsageHoursRequest {
    /// The last hour the caller has, empty for none.
    pub after_hour: String,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct UsageHoursResponse {
    pub store_id: String,
    /// Every row of each hour in this page: a page never splits an hour.
    pub hours: Vec<UsageHourRow>,
    pub models: Vec<UsageHourModelRow>,
    pub more: bool,
}

/// Turns past retention summed per UTC hour. `''` is an unknown model or currency.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct UsageHourRow {
    /// `YYYY-MM-DDTHH:00:00Z`.
    pub hour: String,
    pub agent_id: String,
    pub project_path: String,
    pub model_id: String,
    pub cost_currency: String,
    pub turns: i64,
    pub sessions: i64,
    pub active_seconds: i64,
    #[serde(flatten)]
    pub tokens: UsageTokens,
    pub cost_amount: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct UsageHourModelRow {
    pub hour: String,
    pub agent_id: String,
    pub project_path: String,
    pub model: String,
    #[serde(flatten)]
    pub tokens: UsageTokens,
}
