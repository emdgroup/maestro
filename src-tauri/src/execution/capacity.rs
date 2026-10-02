//! How many agents a host can run at once.
//!
//! The limit is per host rather than per project, because it tracks real resources: two projects
//! pointed at the same SSH box share that box's memory, and nothing in the frontend can see that —
//! which is why the scheduler has to live here rather than in the UI.
//!
//! The limit itself is the daemon's (`maestro-server/src/pipeline_settings.rs`), measured on the
//! machine the agents run on; this is the app's view of it.
//!
//! The user picks between a fixed number and a figure derived from free memory. Neither is a
//! guess about the other: a laptop with plenty of RAM but a noisy fan wants a hard cap, and a
//! shared build host wants the limit to move as other people use it.

use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, Default)]
#[serde(rename_all = "PascalCase")]
pub enum ConcurrencyMode {
    /// The number the user set, regardless of what the host is doing.
    Hard,
    /// Derived from the host's free memory, recomputed whenever the queue is drained.
    ///
    /// The default, because the limit exists to stop auto-mode starting agents a host has no
    /// memory for — and a fixed number chosen before anyone knew what the machine looks like
    /// cannot do that. A host that cannot be measured falls back to the fixed number.
    #[default]
    Auto,
}

impl From<maestro_protocol::ConcurrencyMode> for ConcurrencyMode {
    fn from(mode: maestro_protocol::ConcurrencyMode) -> Self {
        match mode {
            maestro_protocol::ConcurrencyMode::Hard => Self::Hard,
            maestro_protocol::ConcurrencyMode::Auto => Self::Auto,
        }
    }
}

impl From<ConcurrencyMode> for maestro_protocol::ConcurrencyMode {
    fn from(mode: ConcurrencyMode) -> Self {
        match mode {
            ConcurrencyMode::Hard => Self::Hard,
            ConcurrencyMode::Auto => Self::Auto,
        }
    }
}
